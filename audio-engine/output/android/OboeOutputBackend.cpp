#include "OboeOutputBackend.h"
#include "AndroidPcmCallback.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

#if defined(__ANDROID__)
#include <aaudio/AAudio.h>
#include <android/log.h>
#include <dlfcn.h>
#endif

namespace twilight::audio {
namespace {

constexpr int kDefaultOboeSampleRate = 48000;
constexpr int kDefaultOboeChannels = 2;
constexpr int kDefaultOboeBufferFrames = 256;

double framesToLatencyMs(int frames, int sampleRate) {
  return sampleRate > 0 ? static_cast<double>(frames) * 1000.0 / static_cast<double>(sampleRate) : 0.0;
}

template <typename ConfigT>
bool extractConfigExclusiveFlag(const ConfigT& config) {
  if constexpr (requires { config.exclusive; }) {
    return static_cast<bool>(config.exclusive);
  } else {
    return config.wasapiExclusivePushMode;
  }
}

bool deviceIdRequestsExclusive(const std::string& deviceId) {
  return deviceId == "exclusive" || deviceId == "oboe-exclusive" ||
         deviceId.find(":exclusive") != std::string::npos;
}

#if defined(__ANDROID__)
constexpr const char* kLogTag = "TwilightOboeBackend";

// Resolve API 34 queries dynamically so the same library still loads on API 26.
void readHardwareFormat(AAudioStream* stream, OutputInfo& info) {
  using Query = int32_t (*)(AAudioStream*);
  static const auto rate = reinterpret_cast<Query>(dlsym(RTLD_DEFAULT, "AAudioStream_getHardwareSampleRate"));
  static const auto channels = reinterpret_cast<Query>(dlsym(RTLD_DEFAULT, "AAudioStream_getHardwareChannelCount"));
  static const auto format = reinterpret_cast<Query>(dlsym(RTLD_DEFAULT, "AAudioStream_getHardwareFormat"));
  info.hardwareSampleRate = rate ? std::max(0, rate(stream)) : 0;
  info.hardwareChannels = channels ? std::max(0, channels(stream)) : 0;
  const int32_t hardwareFormat = format ? format(stream) : AAUDIO_FORMAT_INVALID;
  switch (hardwareFormat) {
    case AAUDIO_FORMAT_PCM_I16:
      info.hardwareSampleFormat = "int16"; info.hardwareBitDepth = 16; break;
    case AAUDIO_FORMAT_PCM_I24_PACKED:
      info.hardwareSampleFormat = "int24"; info.hardwareBitDepth = 24; break;
    case AAUDIO_FORMAT_PCM_I32:
      info.hardwareSampleFormat = "int32"; info.hardwareBitDepth = 32; break;
    case AAUDIO_FORMAT_PCM_FLOAT:
      info.hardwareSampleFormat = "float32"; info.hardwareBitDepth = 32; break;
    default:
      info.hardwareSampleFormat.clear(); info.hardwareBitDepth = 0; break;
  }
}

int32_t parseAndroidDeviceId(const std::string& deviceId) {
  if (deviceId.empty() || deviceId == "auto" || deviceId == "default" ||
      deviceId == "exclusive" || deviceId == "oboe-exclusive") {
    return AAUDIO_UNSPECIFIED;
  }
  const size_t colonPos = deviceId.find(':');
  const std::string numericPart = colonPos == std::string::npos ? deviceId : deviceId.substr(0, colonPos);
  if (numericPart.empty() || numericPart == "auto" || numericPart == "default") {
    return AAUDIO_UNSPECIFIED;
  }
  char* endPtr = nullptr;
  const long parsed = std::strtol(numericPart.c_str(), &endPtr, 10);
  if (endPtr == numericPart.c_str() || (endPtr && *endPtr != '\0') || parsed <= 0) {
    return AAUDIO_UNSPECIFIED;
  }
  return static_cast<int32_t>(parsed);
}
#endif

}  // namespace

struct OboeOutputBackend::Impl {
  mutable std::mutex mutex;
  RenderCallback callback;
  TypedRenderCallback typedCallback;
  std::shared_ptr<UsbPcmPolicy> usbPolicy;
  bool usbLease = false;
  bool rawPcm = false;
  int usbDeviceId = 0;
  int requestedAAudioFormat = 2; // AAUDIO_FORMAT_PCM_FLOAT
  void releaseUsbLease() {
    if (usbLease && usbPolicy) usbPolicy->release();
    usbLease = false;
  }
  OutputEventCallback eventCallback;
  OutputConfig outputConfig;
  AudioFormat format;
  OutputInfo info;
  OutputInfo::Diagnostics diagnostics;
  DopRuntimeFacts dopFacts;
  std::string currentDeviceId = "auto";
  std::string currentDeviceName = "Android Oboe Default Output";
  std::atomic<bool> exclusiveRequested{false};
  std::atomic<bool> opened{false};
  std::atomic<bool> running{false};
  std::atomic<bool> stopRequested{false};
  std::atomic<int> activeChannels{kDefaultOboeChannels};
  int latencyFrames = kDefaultOboeBufferFrames;
  int framesPerBurst = kDefaultOboeBufferFrames;
  std::thread renderThread;
  std::vector<float> renderScratch;

#if defined(__ANDROID__)
  AAudioStream* aaudioStream = nullptr;

