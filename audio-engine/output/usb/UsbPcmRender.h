#pragma once

#include "../IOutputBackend.h"
#include <algorithm>
#include <bit>
#include <cmath>
#include <cstring>
#include <span>

namespace twilight::audio {

inline void packUsbPcm(std::span<const float> input, AudioSampleFormat format, uint8_t* output) {
  const size_t width = audioSampleFormatBytes(format);
  const int bits = format == AudioSampleFormat::Int16Interleaved ? 16 :
      (format == AudioSampleFormat::Int24Interleaved || format == AudioSampleFormat::Int24In32Interleaved ? 24 : 32);
  for (size_t sample = 0; sample < input.size(); ++sample) {
    uint32_t value;
    if (format == AudioSampleFormat::Float32Interleaved) {
      value = std::bit_cast<uint32_t>(input[sample]);
    } else {
      const int64_t scale = int64_t{1} << (bits - 1);
      const double finite = std::isfinite(input[sample]) ? std::clamp<double>(input[sample], -1.0, 1.0) : 0.0;
      const int64_t quantized = std::clamp<int64_t>(std::llround(finite * scale), -scale, scale - 1);
      value = static_cast<uint32_t>(quantized);
      if (format == AudioSampleFormat::Int24In32Interleaved) value <<= 8;
    }
    for (size_t byte = 0; byte < width; ++byte) output[sample * width + byte] = static_cast<uint8_t>(value >> (8 * byte));
  }
}

// Scratch belongs to a preallocated transfer slot. The typed path never enters
// Float32; ordinary processing uses the existing float callback and packs once.
inline size_t renderUsbPcm(uint8_t* output, size_t frames, const AudioFormat& format,
    const TypedRenderCallback& typed, const RenderCallback& floats, std::span<float> scratch) {
  const size_t stride = audioFormatBytesPerFrame(format);
  size_t rendered = 0;
  if (typed) {
    PcmBlock block{format, output, frames, frames * stride};
    rendered = std::min(frames, typed(block));
  }
  if (rendered == 0 && floats) {
    rendered = std::min(frames, floats(scratch.data(), frames));
    packUsbPcm(scratch.first(rendered * format.channelCount), format.sampleFormat, output);
  }
  std::memset(output + rendered * stride, 0, (frames - rendered) * stride);
  return rendered;
}

}  // namespace twilight::audio
