#include "../decoder/FFmpegDecoder.h"
#include "../dsp/DspWorkspaceProcessors.h"
#include "../output/android/AndroidChannelLayout.h"
#include "ChannelLayoutFixture.h"

extern "C" {
#include <libavutil/channel_layout.h>
}

#include <algorithm>
#include <bit>
#include <cmath>
#include <iostream>
#include <string>
#include <vector>

using namespace twilight::audio;
namespace {
int checks = 0, failures = 0;
void check(bool value, const std::string& message) {
  ++checks;
  if (!value) { ++failures; std::cerr << "FAIL: " << message << '\n'; }
}

void verifyDecodedLayout(uint32_t mask) {
  constexpr size_t frames = 4096;
  FFmpegDecoder decoder;
  decoder.setInputFactory(layout_fixture::factory(mask, frames));
  std::string error;
  if (!decoder.open("memory-layout://source.wav", &error)) {
    check(false, "open: " + error); return;
  }
  AudioFormat format = decoder.outputFormat();
  check(decoder.streamInfo().sourceFormat.channelMask == mask, "source mask: " + channelMaskToString(mask));
  check(format.channelMask == mask, "default decoded mask: " + channelMaskToString(mask));
  format.bitDepth = 32;
  format.sampleFormat = AudioSampleFormat::Float32Interleaved;
  check(decoder.setOutputFormat(format, &error), "set Float32 output: " + error);
  std::vector<float> actual(frames * format.channelCount);
  const size_t read = decoder.readFrames(actual.data(), frames, &error);
  check(read == frames && error.empty(), "decode complete: " + error);
  const auto expected = layout_fixture::samples(mask, frames);
  check(actual == expected, "default decode preserves speaker samples, mask=" + std::to_string(mask));
  if ((mask & 8) == 0 && std::popcount(mask) >= 3) {
    DspConfig config;
    config.enabled = config.bassManagementEnabled = true;
    BassManagementProcessor bass;
    bass.configure(config); bass.prepare(decoder.outputFormat());
    const auto before = actual;
    bass.process(actual.data(), frames);
    check(!bass.isActive(), "known no-LFE layout bypasses bass management, mask=" + std::to_string(mask));
    check(actual == before, "no-LFE main/centre samples unchanged, mask=" + std::to_string(mask));
  }
  std::cout << "{\"case\":\"decode\",\"mask\":\"" << channelMaskToString(mask)
            << "\",\"channels\":" << format.channelCount << ",\"frames\":" << read << "}\n";
}

void verifyBassTarget(uint32_t mask) {
  constexpr size_t frames = 8192;
  const int channels = std::popcount(mask), lfe = std::popcount(mask & 7);
  AudioFormat format{48000, channels, 32}; format.channelMask = mask;
  DspConfig config;
  config.enabled = config.bassManagementEnabled = true;
  config.bassRedirectLfe = false;
  config.bassLfeGainDb = 6;
  BassManagementProcessor bass;
  bass.configure(config); bass.prepare(format);
  check(bass.isActive() && bass.lfeChannelIndex() == lfe && !bass.usesLegacyChannelLayout(),
      "native LFE index: " + channelMaskToString(mask));
  std::vector<float> actual(frames * channels, 0);
  for (size_t f = 0; f < frames; ++f) actual[f * channels + lfe] = float(layout_fixture::sample(f, lfe)) / 32768;
  const auto before = actual;
  bass.process(actual.data(), frames);
  check(actual == before, "redirect disabled preserves original LFE exactly: " + channelMaskToString(mask));
  config.bassRedirectLfe = true;
  bass.configure(config);
  for (size_t f = 0; f < frames; ++f)
    for (int ch = 0; ch < channels; ++ch) actual[f * channels + ch] = ch == lfe ? .003f : .0005f;
  // Exercise block boundaries as well as the steady-state DC routing sum.
  bass.process(actual.data(), 137);
  bass.process(actual.data() + 137 * channels, frames - 137);
  const double expectedLfe = (.003 + (channels - 1) * .0005) * std::pow(10.0, 6.0 / 20);
  check(std::abs(actual[(frames - 1) * channels + lfe] - expectedLfe) < 2e-7,
      "all main bass reaches the actual LFE: " + channelMaskToString(mask));
  double mainPeak = 0;
  for (int ch = 0; ch < channels; ++ch)
    if (ch != lfe) mainPeak = std::max(mainPeak, std::abs(double(actual[(frames - 1) * channels + ch])));
  check(mainPeak < 1e-7, "mains high-passed, not mistaken for LFE: " + channelMaskToString(mask));
}

void verifyConverterRequests() {
  FFmpegDecoder decoder;
  decoder.setInputFactory(layout_fixture::factory(0xb, 4096));
  std::string error;
  check(decoder.open("memory-layout://2.1.wav", &error), "open converter fixture: " + error);
  AudioFormat format{48000, 3, 32}; format.channelMask = 0xb;
  check(decoder.setOutputFormat(format, &error), "native Float32 target");
  std::vector<float> prefix(137 * 3);
  check(decoder.readFrames(prefix.data(), 137, &error) == 137, "read prefix before rejected request");
  AudioFormat invalid = format; invalid.channelMask = 3;
  check(!decoder.setOutputFormat(invalid, &error) && !error.empty(), "reject mask/count disagreement");
  check(decoder.outputFormat().channelMask == 0xb && decoder.streamInfo().decodedFormat.channelMask == 0xb,
      "rejected request retains accepted converter facts");
  error.clear();
  std::vector<float> rest((4096 - 137) * 3);
  check(decoder.readFrames(rest.data(), 4096 - 137, &error) == 4096 - 137 && error.empty(),
      "rejected request retains buffered audio and position");
  const auto expected = layout_fixture::samples(0xb, 4096);
  check(std::equal(prefix.begin(), prefix.end(), expected.begin()) &&
      std::equal(rest.begin(), rest.end(), expected.begin() + prefix.size()), "converter transaction samples unchanged");

  // An explicit target with the same count is a real rematrix request, not an alias.
  format.channelMask = 7;
  check(decoder.setOutputFormat(format, &error) && decoder.seek(0, &error), "request 2.1 -> 3.0");
  std::vector<float> converted(4096 * 3);
  check(decoder.readFrames(converted.data(), 4096, &error) == 4096, "read rematrix output");
  bool correct = true;
  for (size_t f = 0; f < 4096; ++f)
    correct &= converted[f * 3] == expected[f * 3] && converted[f * 3 + 1] == expected[f * 3 + 1] && converted[f * 3 + 2] == 0;
  check(correct && decoder.outputFormat().channelMask == 7, "2.1 LFE is not relabelled as 3.0 centre");

  // Count-only requests still ask FFmpeg for its default layout, as before.
  format.channelMask = 0;
  AVChannelLayout defaults{}; av_channel_layout_default(&defaults, format.channelCount);
  check(decoder.setOutputFormat(format, &error) && decoder.outputFormat().channelMask == defaults.u.mask,
      "count-only output retains FFmpeg default-layout contract");
  av_channel_layout_uninit(&defaults);
}

void verifyCompatibility() {
  AudioFormat left{48000, 3, 24, AudioSampleFormat::Int24Interleaved}; left.channelMask = 7;
  AudioFormat right = left; right.channelMask = 0xb;
  check(!pcmFormatsExactMatch(left, right), "equal count does not mean equal native speakers");
  right.sampleFormat = AudioSampleFormat::Int24In32Interleaved;
  check(!pcmFormatsSemanticallyMatch(left, right), "24-bit container compatibility includes speakers");
  right.sampleFormat = AudioSampleFormat::Int32Interleaved; right.bitDepth = 32;
  check(!pcmFormatsPreserveSource(left, right), "integer widening includes speakers");
  PerfectEvaluation evaluation;
  evaluation.sourceFormat = evaluation.decodedFormat = left;
  evaluation.outputFormat = left; evaluation.outputFormat.channelMask = 0xb;
  evaluation.sourceLossless = evaluation.supportsOutputPerfect = evaluation.pcmPassthrough = true;
  const auto mismatch = evaluatePerfect(evaluation);
  check(!mismatch.outputPerfect && !mismatch.sourceExact && mismatch.resampled, "known layout conversion is not bit-perfect");
  right.channelMask = 0;
  check(pcmFormatsPreserveSource(left, right), "unknown old output retains integer-widening use");
  right = left; right.channelMask = 0;
  check(pcmFormatsExactMatch(left, right) && pcmFormatsExactMatch(right, left), "old count-only matching stays usable");
  right = left;
  check(pcmFormatsExactMatch(left, right), "same known layout exact match");
  check(channelMaskToString(uint64_t{1} << 55) == "0x80000000000000", "64-bit masks have lossless JSON string representation");

  for (int channels : {3, 4, 5, 6, 7, 8}) {
    BassManagementProcessor bass;
    DspConfig config; config.enabled = config.bassManagementEnabled = true;
    bass.configure(config); bass.prepare(AudioFormat{48000, channels, 32});
    check(bass.isActive() && bass.usesLegacyChannelLayout() && bass.lfeChannelIndex() == (channels >= 6 ? 3 : channels - 1),
        "count-only bass target retains original convention");
  }
}

void verifyAndroidMapping() {
  for (uint32_t mask : {3u, 7u, 0xbu, 0x33u, 0x37u, 0x3fu, 0x60fu, 0x63fu}) {
    AudioFormat format{48000, std::popcount(mask), 32}; format.channelMask = mask;
    check(androidOutputChannelMask(format) == mask && nativeOutputChannelMask(mask, format.channelCount) == mask,
        "AAudio native-speaker mapping: " + channelMaskToString(mask));
  }
  AudioFormat mono{48000, 1, 32}; mono.channelMask = 4;
  check(androidOutputChannelMask(mono) == 1 && nativeOutputChannelMask(1, 1) == 4, "Android MONO normalizes to native mono");
  check(nativeOutputChannelMask(0, 2) == 0 && nativeOutputChannelMask(0x80000003, 2) == 0 &&
      nativeOutputChannelMask(0xc0003, 4) == 0, "unreported/indexed/non-native Android layout stays unspecified");
}
}  // namespace

int main() {
  for (const uint32_t mask : {4u, 3u, 0x7u, 0xbu, 0xfu, 0x33u, 0x3bu, 0x37u, 0x607u, 0x3fu, 0x60fu,
                             0x707u, 0x70fu, 0x637u, 0x63fu}) {
    verifyDecodedLayout(mask);
    if ((mask & 8) != 0) verifyBassTarget(mask);
  }
  verifyConverterRequests(); verifyCompatibility(); verifyAndroidMapping();
  std::cout << "{\"suite\":\"channel-layout\",\"checks\":" << checks << ",\"failures\":" << failures << "}\n";
  return failures == 0 ? 0 : 1;
}
