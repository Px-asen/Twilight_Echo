#include "../dsp/ConvolverProcessor.h"

#include <algorithm>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <vector>

using namespace twilight::audio;

// The same 32-frame stereo PCM16 IR in four containers: left +0.5, right -0.25.
void writePcmImpulse(const std::filesystem::path& path, bool aiff, bool aifc) {
  std::ofstream out(path, std::ios::binary);
  const auto integer = [&](uint32_t value, int bytes, bool bigEndian) {
    for (int i = 0; i < bytes; ++i) out.put(static_cast<char>(value >> (8 * (bigEndian ? bytes - i - 1 : i))));
  };
  if (aiff) {
    out.write("FORM", 4); integer(aifc ? 192 : 174, 4, true); out.write(aifc ? "AIFC" : "AIFF", 4);
    if (aifc) { out.write("FVER", 4); integer(4, 4, true); integer(0xa2805140, 4, true); }
    out.write("COMM", 4); integer(aifc ? 24 : 18, 4, true);
    integer(2, 2, true); integer(32, 4, true); integer(16, 2, true);
    const uint8_t rate[]{0x40, 0x0e, 0xbb, 0x80, 0, 0, 0, 0, 0, 0};  // 48000, IEEE extended 80-bit.
    out.write(reinterpret_cast<const char*>(rate), sizeof(rate));
    if (aifc) { out.write("sowt", 4); integer(0, 2, true); }
    out.write("SSND", 4); integer(136, 4, true); integer(0, 4, true); integer(0, 4, true);
  } else {
    out.write("RIFF", 4); integer(164, 4, false); out.write("WAVEfmt ", 8);
    integer(16, 4, false); integer(1, 2, false); integer(2, 2, false); integer(48000, 4, false);
    integer(192000, 4, false); integer(4, 2, false); integer(16, 2, false);
    out.write("data", 4); integer(128, 4, false);
  }
  for (int frame = 0; frame < 32; ++frame) {
    integer(16384, 2, aiff && !aifc); integer(0xe000, 2, aiff && !aifc);
  }
}

void writeFlacImpulse(const std::filesystem::path& path) {
  // One fixed-block frame, independent stereo constant subframes, unset optional STREAMINFO MD5.
  const std::string hex =
      "664c614380000022002000200000000000000bb802f00000002000000000000000000000000000000000"
      "fff86018001f4400400000e000164f";
  std::ofstream out(path, std::ios::binary);
  for (size_t i = 0; i < hex.size(); i += 2) out.put(static_cast<char>(std::stoul(hex.substr(i, 2), nullptr, 16)));
}

int main(int argc, char** argv) try {
  const auto root = argc == 2 ? std::filesystem::path(argv[1]) : std::filesystem::temp_directory_path();
  const auto directory = root /
      ("twilight-convolver-formats-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  std::filesystem::create_directory(directory);
  const auto wav = directory / "ir.wav", flac = directory / "ir.flac";
  const auto aiff = directory / "ir.aiff", aifc = directory / "ir-aifc.aiff";
  writePcmImpulse(wav, false, false); writePcmImpulse(aiff, true, false);
  writePcmImpulse(aifc, true, true); writeFlacImpulse(flac);
  for (const auto& path : {wav, flac, aiff, aifc}) {
    for (const std::vector<size_t>& chunks : {std::vector<size_t>{128}, std::vector<size_t>{1, 17, 64, 123}}) {
      ConvolverProcessor processor;
      AudioFormat format; format.sampleRate = 48000; format.channelCount = 2;
      processor.prepare(format);
      DspConfig config; config.enabled = true; config.convolverEnabled = true; config.convolverPartitionSize = 64;
      processor.configure(config);
      std::string error;
      const bool loaded = processor.loadImpulseResponse(path.string(), &error);
      if (!loaded) std::cerr << path << ": " << error << '\n';
      assert(loaded);
      const auto info = processor.info();
      assert(info.sampleRate == 48000 && info.channels == 2 && info.lengthFrames == 32);
      std::vector<float> samples(512 * 2, 0.0f);
      samples[0] = samples[1] = 1.0f;
      size_t offset = 0, chunk = 0;
      while (offset < 512) {
        const size_t frames = std::min(chunks[chunk++ % chunks.size()], 512 - offset);
        processor.process(samples.data() + offset * 2, frames);
        offset += frames;
      }
      assert(processor.isActive());
      for (size_t frame = 0; frame < 512; ++frame) {
        const bool wet = frame >= info.latencyFrames && frame < info.latencyFrames + 32;
        assert(std::abs(samples[frame * 2] - (wet ? .5f : 0.0f)) < .000002f);
        assert(std::abs(samples[frame * 2 + 1] - (wet ? -.25f : 0.0f)) < .000002f);
      }
    }
    std::filesystem::remove(path);
  }
  std::filesystem::remove(directory);
  std::cout << "WAV, FLAC, AIFF and AIFC impulse decode/convolution: stereo samples, gain, sign and fragmented input passed\n";
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
