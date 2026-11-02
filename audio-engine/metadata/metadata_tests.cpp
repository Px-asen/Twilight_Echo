#include "AudioMetadataService.h"
#include "../decoder/SeekableInputStream.h"
#include "../tests/AudioFixtureLibrary.h"

#include <algorithm>
#include <cassert>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <system_error>
#include <vector>

using namespace twilight::audio;

namespace {

void writeIsoLe32To(uint8_t* data, uint32_t value) {
  data[0] = static_cast<uint8_t>(value & 0xff);
  data[1] = static_cast<uint8_t>((value >> 8) & 0xff);
  data[2] = static_cast<uint8_t>((value >> 16) & 0xff);
  data[3] = static_cast<uint8_t>((value >> 24) & 0xff);
}

void writeIsoBe32To(uint8_t* data, uint32_t value) {
  data[0] = static_cast<uint8_t>((value >> 24) & 0xff);
  data[1] = static_cast<uint8_t>((value >> 16) & 0xff);
  data[2] = static_cast<uint8_t>((value >> 8) & 0xff);
  data[3] = static_cast<uint8_t>(value & 0xff);
}

void writeIsoDirectoryRecord(
    std::vector<uint8_t>& directory,
    size_t offset,
    uint32_t extent,
    uint32_t size,
    bool isDirectory,
    const std::string& name) {
  const size_t nameLength = name.size();
  const size_t recordLength = 33 + nameLength + ((nameLength % 2) == 0 ? 1 : 0);
  assert(offset + recordLength <= directory.size());
  directory[offset] = static_cast<uint8_t>(recordLength);
  writeIsoLe32To(directory.data() + offset + 2, extent);
  writeIsoBe32To(directory.data() + offset + 6, extent);
  writeIsoLe32To(directory.data() + offset + 10, size);
  writeIsoBe32To(directory.data() + offset + 14, size);
  directory[offset + 25] = isDirectory ? 0x02 : 0x00;
  directory[offset + 28] = 1;
  directory[offset + 31] = 1;
  directory[offset + 32] = static_cast<uint8_t>(nameLength);
  std::copy(name.begin(), name.end(), directory.begin() + static_cast<std::ptrdiff_t>(offset + 33));
}

void writeIsoSpecialDirectoryRecord(
    std::vector<uint8_t>& directory,
    size_t offset,
    uint32_t extent,
    uint32_t size,
    uint8_t name) {
  directory[offset] = 34;
  writeIsoLe32To(directory.data() + offset + 2, extent);
  writeIsoBe32To(directory.data() + offset + 6, extent);
  writeIsoLe32To(directory.data() + offset + 10, size);
  writeIsoBe32To(directory.data() + offset + 14, size);
  directory[offset + 25] = 0x02;
  directory[offset + 28] = 1;
  directory[offset + 31] = 1;
  directory[offset + 32] = 1;
  directory[offset + 33] = name;
}

void writeIsoTwilightTrack(
    std::vector<uint8_t>& toc,
    size_t offset,
    int trackNumber,
    uint32_t startSector,
    uint32_t sectorCount,
    uint32_t channelCount,
    uint32_t sampleRate,
    bool dst,
    const std::string& fileName) {
  assert(offset + 64 <= toc.size());
  std::memcpy(toc.data() + offset, "TWTE1", 5);
  writeIsoLe32To(toc.data() + offset + 8, static_cast<uint32_t>(trackNumber));
  writeIsoLe32To(toc.data() + offset + 12, startSector);
  writeIsoLe32To(toc.data() + offset + 16, sectorCount);
  writeIsoLe32To(toc.data() + offset + 20, channelCount);
  writeIsoLe32To(toc.data() + offset + 24, sampleRate);
  writeIsoLe32To(toc.data() + offset + 28, dst ? 1U : 0U);
  std::copy(fileName.begin(), fileName.end(), toc.begin() + static_cast<std::ptrdiff_t>(offset + 32));
}

std::filesystem::path writeSacdMetadataIsoFixture(const std::string& name) {
  const auto path = std::filesystem::temp_directory_path() / name;
  constexpr uint32_t kRootSector = 20;
  constexpr uint32_t kSacdSector = 21;
  constexpr uint32_t kSectorSize = 2048;
  std::vector<uint8_t> image(27 * kSectorSize, 0);

  uint8_t* pvd = image.data() + 16 * kSectorSize;
  pvd[0] = 1;
  std::memcpy(pvd + 1, "CD001", 5);
  pvd[6] = 1;
  writeIsoLe32To(pvd + 156 + 2, kRootSector);
  writeIsoBe32To(pvd + 156 + 6, kRootSector);
  writeIsoLe32To(pvd + 156 + 10, kSectorSize);
  writeIsoBe32To(pvd + 156 + 14, kSectorSize);
  pvd[156] = 34;
  pvd[156 + 25] = 0x02;
  pvd[156 + 28] = 1;
  pvd[156 + 31] = 1;
  pvd[156 + 32] = 1;

  uint8_t* terminator = image.data() + 17 * kSectorSize;
  terminator[0] = 255;
  std::memcpy(terminator + 1, "CD001", 5);
  terminator[6] = 1;

  std::vector<uint8_t> root(kSectorSize, 0);
  writeIsoSpecialDirectoryRecord(root, 0, kRootSector, kSectorSize, 0);
  writeIsoSpecialDirectoryRecord(root, 34, kRootSector, kSectorSize, 1);
  writeIsoDirectoryRecord(root, 68, kSacdSector, kSectorSize, true, "SACD");
  std::copy(root.begin(), root.end(), image.begin() + kRootSector * kSectorSize);

  std::vector<uint8_t> sacd(kSectorSize, 0);
  writeIsoSpecialDirectoryRecord(sacd, 0, kSacdSector, kSectorSize, 0);
  writeIsoSpecialDirectoryRecord(sacd, 34, kRootSector, kSectorSize, 1);
  writeIsoDirectoryRecord(sacd, 68, 22, 128, false, "MASTER.TOC");
  writeIsoDirectoryRecord(sacd, 112, 23, 2048, false, "TWOCH_AREA.TOC");
  writeIsoDirectoryRecord(sacd, 160, 25, 256, false, "TRACK01.DSD");
  writeIsoDirectoryRecord(sacd, 206, 26, 256, false, "TRACK02.DST");
  std::copy(sacd.begin(), sacd.end(), image.begin() + kSacdSector * kSectorSize);

  std::vector<uint8_t> twoch(kSectorSize, 0);
  std::memcpy(twoch.data(), "TWTEAREA", 8);
  writeIsoLe32To(twoch.data() + 8, 2);
  writeIsoTwilightTrack(twoch, 16, 1, 25, 1, 2, 2822400, false, "TRACK01.DSD");
  writeIsoTwilightTrack(twoch, 80, 2, 26, 1, 2, 2822400, true, "TRACK02.DST");
  std::copy(twoch.begin(), twoch.end(), image.begin() + 23 * kSectorSize);

  for (int i = 0; i < 256; ++i) image[25 * kSectorSize + i] = static_cast<uint8_t>(0x80 + (i & 0x3f));
  for (int i = 0; i < 256; ++i) image[26 * kSectorSize + i] = static_cast<uint8_t>(0x40 + (i & 0x3f));

  std::ofstream out(path, std::ios::binary);
  out.write(reinterpret_cast<const char*>(image.data()), static_cast<std::streamsize>(image.size()));
  if (!out.good()) throw std::system_error(errno, std::generic_category(), "Cannot write fixture " + path.string());
  return path;
}

#if defined(TAE_HAS_FFMPEG)
void writeLe32(std::ofstream& out, uint32_t value) {
  out.put(static_cast<char>(value & 0xff));
  out.put(static_cast<char>((value >> 8) & 0xff));
  out.put(static_cast<char>((value >> 16) & 0xff));
  out.put(static_cast<char>((value >> 24) & 0xff));
}

void writeLe64(std::ofstream& out, uint64_t value) {
  writeLe32(out, static_cast<uint32_t>(value & 0xffffffffULL));
  writeLe32(out, static_cast<uint32_t>((value >> 32) & 0xffffffffULL));
}

std::filesystem::path writeDsfFixture(const std::string& name, uint32_t sampleRate) {
  const auto path = std::filesystem::temp_directory_path() / name;
  constexpr uint32_t kChannels = 2;
  constexpr uint32_t kBlockSizePerChannel = 4096;
  constexpr uint64_t kDataBytes = static_cast<uint64_t>(kChannels) * kBlockSizePerChannel;
  constexpr uint64_t kFileSize = 28 + 52 + 12 + kDataBytes;

  std::ofstream out(path, std::ios::binary);
  out.write("DSD ", 4);
  writeLe64(out, 28);
  writeLe64(out, kFileSize);
  writeLe64(out, 0);
  out.write("fmt ", 4);
  writeLe64(out, 52);
  writeLe32(out, 1);
  writeLe32(out, 0);
  writeLe32(out, 2);
  writeLe32(out, kChannels);
  writeLe32(out, sampleRate);
  writeLe32(out, 1);
  writeLe64(out, kBlockSizePerChannel * 8);
  writeLe32(out, kBlockSizePerChannel);
  writeLe32(out, 0);
  out.write("data", 4);
  writeLe64(out, 12 + kDataBytes);
  for (uint64_t i = 0; i < kDataBytes; ++i) out.put(static_cast<char>(0x69));
  return path;
}

void assertDsfMetadataWhenSupported(const std::string& name, uint32_t sampleRate, int dsdRate) {
  const auto path = writeDsfFixture(name, sampleRate);
  const std::string json = readMetadataJson(path.string());
  std::filesystem::remove(path);
  if (json.find("\"error\":\"\"") == std::string::npos) {
    std::cout << "Skipping DSF metadata fixture: FFmpeg could not parse generated DSF" << std::endl;
    return;
  }
  assert(json.find("\"codec\":\"dsd") != std::string::npos);
  assert(json.find("\"container\":\"") != std::string::npos);
  assert(json.find("\"isDsd\":true") != std::string::npos);
  assert(json.find("\"dsdMode\":\"pcm\"") != std::string::npos);
  assert(json.find("\"outputModes\":[\"native\",\"dop\",\"pcm\"]") != std::string::npos);
  assert(json.find("\"sampleRate\":" + std::to_string(sampleRate)) != std::string::npos);
  assert(json.find("\"dsdRate\":" + std::to_string(dsdRate)) != std::string::npos);
  assert(json.find("\"channelCount\":2") != std::string::npos);
  assert(json.find("\"bitDepth\":1") != std::string::npos);
}

void assertWavPackMetadata() {
  const auto check = [](const test::TempAudioFixture& fixture, bool dsd, int bits, int rate) {
    SeekableInputStream stream;
    assert(stream.open(fixture.string()));
    const auto factory = std::make_shared<const SeekableInputFactory>(
        [input = stream.input()](const std::string&) { return input; });
    for (const bool hosted : {false, true}) {
      const auto json = hosted ? readMetadataJson("content://documents/opaque-metadata", factory) : readMetadataJson(fixture.string());
      assert(json.find("\"error\":\"\"") != std::string::npos);
      assert(json.find("\"codec\":\"wavpack\"") != std::string::npos);
      assert(json.find(std::string("\"isDsd\":") + (dsd ? "true" : "false")) != std::string::npos);
      assert(json.find("\"bitDepth\":" + std::to_string(bits) + ",") != std::string::npos);
      assert(json.find("\"sampleRate\":" + std::to_string(rate) + ",") != std::string::npos);
      assert(json.find("\"channelCount\":2") != std::string::npos);
      if (dsd) {
        assert(json.find("\"dsdRate\":128") != std::string::npos);
        assert(json.find("\"outputModes\":[\"pcm\"]") != std::string::npos);
      } else {
        assert(json.find("\"title\":\"Moonrise\"") != std::string::npos);
        assert(json.find("\"artist\":\"Twilight\"") != std::string::npos);
        assert(json.find("\"album\":\"Night\"") != std::string::npos);
        assert(json.find("\"trackNumber\":\"3/9\"") != std::string::npos);
        assert(json.find("\"discNumber\":\"2/2\"") != std::string::npos);
      }
    }
  };
  const auto dsd = test::writeWavPackDsdFixture("twilight-metadata-dsd128.wv");
  check(dsd, true, 1, 5644800);
  for (const auto& [bits, floating] : {std::pair{16, false}, {20, false}, {24, false}, {32, false}, {32, true}}) {
    const auto fixture = test::writeWavPackPcmFixture("twilight-metadata-pcm.wv", bits, floating, 192000);
    check(fixture, false, bits, 192000);
  }
}
#endif

}  // namespace

