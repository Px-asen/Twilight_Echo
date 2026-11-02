#pragma once

#include "IAudioProcessor.h"

#include <array>
#include <vector>

namespace twilight::audio {

class CrossfeedProcessor final : public IAudioProcessor {
 public:
  void configure(const DspConfig& config) override;
  void prepare(const AudioFormat& format) override;
  void setTrackContext(const DspTrackContext& context) override;
  void process(float* samples, size_t frameCount) override;
  void processDouble(double* samples, size_t frameCount) override;
  void reset() override;
  bool isActive() const override;

  double strength() const;

 private:
  void rebuildFilters();
  template <typename Sample> void processSamples(Sample* samples, size_t frameCount);

  DspConfig config_;
  AudioFormat format_;
  std::vector<float> delayLeft_;
  std::vector<float> delayRight_;
  size_t delayIndex_ = 0;
  double lowpassLeft_ = 0.0;
  double lowpassRight_ = 0.0;
  double alpha_ = 0.0;
  double lowA0_ = 0.0, lowB1_ = 0.0;
  double highA0_ = 0.0, highA1_ = 0.0, highB1_ = 0.0;
  double namedGain_ = 1.0;
  std::array<double, 2> namedInput_{}, namedLow_{}, namedHigh_{};
  bool active_ = false;
};

}  // namespace twilight::audio
