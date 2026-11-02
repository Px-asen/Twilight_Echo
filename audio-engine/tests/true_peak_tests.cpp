#include "../dsp/DspWorkspaceProcessors.h"
#include <ebur128.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <numbers>
#include <string_view>
#include <vector>

using namespace twilight::audio;

namespace {
bool tracking = false;
size_t newCalls = 0, deleteCalls = 0;
#if defined(TAE_TEST_WRAP_ALLOCATORS)
size_t mallocCalls = 0, callocCalls = 0, freeCalls = 0;
#endif
}  // namespace

void* operator new(size_t size) {
  if (tracking) ++newCalls;
  if (void* pointer = std::malloc(size ? size : 1)) return pointer;
  throw std::bad_alloc();
}
void* operator new[](size_t size) { return ::operator new(size); }
void operator delete(void* pointer) noexcept {
  if (tracking && pointer) ++deleteCalls;
  std::free(pointer);
}
void operator delete[](void* pointer) noexcept { ::operator delete(pointer); }
void operator delete(void* pointer, size_t) noexcept { ::operator delete(pointer); }
void operator delete[](void* pointer, size_t) noexcept { ::operator delete(pointer); }

#if defined(TAE_TEST_WRAP_ALLOCATORS)
extern "C" void* __real_malloc(size_t);
extern "C" void* __real_calloc(size_t, size_t);
extern "C" void __real_free(void*);
extern "C" void* __wrap_malloc(size_t size) {
  if (tracking) ++mallocCalls;
  return __real_malloc(size);
}
extern "C" void* __wrap_calloc(size_t count, size_t size) {
  if (tracking) ++callocCalls;
  return __real_calloc(count, size);
}
extern "C" void __wrap_free(void* pointer) {
  if (tracking && pointer) ++freeCalls;
  __real_free(pointer);
}
#endif

