#pragma once

#include <array>
#include <span>
#include <string>
#include <vector>

namespace twilight::audio {

// A source IN transfer supplies the exact packet frame counts for one OUT
// transfer. Both endpoints must have the same service interval. Audio payload
// is neither decoded nor retained; all queue storage is allocated before start.
class UsbImplicitFeedback {
 public:
  static constexpr size_t kPackets = 8;
  using Frames = std::array<size_t, kPackets>;

  void configure(size_t sourceFrameBytes, size_t outputMaxFrames, size_t capacity) {
    sourceFrameBytes_ = sourceFrameBytes;
    outputMaxFrames_ = outputMaxFrames;
    queue_.resize(capacity);
    reset();
  }
  void reset() noexcept { head_ = count_ = 0; }
  bool push(std::span<const size_t, kPackets> lengths, std::string* error) {
    Frames frames{};
    size_t total = 0;
    for (size_t i = 0; i < kPackets; ++i) {
      if (lengths[i] % sourceFrameBytes_ != 0) {
        if (error) *error = "USB 隐式反馈包不是完整音频帧";
        return false;
      }
      frames[i] = lengths[i] / sourceFrameBytes_;
      if (frames[i] > outputMaxFrames_) {
        if (error) *error = "USB 隐式反馈超过 OUT 端点帧容量";
        return false;
      }
      total += frames[i];
    }
    if (total == 0) return true; // Startup null IN transfers do not produce a zero-byte OUT transfer.
    if (count_ == queue_.size()) {
      if (error) *error = "USB 隐式反馈队列溢出";
      return false;
    }
    queue_[(head_ + count_) % queue_.size()] = frames;
    ++count_;
    return true;
  }
  bool pop(Frames& frames) noexcept {
    if (count_ == 0) return false;
    frames = queue_[head_];
    head_ = (head_ + 1) % queue_.size();
    --count_;
    return true;
  }

 private:
  size_t sourceFrameBytes_ = 1;
  size_t outputMaxFrames_ = 0;
  size_t head_ = 0;
  size_t count_ = 0;
  std::vector<Frames> queue_;
};

}  // namespace twilight::audio