  void closeAAudioStreamLocked() {
    if (aaudioStream) {
      AAudioStream* streamToClose = aaudioStream;
      aaudioStream = nullptr;
      AAudioStream_close(streamToClose);
    }
  }

  static aaudio_data_callback_result_t onAudioReady(
      AAudioStream* stream,
      void* userData,
      void* audioData,
      int32_t numFrames) {
    (void)stream;
    auto* self = static_cast<Impl*>(userData);
    if (!self || !audioData || numFrames <= 0) return AAUDIO_CALLBACK_RESULT_CONTINUE;
    const bool running = !self->stopRequested.load(std::memory_order_acquire) &&
                         self->running.load(std::memory_order_acquire);
    renderAndroidPcm(audioData, static_cast<size_t>(numFrames), self->format,
        running, self->rawPcm, self->typedCallback, self->callback);
    return running ? AAUDIO_CALLBACK_RESULT_CONTINUE : AAUDIO_CALLBACK_RESULT_STOP;
  }

  static void onErrorCallback(
      AAudioStream* stream,
      void* userData,
      aaudio_result_t error) {
    (void)stream;
    auto* self = static_cast<Impl*>(userData);
    if (!self) return;

    self->stopRequested.store(true, std::memory_order_release);
    self->running.store(false, std::memory_order_release);

    const char* errText = AAudio_convertResultToText(error);
    const std::string message = std::string("Android AAudio stream error: ") +
                                (errText ? errText : std::to_string(static_cast<int>(error)));
    __android_log_print(ANDROID_LOG_WARN, kLogTag, "%s (code=%d)", message.c_str(), static_cast<int>(error));

    const bool disconnected =
        (error == AAUDIO_ERROR_DISCONNECTED || error == AAUDIO_ERROR_NO_SERVICE);
    OutputEventCallback localEventCb;
    {
      std::lock_guard lock(self->mutex);
      if (disconnected) {
        ++self->diagnostics.deviceLostCount;
      } else {
        ++self->diagnostics.sessionUnderrunCount;
        ++self->diagnostics.lifetimeUnderrunCount;
      }
      self->diagnostics.lastError = message;
      self->info.diagnostics = self->diagnostics;
      self->info.deviceRecovered = false;
      self->info.outputReleased = true;
      self->info.exclusive = false;
      self->info.outputPerfect = false;
      self->info.actualDeviceId.clear();
      self->info.hardwareSampleRate = 0;
      self->info.hardwareBitDepth = 0;
      self->info.hardwareChannels = 0;
      self->info.hardwareSampleFormat.clear();
      localEventCb = self->eventCallback;
    }

    if (localEventCb) {
      localEventCb(
          disconnected ? OutputBackendEvent::DeviceInvalidated : OutputBackendEvent::RenderError,
          message);
    }
  }

