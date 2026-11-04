#pragma once
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <optional>

namespace twilight::audio {
// One render-thread writer; status/control readers. Atomic fields make an
// overwritten slot a missed observation, never a C++ seqlock data race.
class BridgePresentationHistory {
 public:
  void reset(size_t frames = 0) {
    size_ = frames; entries_ = frames ? std::make_unique<Entry[]>(frames) : nullptr; end_ = 0;
  }
  void record(uint64_t deviceFrame, double first, double end) {
    auto& entry = entries_[deviceFrame % size_];
    entry.tag.store(deviceFrame * 2 + 1, std::memory_order_seq_cst);
    entry.first.store(first, std::memory_order_seq_cst);
    entry.end.store(end, std::memory_order_seq_cst);
    entry.tag.store(deviceFrame * 2 + 2, std::memory_order_seq_cst);
  }
  void publish(uint64_t end) { end_.store(end, std::memory_order_release); }
  uint64_t committedEnd() const { return end_.load(std::memory_order_acquire); }
  std::optional<double> sourceAt(double devicePosition) const {
    const auto end = committedEnd();
    if (!size_ || !end || !std::isfinite(devicePosition) || devicePosition < 0) return {};
    const uint64_t frame = devicePosition >= static_cast<double>(end) ? end-1 : static_cast<uint64_t>(devicePosition);
    const auto& entry = entries_[frame % size_];
    const auto tag = entry.tag.load(std::memory_order_seq_cst);
    if (tag != frame * 2 + 2) return {};
    const double first = entry.first.load(std::memory_order_seq_cst), last = entry.end.load(std::memory_order_seq_cst);
    if (entry.tag.load(std::memory_order_seq_cst) != tag) return {};
    const double fraction = devicePosition >= static_cast<double>(end) ? 1 : devicePosition - static_cast<double>(frame);
    return first + (last-first)*fraction;
  }
 private:
  struct Entry { std::atomic<uint64_t> tag{0}; std::atomic<double> first{0}, end{0}; };
  size_t size_ = 0;
  std::unique_ptr<Entry[]> entries_;
  std::atomic<uint64_t> end_{0};
};
} // namespace twilight::audio
