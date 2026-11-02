#include "../dsp/DspWorkspaceProcessors.h"
#include "../dsp/FftSpectrumAnalyzer.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <complex>
#include <cstdio>
#include <numbers>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

using namespace twilight::audio;

namespace {
int failures = 0;
constexpr size_t kResolution = 8192;

void check(bool passed, const char* description) {
  std::printf("%s %s\n", passed ? "PASS" : "FAIL", description);
  if (!passed) ++failures;
}

AudioFormat formatFor(int rate, int channels) {
  AudioFormat format;
  format.sampleRate = rate;
  format.channelCount = channels;
  return format;
}

std::vector<double> array(const std::string& json, const std::string& key) {
  const size_t start = json.find("\"" + key + "\":[");
  if (start == std::string::npos) return {};
  const size_t left = json.find('[', start), right = json.find(']', left);
  std::istringstream in(json.substr(left + 1, right - left - 1));
  std::vector<double> values;
  double value;
  while (in >> value) { values.push_back(value); if (in.peek() == ',') in.get(); }
  return values;
}

std::vector<float> tone(int channels, size_t bin, double amplitude, double rightSign = 1.0) {
  std::vector<float> samples(kResolution * channels);
  for (size_t frame = 0; frame < kResolution; ++frame) {
    const float value = static_cast<float>(amplitude * std::sin(2 * std::numbers::pi * bin * frame / kResolution));
    for (int channel = 0; channel < channels; ++channel) {
      samples[frame * channels + channel] = value * (channel == 0 ? 1.0 : rightSign);
    }
  }
  return samples;
}

// Independent direct DFT of the actual Hann-windowed PCM at one frequency.
// Display normalization remains the established [-90,+10] dBFS sine scale.
double dftDisplay(const std::vector<float>& samples, size_t bin, int channels) {
  std::complex<double> sum{};
  for (size_t frame = 0; frame < kResolution; ++frame) {
    double mono = 0.0;
    for (int channel = 0; channel < channels; ++channel) mono += samples[frame * channels + channel];
    mono /= channels;
    const double window = 0.5 - 0.5 * std::cos(2 * std::numbers::pi * frame / (kResolution - 1));
    sum += mono * window * std::exp(std::complex<double>(0, -2 * std::numbers::pi * bin * frame / kResolution));
  }
  const double amplitude = std::abs(sum) / (kResolution * 0.25);
  return std::clamp((20 * std::log10(std::max(amplitude, 1e-6)) + 90) / 100, 0.0, 1.0);
}

std::string readBands(const FftSpectrumAnalyzer& analyzer, size_t points = 4096) {
#if defined(TAE_TEST_PEAK_BANDS)
  return analyzer.readVisualizationJson(points, 16, 0, 0, 48, true);
#else
  // Initial reproduction: the existing interpolated bars miss peaks between
  // sparse bar centres. The new mode must opt in without changing this default.
  return analyzer.readVisualizationJson(points, 16, 0, 0, 48);
#endif
}

void meterChecks() {
  for (double phase : {0.0, std::numbers::pi / 2, std::numbers::pi}) {
    LoudnessMeterProcessor meter;
    DspConfig config;
    config.enabled = true; config.meterEnabled = true;
    meter.configure(config); meter.prepare(formatFor(48000, 2));
    std::vector<float> samples(48000 * 2);
    for (size_t frame = 0; frame < 48000; ++frame) {
      samples[2 * frame] = static_cast<float>(0.2 * std::sin(2 * std::numbers::pi * frame / 48));
      samples[2 * frame + 1] = static_cast<float>(0.05 * std::sin(2 * std::numbers::pi * frame / 48 + phase));
    }
    const auto original = samples;
    for (size_t frame = 0; frame < 48000; frame += 125) meter.process(samples.data() + 2 * frame, 125);
    std::printf("correlation phase=%.9f expected=%.9f measured=%.9f\n", phase, std::cos(phase), meter.correlation());
    check(std::abs(meter.correlation() - std::cos(phase)) < 1e-7 && samples == original,
          "cumulative L/R correlation matches analytic phase despite channel amplitude difference");
    meter.reset();
    check(meter.correlation() == 0.0, "reset clears correlation");
  }
  LoudnessMeterProcessor meter;
  DspConfig config;
  config.enabled = true; config.meterEnabled = true;
  meter.configure(config); meter.prepare(formatFor(48000, 2));
  auto positive = tone(2, 171, 0.2), negative = tone(2, 171, 0.2, -1.0);
  meter.process(positive.data(), kResolution);
  meter.process(negative.data(), kResolution);
  std::printf("cumulative-correlation equal-positive-negative=%.9f\n", meter.correlation());
  check(std::abs(meter.correlation()) < 1e-12, "correlation retains its original cumulative-energy meaning");
  meter.prepare(formatFor(48000, 1));
  meter.process(positive.data(), kResolution);
  check(meter.correlation() == 0.0, "mono has no L/R correlation");
}

int profile() {
  FftSpectrumAnalyzer analyzer;
  analyzer.prepare(formatFor(48000, 2), kResolution);
  const auto samples = tone(2, 171, 0.5);
  size_t minBytes = 999999, maxBytes = 0, bytes = 0;
  const auto start = std::chrono::steady_clock::now();
  // Ten minutes equivalent at the Android monitor's 10 Hz request cadence;
  // CPU work runs offline, without waiting or opening an audio device.
  for (size_t poll = 0; poll < 6000; ++poll) {
    for (size_t frame = 0; frame < 4800; frame += 256) {
      analyzer.capture(samples.data() + frame * 2, std::min<size_t>(256, 4800 - frame), 2);
    }
    const auto json = readBands(analyzer);
    minBytes = std::min(minBytes, json.size()); maxBytes = std::max(maxBytes, json.size());
    bytes += json.size();
  }
  const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
  std::printf("host-monitor polls=6000 equivalentSeconds=600 cadenceHz=10 minJsonBytes=%zu maxJsonBytes=%zu totalJsonBytes=%zu hostElapsedSeconds=%.6f\n",
      minBytes, maxBytes, bytes, elapsed);
  check(maxBytes < 2048, "48-band monitor payload stays below 2 KiB without full spectra or spectrogram history");
  return failures == 0 ? 0 : 1;
}
}  // namespace

