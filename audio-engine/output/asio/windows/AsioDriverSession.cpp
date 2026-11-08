#include "AsioDriverSession.h"
#include "AsioPcmMode.h"
#include "AsioDriverCompatibility.h"

#include "../AsioRenderUtils.h"

#include <objbase.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <limits>
#include <optional>
#include <set>
#include <thread>
#include <utility>
#include <vector>

namespace twilight::audio::asio_windows {
namespace {

constexpr uint32_t kEventReset = 1U << 0U;
constexpr uint32_t kEventRestart = 1U << 1U;
constexpr uint32_t kEventBufferFailure = 1U << 2U;
// Transient load notifications. Kept separate from kEventBufferFailure so they
// reach diagnostics without dragging the stream through a full rebuild.
constexpr uint32_t kEventXrun = 1U << 3U;

std::string hresultError(const char* stage, HRESULT value) {
  char buffer[96] = {};
  std::snprintf(
      buffer,
      sizeof(buffer),
      "%s (HRESULT=0x%08lx)",
      stage,
      static_cast<unsigned long>(value));
  return buffer;
}

int bitDepthForFormat(AudioSampleFormat format) {
  switch (format) {
    case AudioSampleFormat::Int16Interleaved:
      return 16;
    case AudioSampleFormat::Int24Interleaved:
    case AudioSampleFormat::Int24In32Interleaved:
      return 24;
    case AudioSampleFormat::DsdInt8Lsb1:
    case AudioSampleFormat::DsdInt8Msb1:
    case AudioSampleFormat::DsdInt8Ner8:
      return 1;
    case AudioSampleFormat::Int32Interleaved:
    case AudioSampleFormat::Float32Interleaved:
    default:
      return 32;
  }
}

std::string driverError(asio_abi::AsioDriver* driver, const char* fallback) {
  if (!driver) return fallback;
  std::array<char, 1024> message{};
  driver->getErrorMessage(message.data());
  const auto end = std::find(message.begin(), message.end(), '\0');
  return end == message.begin() ? fallback : std::string(message.begin(), end);
}

void traceAsioDriverCall(const char* phase) {
  const char* tracePath = std::getenv("TAE_ASIO_TRACE_PATH");
  if (!tracePath || tracePath[0] == '\0') return;
  std::ofstream trace(tracePath, std::ios::app);
  if (trace) trace << phase << '\n';
}

void traceNativeDsdResult(
    asio_abi::AsioDriver* driver,
    const char* operation,
    asio_abi::AsioError result,
    std::optional<double> rate = std::nullopt,
    const asio_abi::AsioIoFormat* ioFormat = nullptr) {
  const char* tracePath = std::getenv("TAE_ASIO_TRACE_PATH");
  if (!tracePath || tracePath[0] == '\0') return;
  std::ofstream trace(tracePath, std::ios::app);
  if (!trace) return;
  std::array<char, 1024> message{};
  if (driver) driver->getErrorMessage(message.data());
  trace << "Native DSD " << operation << " result=" << result;
  if (rate.has_value()) trace << " rate=" << *rate;
  if (ioFormat) trace << " formatType=" << ioFormat->formatType;
  trace << " error=" << message.data() << '\n';
}

void traceNativeDsdText(const char* operation, const std::string& text) {
  const char* tracePath = std::getenv("TAE_ASIO_TRACE_PATH");
  if (!tracePath || tracePath[0] == '\0') return;
  std::ofstream trace(tracePath, std::ios::app);
  if (trace) trace << "Native DSD " << operation << " " << text << '\n';
}

std::vector<int32_t> sessionBufferSizeCandidates(
    const AsioBufferRange& range,
    const AsioOpenConfig& config,
    bool nativeDsdRequested,
    int32_t bufferScale = 1) {
  if (range.maximum <= 0) return {};
  if (nativeDsdRequested) {
    const int64_t scaled = int64_t{std::max(0L, config.bufferSizeFrames)} * bufferScale;
    const int32_t requested = static_cast<int32_t>(std::min<int64_t>(scaled, asio::kMaximumDsdBufferSamples));
    return bufferSizeCandidates(range, requested, config.dsdMinimumBufferFrames,
                                asio::kMaximumDsdBufferSamples);
  }
  const bool needsAutoFloor =
      config.bufferSizeFrames <= 0 || config.bufferSizeFrames < asio::kMinimumSafeAsioBufferFrames;
  const long floor = needsAutoFloor
      ? asio::minimumAutoBufferFrames(config.format)
      : asio::kMinimumSafeAsioBufferFrames;
  const int32_t minimumRequired = static_cast<int32_t>(std::min<long>(range.maximum, floor));
  const int32_t requested = config.bufferSizeFrames <= 0
      ? minimumRequired
      : std::max(static_cast<int32_t>(config.bufferSizeFrames), minimumRequired);
  return bufferSizeCandidates(range, requested, minimumRequired);
}

}  // namespace

struct AsioDriverSession::State final : AsioCallbackTarget {
  asio_abi::AsioDriver* driver = nullptr;
  std::vector<asio_abi::AsioBufferInfo> buffers;
  std::vector<AsioChannelFormat> channelFormats;
  asio_abi::AsioCallbacks callbacks{};
  AsioBufferSwitchCallback bufferSwitch;
  AsioEventCallback eventCallback;
  std::atomic<bool> running = false;
  std::atomic<uint32_t> pendingEvents = 0;
  // Set while the init-compatibility "Cubase dance" runs its dummy engine
  // round: the dummy buffers fire real callbacks that must neither reach the
  // render pipeline nor raise spurious buffer-failure events.
  std::atomic<bool> danceInProgress = false;
  int32_t bufferSize = 0;
  AsioBufferRange pcmBufferRange;
  int32_t bufferSizeScale = 1;
  int32_t inputChannels = 0;
  int32_t outputBufferOffset = 0;
  AsioOpenConfig openConfig;
  double actualSampleRate = 0;
  std::string controlError;
  std::string startupSummary;
  int32_t latency = 0;
  asio_abi::AsioIoFormat originalIoFormat{};
  double originalSampleRate = 0;
  std::string nativeDsdNegotiation;
  bool initialized = false;
  bool buffersCreated = false;
  bool started = false;
  bool ioFormatRestoreRequired = false;
  bool originalIoFormatKnown = false;
  bool sampleRateRestoreRequired = false;
  bool nativeDsdCanDoReported = false;
  std::optional<AsioSampleFormatMapping> sampleFormatMapping;
  AsioNativeDsdControlOrder nativeDsdControlOrder = AsioNativeDsdControlOrder::Default;

