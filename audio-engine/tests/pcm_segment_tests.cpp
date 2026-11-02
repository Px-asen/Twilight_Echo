#include "../media/PcmSegmentRenderer.h"
#include "../decoder/FFmpegDecoder.h"
#include "ChannelLayoutFixture.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
}
#include <algorithm>
#include <cstring>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <vector>

using namespace twilight::audio;
namespace {
void check(bool ok, const std::string& message) { if (!ok) throw std::runtime_error(message); }
void word(std::vector<uint8_t>& bytes, uint32_t value, int width) {
  for (int i = 0; i < width; ++i) bytes.push_back(static_cast<uint8_t>(value >> (8 * i)));
}
void tag(std::vector<uint8_t>& bytes, const char* text) { bytes.insert(bytes.end(), text, text + 4); }
uint32_t le(const std::string& text, size_t start, int width) {
  uint32_t value = 0;
  for (int i = 0; i < width; ++i) value |= static_cast<uint32_t>(static_cast<uint8_t>(text.at(start + i))) << (8 * i);
  return value;
}
struct MemoryInput final : SeekableInput {
  std::vector<uint8_t> bytes;
  explicit MemoryInput(std::vector<uint8_t> data) : bytes(std::move(data)) {}
  int64_t size() override { return bytes.size(); }
  int readAt(int64_t offset, uint8_t* output, int count) override {
    if (offset < 0 || count < 0) return -1;
    if (static_cast<size_t>(offset) >= bytes.size()) return 0;
    const size_t length = std::min<size_t>(count, bytes.size() - offset);
    std::memcpy(output, bytes.data() + offset, length);
    return static_cast<int>(length);
  }
  void cancel() override {}
};
void open(FFmpegDecoder& decoder, const std::vector<uint8_t>& input) {
  decoder.setInputFactory(std::make_shared<const SeekableInputFactory>([&input](const std::string&) {
    return std::make_shared<MemoryInput>(input);
  }));
  std::string error;
  check(decoder.open("host-audio://disc.wav", &error), error);
}
std::vector<uint8_t> wave(const AudioFormat& format, const std::vector<uint8_t>& pcm) {
  std::vector<uint8_t> out;
  const size_t stride = audioFormatBytesPerFrame(format);
  tag(out, "RIFF"); word(out, 36 + pcm.size(), 4); tag(out, "WAVE");
  tag(out, "fmt "); word(out, 16, 4);
  word(out, format.sampleFormat == AudioSampleFormat::Float32Interleaved ? 3 : 1, 2);
  word(out, format.channelCount, 2); word(out, format.sampleRate, 4); word(out, format.sampleRate * stride, 4);
  word(out, stride, 2); word(out, format.bitDepth, 2); tag(out, "data"); word(out, pcm.size(), 4);
  out.insert(out.end(), pcm.begin(), pcm.end());
  return out;
}
std::vector<uint8_t> pcm(const AudioFormat& format, size_t frames) {
  const size_t stride = audioFormatBytesPerFrame(format), width = stride / format.channelCount;
  std::vector<uint8_t> out(frames * stride);
  for (size_t i = 0; i < frames * format.channelCount; ++i) {
    uint32_t bits = static_cast<uint32_t>(i * 100003u + 17u);
    if (format.sampleFormat == AudioSampleFormat::Float32Interleaved)
      bits = 0x3f000000u | (bits & 0x007fffffu) | ((i & 1u) << 31);
    for (size_t byte = 0; byte < width; ++byte) out[i * width + byte] = bits >> (byte * 8);
  }
  return out;
}
void verify(const AudioFormat& format) {
  constexpr size_t frames = 10013, start = 1001, end = frames - 3;
  const auto original = pcm(format, frames);
  const auto input = wave(format, original);
  const size_t stride = audioFormatBytesPerFrame(format);
  const size_t silence = format.sampleRate / 75;
  FFmpegDecoder decoder; open(decoder, input);
  std::ostringstream output(std::ios::binary);
  std::string error;
  check(writePcmSegment(decoder, double(start) / format.sampleRate, double(end) / format.sampleRate,
      double(silence) / format.sampleRate, output, &error), error);
  const auto wav = output.str();
  check(wav.substr(0, 4) == "RIFF" && wav.substr(8, 4) == "WAVE" && le(wav, 4, 4) + 8 == wav.size(), "invalid RIFF length");
  check(le(wav, 22, 2) == static_cast<unsigned>(format.channelCount) &&
      le(wav, 24, 4) == static_cast<unsigned>(format.sampleRate) && le(wav, 34, 2) == static_cast<unsigned>(format.bitDepth),
      "segment rate, channel count or PCM width changed");
  size_t data = 0;
  for (size_t offset = 12; offset + 8 <= wav.size();) {
    const size_t count = le(wav, offset + 4, 4);
    if (wav.substr(offset, 4) == "data") { data = offset + 8; break; }
    offset += 8 + count + (count & 1);
  }
  check(data && le(wav, data - 4, 4) == (silence + end - start) * stride, "wrong segment duration or data size");
  check(std::all_of(wav.begin() + data, wav.begin() + data + silence * stride,
      [](char value) { return value == 0; }), "virtual PREGAP was not silent");
  const auto* audio = reinterpret_cast<const uint8_t*>(wav.data()) + data + silence * stride;
  check(std::equal(original.begin() + start * stride, original.begin() + end * stride, audio),
      "CUE boundary, channel order, integer LSB or float data changed");
  check(wav.size() == data + (silence + end - start) * stride + (((silence + end - start) * stride) & 1),
      "audio outside the segment leaked into WAV");
  FFmpegDecoder restored;
  const std::vector<uint8_t> generated(wav.begin(), wav.end());
  open(restored, generated);
  check(restored.setOutputFormat(format, &error), error);
  const size_t total = silence + end - start;
  std::vector<uint8_t> roundtrip((total + 1) * stride);
  size_t read = 0;
  while (read < total + 1) {
    PcmBlock block{format, roundtrip.data() + read * stride, total + 1 - read, (total + 1 - read) * stride};
    const size_t count = restored.readFrames(block, &error);
    check(error.empty(), error);
    if (!count) break;
    read += count;
  }
  check(read == total && std::memcmp(roundtrip.data(), wav.data() + data, total * stride) == 0,
      "generated WAV did not reopen with identical PCM samples/channel order");
  std::cout << "{\"encoding\":\"" << sampleFormatToString(format.sampleFormat) << "\",\"rate\":" << format.sampleRate
            << ",\"channels\":" << format.channelCount << ",\"sourceFrames\":" << end - start
            << ",\"silenceFrames\":" << silence << ",\"bytesExact\":true}\n";
}
void failures() {
  const AudioFormat format{48000, 2, 16, AudioSampleFormat::Int16Interleaved};
  const auto input = wave(format, pcm(format, 100));
  for (const auto range : {std::pair{-1.0, 1.0}, {1.0, 1.0}, {0.0, 1e30}, {0.0, 0.000001}}) {
    FFmpegDecoder decoder; open(decoder, input);
    std::ostringstream output;
    std::string error;
    check(!writePcmSegment(decoder, range.first, range.second, 0, output, &error) && !error.empty(),
        "invalid/empty/oversized WAV was accepted");
    check(output.str().empty(), "invalid range produced a WAV header");
  }
  FFmpegDecoder decoder; open(decoder, input);
  std::ostringstream output;
  std::string error;
  check(!writePcmSegment(decoder, 0, 0.1, 0, output, &error) && error.find("ended before") != std::string::npos,
      "a truncated source was silently padded or accepted");
  std::cout << "{\"invalidRanges\":4,\"truncatedSourceRejected\":true}\n";
}
void flac() {
  // Encode in memory so the check covers compressed packet boundaries and a short tail,
  // without depending on filesystem fixture permissions or an external audio file.
  const AudioFormat format{44100, 2, 24, AudioSampleFormat::Int24Interleaved};
  constexpr size_t frames = 10013, begin = 1501, finish = frames - 2;
  const auto original = pcm(format, frames);
  const AVCodec* codec = avcodec_find_encoder(AV_CODEC_ID_FLAC);
  check(codec, "FLAC encoder unavailable for segment fixture");
  AVCodecContext* encoder = avcodec_alloc_context3(codec);
  encoder->sample_rate = format.sampleRate;
  encoder->sample_fmt = AV_SAMPLE_FMT_S32;
  encoder->bits_per_raw_sample = 24;
  av_channel_layout_default(&encoder->ch_layout, 2);
  check(avcodec_open2(encoder, codec, nullptr) == 0, "Unable to open FLAC fixture encoder");
  AVFrame* frame = av_frame_alloc();
  frame->format = encoder->sample_fmt; frame->sample_rate = encoder->sample_rate;
  av_channel_layout_copy(&frame->ch_layout, &encoder->ch_layout);
  frame->nb_samples = encoder->frame_size;
  check(av_frame_get_buffer(frame, 0) == 0, "Unable to allocate FLAC fixture frame");
  AVPacket* packet = av_packet_alloc();
  std::vector<uint8_t> encoded{'f', 'L', 'a', 'C', 0x80, 0, 0, 34};
  check(encoder->extradata_size == 34, "Unexpected FLAC STREAMINFO");
  encoded.insert(encoded.end(), encoder->extradata, encoder->extradata + encoder->extradata_size);
  const auto drain = [&] {
    for (;;) {
      const int result = avcodec_receive_packet(encoder, packet);
      if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) break;
      check(result >= 0, "Unable to encode FLAC fixture packet");
      encoded.insert(encoded.end(), packet->data, packet->data + packet->size);
      av_packet_unref(packet);
    }
  };
  for (size_t offset = 0; offset < frames;) {
    frame->nb_samples = std::min<size_t>(encoder->frame_size, frames - offset);
    check(av_frame_make_writable(frame) == 0, "Unable to write FLAC fixture frame");
    auto* samples = reinterpret_cast<int32_t*>(frame->data[0]);
    for (size_t index = 0; index < frame->nb_samples * 2u; ++index) {
      const size_t byte = (offset * 2 + index) * 3;
      const uint32_t value = (uint32_t(original[byte]) << 8) | (uint32_t(original[byte + 1]) << 16) |
          (uint32_t(original[byte + 2]) << 24);
      std::memcpy(samples + index, &value, sizeof(value));
    }
    frame->pts = offset;
    check(avcodec_send_frame(encoder, frame) == 0, "FLAC fixture frame rejected");
    drain(); offset += frame->nb_samples;
  }
  check(avcodec_send_frame(encoder, nullptr) == 0, "Unable to flush FLAC fixture encoder");
  drain();
  av_packet_free(&packet); av_frame_free(&frame); avcodec_free_context(&encoder);
  FFmpegDecoder decoder; open(decoder, encoded);
  std::string error;
  std::ostringstream output(std::ios::binary);
  check(writePcmSegment(decoder, double(begin) / format.sampleRate, double(finish) / format.sampleRate,
      0, output, &error), error);
  const auto result = output.str();
  check(le(result, 40, 4) == (finish - begin) * 6 && result.size() == 44 + (finish - begin) * 6,
      "FLAC segment length changed");
  check(std::equal(original.begin() + begin * 6, original.begin() + finish * 6,
      reinterpret_cast<const uint8_t*>(result.data()) + 44), "FLAC segment samples or 24-bit LSBs changed");
  std::cout << "{\"compressedFlac\":true,\"rate\":44100,\"bits\":24,\"channels\":2,\"sourceFrames\":"
            << finish - begin << ",\"bytesExact\":true}\n";
}
void nativeLayouts() {
  for (const uint32_t mask : {7u, 0xbu, 0x33u, 0x37u, 0x3fu, 0x63fu}) {
    FFmpegDecoder decoder;
    decoder.setInputFactory(layout_fixture::factory(mask, 4096));
    std::string error;
    check(decoder.open("memory-layout://disc.wav", &error), error);
    std::ostringstream output(std::ios::binary);
    constexpr size_t first = 137, last = 3001;
    check(writePcmSegment(decoder, double(first) / 48000, double(last) / 48000, 0, output, &error), error);
    const auto bytes = output.str();
    check(le(bytes, 20, 2) == 0xfffe && le(bytes, 40, 4) == mask, "segment discarded the source speaker mask");
    FFmpegDecoder restored;
    const std::vector<uint8_t> generated(bytes.begin(), bytes.end());
    open(restored, generated);
    check(restored.streamInfo().sourceFormat.channelMask == mask && restored.outputFormat().channelMask == mask,
        "generated segment changed speakers on reopen");
    AudioFormat format = restored.outputFormat(); format.bitDepth = 32;
    format.sampleFormat = AudioSampleFormat::Float32Interleaved;
    check(restored.setOutputFormat(format, &error), error);
    std::vector<float> actual((last - first) * format.channelCount);
    check(restored.readFrames(actual.data(), last - first, &error) == last - first, "segment frame count changed");
    const auto expected = layout_fixture::samples(mask, 4096);
    check(std::equal(actual.begin(), actual.end(), expected.begin() + first * format.channelCount),
        "segment layout roundtrip rematrixed centre, LFE or surround samples");
    std::cout << "{\"nativeSegmentMask\":\"" << channelMaskToString(mask) << "\",\"frames\":" << last - first
              << ",\"samplesExact\":true}\n";
  }
}
}  // namespace
int main() {
  try {
    std::cout << "{\"suite\":\"cast-pcm-segment\",\"ffmpeg\":\"" << av_version_info() << "\"}\n";
    for (const auto sample : {AudioSampleFormat::Int16Interleaved, AudioSampleFormat::Int24Interleaved,
                             AudioSampleFormat::Int32Interleaved, AudioSampleFormat::Float32Interleaved}) {
      for (int rate : {44100, 48000}) for (int channels : {1, 2, 6}) {
        const int bits = sample == AudioSampleFormat::Int16Interleaved ? 16 : sample == AudioSampleFormat::Int24Interleaved ? 24 : 32;
        verify(AudioFormat{rate, channels, bits, sample});
      }
    }
    verify(AudioFormat{768000, 2, 24, AudioSampleFormat::Int24Interleaved});
    failures();
    flac();
    nativeLayouts();
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
