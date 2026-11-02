#include "../dsp/DspWorkspaceProcessors.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstdint>
#include <numbers>
#include <string>
#include <vector>

using namespace twilight::audio;

namespace {
int checks = 0, failures = 0;

void check(bool passed, const char* description) {
  ++checks;
  std::printf("%s %s\n", passed ? "PASS" : "FAIL", description);
  if (!passed) ++failures;
}

bool near(double actual, double expected, double tolerance = 0.1) {
  return std::isfinite(actual) && std::abs(actual - expected) <= tolerance;
}

bool negativeInfinity(double value) {
  return std::isinf(value) && value < 0;
}

void prepare(LoudnessMeterProcessor& meter, int rate, int channels, uint64_t nativeMask = 0) {
  DspConfig config;
  config.enabled = true;
  config.meterEnabled = true;
  AudioFormat format;
  format.sampleRate = rate;
  format.channelCount = channels;
  format.channelMask = nativeMask;
  meter.configure(config);
  meter.prepare(format);
}

// In-memory signal only: no decoder, fixture files, audio output, or device IO.
void feed(LoudnessMeterProcessor& meter, int rate, int channels, int seconds,
          double amplitude, double frequency = 1000.0, unsigned channelMask = 0xff,
          bool irregular = false) {
  constexpr std::array<size_t, 5> chunks{1, 7, 63, 2048, 511};
  std::vector<float> buffer(2048 * static_cast<size_t>(channels));
  const size_t total = static_cast<size_t>(rate) * seconds;
  size_t frame = 0, block = 0;
  while (frame < total) {
    const size_t count = std::min(total - frame, irregular ? chunks[block++ % chunks.size()] : 256);
    for (size_t n = 0; n < count; ++n) {
      const float value = static_cast<float>(amplitude * std::sin(2.0 * std::numbers::pi * frequency * (frame + n) / rate));
      for (int channel = 0; channel < channels; ++channel) {
        buffer[n * channels + channel] = (channelMask & (1U << channel)) ? value : 0.0f;
      }
    }
    const auto before = buffer;
    meter.process(buffer.data(), count);
    if (buffer != before) {
      check(false, "meter leaves PCM samples unchanged");
      return;
    }
    frame += count;
  }
}

// Independent steady-state reference using the published BS.1770 48 kHz
// K-weighting coefficients, not a second call into libebur128.
double referenceLufs48k(double frequency, double amplitude, double channelWeight) {
  const auto z = std::exp(std::complex<double>(0.0, -2.0 * std::numbers::pi * frequency / 48000.0));
  const auto shelf = (1.53512485958697 - 2.69169618940638 * z + 1.19839281085285 * z * z) /
      (1.0 - 1.69065929318241 * z + 0.73248077421585 * z * z);
  const auto highpass = (1.0 - 2.0 * z + z * z) / (1.0 - 1.99004745483398 * z + 0.99007225036621 * z * z);
  return -0.691 + 10.0 * std::log10(amplitude * amplitude * 0.5 * channelWeight * std::norm(shelf * highpass));
}

void printReadings(const char* name, const LoudnessMeterProcessor& meter) {
  std::printf("%s I=%.9f M=%.9f S=%.9f LRA=%.9f\n", name,
      meter.integratedLufs(), meter.momentaryLufs(), meter.shortTermLufs(), meter.loudnessRangeLu());
}

void verifyNativeLayout(const char* name, uint64_t mask, int channels,
                        unsigned soundingChannels, double weight) {
  LoudnessMeterProcessor meter;
  prepare(meter, 48000, channels, mask);
  feed(meter, 48000, channels, 4, 0.1, 1000.0, soundingChannels, true);
  printReadings(name, meter);
  const double expected = weight == 0 ? -INFINITY : referenceLufs48k(1000.0, 0.1, weight);
  const auto correct = [&](double value) {
    return weight == 0 ? negativeInfinity(value) : near(value, expected);
  };
  check(correct(meter.integratedLufs()), (std::string(name) + " native integrated weight").c_str());
  check(correct(meter.momentaryLufs()), (std::string(name) + " native momentary weight").c_str());
  check(correct(meter.shortTermLufs()), (std::string(name) + " native short-term weight").c_str());
  check(near(meter.truePeakDb(), -20.0, 0.02), "LFE exclusion does not exclude it from true peak");
  meter.reset();
  feed(meter, 48000, channels, 4, 0.1, 1000.0, soundingChannels);
  check(correct(meter.integratedLufs()), "reset retains the native channel map");
}
}  // namespace

