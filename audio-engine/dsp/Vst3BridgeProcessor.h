#pragma once

#include "IAudioProcessor.h"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <string>

namespace twilight::audio {

struct Vst3BridgeConfig {
  std::string nodeId;
  std::string modulePath;
  std::string classId;
  std::string parametersJson;
  std::string statePath;
  std::string stateFormat;
};

class Vst3BridgeProcessor final : public IAudioProcessor {
 public:
  explicit Vst3BridgeProcessor(Vst3BridgeConfig config);
  ~Vst3BridgeProcessor() override;

  Vst3BridgeProcessor(const Vst3BridgeProcessor&) = delete;
  Vst3BridgeProcessor& operator=(const Vst3BridgeProcessor&) = delete;

  void configure(const DspConfig& config) override;
  void prepare(const AudioFormat& format) override;
  void setTrackContext(const DspTrackContext& context) override;
  void process(float* samples, size_t frameCount) override;
  void reset() override;
  bool isActive() const override;

  const std::string& lastError() const noexcept { return lastError_; }
  std::string bypassReason() const;
  uint32_t latencyFrames() const noexcept;
  uint32_t tailFrames() const noexcept;
  uint64_t processCalls() const noexcept { return processCalls_.load(std::memory_order_relaxed); }
  uint64_t overrunCount() const noexcept { return overrunCount_.load(std::memory_order_relaxed); }
  double lastProcessMs() const noexcept { return 0.0; }
  double maxProcessMs() const noexcept { return 0.0; }
  static size_t liveInstanceCountForTests() noexcept;

 private:
  bool launchHost();
  void destroyHost();
  void processBlock(float* samples, uint32_t frameCount) noexcept;
  void storeDelayedFrames(uint64_t firstFrame, const float* samples, uint32_t frameCount) noexcept;
  void readDelayedFrames(uint64_t firstFrame, float* samples, uint32_t frameCount) noexcept;
  void setFailure(const std::string& message);

  Vst3BridgeConfig bridgeConfig_;
  DspConfig dspConfig_;
  AudioFormat format_;
  DspTrackContext trackContext_;
  std::string lastError_;
  void* mappingHandle_ = nullptr;
  void* inputEventHandle_ = nullptr;
  void* hostProcessHandle_ = nullptr;
  void* sharedMemory_ = nullptr;
  std::atomic<bool> active_{false};
  std::atomic<uint64_t> processCalls_{0};
  std::atomic<uint64_t> overrunCount_{0};
  static std::atomic<size_t> liveInstanceCount_;
  uint32_t nextSequence_ = 0;
  uint64_t inputFramePosition_ = 0;
  static constexpr uint32_t kSlotCount = 4;
  static constexpr uint32_t kMaxFrames = 4096;
  static constexpr uint32_t kMaxChannels = 8;
  static constexpr uint32_t kDelayFrames = kMaxFrames;
  static constexpr uint32_t kBufferedFrames = kDelayFrames + kMaxFrames;
  std::array<float, static_cast<size_t>(kBufferedFrames) * kMaxChannels> delayedSamples_{};
  std::array<uint64_t, kSlotCount> slotFramePositions_{};
};

}  // namespace twilight::audio
