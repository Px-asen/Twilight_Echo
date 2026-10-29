#include "../decoder/FFmpegDecoder.h"

extern "C" {
#include <libavutil/avutil.h>
#include <libswresample/swresample.h>
}

#include <algorithm>
#include <atomic>
#include <bit>
#include <cmath>
#include <complex>
#include <cstring>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <vector>

using namespace twilight::audio;
namespace {
using Quality = FFmpegDecoder::ResamplerQuality;
using Phase = FFmpegDecoder::ResamplerPhase;
constexpr double pi = 3.14159265358979323846;
void check(bool ok, const std::string& message) { if (!ok) throw std::runtime_error(message); }

// Float WAV over the production host-input boundary: no fixture-file precision
// loss, filesystem permissions or platform audio mixer enter these measurements.
struct WaveInput final : SeekableInput {
  std::vector<uint8_t> bytes;
  std::atomic<bool> cancelled{false};
  WaveInput(const std::vector<float>& samples, int rate) {
    auto word = [&](uint32_t value, int count) {
      for (int i = 0; i < count; ++i) bytes.push_back((value >> (8 * i)) & 255);
    };
    auto tag = [&](const char* value) { bytes.insert(bytes.end(), value, value + 4); };
    tag("RIFF"); word(36 + samples.size() * 4, 4); tag("WAVE"); tag("fmt ");
    word(16, 4); word(3, 2); word(1, 2); word(rate, 4); word(rate * 4, 4);
    word(4, 2); word(32, 2); tag("data"); word(samples.size() * 4, 4);
    for (float sample : samples) word(std::bit_cast<uint32_t>(sample), 4);
  }
  int64_t size() override { return bytes.size(); }
  int readAt(int64_t position, uint8_t* output, int count) override {
    if (cancelled || position < 0) return -1;
    if (static_cast<size_t>(position) >= bytes.size()) return 0;
    const size_t n = std::min<size_t>(count, bytes.size() - position);
    std::memcpy(output, bytes.data() + position, n); return static_cast<int>(n);
  }
  void cancel() override { cancelled = true; }
};

std::vector<float> convert(const std::vector<float>& input, int from, int to,
                           Quality quality, Phase phase, size_t block = 257) {
  FFmpegDecoder decoder;
  decoder.setInputFactory(std::make_shared<const SeekableInputFactory>(
      [&](const std::string&) { return std::make_shared<WaveInput>(input, from); }));
  decoder.setResamplerQuality(quality); decoder.setResamplerPhase(phase);
  std::string error;
  check(decoder.open("host-audio://resampler.wav", &error), error);
  AudioFormat format{to, 1, 32, AudioSampleFormat::Float32Interleaved};
  check(decoder.setOutputFormat(format, &error), error);
  const bool smooth = quality != Quality::Native &&
      (phase == Phase::LinearSmooth || phase == Phase::MinimumSmooth);
  check(decoder.effectiveResamplerPhase() == (smooth ? Phase::LinearSmooth : Phase::Linear),
        "effective phase disagrees with the configured SWR filter");
  decoder.setResamplerPhase(Phase::Minimum);
  check(decoder.effectiveResamplerPhase() == (smooth ? Phase::LinearSmooth : Phase::Linear),
        "pending phase request overwrote active filter observation");
  std::vector<float> result, buffer(block);
  for (;;) {
    const size_t count = decoder.readFrames(buffer.data(), block, &error);
    check(error.empty(), error);
    result.insert(result.end(), buffer.begin(), buffer.begin() + count);
    if (!count) break;
  }
  check(decoder.eof(), "conversion did not reach EOF");
  check(std::abs(static_cast<double>(result.size()) - input.size() * double(to) / from) <= 1,
        "resampler dropped its tail");
  return result;
}

double maximumDifference(const std::vector<float>& a, const std::vector<float>& b) {
  check(a.size() == b.size(), "different output lengths"); double result = 0;
  for (size_t i = 0; i < a.size(); ++i) result = std::max(result, double(std::abs(a[i] - b[i])));
  return result;
}
double db(double amplitude) { return 20 * std::log10(std::max(amplitude, 1e-15)); }
std::vector<float> tone(int rate, double hz) {
  std::vector<float> samples(rate / 5);
  for (size_t i = 0; i < samples.size(); ++i) samples[i] = 0.5 * std::sin(2 * pi * hz * i / rate);
  return samples;
}
// 0.05–0.15 s excludes start/flush transients; integer-Hz multiples of 10
// contain an integral number of periods in the measurement window.
double rms(const std::vector<float>& samples, int rate, bool errorToTone = false) {
  double sum = 0;
  for (int i = rate / 20; i < rate * 3 / 20; ++i) {
    const double value = samples[i] - (errorToTone ? 0.5 * std::sin(2 * pi * 1000 * i / rate) : 0);
    sum += value * value;
  }
  return std::sqrt(sum / (rate / 10));
}
double response(const std::vector<float>& impulse, int from, int to, double hz) {
  std::complex<double> sum{};
  const int center = to / 10;
  for (int i = std::max(0, center - 512); i < std::min<int>(impulse.size(), center + 513); ++i)
    sum += double(impulse[i]) * std::polar(1.0, -2 * pi * hz * (i - center) / to);
  return db(std::abs(sum) * from / to);
}

void checkSeek(Quality quality, Phase phase, int from, int to) {
  std::vector<float> input(from * 3 + 137);
  for (size_t i = 0; i < input.size(); ++i)
    input[i] = 0.3 * std::sin(2 * pi * 1000 * i / from) + 0.1 * std::sin(2 * pi * 11000 * i / from);
  const auto reference = convert(input, from, to, quality, phase);
  FFmpegDecoder decoder;
  decoder.setInputFactory(std::make_shared<const SeekableInputFactory>(
      [&](const std::string&) { return std::make_shared<WaveInput>(input, from); }));
  decoder.setResamplerQuality(quality); decoder.setResamplerPhase(phase);
  std::string error;
  check(decoder.open("host-audio://seek.wav", &error), error);
  check(decoder.setOutputFormat({to,1,32,AudioSampleFormat::Float32Interleaved}, &error), error);
  for (size_t offset : {size_t(0), size_t(1), size_t(to * 2 + 37), reference.size() - 123}) {
    check(decoder.seekOutputFrame(offset, &error), error);
    std::vector<float> actual(257);
    const size_t read = decoder.readFrames(actual.data(), actual.size(), &error);
    check(error.empty(), error);
    check(read == std::min(actual.size(), reference.size() - offset), "seek output length changed");
    for (size_t i = 0; i < read; ++i)
      check(std::abs(actual[i] - reference[offset+i]) < 1e-5, "seek PCM differs from continuous conversion");
  }
}
void measure() {
  std::cout << "{\"ffmpeg\":\"" << av_version_info() << "\",\"swresampleVersion\":"
            << swresample_version() << "}\n";
  const std::vector<std::pair<Quality, const char*>> qualities{
      {Quality::Native, "native"}, {Quality::High, "high"}, {Quality::Ultra, "ultra"}};
  const std::vector<std::pair<Phase, const char*>> phases{{Phase::Linear,"linear"},
      {Phase::Minimum,"minimum"}, {Phase::LinearSmooth,"linear-smooth"}, {Phase::MinimumSmooth,"minimum-smooth"}};
  for (auto [from, to] : {std::pair{44100,48000}, {48000,44100}, {96000,44100}}) {
    for (auto [quality, qualityName] : qualities) {
      std::vector<std::vector<float>> impulses;
      for (auto [phase, phaseName] : phases) {
        std::vector<float> source(from / 5); source[from / 10] = 1;
        auto impulse = convert(source, from, to, quality, phase);
        const auto otherBlock = convert(source, from, to, quality, phase, 4096);
        check(maximumDifference(impulse, otherBlock) == 0, "read block size changed PCM");
        const int center = to / 10;
        double before = 0, after = 0, symmetry = 0;
        for (int n = 1; n <= 256; ++n) {
          before += double(impulse[center-n]) * impulse[center-n];
          after += double(impulse[center+n]) * impulse[center+n];
          symmetry = std::max(symmetry, double(std::abs(impulse[center-n] - impulse[center+n])));
        }
        check(symmetry < 2e-5, "linear-phase impulse lost symmetry");
        const auto convertedTone = convert(tone(from,1000), from,to,quality,phase);
        const double errorDb = db(rms(convertedTone,to,true) / (0.5 / std::sqrt(2.0)));
        const double gain1k = response(impulse,from,to,1000);
        check(std::abs(gain1k) < 0.02, "1 kHz gain exceeds 0.02 dB");
        check(errorDb < -65, "1 kHz conversion error exceeds -65 dB relative to tone RMS");
        std::cout << std::setprecision(10) << "{\"from\":" << from << ",\"to\":" << to
            << ",\"quality\":\"" << qualityName << "\",\"requestedPhase\":\"" << phaseName
            << "\",\"frames\":" << impulse.size() << ",\"symmetryMax\":" << symmetry
            << ",\"preEnergy\":" << before << ",\"postEnergy\":" << after
            << ",\"gain1kDb\":" << gain1k << ",\"gain18kDb\":" << response(impulse,from,to,18000)
            << ",\"gain20kDb\":" << response(impulse,from,to,20000) << ",\"toneErrorDb\":" << errorDb;
        if (from > to) {
          const double stopHz = from == 96000 ? 30000 : 23000;
          const auto stop = convert(tone(from,stopHz),from,to,quality,phase);
          const double aliasDb = db(rms(stop,to) / (0.5 / std::sqrt(2.0)));
          check(std::isfinite(aliasDb), "nonfinite stopband output");
          // Measured stop tones: 23 kHz for 48→44.1, 30 kHz for 96→44.1.
          // This is not a bound on every frequency in the transition band.
          check(aliasDb < (quality == Quality::Ultra ? -90 : quality == Quality::High ? -80 : -20),
                "stop-tone alias rejection regressed");
          std::cout << ",\"stopToneHz\":" << stopHz << ",\"aliasDb\":" << aliasDb;
        }
        std::cout << "}\n";
        impulses.push_back(std::move(impulse));
      }
      // These are legacy request aliases, not minimum-phase implementations.
      check(maximumDifference(impulses[0],impulses[1]) == 0, "minimum alias changed");
      check(maximumDifference(impulses[2],impulses[3]) == 0, "minimum-smooth alias changed");
      if (quality == Quality::Native) check(impulses[0] == impulses[2], "native fixed rolloff changed");
      else check(maximumDifference(impulses[0],impulses[2]) > 1e-5, "smooth rolloff has no effect");
    }
  }
  const auto sameRate = tone(48000,1000);
  check(convert(sameRate,48000,48000,Quality::Ultra,Phase::MinimumSmooth) == sameRate,
        "equal-rate float conversion changed samples");
  for (auto quality : {Quality::High, Quality::Ultra})
    for (auto phase : {Phase::Linear, Phase::LinearSmooth})
      for (auto [from,to] : {std::pair{44100,48000}, {96000,44100}}) checkSeek(quality,phase,from,to);
  std::cout << "{\"checks\":\"passed\",\"responseCases\":36,\"seekCases\":8,\"positionsPerSeekCase\":4}\n";
}

void highRates() {
  std::cout << "{\"ffmpeg\":\"" << av_version_info() << "\",\"suite\":\"high-pcm\"}\n";
  for (auto [from, to] : {std::pair{44100,705600}, {48000,768000}, {705600,48000}, {768000,44100}}) {
    const auto input = tone(from, 1000);
    const auto output = convert(input, from, to, Quality::Ultra, Phase::Linear);
    check(std::all_of(output.begin(), output.end(), [](float value) { return std::isfinite(value); }), "nonfinite high-rate sample");
    check(maximumDifference(output, convert(input, from, to, Quality::Ultra, Phase::Linear, 4096)) == 0,
          "high-rate block size changed PCM");
    const double errorDb = db(rms(output, to, true) / (0.5 / std::sqrt(2.0)));
    check(errorDb < -65, "high-rate tone error exceeds -65 dB");
    checkSeek(Quality::Ultra, Phase::Linear, from, to);
    std::cout << "{\"from\":" << from << ",\"to\":" << to << ",\"frames\":" << output.size()
              << ",\"toneErrorDb\":" << errorDb << ",\"seekPositions\":4}\n";
  }
  for (int rate : {705600, 768000}) {
    const auto input = tone(rate, 1000);
    check(convert(input, rate, rate, Quality::Ultra, Phase::Linear) == input, "same high-rate PCM changed");
  }
  std::cout << "{\"checks\":\"passed\",\"conversionCases\":4,\"sameRateCases\":2,\"seekCases\":4}\n";
}
}
int main() {
  try { if (std::getenv("TAE_RESAMPLER_HIGH_RATE_ONLY")) highRates(); else { measure(); highRates(); } return 0; }
  catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
