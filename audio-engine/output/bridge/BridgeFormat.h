#pragma once
#include "../IOutputBackend.h"
#include <bit>

namespace twilight::audio {
// Stable wire codes. Native DSD frame = one byte/channel; rate remains DSD bits/s.
enum class BridgeWireFormat : int { Float32 = 1, Dop24 = 2, DsdLsb = 3, DsdMsb = 4, DsdNer8 = 5 };
inline const char* bridgeWireName(BridgeWireFormat f) {
  switch (f) {
    case BridgeWireFormat::Float32: return "float32-le";
    case BridgeWireFormat::Dop24: return "dop-int24-le";
    case BridgeWireFormat::DsdLsb: return "dsd-int8-lsb1";
    case BridgeWireFormat::DsdMsb: return "dsd-int8-msb1";
    case BridgeWireFormat::DsdNer8: return "dsd-int8-ner8";
  }
  return "invalid";
}
inline size_t bridgeSampleBytes(BridgeWireFormat f) { return f == BridgeWireFormat::Float32 ? 4 : f == BridgeWireFormat::Dop24 ? 3 : 1; }
inline int bridgeFrameRate(int rate, BridgeWireFormat f) { return static_cast<int>(f) >= 3 ? rate / 8 : rate; }
inline bool validBridgeFormat(int rate, int channels, BridgeWireFormat f, uint64_t mask) {
  if (channels < 1 || channels > 8 || (mask && (mask > 0x3ffff || std::popcount(mask) != channels))) return false;
  if (channels > 2 && !mask) return false;
  if (f == BridgeWireFormat::Float32) {
    if (rate >= 44100 && rate <= 192000) return true; // Legacy negotiated PCM rates.
    for (int r : {44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000}) if (r == rate) return true;
  } else if (f == BridgeWireFormat::Dop24) {
    for (int r : {176400, 192000, 352800, 384000, 705600, 768000, 1411200, 1536000}) if (r == rate) return true;
  } else if (static_cast<int>(f) >= 3 && static_cast<int>(f) <= 5) {
    for (int r : {2822400, 3072000, 5644800, 6144000, 11289600, 12288000, 22579200, 24576000}) if (r == rate) return true;
  }
  return false;
}
inline AudioFormat bridgeAudioFormat(int rate, int channels, BridgeWireFormat f, uint64_t mask) {
  return {rate, channels, f == BridgeWireFormat::Float32 ? 32 : f == BridgeWireFormat::Dop24 ? 24 : 1,
    f == BridgeWireFormat::Float32 ? AudioSampleFormat::Float32Interleaved :
    f == BridgeWireFormat::Dop24 ? AudioSampleFormat::Int24Interleaved :
    f == BridgeWireFormat::DsdLsb ? AudioSampleFormat::DsdInt8Lsb1 :
    f == BridgeWireFormat::DsdMsb ? AudioSampleFormat::DsdInt8Msb1 : AudioSampleFormat::DsdInt8Ner8,
    f == BridgeWireFormat::Dop24, mask};
}
} // namespace twilight::audio