  bool selectNativeDsdSemanticRate(int driverRate, const char* order, std::string* error) {
    const double requestedRate = static_cast<double>(driverRate);

    sampleRateRestoreRequired = true;
    AsioRateNegotiator negotiation(*driver, [this, order](const std::string& name, asio_abi::AsioError result, double rate) {
      traceNativeDsdResult(driver, (std::string(order) + " " + name).c_str(), result, rate);
    });
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(2000);
    if (!negotiation.select(requestedRate, &actualSampleRate, deadline) &&
        !negotiation.pivot(requestedRate, true, &actualSampleRate, deadline)) {
      if (error) *error = "ASIO driver could not select the Native DSD semantic sample rate";
      return false;
    }
    return true;
  }

  bool selectNativeDsdIoFormat(const char* order, std::string* error) {
    asio_abi::AsioIoFormat requestedIoFormat{};
    requestedIoFormat.formatType = asio_abi::kAsioIoFormatDsd;
    const auto canFormatResult = driver->future(asio_abi::kFutureCanDoIoFormat, &requestedIoFormat);
    traceNativeDsdResult(driver, (std::string(order) + " can-io-format").c_str(), canFormatResult, std::nullopt, &requestedIoFormat);
    if (!asio_abi::asioErrorIsSuccess(canFormatResult) ||
        requestedIoFormat.formatType == asio_abi::kAsioIoFormatInvalid) {
      if (error) *error = "ASIO driver rejected Native DSD I/O format";
      return false;
    }
    nativeDsdCanDoReported = true;

    ioFormatRestoreRequired = true;
    const auto setFormatResult = driver->future(asio_abi::kFutureSetIoFormat, &requestedIoFormat);
    traceNativeDsdResult(driver, (std::string(order) + " set-io-format").c_str(), setFormatResult, std::nullopt, &requestedIoFormat);
    if (!asio_abi::asioErrorIsSuccess(setFormatResult) ||
        requestedIoFormat.formatType == asio_abi::kAsioIoFormatInvalid) {
      if (error) *error = "ASIO driver could not switch to Native DSD I/O format";
      return false;
    }
    return true;
  }

  bool verifyNativeDsdIoFormat(const char* order, std::string* error) {
    asio_abi::AsioIoFormat activeIoFormat{};
    const auto getFormatResult = driver->future(asio_abi::kFutureGetIoFormat, &activeIoFormat);
    traceNativeDsdResult(driver, (std::string(order) + " get-io-format").c_str(), getFormatResult, std::nullopt, &activeIoFormat);
    if (asio_abi::asioErrorIsSuccess(getFormatResult) &&
        activeIoFormat.formatType != asio_abi::kAsioIoFormatDsd) {
      if (error) *error = "ASIO driver did not confirm Native DSD I/O format";
      return false;
    }
    return true;
  }

  bool configureNativeDsd(const AudioFormat& format, std::string* error) {
    if (!driver || !isDsdSampleFormat(format.sampleFormat)) {
      if (error) *error = "Native DSD configuration requires a raw DSD format";
      return false;
    }
    nativeDsdCanDoReported = false;
    const int driverRate = asio::driverSampleRate(format);
    if (driverRate <= 0) {
      if (error) *error = "Native DSD requested an invalid ASIO semantic sample rate";
      return false;
    }

    const auto originalRateResult = driver->getSampleRate(&originalSampleRate);
    traceNativeDsdResult(driver, "get-original-sample-rate", originalRateResult, originalSampleRate);
    if (!asio_abi::asioErrorIsSuccess(originalRateResult) || !std::isfinite(originalSampleRate) || originalSampleRate <= 0)
      originalSampleRate = 0;

    const auto getIoFormatResult = driver->future(asio_abi::kFutureGetIoFormat, &originalIoFormat);
    traceNativeDsdResult(driver, "get-original-io-format", getIoFormatResult, std::nullopt, &originalIoFormat);
    if (asio_abi::asioErrorIsSuccess(getIoFormatResult)) {
      originalIoFormatKnown = true;
      std::memset(originalIoFormat.reserved, 0, sizeof(originalIoFormat.reserved));
      if (originalIoFormat.formatType != asio_abi::kAsioIoFormatPcm &&
          originalIoFormat.formatType != asio_abi::kAsioIoFormatDsd) originalIoFormatKnown = false;
      nativeDsdNegotiation = "get-confirmed";
    } else {
      // Several otherwise-capable ASIO drivers implement CanDo/Set but omit
      // GetIoFormat. The active channel sample type is the authoritative proof.
      nativeDsdNegotiation = "get-unsupported";
    }

    if (openConfig.bufferSizeInPcmFrames && originalIoFormatKnown &&
        originalIoFormat.formatType == asio_abi::kAsioIoFormatPcm) {
      AsioBufferRange range;
      if (asio_abi::asioErrorIsSuccess(driver->getBufferSize(
              &range.minimum, &range.maximum, &range.preferred, &range.granularity))) pcmBufferRange = range;
    }

    std::string formatFirstError;
    if ((nativeDsdControlOrder == AsioNativeDsdControlOrder::Default ||
         nativeDsdControlOrder == AsioNativeDsdControlOrder::FormatFirst) &&
        selectNativeDsdIoFormat("format-first", &formatFirstError) &&
        selectNativeDsdSemanticRate(driverRate, "format-first", &formatFirstError) &&
        verifyNativeDsdIoFormat("format-first", &formatFirstError)) {
      nativeDsdNegotiation = originalIoFormatKnown ? "format-first-confirmed" : "format-first-runtime-confirmed";
      return true;
    }

    std::string restoreError;
    if (!restoreNativeDsdConfiguration(&restoreError)) {
      nativeDsdNegotiation = "restore-failed";
      if (error) *error = restoreError;
      return false;
    }

    // A few drivers expose the DSD format only after the semantic rate has
    // been primed. Keep that compatibility path as a fallback, but do not
    // probe it first: a failed rate-first SetSampleRate can leave otherwise
    // capable drivers in a state where buffer creation fails.
    std::string rateFirstError;
    if ((nativeDsdControlOrder == AsioNativeDsdControlOrder::Default ||
         nativeDsdControlOrder == AsioNativeDsdControlOrder::RateFirst) &&
        selectNativeDsdSemanticRate(driverRate, "rate-first", &rateFirstError) &&
        selectNativeDsdIoFormat("rate-first", &rateFirstError) &&
        verifyNativeDsdIoFormat("rate-first", &rateFirstError)) {
      nativeDsdNegotiation = originalIoFormatKnown ? "rate-first-confirmed" : "rate-first-runtime-confirmed";
      return true;
    }

    restoreError.clear();
    if (!restoreNativeDsdConfiguration(&restoreError)) {
      nativeDsdNegotiation = "restore-failed";
      if (error) *error = restoreError;
      return false;
    }

    // A third driver family never implemented the IoFormat futures at all and
    // switches its channel sample type to raw DSD purely from the semantic DSD
    // sample rate (the Amanero-era USB class). Setting the rate alone is safe:
    // the getChannelInfo DSD-type check later in open() is the actual proof, so
    // a driver that ignored the rate fails there instead of emitting PCM into
    // a DSD stream.
    std::string rateOnlyError;
    if ((nativeDsdControlOrder == AsioNativeDsdControlOrder::Default ||
         nativeDsdControlOrder == AsioNativeDsdControlOrder::RateOnly) &&
        selectNativeDsdSemanticRate(driverRate, "rate-only", &rateOnlyError)) {
      nativeDsdNegotiation = "rate-only";
      return true;
    }

    restoreError.clear();
    if (!restoreNativeDsdConfiguration(&restoreError)) {
      nativeDsdNegotiation = "restore-failed";
      if (error) *error = restoreError;
      return false;
    }
    nativeDsdNegotiation = "all-orders-failed";
    if (error) {
      *error = "ASIO Native DSD negotiation failed (format-first: " + formatFirstError +
               "; rate-first: " + rateFirstError + "; rate-only: " + rateOnlyError + ")";
      if (nativeDsdCanDoReported) {
        // Can-do answered yes while both sets were refused. Field-verified
        // shape of a device held by another audio client — the same driver
        // accepts every switch the moment the other client closes — not of
        // missing DSD capability. Say so instead of implying the DAC cannot.
        *error += "; the driver claims DSD support but refused the switch, so another audio client "
                  "likely holds the device";
      }
    }
    return false;
  }

