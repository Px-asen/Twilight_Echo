#include "../dsp/CrossfeedProcessor.h"
#include "../dsp/DspWorkspaceProcessors.h"
#include "../third_party/bs2b/upstream/bs2b.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdio>
#include <limits>
#include <numbers>
#include <vector>

using namespace twilight::audio;

namespace {
constexpr double pi = std::numbers::pi;
using Complex = std::complex<double>;
int checks = 0, failures = 0;

void check(bool result, const char* label) {
  ++checks;
  failures += !result;
  std::printf("%s %s\n", result ? "PASS" : "FAIL", label);
}
double linear(double db) { return std::pow(10.0, db / 20); }
AudioFormat format(int rate, int channels) {
  AudioFormat f; f.sampleRate = rate; f.channelCount = channels; return f;
}
void setup(IAudioProcessor& p, const DspConfig& c, int rate, int channels) {
  p.configure(c); p.prepare(format(rate, channels));
}
void process(IAudioProcessor& p, std::vector<float>& data, int channels, bool fragmented = false) {
  const size_t frames = data.size() / channels;
  if (!fragmented) { p.process(data.data(), frames); return; }
  constexpr size_t sizes[] = {1, 17, 128, 3, 511};
  for (size_t offset = 0, block = 0; offset < frames; ++block) {
    const auto count = std::min(sizes[block % 5], frames - offset);
    p.process(data.data() + offset * channels, count); offset += count;
  }
}
double maxError(const std::vector<float>& a, const std::vector<float>& b) {
  double error = 0;
  for (size_t i = 0; i < a.size(); ++i) {
    if (!std::isfinite(a[i]) || !std::isfinite(b[i])) return std::numeric_limits<double>::infinity();
    error = std::max(error, std::abs(double(a[i]) - b[i]));
  }
  return error;
}
std::vector<float> signal(int rate, int channels, double hz, double amplitude, int channel = 0) {
  std::vector<float> data(static_cast<size_t>(rate) * channels);
  for (int n = 0; n < rate; ++n)
    data[static_cast<size_t>(n) * channels + channel] = static_cast<float>(amplitude * std::sin(2*pi*hz*n/rate));
  return data;
}
Complex fit(const std::vector<float>& data, int rate, int channels, int channel, double hz, double amplitude) {
  Complex sum{};
  // Last quarter-second after 0.75 s settling; all probe frequencies have
  // whole cycles in this interval. Fit the actual float-output waveform.
  for (int n = rate * 3 / 4; n < rate; ++n) {
    if (!std::isfinite(data[static_cast<size_t>(n)*channels + channel]))
      return Complex(std::numeric_limits<double>::infinity(), 0);
    const double angle = 2*pi*hz*n/rate;
    sum += double(data[static_cast<size_t>(n)*channels + channel]) * Complex(std::sin(angle), std::cos(angle));
  }
  return sum * (2.0 / ((rate - rate * 3 / 4) * amplitude));
}
void checkHistory(IAudioProcessor& p, const std::vector<float>& input, int channels, const char* label) {
  p.reset(); auto whole = input; process(p, whole, channels);
  p.reset(); auto blocks = input; process(p, blocks, channels, true);
  check(whole == blocks, label);
  p.reset(); blocks = input; process(p, blocks, channels);
  check(whole == blocks, "reset returns every filter and delay history to its initial state");
}

void stereoResponse() {
  double maximum = 0;
  for (double width : {0., 1., 2.}) for (double balance : {-1., -0.4, 0., 0.65, 1.})
    for (int gains = 0; gains < 2; ++gains) for (int flags = 0; flags < 16; ++flags) {
      DspConfig c; c.enabled = c.stereoFieldEnabled = true;
      c.stereoWidth = width; c.stereoBalance = balance;
      c.stereoMidGainDb = gains ? -3 : 0; c.stereoSideGainDb = gains ? 6 : 0;
      c.stereoSwap = flags & 1; c.stereoInvertLeft = flags & 2;
      c.stereoInvertRight = flags & 4; c.stereoMono = flags & 8;
      // Construct a 2x2 transfer matrix: balance * M/S * polarity * swap.
      // This independently exercises all combinations, not just the same
      // sequence of scalar operations used by the production processor.
      const double mid = linear(c.stereoMidGainDb), side = c.stereoMono ? 0 : width * linear(c.stereoSideGainDb);
      const double mix[2][2] = {{(mid+side)/2, (mid-side)/2}, {(mid-side)/2, (mid+side)/2}};
      const double attenuation[] = {balance > 0 ? 1-balance : 1, balance < 0 ? 1+balance : 1};
      double matrix[2][2]{};
      for (int out = 0; out < 2; ++out) for (int route = 0; route < 2; ++route) {
        const bool inverted = route == 0 ? c.stereoInvertLeft : c.stereoInvertRight;
        matrix[out][c.stereoSwap ? 1-route : route] = attenuation[out] * mix[out][route] * (inverted ? -1 : 1);
      }
      std::vector<float> input{0.125f, 0, 0, -0.25f, 0.25f, 0.25f, -0.5f, 0.5f, 0.125f, -0.375f};
      auto expected = input;
      for (size_t i = 0; i < input.size(); i += 2) for (int out = 0; out < 2; ++out)
        expected[i+out] = static_cast<float>(matrix[out][0]*input[i] + matrix[out][1]*input[i+1]);
      StereoFieldProcessor p; setup(p, c, 48000, 2); auto output = input; process(p, output, 2, true);
      const double error = maxError(output, expected); maximum = std::max(maximum, error);
      check(p.isActive() && error < 2e-7, "stereo basis/mid/side/balance/swap/polarity match the independent transfer matrix");
    }
  std::printf("stereo-matrix combinations=480 maxSampleError=%.12g\n", maximum);
  DspConfig c; c.enabled = c.stereoFieldEnabled = true;
  for (int channels : {1, 3, 8}) {
    StereoFieldProcessor p; setup(p, c, 48000, channels);
    std::vector<float> data(37*channels, 0.125f), original = data; process(p, data, channels);
    check(!p.isActive() && data == original, "stereo processor leaves non-stereo formats exactly unchanged");
  }
  StereoFieldProcessor p; setup(p, c, 48000, 2);
  std::vector<float> data{0.25f, -0.5f, -0.125f, 0.75f}, original = data; process(p, data, 2);
  check(data == original, "default stereo controls have exact unit transfer");
  c.enabled = false; setup(p, c, 48000, 2); data = original; process(p, data, 2);
  check(data == original, "disabled stereo processor is exact bypass");
}

void matrixResponse() {
  for (int channels : {1, 2, 6, 8}) {
    DspConfig c; c.enabled = c.channelMatrixEnabled = true;
    for (int row = 0; row < channels; ++row) for (int column = 0; column < channels; ++column)
      c.channelMatrix.push_back(((row*3 + column*5) % 11 - 5) / 16.0);
    // One independent unit-basis frame per input reveals row/column order.
    std::vector<float> input(static_cast<size_t>(channels)*channels), expected(input.size());
    for (int frame = 0; frame < channels; ++frame) {
      input[frame*channels + frame] = 0.25f;
      for (int out = 0; out < channels; ++out)
        expected[frame*channels + out] = static_cast<float>(0.25L*c.channelMatrix[out*channels + frame]);
    }
    ChannelMatrixProcessor p; setup(p, c, 48000, channels); auto output = input; process(p, output, channels, true);
    check(output == expected, "nonsymmetric channel matrix routes every input basis in row-major output order");
    for (int n = 0; n < channels*channels; ++n) input[n] = static_cast<float>((n % 17 - 8) / 32.0);
    for (int frame = 0; frame < channels; ++frame) for (int out = 0; out < channels; ++out) {
      long double sum = 0;
      for (int in = 0; in < channels; ++in) sum += (long double)input[frame*channels + in]*c.channelMatrix[out*channels + in];
      expected[frame*channels + out] = static_cast<float>(sum);
    }
    output = input; process(p, output, channels);
    check(output == expected, "dense simultaneous channel mixing matches independent long-double matrix multiplication");
    c.enabled = false; p.configure(c); output = input; process(p, output, channels);
    check(output == input, "disabled channel matrix is exact bypass");
  }
}

void stripResponse() {
  constexpr double delays[] = {0, 0.01, 0.25, 1.1, 3.3, 250, 2.5, 0};
  constexpr double gains[] = {0, -6, 3, -24, 12, -3, -60, 24};
  for (int rate : {44100, 48000, 96000}) for (int channels : {1, 2, 6, 8}) {
    DspConfig c; c.enabled = c.channelStripEnabled = true;
    for (int ch = 0; ch < channels; ++ch)
      c.channelStripChannels.push_back({gains[ch], delays[ch], ch % 2 == 1, ch == 7});
    const size_t frames = static_cast<size_t>(rate)*3/10;
    std::vector<float> input(frames*channels), expected(input.size());
    for (size_t frame = 0; frame < frames; ++frame) for (int ch = 0; ch < channels; ++ch)
      input[frame*channels + ch] = static_cast<float>((int((frame*7 + ch*13) % 127)-63) / 512.0);
    for (size_t frame = 0; frame < frames; ++frame) for (int ch = 0; ch < channels; ++ch) {
      const auto delay = static_cast<size_t>(std::llround(delays[ch]*rate/1000));
      const double source = frame >= delay ? input[(frame-delay)*channels + ch] : 0;
      expected[frame*channels + ch] = static_cast<float>(ch == 7 ? 0 : source*linear(gains[ch])*(ch % 2 ? -1 : 1));
    }
    ChannelStripProcessor p; setup(p, c, rate, channels); auto output = input; process(p, output, channels, true);
    const double error = maxError(output, expected);
    std::printf("channel-strip rate=%d channels=%d maxSampleError=%.12g\n", rate, channels, error);
    check(error < 2e-7, "per-channel rounded delay, gain, polarity and mute match indexed source samples through ring wraps");
    checkHistory(p, input, channels, "channel calibration is exact across irregular block boundaries");
    c.enabled = false; p.configure(c); output = input; process(p, output, channels);
    check(output == input, "disabled channel calibration is exact bypass");
  }
  // The existing short-list contract repeats the final configured strip.
  DspConfig c; c.enabled = c.channelStripEnabled = true;
  c.channelStripChannels = {{0, 0, false, false}, {-6, 1, true, false}};
  ChannelStripProcessor p; setup(p, c, 48000, 8);
  std::vector<float> data(96*8, 0); for (int ch = 0; ch < 8; ++ch) data[ch] = 0.5f;
  process(p, data, 8, true);
  bool correct = data[0] == 0.5f;
  for (int ch = 1; ch < 8; ++ch) correct &= data[ch] == 0 &&
      std::abs(data[48*8+ch] + 0.5*linear(-6)) < 2e-8;
  check(correct, "short channel-strip lists preserve the existing repeat-last setting contract");
}

struct Crossover { Complex low, high; };
Crossover lr4(int rate, double cutoff, double hz) {
  // Bilinear transform of the analog squared Butterworth transfer, rather
  // than the production biquad coefficient or state implementation.
  const Complex s(0, std::tan(pi*hz/rate)/std::tan(pi*cutoff/rate));
  const auto denominator = s*s + std::sqrt(2.0)*s + 1.0;
  return {std::pow(1.0/denominator, 2), std::pow(s*s/denominator, 2)};
}

void bassResponse() {
  double maximum = 0;
  for (int rate : {44100, 48000, 96000}) for (double cutoff : {80., 200.})
    for (double hz : {20., 40., 80., 200., 1000., 10000.}) {
      DspConfig c; c.enabled = c.bassManagementEnabled = true;
      c.bassCrossoverHz = cutoff; c.bassLfeGainDb = -3;
      BassManagementProcessor p; setup(p, c, rate, 6);
      auto data = signal(rate, 6, hz, 0.125); process(p, data, 6, true);
      const auto reference = lr4(rate, cutoff, hz);
      const auto high = fit(data, rate, 6, 0, hz, 0.125), low = fit(data, rate, 6, 3, hz, 0.125);
      const double error = std::max(std::abs(high-reference.high), std::abs(low-reference.low*linear(-3)));
      maximum = std::max(maximum, error);
      std::printf("bass-response rate=%d cutoffHz=%.0f frequencyHz=%.0f highMagnitude=%.12g lowMagnitude=%.12g complexError=%.12g\n",
                  rate, cutoff, hz, std::abs(high), std::abs(low), error);
      check(error < 2e-6, "bass main/LFE magnitude and phase follow independent LR4 high/low transfers");
    }
  std::printf("bass-summary maxComplexError=%.12g\n", maximum);
  for (int channels : {3, 4, 5, 6, 8}) {
    const int lfe = channels >= 6 ? 3 : channels-1;
    DspConfig c; c.enabled = c.bassManagementEnabled = true; c.bassLfeGainDb = 6;
    for (bool redirect : {false, true}) {
      c.bassRedirectLfe = redirect; BassManagementProcessor p; setup(p, c, 48000, channels);
      std::vector<float> input(48000*channels);
      for (int n = 0; n < 48000; ++n) {
        const float tone = static_cast<float>(0.0625*std::sin(2*pi*80*n/48000));
        for (int ch = 0; ch < channels; ++ch) input[n*channels+ch] = ch == lfe ? tone*0.5f : tone;
      }
      auto output = input; process(p, output, channels, true);
      const auto reference = lr4(48000, 80, 80);
      const auto lfeResponse = fit(output, 48000, channels, lfe, 80, 0.0625);
      const Complex expected = redirect ? (Complex(0.5,0) + double(channels-1)*reference.low)*linear(6) : Complex(0.5,0);
      check(std::abs(lfeResponse-expected) < 2e-6, "bass layout chooses the documented LFE index and sums mains without normalization");
      check(std::abs(fit(output,48000,channels,0,80,0.0625)-reference.high) < 2e-6,
            "redirect-off keeps the original main high-pass while leaving LFE gain unapplied");
      checkHistory(p, input, channels, "bass filter histories are exact across irregular block boundaries");
    }
  }
  DspConfig c; c.enabled = c.bassManagementEnabled = true;
  for (int channels : {1, 2}) {
    BassManagementProcessor p; setup(p, c, 48000, channels);
    std::vector<float> data(64*channels, 0.25f), original = data; process(p, data, channels);
    check(!p.isActive() && data == original, "bass management bypasses mono and stereo without an LFE layout");
  }
}

Complex shelf(int rate, double cutoff, double gainDb, double hz, bool high) {
  const double a = std::pow(10.0, gainDb/40);
  const Complex s(0, std::tan(pi*hz/rate)/std::tan(pi*cutoff/rate));
  const auto root = std::sqrt(2*a)*s;
  return high ? a*(a*s*s+root+1.0)/(s*s+root+a) : a*(s*s+root+a)/(a*s*s+root+1.0);
}
void contourResponse() {
  double maximum = 0;
  for (int rate : {44100, 48000, 96000}) for (double amount : {0.25, 0.6, 1.})
    for (double referenceVolume : {0., 0.5, 0.75}) for (double hz : {20., 104., 1000., 8000., 16000.}) {
      DspConfig c; c.enabled = c.loudnessContourEnabled = true;
      c.loudnessContourAmount = amount; c.loudnessReferenceVolume = referenceVolume;
      LoudnessContourProcessor p; setup(p, c, rate, 1); auto data = signal(rate, 1, hz, 0.0625);
      process(p, data, 1, true); const auto measured = fit(data, rate, 1, 0, hz, 0.0625);
      const double compensation = amount*(1-referenceVolume);
      const auto expected = shelf(rate,105,compensation*12,hz,false)*shelf(rate,8000,compensation*5,hz,true);
      const double error = std::abs(measured-expected); maximum = std::max(maximum,error);
      std::printf("contour-response rate=%d amount=%.2f referenceVolume=%.2f frequencyHz=%.0f expectedDb=%.12g measuredDb=%.12g complexError=%.12g\n",
                  rate,amount,referenceVolume,hz,20*std::log10(std::abs(expected)),20*std::log10(std::abs(measured)),error);
      check(p.isActive() && error < 2e-6, "loudness contour follows the fixed S=1 low/high shelf transfer scaled by amount and reference volume");
    }
  std::printf("contour-summary maxComplexError=%.12g\n", maximum);
  DspConfig c; c.enabled = c.loudnessContourEnabled = true; c.loudnessContourAmount = 0.6;
  LoudnessContourProcessor p; setup(p,c,48000,8);
  auto input = signal(48000,8,80,0.125);
  for (int n=0;n<48000;++n) for(int ch=1;ch<8;++ch) input[n*8+ch] = std::ldexp(input[n*8],-ch)*(ch%2 ? -1:1);
  checkHistory(p,input,8,"loudness shelves preserve every channel's history across irregular blocks");
  auto output=input; p.reset(); process(p,output,8);
  bool linked=true;
  for(int n=0;n<48000;++n) for(int ch=1;ch<8;++ch) linked &= output[n*8+ch] == std::ldexp(output[n*8],-ch)*(ch%2 ? -1:1);
  check(linked,"loudness shelves keep channel scaling and polarity independent");
  for (int off=0;off<3;++off) {
    c.enabled=off!=0; c.loudnessContourAmount=off==1 ? 0:0.6; c.loudnessReferenceVolume=off==2 ? 1:0.75;
    p.configure(c); output=input; process(p,output,8);
    check(!p.isActive() && output==input,"disabled/zero-amount/full-reference loudness contour is exact bypass");
  }
}

struct CrossfeedRecipe { CrossfeedAlgorithm algorithm; double delayMs, cutoff, directDrop, crossGain; };
constexpr CrossfeedRecipe recipes[] = {
  {CrossfeedAlgorithm::Custom,0.35,700,0.08,0.38},
  {CrossfeedAlgorithm::Custom,1.1,1800,0.08,0.38},
  {CrossfeedAlgorithm::Bauer,0,700,0,0},
  {CrossfeedAlgorithm::Bs2b,0,700,0,0},
  {CrossfeedAlgorithm::Meier,0,650,0,0}
};
void crossfeedResponse() {
  double maximum=0;
  for(int rate : {44100,48000,96000}) for(size_t r=0;r<std::size(recipes);++r)
    for(double strength : {0.25,0.75,1.}) {
      const auto recipe=recipes[r]; DspConfig c; c.enabled=c.crossfeedEnabled=true;
      c.crossfeedAlgorithm=recipe.algorithm; c.crossfeedStrength=strength;
      c.crossfeedDelayMs=recipe.delayMs; c.crossfeedCutoffHz=recipe.cutoff;
      CrossfeedProcessor p; setup(p,c,rate,2);
      const auto delay=static_cast<size_t>(std::llround(rate*recipe.delayMs/1000));
      const double alpha=1.0/(1+rate/(2*pi*recipe.cutoff));
      const double direct=1-recipe.directDrop*strength,cross=recipe.crossGain*strength;
      const bool named=recipe.algorithm!=CrossfeedAlgorithm::Custom;
      t_bs2bd referenceState{};
      bs2b_set_srate(&referenceState,rate);
      bs2b_set_level(&referenceState,recipe.algorithm==CrossfeedAlgorithm::Meier ? BS2B_JMEIER_CLEVEL : BS2B_DEFAULT_CLEVEL);
      std::vector<float> impulse((delay+256)*2),expected(impulse.size()); impulse[0]=0.25f;
      if (named) {
        std::vector<double> wet(impulse.begin(),impulse.end());
        bs2b_cross_feed_d(&referenceState,wet.data(),static_cast<int>(wet.size()/2));
        for(size_t n=0;n<expected.size();++n) expected[n]=static_cast<float>((1-strength)*impulse[n]+strength*wet[n]);
      } else {
        expected[0]=static_cast<float>(0.25*direct);
        for(size_t n=delay;n<expected.size()/2;++n) expected[n*2+1]=static_cast<float>(0.25*cross*alpha*std::pow(1-alpha,double(n-delay)));
      }
      auto output=impulse; process(p,output,2,true);
      check(maxError(output,expected)<2e-8,"crossfeed impulse follows the original named profile or unchanged analytic custom delay");
      p.reset(); for(size_t n=0;n<impulse.size()/2;++n) std::swap(impulse[n*2],impulse[n*2+1]);
      output=impulse; process(p,output,2,true);
      for(size_t n=0;n<expected.size()/2;++n) std::swap(expected[n*2],expected[n*2+1]);
      check(maxError(output,expected)<2e-8,"crossfeed is left/right reciprocal with no shared-channel state leakage");
      for(double hz : {100.,700.,1000.,8000.,18000.}) {
        p.reset(); auto data=signal(rate,2,hz,0.125); process(p,data,2,true);
        const auto z=std::polar(1.0,-2*pi*hz/rate);
        const auto reference=named ? strength*referenceState.gain*referenceState.a0_lo/(1.0-referenceState.b1_lo*z)
            : cross*alpha*std::pow(z,int(delay))/(1.0-(1-alpha)*z);
        const auto referenceDirect=named ? 1.0-strength+strength*referenceState.gain*
            (referenceState.a0_hi+referenceState.a1_hi*z)/(1.0-referenceState.b1_hi*z) : Complex(direct,0);
        const auto measured=fit(data,rate,2,1,hz,0.125),unchanged=fit(data,rate,2,0,hz,0.125);
        const double error=std::max(std::abs(measured-reference),std::abs(unchanged-referenceDirect));
        maximum=std::max(maximum,error);
        std::printf("crossfeed-response rate=%d recipe=%zu strength=%.2f delayFrames=%zu frequencyHz=%.0f expectedCrossMagnitude=%.12g measuredCrossMagnitude=%.12g complexError=%.12g\n",
                    rate,r,strength,delay,hz,std::abs(reference),std::abs(measured),error);
        check(error<2e-6,"crossfeed direct/cross transfer matches the original named or analytic custom z-domain reference");
      }
    }
  std::printf("crossfeed-summary maxComplexError=%.12g\n",maximum);
  DspConfig c; c.enabled=c.crossfeedEnabled=true; c.crossfeedStrength=0.75;
  CrossfeedProcessor p; setup(p,c,48000,2); auto input=signal(48000,2,700,0.125);
  checkHistory(p,input,2,"crossfeed delay and low-pass histories are exact across irregular blocks");
  for(int channels : {1,6,8}) {
    setup(p,c,48000,channels); std::vector<float> data(64*channels,0.25f),original=data; process(p,data,channels);
    check(!p.isActive() && data==original,"crossfeed leaves non-stereo formats exactly unchanged");
  }
  c.crossfeedStrength=0; setup(p,c,48000,2); auto output=input; process(p,output,2);
  check(!p.isActive() && output==input,"zero crossfeed strength is exact bypass");
}
} // namespace

int main() {
  stereoResponse(); matrixResponse(); stripResponse(); bassResponse(); contourResponse(); crossfeedResponse();
  std::printf("spatial-response checks=%d failures=%d\n",checks,failures);
  return failures ? 1:0;
}
