#include "dsp/WsolaResampler.h"
#include "PerformanceTestPriority.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <vector>

// Component deadline gate; physical-device underruns still require the audio soak.
int main() {
  ScopedPerformanceTestThreadPriority performanceTestThreadPriority;
  using Clock = std::chrono::steady_clock;
  bool failed = false;
  for (int sr : {48000, 96000, 192000}) {
    for (int channels : {2, 8}) {
      std::vector<float> source(static_cast<size_t>(sr * channels));
      for (int i = 0; i < sr; ++i) {
        const double phase = 6.283185307179586 * i / sr;
        for (int c = 0; c < channels; ++c) {
          source[static_cast<size_t>(i * channels + c)] = static_cast<float>(
              0.4 * std::sin(phase * (440 + c * 13)) + 0.2 * std::sin(phase * (719 + c * 17)));
        }
      }
      for (int block : {256, 1024}) {
        for (double rate : {0.5, 0.75, 1.0, 1.5, 2.0}) {
          twilight::audio::WsolaResampler processor;
          processor.prepare(channels, sr, static_cast<size_t>(block));
          processor.setRate(rate);
          std::vector<float> output(static_cast<size_t>(block * channels));
          std::vector<double> samples(1024);
          size_t cursor = 0;
          const auto pull = [&](float* dst, size_t count) {
            for (size_t i = 0; i < count; ++i) {
              std::copy_n(source.data() + cursor * channels, channels, dst + i * channels);
              cursor = (cursor + 1) % static_cast<size_t>(sr);
            }
            return count;
          };
          for (int i = 0; i < 16; ++i) processor.process(output.data(), block, pull);
          const double deadline = block * 1000.0 / sr;
          size_t misses = 0;
          for (double& sample : samples) {
            const auto start = Clock::now();
            const size_t produced = processor.process(output.data(), block, pull);
            sample = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
            if (produced != static_cast<size_t>(block)) return 2;
            if (sample > deadline) ++misses;
          }
          std::sort(samples.begin(), samples.end());
          const double p999 = samples[static_cast<size_t>(std::ceil(samples.size() * 0.999)) - 1];
          std::printf("{\"sampleRate\":%d,\"channels\":%d,\"block\":%d,\"rate\":%.2f,"
                      "\"deadlineMs\":%.6f,\"p999Ms\":%.6f,\"peakMs\":%.6f,\"deadlineMisses\":%zu}\n",
                      sr, channels, block, rate, deadline, p999, samples.back(), misses);
          // A rare scheduler preemption is reported; sustained near-deadline
          // processor work fails the gate and leaves no headroom for other DSP.
          if (p999 > deadline * 0.8 || misses > 1) failed = true;
        }
      }
    }
  }
  return failed ? 1 : 0;
}
