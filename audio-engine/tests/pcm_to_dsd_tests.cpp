#include "../dsp/PcmToDsdModulator.h"

#include "../core/AudioPipelineDsdUtils.h"

#include <algorithm>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <numeric>
#include <string>
#include <type_traits>
#include <vector>

using namespace twilight::audio;

namespace {

constexpr double kTwoPi = 2.0 * 3.14159265358979323846;

[[noreturn]] void failTest(const char* message) {
  std::fprintf(stderr, "%s\n", message);
  std::abort();
}

std::vector<double> bitsFromMsbBytes(const std::vector<uint8_t>& bytes) {
  std::vector<double> bits;
  bits.reserve(bytes.size() * 8);
  for (uint8_t byte : bytes) {
    for (int bit = 7; bit >= 0; --bit) {
      bits.push_back((byte >> bit) & 1 ? 1.0 : -1.0);
    }
  }
  return bits;
}

// Three cascaded length-R boxcar filters followed by pick-every-R, i.e. a
// CIC^3 decimator. Enough stopband rejection to expose the in-band sine.
std::vector<double> decimateCic3(const std::vector<double>& bits, size_t R) {
  std::vector<double> stage(bits.size(), 0.0);
  std::vector<double> current(bits.begin(), bits.end());
  for (int pass = 0; pass < 2; ++pass) {
    std::vector<double> delay(R, 0.0);
    double sum = 0.0;
    for (size_t n = 0; n < current.size(); ++n) {
      sum += current[n] - delay[n % R];
      delay[n % R] = current[n];
      stage[n] = sum / static_cast<double>(R);
    }
    current = stage;
  }
  std::vector<double> output;
  output.reserve(bits.size() / R + 1);
  std::vector<double> delay(R, 0.0);
  double sum = 0.0;
  for (size_t n = 0; n < current.size(); ++n) {
    sum += current[n] - delay[n % R];
    delay[n % R] = current[n];
    if (n % R == R - 1) output.push_back(sum / static_cast<double>(R));
  }
  return output;
}

// Streaming moving-average cascade followed by pick-every-R. Three stages
// match decimateCic3 exactly; eight reject the seventh-order shaper's stronger
// ultrasonic noise before decimation. Both shapers use that same probe filter.
std::vector<double> decimatePackedCic(const std::vector<uint8_t>& bytes, size_t ratio, size_t stages) {
  std::vector<double> delay(stages * ratio, 0.0), sums(stages, 0.0), output;
  output.reserve(bytes.size() * 8 / ratio);
  size_t position = 0;
  for (uint8_t byte : bytes) {
    for (int bit = 7; bit >= 0; --bit) {
      double value = (byte >> bit) & 1 ? 1.0 : -1.0;
      for (size_t stage = 0; stage < stages; ++stage) {
        double& old = delay[stage * ratio + position];
        sums[stage] += value - old;
        old = value;
        value = sums[stage] / static_cast<double>(ratio);
      }
      if (++position == ratio) {
        output.push_back(value);
        position = 0;
      }
    }
  }
  return output;
}

struct SineFit {
  double amplitude = 0.0;
  double snrDb = 0.0;
};

// Least-squares fit of A*sin + B*cos + C at the target frequency; SNR is the
// fitted sine power against the residual power.
SineFit fitSine(const std::vector<double>& x, double sampleRate, double frequency, size_t skip) {
  const size_t begin = skip;
  const size_t end = x.size() > skip ? x.size() - skip : 0;
  assert(end > begin + 64);

  double m[3][3] = {};
  double r[3] = {};
  for (size_t n = begin; n < end; ++n) {
    const double phase = kTwoPi * frequency * static_cast<double>(n) / sampleRate;
    const double basis[3] = {std::sin(phase), std::cos(phase), 1.0};
    for (int row = 0; row < 3; ++row) {
      for (int col = 0; col < 3; ++col) m[row][col] += basis[row] * basis[col];
      r[row] += x[n] * basis[row];
    }
  }
  for (int col = 0; col < 3; ++col) {
    int pivot = col;
    for (int row = col + 1; row < 3; ++row) {
      if (std::abs(m[row][col]) > std::abs(m[pivot][col])) pivot = row;
    }
    for (int k = 0; k < 3; ++k) std::swap(m[col][k], m[pivot][k]);
    std::swap(r[col], r[pivot]);
    for (int row = 0; row < 3; ++row) {
      if (row == col) continue;
      const double factor = m[row][col] / m[col][col];
      for (int k = col; k < 3; ++k) m[row][k] -= factor * m[col][k];
      r[row] -= factor * r[col];
    }
  }
  const double a = r[0] / m[0][0];
  const double b = r[1] / m[1][1];
  const double c = r[2] / m[2][2];

  double signalPower = 0.0;
  double noisePower = 0.0;
  for (size_t n = begin; n < end; ++n) {
    const double phase = kTwoPi * frequency * static_cast<double>(n) / sampleRate;
    const double fitted = a * std::sin(phase) + b * std::cos(phase) + c;
    signalPower += fitted * fitted;
    const double residual = x[n] - fitted;
    noisePower += residual * residual;
  }

  SineFit fit;
  fit.amplitude = std::hypot(a, b);
  fit.snrDb = 10.0 * std::log10(signalPower / noisePower);
  return fit;
}

double onesDensity(const std::vector<uint8_t>& bytes) {
  size_t ones = 0;
  for (uint8_t byte : bytes) {
    for (int bit = 0; bit < 8; ++bit) ones += (byte >> bit) & 1;
  }
  return static_cast<double>(ones) / (static_cast<double>(bytes.size()) * 8.0);
}

std::vector<uint8_t> runMono(
    PcmToDsdModulator& modulator,
    const std::vector<float>& input,
    size_t blockFrames) {
  std::vector<uint8_t> output(modulator.outputBytesPerChannel(input.size()));
  std::vector<uint8_t> block(modulator.outputBytesPerChannel(blockFrames));
  size_t outOffset = 0;
  size_t frame = 0;
  while (frame < input.size()) {
    const size_t frames = std::min(blockFrames, input.size() - frame);
    uint8_t* channelOutputs[1] = {block.data()};
    const size_t bytes = modulator.process(input.data() + frame, frames, channelOutputs, block.size());
    if (bytes != modulator.outputBytesPerChannel(frames)) {
      failTest("process wrote an unexpected byte count");
    }
    for (size_t i = 0; i < bytes; ++i) output[outOffset + i] = block[i];
    outOffset += bytes;
    frame += frames;
  }
  assert(outOffset == output.size());
  return output;
}

void testSineRecoveryAt44100ToDsd64() {
  PcmToDsdModulator modulator;
  PcmToDsdModulatorConfig config;
  config.inputSampleRate = 44100;
  config.channelCount = 1;
  config.targetDsdRate = 64;
  config.bitOrder = DsdBitOrder::MsbFirst;
  std::string error;
  if (!modulator.configure(config, &error)) failTest(error.c_str());
  assert(modulator.dsdSampleRate() == 2822400);
  assert(modulator.upsampleRatio() == 64);
  assert(modulator.outputSampleFormat() == AudioSampleFormat::DsdInt8Msb1);

  const size_t frames = 32768;
  std::vector<float> input(frames);
  for (size_t n = 0; n < frames; ++n) {
    input[n] = 0.5f * std::sin(kTwoPi * 1000.0 * static_cast<double>(n) / 44100.0);
  }

  const auto dsdBytes = runMono(modulator, input, 512);
  assert(modulator.instabilityResetCount() == 0);

  const auto bits = bitsFromMsbBytes(dsdBytes);
  const auto decimated = decimateCic3(bits, 64);
  assert(decimated == decimatePackedCic(dsdBytes, 64, 3));
  const SineFit fit = fitSine(decimated, 44100.0, 1000.0, 512);

  // 0.5 FS input lands at 0.25 after the fixed -6 dB modulator headroom.
  if (fit.amplitude < 0.20 || fit.amplitude > 0.30) {
    std::fprintf(stderr, "recovered amplitude %.4f\n", fit.amplitude);
    failTest("PCM to DSD sine recovery amplitude out of range");
  }
  if (fit.snrDb < 60.0) {
    std::fprintf(stderr, "recovered SNR %.2f dB\n", fit.snrDb);
    failTest("PCM to DSD sine recovery SNR below 60 dB");
  }
  std::fprintf(stderr, "sine recovery: amplitude %.4f, SNR %.2f dB\n", fit.amplitude, fit.snrDb);
}

void testSeventhOrderNormalInputDoesNotResetTheLoop() {
  for (int rate : {44100, 48000}) for (int target : {64, 128, 256, 512}) {
    PcmToDsdModulator modulator;
    std::string error;
    if (!modulator.configure({rate, 1, target, DsdBitOrder::MsbFirst, 7}, &error)) failTest(error.c_str());
    for (float dc : {-1.0f, 1.0f}) {
      modulator.reset();
      runMono(modulator, std::vector<float>(4096, dc), 256);
      if (modulator.instabilityResetCount() != 0) failTest("Seventh-order modulator reset on full-scale PCM DC");
    }
    modulator.reset();
    std::vector<float> noise(4096);
    uint32_t seed = 1;
    for (auto& sample : noise) {
      seed = seed * 1664525U + 1013904223U;
      sample = static_cast<float>(static_cast<double>(seed) / 2147483648.0 - 1.0);
    }
    runMono(modulator, noise, 256);
    if (modulator.instabilityResetCount() != 0) failTest("Seventh-order modulator reset on bounded PCM noise");
    modulator.reset();
    std::vector<float> tone(8192);
    for (size_t n = 0; n < tone.size(); ++n)
      tone[n] = static_cast<float>(0.5 * std::sin(kTwoPi * 1000.0 * n / rate));
    const auto encoded = runMono(modulator, tone, 257);
    if (modulator.instabilityResetCount() != 0) failTest("Seventh-order modulator reset on normal PCM tone");
    const auto decoded = decimatePackedCic(encoded, modulator.upsampleRatio(), 8);
    const auto fit = fitSine(decoded, rate, 1000.0, 512);
    if (fit.amplitude < 0.20 || fit.amplitude > 0.30 || fit.snrDb < 60.0)
      failTest("Seventh-order PCM to DSD sine recovery failed");
    std::fprintf(stderr, "seventh-order rate=%d target=%d amplitude=%.6f SNR=%.2f dB resets=0\n",
        rate, target, fit.amplitude, fit.snrDb);
  }
}

void testSilenceBitDensityIsBalanced() {
  PcmToDsdModulator modulator;
  PcmToDsdModulatorConfig config;
  config.inputSampleRate = 44100;
  config.channelCount = 2;
  config.targetDsdRate = 64;
  std::string error;
  if (!modulator.configure(config, &error)) failTest(error.c_str());

  const size_t frames = 16384;
  std::vector<float> input(frames * 2, 0.0f);
  std::vector<uint8_t> left(modulator.outputBytesPerChannel(frames));
  std::vector<uint8_t> right(modulator.outputBytesPerChannel(frames));
  uint8_t* channelOutputs[2] = {left.data(), right.data()};
  const size_t bytes = modulator.process(input.data(), frames, channelOutputs, left.size());
  assert(bytes == left.size());

  const double densityLeft = onesDensity(left);
  const double densityRight = onesDensity(right);
  if (std::abs(densityLeft - 0.5) > 0.01 || std::abs(densityRight - 0.5) > 0.01) {
    std::fprintf(stderr, "silence density L=%.4f R=%.4f\n", densityLeft, densityRight);
    failTest("digital silence must idle at ~50% bit density");
  }
}

void testInstabilityGuardRecovers() {
  PcmToDsdModulator modulator;
  PcmToDsdModulatorConfig config;
  config.inputSampleRate = 44100;
  config.channelCount = 1;
  config.targetDsdRate = 64;
  std::string error;
  if (!modulator.configure(config, &error)) failTest(error.c_str());

  // Garbage input: NaN, infinities and absurd magnitudes must be absorbed by
  // the input conditioning without tripping the loop.
  std::vector<float> garbage(4096);
  for (size_t n = 0; n < garbage.size(); ++n) {
    switch (n % 4) {
      case 0:
        garbage[n] = std::numeric_limits<float>::quiet_NaN();
        break;
      case 1:
        garbage[n] = std::numeric_limits<float>::infinity();
        break;
      case 2:
        garbage[n] = -1.0e30f;
        break;
      default:
        garbage[n] = 1.0e30f;
        break;
    }
  }
  const auto garbageBytes = runMono(modulator, garbage, 256);
  assert(garbageBytes.size() == modulator.outputBytesPerChannel(garbage.size()));

  // Force the loop state into an unstable region; the guard must reset the
  // integrators rather than emit unbounded state.
  modulator.injectInstabilityForTest();
  std::vector<float> silence(8192, 0.0f);
  const auto recoveryBytes = runMono(modulator, silence, 512);
  if (modulator.instabilityResetCount() == 0) {
    failTest("instability guard did not engage on forced overload");
  }

  // After recovery the tail must settle back to a balanced idle pattern.
  const size_t tailBytes = recoveryBytes.size() / 2;
  std::vector<uint8_t> tail(recoveryBytes.end() - static_cast<long long>(tailBytes), recoveryBytes.end());
  const double density = onesDensity(tail);
  if (std::abs(density - 0.5) > 0.02) {
    std::fprintf(stderr, "post-recovery density %.4f\n", density);
    failTest("modulator did not recover to balanced idle after overload");
  }
}

void testRateFamilyMapping() {
  struct Case {
    int inputRate;
    int dsdRate;
    int expectedDsdSampleRate;
    int expectedRatio;
  };
  const Case cases[] = {
      {44100, 64, 2822400, 64},
      {44100, 128, 5644800, 128},
      {44100, 256, 11289600, 256},
      {44100, 512, 22579200, 512},
      {88200, 64, 2822400, 32},
      {176400, 128, 5644800, 32},
      {48000, 64, 3072000, 64},
      {96000, 128, 6144000, 64},
      {192000, 256, 12288000, 64},
      {352800, 64, 2822400, 8}};
  for (const Case& c : cases) {
    PcmToDsdModulator modulator;
    PcmToDsdModulatorConfig config;
    config.inputSampleRate = c.inputRate;
    config.channelCount = 2;
    config.targetDsdRate = c.dsdRate;
    std::string error;
    if (!modulator.configure(config, &error)) failTest(error.c_str());
    assert(modulator.dsdSampleRate() == c.expectedDsdSampleRate);
    assert(modulator.upsampleRatio() == c.expectedRatio);
    if (c.expectedRatio >= 64) {
      assert(modulator.halfbandStageCount() == 6);
    }
  }

  // Rejections: off-family rates, unsupported multipliers, ratios below x8.
  const Case rejected[] = {
      {32000, 64, 0, 0},
      {44100, 1024, 0, 0},
      {44100, 32, 0, 0},
      {705600, 64, 0, 0},
      {0, 64, 0, 0}};
  for (const Case& c : rejected) {
    PcmToDsdModulator modulator;
    PcmToDsdModulatorConfig config;
    config.inputSampleRate = c.inputRate;
    config.channelCount = 2;
    config.targetDsdRate = c.dsdRate;
    std::string error;
    assert(!modulator.configure(config, &error));
    assert(!error.empty());
    assert(!modulator.configured());
  }
}

void testBitOrderMatchesEngineConvention() {
  PcmToDsdModulatorConfig config;
  config.inputSampleRate = 44100;
  config.channelCount = 1;
  config.targetDsdRate = 64;

  config.bitOrder = DsdBitOrder::MsbFirst;
  PcmToDsdModulator msb;
  std::string error;
  if (!msb.configure(config, &error)) failTest(error.c_str());
  assert(msb.outputSampleFormat() == AudioSampleFormat::DsdInt8Msb1);

  config.bitOrder = DsdBitOrder::LsbFirst;
  PcmToDsdModulator lsb;
  if (!lsb.configure(config, &error)) failTest(error.c_str());
  assert(lsb.outputSampleFormat() == AudioSampleFormat::DsdInt8Lsb1);

  const size_t frames = 1024;
  std::vector<float> input(frames);
  for (size_t n = 0; n < frames; ++n) {
    input[n] = 0.4f * std::sin(kTwoPi * 3000.0 * static_cast<double>(n) / 44100.0);
  }

  const auto msbBytes = runMono(msb, input, 128);
  const auto lsbBytes = runMono(lsb, input, 128);
  assert(msbBytes.size() == lsbBytes.size());
  // Identical inputs and state: each byte must be the exact bit reversal of
  // its counterpart, matching the engine's render::reverseDsdBits convention.
  for (size_t i = 0; i < msbBytes.size(); ++i) {
    if (render::reverseDsdBits(msbBytes[i]) != lsbBytes[i]) {
      failTest("MSB-first and LSB-first outputs are not bit-reversed counterparts");
    }
  }
}

void testProcessRejectsBadArguments() {
  PcmToDsdModulator modulator;
  std::vector<float> input(64, 0.0f);
  std::vector<uint8_t> output(64);
  uint8_t* channelOutputs[1] = {output.data()};
  // Unconfigured modulator must refuse work.
  assert(modulator.process(input.data(), 8, channelOutputs, output.size()) == 0);

  PcmToDsdModulatorConfig config;
  config.inputSampleRate = 44100;
  config.channelCount = 1;
  config.targetDsdRate = 64;
  std::string error;
  if (!modulator.configure(config, &error)) failTest(error.c_str());

  assert(modulator.process(nullptr, 8, channelOutputs, output.size()) == 0);
  assert(modulator.process(input.data(), 8, nullptr, output.size()) == 0);
  // Capacity too small for 8 frames * 64 bits = 64 bytes.
  assert(modulator.process(input.data(), 8, channelOutputs, 32) == 0);
  uint8_t* nullChannel[1] = {nullptr};
  assert(modulator.process(input.data(), 8, nullChannel, output.size()) == 0);
  assert(modulator.process(input.data(), 0, channelOutputs, output.size()) == 0);
}

template <typename SampleT>
size_t processSamples(PcmToDsdModulator& modulator, const SampleT* input, size_t frames,
    uint8_t* const* outputs, size_t capacity) {
  if constexpr (std::is_same_v<SampleT, double>)
    return modulator.processDouble(input, frames, outputs, capacity);
  else
    return modulator.process(input, frames, outputs, capacity);
}

template <typename SampleT>
void testIndependentChannelsAndGeneratedPacking() {
  size_t configurations = 0;
  // x8/x16/x32/x64 interpolation and residual holds through x8, including
  // paired channels followed by an odd scalar tail. Mono is the scalar oracle.
  for (int rate : {44100, 48000, 192000, 352800}) for (int target : {64, 128, 256, 512})
  for (int channels : {1, 2, 3, 8}) for (auto order : {DsdBitOrder::MsbFirst, DsdBitOrder::LsbFirst})
  for (int loopOrder : {5, 7}) {
    PcmToDsdModulator multi, contiguous;
    PcmToDsdModulatorConfig config{rate, channels, target, order, loopOrder};
    std::string error;
    if (!multi.configure(config, &error)) failTest(error.c_str());
    if (!contiguous.configure(config, &error)) failTest(error.c_str());
    std::vector<PcmToDsdModulator> mono(channels);
    config.channelCount = 1;
    for (auto& modulator : mono) if (!modulator.configure(config, &error)) failTest(error.c_str());

    constexpr size_t totalFrames = 17 + 3 + 64 + 1;
    std::vector<SampleT> input(totalFrames * channels);
    for (size_t f = 0; f < totalFrames; ++f) for (int c = 0; c < channels; ++c) {
      input[f * channels + c] = static_cast<SampleT>(.4 * std::sin(f * .17 + c));
      // Only one channel receives non-finite/clipped inputs; its neighbors
      // must still match their own mono stream.
      if (c == 1) switch (f) {
        case 17: input[f * channels + c] = std::numeric_limits<SampleT>::quiet_NaN(); break;
        case 18: input[f * channels + c] = std::numeric_limits<SampleT>::infinity(); break;
        case 19: input[f * channels + c] = -std::numeric_limits<SampleT>::infinity(); break;
        case 20: input[f * channels + c] = std::numeric_limits<SampleT>::max(); break;
        case 21: input[f * channels + c] = std::numeric_limits<SampleT>::lowest(); break;
      }
    }
    const size_t contiguousBytes = multi.outputBytesPerChannel(totalFrames);
    std::vector<uint8_t> whole(contiguousBytes * channels);
    std::vector<uint8_t*> wholePlanes(channels);
    for (int c = 0; c < channels; ++c) wholePlanes[c] = whole.data() + contiguousBytes * c;
    assert(processSamples(contiguous, input.data(), totalFrames, wholePlanes.data(), contiguousBytes) == contiguousBytes);

    const size_t stride = multi.outputBytesPerChannel(256);
    std::vector<uint8_t> padded(stride * channels, 0xee);
    std::vector<uint8_t*> planes(channels);
    for (int c = 0; c < channels; ++c) planes[c] = padded.data() + stride * c;
    size_t position = 0;
    for (size_t frames : {size_t(17), size_t(3), size_t(64), size_t(1)}) {
      std::fill(padded.begin(), padded.end(), 0xee);
      const SampleT* block = input.data() + position * channels;
      const size_t written = processSamples(multi, block, frames, planes.data(), stride);
      assert(written == multi.outputBytesPerChannel(frames));
      for (int c = 0; c < channels; ++c) {
        std::vector<SampleT> single(frames);
        for (size_t f = 0; f < frames; ++f) single[f] = block[f * channels + c];
        std::vector<uint8_t> expected(written);
        uint8_t* pointer = expected.data();
        assert(processSamples(mono[c], single.data(), frames, &pointer, written) == written);
        if (!std::equal(expected.begin(), expected.end(), planes[c])) failTest("Paired quantizer changed channel bits");
        if (!std::equal(expected.begin(), expected.end(), wholePlanes[c] + multi.outputBytesPerChannel(position)))
          failTest("Fragmented modulation changed channel bits");
        assert(std::all_of(planes[c] + written, planes[c] + stride, [](uint8_t byte) { return byte == 0xee; }));
      }
      for (auto format : {AudioSampleFormat::DsdInt8Msb1, AudioSampleFormat::DsdInt8Lsb1,
                          AudioSampleFormat::DsdInt8Ner8, AudioSampleFormat::Int24Interleaved,
                          AudioSampleFormat::Int24In32Interleaved}) {
        const bool native = isDsdSampleFormat(format);
        const size_t available = native ? written : written / 2;
        const size_t count = std::min<size_t>(available, 3); // partial callback, including odd marker phase
        const size_t sampleBytes = native ? 1 : dop::dopCarrierBytesPerSample(format);
        std::vector<uint8_t> packed(count * channels * sampleBytes + 8, 0xdd);
        assert(render::packGeneratedDsd(planes.data(), written, channels, order, format,
            packed.data(), packed.size() - 8, count, 1) == count);
        for (size_t f = 0; f < count; ++f) for (int c = 0; c < channels; ++c) {
          if (native) assert(packed[f * channels + c] == render::convertDsdByte(planes[c][f], order, format));
          else {
            uint8_t expected[4]{};
            dop::writeDopSample(expected, 0, sampleBytes, dop::normalizeDsdByte(planes[c][2 * f], order),
                dop::normalizeDsdByte(planes[c][2 * f + 1], order), dop::dopMarkerForFrame(1 + f));
            assert(std::equal(expected, expected + sampleBytes, packed.data() + (f * channels + c) * sampleBytes));
          }
        }
        assert(std::all_of(packed.end() - 8, packed.end(), [](uint8_t byte) { return byte == 0xdd; }));
      }
      position += frames;
    }
    // The SIMD and scalar guards both recover independently for odd layouts.
    multi.injectInstabilityForTest();
    std::vector<SampleT> silence(channels);
    const size_t written = processSamples(multi, silence.data(), 1, planes.data(), stride);
    uint64_t expectedResets = 0;
    for (int c = 0; c < channels; ++c) {
      mono[c].injectInstabilityForTest();
      std::vector<uint8_t> expected(written);
      uint8_t* pointer = expected.data();
      assert(processSamples(mono[c], silence.data(), 1, &pointer, written) == written);
      if (!std::equal(expected.begin(), expected.end(), planes[c])) failTest("Paired guard changed recovery bits");
      expectedResets += mono[c].instabilityResetCount();
    }
    assert(multi.instabilityResetCount() >= static_cast<uint64_t>(channels));
    assert(multi.instabilityResetCount() == expectedResets);
    multi.reset();
    assert(multi.instabilityResetCount() == 0);
    ++configurations;
  }
  std::fprintf(stderr, "independent %s channels/packing: %zu configurations passed\n",
      std::is_same_v<SampleT, double> ? "float64" : "float32", configurations);
}

// Opt-in compute probe, not a timing gate. The same executable cross-compiles
// for Android; no output device, JNI, decoder or USB transfer is opened here.
void probePcmToDsd() {
  using Clock = std::chrono::steady_clock;
#if defined(__aarch64__)
  constexpr const char* architecture = "arm64";
#elif defined(__arm__)
  constexpr const char* architecture = "arm32";
#elif defined(__x86_64__) || defined(_M_X64)
  constexpr const char* architecture = "x86_64";
#else
  constexpr const char* architecture = "other";
#endif
  constexpr size_t frames = 256;
  constexpr int channels = 2;
  for (int rate : {44100, 48000}) for (int target : {64, 128, 256, 512}) for (int order : {5, 7}) {
    PcmToDsdModulator modulator;
    PcmToDsdModulatorConfig config{rate, channels, target, DsdBitOrder::MsbFirst, order};
    std::string error;
    if (!modulator.configure(config, &error)) failTest(error.c_str());
    const size_t bytes = modulator.outputBytesPerChannel(frames);
    std::vector<uint8_t> planar(bytes * channels), packed(bytes * channels * 2);
    uint8_t* planes[channels] = {planar.data(), planar.data() + bytes};
    std::vector<float> input(frames * channels);
    for (size_t n = 0; n < frames; ++n) {
      input[n * channels] = static_cast<float>(0.5 * std::sin(kTwoPi * 1000.0 * n / rate));
      input[n * channels + 1] = static_cast<float>(0.3 * std::sin(kTwoPi * 3000.0 * n / rate));
    }
    for (bool dop : {false, true}) {
      modulator.reset();
      const auto format = dop ? AudioSampleFormat::Int24In32Interleaved : AudioSampleFormat::DsdInt8Msb1;
      const size_t outputFrames = dop ? bytes / 2 : bytes;
      const size_t outputBytes = outputFrames * channels * (dop ? 4 : 1);
      const size_t blocks = (static_cast<size_t>(rate) + frames * 4 - 1) / (frames * 4);
      std::vector<double> milliseconds;
      milliseconds.reserve(blocks);
      size_t marker = 0;
      unsigned outputSum = 0;
      const auto renderBlock = [&] {
        if (modulator.process(input.data(), frames, planes, bytes) != bytes)
          failTest("Probe modulation wrote an unexpected byte count");
        if (render::packGeneratedDsd(planes, bytes, channels, DsdBitOrder::MsbFirst, format,
            packed.data(), outputBytes, outputFrames, marker) != outputFrames)
          failTest("Probe packing wrote an unexpected frame count");
        marker += outputFrames;
      };
      for (int warm = 0; warm < 4; ++warm) renderBlock();
      modulator.reset();
      marker = 0;
      for (size_t block = 0; block < blocks; ++block) {
        const auto start = Clock::now();
        renderBlock();
        const auto end = Clock::now();
        milliseconds.push_back(std::chrono::duration<double, std::milli>(end - start).count());
        outputSum += packed[(block * 131) % outputBytes];
      }
      const double totalMs = std::accumulate(milliseconds.begin(), milliseconds.end(), 0.0);
      std::sort(milliseconds.begin(), milliseconds.end());
      const double deadlineMs = frames * 1000.0 / rate;
      const size_t p95 = (blocks * 95 + 99) / 100 - 1;
      std::printf("{\"kind\":\"compute\",\"architecture\":\"%s\",\"inputSampleRate\":%d,"
          "\"channels\":%d,\"targetDsdRate\":%d,\"dsdBitClockHz\":%d,\"order\":%d,"
          "\"transport\":\"%s\",\"blockFrames\":%zu,\"blocks\":%zu,\"audioSeconds\":%.9g,"
          "\"meanBlockMs\":%.9g,\"p95BlockMs\":%.9g,\"maxBlockMs\":%.9g,"
          "\"deadlineMs\":%.9g,\"computeRealTimeRatio\":%.9g,\"instabilityResets\":%llu,\"outputSum\":%u}\n",
          architecture, rate, channels, target, modulator.dsdSampleRate(), order, dop ? "dop24in32" : "native-byte",
          frames, blocks, static_cast<double>(blocks * frames) / rate, totalMs / blocks,
          milliseconds[p95], milliseconds.back(), deadlineMs, totalMs / (blocks * deadlineMs),
          static_cast<unsigned long long>(modulator.instabilityResetCount()), outputSum);
    }
    config.channelCount = 1;
    if (!modulator.configure(config, &error)) failTest(error.c_str());
    constexpr size_t qualityFrames = 8192;
    for (double frequency : {1000.0, 10000.0, 20000.0}) {
      std::vector<float> tone(qualityFrames);
      for (size_t n = 0; n < tone.size(); ++n)
        tone[n] = static_cast<float>(0.5 * std::sin(kTwoPi * frequency * n / rate));
      modulator.reset();
      const auto encoded = runMono(modulator, tone, frames);
      const auto decoded = decimatePackedCic(encoded, modulator.upsampleRatio(), 8);
      const auto fit = fitSine(decoded, rate, frequency, 512);
      const double ratio = modulator.upsampleRatio();
      const double angle = kTwoPi * 0.5 * frequency / rate;
      const double reference = 0.25 * std::pow(std::sin(angle) / (ratio * std::sin(angle / ratio)), 8);
      std::printf("{\"kind\":\"cic8-recovery\",\"architecture\":\"%s\",\"inputSampleRate\":%d,"
          "\"targetDsdRate\":%d,\"order\":%d,\"toneHz\":%.0f,\"inputPeak\":0.5,\"headroomScale\":0.5,"
          "\"frames\":%zu,\"skipEachEnd\":512,\"amplitude\":%.9g,\"cicCorrectedGainDb\":%.9g,"
          "\"residualSnrDb\":%.9g,\"instabilityResets\":%llu}\n", architecture, rate, target, order,
          frequency, qualityFrames, fit.amplitude, 20.0 * std::log10(fit.amplitude / reference), fit.snrDb,
          static_cast<unsigned long long>(modulator.instabilityResetCount()));
    }
  }
}

}  // namespace

int main(int argc, char** argv) {
  if (argc == 2 && std::strcmp(argv[1], "--probe") == 0) {
    probePcmToDsd();
    return 0;
  }
  testRateFamilyMapping();
  testProcessRejectsBadArguments();
  testIndependentChannelsAndGeneratedPacking<float>();
  testIndependentChannelsAndGeneratedPacking<double>();
  testSilenceBitDensityIsBalanced();
  testBitOrderMatchesEngineConvention();
  testInstabilityGuardRecovers();
  testSineRecoveryAt44100ToDsd64();
  testSeventhOrderNormalInputDoesNotResetTheLoop();
  return 0;
}
