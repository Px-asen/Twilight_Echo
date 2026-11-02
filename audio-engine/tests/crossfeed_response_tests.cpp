#include "../dsp/CrossfeedProcessor.h"
#include "../third_party/bs2b/upstream/bs2b.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <new>
#include <numbers>
#include <type_traits>
#include <vector>

using namespace twilight::audio;

static bool tracking = false;
static size_t cppAllocations = 0, cppReleases = 0, cAllocations = 0, cReleases = 0;
void* operator new(size_t size) {
  if (tracking) ++cppAllocations;
  if (void* pointer = std::malloc(size ? size : 1)) return pointer;
  throw std::bad_alloc();
}
void* operator new[](size_t size) { return ::operator new(size); }
void operator delete(void* pointer) noexcept {
  if (tracking && pointer) ++cppReleases;
  std::free(pointer);
}
void operator delete[](void* pointer) noexcept { ::operator delete(pointer); }
void operator delete(void* pointer, size_t) noexcept { ::operator delete(pointer); }
void operator delete[](void* pointer, size_t) noexcept { ::operator delete(pointer); }
#if defined(TAE_TEST_WRAP_ALLOCATORS)
extern "C" void* __real_malloc(size_t);
extern "C" void* __real_calloc(size_t, size_t);
extern "C" void __real_free(void*);
extern "C" void* __wrap_malloc(size_t n) { if (tracking) ++cAllocations; return __real_malloc(n); }
extern "C" void* __wrap_calloc(size_t n, size_t size) { if (tracking) ++cAllocations; return __real_calloc(n, size); }
extern "C" void __wrap_free(void* p) { if (tracking && p) ++cReleases; __real_free(p); }
#endif

