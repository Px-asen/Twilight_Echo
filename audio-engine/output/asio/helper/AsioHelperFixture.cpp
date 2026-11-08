#include "AsioHelperServer.h"

#include <Windows.h>

#include <array>
#include <atomic>
#include <chrono>
#include <cstring>
#include <iostream>
#include <string>
#include <string_view>
#include <thread>
#include <utility>

namespace twilight::audio::asio_helper {
namespace {

std::string fixtureMode() {
  std::array<char, 128> value{};
  const DWORD length = GetEnvironmentVariableA(
      "TAE_ASIO_HELPER_FIXTURE_MODE", value.data(), static_cast<DWORD>(value.size()));
  return length > 0 && length < value.size() ? std::string(value.data(), length) : "normal";
}

class FixtureHost final : public IAsioHost {
 public:
  explicit FixtureHost(std::string mode) : mode_(std::move(mode)) {}

  ~FixtureHost() override {
    close();
  }

  std::vector<AsioDeviceInfo> enumerateDevices() override {
    return {deviceInfo()};
  }

  AsioHostDiagnostics diagnostics() const override {
    AsioHostDiagnostics result;
    result.processArchitecture = sizeof(void*) == 8 ? "x64" : "x86";
    result.helperArchitecture = result.processArchitecture;
    result.buildEnabled = true;
    result.registeredDriverCount64 = 1;
    result.loadableDriverCount64 = 1;
    return result;
  }

  bool probeDevice(const std::string& deviceId, AsioDeviceInfo* info, std::string* error) override {
    if (deviceId != deviceInfo().id || !info) {
      if (error) *error = "fixture device was not found";
      return false;
    }
    *info = deviceInfo();
    return true;
  }

  bool open(const AsioOpenConfig& config, AsioOpenResult* result, std::string* error) override {
    if (mode_ == "open-restore-failure") {
      closeError_ = "fixture failed to restore format during open";
      if (result) result->failureKind = AsioOpenFailureKind::Format;
      if (error) *error = "fixture rejected the open after changing format";
      return false;
    }
    if (mode_ == "device-reject") {
      if (result) result->failureKind = AsioOpenFailureKind::Driver;
      if (error) *error = "fixture rejected the device";
      return false;
    }
    if (config.deviceId != deviceInfo().id || config.format.channelCount != 2 ||
        config.format.sampleRate <= 0) {
      if (result) result->failureKind = AsioOpenFailureKind::Format;
      if (error) *error = "fixture rejected the open format";
      return false;
    }
    opened_ = true;
    rate_ = config.format.sampleRate;
    if (mode_.starts_with("large-dsd")) {
      if (!config.bufferSizeInPcmFrames) {
        if (error) *error = "fixture requires the PCM preference unit";
        return false;
      }
      frames_ = config.bufferSizeFrames * 256;
    } else frames_ = kFrames;
    closeError_.clear();
    if (result) {
      result->actualFormat = config.format;
      result->bufferSizeFrames = frames_;
      result->latencyFrames = kFrames;
      result->driverName = "Twilight ASIO fixture";
      result->driverVersion = 1;
      result->failureKind = AsioOpenFailureKind::None;
    }
    return true;
  }

  bool createBuffers(
      AsioBufferSwitchCallback bufferSwitch,
      AsioEventCallback eventCallback,
      std::string* error) override {
    if (!opened_) {
      if (error) *error = "fixture session is not open";
      return false;
    }
    bufferSwitch_ = std::move(bufferSwitch);
    eventCallback_ = std::move(eventCallback);
    buffersCreated_ = true;
    outputReadyCalls_.store(0, std::memory_order_release);
    for (auto& channel : buffers_) {
      const size_t bytes = mode_ == "large-dsd-bits" ? frames_ / 8
          : mode_.starts_with("large-dsd") ? frames_ : kFrames * sizeof(double);
      for (auto& buffer : channel) buffer.assign(bytes + 16, 0xcd);
    }
    return true;
  }