  bool restoreNativeDsdConfiguration(std::string* error) {
    if (!driver) return true;
    bool restored = true;
    std::string detail;
    if (ioFormatRestoreRequired) {
      asio_abi::AsioIoFormat retained{};
      retained.formatType = originalIoFormatKnown ? originalIoFormat.formatType : asio_abi::kAsioIoFormatPcm;
      const auto restoredFormat = driver->future(asio_abi::kFutureSetIoFormat, &retained);
      asio_abi::AsioIoFormat observed{};
      observed.formatType = asio_abi::kAsioIoFormatInvalid;
      const auto observedResult = driver->future(asio_abi::kFutureGetIoFormat, &observed);
      if (!asio_abi::asioErrorIsSuccess(restoredFormat) || retained.formatType == asio_abi::kAsioIoFormatInvalid ||
          (asio_abi::asioErrorIsSuccess(observedResult) && observed.formatType != retained.formatType)) {
        restored = false;
        detail = "ASIO driver failed to restore the retained I/O format";
      }
      if (restored) ioFormatRestoreRequired = false;
    }
    if (sampleRateRestoreRequired && originalSampleRate > 0) {
      AsioRateNegotiator negotiation(*driver);
      double restoredRate = 0;
      const bool rateRestored = negotiation.select(originalSampleRate, &restoredRate,
          std::chrono::steady_clock::now() + std::chrono::milliseconds(500));
      if (!rateRestored) {
        restored = false;
        if (!detail.empty()) detail += "; ";
        detail += "ASIO driver failed to restore the retained sample rate";
      }
      if (rateRestored) sampleRateRestoreRequired = false;
    }
    if (originalSampleRate <= 0) sampleRateRestoreRequired = false;
    if (!restored && error) *error = detail;
    return restored;
  }

  void onAsioBufferSwitch(int32_t bufferIndex) noexcept override {
    if (danceInProgress.load(std::memory_order_acquire)) return;
    if (bufferIndex < 0 || bufferIndex > 1 || !running.load(std::memory_order_acquire)) {
      pendingEvents.fetch_or(kEventBufferFailure, std::memory_order_release);
      return;
    }
    try {
      if (bufferSwitch) bufferSwitch(bufferIndex);
    } catch (...) {
      pendingEvents.fetch_or(kEventBufferFailure, std::memory_order_release);
    }
  }

  void onAsioSampleRateChanged(double rate) noexcept override {
    if (running.load(std::memory_order_acquire) && (!std::isfinite(rate) || std::abs(rate - actualSampleRate) > 0.01))
      pendingEvents.fetch_or(kEventRestart, std::memory_order_release);
  }

  int32_t onAsioMessage(int32_t selector, int32_t value, void*, double*) noexcept override {
    switch (selector) {
      case asio_abi::kSelectorSupported:
        return value == asio_abi::kSelectorEngineVersion || value == asio_abi::kSelectorSupportsTimeInfo
                   ? asio_abi::kAsioTrue
                   : asio_abi::kAsioFalse;
      case asio_abi::kSelectorResetRequest:
      case asio_abi::kSelectorResyncRequest:
        pendingEvents.fetch_or(kEventReset, std::memory_order_release);
        return asio_abi::kAsioTrue;
      case asio_abi::kSelectorBufferSizeChange:
        // The buffer geometry changed underneath us; the current buffers are
        // genuinely stale, so this one does require a rebuild.
        pendingEvents.fetch_or(kEventBufferFailure, std::memory_order_release);
        return asio_abi::kAsioTrue;
      case asio_abi::kSelectorLatenciesChanged:
      case asio_abi::kSelectorOverload:
        // Informational. Overload is the driver saying it missed a deadline
        // (typically a transient CPU spike) and LatenciesChanged only means the
        // reported latency figures moved. Neither invalidates the stream, and
        // both used to force a stop/close/open/start cycle with a 500 ms+
        // backoff - a self-inflicted dropout on top of a momentary glitch.
        pendingEvents.fetch_or(kEventXrun, std::memory_order_release);
        return asio_abi::kAsioTrue;
      case asio_abi::kSelectorEngineVersion:
        return 2;
      case asio_abi::kSelectorSupportsTimeInfo:
        return asio_abi::kAsioTrue;
      default:
        return asio_abi::kAsioFalse;
    }
  }

