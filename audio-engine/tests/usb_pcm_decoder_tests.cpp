#include "../decoder/FFmpegDecoder.h"
#include "../output/android/AndroidPcmCallback.h"

extern "C" {
#include <libavutil/avutil.h>
}
#include <algorithm>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <vector>

using namespace twilight::audio;
namespace {
void check(bool ok, const std::string& message) { if (!ok) throw std::runtime_error(message); }

struct MemoryWave final : SeekableInput {
  std::vector<uint8_t> bytes;
  MemoryWave(const AudioFormat& format, const std::vector<uint8_t>& pcm) {
    const auto word = [&](uint32_t value, int count) {
      for (int i = 0; i < count; ++i) bytes.push_back(static_cast<uint8_t>(value >> (8 * i)));
    };
    const auto tag = [&](const char* text) { bytes.insert(bytes.end(), text, text + 4); };
    const auto stride = audioFormatBytesPerFrame(format);
    tag("RIFF"); word(36 + pcm.size(), 4); tag("WAVE"); tag("fmt "); word(16, 4);
    word(format.sampleFormat == AudioSampleFormat::Float32Interleaved ? 3 : 1, 2);
    word(format.channelCount, 2); word(format.sampleRate, 4); word(format.sampleRate * stride, 4);
    word(stride, 2); word(format.bitDepth, 2); tag("data"); word(pcm.size(), 4);
    bytes.insert(bytes.end(), pcm.begin(), pcm.end());
  }
  int64_t size() override { return bytes.size(); }
  int readAt(int64_t position, uint8_t* output, int count) override {
    if (position < 0 || count < 0) return -1;
    if (static_cast<size_t>(position) >= bytes.size()) return 0;
    const size_t length = std::min<size_t>(count, bytes.size() - position);
    std::memcpy(output, bytes.data() + position, length); return static_cast<int>(length);
  }
  void cancel() override {}
};

void verify(const AudioFormat& format) {
  constexpr size_t frames = 5003;
  const size_t stride = audioFormatBytesPerFrame(format), sampleBytes = stride / format.channelCount;
  std::vector<uint8_t> input(frames * stride);
  // Include zero, both signed limits, half-scale + 1 LSB, alternating low bits and varying words.
  const uint32_t seeds[] = {0, 1, 0xffffffff, 0x40000001, 0x7fffffff, 0x80000000, 0x80000001, 0x55555555};
  for (size_t i = 0; i < frames * format.channelCount; ++i) {
    uint32_t bits = i < std::size(seeds) ? seeds[i] : static_cast<uint32_t>(i * 100003u + 17u);
    if (format.sampleFormat == AudioSampleFormat::Float32Interleaved)
      bits = 0x3f000000u | (bits & 0x007fffffu) | ((i & 1) << 31); // finite, including 0.5 + 1 float LSB
    for (size_t byte = 0; byte < sampleBytes; ++byte) input[i * sampleBytes + byte] = bits >> (8 * byte);
  }
  const auto open = [&](FFmpegDecoder& decoder) {
    decoder.setInputFactory(std::make_shared<const SeekableInputFactory>([&](const std::string&) {
      return std::make_shared<MemoryWave>(format, input);
    }));
    std::string error;
    check(decoder.open("host-audio://raw.wav", &error), error);
    const auto source = decoder.streamInfo().sourceFormat;
    check(source.sampleRate == format.sampleRate && source.channelCount == format.channelCount &&
          source.bitDepth == format.bitDepth && source.sampleFormat == format.sampleFormat, "source format changed");
    check(decoder.setOutputFormat(format, &error), error);
    check(decoder.resamplerEngine() == FFmpegDecoder::ResamplerEngine::None, "raw PCM entered a resampler");
  };
  for (size_t block : {size_t(257), size_t(4096)}) {
    FFmpegDecoder decoder; open(decoder);
    std::vector<uint8_t> decoded, buffer(block * stride);
    std::string error;
    for (;;) {
      PcmBlock pcm{format, buffer.data(), block, buffer.size()};
      const size_t count = decoder.readFrames(pcm, &error);
      check(error.empty(), error);
      decoded.insert(decoded.end(), buffer.begin(), buffer.begin() + count * stride);
      if (!count) break;
    }
    check(decoder.eof() && decoded == input, "integer bits or float bytes changed, or tail was dropped");
  }
  FFmpegDecoder decoder; open(decoder);
  std::string error;
  for (const size_t offset : {size_t(0), size_t(1), size_t(1999), size_t(4090), frames - 3}) {
    check(decoder.seekOutputFrame(offset, &error), error);
    constexpr size_t wanted = 257;
    std::vector<uint8_t> output(wanted * stride + 8, 0xa5);
    size_t decodedFrames = 0;
    renderAndroidPcm(output.data(), wanted, format, true, true, [&](PcmBlock& pcm) {
      decodedFrames = decoder.readFrames(pcm, &error); return decodedFrames;
    }, [&](float*, size_t) -> size_t { throw std::runtime_error("raw PCM used a float fallback"); });
    check(error.empty(), error);
    const size_t expected = std::min(wanted, frames - offset);
    check(decodedFrames == expected, "seek returned wrong frame count");
    check(std::equal(input.begin() + offset * stride, input.begin() + (offset + expected) * stride,
        output.begin()), "seek changed PCM bytes");
    check(std::all_of(output.begin() + expected * stride, output.begin() + wanted * stride,
        [](auto byte) { return byte == 0; }), "short callback tail was not silent");
    check(std::all_of(output.begin() + wanted * stride, output.end(), [](auto byte) { return byte == 0xa5; }),
        "callback wrote past the AAudio buffer");
  }
  std::cout << "{\"encoding\":\"" << sampleFormatToString(format.sampleFormat) << "\",\"channels\":"
            << format.channelCount << ",\"frames\":" << frames << ",\"blockSizes\":[257,4096],\"seekPositions\":5,\"bytesExact\":true}\n";
}
}
int main() {
  try {
    std::cout << "{\"ffmpeg\":\"" << av_version_info() << "\",\"suite\":\"usb-raw-pcm\"}\n";
    for (const auto sample : {AudioSampleFormat::Int16Interleaved, AudioSampleFormat::Int24Interleaved,
                             AudioSampleFormat::Int32Interleaved, AudioSampleFormat::Float32Interleaved}) {
      for (const int channels : {1, 2}) {
        const int bits = sample == AudioSampleFormat::Int16Interleaved ? 16 : sample == AudioSampleFormat::Int24Interleaved ? 24 : 32;
        verify(AudioFormat{48000, channels, bits, sample});
      }
    }
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
