#include "AsioHelperHost.h"

#include "AsioRenderUtils.h"
#include "AsioRealtimeThread.h"
#include "DeviceCapabilityCache.h"
#include "windows/AsioDriverCatalog.h"
#include <cstdlib>
#include <string_view>

#include <Windows.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <thread>

namespace twilight::audio {
namespace {

constexpr auto kSlowControlDeadline = std::chrono::seconds(12);
constexpr auto kCloseControlDeadline = std::chrono::seconds(3);

}  // namespace

AsioHelperHost::AsioHelperHost()
    : AsioHelperHost(asio_helper::locateAsioHelperExecutable(AsioArchitecture::X64, nullptr),
        asio_helper::locateAsioHelperExecutable(AsioArchitecture::X86, nullptr),
        asio_windows::AsioDriverCatalog::enumerateAll) {}

AsioHelperHost::AsioHelperHost(std::wstring helperPath)
    : process_(std::make_unique<asio_helper::AsioHelperProcess>(std::move(helperPath))) {}

AsioHelperHost::AsioHelperHost(std::wstring x64Path, std::wstring x86Path, CatalogProvider catalog)
    : process_(std::make_unique<asio_helper::AsioHelperProcess>(x64Path, AsioArchitecture::X64)),
      catalog_(std::move(catalog)), x64Path_(std::move(x64Path)), x86Path_(std::move(x86Path)) {}

bool AsioHelperHost::selectDevice(const std::string& deviceId, std::string* resolvedId, std::string* error) {
  *resolvedId = deviceId;
  if (!catalog_) return true;  // Preserve single-path fixture injection.
  const char* disabled = std::getenv("TWILIGHT_DISABLE_ASIO");
  if (disabled && std::string_view(disabled) == "1") {
    if (error) *error = "ASIO backend is disabled by TWILIGHT_DISABLE_ASIO=1";
    return false;
  }
  const auto entry = asio_windows::AsioDriverCatalog::resolveEntries(catalog_(), deviceId);
  if (!entry) {
    if (error) *error = "ASIO device was not found or legacy device name is ambiguous: " + deviceId;
    return false;
  }
  *resolvedId = entry->id;
  if (architecture_ == entry->architecture) return true;
  if (started_.load(std::memory_order_acquire)) {
    if (error) *error = "Stop the active ASIO stream before probing another driver architecture";
    return false;
  }
  close();  // Drains the render worker before replacing its process/mapping.
  if (!lastCloseError().empty() && process_->failureReason() != asio_helper::FailureReason::LaunchFailed) {
    if (error) *error = lastCloseError();
    return false;
  }
  process_->shutdown();
  architecture_ = entry->architecture;
  process_ = std::make_unique<asio_helper::AsioHelperProcess>(
      architecture_ == AsioArchitecture::X86 ? x86Path_ : x64Path_, architecture_);
  { std::lock_guard lock(stateMutex_); closeError_.clear(); }
  return true;
}

AsioHelperHost::~AsioHelperHost() {
  close();
  stopWorker();
  process_->shutdown();
}

bool AsioHelperHost::ensureProcess(std::string* error) const {
  if (process_->alive() && process_->shared()) return true;
  if (process_->failureReason() != asio_helper::FailureReason::None) {
    if (error) *error = process_->lastFailure();
    return false;
  }
  return process_->launch(error);
}

std::vector<AsioDeviceInfo> AsioHelperHost::enumerateDevices() {
  if (catalog_) {
    const char* disabled = std::getenv("TWILIGHT_DISABLE_ASIO");
    if (disabled && std::string_view(disabled) == "1") return {};
    std::vector<AsioDeviceInfo> devices;
    for (const auto& entry : catalog_()) {
      AsioDeviceInfo device = DeviceCapabilityCache::instance().get(entry.id).value_or(AsioDeviceInfo{});
      device.id = entry.id;
      device.name = entry.displayName;
      device.driverName = entry.displayName;
      device.driverArchitecture = asioArchitectureName(entry.architecture);
      devices.push_back(std::move(device));
    }
    return devices;
  }
  std::string error;
  if (!ensureProcess(&error)) {
    std::lock_guard lock(stateMutex_);
    closeError_ = error;
    return {};
  }
  auto response = std::make_unique<asio_helper::Response>();
  if (!process_->request(
          asio_helper::Command::EnumerateDevices,
          response.get(),
          kSlowControlDeadline,
          &error)) {
    std::lock_guard lock(stateMutex_);
    closeError_ = error;
    return {};
  }
  std::vector<AsioDeviceInfo> devices;
  const size_t count = std::min<size_t>(response->deviceCount, asio_helper::kMaxDevices);
  devices.reserve(count);
  for (size_t index = 0; index < count; ++index) {
    AsioDeviceInfo device = asio_helper::decodeDevice(response->devices[index]);
    if (!device.capabilityProbed) {
      if (const auto cached = DeviceCapabilityCache::instance().get(device.id)) {
        AsioDeviceInfo merged = *cached;
        merged.id = device.id;
        merged.name = device.name;
        if (merged.driverName.empty()) merged.driverName = device.driverName;
        device = std::move(merged);
      }
    }
    devices.push_back(std::move(device));
  }
  return devices;
}

AsioHostDiagnostics AsioHelperHost::diagnostics() const {
  if (catalog_) {
    AsioHostDiagnostics result;
    result.processArchitecture = asioArchitectureName(nativeAsioArchitecture());
    result.helperArchitecture = process_->alive() ? asioArchitectureName(architecture_) : "";
    result.buildEnabled = true;
    const char* disabled = std::getenv("TWILIGHT_DISABLE_ASIO");
    result.environmentDisabled = disabled && std::string_view(disabled) == "1";
    const auto catalog = asio_windows::AsioDriverCatalog::diagnostics();
    result.registeredDriverCount32 = catalog.registeredDriverCount32;
    result.registeredDriverCount64 = catalog.registeredDriverCount64;
    result.loadableDriverCount32 = catalog.loadableDriverCount32;
    result.loadableDriverCount64 = catalog.loadableDriverCount64;
    return result;
  }
  std::string error;
  if (!ensureProcess(&error)) {
    std::lock_guard lock(stateMutex_);
    closeError_ = error;
    AsioHostDiagnostics result;
    result.processArchitecture = sizeof(void*) == 8 ? "x64" : "x86";
    result.buildEnabled = true;
    return result;
  }
  auto response = std::make_unique<asio_helper::Response>();
  if (!process_->request(
          asio_helper::Command::GetDiagnostics,
          response.get(),
          kSlowControlDeadline,
          &error)) {
    std::lock_guard lock(stateMutex_);
    closeError_ = error;
    AsioHostDiagnostics result;
    result.processArchitecture = sizeof(void*) == 8 ? "x64" : "x86";
    result.buildEnabled = true;
    return result;
  }
  return asio_helper::decodeDiagnostics(response->diagnostics);
}

bool AsioHelperHost::probeDevice(
    const std::string& deviceId,
    AsioDeviceInfo* info,
    std::string* error) {
  if (!info) {
    if (error) *error = "ASIO capability probe requires an output record";
    return false;
  }
  std::string resolvedId;
  if (!selectDevice(deviceId, &resolvedId, error) || !ensureProcess(error)) {
    std::lock_guard lock(stateMutex_);
    closeError_ = error ? *error : process_->lastFailure();
    return false;
  }
  auto response = std::make_unique<asio_helper::Response>();
  const bool ok = process_->request(
      asio_helper::Command::ProbeDevice,
      [&](asio_helper::Request& request) {
        asio_helper::copyText(request.deviceId, sizeof(request.deviceId), resolvedId);
      },
      response.get(),
      kSlowControlDeadline,
      error);
  if (!ok) {
    std::lock_guard lock(stateMutex_);
    closeError_ = error ? *error : process_->lastFailure();
    return false;
  }
  *info = asio_helper::decodeDevice(response->device);
  if (info->capabilityProbed) {
    DeviceCapabilityCache::instance().put(*info);
  }
  return true;
}

bool AsioHelperHost::open(
    const AsioOpenConfig& config,
    AsioOpenResult* result,
    std::string* error) {
  close();
  {
    std::lock_guard lock(stateMutex_);
    closeError_.clear();
  }
  helperFailureDispatched_.store(false, std::memory_order_release);
  std::string resolvedId;
  if (!selectDevice(config.deviceId, &resolvedId, error) || !ensureProcess(error)) return false;
  auto response = std::make_unique<asio_helper::Response>();
  const bool ok = process_->request(
      asio_helper::Command::Open,
      [&](asio_helper::Request& request) {
        asio_helper::copyText(request.deviceId, sizeof(request.deviceId), resolvedId);
        request.format = asio_helper::encodeAudioFormat(config.format);
        request.bufferSizeFrames = static_cast<int32_t>(config.bufferSizeFrames);
        request.outputChannelStart = config.outputChannelStart;
        if (config.sampleFormatMapping) {
          request.sampleFormatMappingReported =
              static_cast<int32_t>(config.sampleFormatMapping->reported);
          request.sampleFormatMappingInterpreted =
              static_cast<int32_t>(config.sampleFormatMapping->interpreted);
        }
        request.nativeDsdControlOrder = static_cast<int32_t>(config.nativeDsdControlOrder);
        request.dsdMinimumBufferFrames = static_cast<int32_t>(config.dsdMinimumBufferFrames);
        request.dsdCadenceConfirmCallbacks = static_cast<int32_t>(config.dsdCadenceConfirmCallbacks);
      },
      response.get(),
      kSlowControlDeadline,
      error);
  if (result) {
    result->actualFormat = asio_helper::decodeAudioFormat(response->actualFormat);
    result->bufferSizeFrames = response->bufferSizeFrames;
    result->latencyFrames = response->latencyFrames;
    result->driverName = asio_helper::readText(response->driverName);
    result->driverVersion = response->driverVersion;
    result->nativeDsdNegotiation = asio_helper::readText(response->nativeDsdNegotiation);
    result->failureKind = static_cast<AsioOpenFailureKind>(response->openFailureKind);
  }
  if (!ok) {
    {
      std::lock_guard lock(stateMutex_);
      closeError_ = error ? *error : process_->lastFailure();
    }
    if (response->failureReason ==
        static_cast<int32_t>(asio_helper::FailureReason::FormatRestoreFailed)) {
      process_->abort(
          asio_helper::FailureReason::FormatRestoreFailed,
          asio_helper::readText(response->message));
    }
    return false;
  }
  std::lock_guard lock(stateMutex_);
  openFormat_ = config.format;
  return true;
}

bool AsioHelperHost::createBuffers(
    AsioBufferSwitchCallback bufferSwitch,
    AsioEventCallback eventCallback,
    std::string* error) {
  if (!ensureProcess(error)) return false;
  auto response = std::make_unique<asio_helper::Response>();
  if (!process_->request(
          asio_helper::Command::CreateBuffers,
          response.get(),
          kSlowControlDeadline,
          error)) {
    std::lock_guard lock(stateMutex_);
    closeError_ = error ? *error : process_->lastFailure();
    return false;
  }
  if (response->channelCount == 0 || response->channelCount > asio_helper::kMaxChannels ||
      response->bufferSizeFrames <= 0 ||
      response->bufferSizeFrames > static_cast<int32_t>(asio_helper::kMaxFrames)) {
    if (error) *error = asio_helper::failureMessage(
        asio_helper::FailureReason::ProtocolError,
        "ASIO helper returned invalid buffer geometry");
    process_->abort(asio_helper::FailureReason::ProtocolError, "invalid buffer geometry");
    return false;
  }
  {
    std::lock_guard lock(stateMutex_);
    bufferSwitch_ = std::move(bufferSwitch);
    eventCallback_ = std::move(eventCallback);
    activeBufferSize_ = response->bufferSizeFrames;
    activeSampleRate_ = response->actualFormat.sampleRate;
    activeLatencyFrames_ = response->latencyFrames;
    startupSummary_ = asio_helper::readText(response->startupSummary);
    channelFormats_.clear();
    channelFormats_.reserve(response->channelCount);
    for (uint32_t channel = 0; channel < response->channelCount; ++channel) {
      const AsioChannelFormat format =
          asio_helper::decodeChannelFormat(response->channelFormats[channel]);
      const auto& record = response->channelFormats[channel];
      if (!asio_helper::validSampleFormat(record.logicalFormat) || record.littleEndian > 1 ||
          record.validBitsAreMostSignificant > 1 || !asio::isSupportedChannelFormat(format)) {
        if (error) *error = "ASIO helper returned an invalid channel format";
        process_->abort(asio_helper::FailureReason::ProtocolError, "invalid channel format");
        return false;
      }
      channelFormats_.push_back(format);
      renderChannelFormats_[channel] = format;
    }
    renderChannelCount_.store(response->channelCount, std::memory_order_release);
  }
  startWorker();
  return true;
}

bool AsioHelperHost::start(std::string* error) {
  auto* shared = process_->shared();
  if (shared && shared->renderQueueCapacity > 0) {
    renderAhead_.store(true, std::memory_order_release);
    process_->wakeCallbacks();
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(50);
    const uint32_t target = std::min<uint32_t>(8, shared->renderQueueCapacity);
    while (std::chrono::steady_clock::now() < deadline &&
           static_cast<uint32_t>(asio_helper::readAtomic(&shared->renderQueueWrite) -
               asio_helper::readAtomic(&shared->renderQueueRead)) < target) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
  }
  if (!process_->request(
          asio_helper::Command::Start,
          nullptr,
          kSlowControlDeadline,
          error)) {
    std::lock_guard lock(stateMutex_);
    closeError_ = error ? *error : process_->lastFailure();
    renderAhead_.store(false, std::memory_order_release);
    return false;
  }
  started_.store(true, std::memory_order_release);
  return true;
}

void AsioHelperHost::stop() {
  renderAhead_.store(false, std::memory_order_release);
  started_.store(false, std::memory_order_release);
  if (!process_->alive()) return;
  std::string ignored;
  if (!process_->request(
      asio_helper::Command::Stop,
      nullptr,
      kCloseControlDeadline,
      &ignored)) {
    std::lock_guard lock(stateMutex_);
    closeError_ = ignored.empty() ? process_->lastFailure() : ignored;
  }
}

void AsioHelperHost::close() {
  renderAhead_.store(false, std::memory_order_release);
  started_.store(false, std::memory_order_release);
  if (process_->alive()) {
    auto response = std::make_unique<asio_helper::Response>();
    std::string error;
    if (!process_->request(
            asio_helper::Command::Close,
            response.get(),
            kCloseControlDeadline,
            &error)) {
      {
        std::lock_guard lock(stateMutex_);
        closeError_ = error;
      }
      if (response->failureReason ==
          static_cast<int32_t>(asio_helper::FailureReason::FormatRestoreFailed)) {
        process_->abort(
            asio_helper::FailureReason::FormatRestoreFailed,
            asio_helper::readText(response->message));
      }
    } else if (response->formatRestored == 0) {
      {
        std::lock_guard lock(stateMutex_);
        closeError_ = asio_helper::failureMessage(
            asio_helper::FailureReason::FormatRestoreFailed,
            "ASIO helper did not restore the retained PCM format");
      }
      process_->abort(
          asio_helper::FailureReason::FormatRestoreFailed,
          "ASIO helper did not restore the retained PCM format");
    } else {
      std::lock_guard lock(stateMutex_);
      closeError_.clear();
    }
  } else if (!process_->lastFailure().empty()) {
    std::lock_guard lock(stateMutex_);
    closeError_ = process_->lastFailure();
  }
  stopWorker();
  renderChannelCount_.store(0, std::memory_order_release);
  std::lock_guard lock(stateMutex_);
  bufferSwitch_ = nullptr;
  eventCallback_ = nullptr;
  channelFormats_.clear();
  activeBufferSize_ = 0;
}

void* AsioHelperHost::outputBuffer(long channel, long bufferIndex) {
  return asio_helper::channelBuffer(process_->shared(), channel, bufferIndex);
}

AudioSampleFormat AsioHelperHost::outputSampleFormat(long channel) const {
  return outputChannelFormat(channel).logicalFormat;
}

AsioChannelFormat AsioHelperHost::outputChannelFormat(long channel) const {
  std::lock_guard lock(stateMutex_);
  if (channel < 0 || static_cast<size_t>(channel) >= channelFormats_.size()) return {};
  return channelFormats_[static_cast<size_t>(channel)];
}

bool AsioHelperHost::outputReady() {
  return process_->alive();
}

long AsioHelperHost::activeBufferSize() const {
  std::lock_guard lock(stateMutex_);
  return activeBufferSize_;
}

int AsioHelperHost::activeSampleRate() const {
  std::lock_guard lock(stateMutex_);
  return activeSampleRate_;
}

long AsioHelperHost::activeLatencyFrames() const {
  std::lock_guard lock(stateMutex_);
  return activeLatencyFrames_;
}

std::string AsioHelperHost::startupSummary() const {
  std::lock_guard lock(stateMutex_);
  return startupSummary_;
}

size_t AsioHelperHost::activeRenderFrameCapacity() const {
  const auto* shared = process_->shared();
  return shared ? static_cast<size_t>(std::max<LONG>(0, asio_helper::readAtomic(&shared->activeRenderFrameCapacity))) : 0;
}

bool AsioHelperHost::dsdBufferUnitConfirmed() const {
  const auto* shared = process_->shared();
  return shared && asio_helper::readAtomic(&shared->dsdBufferUnitConfirmed) != 0;
}

AsioRenderHealth AsioHelperHost::renderHealth() const {
  const auto* shared = process_->shared();
  if (!shared) return {};
  return {
      static_cast<uint32_t>(asio_helper::readAtomic(&shared->callbackHeartbeat)),
      static_cast<uint32_t>(asio_helper::readAtomic(&shared->renderUnderrunCount)),
      static_cast<uint32_t>(asio_helper::readAtomic(&shared->callbackDropCount))};
}

void AsioHelperHost::commitOutputBuffer(long bufferIndex, size_t frameCount) {
  auto* shared = process_->shared();
  if (!shared || bufferIndex < 0 || bufferIndex > 1) return;
  asio_helper::RenderBuffer& buffer = shared->buffers[bufferIndex];
  const uint32_t boundedFrames = static_cast<uint32_t>(
      std::min({frameCount, size_t{asio_helper::kMaxFrames}, activeRenderFrameCapacity()}));
  const uint32_t channelCount = std::min<uint32_t>(
      renderChannelCount_.load(std::memory_order_acquire),
      asio_helper::kMaxChannels);
  buffer.committedFrames = boundedFrames;
  std::memset(buffer.channelBytes, 0, sizeof(buffer.channelBytes));
  for (uint32_t channel = 0; channel < channelCount; ++channel) {
    const size_t bytes =
        asio::wireBytesForFrames(renderChannelFormats_[channel], boundedFrames);
    buffer.channelBytes[channel] = static_cast<uint32_t>(
        std::min<size_t>(bytes, asio_helper::kChannelStride));
  }
  if (shared->renderQueueCapacity > 0) {
    const uint32_t write = static_cast<uint32_t>(asio_helper::readAtomic(&shared->renderQueueWrite));
    const uint32_t read = static_cast<uint32_t>(asio_helper::readAtomic(&shared->renderQueueRead));
    if (write - read >= shared->renderQueueCapacity) {
      asio_helper::incrementAtomic(&shared->callbackDropCount);
      return;
    }
    auto& queued = shared->renderQueueBlocks[write % shared->renderQueueCapacity];
    queued.committedFrames = boundedFrames;
    for (uint32_t channel = 0; channel < channelCount; ++channel) {
      queued.channelBytes[channel] = buffer.channelBytes[channel];
      auto* destination = asio_helper::queuedChannelBuffer(shared, write, channel);
      if (!destination || buffer.channelBytes[channel] > shared->renderQueueChannelStride) return;
      std::memcpy(destination, asio_helper::channelBuffer(shared, channel, bufferIndex), buffer.channelBytes[channel]);
    }
    MemoryBarrier();
    asio_helper::exchangeAtomic(&shared->renderQueueWrite, static_cast<LONG>(write + 1));
    return;
  }
  MemoryBarrier();
  asio_helper::incrementAtomic(&buffer.generation);
}

std::string AsioHelperHost::lastCloseError() const {
  std::lock_guard lock(stateMutex_);
  return closeError_;
}

void AsioHelperHost::startWorker() {
  bool expected = false;
  if (!workerRunning_.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) return;
  worker_ = std::thread([this] { workerLoop(); });
}

void AsioHelperHost::stopWorker() {
  workerRunning_.store(false, std::memory_order_release);
  process_->wakeCallbacks();
  if (worker_.joinable() && worker_.get_id() != std::this_thread::get_id()) worker_.join();
}

std::chrono::milliseconds AsioHelperHost::callbackDeadline() const {
  std::lock_guard lock(stateMutex_);
  const int frameRate = std::max(1, asio::callbackFrameRate(openFormat_));
  const double periodMs = static_cast<double>(std::max<long>(1, activeBufferSize_)) * 1000.0 /
      static_cast<double>(frameRate);
  return std::chrono::milliseconds(static_cast<int64_t>(std::max(2000.0, periodMs * 8.0)));
}

void AsioHelperHost::workerLoop() {
  asio::RealtimeThread realtimeThread;
  int32_t callbackRead = 0;
  int32_t hostEventRead = 0;
  int32_t lastHeartbeat = 0;
  bool wasStarted = false;
  auto lastCallback = std::chrono::steady_clock::now();
  while (workerRunning_.load(std::memory_order_acquire)) {
    auto* shared = process_->shared();
    if (!shared || !process_->alive()) {
      if (started_.load(std::memory_order_acquire)) {
        dispatchHelperFailure(
            process_->failureReason() == asio_helper::FailureReason::None
                ? asio_helper::FailureReason::ProcessExited
                : process_->failureReason(),
            process_->lastFailure());
      }
      break;
    }

    const int32_t callbackWrite = asio_helper::readAtomic(&shared->callbackWriteSequence);
    while (callbackRead < callbackWrite) {
      const asio_helper::CallbackRecord record =
          shared->callbacks[static_cast<uint32_t>(callbackRead) % asio_helper::kCallbackRingSize];
      ++callbackRead;
      asio_helper::exchangeAtomic(&shared->callbackReadSequence, callbackRead);
      AsioBufferSwitchCallback callback;
      {
        std::lock_guard lock(stateMutex_);
        callback = bufferSwitch_;
      }
      if (shared->renderQueueCapacity == 0 && callback && record.bufferIndex >= 0 && record.bufferIndex <= 1) {
        asio_helper::RenderBuffer& buffer = shared->buffers[record.bufferIndex];
        const LONG generation = asio_helper::readAtomic(&buffer.generation);
        const LONG consumed = asio_helper::readAtomic(&buffer.consumedGeneration);
        if (generation == consumed) {
          callback(record.bufferIndex);
        } else {
          asio_helper::incrementAtomic(&shared->callbackDropCount);
        }
      }
    }

    if (shared->renderQueueCapacity > 0 && renderAhead_.load(std::memory_order_acquire)) {
      AsioBufferSwitchCallback callback;
      { std::lock_guard lock(stateMutex_); callback = bufferSwitch_; }
      const double periodMs = activeRenderFrameCapacity() * 8000.0 / std::max(1, openFormat_.sampleRate);
      const uint32_t target = std::min<uint32_t>(shared->renderQueueCapacity,
          dsdBufferUnitConfirmed() && periodMs > 0
              ? static_cast<uint32_t>(std::clamp(std::ceil(8.0 / periodMs), 2.0, 32.0)) : 8);
      for (uint32_t block = 0; callback && block < target && renderAhead_.load(std::memory_order_acquire); ++block) {
        const uint32_t write = static_cast<uint32_t>(asio_helper::readAtomic(&shared->renderQueueWrite));
        const uint32_t read = static_cast<uint32_t>(asio_helper::readAtomic(&shared->renderQueueRead));
        if (write - read >= target) break;
        callback(0);
        if (write == static_cast<uint32_t>(asio_helper::readAtomic(&shared->renderQueueWrite))) break;
      }
    }

    const int32_t hostEventWrite = asio_helper::readAtomic(&shared->hostEventWriteSequence);
    while (hostEventRead < hostEventWrite) {
      const asio_helper::HostEventRecord record =
          shared->hostEvents[static_cast<uint32_t>(hostEventRead) % asio_helper::kHostEventRingSize];
      ++hostEventRead;
      asio_helper::exchangeAtomic(&shared->hostEventReadSequence, hostEventRead);
      AsioEventCallback callback;
      {
        std::lock_guard lock(stateMutex_);
        callback = eventCallback_;
      }
      if (callback && record.event >= static_cast<int32_t>(AsioHostEvent::DriverReset) &&
          record.event <= static_cast<int32_t>(AsioHostEvent::Xrun)) {
        callback(
            static_cast<AsioHostEvent>(record.event),
            asio_helper::readText(record.message));
      }
    }

    const bool isStarted = started_.load(std::memory_order_acquire);
    const int32_t heartbeat = asio_helper::readAtomic(&shared->callbackHeartbeat);
    if (isStarted && !wasStarted) {
      lastHeartbeat = heartbeat;
      lastCallback = std::chrono::steady_clock::now();
    }
    wasStarted = isStarted;
    if (heartbeat != lastHeartbeat) {
      lastHeartbeat = heartbeat;
      lastCallback = std::chrono::steady_clock::now();
    } else if (isStarted &&
               std::chrono::steady_clock::now() - lastCallback > callbackDeadline()) {
      const std::string detail = "ASIO helper callback heartbeat stopped";
      process_->abort(asio_helper::FailureReason::CallbackStalled, detail);
      dispatchHelperFailure(asio_helper::FailureReason::CallbackStalled, detail);
      break;
    }
    process_->waitForCallbacks(100);
  }
  workerRunning_.store(false, std::memory_order_release);
}

void AsioHelperHost::dispatchHelperFailure(
    asio_helper::FailureReason reason,
    const std::string& detail) {
  bool expected = false;
  if (!helperFailureDispatched_.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) return;
  started_.store(false, std::memory_order_release);
  AsioEventCallback callback;
  {
    std::lock_guard lock(stateMutex_);
    callback = eventCallback_;
  }
  const std::string message = detail.starts_with("asio_helper_")
      ? detail
      : asio_helper::failureMessage(reason, detail);
  if (callback) callback(AsioHostEvent::HelperFailure, message);
}

std::unique_ptr<IAsioHost> createIsolatedAsioHost() {
  return std::make_unique<AsioHelperHost>();
}

}  // namespace twilight::audio