  void drainEvents() {
    const uint32_t events = pendingEvents.exchange(0, std::memory_order_acq_rel);
    if (!eventCallback || events == 0) return;
    if ((events & kEventReset) != 0) eventCallback(AsioHostEvent::DriverReset, "driver requested reset");
    if ((events & kEventRestart) != 0) eventCallback(AsioHostEvent::DriverRestart, "driver sample rate changed");
    if ((events & kEventBufferFailure) != 0) eventCallback(AsioHostEvent::BufferFailure, "driver requested buffer reconfiguration");
    if ((events & kEventXrun) != 0) eventCallback(AsioHostEvent::Xrun, "driver reported a transient load event");
  }
};

AsioDriverSession::AsioDriverSession(AsioDriverEntry entry, std::shared_ptr<AsioControlThread> controlThread)
    : AsioDriverSession(std::move(entry), std::move(controlThread), {}) {}

AsioDriverSession::AsioDriverSession(AsioDriverEntry entry, std::shared_ptr<AsioControlThread> controlThread,
                                   DriverFactory factory)
    : entry_(std::move(entry)), controlThread_(std::move(controlThread)), state_(std::make_shared<State>()),
      driverFactory_(std::move(factory)) {}

AsioDriverSession::~AsioDriverSession() {
  close();
}

bool AsioDriverSession::open(const AsioOpenConfig& config, AsioOpenResult* result, std::string* error) {
  if (state_->driver) close();
  if (!lastCloseError_.empty()) {
    if (result) result->failureKind = AsioOpenFailureKind::Driver;
    if (error) *error = lastCloseError_;
    return false;
  }
  if (!controlThread_ || !controlThread_->start(error)) return false;
  const auto state = state_;
  const auto operation = controlThread_->call(
      [state, config, factory = driverFactory_, clsidText = entry_.clsid, systemReference = controlThread_->systemReference()]() {
        struct OpenState {
          bool ok = false;
          AsioOpenResult result;
          std::string error;
        } outcome;
        // Default to a driver-wide fault; each format-specific refusal below
        // downgrades this so the caller knows another candidate is worth trying.
        outcome.result.failureKind = AsioOpenFailureKind::Driver;
        state->sampleFormatMapping = config.sampleFormatMapping;
        state->nativeDsdControlOrder = config.nativeDsdControlOrder;
        state->nativeDsdNegotiation.clear();
        state->actualSampleRate = 0;
        state->originalIoFormatKnown = false;
        state->originalSampleRate = 0;
        state->startupSummary.clear();
        state->pcmBufferRange = {};
        state->bufferSizeScale = 1;

        CLSID clsid{};
        const std::wstring wideClsid(clsidText.begin(), clsidText.end());
        if (FAILED(CLSIDFromString(wideClsid.c_str(), &clsid))) {
          outcome.error = "ASIO driver CLSID is invalid";
          return outcome;
        }
        HRESULT activation = S_OK;
        if (factory) state->driver = factory();
        else activation = CoCreateInstance(
            clsid,
            nullptr,
            CLSCTX_INPROC_SERVER,
            clsid,
            reinterpret_cast<void**>(&state->driver));
        traceAsioDriverCall("after CoCreateInstance");
        if (FAILED(activation) || !state->driver) {
          outcome.error = hresultError("ASIO driver activation failed", activation);
          return outcome;
        }
        traceAsioDriverCall("before init");
        const auto initialized = state->driver->init(systemReference);
        traceAsioDriverCall("after init");
        if (!asio_abi::asioBoolIsTrue(initialized)) {
          outcome.error = driverError(state->driver, "ASIO driver initialization failed");
          state->driver->Release();
          state->driver = nullptr;
          return outcome;
        }
        state->initialized = true;
        if (!isDsdSampleFormat(config.format.sampleFormat) && !ensureAsioPcmMode(*state->driver)) {
          outcome.error = "ASIO driver could not restore PCM I/O format before PCM playback";
          return outcome;
        }

        int32_t inputChannels = 0;
        int32_t outputChannels = 0;
        traceAsioDriverCall("before getChannels");
        if (!asio_abi::asioErrorIsSuccess(state->driver->getChannels(&inputChannels, &outputChannels))) {
          outcome.error = driverError(state->driver, "ASIO output channel configuration is unavailable");
          return outcome;
        }
        if (config.format.channelCount <= 0 || config.format.channelCount > kMaximumAsioChannels ||
            config.outputChannelStart < 0 || config.outputChannelStart > 255 ||
            config.outputChannelStart + config.format.channelCount > outputChannels) {
          // The driver works; this channel count does not fit it.
          outcome.result.failureKind = AsioOpenFailureKind::Format;
          outcome.error = driverError(state->driver, "ASIO output channel configuration is unavailable");
          return outcome;
        }
        traceAsioDriverCall("after getChannels");
        state->openConfig = config;
        state->inputChannels = std::clamp(inputChannels, 0, kMaximumAsioChannels);
        const bool nativeDsdRequested = isDsdSampleFormat(config.format.sampleFormat);
        if (nativeDsdRequested && !state->configureNativeDsd(config.format, &outcome.error)) {
          outcome.result.failureKind = AsioOpenFailureKind::Format;
          return outcome;
        }
        const int driverRate = asio::driverSampleRate(config.format);
        const double requestedRate = static_cast<double>(driverRate);
        traceAsioDriverCall("before sample rate negotiation");
        AsioRateNegotiator negotiation(*state->driver, [state](const std::string& name, asio_abi::AsioError code, double rate) {
          traceNativeDsdResult(state->driver, name.c_str(), code, rate);
        });
        const auto rateDeadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(2500);
        if (requestedRate <= 0 || (!negotiation.select(requestedRate, &state->actualSampleRate, rateDeadline) &&
            !negotiation.pivot(requestedRate, nativeDsdRequested, &state->actualSampleRate, rateDeadline))) {
          outcome.result.failureKind = AsioOpenFailureKind::Format;
          outcome.error = "ASIO sample rate did not settle: requested=" + std::to_string(driverRate) +
              " observed=" + std::to_string(state->actualSampleRate);
          return outcome;
        }
        traceAsioDriverCall("after sample rate negotiation");
        AsioBufferRange range;
        const auto rangeResult = state->driver->getBufferSize(&range.minimum, &range.maximum, &range.preferred, &range.granularity);
        if (nativeDsdRequested && config.bufferSizeInPcmFrames && asio_abi::asioErrorIsSuccess(rangeResult))
          state->bufferSizeScale = nativeDsdBufferScale(state->pcmBufferRange, range);
        traceNativeDsdText("buffer-size-post-rate", "minimum=" + std::to_string(range.minimum) +
            " maximum=" + std::to_string(range.maximum) + " preferred=" + std::to_string(range.preferred) +
            " granularity=" + std::to_string(range.granularity));
        const auto sizes = asio_abi::asioErrorIsSuccess(rangeResult)
            ? sessionBufferSizeCandidates(range, config, nativeDsdRequested, state->bufferSizeScale)
            : std::vector<int32_t>{};
        if (sizes.empty()) {
          outcome.result.failureKind = AsioOpenFailureKind::Format;
          outcome.error = "ASIO driver reported no legal buffer size after rate negotiation";
          return outcome;
        }
        state->bufferSize = sizes.front();

        // JUCE re-reads the channel count after the rate switch: on a few
        // drivers it changes, and createBuffers with a stale count then fails
        // obscurely. A failed re-read is not fatal - the original count stands.
        traceAsioDriverCall("before getChannels (post-rate)");
        int32_t postRateInputs = 0;
        int32_t postRateOutputs = 0;
        const bool postChannelsKnown = asio_abi::asioErrorIsSuccess(
            state->driver->getChannels(&postRateInputs, &postRateOutputs));
        if (postChannelsKnown && config.outputChannelStart + config.format.channelCount > postRateOutputs) {
          outcome.result.failureKind = AsioOpenFailureKind::Format;
          outcome.error = "ASIO output channel configuration changed after the rate switch";
          return outcome;
        }
        if (postChannelsKnown && postRateInputs >= 0) state->inputChannels = std::clamp(postRateInputs, 0, kMaximumAsioChannels);
        traceAsioDriverCall("after getChannels (post-rate)");
        const long long roundedRate = std::llround(state->actualSampleRate);
        state->channelFormats.assign(static_cast<size_t>(config.format.channelCount), AsioChannelFormat{});
        // Pre-buffer channel information is advisory. Several drivers expose
        // their final sample type only after allocating buffers.
        for (int32_t channel = 0; channel < config.format.channelCount; ++channel) {
          asio_abi::AsioChannelInfo info{};
          info.channel = config.outputChannelStart + channel;
          info.isInput = asio_abi::kAsioFalse;
          if (asio_abi::asioErrorIsSuccess(state->driver->getChannelInfo(&info))) {
            if (auto format = channelFormatFor(info.type, state->sampleFormatMapping);
                format && isDsdSampleFormat(format->logicalFormat) == nativeDsdRequested)
              state->channelFormats[static_cast<size_t>(channel)] = *format;
          }
          if (nativeDsdRequested && !isDsdSampleFormat(state->channelFormats[channel].logicalFormat)) {
            const auto type = config.format.sampleFormat == AudioSampleFormat::DsdInt8Lsb1 ? asio_abi::kAsioSampleDsdInt8Lsb1
                : config.format.sampleFormat == AudioSampleFormat::DsdInt8Msb1 ? asio_abi::kAsioSampleDsdInt8Msb1 : asio_abi::kAsioSampleDsdInt8Ner8;
            state->channelFormats[channel] = *channelFormatFor(type);
          }
          traceNativeDsdText("channel-info-advisory", "channel=" + std::to_string(channel) + " type=" + std::to_string(info.type));
        }
        int32_t inputLatency = 0;
        int32_t outputLatency = 0;
        traceAsioDriverCall("before getLatencies");
        if (asio_abi::asioErrorIsSuccess(state->driver->getLatencies(&inputLatency, &outputLatency))) {
          state->latency = outputLatency;
        } else {
          // Emulated and proxy drivers (ASIO4ALL, ASIO2WASAPI, WINE) commonly
          // return ASE_NotPresent before buffers exist. Tolerate it as zero —
          // the post-createBuffers latency re-read fills in the real value —
          // instead of failing the whole driver.
          state->latency = 0;
        }
        traceAsioDriverCall("after getLatencies");
        std::array<char, 32> driverName{};
        traceAsioDriverCall("before getDriverName");
        state->driver->getDriverName(driverName.data());
        traceAsioDriverCall("after getDriverName");
        outcome.result.driverName = driverName.data();
        outcome.result.driverVersion = state->driver->getDriverVersion();
        const AudioSampleFormat actualSampleFormat = state->channelFormats.front().logicalFormat;
        const int actualSemanticRate = static_cast<int>(roundedRate);
        if (nativeDsdRequested && actualSemanticRate != config.format.sampleRate) {
          state->nativeDsdNegotiation = "sample-rate-mismatch";
          outcome.result.failureKind = AsioOpenFailureKind::Format;
          outcome.error = "ASIO driver returned a Native DSD semantic rate different from the requested stream";
          return outcome;
        }
        if (nativeDsdRequested && state->nativeDsdNegotiation == "get-unsupported") {
          state->nativeDsdNegotiation = "runtime-confirmed";
        }
        outcome.result.actualFormat = config.format;
        outcome.result.actualFormat.sampleRate = actualSemanticRate;
        outcome.result.actualFormat.sampleFormat = actualSampleFormat;
        outcome.result.actualFormat.bitDepth = bitDepthForFormat(outcome.result.actualFormat.sampleFormat);
        outcome.result.bufferSizeFrames = state->bufferSize;
        outcome.result.latencyFrames = state->latency;
        outcome.result.nativeDsdNegotiation = state->nativeDsdNegotiation;
        outcome.result.failureKind = AsioOpenFailureKind::None;
        outcome.ok = true;
        return outcome;
      },
      error);

  if (!operation || !operation->ok) {
    if (result) {
      result->nativeDsdNegotiation = state->nativeDsdNegotiation;
      // A control-thread timeout or rejection leaves no outcome; treat that as a
      // driver fault so the caller stops rather than hammering a wedged driver.
      result->failureKind =
          operation ? operation->result.failureKind : AsioOpenFailureKind::Driver;
    }
    if (error && operation) *error = operation->error;
    close();
    return false;
  }
  if (result) *result = operation->result;
  controlThread_->setMaintenance([state] { state->drainEvents(); });
  return true;
}

bool AsioDriverSession::probe(AsioDeviceInfo* info, std::string* error) {
  if (!info) {
    if (error) *error = "ASIO capability probe requires an output record";
    return false;
  }
  if (!controlThread_ || !controlThread_->start(error)) return false;

  const auto state = state_;
  const auto operation = controlThread_->call(
      [state, clsidText = entry_.clsid, systemReference = controlThread_->systemReference()]() {
        struct ProbeState {
          bool ok = false;
          AsioDeviceInfo info;
          std::string error;
        } outcome;

        CLSID clsid{};
        const std::wstring wideClsid(clsidText.begin(), clsidText.end());
        if (FAILED(CLSIDFromString(wideClsid.c_str(), &clsid))) {
          outcome.error = "ASIO driver CLSID is invalid";
          return outcome;
        }
        asio_abi::AsioDriver* driver = nullptr;
        const HRESULT activation = CoCreateInstance(
            clsid, nullptr, CLSCTX_INPROC_SERVER, clsid, reinterpret_cast<void**>(&driver));
        if (FAILED(activation) || !driver) {
          outcome.error = hresultError("ASIO driver activation failed", activation);
          return outcome;
        }
        if (!asio_abi::asioBoolIsTrue(driver->init(systemReference))) {
          outcome.error = driverError(driver, "ASIO driver initialization failed");
          driver->Release();
          return outcome;
        }

        // Capability enumeration must not switch the device's live I/O mode.
        double originalRate = 0;
        const bool originalRateKnown =
            asio_abi::asioErrorIsSuccess(driver->getSampleRate(&originalRate)) && originalRate > 0;

        int32_t inputChannels = 0;
        int32_t outputChannels = 0;
        if (asio_abi::asioErrorIsSuccess(driver->getChannels(&inputChannels, &outputChannels))) {
          outcome.info.outputChannels = static_cast<int>(outputChannels);
        }

        int32_t minimum = 0;
        int32_t maximum = 0;
        int32_t preferred = 0;
        int32_t granularity = 0;
        if (asio_abi::asioErrorIsSuccess(
                driver->getBufferSize(&minimum, &maximum, &preferred, &granularity))) {
          outcome.info.minBufferSize = minimum;
          outcome.info.maxBufferSize = maximum;
          outcome.info.preferredBufferSize = preferred;
          outcome.info.bufferGranularity = granularity;
        }

        for (int rate : asioDefaultSampleRateProbeSet()) {
          if (asio_abi::asioErrorIsSuccess(driver->canSampleRate(static_cast<double>(rate)))) {
            outcome.info.supportedSampleRates.push_back(rate);
          }
        }
        if (originalRateKnown) {
          const int rounded = static_cast<int>(std::llround(originalRate));
          outcome.info.defaultSampleRate = rounded;
          if (std::find(
                  outcome.info.supportedSampleRates.begin(),
                  outcome.info.supportedSampleRates.end(),
                  rounded) == outcome.info.supportedSampleRates.end()) {
            outcome.info.supportedSampleRates.push_back(rounded);
            std::sort(outcome.info.supportedSampleRates.begin(), outcome.info.supportedSampleRates.end());
          }
        }

        // The active channel sample type is the driver's authoritative PCM wire
        // format. Record it verbatim: guessing Int16/Int24/Float32 is exactly
        // what made format selection unreliable.
        asio_abi::AsioChannelInfo channelInfo{};
        channelInfo.channel = 0;
        channelInfo.isInput = asio_abi::kAsioFalse;
        channelInfo.isActive = asio_abi::kAsioTrue;
        if (asio_abi::asioErrorIsSuccess(driver->getChannelInfo(&channelInfo))) {
          if (const auto format = channelFormatFor(channelInfo.type)) {
            outcome.info.sampleFormats.push_back(format->logicalFormat);
            outcome.info.defaultSampleFormat = format->logicalFormat;
            const int depth = bitDepthForFormat(format->logicalFormat);
            outcome.info.bitDepths.push_back(depth);
            outcome.info.defaultBitDepth = depth;
          }
        }

        int32_t inputLatency = 0;
        int32_t outputLatency = 0;
        if (asio_abi::asioErrorIsSuccess(driver->getLatencies(&inputLatency, &outputLatency))) {
          outcome.info.outputLatencyFrames = outputLatency;
        }

        std::array<char, 32> driverName{};
        driver->getDriverName(driverName.data());
        outcome.info.driverName = driverName.data();
        outcome.info.driverVersion = driver->getDriverVersion();

        // DSD capability: ask before switching. CanDo is non-destructive, so a
        // driver that answers yes here is a genuine Native DSD candidate even
        // when it omits GetIoFormat.
        asio_abi::AsioIoFormat dsdIoFormat{};
        dsdIoFormat.formatType = asio_abi::kAsioIoFormatDsd;
        if (asio_abi::asioErrorIsSuccess(driver->future(asio_abi::kFutureCanDoIoFormat, &dsdIoFormat)) &&
            dsdIoFormat.formatType == asio_abi::kAsioIoFormatDsd) {
          outcome.info.nativeDsdCapable = true;
          for (int rate : asioDsdSemanticRateProbeSet()) {
            if (asio_abi::asioErrorIsSuccess(driver->canSampleRate(static_cast<double>(rate)))) {
              outcome.info.nativeDsdSampleRates.push_back(rate);
            }
          }
          outcome.info.nativeDsdSampleFormats = {
              AudioSampleFormat::DsdInt8Msb1,
              AudioSampleFormat::DsdInt8Lsb1,
              AudioSampleFormat::DsdInt8Ner8};
        }

        // DoP rides a normal PCM carrier, so any driver taking a 24-bit type at
        // a DoP carrier rate can attempt it. Both rate families are probed to
        // match dopCarrierFormatForDsd's carrier table: a 48k-family source
        // needs 192k/384k/768k/1536k carriers, and understating them here
        // mislabels capable devices.
        for (int rate : {176400, 192000, 352800, 384000, 705600, 768000, 1411200, 1536000}) {
          if (std::find(
                  outcome.info.supportedSampleRates.begin(),
                  outcome.info.supportedSampleRates.end(),
                  rate) != outcome.info.supportedSampleRates.end()) {
            outcome.info.dopCarrierSampleRates.push_back(rate);
          }
        }
        if (!outcome.info.dopCarrierSampleRates.empty()) {
          outcome.info.dopCapable = true;
          outcome.info.dopCarrierSampleFormats = {
              AudioSampleFormat::Int24Interleaved,
              AudioSampleFormat::Int24In32Interleaved,
              AudioSampleFormat::Int32Interleaved};
        }

        driver->Release();
        outcome.info.capabilityProbed = true;
        outcome.ok = outcome.info.outputChannels > 0 || !outcome.info.supportedSampleRates.empty();
        if (!outcome.ok) outcome.error = "ASIO driver did not report any usable capability";
        return outcome;
      },
      error);

  if (!operation || !operation->ok) {
    if (error && operation && !operation->error.empty()) *error = operation->error;
    return false;
  }

  // Identity fields stay owned by the catalog entry; the probe only contributes
  // capabilities.
  AsioDeviceInfo probed = operation->info;
  probed.id = info->id;
  probed.name = info->name;
  probed.isDefault = info->isDefault;
  if (probed.driverName.empty()) probed.driverName = info->driverName;
  probed.capabilityVersion = info->capabilityVersion;
  *info = probed;
  return true;
}

bool AsioDriverSession::createBuffers(
    AsioBufferSwitchCallback bufferSwitch,
    AsioEventCallback eventCallback,
    std::string* error) {
  const auto state = state_;
  const auto operation = controlThread_->call(
      [state, bufferSwitch = std::move(bufferSwitch), eventCallback = std::move(eventCallback)]() mutable {
        if (!state->driver || !state->initialized || state->buffersCreated) return false;
        state->controlError.clear();
        state->bufferSwitch = std::move(bufferSwitch);
        state->eventCallback = std::move(eventCallback);
        std::string installError;
        if (!AsioCallbackRouter::install(state.get(), &installError)) {
          state->controlError = installError; return false;
        }
        state->callbacks = AsioCallbackRouter::callbacks();
        const int32_t outputs = state->openConfig.format.channelCount;
        const bool dsd = isDsdSampleFormat(state->openConfig.format.sampleFormat);
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(7);
        int attempts = 0;
        std::set<std::pair<int32_t, int32_t>> tried;
        bool structuralFailure = false;
        std::string attemptSummary;
        const auto readRange = [state](AsioBufferRange* range) {
          const auto code = state->driver->getBufferSize(&range->minimum, &range->maximum, &range->preferred, &range->granularity);
          traceNativeDsdResult(state->driver, "get-buffer-size", code);
          traceNativeDsdText("buffer-range", "min=" + std::to_string(range->minimum) + " max=" + std::to_string(range->maximum) +
              " preferred=" + std::to_string(range->preferred) + " granularity=" + std::to_string(range->granularity));
          return asio_abi::asioErrorIsSuccess(code) && range->valid();
        };
        const auto dispose = [state]() {
          const auto code = state->driver->disposeBuffers();
          traceNativeDsdResult(state->driver, "dispose-buffers-retry", code);
          state->buffersCreated = false;
          state->buffers.clear();
          state->outputBufferOffset = 0;
        };
        const auto refreshFormats = [state, outputs, dsd]() {
          std::vector<AsioChannelFormat> formats;
          for (int32_t channel = 0; channel < outputs; ++channel) {
            asio_abi::AsioChannelInfo info{};
            info.channel = state->openConfig.outputChannelStart + channel;
            info.isInput = asio_abi::kAsioFalse;
            const auto code = state->driver->getChannelInfo(&info);
            const auto format = channelFormatFor(info.type, state->sampleFormatMapping);
            traceNativeDsdText("channel-info-post-create", "channel=" + std::to_string(channel) +
                " type=" + std::to_string(info.type) + " result=" + std::to_string(code));
            if (!asio_abi::asioErrorIsSuccess(code) || !format || !asio::isSupportedChannelFormat(*format)) {
              state->controlError = "unsupported_asio_sample_type: channel=" + std::to_string(channel) +
                  " type=" + std::to_string(info.type) + " result=" + std::to_string(code);
              return false;
            }
            if (isDsdSampleFormat(format->logicalFormat) != dsd ||
                (dsd && !formats.empty() && !asio::channelFormatsMatch(formats.front(), *format))) {
              state->controlError = "ASIO output channel I/O format mismatch after buffer creation";
              return false;
            }
            if (!state->buffers[static_cast<size_t>(state->outputBufferOffset + channel)].buffers[0] ||
                !state->buffers[static_cast<size_t>(state->outputBufferOffset + channel)].buffers[1]) {
              state->controlError = "ASIO driver returned a null output buffer"; return false;
            }
            formats.push_back(*format);
          }
          AsioRateNegotiator rate(*state->driver);
          double actual = 0;
          if (!rate.read(&actual) || std::abs(actual - asio::driverSampleRate(state->openConfig.format)) > 0.01) {
            state->controlError = "ASIO sample rate changed during buffer creation"; return false;
          }
          state->actualSampleRate = actual;
          state->channelFormats = std::move(formats);
          return true;
        };
        const auto tryRange = [&](const AsioBufferRange& range) {
          const auto candidates = sessionBufferSizeCandidates(range, state->openConfig, dsd, state->bufferSizeScale);
          // Output-only keeps healthy playback drivers inexpensive. Duplex is
          // a fallback for drivers that require their input pins to be allocated.
          const int configurations = !dsd && !state->openConfig.format.dopEncoded && state->inputChannels > 0 ? 2 : 1;
          for (int configuration = 0; configuration < configurations; ++configuration) {
            const int32_t inputs = configuration == 1 ? state->inputChannels : 0;
            for (int32_t size : candidates) {
              if (!tried.emplace(size, inputs).second) continue;
              if (attempts >= 96 || std::chrono::steady_clock::now() >= deadline) return false;
              ++attempts;
              state->buffers.assign(static_cast<size_t>(inputs + outputs), {});
              state->outputBufferOffset = inputs;
              for (int32_t channel = 0; channel < inputs + outputs; ++channel) {
                state->buffers[channel].isInput = channel < inputs ? asio_abi::kAsioTrue : asio_abi::kAsioFalse;
                state->buffers[channel].channelNum = channel < inputs ? channel : state->openConfig.outputChannelStart + channel - inputs;
              }
              const auto code = state->driver->createBuffers(state->buffers.data(), inputs + outputs, size, &state->callbacks);
              traceNativeDsdResult(state->driver, "create-buffers-candidate", code, size);
              if (attemptSummary.size() < 320) attemptSummary += " " + std::to_string(size) + "/in=" + std::to_string(inputs) + ":" + std::to_string(code);
              if (asio_abi::asioErrorIsSuccess(code)) {
                state->buffersCreated = true;
                state->bufferSize = size;
                if (refreshFormats()) return true;
                structuralFailure = true;
              }
              // An error may follow a partial allocation. Dispose before any
              // retry, including preferred, duplex, clock pivot and dummy start.
              dispose();
              if (structuralFailure) return false;
            }
          }
          return false;
        };
        AsioBufferRange range;
        bool created = readRange(&range) && tryRange(range);
        if (!created && !structuralFailure && std::chrono::steady_clock::now() < deadline) {
          AsioBufferRange refreshed;
          if (readRange(&refreshed)) { range = refreshed; created = tryRange(range); }
        }
        if (!created && !structuralFailure && std::chrono::steady_clock::now() < deadline) {
          AsioRateNegotiator rate(*state->driver, [state](const std::string& name, asio_abi::AsioError code, double value) {
            traceNativeDsdResult(state->driver, name.c_str(), code, value);
          });
          const auto pivotDeadline = std::min(deadline, std::chrono::steady_clock::now() + std::chrono::milliseconds(2000));
          if (rate.pivot(asio::driverSampleRate(state->openConfig.format), dsd, &state->actualSampleRate, pivotDeadline) && readRange(&range)) {
            tried.clear();
            created = tryRange(range);
          }
        }
        if (!created && !structuralFailure && !dsd && !state->openConfig.format.dopEncoded &&
            std::abs(state->actualSampleRate - asio::driverSampleRate(state->openConfig.format)) <= 0.01 &&
            std::chrono::steady_clock::now() < deadline) {
          // Retain the bounded initialization round for drivers that finalize
          // setup only after a start/stop. Never start uninitialized DSD buffers.
          const auto candidates = bufferSizeCandidates(range, range.preferred);
          if (!candidates.empty()) {
            const int32_t size = candidates.front();
            const int32_t count = std::min(outputs, 2);
            std::array<asio_abi::AsioBufferInfo, 2> dummy{};
            for (int32_t channel = 0; channel < count; ++channel) dummy[channel].channelNum = state->openConfig.outputChannelStart + channel;
            state->danceInProgress.store(true, std::memory_order_release);
            const auto code = state->driver->createBuffers(dummy.data(), count, size, &state->callbacks);
            if (asio_abi::asioErrorIsSuccess(code)) {
              bool safe = true;
              for (int32_t channel = 0; channel < count; ++channel) {
                asio_abi::AsioChannelInfo info{}; info.channel = state->openConfig.outputChannelStart + channel;
                const auto queried = state->driver->getChannelInfo(&info);
                const auto format = channelFormatFor(info.type);
                if (!asio_abi::asioErrorIsSuccess(queried) || !format || isDsdSampleFormat(format->logicalFormat)) { safe = false; break; }
                for (auto* buffer : dummy[channel].buffers) {
                  if (!buffer) { safe = false; break; }
                  std::memset(buffer, 0, static_cast<size_t>(size) * asio::bytesPerSample(*format));
                }
              }
              if (safe) {
                if (asio_abi::asioErrorIsSuccess(state->driver->start())) asioControlPause(std::chrono::milliseconds(80));
                state->driver->stop();
              }
            }
            dispose();
            state->danceInProgress.store(false, std::memory_order_release);
            state->pendingEvents.store(0, std::memory_order_release);
            tried.clear();
            if (readRange(&range)) created = tryRange(range);
          }
        }
        state->startupSummary = "requestedRate=" + std::to_string(state->openConfig.format.sampleRate) +
            " actualRate=" + std::to_string(state->actualSampleRate) + " attempts=" + std::to_string(attempts) +
            " requestedBuffer=" + std::to_string(state->openConfig.bufferSizeFrames) +
            " bufferScale=" + std::to_string(state->bufferSizeScale) +
            " driverBuffer=" + std::to_string(state->bufferSize) +
            " buffers=" + attemptSummary;
        if (!created) {
          AsioCallbackRouter::uninstall(state.get(), nullptr);
          if (state->controlError.empty()) state->controlError = "ASIO buffer creation failed: " + state->startupSummary;
          return false;
        }
        int32_t inputLatency = 0, outputLatency = 0;
        if (asio_abi::asioErrorIsSuccess(state->driver->getLatencies(&inputLatency, &outputLatency))) state->latency = outputLatency;
        state->pendingEvents.store(0, std::memory_order_release);
        return true;
      }, error);
  if (!operation || !*operation) {
    if (operation && error) *error = state->controlError.empty() ? "ASIO buffer creation failed" : state->controlError;
    return false;
  }
  return true;
}

bool AsioDriverSession::start(std::string* error) {
  const auto state = state_;
  const auto operation = controlThread_->call(
      [state] {
        if (!state->driver || !state->buffersCreated || state->started) return false;
        state->running = true;
        traceAsioDriverCall("before start");
        if (!asio_abi::asioErrorIsSuccess(state->driver->start())) {
          state->running = false;
          state->driver->stop();
          return false;
        }
        traceAsioDriverCall("after start");
        state->started = true;
        return true;
      },
      error);
  if (!operation || !*operation) {
    if (error && error->empty()) *error = "ASIO driver start failed";
    return false;
  }
  return true;
}

void AsioDriverSession::stop() {
  const auto state = state_;
  std::string ignored;
  controlThread_->call(
      [state] {
        state->running = false;
        if (state->driver && state->started) state->driver->stop();
        state->started = false;
        return true;
      },
      &ignored);
}

void AsioDriverSession::close() {
  if (!controlThread_) return;
  const auto state = state_;
  std::string cleanupError;
  const auto operation = controlThread_->call(
      [state, retainedCloseError = lastCloseError_] {
        struct CloseState {
          bool ok = true;
          std::string error;
        } outcome;
        state->running = false;
        if (!state->driver) {
          // Releasing COM cannot prove that a failed format restoration later
          // succeeded. Preserve that failure across repeated close calls.
          outcome.ok = retainedCloseError.empty();
          outcome.error = retainedCloseError;
          return outcome;
        }
        traceAsioDriverCall("before close");
        if (state->started) state->driver->stop();
        state->started = false;
        if (state->buffersCreated) {
          std::string uninstallError;
          if (!AsioCallbackRouter::uninstall(state.get(), &uninstallError)) {
            outcome.ok = false;
            outcome.error = uninstallError.empty()
                ? "ASIO callback router could not be released"
                : uninstallError;
            return outcome;
          }
          state->driver->disposeBuffers();
          state->buffersCreated = false;
        }
        std::string restoreError;
        if (!state->restoreNativeDsdConfiguration(&restoreError)) {
          outcome.ok = false;
          outcome.error = restoreError;
        }
        state->buffers.clear();
        state->channelFormats.clear();
        state->bufferSwitch = nullptr;
        state->eventCallback = nullptr;
        traceAsioDriverCall("before Release");
        state->driver->Release();
        traceAsioDriverCall("after Release");
        state->driver = nullptr;
        state->initialized = false;
        return outcome;
      },
      &cleanupError);
  controlThread_->setMaintenance(nullptr);
  if (!operation || !operation->ok) {
    lastCloseError_ = operation && !operation->error.empty()
        ? operation->error
        : (cleanupError.empty() ? "ASIO driver close did not complete" : cleanupError);
    traceAsioDriverCall(("close cleanup incomplete: " + cleanupError).c_str());
    // The worker is wedged inside a driver call and this session is being
    // abandoned; the cleanup lambda above will never run. The process-wide
    // callback router still points at this session's State, so without a
    // forced release every future ASIO session fails at install ("only one
    // ASIO session may own the callback router") until process restart, and a
    // late driver callback could reach freed memory. The router's dispatch
    // double-check makes this race-free: callbacks arriving after the CAS see
    // a null target and no-op. The drain result is best-effort — the CAS is
    // the part that matters.
    std::string forceError;
    AsioCallbackRouter::uninstall(state.get(), &forceError);
    traceAsioDriverCall(("forced callback router release: " + forceError).c_str());
    return;
  }
  lastCloseError_.clear();
}

std::string AsioDriverSession::lastCloseError() const {
  return lastCloseError_;
}

void* AsioDriverSession::outputBuffer(long channel, long bufferIndex) const {
  if (channel < 0 || bufferIndex < 0 || bufferIndex > 1) return nullptr;
  const size_t channelIndex = static_cast<size_t>(channel);
  const size_t index = channelIndex + static_cast<size_t>(state_->outputBufferOffset);
  if (channelIndex >= state_->channelFormats.size() || index >= state_->buffers.size()) return nullptr;
  return state_->buffers[index].buffers[static_cast<size_t>(bufferIndex)];
}

AsioChannelFormat AsioDriverSession::outputChannelFormat(long channel) const {
  if (channel >= 0 && static_cast<size_t>(channel) < state_->channelFormats.size()) {
    return state_->channelFormats[static_cast<size_t>(channel)];
  }
  return {};
}

bool AsioDriverSession::outputReady() {
  if (!state_->running.load(std::memory_order_acquire) || !state_->driver) return false;
  return asio_abi::asioErrorIsSuccess(state_->driver->outputReady());
}

long AsioDriverSession::activeBufferSize() const { return state_->bufferSize; }
int AsioDriverSession::activeSampleRate() const { return static_cast<int>(std::llround(state_->actualSampleRate)); }
long AsioDriverSession::activeLatencyFrames() const { return state_->latency; }
std::string AsioDriverSession::startupSummary() const { return state_->startupSummary; }

}  // namespace twilight::audio::asio_windows