namespace {
int failures = 0;

void check(bool passed, const char* description) {
  std::printf("%s %s\n", passed ? "PASS" : "FAIL", description);
  if (!passed) ++failures;
}

double db(double value) { return 20.0 * std::log10(value); }

AudioFormat formatFor(int rate, int channels) {
  AudioFormat format;
  format.sampleRate = rate;
  format.channelCount = channels;
  return format;
}

void prepare(LoudnessMeterProcessor& meter, int rate, int channels) {
  DspConfig config;
  config.enabled = true;
  config.meterEnabled = true;
  meter.configure(config);
  meter.prepare(formatFor(rate, channels));
}

std::vector<float> tone(int rate, int channels, double frequency, double amplitude, double phase) {
  const size_t frames = static_cast<size_t>(rate / 4);
  std::vector<float> signal(frames * channels);
  for (size_t frame = 0; frame < frames; ++frame) {
    // Smooth edges isolate reconstruction accuracy from a truncated sine's ringing.
    const double fade = std::min({1.0, static_cast<double>(frame) / 1024.0,
        static_cast<double>(frames - 1 - frame) / 1024.0});
    const double window = 0.5 - 0.5 * std::cos(std::numbers::pi * fade);
    for (int channel = 0; channel < channels; ++channel) {
      signal[frame * channels + channel] = static_cast<float>(window * amplitude *
          std::sin(2.0 * std::numbers::pi * frequency * frame / rate + phase) *
          (channel == channels - 1 ? 1.0 : 0.5));
    }
  }
  return signal;
}

double referencePeak(const std::vector<float>& signal, int rate, int channels) {
  auto* reference = ebur128_init(channels, rate, EBUR128_MODE_TRUE_PEAK);
  if (!reference) return NAN;
  const int result = ebur128_add_frames_float(reference, signal.data(), signal.size() / channels);
  double peak = 0.0;
  for (int channel = 0; channel < channels; ++channel) {
    double value = 0.0;
    if (result != EBUR128_SUCCESS || ebur128_true_peak(reference, channel, &value) != EBUR128_SUCCESS) {
      ebur128_destroy(&reference);
      return NAN;
    }
    peak = std::max(peak, value);
  }
  ebur128_destroy(&reference);
  return db(peak);
}

void feed(LoudnessMeterProcessor& meter, std::vector<float>& signal, int channels, bool irregular) {
  constexpr std::array<size_t, 6> chunks{1, 3, 7, 511, 2048, 63};
  const size_t total = signal.size() / channels;
  size_t frame = 0, block = 0;
  while (frame < total) {
    const size_t frames = std::min(total - frame, irregular ? chunks[block++ % chunks.size()] : 256);
    meter.process(signal.data() + frame * channels, frames);
    frame += frames;
  }
}

size_t limit(std::vector<float>& signal, int rate, int channels, double lookahead, bool irregular,
             double ceiling = -1.0) {
  DynamicsProcessor limiter(DynamicsMode::TruePeakLimiter);
  DspConfig config;
  config.enabled = true;
  config.truePeakLimiterEnabled = true;
  config.truePeakCeilingDb = ceiling;
  config.truePeakLookaheadMs = lookahead;
  config.truePeakReleaseMs = 1.0;
  limiter.configure(config);
  limiter.prepare(formatFor(rate, channels));
  constexpr std::array<size_t, 5> chunks{1, 7, 63, 511, 2048};
  const size_t frames = signal.size() / channels;
  size_t offset = 0, block = 0;
  while (offset < frames) {
    const size_t count = std::min(frames - offset, irregular ? chunks[block++ % chunks.size()] : 256);
    limiter.process(signal.data() + offset * channels, count);
    offset += count;
  }
  return limiter.latencyFrames();
}

int realtime() {
  LoudnessMeterProcessor meter;
  prepare(meter, 48000, 2);
  DynamicsProcessor limiter(DynamicsMode::TruePeakLimiter);
  DspConfig config;
  config.enabled = true;
  config.truePeakLimiterEnabled = true;
  config.truePeakLookaheadMs = 20.0;
  config.truePeakReleaseMs = 1.0;
  limiter.configure(config);
  limiter.prepare(formatFor(48000, 2));
  check(limiter.isActive() && meter.isActive(), "realtime path runs both active processors");
  std::array<float, 512> signal{}, source{};
  for (size_t frame = 0; frame < 256; ++frame) {
    source[frame * 2] = static_cast<float>(1.5 * std::sin(2 * std::numbers::pi * frame / 4 + std::numbers::pi / 4));
    source[frame * 2 + 1] = -source[frame * 2] * 0.5f;
  }
  tracking = true;
  for (size_t block = 0; block < 600 * 48000 / 256; ++block) {
    const float amplitude = (block / 1875) % 2 == 0 ? 1.0f : 0.1f;
    for (size_t sample = 0; sample < signal.size(); ++sample) signal[sample] = source[sample] * amplitude;
    limiter.process(signal.data(), 256);
    meter.process(signal.data(), 256);
    if (block % 1875 == 0) {
      (void)meter.truePeakDb(); (void)meter.integratedLufs(); (void)meter.loudnessRangeLu();
    }
  }
  tracking = false;
  std::printf("ten-minute limiter + meter: new=%zu delete=%zu", newCalls, deleteCalls);
#if defined(TAE_TEST_WRAP_ALLOCATORS)
  std::printf(" malloc=%zu calloc=%zu free=%zu", mallocCalls, callocCalls, freeCalls);
#endif
  std::printf("\n");
#if defined(TAE_TEST_WRAP_ALLOCATORS)
  check(mallocCalls == 0 && callocCalls == 0 && freeCalls == 0, "no C allocator calls while rendering");
#endif
  check(newCalls == 0 && deleteCalls == 0, "no C++ allocator calls while rendering");
  return failures == 0 ? 0 : 1;
}
}  // namespace

