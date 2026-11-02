#pragma once

#include "DspTypes.h"

#include <cstddef>
#include <vector>

namespace twilight::audio {

class IAudioProcessor {
 public:
  virtual ~IAudioProcessor() = default;

  virtual void configure(const DspConfig& config) = 0;
  virtual void prepare(const AudioFormat& format) = 0;
  virtual void setTrackContext(const DspTrackContext& context) = 0;
  virtual void process(float* samples, size_t frameCount) = 0;

  /**
   * 64-bit Float (double) internal DSP pipeline entry point.
   * Native double implementations avoid intermediate Float32 quantization.
   * Float-only processors use processFloatBridge with their prepared channel
   * count; they retain their existing Float32 processing precision.
   */
  virtual void processDouble(double* samples, size_t frameCount) = 0;

  virtual void reset() = 0;
  virtual bool isActive() const = 0;

 protected:
  // Float-only implementations supply their prepared format. Buffer extent
  // is the actual interleaved sample count, not the supported channel limit.
  void processFloatBridge(double* samples, size_t frameCount, int channelCount) {
    if (!samples || frameCount == 0 || !isActive()) return;
    const size_t totalSamples = frameCount * static_cast<size_t>(channelCount);
    std::vector<float> temp(totalSamples);
    for (size_t i = 0; i < totalSamples; ++i) {
      temp[i] = static_cast<float>(samples[i]);
    }
    process(temp.data(), frameCount);
    for (size_t i = 0; i < totalSamples; ++i) {
      samples[i] = static_cast<double>(temp[i]);
    }
  }
};

}  // namespace twilight::audio
