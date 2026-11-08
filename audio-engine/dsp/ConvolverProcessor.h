#pragma once

#include "IAudioProcessor.h"
#include "ConvolverRealtimeBudget.h"

#include <array>
#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace twilight::audio {

class ConvolverProcessor final : public IAudioProcessor {
 public:
  ConvolverProcessor();
  ~ConvolverProcessor() override;

  void configure(const DspConfig& config) override;
  void prepare(const AudioFormat& format) override;
  void setTrackContext(const DspTrackContext& context) override;
  void process(float* samples, size_t frameCount) override;
  void processDouble(double* samples, size_t frameCount) override {
    processFloatBridge(samples, frameCount, format_.channelCount);
  }
  void reset() override;
  bool isActive() const override;

  bool loadImpulseResponse(const std::string& path, std::string* error);
  void unloadImpulseResponse();
  ConvolverInfo info() const;

  // Shares realtime telemetry with the render clone of this node. AudioPipeline hands the
  // control instance's state to every graph it builds for the same configuration, so a
  // bypass raised on the audio thread becomes visible to info() and to the UI.
  void setRealtimeState(std::shared_ptr<ConvolverRealtimeState> state);
  const std::shared_ptr<ConvolverRealtimeState>& realtimeState() const { return realtimeState_; }

 private:
  struct IrData {
    int sampleRate = 0;
    int channels = 0;
    uint64_t frames = 0;
    std::vector<std::vector<float>> samples;
  };

  struct FftChannel;

  static bool readImpulse(const std::string& path, IrData* out, std::string* error);
  static bool readWaveImpulse(const std::string& path, IrData* out, std::string* error);
  static bool readFfmpegImpulse(const std::string& path, IrData* out, std::string* error);
  static IrData resampleIr(const IrData& source, int targetSampleRate);

  void rebuild();
  bool prepareRuntimeIr(std::string* error);
  void bypassRealtime();
  // Returns true when a previously bypassed convolver may try again.
  bool shouldRearmAfterBypass();
  uint32_t choosePartitionSize(const IrData& ir) const;
  const std::vector<float>& impulseForOutputChannel(const IrData& ir, int outputChannel) const;
  void updateInfoFromRuntime(const IrData& ir, bool resampled);

  DspConfig config_;
  AudioFormat format_;
  std::shared_ptr<const IrData> originalIr_;
  std::string irIdentity_;
  std::shared_ptr<const IrData> runtimeIr_;
  std::vector<std::unique_ptr<FftChannel>> channels_;
  std::array<float, 8> routedInput_{};
  std::array<float, 8> wetOutput_{};
  std::vector<float> wetDelayBuffer_;
  double wetGain_ = 1.0;
  size_t wetDelayFrames_ = 0;
  size_t wetDelayWriteFrame_ = 0;
  ConvolverInfo info_;
  convolver::RealtimeBudget realtimeBudget_;
  // Successive bypasses back off exponentially so a genuinely too-heavy IR settles into
  // "off" instead of thrashing, while a one-off scheduling hiccup recovers quickly.
  uint32_t bypassGeneration_ = 0;
  std::chrono::steady_clock::time_point lastBypassAt_{};
  bool active_ = false;
  bool realtimeBypassed_ = false;
  std::shared_ptr<ConvolverRealtimeState> realtimeState_ = std::make_shared<ConvolverRealtimeState>();
};

}  // namespace twilight::audio
