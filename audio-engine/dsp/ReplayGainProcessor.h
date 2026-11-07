#pragma once

#include "IAudioProcessor.h"

namespace twilight::audio {

class ReplayGainProcessor final : public IAudioProcessor {
 public:
  void configure(const DspConfig& config) override;
  void prepare(const AudioFormat& format) override;
  void setTrackContext(const DspTrackContext& context) override;
  void process(float* samples, size_t frameCount) override;
  void processDouble(double* samples, size_t frameCount) override;
  void reset() override;
  bool isActive() const override;
  double currentGainDb() const;
  void adoptPreparedGain(const ReplayGainProcessor& next) noexcept {
    gainDb_ = next.gainDb_; gainLinear_ = next.gainLinear_; active_ = next.active_;
  }

 private:
  void updateGain(const ReplayGainInfo& info);

  DspConfig config_;
  AudioFormat format_;
  double gainDb_ = 0.0;
  double gainLinear_ = 1.0;
  bool active_ = false;
};

}  // namespace twilight::audio
