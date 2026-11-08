#pragma once

#include <cstdint>

namespace twilight::audio::asio {

inline constexpr int32_t kMaximumPcmBufferFrames = 32768;
inline constexpr int32_t kMaximumChannelBufferBytes = kMaximumPcmBufferFrames * 8;
// DSD bit counts and packed source frames are different units. A full packed
// buffer still fits the existing per-channel transport allocation.
inline constexpr int32_t kMaximumDsdBufferSamples = kMaximumChannelBufferBytes * 8;

}  // namespace twilight::audio::asio