namespace {
constexpr double pi = std::numbers::pi;
using Complex = std::complex<long double>;
int checks = 0, failures = 0;
double maximumOracleFloat = 0, maximumOracleDouble = 0, maximumTransfer = 0;
struct Profile { CrossfeedAlgorithm algorithm; const char* name; uint32_t level; };
constexpr Profile profiles[] = {
    {CrossfeedAlgorithm::Bauer, "bauer", BS2B_DEFAULT_CLEVEL},
    {CrossfeedAlgorithm::Bs2b, "bs2b", BS2B_DEFAULT_CLEVEL},
    {CrossfeedAlgorithm::Meier, "meier", BS2B_JMEIER_CLEVEL}};

void check(bool pass, const char* label) {
  ++checks; failures += !pass;
  std::printf("%s %s\n", pass ? "PASS" : "FAIL", label);
}
AudioFormat format(int rate, int channels = 2) {
  AudioFormat f; f.sampleRate = rate; f.channelCount = channels; return f;
}
DspConfig config(CrossfeedAlgorithm algorithm, double strength = 1) {
  DspConfig c; c.enabled = c.crossfeedEnabled = true;
  c.crossfeedAlgorithm = algorithm; c.crossfeedStrength = strength; return c;
}
void setup(CrossfeedProcessor& p, const DspConfig& c, int rate) {
  p.configure(c); p.prepare(format(rate));
}
template <typename Sample>
void call(CrossfeedProcessor& p, Sample* data, size_t frames) {
  if constexpr (std::is_same_v<Sample, float>) p.process(data, frames);
  else p.processDouble(data, frames);
}
template <typename Sample>
void process(CrossfeedProcessor& p, std::vector<Sample>& data, bool fragmented = false) {
  if (!fragmented) { call(p, data.data(), data.size()/2); return; }
  constexpr size_t blocks[] = {1, 17, 128, 3, 511};
  for (size_t offset = 0, block = 0; offset < data.size()/2; ++block) {
    const size_t count = std::min(blocks[block % 5], data.size()/2-offset);
    call(p, data.data()+offset*2, count); offset += count;
  }
}
template <typename A, typename B>
double error(const std::vector<A>& a, const std::vector<B>& b) {
  double maximum = 0;
  for (size_t i = 0; i < a.size(); ++i) {
    if (!std::isfinite(a[i]) || !std::isfinite(b[i])) return std::numeric_limits<double>::infinity();
    maximum = std::max(maximum, std::abs(double(a[i])-double(b[i])));
  }
  return maximum;
}
template <typename Sample>
std::vector<Sample> stimulus() {
  std::vector<Sample> data(8192*2);
  for (size_t i = 0; i < data.size(); ++i)
    data[i] = static_cast<Sample>(.14*std::sin(i*.137)+.08*std::cos(i*.019)+(int(i*67%127)-63)/1024.0);
  data[0] = static_cast<Sample>(.1234567891234567); data[1] = static_cast<Sample>(-.2345678912345678);
  return data;
}
template <typename Sample>
std::vector<Sample> oracle(const std::vector<Sample>& input, int rate, uint32_t level, double strength) {
  // Compile the original libbs2b 3.1.0 C implementation as an independent
  // executable reference; only our existing strength control is mixed here.
  t_bs2bd state{}; bs2b_set_srate(&state, rate); bs2b_set_level(&state, level);
  std::vector<double> wet(input.begin(), input.end());
  bs2b_cross_feed_d(&state, wet.data(), static_cast<int>(wet.size()/2));
  std::vector<Sample> output(input.size());
  for (size_t i = 0; i < input.size(); ++i)
    output[i] = static_cast<Sample>((1-strength)*double(input[i])+strength*wet[i]);
  return output;
}

template <typename Sample>
void compareUpstream() {
  const auto input = stimulus<Sample>();
  for (const auto& profile : profiles) for (int rate : {8000, 44100, 48000, 96000, 192000, 384000})
    for (double strength : {.25, .75, 1.}) {
      CrossfeedProcessor p; setup(p, config(profile.algorithm, strength), rate);
      const auto expected = oracle(input, rate, profile.level, strength);
      auto output = input; process(p, output, true);
      const double difference = error(output, expected);
      if constexpr (std::is_same_v<Sample, float>) maximumOracleFloat = std::max(maximumOracleFloat, difference);
      else maximumOracleDouble = std::max(maximumOracleDouble, difference);
      std::printf("oracle algorithm=%s rate=%d strength=%.2f precision=%s maxSampleError=%.12g\n",
                  profile.name, rate, strength, std::is_same_v<Sample, float> ? "float" : "double", difference);
      check(difference < (std::is_same_v<Sample, float> ? 6e-8 : 4e-14),
            "named crossfeed matches the original libbs2b profile and dry/wet strength");
      p.reset(); auto whole = input; process(p, whole);
      check(whole == output, "irregular blocks and reset preserve exact crossfeed histories");
      for (size_t i = 0; i < output.size(); i += 2) std::swap(output[i], output[i+1]);
      auto swapped = input;
      for (size_t i = 0; i < swapped.size(); i += 2) std::swap(swapped[i], swapped[i+1]);
      p.reset(); process(p, swapped);
      check(swapped == output, "named crossfeed is reciprocal without left/right history leakage");
    }
}

std::array<Complex, 2> publishedResponse(int rate, uint32_t level, double strength, double hz) {
  // Published BS2B H-transform, evaluated in long double in the z domain.
  // No production coefficients or recurrence are read by this reference.
  const long double feed = (level >> 16)/10.L, cutoff = level & 0xffff;
  const long double lowDb = -5*feed/6-3, highDb = feed/6-3;
  const long double lowGain = std::pow(10.L, lowDb/20), highLoss = 1-std::pow(10.L, highDb/20);
  const long double highCutoff = cutoff*std::pow(2.L, (lowDb-20*std::log10(highLoss))/12);
  const long double lowPole = std::exp(-2*std::numbers::pi_v<long double>*cutoff/rate);
  const long double highPole = std::exp(-2*std::numbers::pi_v<long double>*highCutoff/rate);
  const auto z = std::polar(1.L, -2*std::numbers::pi_v<long double>*hz/rate);
  const long double gain = 1/(1-highLoss+lowGain);
  const auto direct = gain*(1.L-highLoss*(1-highPole)-highPole*z)/(1.L-highPole*z);
  const auto cross = gain*lowGain*(1-lowPole)/(1.L-lowPole*z);
  const long double wet = strength;
  return {1.L-wet+wet*direct, wet*cross};
}
template <typename Sample>
void frequencyResponse() {
  for (const auto& profile : profiles) for (int rate : {44100, 48000, 96000, 384000, 705600, 768000})
    for (double strength : {.25, .75, 1.}) {
      CrossfeedProcessor p; setup(p, config(profile.algorithm, strength), rate);
      std::vector<Sample> impulse(16384*2); impulse[0] = static_cast<Sample>(.25);
      process(p, impulse, true);
      for (double hz : {0., 20., 100., 650., 700., 1000., 8000., rate*.475}) {
        const auto reference = publishedResponse(rate, profile.level, strength, hz);
        std::array<Complex, 2> measured{};
        for (size_t n = 0; n < impulse.size()/2; ++n) {
          const auto basis = std::polar(4.L, -2*std::numbers::pi_v<long double>*hz*n/rate);
          for (int ch = 0; ch < 2; ++ch) measured[ch] += (long double)impulse[n*2+ch]*basis;
        }
        const double difference = static_cast<double>(std::max(std::abs(measured[0]-reference[0]), std::abs(measured[1]-reference[1])));
        maximumTransfer = std::max(maximumTransfer, difference);
        std::printf("transfer algorithm=%s rate=%d strength=%.2f precision=%s frequencyHz=%.0f directMagnitude=%.12Lg crossMagnitude=%.12Lg complexError=%.12g\n",
                    profile.name, rate, strength, std::is_same_v<Sample, float> ? "float" : "double", hz,
                    std::abs(measured[0]), std::abs(measured[1]), difference);
        check(difference < (std::is_same_v<Sample, float> ? 3e-7 : 3e-12),
              "direct shelf and opposite low-pass match the published complex transfer through 768 kHz");
      }
    }
}

template <typename Sample>
void lifecycle() {
  const auto input = stimulus<Sample>();
  for (const auto& profile : profiles) {
    auto c = config(profile.algorithm, .25); CrossfeedProcessor p; setup(p, c, 48000);
    auto output = input;
    call(p, output.data(), 2048);
    // Same-format prepare is used by DspChain::setCrossfeedStrength. It must
    // not clear only the delay while retaining an unrelated filter tail.
    p.configure(c); p.prepare(format(48000)); p.setTrackContext({});
    call(p, output.data()+4096, output.size()/2-2048);
    check(error(output, oracle(input, 48000, profile.level, .25)) < 6e-8,
          "idempotent configure, prepare and track context preserve filter history");

    p.reset(); output = input; call(p, output.data(), 2048);
    c.crossfeedStrength = .75; p.configure(c); p.prepare(format(48000));
    call(p, output.data()+4096, output.size()/2-2048);
    auto expected = oracle(input, 48000, profile.level, .25);
    const auto later = oracle(input, 48000, profile.level, .75);
    std::copy(later.begin()+4096, later.end(), expected.begin()+4096);
    check(error(output, expected) < 6e-8, "live strength changes retain the original named-filter state");

    c.crossfeedDelayMs = 2; c.crossfeedCutoffHz = 3000;
    p.reset(); p.configure(c); output = input; process(p, output);
    check(error(output, oracle(input, 48000, profile.level, .75)) < 6e-8,
          "custom delay and cutoff do not alter named profiles");

    p.prepare(format(96000)); output = input; process(p, output);
    check(error(output, oracle(input, 96000, profile.level, .75)) < 6e-8,
          "sample-rate changes rebuild both named filters and clear every history");
    c.crossfeedAlgorithm = profile.algorithm == CrossfeedAlgorithm::Meier ? CrossfeedAlgorithm::Bs2b : CrossfeedAlgorithm::Meier;
    const uint32_t otherLevel = c.crossfeedAlgorithm == CrossfeedAlgorithm::Meier ? BS2B_JMEIER_CLEVEL : BS2B_DEFAULT_CLEVEL;
    p.configure(c); output = input; process(p, output);
    check(error(output, oracle(input, 96000, otherLevel, .75)) < 6e-8,
          "algorithm changes apply immediately without requiring another prepare");

    for (int off = 0; off < 3; ++off) {
      auto disabled = c;
      if (off == 0) disabled.enabled = false;
      if (off == 1) disabled.crossfeedEnabled = false;
      if (off == 2) disabled.crossfeedStrength = 0;
      p.configure(disabled); output = input; process(p, output);
      check(!p.isActive() && p.strength() == 0 && output == input, "disabled DSP, crossfeed and zero strength are exact bypasses");
      p.configure(c); output = input; process(p, output);
      check(error(output, oracle(input, 96000, otherLevel, .75)) < 6e-8, "reenabling starts with cleared histories");
    }
    for (int channels : {1, 6, 8}) {
      p.prepare(format(48000, channels)); output = input;
      call(p, output.data(), output.size()/channels);
      check(!p.isActive() && output == input, "non-stereo formats remain exact bypasses");
    }
  }
}

template <typename Sample>
void customCompatibility() {
  const auto input = stimulus<Sample>();
  for (int rate : {44100, 48000, 96000}) for (double delayMs : {.05, .35, 2.}) {
    auto c = config(CrossfeedAlgorithm::Custom, .75); c.crossfeedDelayMs = delayMs; c.crossfeedCutoffHz = 1800;
    const size_t delay = static_cast<size_t>(std::max(1., std::round(rate*delayMs/1000)));
    const double alpha = 1/(1+rate/(2*pi*c.crossfeedCutoffHz));
    auto expected = input; double low[2]{};
    for (size_t frame = 0; frame < input.size()/2; ++frame) {
      for (int ch = 0; ch < 2; ++ch) {
        // Custom keeps its original float delay storage, also for double callers.
        const double delayed = frame < delay ? 0 : static_cast<float>(input[(frame-delay)*2+ch]);
        low[ch] += alpha*(delayed-low[ch]);
      }
      for (int ch = 0; ch < 2; ++ch)
        expected[frame*2+ch] = static_cast<Sample>(std::clamp(double(input[frame*2+ch])*(1-.08*c.crossfeedStrength)+low[1-ch]*.38*c.crossfeedStrength, -4., 4.));
    }
    CrossfeedProcessor p; setup(p, c, rate); auto output = input; process(p, output, true);
    check(error(output, expected) < (std::is_same_v<Sample, float> ? 6e-8 : 2e-14),
          "custom retains the existing integer delay, one-pole, gains and float delay precision");
    // Changing the delay on a prepared object must configure the new ring.
    auto changed = c; changed.crossfeedDelayMs = delayMs == 2 ? .05 : 2;
    p.configure(changed); output = input; process(p, output);
    CrossfeedProcessor fresh; setup(fresh, changed, rate); auto other = input; process(fresh, other);
    check(output == other, "custom parameter changes rebuild and reset the prepared delay immediately");
  }
}

void callbackAllocations() {
  for (const auto algorithm : {CrossfeedAlgorithm::Custom, CrossfeedAlgorithm::Bauer, CrossfeedAlgorithm::Bs2b, CrossfeedAlgorithm::Meier}) {
    CrossfeedProcessor p; setup(p, config(algorithm, .75), 48000);
    std::array<float, 512> f{}; std::array<double, 512> d{};
    cppAllocations = cppReleases = cAllocations = cReleases = 0;
    tracking = true;
    for (size_t block = 0; block < 30*48000/256; ++block) {
      f[0] = .125f; d[1] = .2345678912345678;
      p.process(f.data(), 256); p.processDouble(d.data(), 256);
      if (block % 17 == 0) p.reset();
    }
    tracking = false;
    std::printf("callback algorithm=%d cppAllocations=%zu cppReleases=%zu cAllocations=%zu cReleases=%zu\n",
                int(algorithm), cppAllocations, cppReleases, cAllocations, cReleases);
    check(cppAllocations == 0 && cppReleases == 0 && cAllocations == 0 && cReleases == 0,
          "30-second-equivalent float/double callbacks and reset allocate and release no memory");
  }
}

void aliasesAndHeadroom() {
  const auto input = stimulus<double>();
  CrossfeedProcessor bauer, bs2b; setup(bauer, config(CrossfeedAlgorithm::Bauer), 48000); setup(bs2b, config(CrossfeedAlgorithm::Bs2b), 48000);
  auto a = input, b = input; process(bauer, a); process(bs2b, b);
  check(a == b, "Bauer and BS2B remain aliases of the same official default, not invented separate algorithms");
  double residual = 0; for (double value : a) residual = std::max(residual, std::abs(value-static_cast<float>(value)));
  check(residual > 1e-10, "named double processing retains values beyond float precision");
  for (const auto& profile : profiles) {
    CrossfeedProcessor p; setup(p, config(profile.algorithm), 48000);
    std::vector<double> mono(8192*2, 1.5); process(p, mono);
    check(std::abs(mono[mono.size()-1]-1.5) < 2e-13 && mono[mono.size()-1] == mono[mono.size()-2],
          "normalized mono DC retains DSP headroom instead of adding an implicit full-scale limiter");
    auto data = input; data.push_back(123.456789123); data.push_back(-234.567891234);
    p.reset(); p.processDouble(data.data(), input.size()/2);
    check(data[data.size()-2] == 123.456789123 && data.back() == -234.567891234,
          "double processing never touches samples beyond frameCount times two");
  }
}
}  // namespace

int main() {
  compareUpstream<float>(); compareUpstream<double>();
  frequencyResponse<float>(); frequencyResponse<double>();
  lifecycle<float>(); lifecycle<double>();
  customCompatibility<float>(); customCompatibility<double>();
  aliasesAndHeadroom(); callbackAllocations();
  std::printf("{\"suite\":\"crossfeed-response\",\"checks\":%d,\"failures\":%d,\"maxOracleFloatError\":%.12g,\"maxOracleDoubleError\":%.12g,\"maxComplexTransferError\":%.12g}\n",
              checks, failures, maximumOracleFloat, maximumOracleDouble, maximumTransfer);
  return failures ? 1 : 0;
}