int main(int argc, char** argv) {
  if (argc == 2 && std::string_view(argv[1]) == "--profile") return profile();
  if (argc == 2 && std::string_view(argv[1]) == "--json") {
    FftSpectrumAnalyzer analyzer;
    analyzer.prepare(formatFor(48000, 2), kResolution);
    auto samples = tone(2, 171, 0.5);
    analyzer.capture(samples.data(), kResolution, 2);
    std::printf("%s\n", readBands(analyzer).c_str());
    return 0;
  }
  for (int rate : {32000, 44100, 48000, 96000, 192000, 768000}) {
    for (size_t bin : {size_t{11}, size_t{171}, size_t{1024}}) {
      const double frequency = static_cast<double>(bin * rate) / kResolution;
      if (frequency > 20000) continue;
      FftSpectrumAnalyzer analyzer;
      analyzer.prepare(formatFor(rate, 2), kResolution);
      auto samples = tone(2, bin, 0.5);
      const auto original = samples;
      analyzer.capture(samples.data(), kResolution, 2);
      const auto bins = array(analyzer.readVisualizationJson(4096, 16, 0, 0), "spectrum");
      const double expected = dftDisplay(samples, bin, 2);
      const auto bands = array(readBands(analyzer), "visualizerBars");
      const double top = std::min(20000.0, rate / 2.0);
      const size_t expectedBar = std::min<size_t>(47, static_cast<size_t>(std::floor(std::log(frequency / 20) / std::log(top / 20) * 48)));
      const auto maximum = std::max_element(bands.begin(), bands.end());
      const double peak = maximum == bands.end() ? 0.0 : *maximum;
      const size_t actualBar = maximum == bands.end() ? 999 : static_cast<size_t>(maximum - bands.begin());
      std::printf("spectrum rate=%d bin=%zu frequency=%.9f expected=%.9f fft=%.9f band=%.9f expectedBar=%zu actualBar=%zu\n",
          rate, bin, frequency, expected, bins[bin], peak, expectedBar, actualBar);
      check(std::abs(bins[bin] - expected) < 1e-5, "FFT level agrees with independent direct DFT");
      check(bands.size() == 48 && actualBar == expectedBar && std::abs(peak - expected) < 1e-5,
            "48 logarithmic peak bands preserve narrow-band peak and frequency bucket");
      check(array(readBands(analyzer, 64), "visualizerBars") == bands,
            "peak bands use native FFT bins, not a coarse virtual point grid");
      check(samples == original, "spectrum capture is read-only");
    }
  }
  {
    FftSpectrumAnalyzer analyzer;
    analyzer.prepare(formatFor(48000, 2), kResolution);
    auto samples = tone(2, 171, 0.5, -1.0);
    analyzer.capture(samples.data(), kResolution, 2);
    const auto bands = array(readBands(analyzer), "visualizerBars");
    check(bands.size() == 48 && std::all_of(bands.begin(), bands.end(), [](double v) { return v == 0; }),
          "spectrum preserves its mono-downmix source: antiphase L/R cancels");
    analyzer.setEnabled(false);
    const std::string disabled = readBands(analyzer);
    const auto zeros = array(disabled, "visualizerBars");
    check(zeros.size() == 48 && std::all_of(zeros.begin(), zeros.end(), [](double v) { return v == 0; }) &&
          disabled.find("\"active\":false") != std::string::npos,
          "disabled monitor returns 48 inactive zero bars");
  }
  meterChecks();
  std::printf("audio-monitor failures=%d\n", failures);
  return failures == 0 ? 0 : 1;
}
