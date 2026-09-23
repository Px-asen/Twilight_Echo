#pragma once
#include <algorithm>
#include <array>
#include <cstddef>

namespace twilight::audio {
class AuditionTransition {
 public:
  void process(float* samples, size_t frames, int channels, int sampleRate,
               const void* graph, bool audition) {
    if (!samples || !frames || channels < 1 || channels > 8) return;
    if (graph != graph_) {
      if (initialized_ && (audition || audition_)) {
        from_ = last_;
        total_ = std::max(1, sampleRate / 100);
        remaining_ = total_;
      }
      graph_ = graph;
      audition_ = audition;
    }
    if (remaining_ == 0) {
      for (int channel = 0; channel < channels; ++channel)
        last_[channel] = samples[(frames - 1) * channels + channel];
      initialized_ = true;
      return;
    }
    for (size_t frame = 0; frame < frames; ++frame) {
      const float weight = remaining_ > 0 ? 1.0f - static_cast<float>(remaining_) / total_ : 1.0f;
      for (int channel = 0; channel < channels; ++channel) {
        auto& sample = samples[frame * channels + channel];
        if (remaining_ > 0) sample = from_[channel] * (1.0f - weight) + sample * weight;
        last_[channel] = sample;
      }
      if (remaining_ > 0) --remaining_;
    }
    initialized_ = true;
  }
 private:
  const void* graph_ = nullptr;
  bool audition_ = false;
  bool initialized_ = false;
  int remaining_ = 0;
  int total_ = 1;
  std::array<float, 8> from_{};
  std::array<float, 8> last_{};
};
}