int main() {
  for (double frequency : {100.0, 1000.0, 10000.0}) {
    for (int channels : {1, 2}) {
      LoudnessMeterProcessor meter;
      prepare(meter, 48000, channels);
      feed(meter, 48000, channels, 4, 0.1, frequency);
      const double expected = referenceLufs48k(frequency, 0.1, channels);
      std::printf("tone frequency=%.0f channels=%d expected=%.9f ", frequency, channels, expected);
      printReadings("measured", meter);
      check(near(meter.integratedLufs(), expected), "integrated K-weighting and channel summation within 0.1 LU");
      check(near(meter.momentaryLufs(), expected), "400 ms momentary window within 0.1 LU");
      check(near(meter.shortTermLufs(), expected), "3 s short-term window within 0.1 LU");
    }
  }

  {
    LoudnessMeterProcessor meter;
    prepare(meter, 48000, 2);
    feed(meter, 48000, 2, 4, 0.0001);
    printReadings("below-absolute-gate", meter);
    check(negativeInfinity(meter.integratedLufs()), "below -70 LUFS absolute gate is unmeasurable, not raw RMS");
  }
  {
    LoudnessMeterProcessor meter;
    prepare(meter, 48000, 2);
    feed(meter, 48000, 2, 8, 0.1);
    const double tone = meter.integratedLufs();
    feed(meter, 48000, 2, 8, 0.0001);
    printReadings("gated-quiet-tail", meter);
    check(near(meter.integratedLufs(), tone, 0.2), "integrated absolute/relative gating excludes quiet tail");
    feed(meter, 48000, 2, 8, 0.0);
    printReadings("silent-windows", meter);
    check(negativeInfinity(meter.momentaryLufs()), "silent momentary window remains negative infinity");
    check(negativeInfinity(meter.shortTermLufs()), "silent short-term window remains negative infinity");
    meter.reset();
    check(negativeInfinity(meter.integratedLufs()) && negativeInfinity(meter.momentaryLufs()) &&
        negativeInfinity(meter.shortTermLufs()), "reset clears all loudness windows");
  }
  {
    LoudnessMeterProcessor meter;
    prepare(meter, 48000, 6);
    feed(meter, 48000, 6, 4, 0.1, 1000.0, 1U << 3);
    printReadings("5.1-LFE-only", meter);
    check(negativeInfinity(meter.integratedLufs()), "conventional 5.1 LFE is excluded from loudness");
    meter.reset();
    feed(meter, 48000, 6, 4, 0.1, 1000.0, 1U << 4);
    printReadings("5.1-surround-only", meter);
    check(near(meter.integratedLufs(), referenceLufs48k(1000.0, 0.1, 1.41)), "conventional 5.1 surround uses 1.41 energy weight");
  }
  for (int rate : {44100, 96000}) {
    LoudnessMeterProcessor regular, split;
    prepare(regular, rate, 2);
    prepare(split, rate, 2);
    feed(regular, rate, 2, 4, 0.1);
    feed(split, rate, 2, 4, 0.1, 1000.0, 0xff, true);
    check(near(split.integratedLufs(), regular.integratedLufs(), 1e-9) &&
        near(split.momentaryLufs(), regular.momentaryLufs(), 1e-9) &&
        near(split.shortTermLufs(), regular.shortTermLufs(), 1e-9), "irregular block sizes preserve loudness windows");
    const double level = regular.integratedLufs();
    regular.reset();
    feed(regular, rate, 2, 4, 0.05);
    check(near(level - regular.integratedLufs(), 20.0 * std::log10(2.0)), "half amplitude changes integrated loudness by 6.0206 LU");
  }
  verifyNativeLayout("2.1-LFE", 0xb, 3, 1U << 2, 0);
  verifyNativeLayout("2.1-front", 0xb, 3, 1U << 0, 1);
  verifyNativeLayout("3.0-centre", 0x7, 3, 1U << 2, 1);
  verifyNativeLayout("quad-surround", 0x33, 4, 1U << 2, 1.41);
  verifyNativeLayout("5.0-surround", 0x37, 5, 1U << 3, 1.41);
  verifyNativeLayout("quad-side", 0x603, 4, 1U << 2, 1.41);
  verifyNativeLayout("5.1-LFE", 0x3f, 6, 1U << 3, 0);
  verifyNativeLayout("5.1-surround", 0x3f, 6, 1U << 4, 1.41);
  verifyNativeLayout("5.1-side", 0x60f, 6, 1U << 4, 1.41);
  verifyNativeLayout("6.0-back-centre", 0x707, 6, 1U << 3, 1);
  verifyNativeLayout("7.1-back-left", 0x63f, 8, 1U << 4, 1);
  verifyNativeLayout("7.1-back-right", 0x63f, 8, 1U << 5, 1);
  verifyNativeLayout("7.1-side-left", 0x63f, 8, 1U << 6, 1.41);
  verifyNativeLayout("7.1-side-right", 0x63f, 8, 1U << 7, 1.41);
  verifyNativeLayout("7.1-all", 0x63f, 8, 0xff, 7.82);
  verifyNativeLayout("7.1-wide", 0xff, 8, 0xff, 7.82);
  verifyNativeLayout("top-front", 0x1003, 3, 1U << 2, 1);
  verifyNativeLayout("top-back", 0x8003, 3, 1U << 2, 1);
  verifyNativeLayout("second-LFE", (uint64_t{1} << 35) | 3, 3, 1U << 2, 0);
  verifyNativeLayout("both-LFEs", (uint64_t{1} << 35) | 0xb, 4, 0xc, 0);
  verifyNativeLayout("7.1-new-side", (uint64_t{1} << 41) | (uint64_t{1} << 42) | 0x3f,
                     8, 0xc0, 2.82);
  verifyNativeLayout("7.1-new-side-rear", (uint64_t{1} << 41) | (uint64_t{1} << 42) | 0x3f,
                     8, 0x30, 2);

  // BS.1770-5 Annex 3: horizontal +/-60, +/-90 and +/-110 have
  // gain 1.41; height, bottom and front positions have gain 1.0.
  // A lone BL/BR follows the conventional 5.x surround role (as does quad).
  for (unsigned bit : {0U, 1U, 2U, 3U, 4U, 5U, 6U, 7U, 8U, 9U, 10U, 11U,
                       12U, 13U, 14U, 15U, 16U, 17U, 29U, 30U, 31U, 32U,
                       33U, 34U, 35U, 36U, 37U, 38U, 39U, 40U, 41U, 42U,
                       43U, 44U, 61U, 62U}) {
    const bool lfe = bit == 3 || bit == 35;
    const bool surround = bit == 4 || bit == 5 || bit == 9 || bit == 10 ||
        bit == 31 || bit == 32 || bit == 33 || bit == 34 || bit == 41 || bit == 42;
    verifyNativeLayout(("speaker-bit-" + std::to_string(bit)).c_str(), uint64_t{1} << bit,
                       1, 1, lfe ? 0 : surround ? 1.41 : 1);
  }
  {
    LoudnessMeterProcessor meter;
    prepare(meter, 48000, 3, 0xb);
    feed(meter, 48000, 3, 4, 0.1, 1000, 4);
    check(negativeInfinity(meter.integratedLufs()), "2.1 layout installed before same-count reprepare");
    prepare(meter, 48000, 3, 0x7);
    feed(meter, 48000, 3, 4, 0.1, 1000, 4);
    check(near(meter.integratedLufs(), referenceLufs48k(1000, 0.1, 1)),
          "same-count 2.1 to 3.0 reprepare replaces LFE with centre");
  }
  {
    LoudnessMeterProcessor meter;
    prepare(meter, 48000, 8);
    feed(meter, 48000, 8, 4, 0.1, 1000, 1U << 6);
    check(negativeInfinity(meter.integratedLufs()), "unspecified eight-channel layout retains old unused index 6");
  }
  std::printf("{\"suite\":\"loudness-layout\",\"checks\":%d,\"failures\":%d}\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
