#pragma once

#include "../IOutputBackend.h"
#include <algorithm>
#include <cstring>
#include <span>

namespace twilight::audio {

// DoP is typed-only. A short/empty callback still sends DSD idle with a marker
// phase owned by this USB session, including across transfer/packet boundaries.
inline size_t renderUsbDop(uint8_t* output, size_t frames, const AudioFormat& format,
    const TypedRenderCallback& typed, uint64_t& markerIndex) {
  const size_t width = audioSampleFormatBytes(format.sampleFormat);
  const size_t channels = static_cast<size_t>(format.channelCount);
  const size_t stride = width * channels;
  size_t rendered = 0;
  if (typed) {
    PcmBlock block{format, output, frames, frames * stride};
    rendered = std::min(frames, typed(block));
  }
  for (size_t frame = 0; frame < frames; ++frame) {
    const uint8_t marker = ((markerIndex + frame) & 1) ? 0xfa : 0x05;
    for (size_t channel = 0; channel < channels; ++channel) {
      auto* sample = output + frame * stride + channel * width;
      if (frame >= rendered) {
        if (width == 4) sample[0] = 0;
        sample[width - 3] = sample[width - 2] = 0x96;
      }
      sample[width - 1] = marker;
    }
  }
  markerIndex += frames;
  return rendered;
}

// The engine renders MSB-first, byte-interleaved DSD. USB U32 words group four
// consecutive bytes per channel; word endianness does not change bit order.
inline size_t renderUsbNativeDsd(uint8_t* output, size_t wordFrames, const AudioFormat& format,
    bool littleEndianWords, const TypedRenderCallback& typed, std::span<uint8_t> scratch) {
  const size_t channels = static_cast<size_t>(format.channelCount);
  const size_t byteFrames = wordFrames * 4;
  const size_t bytes = byteFrames * channels;
  size_t rendered = 0;
  if (typed) {
    PcmBlock block{format, scratch.data(), byteFrames, bytes};
    rendered = std::min(byteFrames, typed(block));
  }
  std::memset(scratch.data() + rendered * channels, 0x96, bytes - rendered * channels);
  for (size_t frame = 0; frame < wordFrames; ++frame) {
    for (size_t channel = 0; channel < channels; ++channel) {
      for (size_t byte = 0; byte < 4; ++byte) {
        const size_t time = littleEndianWords ? 3 - byte : byte;
        output[(frame * channels + channel) * 4 + byte] = scratch[(frame * 4 + time) * channels + channel];
      }
    }
  }
  return rendered;
}

}  // namespace twilight::audio
