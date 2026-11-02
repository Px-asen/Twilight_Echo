#pragma once

#include "../../core/AudioTypes.h"
#include <bit>

namespace twilight::audio {

// AAudio and WAVE share speaker bits/order through TOP_BACK_RIGHT. Higher
// Android positions use another numbering/order and are not represented here.
inline uint32_t androidOutputChannelMask(const AudioFormat& format) {
  if (format.channelCount == 1 && format.channelMask == 0x4) return 0x1; // Android MONO
  return (format.channelMask & ~uint64_t{0x3ffff}) == 0 &&
      std::popcount(format.channelMask) == format.channelCount
      ? static_cast<uint32_t>(format.channelMask) : 0;
}

inline uint64_t nativeOutputChannelMask(uint32_t mask, int channels) {
  if (channels == 1 && mask == 0x1) return 0x4;
  return (mask & ~uint32_t{0x3ffff}) == 0 && std::popcount(mask) == channels ? mask : 0;
}

}  // namespace twilight::audio
