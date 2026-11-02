#include "AudioFixtureLibrary.h"

#include <algorithm>
#include <array>
#include <cassert>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <system_error>

#if defined(TAE_HAS_FFMPEG)
extern "C" {
#include <libavcodec/avcodec.h>
}
#endif

namespace twilight::audio::test {
namespace {

void writeLe16(std::ofstream& out, uint16_t value) {
  out.put(static_cast<char>(value & 0xff));
  out.put(static_cast<char>((value >> 8) & 0xff));
}

void writeLe32(std::ofstream& out, uint32_t value) {
  writeLe16(out, static_cast<uint16_t>(value & 0xffff));
  writeLe16(out, static_cast<uint16_t>((value >> 16) & 0xffff));
}

void writeLe64(std::ofstream& out, uint64_t value) {
  writeLe32(out, static_cast<uint32_t>(value & 0xffffffffULL));
  writeLe32(out, static_cast<uint32_t>((value >> 32) & 0xffffffffULL));
}

std::filesystem::path tempPathFor(const std::string& name) {
  return std::filesystem::temp_directory_path() / name;
}

std::string lowercaseExtension(const std::filesystem::path& path) {
  std::string extension = path.extension().string();
  std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return extension;
}

bool isSupportedExternalFixture(const std::filesystem::path& path) {
  static constexpr std::array<const char*, 11> kExtensions = {
      ".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".dsf", ".dff", ".aiff", ".iso"};
  const std::string extension = lowercaseExtension(path);
  return std::find(kExtensions.begin(), kExtensions.end(), extension) != kExtensions.end();
}

std::string readTextFile(const std::filesystem::path& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) return {};
  std::ostringstream buffer;
  buffer << file.rdbuf();
  return buffer.str();
}

std::string parseJsonStringAt(const std::string& json, size_t quote) {
  if (quote >= json.size() || json[quote] != '"') return {};
  std::string value;
  for (size_t i = quote + 1; i < json.size(); ++i) {
    const char ch = json[i];
    if (ch == '"') return value;
    if (ch != '\\' || i + 1 >= json.size()) {
      value.push_back(ch);
      continue;
    }
    const char escaped = json[++i];
    switch (escaped) {
      case '\\':
      case '"':
      case '/':
        value.push_back(escaped);
        break;
      case 'n':
        value.push_back('\n');
        break;
      case 'r':
        value.push_back('\r');
        break;
      case 't':
        value.push_back('\t');
        break;
      default:
        value.push_back(escaped);
        break;
    }
  }
  return {};
}

void collectManifestKeyPaths(
    const std::string& json,
    const std::string& key,
    const std::filesystem::path& baseDir,
    std::vector<std::filesystem::path>* fixtures) {
  if (!fixtures) return;
  const std::string needle = "\"" + key + "\"";
  size_t pos = 0;
  while ((pos = json.find(needle, pos)) != std::string::npos && fixtures->size() < 256) {
    const size_t colon = json.find(':', pos + needle.size());
    if (colon == std::string::npos) break;
    const size_t quote = json.find('"', colon + 1);
    if (quote == std::string::npos) break;
    std::filesystem::path candidate(parseJsonStringAt(json, quote));
    if (!candidate.empty()) {
      if (candidate.is_relative()) candidate = baseDir / candidate;
      if (isSupportedExternalFixture(candidate)) fixtures->push_back(candidate);
    }
    pos = quote + 1;
  }
}

std::vector<std::filesystem::path> findExternalAudioFixturesFromManifest() {
  const char* rawManifest = std::getenv("TAE_AUDIO_FIXTURE_MANIFEST");
  if (!rawManifest || std::string(rawManifest).empty()) return {};
  const std::filesystem::path manifestPath(rawManifest);
  const std::string json = readTextFile(manifestPath);
  if (json.empty()) return {};

  std::vector<std::filesystem::path> fixtures;
  const std::filesystem::path baseDir = manifestPath.parent_path();
  collectManifestKeyPaths(json, "path", baseDir, &fixtures);
  collectManifestKeyPaths(json, "source", baseDir, &fixtures);
  collectManifestKeyPaths(json, "file", baseDir, &fixtures);
  std::sort(fixtures.begin(), fixtures.end());
  fixtures.erase(std::unique(fixtures.begin(), fixtures.end()), fixtures.end());
  return fixtures;
}

}  // namespace

TempAudioFixture::TempAudioFixture(std::filesystem::path path) : path_(std::move(path)) {}

TempAudioFixture::TempAudioFixture(TempAudioFixture&& other) noexcept : path_(std::move(other.path_)) {
  other.path_.clear();
}

TempAudioFixture& TempAudioFixture::operator=(TempAudioFixture&& other) noexcept {
  if (this != &other) {
    cleanup();
    path_ = std::move(other.path_);
    other.path_.clear();
  }
  return *this;
}

TempAudioFixture::~TempAudioFixture() {
  cleanup();
}

void TempAudioFixture::cleanup() {
  if (path_.empty()) return;
  std::error_code ignored;
  std::filesystem::remove(path_, ignored);
  path_.clear();
}

TempAudioFixture writePcmWavFixture(const PcmWavFixtureSpec& spec) {
  const auto path = tempPathFor(spec.name);
  const int bytesPerSample = spec.bitsPerSample / 8;
  const int dataBytes = spec.frameCount * spec.channels * bytesPerSample;
  const uint16_t formatTag = spec.floatingPoint ? 3 : 1;

  std::ofstream out(path, std::ios::binary);
  out.write("RIFF", 4);
  writeLe32(out, 36 + static_cast<uint32_t>(dataBytes));
  out.write("WAVE", 4);
  out.write("fmt ", 4);
  writeLe32(out, 16);
  writeLe16(out, formatTag);
  writeLe16(out, static_cast<uint16_t>(spec.channels));
  writeLe32(out, static_cast<uint32_t>(spec.sampleRate));
  writeLe32(out, static_cast<uint32_t>(spec.sampleRate * spec.channels * bytesPerSample));
  writeLe16(out, static_cast<uint16_t>(spec.channels * bytesPerSample));
  writeLe16(out, static_cast<uint16_t>(spec.bitsPerSample));
  out.write("data", 4);
  writeLe32(out, static_cast<uint32_t>(dataBytes));

  for (int frame = 0; frame < spec.frameCount; ++frame) {
    for (int channel = 0; channel < spec.channels; ++channel) {
      if (spec.floatingPoint) {
        const float value = static_cast<float>(frame) / static_cast<float>(std::max(1, spec.frameCount));
        out.write(reinterpret_cast<const char*>(&value), sizeof(value));
      } else if (spec.bitsPerSample == 16) {
        writeLe16(out, static_cast<uint16_t>(frame * 64));
      } else if (spec.bitsPerSample == 24) {
        const int32_t value = frame * 512;
        out.put(static_cast<char>(value & 0xff));
        out.put(static_cast<char>((value >> 8) & 0xff));
        out.put(static_cast<char>((value >> 16) & 0xff));
      } else {
        writeLe32(out, static_cast<uint32_t>(frame * 1024));
      }
    }
  }

  return TempAudioFixture(path);
}

TempAudioFixture writeFlacTailFixture(
    const std::string& name, bool appendInvalidFrame, bool incomplete, bool knownLength, int fullFrames) {
  // Stereo/44.1 kHz FLAC: 8820 silent samples in two frames (4608 + 4212).
  const std::string hex =
      "664c6143000000221200120000000e0000100ac442f00000227442b1eafdf0fc632f"
      "46230ad0497a29bf8400000e0600000066666d70656700000000fff85918006b0000"
      "00000000108afff8791801107364000000000000d405";
  std::vector<uint8_t> bytes;
  for (size_t i = 0; i < hex.size(); i += 2)
    bytes.push_back(static_cast<uint8_t>(std::stoul(hex.substr(i, 2), nullptr, 16)));
  const auto firstFrame = std::vector<uint8_t>(bytes.begin() + 60, bytes.begin() + 74);
  const auto lastFrame = std::vector<uint8_t>(bytes.begin() + 74, bytes.end());
  bytes.resize(60);
  // Longer streams give FFmpeg's raw-FLAC binary seek enough frame headers.
  // Frame numbers stay below 128, so their UTF-8 representation is one byte.
  const auto appendFrame = [&bytes](std::vector<uint8_t> frame, uint8_t number, size_t headerCrcIndex) {
    frame[4] = number;
    uint8_t crc8 = 0;
    for (size_t i = 0; i < headerCrcIndex; ++i) {
      crc8 ^= frame[i];
      for (int bit = 0; bit < 8; ++bit) crc8 = (crc8 << 1) ^ ((crc8 & 0x80) ? 0x07 : 0);
    }
    frame[headerCrcIndex] = crc8;
    uint16_t crc16 = 0;
    for (size_t i = 0; i < frame.size() - 2; ++i) {
      crc16 ^= static_cast<uint16_t>(frame[i]) << 8;
      for (int bit = 0; bit < 8; ++bit) crc16 = (crc16 << 1) ^ ((crc16 & 0x8000) ? 0x8005 : 0);
    }
    frame[frame.size() - 2] = static_cast<uint8_t>(crc16 >> 8);
    frame.back() = static_cast<uint8_t>(crc16);
    bytes.insert(bytes.end(), frame.begin(), frame.end());
  };
  for (int i = 0; i < fullFrames; ++i) appendFrame(firstFrame, static_cast<uint8_t>(i), 5);
  if (!incomplete) appendFrame(lastFrame, static_cast<uint8_t>(fullFrames), 7);
  const uint64_t sampleCount = static_cast<uint64_t>(fullFrames) * 4608 + 4212;
  bytes[21] = (bytes[21] & 0xf0) | static_cast<uint8_t>(sampleCount >> 32);
  for (int i = 0; i < 4; ++i) bytes[22 + i] = static_cast<uint8_t>(sampleCount >> ((3 - i) * 8));
  std::fill(bytes.begin() + 26, bytes.begin() + 42, 0); // Unset optional PCM MD5.
  if (!knownLength) {
    bytes[21] &= 0xf0;
    bytes[22] = bytes[23] = bytes[24] = bytes[25] = 0;
  }
  if (appendInvalidFrame) {
    // Valid frame header, invalid subframe: receive_frame returns INVALIDDATA.
    const std::array<uint8_t, 14> invalid{0xff, 0xf8, 0x59, 0x18, 0x00, 0x6b, 0x04, 0, 0, 0, 0, 0, 0x10, 0x8a};
    bytes.insert(bytes.end(), invalid.begin(), invalid.end());
  }
  const auto path = tempPathFor(name);
  std::ofstream out(path, std::ios::binary);
  out.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
  return TempAudioFixture(path);
}

TempAudioFixture writeDsfFixture(const std::string& name, int sampleRate, int blockSizePerChannel) {
  const auto path = tempPathFor(name);
  constexpr uint32_t kChannels = 2;
  const uint32_t blockSize = static_cast<uint32_t>(std::max(1, blockSizePerChannel));
  const uint64_t dataBytes = static_cast<uint64_t>(kChannels) * blockSize;
  const uint64_t fileSize = 28 + 52 + 12 + dataBytes;

  std::ofstream out(path, std::ios::binary);
  out.write("DSD ", 4);
  writeLe64(out, 28);
  writeLe64(out, fileSize);
  writeLe64(out, 0);
  out.write("fmt ", 4);
  writeLe64(out, 52);
  writeLe32(out, 1);
  writeLe32(out, 0);
  writeLe32(out, 2);
  writeLe32(out, kChannels);
  writeLe32(out, static_cast<uint32_t>(sampleRate));
  writeLe32(out, 1);
  writeLe64(out, static_cast<uint64_t>(blockSize) * 8);
  writeLe32(out, blockSize);
  writeLe32(out, 0);
  out.write("data", 4);
  writeLe64(out, 12 + dataBytes);
  for (uint64_t i = 0; i < dataBytes; ++i) out.put(static_cast<char>(0x69));

  return TempAudioFixture(path);
}

TempAudioFixture writeWavPackDsdFixture(const std::string& name) {
  const auto path = tempPathFor(name);
  constexpr uint32_t kFrames = 1024;
  constexpr uint32_t kDataBytes = kFrames * 2;
  constexpr uint32_t kMetadataWords = (2 + kDataBytes) / 2;
  uint32_t crc = 0xffffffffu;
  for (uint32_t i = 0; i < kDataBytes; ++i) crc = crc * 3 + 0x69;
  std::ofstream out(path, std::ios::binary);
  out.write("wvpk", 4);
  writeLe32(out, 32 + 4 + 2 + kDataBytes - 8);
  writeLe16(out, 0x0410);
  out.put(0); // Track and index are unused in version 4.
  out.put(0);
  writeLe32(out, kFrames);
  writeLe32(out, 0);
  writeLe32(out, kFrames);
  // DSD, 88.2 kHz base rate, first and final block, stereo.
  writeLe32(out, 0x80000000u | (12u << 23) | 0x1800u);
  writeLe32(out, crc);
  out.put(static_cast<char>(0x8e)); // Large DSD-data metadata block.
  out.put(static_cast<char>(kMetadataWords & 0xff));
  out.put(static_cast<char>((kMetadataWords >> 8) & 0xff));
  out.put(static_cast<char>((kMetadataWords >> 16) & 0xff));
  out.put(3); // Decoded byte rate = 88,200 * 2^3 = 705,600 Hz (DSD128).
  out.put(0); // Uncompressed DSD bytes, interleaved stereo.
  for (uint32_t i = 0; i < kDataBytes; ++i) out.put(static_cast<char>(0x69));
  return TempAudioFixture(path);
}

#if defined(TAE_HAS_FFMPEG)
TempAudioFixture writeWavPackPcmFixture(const std::string& name, int bits, bool floatingPoint, int rate) {
  const auto path = tempPathFor(name);
  const auto* encoder = avcodec_find_encoder(AV_CODEC_ID_WAVPACK);
  assert(encoder);
  auto* context = avcodec_alloc_context3(encoder);
  assert(context);
  context->sample_fmt = floatingPoint ? AV_SAMPLE_FMT_FLTP : bits <= 16 ? AV_SAMPLE_FMT_S16P : AV_SAMPLE_FMT_S32P;
  context->sample_rate = rate;
  context->bits_per_raw_sample = bits;
  context->frame_size = 128;
  av_channel_layout_default(&context->ch_layout, 2);
  assert(avcodec_open2(context, encoder, nullptr) == 0);
  auto* frame = av_frame_alloc();
  auto* packet = av_packet_alloc();
  assert(frame && packet);
  frame->format = context->sample_fmt;
  frame->sample_rate = rate;
  frame->nb_samples = 128;
  assert(av_channel_layout_copy(&frame->ch_layout, &context->ch_layout) == 0);
  assert(av_frame_get_buffer(frame, 0) == 0);
  for (int channel = 0; channel < 2; ++channel) {
    for (int i = 0; i < 128; ++i) {
      const int value = (channel ? -1 : 1) * (i % 64 - 32);
      if (floatingPoint) reinterpret_cast<float*>(frame->data[channel])[i] = value / 64.0f;
      else if (bits <= 16) reinterpret_cast<int16_t*>(frame->data[channel])[i] = value * 127;
      else reinterpret_cast<int32_t*>(frame->data[channel])[i] = value * (bits <= 24 ? 256 : 1);
    }
  }
  assert(avcodec_send_frame(context, frame) == 0);
  assert(avcodec_receive_packet(context, packet) == 0);
  assert(packet->size >= 32);
  // The standalone single-block fixture has a known total. The encoder leaves
  // it unknown for a muxer to fill in. Give the 20-bit case four padding bits;
  // the decoder applies that shift after unpacking the small integer payload.
  packet->data[12] = 128;
  packet->data[13] = packet->data[14] = packet->data[15] = 0;
  if (bits == 20 && !floatingPoint) packet->data[25] |= 0x80; // 4 << SHIFT_LSB (13).
  std::ofstream out(path, std::ios::binary);
  out.write(reinterpret_cast<const char*>(packet->data), packet->size);
  const std::vector<std::pair<std::string, std::string>> tags = {
      {"Title", "Moonrise"}, {"Artist", "Twilight"}, {"Album", "Night"}, {"Track", "3/9"}, {"Disc", "2/2"}};
  uint32_t tagSize = 32;
  for (const auto& [key, value] : tags) {
    writeLe32(out, value.size());
    writeLe32(out, 0);
    out.write(key.c_str(), key.size() + 1);
    out.write(value.data(), value.size());
    tagSize += 8 + key.size() + 1 + value.size();
  }
  out.write("APETAGEX", 8);
  writeLe32(out, 2000);
  writeLe32(out, tagSize);
  writeLe32(out, tags.size());
  writeLe32(out, 0);
  writeLe64(out, 0);
  assert(out.good());
  av_packet_free(&packet);
  av_frame_free(&frame);
  avcodec_free_context(&context);
  return TempAudioFixture(path);
}
#endif

std::vector<std::filesystem::path> findExternalAudioFixtures() {
  auto manifestFixtures = findExternalAudioFixturesFromManifest();
  if (!manifestFixtures.empty()) return manifestFixtures;

  const char* rawDir = std::getenv("TAE_AUDIO_FIXTURES_DIR");
  if (!rawDir || std::string(rawDir).empty()) return {};

  std::error_code error;
  const std::filesystem::path root(rawDir);
  if (!std::filesystem::exists(root, error) || !std::filesystem::is_directory(root, error)) return {};

  std::vector<std::filesystem::path> fixtures;
  for (const auto& entry : std::filesystem::recursive_directory_iterator(root, error)) {
    if (error) break;
    if (!entry.is_regular_file(error)) continue;
    if (!isSupportedExternalFixture(entry.path())) continue;
    fixtures.push_back(entry.path());
    if (fixtures.size() >= 64) break;
  }
  std::sort(fixtures.begin(), fixtures.end());
  return fixtures;
}

}  // namespace twilight::audio::test
