#pragma once

#include "../decoder/SeekableInput.h"

#include <algorithm>
#include <bit>
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>

namespace twilight::audio::layout_fixture {

inline constexpr int sampleRate = 48000;

inline int16_t sample(size_t frame, int channel, int variant = 0) {
  return static_cast<int16_t>(static_cast<int>((frame * (17 + channel * 13) + channel * 431 + variant * 71) % 2048) - 1024);
}

inline std::vector<float> samples(uint32_t mask, size_t frames, int variant = 0) {
  const int channels = std::popcount(mask);
  std::vector<float> result(frames * channels);
  for (size_t frame = 0; frame < frames; ++frame)
    for (int channel = 0; channel < channels; ++channel)
      result[frame * channels + channel] = static_cast<float>(sample(frame, channel, variant)) / 32768.0f;
  return result;
}

// WAVEFORMATEXTENSIBLE PCM16 with an explicit speaker mask. Entirely in memory.
inline std::vector<uint8_t> wave(uint32_t mask, size_t frames, int variant = 0) {
  const int channels = std::popcount(mask);
  std::vector<uint8_t> result;
  const auto word = [&](uint32_t value, int width) {
    for (int i = 0; i < width; ++i) result.push_back(static_cast<uint8_t>(value >> (8 * i)));
  };
  const auto tag = [&](const char* value) { result.insert(result.end(), value, value + 4); };
  const uint32_t bytes = static_cast<uint32_t>(frames * channels * 2);
  tag("RIFF"); word(60 + bytes, 4); tag("WAVE");
  tag("fmt "); word(40, 4); word(0xfffe, 2); word(channels, 2);
  word(sampleRate, 4); word(sampleRate * channels * 2, 4); word(channels * 2, 2);
  word(16, 2); word(22, 2); word(16, 2); word(mask, 4);
  // KSDATAFORMAT_SUBTYPE_PCM = {00000001-0000-0010-8000-00aa00389b71}.
  word(1, 4); word(0, 2); word(0x10, 2); word(0xaa000080, 4); word(0x719b3800, 4);
  tag("data"); word(bytes, 4);
  for (size_t frame = 0; frame < frames; ++frame)
    for (int channel = 0; channel < channels; ++channel)
      word(static_cast<uint16_t>(sample(frame, channel, variant)), 2);
  return result;
}

class MemoryInput final : public SeekableInput {
 public:
  explicit MemoryInput(std::shared_ptr<const std::vector<uint8_t>> bytes) : bytes_(std::move(bytes)) {}
  int64_t size() override { return static_cast<int64_t>(bytes_->size()); }
  int readAt(int64_t offset, uint8_t* output, int count) override {
    if (offset < 0 || count < 0) return -1;
    if (static_cast<size_t>(offset) >= bytes_->size()) return 0;
    const size_t length = std::min<size_t>(count, bytes_->size() - static_cast<size_t>(offset));
    std::memcpy(output, bytes_->data() + offset, length);
    return static_cast<int>(length);
  }
  void cancel() override {}

 private:
  std::shared_ptr<const std::vector<uint8_t>> bytes_;
};

inline std::shared_ptr<const SeekableInputFactory> factory(uint32_t mask, size_t frames, int variant = 0) {
  auto bytes = std::make_shared<const std::vector<uint8_t>>(wave(mask, frames, variant));
  return std::make_shared<const SeekableInputFactory>([bytes](const std::string&) {
    return std::make_shared<MemoryInput>(bytes);
  });
}

}  // namespace twilight::audio::layout_fixture
