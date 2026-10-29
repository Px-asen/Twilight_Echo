#pragma once
#include "../IOutputBackend.h"
#include <algorithm>
#include <cstring>
namespace twilight::audio {
// AAudio owns the memory. No allocation, conversion, JNI or policy calls here.
inline void renderAndroidPcm(void* data, size_t frames, const AudioFormat& format,
    bool running, bool raw, const TypedRenderCallback& typed, const RenderCallback& floats) {
  const size_t stride = audioFormatBytesPerFrame(format);
  if (!data || stride == 0) return;
  size_t rendered = 0;
  if (running) {
    if (raw && typed) {
      PcmBlock block{format, static_cast<uint8_t*>(data), frames, frames * stride};
      rendered = std::min(frames, typed(block));
    } else if (!raw && format.sampleFormat == AudioSampleFormat::Float32Interleaved && floats) {
      rendered = std::min(frames, floats(static_cast<float*>(data), frames));
    }
  }
  std::memset(static_cast<uint8_t*>(data) + rendered * stride, 0, (frames - rendered) * stride);
}
}
