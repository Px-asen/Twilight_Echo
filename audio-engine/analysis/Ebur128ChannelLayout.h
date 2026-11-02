#pragma once

#include <ebur128.h>

#include <bit>
#include <cstdint>

namespace twilight::audio {

// Native WAVE/FFmpeg speaker order. BS.1770-5 Annex 3 gives horizontal
// +/-60, +/-90 and +/-110 channels gain 1.41; +/-135, 180, height and bottom
// channels have unit gain. Both LFE positions are excluded from loudness.
inline int ebur128NativeSpeakerRole(unsigned speaker, uint64_t layout) {
  switch (speaker) {
    case 0: case 29: case 61: return EBUR128_LEFT;
    case 1: case 30: case 62: return EBUR128_RIGHT;
    case 2: return EBUR128_CENTER;
    case 3: case 35: return EBUR128_UNUSED;
    // In conventional quad/5.x, BL/BR carry the sole surround pair. With
    // corresponding side speakers, they are the separate rear (+/-135) pair.
    case 4: return layout & ((uint64_t{1} << 9) | (uint64_t{1} << 41))
                       ? EBUR128_Mp135 : EBUR128_LEFT_SURROUND;
    case 5: return layout & ((uint64_t{1} << 10) | (uint64_t{1} << 42))
                       ? EBUR128_Mm135 : EBUR128_RIGHT_SURROUND;
    case 6: return EBUR128_MpSC;
    case 7: return EBUR128_MmSC;
    case 8: return EBUR128_Mp180;
    case 9: case 41: return EBUR128_Mp090;
    case 10: case 42: return EBUR128_Mm090;
    case 11: return EBUR128_Tp000;
    case 12: return EBUR128_Up030;
    case 13: return EBUR128_Up000;
    case 14: return EBUR128_Um030;
    case 15: return EBUR128_Up135;
    case 16: return EBUR128_Up180;
    case 17: return EBUR128_Um135;
    case 31: return EBUR128_Mp060;
    case 32: return EBUR128_Mm060;
    case 33: return EBUR128_LEFT_SURROUND;
    case 34: return EBUR128_RIGHT_SURROUND;
    case 36: return EBUR128_Up090;
    case 37: return EBUR128_Um090;
    case 38: return EBUR128_Bp000;
    case 39: return EBUR128_Bp045;
    case 40: return EBUR128_Bm045;
    case 43: return EBUR128_Up110;
    case 44: return EBUR128_Um110;
    // A native bit without a defined position gets unit energy gain, not
    // silence. This selector does not relabel AudioFormat's speaker identity.
    default: return EBUR128_CENTER;
  }
}

inline void applyEbur128ChannelLayout(ebur128_state* state, uint64_t layout) {
  if (layout == 0) return;  // Preserve libebur128's existing count-only table.
  uint64_t remaining = layout;
  for (unsigned channel = 0; channel < state->channels && remaining != 0; ++channel) {
    const unsigned speaker = std::countr_zero(remaining);
    remaining &= remaining - 1;
    ebur128_set_channel(state, channel, ebur128NativeSpeakerRole(speaker, layout));
  }
}

}  // namespace twilight::audio
