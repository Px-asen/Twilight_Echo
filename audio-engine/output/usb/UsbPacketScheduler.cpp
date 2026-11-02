#include "UsbPacketScheduler.h"

namespace twilight::audio {

bool UsbPacketScheduler::configure(const UsbIsoGeometry& geometry, int rate, size_t frameBytes, std::string* error) {
  const auto fail = [error](const char* message) { if (error) *error = message; return false; };
  if (rate <= 0 || frameBytes == 0 || geometry.interval < 1 || geometry.interval > 16)
    return fail("USB 采样率、帧大小或服务间隔无效");
  const size_t packet = geometry.rawMaxPacketSize & 0x7ff;
  const size_t additional = (geometry.rawMaxPacketSize >> 11) & 3;
  size_t capacity = packet;
  if (geometry.speed == UsbBusSpeed::Full) {
    if (additional != 0 || packet > 1023) return fail("USB Full Speed 等时包大小无效");
  } else if (geometry.speed == UsbBusSpeed::High) {
    if (additional == 3 || packet > 1024) return fail("USB High Speed 等时事务数无效");
    capacity *= 1 + additional;
  } else {
    capacity = geometry.superSpeedBytesPerInterval;
  }
  const uint32_t ticks = geometry.speed == UsbBusSpeed::Full ? 1000 : 8000;
  const uint32_t interval = uint32_t{1} << (geometry.interval - 1);
  const uint64_t numerator = static_cast<uint64_t>(rate) * 65536 * interval;
  const uint64_t denominator = static_cast<uint64_t>(ticks) * 65536;
  if (capacity == 0 || (numerator + denominator - 1) / denominator > capacity / frameBytes)
    return fail("USB 端点带宽不足以承载请求的完整 PCM 帧");
  ticksPerSecond_ = ticks;
  intervalTicks_ = interval;
  maxPacketBytes_ = capacity;
  maxFrames_ = capacity / frameBytes;
  numerator_ = nominalNumerator_ = numerator;
  denominator_ = denominator;
  phase_ = 0;
  return true;
}

bool UsbPacketScheduler::applyFeedback(std::span<const uint8_t> bytes, std::string* error) {
  if (bytes.empty()) return true; // Null feedback packets do not replace the current rate.
  if (bytes.size() != 3 && bytes.size() != 4) {
    if (error) *error = "USB 反馈必须为 3 字节 10.14 或 4 字节 16.16";
    return false;
  }
  uint64_t value = 0;
  for (size_t i = 0; i < bytes.size(); ++i) value |= static_cast<uint64_t>(bytes[i]) << (8 * i);
  const uint64_t numerator = value * (bytes.size() == 3 ? 4 : 1) * ticksPerSecond_ * intervalTicks_;
  if (value == 0 || (numerator + denominator_ - 1) / denominator_ > maxFrames_) {
    if (error) *error = "USB 反馈为零或超过端点的完整帧容量";
    return false;
  }
  numerator_ = numerator;
  return true;
}

size_t UsbPacketScheduler::nextFrames() noexcept {
  phase_ += numerator_;
  const size_t frames = static_cast<size_t>(phase_ / denominator_);
  phase_ %= denominator_;
  return frames;
}

}  // namespace twilight::audio
