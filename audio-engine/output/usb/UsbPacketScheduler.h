#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <string>

namespace twilight::audio {

enum class UsbBusSpeed { Full, High, Super };

struct UsbIsoGeometry {
  UsbBusSpeed speed = UsbBusSpeed::Full;
  uint16_t rawMaxPacketSize = 0;
  uint8_t interval = 0;
  uint16_t superSpeedBytesPerInterval = 0;
};

// Single USB event-thread owner. Exact nominal rational pacing and explicit
// 10.14 / 16.16 feedback share one phase denominator, including feedback changes.
class UsbPacketScheduler {
 public:
  bool configure(const UsbIsoGeometry& geometry, int rate, size_t frameBytes, std::string* error);
  bool applyFeedback(std::span<const uint8_t> bytes, std::string* error);
  void reset() noexcept { numerator_ = nominalNumerator_; phase_ = 0; }
  size_t nextFrames() noexcept;
  size_t maxPacketBytes() const noexcept { return maxPacketBytes_; }
  size_t maxFrames() const noexcept { return maxFrames_; }
  uint32_t intervalTicks() const noexcept { return intervalTicks_; }
  uint32_t ticksPerSecond() const noexcept { return ticksPerSecond_; }
  double intervalSeconds() const noexcept { return static_cast<double>(intervalTicks_) / ticksPerSecond_; }

 private:
  uint64_t numerator_ = 0;
  uint64_t nominalNumerator_ = 0;
  uint64_t denominator_ = 1;
  uint64_t phase_ = 0;
  uint32_t ticksPerSecond_ = 1000;
  uint32_t intervalTicks_ = 1;
  size_t maxPacketBytes_ = 0;
  size_t maxFrames_ = 0;
};

}  // namespace twilight::audio