  bool start(std::string* error) override {
    if (!buffersCreated_ || started_.exchange(true, std::memory_order_acq_rel)) {
      if (error) *error = "fixture buffers are not ready";
      return false;
    }
    callbackThread_ = std::thread([this] {
      if (mode_ == "callback-backlog") {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        for (int callbackCount = 0; callbackCount < 3; ++callbackCount) {
          if (bufferSwitch_) bufferSwitch_(0);
        }
        return;
      }
      long bufferIndex = 0;
      int callbackCount = 0;
      uint8_t expectedDsdBlock = 1;
      while (started_.load(std::memory_order_acquire)) {
        if (mode_ == "callback-stop" && callbackCount >= 4) return;
        if (mode_ == "delayed-callback" && callbackCount == 0) {
          std::this_thread::sleep_for(std::chrono::milliseconds(250));
        }
        if (bufferSwitch_) bufferSwitch_(bufferIndex);
        if (mode_ == "large-dsd-bits" && eventCallback_ && buffers_[0][bufferIndex][0] != 0x96) {
          bool exact = true;
          for (size_t channel = 0; channel < 2; ++channel) {
            const auto& bytes = buffers_[channel][bufferIndex];
            for (size_t i = 0; i < static_cast<size_t>(frames_ / 8); ++i)
              exact &= bytes[i] == (channel == 0 ? 0x31 : 0x52);
            for (size_t i = frames_ / 8; i < bytes.size(); ++i) exact &= bytes[i] == 0xcd;
          }
          eventCallback_(AsioHostEvent::Xrun, exact ? "large-dsd-verified" : "large-dsd-corrupted");
        }
        if (mode_ == "verify-dsd-queue" && eventCallback_) {
          const uint8_t first = buffers_[0][bufferIndex][0];
          if (first != 0x96) {
            bool exact = first == expectedDsdBlock;
            for (const auto& channel : buffers_) {
              for (size_t byte = 0; byte < kFrames / 8; ++byte)
                exact &= channel[bufferIndex][byte] == expectedDsdBlock;
              for (size_t byte = kFrames / 8; byte < channel[bufferIndex].size(); ++byte)
                exact &= channel[bufferIndex][byte] == 0xcd;
            }
            ++expectedDsdBlock;
            eventCallback_(AsioHostEvent::Xrun, exact ? "dsd-queue-verified" : "dsd-queue-corrupted");
          }
        }
        if (mode_ == "verify-pcm" && eventCallback_) {
          float first = 0;
          std::memcpy(&first, buffers_[0][bufferIndex].data(), sizeof(first));
          if (first != 0) {
            bool exact = true;
            for (size_t channel = 0; channel < 2; ++channel) {
              for (size_t frame = 0; frame < kFrames; ++frame) {
                float sample = 0;
                std::memcpy(&sample, buffers_[channel][bufferIndex].data() + frame * sizeof(float), sizeof(sample));
                exact &= sample == (channel == 0 ? 0.25f : -0.5f);
              }
            }
            eventCallback_(AsioHostEvent::Xrun, exact ? "pcm-verified" : "pcm-corrupted");
          }
        }
        if ((mode_ == "verify-float64" || mode_ == "verify-bounds") && eventCallback_ && callbackCount == 0) {
          bool exact = true;
          const size_t wireBytes = mode_ == "verify-float64" ? 512 : 256;
          for (size_t channel = 0; channel < 2; ++channel) {
            const auto& bytes = buffers_[channel][bufferIndex];
            for (size_t i = wireBytes; i < bytes.size(); ++i) exact &= bytes[i] == 0xcd;
            if (mode_ == "verify-float64") {
              for (size_t i = 0; i < kFrames; ++i) {
                double value = 0; std::memcpy(&value, bytes.data() + i * 8, 8);
                exact &= value == (channel == 0 ? 0.25 : -0.5);
              }
            } else for (size_t i = 0; i < wireBytes; ++i) exact &= bytes[i] == 0;
          }
          eventCallback_(AsioHostEvent::Xrun, exact ? "wire-verified" : "wire-corrupted");
        }
        bufferIndex = 1 - bufferIndex;
        ++callbackCount;
        const double period = mode_ == "large-dsd-bits" ? static_cast<double>(frames_) / rate_
            : mode_ == "large-dsd-bytes" ? static_cast<double>(frames_) * 8 / rate_ : 0.005;
        std::this_thread::sleep_for(std::chrono::duration<double>(period));
      }
    });
    return true;
  }

  void stop() override {
    started_.store(false, std::memory_order_release);
    if (callbackThread_.joinable()) callbackThread_.join();
  }

  void close() override {
    stop();
    const bool hadSession = opened_;
    buffersCreated_ = false;
    opened_ = false;
    bufferSwitch_ = nullptr;
    eventCallback_ = nullptr;
    closeError_ = mode_ == "restore-failure" && hadSession
        ? "fixture failed to restore the retained PCM format"
        : "";
  }

  void* outputBuffer(long channel, long bufferIndex) override {
    if (channel < 0 || channel >= 2 || bufferIndex < 0 || bufferIndex > 1) return nullptr;
    return buffers_[static_cast<size_t>(channel)][static_cast<size_t>(bufferIndex)].data();
  }

  AudioSampleFormat outputSampleFormat(long) const override {
    return AudioSampleFormat::Float32Interleaved;
  }

  AsioChannelFormat outputChannelFormat(long) const override {
    if (mode_ == "verify-dsd-queue" || mode_.starts_with("large-dsd")) {
      AsioChannelFormat format;
      format.logicalFormat = AudioSampleFormat::DsdInt8Msb1;
      format.containerBits = 8;
      format.validBits = 1;
      format.dsdPacking = AsioDsdPacking::Msb1;
      if (mode_ == "large-dsd-ner8") {
        format.logicalFormat = AudioSampleFormat::DsdInt8Ner8;
        format.validBits = 8;
        format.dsdPacking = AsioDsdPacking::Ner8;
      }
      return format;
    }
    if (mode_ == "verify-float64") {
      AsioChannelFormat format;
      format.containerBits = format.validBits = 64;
      return format;
    }
    return {};
  }

