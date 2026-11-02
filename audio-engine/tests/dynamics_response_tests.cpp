#include "../dsp/DspWorkspaceProcessors.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdio>
#include <numbers>
#include <vector>

using namespace twilight::audio;

namespace {
int checks = 0, failures = 0;
constexpr double pi = std::numbers::pi;
double linear(double db) { return std::pow(10.0, db / 20.0); }
void check(bool pass, const char* name) {
  ++checks;
  if (!pass) ++failures;
  std::printf("%s %s\n", pass ? "PASS" : "FAIL", name);
}
AudioFormat format(int rate, int channels = 2) {
  AudioFormat out; out.sampleRate = rate; out.channelCount = channels; return out;
}

void process(IAudioProcessor& processor, std::vector<float>& samples, int channels, bool split = false) {
  const size_t frames = samples.size() / channels;
  if (!split) { processor.process(samples.data(), frames); return; }
  const size_t blocks[] = {1, 127, 19, 256, 7};
  for (size_t offset = 0, block = 0; offset < frames; ++block) {
    const size_t count = std::min(blocks[block % 5], frames - offset);
    processor.process(samples.data() + offset * channels, count); offset += count;
  }
}

std::vector<float> sine(int rate, double hz, double amplitude, int channels = 2) {
  std::vector<float> out(static_cast<size_t>(rate) * 2 * channels);
  for (size_t frame = 0; frame < out.size() / channels; ++frame)
    for (int channel = 0; channel < channels; ++channel)
      out[frame * channels + channel] = static_cast<float>(amplitude * std::sin(2 * pi * hz * frame / rate));
  return out;
}

// Complex sine fit, after 1.5 seconds of settling. Integer-Hz frequencies over
// the final half-second contain complete cycles for this measurement series.
std::complex<double> response(const std::vector<float>& samples, int rate, double hz,
                              double amplitude, int channels = 2, int channel = 0) {
  std::complex<double> sum{};
  const size_t frames = samples.size() / channels, first = frames - rate / 2;
  for (size_t frame = first; frame < frames; ++frame) {
    const double phase = 2 * pi * hz * frame / rate;
    sum += static_cast<double>(samples[frame * channels + channel]) *
           std::complex<double>(std::sin(phase), std::cos(phase));
  }
  return sum * (2.0 / ((frames - first) * amplitude));
}

void staticCompressor() {
  for (int rate : {44100, 48000, 96000}) for (double ratio : {1.0, 2.0, 4.0, 20.0})
    for (double inputDb : {-40.0, -24.0, -6.0}) {
      DspConfig config; config.enabled = config.compressorEnabled = true;
      config.compressorThresholdDb = -24; config.compressorRatio = ratio;
      config.compressorAttackMs = 5; config.compressorReleaseMs = 60; config.compressorMakeupDb = 3;
      DynamicsProcessor compressor(DynamicsMode::Compressor);
      compressor.configure(config); compressor.prepare(format(rate));
      std::vector<float> samples(rate * 2 * 2);
      const float amplitude = static_cast<float>(linear(inputDb));
      for (size_t i = 0; i < samples.size(); i += 2) { samples[i] = amplitude; samples[i + 1] = -amplitude * 0.25f; }
      process(compressor, samples, 2, true);
      const double actualInput = 20 * std::log10(amplitude);
      const double expected = std::min(actualInput, -24 + (actualInput + 24) / ratio) + 3;
      const double measured = 20 * std::log10(samples[samples.size() - 2]);
      std::printf("compressor rate=%d inputDb=%.9f ratio=%.1f expectedDb=%.9f measuredDb=%.9f\n",
                  rate, actualInput, ratio, expected, measured);
      check(std::abs(measured - expected) < 0.00001 && samples.back() == -samples[samples.size() - 2] * 0.25f,
            "hard-knee steady curve, makeup and stereo linking");
    }
}

void dynamicsTime() {
  // Closed-form exponential detector for three DC plateaus; the output gain
  // is the convolution of its target with the documented one-pole smoother.
  // This reference has no production processor state or coefficient helpers.
  for (int rate : {44100, 48000, 96000}) for (auto mode : {DynamicsMode::Gate, DynamicsMode::Compressor}) {
    DspConfig config; config.enabled = config.gateEnabled = config.compressorEnabled = true;
    config.gateAttackMs = config.compressorAttackMs = 8;
    config.gateReleaseMs = config.compressorReleaseMs = 40;
    config.gateThresholdDb = -30; config.compressorThresholdDb = -24;
    config.compressorRatio = 4; config.compressorMakeupDb = 3;
    const size_t plateau = rate / 2;
    const int channels = 8;
    std::vector<float> input(plateau * 3 * channels), reference(input.size());
    double envelope = 0, gain = 1;
    for (size_t segment = 0; segment < 3; ++segment) {
      const float amplitude = segment == 1 ? 0.5f : 0.002f;
      const double initial = envelope;
      const double tau = initial < amplitude ? 0.008 : 0.040;
      for (size_t n = 0; n < plateau; ++n) {
        envelope = amplitude + (initial - amplitude) * std::exp(-(n + 1.0) / (tau * rate));
        const double target = mode == DynamicsMode::Gate ? (envelope >= linear(-30) ? 1 : 0) :
            linear(3) * std::min(1.0, std::pow(envelope / linear(-24), 1.0 / 4 - 1));
        const bool attack = mode == DynamicsMode::Gate ? target > gain : target < gain;
        const double retain = std::exp(-1.0 / ((attack ? 0.008 : 0.040) * rate));
        gain = target + (gain - target) * retain;
        for (int channel = 0; channel < channels; ++channel) {
          const size_t index = (segment * plateau + n) * channels + channel;
          input[index] = std::ldexp(amplitude, -channel) * (channel % 2 ? -1 : 1);
          reference[index] = static_cast<float>(input[index] * gain);
        }
      }
    }
    DynamicsProcessor whole(mode), blocks(mode);
    for (auto* processor : {&whole, &blocks}) { processor->configure(config); processor->prepare(format(rate, channels)); }
    auto output = input, split = input;
    process(whole, output, channels); process(blocks, split, channels, true);
    double error = 0;
    for (size_t i = 0; i < output.size(); ++i) error = std::max(error, std::abs(double(output[i]) - reference[i]));
    std::printf("dynamics-time rate=%d gate=%d maxSampleError=%.12g\n", rate, mode == DynamicsMode::Gate, error);
    check(std::all_of(output.begin(), output.end(), [](float value) { return std::isfinite(value); }) && error < 3e-7,
          "DC attack/release matches analytic detector and gain response");
    check(output == split, "dynamics is block-size invariant across eight linked channels");
    blocks.reset(); split = input; process(blocks, split, channels, true);
    check(output == split, "dynamics reset restores the documented startup state");
    config.enabled = false; blocks.configure(config); split = input; process(blocks, split, channels);
    check(input == split, "disabled dynamics is an exact bypass");
  }
}

struct Crossover { std::complex<double> low, high, allpass; };
Crossover crossover(int rate, double cutoff, double hz) {
  // Bilinear transform of two cascaded Butterworth sections (LR4).
  const std::complex<double> s(0, std::tan(pi * hz / rate));
  const double k = std::tan(pi * cutoff / rate);
  const auto denominator = s * s + std::sqrt(2.0) * k * s + k * k;
  const auto low = std::pow(k * k / denominator, 2), high = std::pow(s * s / denominator, 2);
  return {low, high, low + high};
}

std::complex<double> bandTransfer(int rate, const std::vector<double>& cutoffs, size_t band, double hz) {
  std::complex<double> transfer(1, 0);
  for (size_t split = 0; split < cutoffs.size(); ++split) {
    const auto filters = crossover(rate, cutoffs[split], hz);
    transfer *= split < band ? filters.high : split == band ? filters.low : filters.allpass;
  }
  return transfer;
}

DspConfig multibandConfig(int bands) {
  DspConfig config; config.enabled = config.multibandCompressorEnabled = true;
  config.multibandCrossoversHz = bands == 2 ? std::vector<double>{200} :
      bands == 3 ? std::vector<double>{200, 2000} : std::vector<double>{200, 1000, 5000};
  config.multibandCompressorBands.resize(bands);
  for (auto& band : config.multibandCompressorBands) { band.ratio = 1; band.attackMs = 5; band.releaseMs = 40; }
  return config;
}

void multibandResponse() {
  for (int rate : {44100, 48000, 96000}) for (int bands : {2, 3, 4}) {
    const auto config = multibandConfig(bands);
    for (double hz : {50., 100., 200., 400., 700., 1000., 2000., 4000., 5000., 10000., 18000.}) {
      MultibandCompressorProcessor processor;
      processor.configure(config); processor.prepare(format(rate));
      auto samples = sine(rate, hz, 0.25); process(processor, samples, 2, true);
      const auto measured = response(samples, rate, hz, 0.25);
      std::complex<double> expected{};
      for (int band = 0; band < bands; ++band) expected += bandTransfer(rate, config.multibandCrossoversHz, band, hz);
      const double db = 20 * std::log10(std::abs(measured));
      std::printf("multiband-flat rate=%d bands=%d frequency=%.0f expectedDb=0 measuredDb=%.9f complexError=%.9g\n",
                  rate, bands, hz, db, std::abs(measured - expected));
      check(std::abs(db) < 0.01 && std::abs(measured - expected) < 0.0002,
            "unity compression recombines LR4 bands with flat magnitude and matched phase");
    }
  }
  for (int bands : {2, 3, 4}) {
    auto config = multibandConfig(bands);
    config.multibandCompressorBands[0].makeupDb = -3;
    config.multibandCompressorBands[1].enabled = false;
    config.multibandCompressorBands[1].makeupDb = 12;
    config.multibandCompressorBands.back().makeupDb = 6;
    for (double hz : {100., 1000., 6000.}) {
      MultibandCompressorProcessor processor;
      processor.configure(config); processor.prepare(format(48000));
      auto input = sine(48000, hz, 0.1), output = input;
      process(processor, output, 2);
      const auto measured = response(output, 48000, hz, 0.1);
      std::complex<double> expected{};
      for (int band = 0; band < bands; ++band) expected += bandTransfer(48000, config.multibandCrossoversHz, band, hz) *
          (config.multibandCompressorBands[band].enabled ? linear(config.multibandCompressorBands[band].makeupDb) : 1);
      check(std::abs(measured - expected) < 0.0002, "band makeup and disabled-band unity preserve the intended complex crossover response");
      processor.reset(); auto split = input; process(processor, split, 2, true);
      check(output == split, "multiband reset and irregular blocks preserve every sample");
    }
    config = multibandConfig(bands);
    for (auto& band : config.multibandCompressorBands) { band.thresholdDb = -24; band.ratio = 4; band.makeupDb = 3; }
    MultibandCompressorProcessor processor;
    processor.configure(config); processor.prepare(format(48000));
    std::vector<float> dc(48000 * 3 * 2, 0.5f); process(processor, dc, 2);
    const double expected = -24 + (20 * std::log10(0.5) + 24) / 4 + 3;
    check(std::abs(20 * std::log10(dc.back()) - expected) < 0.0001, "lowest band DC compression has the hard-knee ratio and makeup");
  }
  {
    auto config = multibandConfig(4);
    config.multibandCrossoversHz = {900, 1000, 1100};
    for (double hz : {500., 900., 1000., 1100., 2000.}) {
      MultibandCompressorProcessor processor; processor.configure(config); processor.prepare(format(48000));
      auto samples = sine(48000, hz, 0.25); process(processor, samples, 2, true);
      const auto measured = response(samples, 48000, hz, 0.25);
      std::complex<double> expected{};
      for (int band = 0; band < 4; ++band) expected += bandTransfer(48000, config.multibandCrossoversHz, band, hz);
      std::printf("multiband-close frequency=%.0f measuredDb=%.9f complexError=%.9g\n",
                  hz, 20 * std::log10(std::abs(measured)), std::abs(measured - expected));
      check(std::abs(measured - expected) < 0.0002, "closely spaced crossovers retain matched phase and unity magnitude");
    }
    config = multibandConfig(4);
    for (auto& band : config.multibandCompressorBands) { band.thresholdDb = -30; band.ratio = 4; }
    MultibandCompressorProcessor processor; processor.configure(config); processor.prepare(format(48000, 8));
    std::vector<float> input(8192 * 8);
    for (size_t frame = 0; frame < 8192; ++frame) for (int channel = 0; channel < 8; ++channel) {
      const float value = static_cast<float>(0.25 * std::sin(2 * pi * frame / 48) + 0.12 * std::sin(2 * pi * frame / 8));
      input[frame * 8 + channel] = std::ldexp(value, -channel) * (channel % 2 ? -1 : 1);
    }
    auto output = input; process(processor, output, 8);
    bool linked = true;
    for (size_t frame = 0; frame < 8192; ++frame) for (int channel = 1; channel < 8; ++channel)
      linked &= output[frame * 8 + channel] == std::ldexp(output[frame * 8], -channel) * (channel % 2 ? -1 : 1);
    check(processor.isActive() && linked && output != input, "four-band compression preserves gain linking and polarity across eight channels");
    processor.reset(); auto split = input; process(processor, split, 8, true);
    check(output == split, "reset clears every phase-correction and crossover history across eight channels");
    for (auto& band : config.multibandCompressorBands) band.enabled = false;
    processor.configure(config); output = input; process(processor, output, 8);
    check(!processor.isActive() && input == output, "all disabled bands keep the original exact-bypass contract");
  }
}

void dynamicEqResponse() {
  for (int rate : {44100, 48000, 96000}) for (double range : {-6., 6.}) {
    DspConfig config; config.enabled = config.dynamicEqEnabled = true;
    DspDynamicEqBand band; band.frequency = 1000; band.gainDb = 3; band.q = 4;
    band.thresholdDb = -60; band.ratio = 4; band.rangeDb = range; band.attackMs = 5; band.releaseMs = 80;
    band.channelMask = 1; config.dynamicEqBands = {band};
    DynamicEqProcessor processor;
    processor.configure(config); processor.prepare(format(rate));
    auto input = sine(rate, 1000, 0.2), output = input;
    process(processor, output, 2);
    const double measured = 20 * std::log10(std::abs(response(output, rate, 1000, 0.2)));
    std::printf("dynamic-eq rate=%d rangeDb=%.0f expectedDb=%.9f measuredDb=%.9f\n", rate, range, 3 + range, measured);
    check(std::abs(measured - (3 + range)) < 0.01, "dynamic peak EQ reaches cut/boost range plus static gain at its centre");
    bool untouched = true; for (size_t i = 1; i < input.size(); i += 2) untouched &= input[i] == output[i];
    check(untouched, "dynamic EQ channel mask leaves the excluded channel bit-exact");
    processor.reset(); auto split = input; process(processor, split, 2, true);
    check(output == split, "dynamic EQ reset and block sizes preserve detector/filter history");
  }
  for (double hz : {100., 1000.}) {
    DspConfig config; config.enabled = config.dynamicEqEnabled = true;
    DspDynamicEqBand band; band.frequency = 1000; band.gainDb = 0; band.q = 8;
    band.thresholdDb = -30; band.ratio = 4; band.rangeDb = -6; band.attackMs = 5; band.releaseMs = 80;
    config.dynamicEqBands = {band};
    DynamicEqProcessor processor; processor.configure(config); processor.prepare(format(48000));
    auto samples = sine(48000, hz, 0.25); process(processor, samples, 2);
    const double expected = hz == 1000 ? -6 : 0;
    const double measured = 20 * std::log10(std::abs(response(samples, 48000, hz, 0.25)));
    check(std::abs(measured - expected) < 0.01, "band-limited detector rejects an equally loud out-of-band tone");
  }
}

struct DirectFormOne {
  long double x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  long double process(long double x, const std::array<long double, 5>& c) {
    const auto y = c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y; return y;
  }
};

void dynamicEqTime() {
  // Independent direct-form-I, long-double RBJ reference versus production's
  // float-output correction-form histories. Coefficients follow the filter
  // equations, while the steady centre-gain tests above use analytic gain.
  for (int rate : {44100, 48000, 96000}) {
    DspConfig config; config.enabled = config.dynamicEqEnabled = true;
    DspDynamicEqBand band; band.frequency = 1000; band.gainDb = 2; band.q = 1.7;
    band.thresholdDb = -18; band.ratio = 3; band.rangeDb = -9; band.attackMs = 8; band.releaseMs = 40;
    config.dynamicEqBands = {band};
    const long double omega = 2 * std::numbers::pi_v<long double> * 1000 / rate;
    const auto alpha = std::sin(omega) / (2 * 1.7L), cosine = std::cos(omega);
    const std::array<long double, 5> detector{alpha / (1 + alpha), 0, -alpha / (1 + alpha),
                                          -2 * cosine / (1 + alpha), (1 - alpha) / (1 + alpha)};
    DirectFormOne detection, equalizer;
    long double envelope = 0;
    const size_t plateau = rate / 2;
    std::vector<float> input(plateau * 3), expected(input.size());
    size_t changingRangeFrames = 0;
    for (size_t frame = 0; frame < input.size(); ++frame) {
      const double amplitude = frame / plateau == 1 ? 0.5 : 0.01;
      input[frame] = static_cast<float>(amplitude * std::sin(2 * pi * 1000 * frame / rate));
      const auto level = std::abs(detection.process(input[frame], detector));
      const auto retain = std::exp(-1.L / ((level > envelope ? 0.008L : 0.040L) * rate));
      envelope = level + (envelope - level) * retain;
      const auto reduction = std::clamp((20 * std::log10(std::max(envelope, 1e-12L)) + 18) * (1 - 1 / 3.L), 0.L, 9.L);
      changingRangeFrames += reduction > 0.1L && reduction < 8.9L;
      const auto a = std::pow(10.L, (2 - reduction) / 40);
      const auto denominator = 1 + alpha / a;
      const std::array<long double, 5> coefficients{(1 + alpha * a) / denominator,
          -2 * cosine / denominator, (1 - alpha * a) / denominator,
          -2 * cosine / denominator, (1 - alpha / a) / denominator};
      expected[frame] = static_cast<float>(equalizer.process(input[frame], coefficients));
    }
    DynamicEqProcessor processor; processor.configure(config); processor.prepare(format(rate, 1));
    auto output = input; process(processor, output, 1, true);
    double error = 0;
    for (size_t i = 0; i < output.size(); ++i) error = std::max(error, std::abs(double(output[i]) - expected[i]));
    std::printf("dynamic-eq-time rate=%d maxSampleError=%.12g changingRangeFrames=%zu\n", rate, error, changingRangeFrames);
    check(std::all_of(output.begin(), output.end(), [](float value) { return std::isfinite(value); }) &&
          error < 3e-6 && changingRangeFrames > size_t(rate / 10),
          "dynamic EQ attack/release and unsaturated ratio follow the independent filter/envelope reference");
    band.gainDb = 0; band.ratio = 1; config.dynamicEqBands = {band}; processor.configure(config);
    output = input; process(processor, output, 1, true);
    check(output == input, "ratio-one zero-static-gain dynamic EQ is exact unity");
  }
}
}  // namespace

int main() {
  staticCompressor(); dynamicsTime(); multibandResponse(); dynamicEqResponse(); dynamicEqTime();
  std::printf("dynamics-response checks=%d failures=%d\n", checks, failures);
  return failures ? 1 : 0;
}
