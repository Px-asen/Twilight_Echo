#pragma once

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <limits>

namespace twilight::audio {

// Render-owned hysteresis. The control thread only configures/resets while the
// stream is stopped and samples waiting(); no IO, locks or allocation on render.
class StreamBufferGate {
 public:
  void configure(int sampleRate, bool enabled,
                 size_t capacityFrames = std::numeric_limits<size_t>::max()) noexcept {
    enabled_ = enabled;
    capacityFrames_ = std::max<size_t>(1, capacityFrames);
    const size_t second = static_cast<size_t>(std::max(1, sampleRate));
    startupFrames_ = std::min(second, capacityFrames_);
    refillFrames_ = std::min(second * 3, capacityFrames_);
    reset();
  }

  void reset() noexcept {
    targetFrames_ = startupFrames_;
    waiting_.store(enabled_, std::memory_order_release);
  }

  bool allow(size_t available, size_t requested, bool finished) noexcept {
    if (!enabled_) return true;
    const size_t needed = std::min(requested, capacityFrames_);
    // A short song/tail or a failed source must drain, not wait for impossible
    // future frames. The existing EOF/error path still owns its final outcome.
    if (finished) {
      waiting_.store(false, std::memory_order_release);
      return true;
    }
    if (waiting_.load(std::memory_order_relaxed)) {
      if (available < std::max(targetFrames_, needed)) return false;
      waiting_.store(false, std::memory_order_release);
    }
    if (available < needed) {
      targetFrames_ = refillFrames_;
      waiting_.store(true, std::memory_order_release);
      return false;
    }
    return true;
  }

  bool ready(size_t available, bool finished) const noexcept {
    return finished || available >= (enabled_ ? startupFrames_ : 1);
  }
  bool waiting() const noexcept { return waiting_.load(std::memory_order_acquire); }
  size_t prerollFrames(size_t localFrames) const noexcept {
    return enabled_ ? std::max(localFrames, startupFrames_) : localFrames;
  }

 private:
  bool enabled_ = false;
  size_t startupFrames_ = 1, refillFrames_ = 3, targetFrames_ = 1;
  size_t capacityFrames_ = 1;
  std::atomic<bool> waiting_{false};
};

}  // namespace twilight::audio
