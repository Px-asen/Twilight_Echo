#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>

namespace twilight::audio {

// 49-tap Hann-windowed sinc, as used by libebur128 1.2.6: 4x below
// 96 kHz, 2x above it. Unlike the library, retain reconstruction at >=192 kHz.
// h[j] = sinc((j - 24) / factor) * (1 - cos(2*pi*j/48)) / 2.
// The integer phase is a delayed input sample, already in the sample peak.
class TruePeakDetector {
 public:
  void prepare(int sampleRate) {
    historyFrames_ = sampleRate < 96000 ? 12 : 24;
    reset();
  }

  // A limiter must retain the oldest sample until all FIR phases involving it
  // can be evaluated, not just until the filter's group delay.
  size_t requiredLookaheadFrames() const { return historyFrames_ - 1; }

  double add(float input) {
    const float sample = std::isfinite(input) ? input : 0.0f;
    history_[write_] = history_[write_ + historyFrames_] = sample;
    if (++write_ == historyFrames_) write_ = 0;
    const float* window = history_.data() + write_;
    double peak = std::abs(static_cast<double>(sample));
    if (historyFrames_ == 12) {
      for (const auto& phase : kFractionalPhases4x) {
        double interpolated = 0.0;
        for (size_t tap = 0; tap < phase.size(); ++tap) {
          interpolated += phase[tap] * window[11 - tap];
        }
        peak = std::max(peak, std::abs(interpolated));
      }
    } else {
      double interpolated = 0.0;
      for (size_t tap = 0; tap < kFractionalPhase2x.size(); ++tap) {
        interpolated += kFractionalPhase2x[tap] * window[23 - tap];
      }
      peak = std::max(peak, std::abs(interpolated));
    }
    return peak;
  }

  void reset() {
    history_.fill(0.0f);
    write_ = 0;
  }

 private:
  static constexpr std::array<std::array<double, 12>, 3> kFractionalPhases4x{{
      {{-0.00016744197591618296, 0.004895983142504382, -0.018526005935860405,
        0.046265053486303574, -0.10345672595291239, 0.28868335557343622,
        0.89646515071103405, -0.16145852728990459, 0.069158469679911128,
        -0.030107748292905214, 0.010359954969807055, -0.0016317261636570237}},
      {{-0.00098601330506667092, 0.010358978571612684, -0.033703603627858555,
        0.080138909394514291, -0.18112965507435574, 0.62577362601184794,
        0.62577362601184794, -0.18112965507435577, 0.080138909394514291,
        -0.033703603627858576, 0.010358978571612691, -0.00098601330506667721}},
      {{-0.0016317261636570261, 0.010359954969807034, -0.0301077482929052,
        0.069158469679911128, -0.16145852728990456, 0.89646515071103405,
        0.28868335557343622, -0.1034567259529124, 0.046265053486303574,
        -0.018526005935860422, 0.0048959831425043872, -0.00016744197591618296}},
  }};
  static constexpr std::array<double, 24> kFractionalPhase2x{{
      -0.00011839935662560734, 0.0011538046353613931, -0.0034619828806398663,
      0.0073255944119378254, -0.013099864425549106, 0.021289392984170954,
      -0.03271433305212354, 0.048902422887149417, -0.073154952480662616,
      0.11416841952708477, -0.20412995834166403, 0.63389658716519248,
      0.63389658716519248, -0.20412995834166406, 0.11416841952708479,
      -0.07315495248066263, 0.048902422887149417, -0.03271433305212354,
      0.021289392984170964, -0.013099864425549121, 0.0073255944119378393,
      -0.0034619828806398702, 0.0011538046353613916, -0.00011839935662560734,
  }};
  // Mirroring makes each convolution contiguous without render-thread copies.
  std::array<float, 24 * 2> history_{};
  size_t historyFrames_ = 12;
  size_t write_ = 0;
};

}  // namespace twilight::audio
