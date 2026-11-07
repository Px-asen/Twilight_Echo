#pragma once
#include <atomic>
#include <cstdint>

namespace twilight::audio {
// Device presentation position, correlated with the host's monotonic clock.
// This is deliberately separate from render-callback/queue-consumption counts.
struct OutputClockSnapshot {
  bool supported = false;
  bool valid = false;
  bool running = false;
  uint64_t epoch = 0;
  double positionFrames = 0;
  double sampledAtMs = 0;
  int sampleRate = 0;
};

double outputMonotonicMs();

// One writer (render thread, or control thread after joining it). Readers never
// touch COM objects or wait for the audio callback. Atomic fields also make a
// retried seqlock read legal under the C++ memory model.
class OutputClockCache {
 public:
  void publish(const OutputClockSnapshot& s) {
    sequence_.fetch_add(1, std::memory_order_acq_rel);
    flags_.store((s.supported ? 1 : 0) | (s.valid ? 2 : 0) | (s.running ? 4 : 0), std::memory_order_relaxed);
    epoch_.store(s.epoch, std::memory_order_relaxed);
    position_.store(s.positionFrames, std::memory_order_relaxed);
    time_.store(s.sampledAtMs, std::memory_order_relaxed);
    rate_.store(s.sampleRate, std::memory_order_relaxed);
    sequence_.fetch_add(1, std::memory_order_release);
  }
  OutputClockSnapshot read() const {
    for (int attempt = 0; attempt < 4; ++attempt) {
      const auto before = sequence_.load(std::memory_order_acquire);
      if (before & 1) continue;
      const auto flags = flags_.load(std::memory_order_relaxed);
      OutputClockSnapshot s{bool(flags & 1), bool(flags & 2), bool(flags & 4),
        epoch_.load(std::memory_order_relaxed), position_.load(std::memory_order_relaxed),
        time_.load(std::memory_order_relaxed), rate_.load(std::memory_order_relaxed)};
      std::atomic_thread_fence(std::memory_order_acquire);
      if (before == sequence_.load(std::memory_order_acquire)) return s;
    }
    return {}; // A contended observation is unavailable, never a mixed timestamp.
  }
 private:
  std::atomic<uint64_t> sequence_{0}, epoch_{0};
  std::atomic<unsigned> flags_{0};
  std::atomic<double> position_{0}, time_{0};
  std::atomic<int> rate_{0};
};
} // namespace twilight::audio