int main(int argc, char** argv) {
  if (argc == 2 && std::string_view(argv[1]) == "--realtime") return realtime();
  for (int rate : {44100, 48000, 96000, 192000, 768000}) {
    for (int channels : {1, 2}) {
      auto signal = tone(rate, channels, rate / 4.0, 0.95, std::numbers::pi / 4.0);
      const auto original = signal;
      LoudnessMeterProcessor regular, irregular;
      prepare(regular, rate, channels);
      prepare(irregular, rate, channels);
      feed(regular, signal, channels, false);
      feed(irregular, signal, channels, true);
      const double expected = db(0.95);
      const double reference = rate < 192000 ? referencePeak(signal, rate, channels) : NAN;
      std::printf("quarter-rate rate=%d channels=%d expected=%.9f reference=%.9f measured=%.9f\n",
          rate, channels, expected, reference, regular.truePeakDb());
      check(std::abs(regular.truePeakDb() - expected) <= 0.1, "quarter-rate intersample peak within 0.1 dB of analytic amplitude");
      check(regular.truePeakDb() == irregular.truePeakDb() && signal == original,
          "irregular chunks preserve true peak and input samples");
    }
  }
  for (double frequency : {1000.0, 6000.0, 12000.0, 18000.0, 21600.0}) {
    auto signal = tone(48000, 2, frequency, 0.95, std::numbers::pi / 4.0);
    LoudnessMeterProcessor meter;
    prepare(meter, 48000, 2);
    feed(meter, signal, 2, true);
    const double reference = referencePeak(signal, 48000, 2);
    std::printf("reference-tone frequency=%.0f reference=%.9f measured=%.9f\n", frequency, reference, meter.truePeakDb());
    check(std::abs(meter.truePeakDb() - reference) <= 0.1, "true peak agrees with independent libebur128 within 0.1 dB");
  }
  {
    // All channels are independently reconstructed; the last channel must not
    // disappear into a stereo-only meter or a downmixed detector.
    auto signal = tone(48000, 8, 16000.0, 0.95, 0.0);
    LoudnessMeterProcessor meter;
    prepare(meter, 48000, 8);
    feed(meter, signal, 8, true);
    const double reference = referencePeak(signal, 48000, 8);
    std::printf("eight-channel reference=%.9f measured=%.9f analytic=%.9f\n", reference, meter.truePeakDb(), db(0.95));
    check(std::abs(meter.truePeakDb() - reference) <= 0.1 && std::abs(meter.truePeakDb() - db(0.95)) <= 0.1,
          "eight-channel reconstruction includes a last-channel intersample peak");
    check(meter.clipCount() == 0, "intersample peak does not redefine sample clip count");
    meter.reset();
    std::vector<float> silence(512 * 8, 0.0f);
    meter.process(silence.data(), 512);
    check(std::isinf(meter.truePeakDb()) && meter.truePeakDb() < 0 && meter.clipCount() == 0,
          "reset clears true-peak history and silence remains negative infinity");
  }
  for (double lookahead : {0.1, 1.0, 20.0}) {
    auto signal = tone(48000, 2, 12000.0, 1.2, std::numbers::pi / 4.0);
    auto split = signal;
    limit(signal, 48000, 2, lookahead, false);
    limit(split, 48000, 2, lookahead, true);
    const double peak = referencePeak(signal, 48000, 2);
    std::printf("limited-tone lookahead=%.1f reference=%.9f ceiling=-1\n", lookahead, peak);
    check(peak <= -0.9, "limiter contains intersample sine peak within 0.1 dB of ceiling");
    check(signal == split, "limiter output is block-size invariant");
    std::vector<float> impulse(4800 * 2, 0.0f);
    impulse[1500 * 2] = impulse[1500 * 2 + 1] = 1.5f;
    limit(impulse, 48000, 2, lookahead, true);
    const double impulsePeak = referencePeak(impulse, 48000, 2);
    std::printf("limited-impulse lookahead=%.1f reference=%.9f ceiling=-1\n", lookahead, impulsePeak);
    check(impulsePeak <= -0.9, "limiter retains required reduction until delayed impulse leaves lookahead");
  }
  for (int rate : {44100, 48000, 96000}) {
    // Broadband transients expose envelope modulation that a steady sine misses.
    std::vector<float> noise(static_cast<size_t>(rate / 2) * 2);
    uint32_t random = 1234567;
    for (size_t frame = 0; frame < noise.size() / 2; ++frame) {
      random = random * 1664525U + 1013904223U;
      const float value = (static_cast<double>(random) / 4294967295.0 * 2 - 1) * 1.5;
      noise[2 * frame] = value;
      noise[2 * frame + 1] = value * -0.5f;
    }
    limit(noise, rate, 2, 0.1, true, -12.0);
    const double peak = referencePeak(noise, rate, 2);
    std::printf("limited-noise rate=%d reference=%.9f ceiling=-12\n", rate, peak);
    check(peak <= -11.9, "minimum-lookahead broadband output respects -12 dBTP ceiling within 0.1 dB");
    bool linked = true;
    for (size_t frame = 0; frame < noise.size() / 2; ++frame) {
      linked = linked && noise[frame * 2 + 1] == noise[frame * 2] * -0.5f;
    }
    check(linked, "limiter preserves stereo amplitude ratio and polarity");
  }
  for (int rate : {44100, 48000, 96000}) {
    std::vector<float> signal(static_cast<size_t>(rate / 2) * 2);
    for (size_t frame = 0; frame < signal.size() / 2; ++frame) {
      const double amplitude = (frame / 97) % 2 == 0 ? 1.5 : 0.01;
      const float value = static_cast<float>(amplitude * (
          std::sin(2 * std::numbers::pi * frame * 0.25 + 0.7) +
          std::sin(2 * std::numbers::pi * frame * 0.173 + 1.2)));
      signal[frame * 2] = value;
      signal[frame * 2 + 1] = -0.5f * value;
    }
    limit(signal, rate, 2, 0.1, true);
    const double peak = referencePeak(signal, rate, 2);
    std::printf("limited-bursts rate=%d reference=%.9f ceiling=-1\n", rate, peak);
    check(peak <= -0.9, "abrupt two-tone bursts do not regenerate excess true peak at attack/release");
  }
  for (double lookahead : {0.1, 1.0, 20.0}) {
    auto signal = tone(48000, 2, 1000, 0.1, 0.0);
    signal.resize(signal.size() + 2048 * 2, 0.0f);
    const auto original = signal;
    const size_t latency = limit(signal, 48000, 2, lookahead, true);
    const size_t expected = std::max<size_t>(11, static_cast<size_t>(std::round(48000 * lookahead / 1000)));
    bool transparent = latency == expected;
    for (size_t frame = 0; frame < signal.size() / 2; ++frame) {
      for (size_t channel = 0; channel < 2; ++channel) {
        transparent = transparent && signal[frame * 2 + channel] ==
            (frame < latency ? 0.0f : original[(frame - latency) * 2 + channel]);
      }
    }
    std::printf("latency lookahead=%.1f actual=%zu expected=%zu\n", lookahead, latency, expected);
    check(transparent, "below-ceiling PCM is unchanged apart from exactly reported delay");
  }
  {
    auto signal = tone(96000, 8, 24000, 1.2, std::numbers::pi / 4);
    const size_t latency = limit(signal, 96000, 8, 0.1, true, 0.0);
    const double peak = referencePeak(signal, 96000, 8);
    std::printf("limited-eight-channel rate=96000 reference=%.9f ceiling=0 latency=%zu\n", peak, latency);
    check(peak <= 0.1 && latency == 23, "96 kHz eight-channel limiter honors 0 dBTP and reports 23-frame FIR floor");
  }
  {
    DynamicsProcessor limiter(DynamicsMode::TruePeakLimiter);
    DspConfig config;
    config.enabled = true;
    config.truePeakLimiterEnabled = true;
    config.truePeakLookaheadMs = 20.0;
    config.truePeakReleaseMs = 1.0;
    limiter.configure(config);
    limiter.prepare(formatFor(48000, 2));
    std::vector<float> input(4800 * 2, 0.1f);
    input[1500 * 2] = input[1500 * 2 + 1] = 1.5f;
    auto signal = input;
    limiter.process(signal.data(), 4800);
    check(std::abs(signal[4500 * 2] - 0.1f) <= 1e-6, "release recovers unity after the delayed peak has passed");
    limiter.reset();
    auto reset = input;
    limiter.process(reset.data(), 4800);
    check(signal == reset, "reset clears detector, delay, gain, and peak-window state");
    config.truePeakLimiterEnabled = false;
    limiter.configure(config);
    signal = input;
    limiter.process(signal.data(), 4800);
    check(signal == input && limiter.latencyFrames() == 0, "disabled limiter preserves samples without delay");
  }
  std::printf("true-peak failures=%d\n", failures);
  return failures == 0 ? 0 : 1;
}