  int activeSampleRate() const override { return rate_; }
  long activeLatencyFrames() const override { return 77; }
  std::string startupSummary() const override { return "fixture post-create summary"; }

  bool outputReady() override {
    const int calls = outputReadyCalls_.fetch_add(1, std::memory_order_acq_rel) + 1;
    if (mode_ == "output-ready-false") {
      if (calls > 1 && eventCallback_) {
        eventCallback_(AsioHostEvent::Xrun, "fixture outputReady was called again");
      }
      return false;
    }
    return started_.load(std::memory_order_acquire);
  }

  long activeBufferSize() const override {
    return frames_;
  }

  std::string lastCloseError() const override {
    return closeError_;
  }

 private:
  static constexpr long kFrames = 64;

  AsioDeviceInfo deviceInfo() const {
    AsioDeviceInfo info;
    info.id = mode_ == "routing"
        ? (sizeof(void*) == 8 ? "asio:{fixture}" : "asio:x86:{fixture}") : "asio:fixture";
    info.driverArchitecture = sizeof(void*) == 8 ? "x64" : "x86";
    info.capabilityVersion = 0x1122334455667788ULL;
    info.name = "Twilight ASIO fixture";
    info.driverName = info.name;
    info.driverVersion = 1;
    info.outputChannels = 2;
    info.supportedSampleRates = {44100, 48000, 96000};
    info.bitDepths = {32};
    info.sampleFormats = {AudioSampleFormat::Float32Interleaved};
    info.defaultSampleRate = 48000;
    info.defaultBitDepth = 32;
    info.defaultSampleFormat = AudioSampleFormat::Float32Interleaved;
    info.minBufferSize = kFrames;
    info.maxBufferSize = kFrames;
    info.preferredBufferSize = kFrames;
    info.outputLatencyFrames = kFrames;
    info.capabilityProbed = true;
    return info;
  }

  std::string mode_;
  std::string closeError_;
  AsioBufferSwitchCallback bufferSwitch_;
  AsioEventCallback eventCallback_;
  std::array<std::array<std::vector<uint8_t>, 2>, 2> buffers_{};
  std::thread callbackThread_;
  std::atomic<bool> started_{false};
  std::atomic<int> outputReadyCalls_{0};
  bool opened_ = false;
  bool buffersCreated_ = false;
  int rate_ = 0;
  long frames_ = kFrames;
};

struct Arguments {
  std::wstring mapping;
  std::wstring requestEvent;
  std::wstring responseEvent;
};

bool parseArguments(int argc, wchar_t* argv[], Arguments* result) {
  if (!result || argc != 8 || std::wstring_view(argv[1]) != L"--serve") return false;
  for (int index = 2; index < argc; index += 2) {
    const std::wstring_view key(argv[index]);
    const std::wstring value(argv[index + 1]);
    if (key == L"--shared-memory") result->mapping = value;
    else if (key == L"--request-event") result->requestEvent = value;
    else if (key == L"--response-event") result->responseEvent = value;
    else return false;
  }
  return !result->mapping.empty() && !result->requestEvent.empty() &&
      !result->responseEvent.empty();
}

}  // namespace
}  // namespace twilight::audio::asio_helper

int wmain(int argc, wchar_t* argv[]) {
  using namespace twilight::audio;
  using namespace twilight::audio::asio_helper;
  if (argc == 2 && std::wstring_view(argv[1]) == L"--self-test") {
    std::cout << "{\"kind\":\"twilight-asio-helper-fixture\",\"status\":\"ready\"}";
    return 0;
  }
  Arguments arguments;
  if (!parseArguments(argc, argv, &arguments)) return 64;
  const std::string mode = fixtureMode();
  if (mode == "protocol-mismatch") {
    HANDLE mapping = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, arguments.mapping.c_str());
    if (!mapping) return 2;
    auto* header = static_cast<SharedMemory*>(MapViewOfFile(mapping, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, sizeof(SharedMemory)));
    if (!header) { CloseHandle(mapping); return 2; }
    header->version = kProtocolVersion - 1;
    UnmapViewOfFile(header);
    CloseHandle(mapping);
  }
  AsioHelperServerOptions options;
  options.beforeCommand = [mode](Command command) {
    if (command == Command::GetDiagnostics) {
      if (mode == "control-timeout") Sleep(10000);
      if (mode == "abnormal-exit") TerminateProcess(GetCurrentProcess(), 91);
    }
    if (command == Command::Stop && mode == "stop-timeout") Sleep(10000);
  };
  return runAsioHelperServer(
      arguments.mapping,
      arguments.requestEvent,
      arguments.responseEvent,
      std::make_unique<FixtureHost>(mode),
      std::move(options));
}