  bool openAAudioStreamWithMode(
      int32_t deviceId,
      int32_t sampleRate,
      int32_t channelCount,
      int32_t preferredBufferFrames,
      aaudio_sharing_mode_t sharingMode,
      AAudioStream** outStream,
      std::string* errorOut) {
    AAudioStreamBuilder* builder = nullptr;
    aaudio_result_t result = AAudio_createStreamBuilder(&builder);
    if (result != AAUDIO_OK || !builder) {
      if (errorOut) {
        *errorOut = std::string("AAudio_createStreamBuilder failed: ") +
                    AAudio_convertResultToText(result);
      }
      return false;
    }

    AAudioStreamBuilder_setDirection(builder, AAUDIO_DIRECTION_OUTPUT);
    AAudioStreamBuilder_setPerformanceMode(builder, rawPcm ? AAUDIO_PERFORMANCE_MODE_NONE : AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
    AAudioStreamBuilder_setSharingMode(builder, sharingMode);
    AAudioStreamBuilder_setFormat(builder, rawPcm ? requestedAAudioFormat : AAUDIO_FORMAT_PCM_FLOAT);
    // Dynamic API 28 setter keeps the ordinary API 26 library loadable.
    if (rawPcm) {
      using SetUsage = void (*)(AAudioStreamBuilder*, int32_t);
      static auto setUsage = reinterpret_cast<SetUsage>(dlsym(RTLD_DEFAULT, "AAudioStreamBuilder_setUsage"));
      static auto setContent = reinterpret_cast<SetUsage>(dlsym(RTLD_DEFAULT, "AAudioStreamBuilder_setContentType"));
      if (setUsage) setUsage(builder, 1); // USAGE_MEDIA
      if (setContent) setContent(builder, 2); // CONTENT_TYPE_MUSIC, matches host preference
    }
    AAudioStreamBuilder_setSampleRate(builder, sampleRate);
    AAudioStreamBuilder_setChannelCount(builder, channelCount);
    if (deviceId != AAUDIO_UNSPECIFIED) {
      AAudioStreamBuilder_setDeviceId(builder, deviceId);
    }
    if (preferredBufferFrames > 0) {
      AAudioStreamBuilder_setBufferCapacityInFrames(
          builder, std::max<int32_t>(preferredBufferFrames * 2, 128));
    }
    AAudioStreamBuilder_setDataCallback(builder, &Impl::onAudioReady, this);
    AAudioStreamBuilder_setErrorCallback(builder, &Impl::onErrorCallback, this);

    AAudioStream* stream = nullptr;
    result = AAudioStreamBuilder_openStream(builder, &stream);
    AAudioStreamBuilder_delete(builder);

    if (result != AAUDIO_OK || !stream) {
      if (errorOut) {
        *errorOut = std::string("AAudioStreamBuilder_openStream failed: ") +
                    AAudio_convertResultToText(result);
      }
      return false;
    }

    *outStream = stream;
    return true;
  }
#endif

  void resetStateLocked() {
#if defined(__ANDROID__)
    closeAAudioStreamLocked();
#endif
    releaseUsbLease();
    rawPcm = false;
    usbDeviceId = 0;
    format = {};
    info = {};
    diagnostics = {};
    dopFacts = {};
    currentDeviceId = "auto";
    currentDeviceName = "Android Oboe Default Output";
    latencyFrames = kDefaultOboeBufferFrames;
    framesPerBurst = kDefaultOboeBufferFrames;
    activeChannels.store(kDefaultOboeChannels, std::memory_order_relaxed);
    renderScratch.clear();
  }

  void renderLoop() {
    RenderCallback localCallback;
    int channels = kDefaultOboeChannels;
    int sampleRate = kDefaultOboeSampleRate;
    int periodFrames = kDefaultOboeBufferFrames;
    {
      std::lock_guard lock(mutex);
      localCallback = callback;
      channels = std::max(1, format.channelCount);
      sampleRate = std::max(8000, format.sampleRate);
      periodFrames = std::max(64, latencyFrames);
    }

    const size_t frameCount = static_cast<size_t>(periodFrames);
    const size_t sampleCount = frameCount * static_cast<size_t>(channels);
    std::vector<float> scratch(sampleCount, 0.0f);
    const auto periodDuration = std::chrono::microseconds(
        static_cast<int64_t>(frameCount) * 1000000 / static_cast<int64_t>(sampleRate));

    while (!stopRequested.load(std::memory_order_acquire) && running.load(std::memory_order_acquire)) {
      std::fill(scratch.begin(), scratch.end(), 0.0f);
      if (localCallback) {
        const size_t rendered = localCallback(scratch.data(), frameCount);
        if (rendered < frameCount) {
          const size_t offset = rendered * static_cast<std::size_t>(channels);
          std::fill(scratch.begin() + static_cast<std::ptrdiff_t>(offset), scratch.end(), 0.0f);
        }
      }
      std::this_thread::sleep_for(periodDuration);
    }
  }
};

OboeOutputBackend::OboeOutputBackend() : impl_(std::make_unique<Impl>()) {}

OboeOutputBackend::~OboeOutputBackend() {
  close();
}

const char* OboeOutputBackend::id() const {
  return "oboe";
}

const char* OboeOutputBackend::getBackendName() const {
  return "oboe";
}

std::vector<PcmDeviceCatalogEntry> OboeOutputBackend::enumerateDevices() const {
  return {
      {"auto", "Android Oboe Default Output", true},
  };
}

bool OboeOutputBackend::open(
    const std::string& deviceId,
    const AudioFormat& requestedFormat,
    std::string* error) {
  close();

  if (requestedFormat.sampleRate <= 0 || requestedFormat.channelCount <= 0) {
    if (error) *error = "Invalid requested audio format for Oboe output backend";
    return false;
  }

  std::lock_guard lock(impl_->mutex);
  impl_->resetStateLocked();
  impl_->currentDeviceId = deviceId.empty() ? "auto" : deviceId;
  impl_->currentDeviceName =
      (impl_->currentDeviceId == "auto" || impl_->currentDeviceId == "default")
          ? "Android Oboe Default Output"
          : ("Android Oboe (" + impl_->currentDeviceId + ")");

  const int requestedChannels = std::clamp(requestedFormat.channelCount, 1, 8);
  const int preferredBufferFrames = impl_->outputConfig.preferredBufferSize > 0
                                        ? static_cast<int>(impl_->outputConfig.preferredBufferSize)
                                        : kDefaultOboeBufferFrames;
  const bool wantExclusive = !impl_->outputConfig.usbPcmPassthrough && !impl_->outputConfig.continuityFirst &&
                             (impl_->exclusiveRequested.load(std::memory_order_acquire) ||
                              extractConfigExclusiveFlag(impl_->outputConfig) ||
                              deviceIdRequestsExclusive(impl_->currentDeviceId));

#if defined(__ANDROID__)
  int32_t androidDeviceId = parseAndroidDeviceId(impl_->currentDeviceId);
  impl_->rawPcm = impl_->outputConfig.usbPcmPassthrough;
  if (impl_->rawPcm) {
    if (!impl_->usbPolicy || requestedChannels != requestedFormat.channelCount ||
        requestedChannels > 2 || requestedFormat.dopEncoded) {
      if (error) *error = "USB 原样 PCM 需要 Android 14+ 宿主策略与单／双声道 PCM";
      return false;
    }
    switch (requestedFormat.sampleFormat) {
      case AudioSampleFormat::Int16Interleaved: impl_->requestedAAudioFormat = AAUDIO_FORMAT_PCM_I16; break;
      case AudioSampleFormat::Int24Interleaved: impl_->requestedAAudioFormat = AAUDIO_FORMAT_PCM_I24_PACKED; break;
      case AudioSampleFormat::Int32Interleaved: impl_->requestedAAudioFormat = AAUDIO_FORMAT_PCM_I32; break;
      case AudioSampleFormat::Float32Interleaved: impl_->requestedAAudioFormat = AAUDIO_FORMAT_PCM_FLOAT; break;
      default:
        if (error) *error = "USB 原样 PCM 不支持此样本容器";
        return false;
    }
    androidDeviceId = impl_->usbPolicy->acquire(deviceId, requestedFormat, error);
    if (androidDeviceId <= 0) return false;
    impl_->usbLease = true;
    impl_->usbDeviceId = androidDeviceId;
  }
  // Every failed open releases only this output's lease, including format mismatch.
  struct OpenGuard {
    Impl* self;
    ~OpenGuard() { if (!self->opened.load()) { self->closeAAudioStreamLocked(); self->releaseUsbLease(); } }
  } guard{impl_.get()};
  AAudioStream* stream = nullptr;
  std::string openError;
  bool exclusiveFallbackOccurred = false;

  if (wantExclusive) {
    if (!impl_->openAAudioStreamWithMode(
            androidDeviceId,
            requestedFormat.sampleRate,
            requestedChannels,
            preferredBufferFrames,
            AAUDIO_SHARING_MODE_EXCLUSIVE,
            &stream,
            &openError)) {
      exclusiveFallbackOccurred = true;
      openError.clear();
      if (!impl_->openAAudioStreamWithMode(
              androidDeviceId,
              requestedFormat.sampleRate,
              requestedChannels,
              preferredBufferFrames,
              AAUDIO_SHARING_MODE_SHARED,
              &stream,
              &openError)) {
        if (error) *error = openError;
        return false;
      }
    }
  } else {
    if (!impl_->openAAudioStreamWithMode(
            androidDeviceId,
            requestedFormat.sampleRate,
            requestedChannels,
            preferredBufferFrames,
            AAUDIO_SHARING_MODE_SHARED,
            &stream,
            &openError)) {
      if (error) *error = openError;
      return false;
    }
  }

  impl_->aaudioStream = stream;

  const int32_t actualSampleRate = AAudioStream_getSampleRate(stream);
  const int32_t actualChannels = AAudioStream_getChannelCount(stream);
  const aaudio_sharing_mode_t actualSharingMode = AAudioStream_getSharingMode(stream);
  const aaudio_format_t actualAAudioFormat = AAudioStream_getFormat(stream);
  const int32_t burstFrames = AAudioStream_getFramesPerBurst(stream);

  if (impl_->outputConfig.preferredBufferSize > 0) {
    AAudioStream_setBufferSizeInFrames(stream, std::max<int32_t>(64, preferredBufferFrames));
  } else if (burstFrames > 0) {
    AAudioStream_setBufferSizeInFrames(stream, std::max<int32_t>(burstFrames * 2, 64));
  }

  const int32_t actualBufferSizeFrames = AAudioStream_getBufferSizeInFrames(stream);
  const int32_t actualDeviceId = AAudioStream_getDeviceId(stream);
  const bool isExclusive = (actualSharingMode == AAUDIO_SHARING_MODE_EXCLUSIVE);
  if (impl_->rawPcm && (actualSampleRate != requestedFormat.sampleRate ||
      actualChannels != requestedFormat.channelCount || actualDeviceId != androidDeviceId ||
      actualAAudioFormat != impl_->requestedAAudioFormat || isExclusive || !impl_->usbPolicy->valid())) {
    if (error) *error = "USB 原样 PCM 实际路由或格式与系统偏好不匹配";
    return false;
  }
  if (wantExclusive && !isExclusive) {
    exclusiveFallbackOccurred = true;
  }

  impl_->format.sampleRate = actualSampleRate > 0 ? actualSampleRate : requestedFormat.sampleRate;
  impl_->format.channelCount = actualChannels > 0 ? actualChannels : requestedChannels;
  if (actualAAudioFormat == AAUDIO_FORMAT_PCM_I16) {
    impl_->format.sampleFormat = AudioSampleFormat::Int16Interleaved;
    impl_->format.bitDepth = 16;
  } else if (actualAAudioFormat == AAUDIO_FORMAT_PCM_I24_PACKED) {
    impl_->format.sampleFormat = AudioSampleFormat::Int24Interleaved;
    impl_->format.bitDepth = 24;
  } else if (actualAAudioFormat == AAUDIO_FORMAT_PCM_I32) {
    impl_->format.sampleFormat = AudioSampleFormat::Int32Interleaved;
    impl_->format.bitDepth = 32;
  } else {
    impl_->format.sampleFormat = AudioSampleFormat::Float32Interleaved;
    impl_->format.bitDepth = 32;
  }
  impl_->format.dopEncoded = false;
  impl_->activeChannels.store(impl_->format.channelCount, std::memory_order_release);

  impl_->framesPerBurst = burstFrames > 0 ? burstFrames : kDefaultOboeBufferFrames;
  impl_->latencyFrames = actualBufferSizeFrames > 0
                             ? actualBufferSizeFrames
                             : std::max(64, impl_->framesPerBurst * 2);
  impl_->renderScratch.resize(
      static_cast<size_t>(impl_->latencyFrames) * static_cast<size_t>(impl_->format.channelCount),
      0.0f);

  if (actualDeviceId != AAUDIO_UNSPECIFIED && actualDeviceId > 0) {
    impl_->currentDeviceName =
        std::string("Android AAudio Device #") + std::to_string(actualDeviceId) +
        (isExclusive ? " (Exclusive)" : " (Shared)");
  }

  const double bufferMs = framesToLatencyMs(impl_->latencyFrames, impl_->format.sampleRate);
  const double burstMs = framesToLatencyMs(impl_->framesPerBurst, impl_->format.sampleRate);

  const bool sampleRateConverted = requestedFormat.sampleRate != impl_->format.sampleRate;
  const bool channelLayoutConverted = requestedFormat.channelCount != impl_->format.channelCount;
  const bool sampleFormatConverted =
      effectivePcmBitDepth(requestedFormat) != impl_->format.bitDepth ||
      requestedFormat.sampleFormat != impl_->format.sampleFormat;
  const bool resampled = sampleRateConverted || channelLayoutConverted || sampleFormatConverted;
  const bool sourceExact = isExclusive && !resampled;

  impl_->info = {};
  impl_->info.usbPcmPreferenceAccepted = impl_->rawPcm;
  impl_->info.usbPcmFormatMatched = impl_->rawPcm;
  impl_->info.exclusive = isExclusive;
  impl_->info.accessMode = isExclusive ? "exclusive" : "shared";
  impl_->info.supportsOutputPerfect = false;
  impl_->info.sourceExact = sourceExact;
  impl_->info.outputPerfect = false;
  impl_->info.pcmPassthrough = false;
  impl_->info.resampled = resampled;
  impl_->info.conversionInfo.sampleRateConverted = sampleRateConverted;
  impl_->info.conversionInfo.channelLayoutConverted = channelLayoutConverted;
  impl_->info.conversionInfo.sampleFormatConverted = sampleFormatConverted;
  impl_->info.conversionInfo.source = "aaudio";
  impl_->info.outputSampleRate = impl_->format.sampleRate;
  impl_->info.outputBitDepth = impl_->format.bitDepth;
  impl_->info.outputChannels = impl_->format.channelCount;
  impl_->info.outputSampleFormat = sampleFormatToString(impl_->format.sampleFormat);
  impl_->info.backend = "oboe";
  impl_->info.actualBackend = "oboe";
  impl_->info.devicePathKind = isExclusive ? "direct" : "default";
  impl_->info.deviceName = impl_->currentDeviceName;
  impl_->info.actualDeviceName = impl_->currentDeviceName;
  impl_->info.actualDeviceId =
      (actualDeviceId != AAUDIO_UNSPECIFIED && actualDeviceId > 0)
          ? std::to_string(actualDeviceId)
          : "";
  impl_->info.driverName = "AAudio";
  impl_->info.actualDriverName = "AAudio";
  impl_->info.actualOutputFormat = sampleFormatToString(impl_->format.sampleFormat);
  impl_->info.actualSampleRate = impl_->format.sampleRate;
  impl_->info.actualBitDepth = impl_->format.bitDepth;
  impl_->info.actualChannels = impl_->format.channelCount;
  impl_->info.requestedSampleRate = requestedFormat.sampleRate;
  impl_->info.requestedSampleFormat = sampleFormatToString(requestedFormat.sampleFormat);
  readHardwareFormat(stream, impl_->info);
  impl_->info.bufferSizeFrames = impl_->latencyFrames;
  impl_->info.latencyFrames = impl_->latencyFrames;
  impl_->info.latencyInfo.bufferLatencyMs = bufferMs;
  impl_->info.latencyInfo.outputLatencyMs = burstMs;
  impl_->info.latencyInfo.totalLatencyMs = bufferMs + burstMs;
  impl_->info.latencyMs = impl_->info.latencyInfo.totalLatencyMs;
  impl_->info.channelRoutingMode = channelRoutingModeToString(impl_->outputConfig.routingMode);
  if (!isExclusive) {
    impl_->info.perfectReasonCode = "shared_mixer";
    impl_->info.perfectReason = exclusiveFallbackOccurred
                                    ? "Android AAudio exclusive mode unavailable; fell back to shared output path"
                                    : "Android Oboe/AAudio shared output path";
    impl_->info.capabilityReason = impl_->info.perfectReason;
  } else if (resampled) {
    impl_->info.perfectReasonCode = "pcm_converted";
    impl_->info.perfectReason =
        "Android AAudio exclusive output negotiated a different sample rate, channel count, or PCM format";
    impl_->info.capabilityReason = impl_->info.perfectReason;
  } else {
    impl_->info.perfectReasonCode = "android_system_path";
    impl_->info.perfectReason = "Android AAudio exclusive PCM stream";
    impl_->info.capabilityReason = "Android AAudio exclusive low-latency output path";
  }
  impl_->info.diagnostics = impl_->diagnostics;
  synchronizeOutputConversionInfo(impl_->info);

  impl_->dopFacts = {};
  impl_->dopFacts.state = DopRuntimeFactState::Unsupported;
  impl_->dopFacts.reason = isExclusive
                               ? "Android AAudio float32 output path does not prove DoP passthrough"
                               : "Android Oboe shared output path does not prove DoP passthrough";

  impl_->opened.store(true, std::memory_order_release);
  return true;
#else
  (void)wantExclusive;
  if (impl_->outputConfig.usbPcmPassthrough) {
    if (error) *error = "USB 原样 PCM 仅支持 Android 14+";
    return false;
  }
  impl_->format.sampleRate = requestedFormat.sampleRate;
  impl_->format.channelCount = requestedChannels;
  impl_->format.sampleFormat = AudioSampleFormat::Float32Interleaved;
  impl_->format.bitDepth = 32;
  impl_->format.dopEncoded = false;
  impl_->activeChannels.store(impl_->format.channelCount, std::memory_order_release);

  impl_->latencyFrames = std::max(64, preferredBufferFrames);
  impl_->framesPerBurst = impl_->latencyFrames;
  impl_->renderScratch.resize(
      static_cast<size_t>(impl_->latencyFrames) * static_cast<size_t>(impl_->format.channelCount),
      0.0f);

  const double bufferMs = framesToLatencyMs(impl_->latencyFrames, impl_->format.sampleRate);
  impl_->info = {};
  impl_->info.exclusive = false;
  impl_->info.accessMode = "shared";
  impl_->info.supportsOutputPerfect = false;
  impl_->info.sourceExact = false;
  impl_->info.outputPerfect = false;
  impl_->info.pcmPassthrough = false;
  impl_->info.resampled = requestedFormat.sampleRate != impl_->format.sampleRate ||
                          requestedFormat.channelCount != impl_->format.channelCount ||
                          effectivePcmBitDepth(requestedFormat) != impl_->format.bitDepth ||
                          requestedFormat.sampleFormat != impl_->format.sampleFormat;
  impl_->info.outputSampleRate = impl_->format.sampleRate;
  impl_->info.outputBitDepth = impl_->format.bitDepth;
  impl_->info.outputChannels = impl_->format.channelCount;
  impl_->info.backend = "oboe";
  impl_->info.actualBackend = "oboe";
  impl_->info.devicePathKind = "default";
  impl_->info.deviceName = impl_->currentDeviceName;
  impl_->info.actualDeviceName = impl_->currentDeviceName;
  impl_->info.actualDeviceId = impl_->currentDeviceId;
  impl_->info.actualOutputFormat = sampleFormatToString(impl_->format.sampleFormat);
  impl_->info.actualSampleRate = impl_->format.sampleRate;
  impl_->info.actualBitDepth = impl_->format.bitDepth;
  impl_->info.actualChannels = impl_->format.channelCount;
  impl_->info.bufferSizeFrames = impl_->latencyFrames;
  impl_->info.latencyFrames = impl_->latencyFrames;
  impl_->info.latencyInfo.bufferLatencyMs = bufferMs;
  impl_->info.latencyInfo.outputLatencyMs = bufferMs;
  impl_->info.latencyInfo.totalLatencyMs = bufferMs * 2.0;
  impl_->info.latencyMs = impl_->info.latencyInfo.totalLatencyMs;
  impl_->info.channelRoutingMode = channelRoutingModeToString(impl_->outputConfig.routingMode);
  impl_->info.perfectReasonCode = "shared_mixer";
  impl_->info.perfectReason = "Android Oboe/AAudio shared output path";
  impl_->info.capabilityReason = impl_->info.perfectReason;
  synchronizeOutputConversionInfo(impl_->info);

  impl_->dopFacts = {};
  impl_->dopFacts.state = DopRuntimeFactState::Unsupported;
  impl_->dopFacts.reason = "Android Oboe shared output path does not prove DoP passthrough";

  impl_->opened.store(true, std::memory_order_release);
  return true;
#endif
}

bool OboeOutputBackend::setOutputConfig(const OutputConfig& config, std::string* error) {
  (void)error;
  std::lock_guard lock(impl_->mutex);
  impl_->outputConfig = config;
  if (extractConfigExclusiveFlag(config)) {
    impl_->exclusiveRequested.store(true, std::memory_order_release);
  }
  impl_->info.channelRoutingMode = channelRoutingModeToString(impl_->outputConfig.routingMode);
  return true;
}

void OboeOutputBackend::setUsbPcmPolicy(std::shared_ptr<UsbPcmPolicy> policy) {
  impl_->usbPolicy = std::move(policy);
}

bool OboeOutputBackend::startTyped(TypedRenderCallback callback, RenderCallback fallback,
    OutputEventCallback event, std::string* error) {
  if (impl_->rawPcm && (!callback || !impl_->usbLease || !impl_->usbPolicy->valid())) {
    if (error) *error = "USB 原样 PCM 样本回调或系统偏好已失效";
    close();
    return false;
  }
  impl_->typedCallback = std::move(callback);
  return start(std::move(fallback), std::move(event), error);
}

void OboeOutputBackend::setExclusiveMode(bool exclusive) {
  impl_->exclusiveRequested.store(exclusive, std::memory_order_release);
}

bool OboeOutputBackend::isExclusiveModeRequested() const {
  return impl_->exclusiveRequested.load(std::memory_order_acquire);
}

bool OboeOutputBackend::start(
    RenderCallback callback,
    OutputEventCallback eventCallback,
    std::string* error) {
  if (impl_->rawPcm && !impl_->typedCallback) {
    if (error) *error = "USB 原样 PCM 不能使用浮点回退回调";
    return false;
  }
  if (!impl_->opened.load(std::memory_order_acquire)) {
    if (error) *error = "Oboe output backend is not open";
    return false;
  }
  if (impl_->running.exchange(true, std::memory_order_acq_rel)) {
    if (error) *error = "Oboe output backend is already running";
    return false;
  }
  {
    std::lock_guard lock(impl_->mutex);
    impl_->callback = std::move(callback);
    impl_->eventCallback = std::move(eventCallback);
  }
  impl_->stopRequested.store(false, std::memory_order_release);

#if defined(__ANDROID__)
  AAudioStream* stream = nullptr;
  {
    std::lock_guard lock(impl_->mutex);
    stream = impl_->aaudioStream;
  }
  if (!stream) {
    impl_->running.store(false, std::memory_order_release);
    if (error) *error = "Android AAudio stream is not initialized";
    return false;
  }
  const aaudio_result_t result = AAudioStream_requestStart(stream);
  if (result != AAUDIO_OK) {
    impl_->running.store(false, std::memory_order_release);
    if (error) {
      *error = std::string("AAudioStream_requestStart failed: ") +
               AAudio_convertResultToText(result);
    }
    return false;
  }
  return true;
#else
  impl_->renderThread = std::thread([this] { impl_->renderLoop(); });
  return true;
#endif
}

void OboeOutputBackend::stop() {
  impl_->stopRequested.store(true, std::memory_order_release);
  const bool wasRunning = impl_->running.exchange(false, std::memory_order_acq_rel);

#if defined(__ANDROID__)
  AAudioStream* stream = nullptr;
  {
    std::lock_guard lock(impl_->mutex);
    stream = impl_->aaudioStream;
  }
  if (wasRunning && stream) {
    AAudioStream_requestStop(stream);
    aaudio_stream_state_t nextState = AAUDIO_STREAM_STATE_UNINITIALIZED;
    AAudioStream_waitForStateChange(
        stream,
        AAUDIO_STREAM_STATE_STOPPING,
        &nextState,
        100000000LL /* 100 ms */);
  }
#else
  if (wasRunning && impl_->renderThread.joinable() &&
      impl_->renderThread.get_id() != std::this_thread::get_id()) {
    impl_->renderThread.join();
  }
#endif
}

void OboeOutputBackend::close() {
  stop();
  if (impl_->renderThread.joinable() &&
      impl_->renderThread.get_id() != std::this_thread::get_id()) {
    impl_->renderThread.join();
  }
  impl_->opened.store(false, std::memory_order_release);
  std::lock_guard lock(impl_->mutex);
#if defined(__ANDROID__)
  impl_->closeAAudioStreamLocked();
#endif
  impl_->typedCallback = nullptr;
  impl_->callback = nullptr;
  impl_->eventCallback = nullptr;
  impl_->resetStateLocked();
}

bool OboeOutputBackend::isOpen() const {
  return impl_->opened.load(std::memory_order_acquire);
}

bool OboeOutputBackend::isRunning() const {
  return impl_->running.load(std::memory_order_acquire);
}

int OboeOutputBackend::getSampleRate() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->format.sampleRate;
}

int OboeOutputBackend::getChannels() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->format.channelCount;
}

