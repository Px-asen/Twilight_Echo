#pragma once

#include "IAsioHost.h"
#include "helper/AsioHelperProcess.h"
#include "windows/AsioDriverCatalog.h"

#include <array>
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace twilight::audio {

class AsioHelperHost final : public IAsioHost {
 public:
  using CatalogProvider = std::function<std::vector<asio_windows::AsioDriverEntry>()>;
  AsioHelperHost();
  AsioHelperHost(std::wstring x64Path, std::wstring x86Path, CatalogProvider catalog);
  explicit AsioHelperHost(std::wstring helperPath);
  ~AsioHelperHost() override;

  std::vector<AsioDeviceInfo> enumerateDevices() override;
  AsioHostDiagnostics diagnostics() const override;
  bool probeDevice(const std::string& deviceId, AsioDeviceInfo* info, std::string* error) override;
  bool open(const AsioOpenConfig& config, AsioOpenResult* result, std::string* error) override;
  bool createBuffers(
      AsioBufferSwitchCallback bufferSwitch,
      AsioEventCallback eventCallback,
      std::string* error) override;
  bool start(std::string* error) override;
  void stop() override;
  void close() override;
  void* outputBuffer(long channel, long bufferIndex) override;
  AudioSampleFormat outputSampleFormat(long channel) const override;
  AsioChannelFormat outputChannelFormat(long channel) const override;
  bool outputReady() override;
  long activeBufferSize() const override;
  int activeSampleRate() const override;
  long activeLatencyFrames() const override;
  std::string startupSummary() const override;
  size_t activeRenderFrameCapacity() const override;
  bool dsdBufferUnitConfirmed() const override;
  AsioRenderHealth renderHealth() const override;
  bool hasDriverBoundaryHealth() const override { return true; }
  void commitOutputBuffer(long bufferIndex, size_t frameCount) override;
  std::string lastCloseError() const override;

 private:
  bool selectDevice(const std::string& deviceId, std::string* resolvedId, std::string* error);
  bool ensureProcess(std::string* error) const;
  void startWorker();
  void stopWorker();
  void workerLoop();
  void dispatchHelperFailure(asio_helper::FailureReason reason, const std::string& detail);
  std::chrono::milliseconds callbackDeadline() const;

  mutable std::unique_ptr<asio_helper::AsioHelperProcess> process_;
  CatalogProvider catalog_;
  std::wstring x64Path_;
  std::wstring x86Path_;
  AsioArchitecture architecture_ = AsioArchitecture::X64;
  mutable std::mutex stateMutex_;
  AsioBufferSwitchCallback bufferSwitch_;
  AsioEventCallback eventCallback_;
  std::vector<AsioChannelFormat> channelFormats_;
  std::array<AsioChannelFormat, asio_helper::kMaxChannels> renderChannelFormats_{};
  std::atomic<uint32_t> renderChannelCount_{0};
  AudioFormat openFormat_;
  long activeBufferSize_ = 0;
  int activeSampleRate_ = 0;
  long activeLatencyFrames_ = -1;
  std::string startupSummary_;
  mutable std::string closeError_;
  std::thread worker_;
  std::atomic<bool> workerRunning_{false};
  std::atomic<bool> started_{false};
  std::atomic<bool> renderAhead_{false};
  std::atomic<bool> helperFailureDispatched_{false};
};

}  // namespace twilight::audio
