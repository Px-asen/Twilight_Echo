#pragma once

#include "SeekableInputStream.h"

#include <array>
#include <cstdint>
#include <optional>
#include <utility>

namespace twilight::audio {

struct WavPackSource {
  bool isDsd = false;
  int bitDepth = 0;
  int64_t totalSamples = -1; // DSD counts bytes per channel, PCM counts samples.
  int64_t leadingTagBytes = 0;
};

// Read through a separate positional cursor, leaving FFmpeg's buffered packets
// untouched. The same host input serves opaque content URIs and local files.
// Flags and the 40-bit count follow WavPack 5.7.0's wavpack.h/open_utils.c.
inline std::optional<WavPackSource> readWavPackSource(
    const std::string& source, std::shared_ptr<SeekableInput> input = {}) {
  SeekableInputStream stream;
  if (input) stream.open(std::move(input));
  else if (!stream.open(source)) return std::nullopt;
  int64_t offset = 0;
  int64_t leadingTagBytes = 0;
  std::array<uint8_t, 32> header{};
  const auto le32 = [&](size_t at) {
    return uint32_t(header[at]) | (uint32_t(header[at + 1]) << 8) |
        (uint32_t(header[at + 2]) << 16) | (uint32_t(header[at + 3]) << 24);
  };
  while (true) {
    stream.clear();
    stream.seekg(offset);
    stream.read(reinterpret_cast<char*>(header.data()), header.size());
    const auto count = stream.gcount();
    if (count >= 10 && std::memcmp(header.data(), "ID3", 3) == 0) {
      const auto size = (uint32_t(header[6] & 0x7f) << 21) | (uint32_t(header[7] & 0x7f) << 14) |
          (uint32_t(header[8] & 0x7f) << 7) | (header[9] & 0x7f);
      offset += 10 + size + ((header[5] & 0x10) ? 10 : 0);
      leadingTagBytes = offset;
      continue;
    }
    if (count != 32 || std::memcmp(header.data(), "wvpk", 4) != 0 || le32(4) < 24) return std::nullopt;
    if (le32(20) == 0) { offset += 8LL + le32(4); continue; }
    const uint32_t flags = le32(24);
    WavPackSource result;
    result.leadingTagBytes = leadingTagBytes;
    result.isDsd = (flags & 0x80000000u) != 0;
    result.bitDepth = result.isDsd ? 1 : (flags & 0x80u) ? 32 :
        int((flags & 3u) + 1) * 8 - int((flags >> 13) & 0x1fu);
    if (le32(12) != 0xffffffffu) {
      result.totalSamples = le32(12) + (int64_t(header[11]) << 32) - header[11];
    }
    return result;
  }
}

}  // namespace twilight::audio