int OboeOutputBackend::getLatencyFrames() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->latencyFrames;
}

AudioFormat OboeOutputBackend::outputFormat() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->format;
}

OutputInfo OboeOutputBackend::outputInfo() const {
  std::lock_guard lock(impl_->mutex);
#if defined(__ANDROID__)
  if (impl_->aaudioStream && !impl_->info.outputReleased) {
    const int32_t deviceId = AAudioStream_getDeviceId(impl_->aaudioStream);
    impl_->info.actualDeviceId = deviceId > 0 ? std::to_string(deviceId) : "";
    readHardwareFormat(impl_->aaudioStream, impl_->info);
    if (impl_->rawPcm && (deviceId != impl_->usbDeviceId || !impl_->usbPolicy->valid())) {
      // Clock thread sees this fact and pauses/releases; callback only sees the atomic brake.
      impl_->stopRequested.store(true, std::memory_order_release);
      impl_->info.usbPcmPreferenceAccepted = false;
      impl_->info.usbPcmFormatMatched = false;
      impl_->info.usbPcmInvalid = true;
    }
    const int32_t xruns = AAudioStream_getXRunCount(impl_->aaudioStream);
    if (xruns > 0) {
      impl_->diagnostics.driverXrunCount = static_cast<uint64_t>(xruns);
      impl_->info.diagnostics.driverXrunCount = static_cast<uint64_t>(xruns);
    }
  }
#endif
  OutputInfo info = impl_->info;
  synchronizeOutputConversionInfo(info);
  return info;
}

DopRuntimeFacts OboeOutputBackend::dopRuntimeFacts() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->dopFacts;
}

NativeDsdRuntimeFacts OboeOutputBackend::nativeDsdRuntimeFacts() const {
  return unsupportedNativeDsdRuntimeFacts("Android Oboe output backend has no native DSD path");
}

std::string OboeOutputBackend::deviceName() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->currentDeviceName;
}

bool oboeBackendAvailable() {
#if defined(__ANDROID__) && defined(TAE_ENABLE_OBOE)
  return true;
#else
  return false;
#endif
}

}  // namespace twilight::audio