int main() try {
  const std::string empty = readMetadataJson("");
  assert(empty.find("\"error\":\"音频地址为空\"") != std::string::npos);

  const auto sacdIsoPath = writeSacdMetadataIsoFixture("twilight-metadata-sacd.iso");
  const std::string sacdIso = readMetadataJson(sacdIsoPath.string());
  std::filesystem::remove(sacdIsoPath);
  if (sacdIso.find("\"container\":\"SACD ISO\"") == std::string::npos) std::cerr << sacdIso << '\n';
  assert(sacdIso.find("\"container\":\"SACD ISO\"") != std::string::npos);
  assert(sacdIso.find("\"isDsd\":true") != std::string::npos);
  assert(sacdIso.find("\"isoTracks\":[") != std::string::npos);
  assert(sacdIso.find("?area=stereo&track=1") != std::string::npos);
  assert(sacdIso.find("\"codec\":\"dsd\"") != std::string::npos);
  assert(sacdIso.find("\"codec\":\"dst\"") != std::string::npos);
  assert(sacdIso.find("\"playable\":true") != std::string::npos);
#if defined(TAE_HAS_FFMPEG)
  assert(sacdIso.find("\"outputModes\":[\"native\",\"dop\",\"pcm\"]") != std::string::npos);
#else
  assert(sacdIso.find("\"outputModes\":[\"native\",\"dop\"]") != std::string::npos);
  assert(sacdIso.find("\"dsdMode\":\"unsupported\"") != std::string::npos);
#endif
  // Metadata uses the same built-in DSD-preserving provider as playback.
  assert(sacdIso.find("\"playable\":false") == std::string::npos);
  assert(sacdIso.find("\"reasonCode\":\"dst_dsd_provider_unavailable\"") == std::string::npos);

  const std::string missing = readMetadataJson("missing-file.flac");
  assert(missing.find("\"source\":\"missing-file.flac\"") != std::string::npos);
  assert(missing.find("\"composer\"") != std::string::npos);
  assert(missing.find("\"albumArtist\"") != std::string::npos);
  assert(missing.find("\"trackNumber\"") != std::string::npos);
  assert(missing.find("\"discNumber\"") != std::string::npos);
  assert(missing.find("\"comment\"") != std::string::npos);
#if defined(TAE_HAS_FFMPEG)
  assertDsfMetadataWhenSupported("twilight-metadata-dsd64.dsf", 2822400, 64);
  assertDsfMetadataWhenSupported("twilight-metadata-dsd128.dsf", 5644800, 128);
  assertDsfMetadataWhenSupported("twilight-metadata-dsd256.dsf", 11289600, 256);
  assertWavPackMetadata();
#endif
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
