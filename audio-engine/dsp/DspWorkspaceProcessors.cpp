#include "DspWorkspaceProcessors.h"

#include <algorithm>
#include <bit>
#include <cmath>
#include <limits>
#include <numbers>

#if defined(TAE_HAS_EBUR128)
#include "../analysis/Ebur128ChannelLayout.h"
#endif

namespace twilight::audio {
namespace {

double dbToLinear(double db) {
  return std::pow(10.0, db / 20.0);
}

double coefficientForMs(double ms, int sampleRate) {
  const double frames = std::max(1.0, ms * static_cast<double>(std::max(1, sampleRate)) / 1000.0);
  return std::exp(-1.0 / frames);
}

double linearToDb(double value) {
  return value <= 1.0e-12 ? -120.0 : 20.0 * std::log10(value);
}

template <typename Biquad>
Biquad normalizeBiquad(double b0, double b1, double b2, double a0, double a1, double a2) {
  if (std::abs(a0) <= 1.0e-12) return {};
  return {b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0};
}

template <typename Biquad>
Biquad makeDspBiquad(DspFilterType type, int sampleRate, double frequency, double gainDb, double q) {
  const double safeSampleRate = static_cast<double>(std::max(1, sampleRate));
  const double safeFrequency = std::clamp(frequency, 10.0, safeSampleRate * 0.48);
  const double safeQ = std::clamp(q, 0.1, 20.0);
  const double w0 = 2.0 * std::numbers::pi * safeFrequency / safeSampleRate;
  const double sinW0 = std::sin(w0);
  const double cosW0 = std::cos(w0);
  const double alpha = sinW0 / (2.0 * safeQ);
  const double a = std::pow(10.0, std::clamp(gainDb, -36.0, 36.0) / 40.0);

  switch (type) {
    case DspFilterType::Peak:
      return normalizeBiquad<Biquad>(
          1.0 + alpha * a, -2.0 * cosW0, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cosW0,
          1.0 - alpha / a);
    case DspFilterType::LowShelf: {
      const double sqrtA = std::sqrt(a);
      const double shelfAlpha = sinW0 / 2.0 * std::sqrt(2.0);
      return normalizeBiquad<Biquad>(
          a * ((a + 1.0) - (a - 1.0) * cosW0 + 2.0 * sqrtA * shelfAlpha),
          2.0 * a * ((a - 1.0) - (a + 1.0) * cosW0),
          a * ((a + 1.0) - (a - 1.0) * cosW0 - 2.0 * sqrtA * shelfAlpha),
          (a + 1.0) + (a - 1.0) * cosW0 + 2.0 * sqrtA * shelfAlpha,
          -2.0 * ((a - 1.0) + (a + 1.0) * cosW0),
          (a + 1.0) + (a - 1.0) * cosW0 - 2.0 * sqrtA * shelfAlpha);
    }
    case DspFilterType::HighShelf: {
      const double sqrtA = std::sqrt(a);
      const double shelfAlpha = sinW0 / 2.0 * std::sqrt(2.0);
      return normalizeBiquad<Biquad>(
          a * ((a + 1.0) + (a - 1.0) * cosW0 + 2.0 * sqrtA * shelfAlpha),
          -2.0 * a * ((a - 1.0) + (a + 1.0) * cosW0),
          a * ((a + 1.0) + (a - 1.0) * cosW0 - 2.0 * sqrtA * shelfAlpha),
          (a + 1.0) - (a - 1.0) * cosW0 + 2.0 * sqrtA * shelfAlpha,
          2.0 * ((a - 1.0) - (a + 1.0) * cosW0),
          (a + 1.0) - (a - 1.0) * cosW0 - 2.0 * sqrtA * shelfAlpha);
    }
    case DspFilterType::LowPass:
      return normalizeBiquad<Biquad>(
          (1.0 - cosW0) * 0.5, 1.0 - cosW0, (1.0 - cosW0) * 0.5, 1.0 + alpha,
          -2.0 * cosW0, 1.0 - alpha);
    case DspFilterType::HighPass:
      return normalizeBiquad<Biquad>(
          (1.0 + cosW0) * 0.5, -(1.0 + cosW0), (1.0 + cosW0) * 0.5, 1.0 + alpha,
          -2.0 * cosW0, 1.0 - alpha);
    case DspFilterType::BandPass:
      return normalizeBiquad<Biquad>(alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * cosW0, 1.0 - alpha);
    case DspFilterType::AllPass:
      return normalizeBiquad<Biquad>(
          1.0 - alpha, -2.0 * cosW0, 1.0 + alpha, 1.0 + alpha, -2.0 * cosW0, 1.0 - alpha);
    case DspFilterType::Notch:
      return normalizeBiquad<Biquad>(1.0, -2.0 * cosW0, 1.0, 1.0 + alpha, -2.0 * cosW0, 1.0 - alpha);
  }
  return {};
}

bool appliesToChannel(uint32_t channelMask, int channel) {
  return (channelMask & (uint32_t{1} << std::min(channel, 31))) != 0;
}

#if defined(TAE_HAS_EBUR128)
void destroyEburState(void*& state) {
  auto* ebur = static_cast<ebur128_state*>(state);
  if (ebur) ebur128_destroy(&ebur);
  state = nullptr;
}

void createEburState(void*& state, const AudioFormat& format, bool active) {
  destroyEburState(state);
  if (!active || format.sampleRate <= 0 || format.channelCount <= 0) return;
  // Fixed loudness histograms avoid libebur128 allocating a history node on
  // the audio thread for every gated block throughout an unbounded session.
  constexpr int kMeterModes = EBUR128_MODE_I | EBUR128_MODE_LRA | EBUR128_MODE_M |
      EBUR128_MODE_S | EBUR128_MODE_HISTOGRAM;
  auto* ebur = ebur128_init(
      static_cast<unsigned int>(std::clamp(format.channelCount, 1, 8)),
      static_cast<unsigned long>(format.sampleRate),
      kMeterModes);
  if (ebur) applyEbur128ChannelLayout(ebur, format.channelMask);
  state = ebur;
}
#else
void destroyEburState(void*& state) {
  state = nullptr;
}

void createEburState(void*& state, const AudioFormat&, bool) {
  state = nullptr;
}
#endif

BassManagementProcessor::Biquad makeButterworth(int sampleRate, double frequency, bool highpass) {
  const double normalizedFrequency = std::clamp(frequency, 20.0, static_cast<double>(sampleRate) * 0.45);
  const double omega = 2.0 * std::numbers::pi * normalizedFrequency / std::max(1, sampleRate);
  const double cosine = std::cos(omega);
  const double alpha = std::sin(omega) / (2.0 * std::sqrt(0.5));
  const double a0 = 1.0 + alpha;
  if (highpass) {
    return {(1.0 + cosine) * 0.5 / a0, -(1.0 + cosine) / a0, (1.0 + cosine) * 0.5 / a0,
            -2.0 * cosine / a0, (1.0 - alpha) / a0};
  }
  return {(1.0 - cosine) * 0.5 / a0, (1.0 - cosine) / a0, (1.0 - cosine) * 0.5 / a0,
          -2.0 * cosine / a0, (1.0 - alpha) / a0};
}

}  // namespace

void ChannelMatrixProcessor::configure(const DspConfig& config) {
  config_ = config;
  rebuild();
}

void ChannelMatrixProcessor::prepare(const AudioFormat& format) {
  format_ = format;
  rebuild();
}

void ChannelMatrixProcessor::rebuild() {
  const int channels = std::clamp(format_.channelCount, 1, 8);
  const size_t expected = static_cast<size_t>(channels * channels);
  active_ = config_.enabled && config_.channelMatrixEnabled && config_.channelMatrix.size() == expected;
  matrix_ = active_ ? config_.channelMatrix : std::vector<double>{};
}

void ChannelMatrixProcessor::process(float* samples, size_t frameCount) {
  if (!active_ || !samples) return;
  const int channels = std::clamp(format_.channelCount, 1, 8);
  for (size_t frame = 0; frame < frameCount; ++frame) {
    float* current = samples + frame * static_cast<size_t>(channels);
    for (int channel = 0; channel < channels; ++channel) frameScratch_[static_cast<size_t>(channel)] = current[channel];
    for (int output = 0; output < channels; ++output) {
      double value = 0.0;
      for (int input = 0; input < channels; ++input) {
        value += matrix_[static_cast<size_t>(output * channels + input)] * frameScratch_[static_cast<size_t>(input)];
      }
      current[output] = static_cast<float>(std::clamp(value, -8.0, 8.0));
    }
  }
}

void ChannelStripProcessor::configure(const DspConfig& config) {
  config_ = config;
  rebuild();
}

void ChannelStripProcessor::prepare(const AudioFormat& format) {
  format_ = format;
  rebuild();
}

void ChannelStripProcessor::rebuild() {
  const int channels = std::clamp(format_.channelCount, 1, 8);
  active_ = config_.enabled && config_.channelStripEnabled && !config_.channelStripChannels.empty() &&
            format_.sampleRate > 0;
  gain_.fill(1.0);
  inverted_.fill(false);
  muted_.fill(false);
  delayFrames_.fill(0);
  if (!active_) {
    delayBuffer_.clear();
    ringFrames_ = 1;
    writeFrame_ = 0;
    return;
  }
  size_t maximumDelay = 0;
  for (int channel = 0; channel < channels; ++channel) {
    const auto& strip = config_.channelStripChannels[std::min<size_t>(static_cast<size_t>(channel), config_.channelStripChannels.size() - 1)];
    gain_[static_cast<size_t>(channel)] = dbToLinear(std::clamp(strip.gainDb, -60.0, 24.0));
    inverted_[static_cast<size_t>(channel)] = strip.polarityInverted;
    muted_[static_cast<size_t>(channel)] = strip.muted;
    delayFrames_[static_cast<size_t>(channel)] = static_cast<size_t>(std::round(
        std::clamp(strip.delayMs, 0.0, 250.0) * static_cast<double>(format_.sampleRate) / 1000.0));
    maximumDelay = std::max(maximumDelay, delayFrames_[static_cast<size_t>(channel)]);
  }
  ringFrames_ = std::max<size_t>(1, maximumDelay + 1);
  delayBuffer_.assign(ringFrames_ * static_cast<size_t>(channels), 0.0f);
  writeFrame_ = 0;
}

void ChannelStripProcessor::process(float* samples, size_t frameCount) {
  if (!active_ || !samples) return;
  const int channels = std::clamp(format_.channelCount, 1, 8);
  for (size_t frame = 0; frame < frameCount; ++frame) {
    float* current = samples + frame * static_cast<size_t>(channels);
    for (int channel = 0; channel < channels; ++channel) {
      const size_t index = static_cast<size_t>(channel);
      delayBuffer_[writeFrame_ * static_cast<size_t>(channels) + index] = current[channel];
      const size_t readFrame = (writeFrame_ + ringFrames_ - delayFrames_[index]) % ringFrames_;
      double value = muted_[index] ? 0.0 : delayBuffer_[readFrame * static_cast<size_t>(channels) + index] * gain_[index];
      if (inverted_[index]) value = -value;
      current[channel] = static_cast<float>(std::clamp(value, -8.0, 8.0));
    }
    writeFrame_ = (writeFrame_ + 1) % ringFrames_;
  }
}

void ChannelStripProcessor::reset() {
  std::fill(delayBuffer_.begin(), delayBuffer_.end(), 0.0f);
  writeFrame_ = 0;
}

float BassManagementProcessor::State::process(float input, const Biquad& filter) {
  const double output = filter.b0 * input + z1;
  z1 = filter.b1 * input - filter.a1 * output + z2;
  z2 = filter.b2 * input - filter.a2 * output;
  return static_cast<float>(std::isfinite(output) ? output : 0.0);
}

void BassManagementProcessor::State::reset() {
  z1 = 0.0;
  z2 = 0.0;
}

void BassManagementProcessor::configure(const DspConfig& config) {
  config_ = config;
  rebuild();
}

void BassManagementProcessor::prepare(const AudioFormat& format) {
  format_ = format;
  rebuild();
}

void BassManagementProcessor::rebuild() {
  const int channels = std::clamp(format_.channelCount, 1, 8);
  constexpr uint64_t lfeBit = uint64_t{1} << 3;
  lfeChannel_ = format_.channelMask == 0 ? (channels >= 6 ? 3 : channels - 1) :
      (format_.channelMask & lfeBit) != 0 ? std::popcount(format_.channelMask & (lfeBit - 1)) : -1;
  active_ = config_.enabled && config_.bassManagementEnabled && format_.sampleRate > 0 &&
            format_.channelCount >= 3 && lfeChannel_ >= 0;
  if (!active_) return;
  lowpass_ = makeButterworth(format_.sampleRate, config_.bassCrossoverHz, false);
  highpass_ = makeButterworth(format_.sampleRate, config_.bassCrossoverHz, true);
  lfeGain_ = dbToLinear(std::clamp(config_.bassLfeGainDb, -24.0, 12.0));
  reset();
}

void BassManagementProcessor::process(float* samples, size_t frameCount) {
  if (!active_ || !samples) return;
  const int channels = std::clamp(format_.channelCount, 1, 8);
  for (size_t frame = 0; frame < frameCount; ++frame) {
    float* current = samples + frame * static_cast<size_t>(channels);
    double redirected = 0.0;
    for (int channel = 0; channel < channels; ++channel) {
      if (channel == lfeChannel_) continue;
      float low = current[channel];
      float high = current[channel];
      for (size_t stage = 0; stage < 2; ++stage) {
        low = lowpassState_[static_cast<size_t>(channel)][stage].process(low, lowpass_);
        high = highpassState_[static_cast<size_t>(channel)][stage].process(high, highpass_);
      }
      current[channel] = high;
      redirected += low;
    }
    if (config_.bassRedirectLfe) {
      current[lfeChannel_] = static_cast<float>(std::clamp((current[lfeChannel_] + redirected) * lfeGain_, -8.0, 8.0));
    }
  }
}

void BassManagementProcessor::reset() {
  for (auto& pair : lowpassState_) for (auto& state : pair) state.reset();
  for (auto& pair : highpassState_) for (auto& state : pair) state.reset();
}

float DynamicEqProcessor::State::process(float input, const Biquad& filter) {
  // Direct-form-I expressed as y = x + correction. These histories do not
  // contain old coefficients when gain changes. Subtracting the identity
  // coefficients first also keeps a zero-gain peak filter exactly transparent.
  const double correction = (filter.b0 - 1.0) * input + (filter.b1 - filter.a1) * x1 +
      (filter.b2 - filter.a2) * x2 - filter.a1 * correction1 - filter.a2 * correction2;
  const double output = input + correction;
  x2 = x1; x1 = input;
  correction2 = correction1; correction1 = correction;
  if (!std::isfinite(output)) {
    reset();
    return 0.0f;
  }
  return static_cast<float>(std::clamp(output, -8.0, 8.0));
}

void DynamicEqProcessor::State::reset() {
  x1 = x2 = correction1 = correction2 = 0.0;
}

void DynamicEqProcessor::configure(const DspConfig& config) {
  config_ = config;
  rebuild();
}

void DynamicEqProcessor::prepare(const AudioFormat& format) {
  format_ = format;
  rebuild();
}

void DynamicEqProcessor::rebuild() {
  bandCount_ = 0;
  envelopes_.fill(0.0);
  dynamicGainDb_.fill(0.0);
  attackCoefficient_.fill(0.0);
  releaseCoefficient_.fill(0.0);
  active_ = false;
  if (!config_.enabled || !config_.dynamicEqEnabled || format_.sampleRate <= 0 || format_.channelCount <= 0) return;

  for (const DspDynamicEqBand& source : config_.dynamicEqBands) {
    if (!source.enabled || bandCount_ >= bands_.size()) continue;
    DspDynamicEqBand band = source;
    band.frequency = std::clamp(band.frequency, 10.0, static_cast<double>(format_.sampleRate) * 0.48);
    band.q = std::clamp(band.q, 0.1, 20.0);
    band.thresholdDb = std::clamp(band.thresholdDb, -100.0, 0.0);
    band.ratio = std::clamp(band.ratio, 1.0, 20.0);
    band.rangeDb = std::clamp(band.rangeDb, -24.0, 24.0);
    band.attackMs = std::clamp(band.attackMs, 0.1, 1000.0);
    band.releaseMs = std::clamp(band.releaseMs, 1.0, 5000.0);
    bands_[bandCount_] = band;
    detectorFilters_[bandCount_] = makeDspBiquad<Biquad>(DspFilterType::BandPass, format_.sampleRate, band.frequency, 0.0, band.q);
    filters_[bandCount_] = makeDspBiquad<Biquad>(band.type, format_.sampleRate, band.frequency, band.gainDb, band.q);
    attackCoefficient_[bandCount_] = coefficientForMs(band.attackMs, format_.sampleRate);
    releaseCoefficient_[bandCount_] = coefficientForMs(band.releaseMs, format_.sampleRate);
    ++bandCount_;
  }

  active_ = bandCount_ > 0;
  if (active_) reset();
}

void DynamicEqProcessor::process(float* samples, size_t frameCount) {
  if (!active_ || !samples) return;
  const int channels = std::clamp(format_.channelCount, 1, 8);
  for (size_t frame = 0; frame < frameCount; ++frame) {
    float* current = samples + frame * static_cast<size_t>(channels);
    for (size_t bandIndex = 0; bandIndex < bandCount_; ++bandIndex) {
      const DspDynamicEqBand& band = bands_[bandIndex];
      double peak = 0.0;
      for (int channel = 0; channel < channels; ++channel) {
        if (!appliesToChannel(band.channelMask, channel)) continue;
        const float detected = detectorStates_[bandIndex][static_cast<size_t>(channel)].process(
            current[channel], detectorFilters_[bandIndex]);
        peak = std::max(peak, std::abs(static_cast<double>(detected)));
      }
      const double envelopeCoefficient = peak > envelopes_[bandIndex] ? attackCoefficient_[bandIndex] : releaseCoefficient_[bandIndex];
      envelopes_[bandIndex] = envelopeCoefficient * envelopes_[bandIndex] + (1.0 - envelopeCoefficient) * peak;
      const double overThreshold = std::max(0.0, linearToDb(envelopes_[bandIndex]) - band.thresholdDb);
      const double requestedRange = std::min(std::abs(band.rangeDb), overThreshold * (1.0 - 1.0 / band.ratio));
      dynamicGainDb_[bandIndex] = band.rangeDb < 0.0 ? -requestedRange : requestedRange;
      filters_[bandIndex] = makeDspBiquad<Biquad>(
          band.type,
          format_.sampleRate,
          band.frequency,
          std::clamp(band.gainDb + dynamicGainDb_[bandIndex], -36.0, 36.0),
          band.q);
    }
    for (int channel = 0; channel < channels; ++channel) {
      float value = current[channel];
      for (size_t bandIndex = 0; bandIndex < bandCount_; ++bandIndex) {
        if (!appliesToChannel(bands_[bandIndex].channelMask, channel)) continue;
        value = states_[bandIndex][static_cast<size_t>(channel)].process(value, filters_[bandIndex]);
      }
      current[channel] = value;
    }
  }
}

void DynamicEqProcessor::reset() {
  for (auto& bandStates : states_) for (State& state : bandStates) state.reset();
  for (auto& bandStates : detectorStates_) for (State& state : bandStates) state.reset();
  envelopes_.fill(0.0);
  dynamicGainDb_.fill(0.0);
}

float MultibandCompressorProcessor::State::process(float input, const Biquad& filter) {
  const double output = filter.b0 * input + z1;
  z1 = filter.b1 * input - filter.a1 * output + z2;
  z2 = filter.b2 * input - filter.a2 * output;
  if (!std::isfinite(output)) {
    reset();
    return 0.0f;
  }
  return static_cast<float>(std::clamp(output, -8.0, 8.0));
}

void MultibandCompressorProcessor::State::reset() {
  z1 = 0.0;
  z2 = 0.0;
}

void MultibandCompressorProcessor::configure(const DspConfig& config) {
  config_ = config;
  rebuild();
}

void MultibandCompressorProcessor::prepare(const AudioFormat& format) {
  format_ = format;
  rebuild();
}

void MultibandCompressorProcessor::rebuild() {
  bandCount_ = 0;
  active_ = false;
  envelope_.fill(0.0);
  gain_.fill(1.0);
  attackCoefficient_.fill(0.0);
  releaseCoefficient_.fill(0.0);
  thresholdLinear_.fill(1.0);
  ratio_.fill(1.0);
  makeupLinear_.fill(1.0);
  if (!config_.enabled || !config_.multibandCompressorEnabled || format_.sampleRate <= 0 ||
      config_.multibandCompressorBands.size() < 2) {
    return;
  }

  bandCount_ = std::min<size_t>(4, config_.multibandCompressorBands.size());
  if (config_.multibandCrossoversHz.size() < bandCount_ - 1) {
    bandCount_ = 0;
    return;
  }

  double previousCrossover = 20.0;
  for (size_t crossover = 0; crossover + 1 < bandCount_; ++crossover) {
    const double frequency = std::clamp(
        config_.multibandCrossoversHz[crossover], previousCrossover + 1.0,
        static_cast<double>(format_.sampleRate) * 0.45);
    previousCrossover = frequency;
    lowpass_[crossover] = makeDspBiquad<Biquad>(DspFilterType::LowPass, format_.sampleRate, frequency, 0.0, std::sqrt(0.5));
    highpass_[crossover] = makeDspBiquad<Biquad>(DspFilterType::HighPass, format_.sampleRate, frequency, 0.0, std::sqrt(0.5));
    if (crossover > 0) {
      // LP4 + HP4 is a second-order all-pass. Earlier bands must acquire
      // the same phase rotation as the residual split at this crossover.
      phaseCorrection_[crossover - 1] = makeDspBiquad<Biquad>(
          DspFilterType::AllPass, format_.sampleRate, frequency, 0.0, std::sqrt(0.5));
    }
  }

  bool anyBandEnabled = false;
  for (size_t bandIndex = 0; bandIndex < bandCount_; ++bandIndex) {
    DspMultibandCompressorBand band = config_.multibandCompressorBands[bandIndex];
    band.thresholdDb = std::clamp(band.thresholdDb, -80.0, 0.0);
    band.ratio = std::clamp(band.ratio, 1.0, 20.0);
    band.attackMs = std::clamp(band.attackMs, 0.1, 1000.0);
    band.releaseMs = std::clamp(band.releaseMs, 1.0, 5000.0);
    band.makeupDb = std::clamp(band.makeupDb, -24.0, 24.0);
    bands_[bandIndex] = band;
    thresholdLinear_[bandIndex] = dbToLinear(band.thresholdDb);
    ratio_[bandIndex] = band.ratio;
    makeupLinear_[bandIndex] = dbToLinear(band.makeupDb);
    attackCoefficient_[bandIndex] = coefficientForMs(band.attackMs, format_.sampleRate);
    releaseCoefficient_[bandIndex] = coefficientForMs(band.releaseMs, format_.sampleRate);
    anyBandEnabled = anyBandEnabled || band.enabled;
  }
  active_ = anyBandEnabled;
  if (active_) reset();
}

void MultibandCompressorProcessor::process(float* samples, size_t frameCount) {
  if (!active_ || !samples) return;
  const int channels = std::clamp(format_.channelCount, 1, 8);
  for (size_t frame = 0; frame < frameCount; ++frame) {
    float* current = samples + frame * static_cast<size_t>(channels);
    for (int channel = 0; channel < channels; ++channel) {
      float residual = current[channel];
      for (size_t crossover = 0; crossover + 1 < bandCount_; ++crossover) {
        for (size_t earlier = 0; earlier < crossover; ++earlier) {
          auto& value = frameBands_[static_cast<size_t>(channel)][earlier];
          value = phaseCorrectionState_[crossover - 1][earlier][static_cast<size_t>(channel)].process(
              value, phaseCorrection_[crossover - 1]);
        }
        float low = residual;
        float high = residual;
        for (size_t stage = 0; stage < 2; ++stage) {
          low = lowpassState_[crossover][static_cast<size_t>(channel)][stage].process(low, lowpass_[crossover]);
          high = highpassState_[crossover][static_cast<size_t>(channel)][stage].process(high, highpass_[crossover]);
        }
        frameBands_[static_cast<size_t>(channel)][crossover] = low;
        residual = high;
      }
      frameBands_[static_cast<size_t>(channel)][bandCount_ - 1] = residual;
    }

    for (size_t bandIndex = 0; bandIndex < bandCount_; ++bandIndex) {
      double peak = 0.0;
      for (int channel = 0; channel < channels; ++channel) {
        peak = std::max(peak, std::abs(static_cast<double>(frameBands_[static_cast<size_t>(channel)][bandIndex])));
      }
      const double coefficient = peak > envelope_[bandIndex] ? attackCoefficient_[bandIndex] : releaseCoefficient_[bandIndex];
      envelope_[bandIndex] = coefficient * envelope_[bandIndex] + (1.0 - coefficient) * peak;
      double target = 1.0;
      if (bands_[bandIndex].enabled && envelope_[bandIndex] > thresholdLinear_[bandIndex]) {
        const double inputDb = linearToDb(envelope_[bandIndex]);
        const double outputDb = bands_[bandIndex].thresholdDb +
                                (inputDb - bands_[bandIndex].thresholdDb) / ratio_[bandIndex];
        target = dbToLinear(outputDb - inputDb) * makeupLinear_[bandIndex];
      } else if (bands_[bandIndex].enabled) {
        target = makeupLinear_[bandIndex];
      }
      const double gainCoefficient = target < gain_[bandIndex] ? attackCoefficient_[bandIndex] : releaseCoefficient_[bandIndex];
      gain_[bandIndex] = gainCoefficient * gain_[bandIndex] + (1.0 - gainCoefficient) * target;
    }

    for (int channel = 0; channel < channels; ++channel) {
      double mixed = 0.0;
      for (size_t bandIndex = 0; bandIndex < bandCount_; ++bandIndex) {
        const double bandGain = bands_[bandIndex].enabled ? gain_[bandIndex] : 1.0;
        mixed += frameBands_[static_cast<size_t>(channel)][bandIndex] * bandGain;
      }
      current[channel] = static_cast<float>(std::clamp(mixed, -8.0, 8.0));
    }
  }
}

void MultibandCompressorProcessor::reset() {
  for (auto& crossover : lowpassState_) for (auto& channel : crossover) for (State& state : channel) state.reset();
  for (auto& crossover : highpassState_) for (auto& channel : crossover) for (State& state : channel) state.reset();
  for (auto& crossover : phaseCorrectionState_) for (auto& band : crossover) for (State& state : band) state.reset();
  envelope_.fill(0.0);
  gain_.fill(1.0);
}

void StereoFieldProcessor::configure(const DspConfig& config) {
  config_ = config;
  rebuild();
}

void StereoFieldProcessor::prepare(const AudioFormat& format) {
  format_ = format;
  rebuild();
}

void StereoFieldProcessor::rebuild() {
  active_ = config_.enabled && config_.stereoFieldEnabled && format_.channelCount == 2;
  const double balance = std::clamp(config_.stereoBalance, -1.0, 1.0);
  leftGain_ = balance > 0.0 ? 1.0 - balance : 1.0;
  rightGain_ = balance < 0.0 ? 1.0 + balance : 1.0;
  midGain_ = dbToLinear(std::clamp(config_.stereoMidGainDb, -24.0, 24.0));
  sideGain_ = dbToLinear(std::clamp(config_.stereoSideGainDb, -24.0, 24.0)) *
              std::clamp(config_.stereoWidth, 0.0, 2.0);
}

void StereoFieldProcessor::process(float* samples, size_t frameCount) {
  if (!active_ || !samples) return;
  for (size_t frame = 0; frame < frameCount; ++frame) {
    float* current = samples + frame * 2;
    double left = current[0];
    double right = current[1];
    if (config_.stereoSwap) std::swap(left, right);
    if (config_.stereoInvertLeft) left = -left;
    if (config_.stereoInvertRight) right = -right;
    const double mid = (left + right) * 0.5 * midGain_;
    const double side = config_.stereoMono ? 0.0 : (left - right) * 0.5 * sideGain_;
    current[0] = static_cast<float>(std::clamp((mid + side) * leftGain_, -8.0, 8.0));
    current[1] = static_cast<float>(std::clamp((mid - side) * rightGain_, -8.0, 8.0));
  }
}

float LoudnessContourProcessor::State::process(float input, const Biquad& filter) {
  const double output = filter.b0 * input + z1;
  z1 = filter.b1 * input - filter.a1 * output + z2;
  z2 = filter.b2 * input - filter.a2 * output;
  if (!std::isfinite(output)) {
    reset();
    return 0.0f;
  }
  return static_cast<float>(std::clamp(output, -8.0, 8.0));
}

void LoudnessContourProcessor::State::reset() {
  z1 = 0.0;
  z2 = 0.0;
}

void LoudnessContourProcessor::configure(const DspConfig& config) {
  config_ = config;
  rebuild();
}

void LoudnessContourProcessor::prepare(const AudioFormat& format) {
  format_ = format;
  rebuild();
}

void LoudnessContourProcessor::rebuild() {
  active_ = false;
  if (!config_.enabled || !config_.loudnessContourEnabled || format_.sampleRate <= 0 || format_.channelCount <= 0) return;
  const double amount = std::clamp(config_.loudnessContourAmount, 0.0, 1.0);
  const double referenceDeficit = 1.0 - std::clamp(config_.loudnessReferenceVolume, 0.0, 1.0);
  const double compensation = amount * referenceDeficit;
  if (compensation <= 1.0e-4) return;
  lowShelf_ = makeDspBiquad<Biquad>(DspFilterType::LowShelf, format_.sampleRate, 105.0, compensation * 12.0, 0.7);
  highShelf_ = makeDspBiquad<Biquad>(DspFilterType::HighShelf, format_.sampleRate, 8000.0, compensation * 5.0, 0.7);
  active_ = true;
  reset();
}

void LoudnessContourProcessor::process(float* samples, size_t frameCount) {
  if (!active_ || !samples) return;
  const int channels = std::clamp(format_.channelCount, 1, 8);
  for (size_t frame = 0; frame < frameCount; ++frame) {
    for (int channel = 0; channel < channels; ++channel) {
      const size_t index = frame * static_cast<size_t>(channels) + static_cast<size_t>(channel);
      const float low = lowState_[static_cast<size_t>(channel)].process(samples[index], lowShelf_);
      samples[index] = highState_[static_cast<size_t>(channel)].process(low, highShelf_);
    }
  }
}

void LoudnessContourProcessor::reset() {
  for (State& state : lowState_) state.reset();
  for (State& state : highState_) state.reset();
}

void DynamicsProcessor::configure(const DspConfig& config) {
  config_ = config;
  const bool enabled = mode_ == DynamicsMode::Gate ? config_.gateEnabled :
                       mode_ == DynamicsMode::Compressor ? config_.compressorEnabled : config_.truePeakLimiterEnabled;
  active_ = config_.enabled && enabled && format_.sampleRate > 0 && format_.channelCount > 0;
  const double attack = mode_ == DynamicsMode::Gate ? config_.gateAttackMs :
                        mode_ == DynamicsMode::Compressor ? config_.compressorAttackMs : config_.truePeakAttackMs;
  const double release = mode_ == DynamicsMode::Gate ? config_.gateReleaseMs :
                         mode_ == DynamicsMode::Compressor ? config_.compressorReleaseMs : config_.truePeakReleaseMs;
  attackCoefficient_ = coefficientForMs(std::clamp(attack, 0.1, 1000.0), format_.sampleRate);
  releaseCoefficient_ = coefficientForMs(std::clamp(release, 1.0, 5000.0), format_.sampleRate);
  thresholdLinear_ = dbToLinear(mode_ == DynamicsMode::Gate ? config_.gateThresholdDb : config_.compressorThresholdDb);
  ceilingLinear_ = dbToLinear(std::clamp(config_.truePeakCeilingDb, -12.0, 0.0));
  makeupLinear_ = dbToLinear(std::clamp(config_.compressorMakeupDb, -24.0, 24.0));
  ratio_ = std::clamp(config_.compressorRatio, 1.0, 20.0);

  if (mode_ == DynamicsMode::TruePeakLimiter && active_) {
    for (auto& detector : truePeakDetectors_) detector.prepare(format_.sampleRate);
    lookaheadFrames_ = static_cast<size_t>(std::round(
        std::clamp(config_.truePeakLookaheadMs, 0.1, 20.0) * static_cast<double>(format_.sampleRate) / 1000.0));
    lookaheadFrames_ = std::max(truePeakDetectors_[0].requiredLookaheadFrames(), lookaheadFrames_);
    const size_t ringFrames = lookaheadFrames_ + 1;
    lookaheadBuffer_.assign(ringFrames * static_cast<size_t>(std::clamp(format_.channelCount, 1, 8)), 0.0f);
    peakWindow_.resize(ringFrames + truePeakDetectors_[0].requiredLookaheadFrames());
  } else {
    lookaheadFrames_ = 0;
    lookaheadBuffer_.clear();
    peakWindow_.clear();
  }
  reset();
}

void DynamicsProcessor::prepare(const AudioFormat& format) {
  format_ = format;
  configure(config_);
}

void DynamicsProcessor::process(float* samples, size_t frameCount) {
  if (!active_ || !samples) return;
  const int channels = std::clamp(format_.channelCount, 1, 8);
  if (mode_ == DynamicsMode::TruePeakLimiter) {
    if (lookaheadBuffer_.empty()) return;
    const size_t ringFrames = lookaheadFrames_ + 1;
    const size_t peakWindowFrames = peakWindow_.size();
    for (size_t frame = 0; frame < frameCount; ++frame) {
      float* current = samples + frame * static_cast<size_t>(channels);
      double truePeak = 0.0;
      for (int channel = 0; channel < channels; ++channel) {
        const size_t channelIndex = static_cast<size_t>(channel);
        lookaheadBuffer_[lookaheadWriteFrame_ * static_cast<size_t>(channels) + channelIndex] = current[channel];
        truePeak = std::max(truePeak, truePeakDetectors_[channelIndex].add(current[channel]));
      }
      // Hold through the audio delay and reconstruction tail before releasing:
      // changing gain within the FIR support can regenerate intersample peaks.
      // The monotonic queue is preallocated and O(1) amortized.
      while (peakWindowSize_ > 0 && peakWindow_[peakWindowHead_].frame + peakWindowFrames <= peakFrame_) {
        peakWindowHead_ = (peakWindowHead_ + 1) % peakWindowFrames;
        --peakWindowSize_;
      }
      while (peakWindowSize_ > 0 &&
             peakWindow_[(peakWindowHead_ + peakWindowSize_ - 1) % peakWindowFrames].peak <= truePeak) {
        --peakWindowSize_;
      }
      peakWindow_[(peakWindowHead_ + peakWindowSize_) % peakWindowFrames] = {peakFrame_++, truePeak};
      ++peakWindowSize_;
      truePeak = peakWindow_[peakWindowHead_].peak;
      const double target = truePeak > ceilingLinear_ && truePeak > 1.0e-12 ? ceilingLinear_ / truePeak : 1.0;
      if (target < gain_) {
        const double smoothed = attackCoefficient_ * gain_ + (1.0 - attackCoefficient_) * target;
        gain_ = std::min(target, smoothed);
      } else {
        gain_ = releaseCoefficient_ * gain_ + (1.0 - releaseCoefficient_) * target;
      }
      const size_t readFrame = (lookaheadWriteFrame_ + ringFrames - lookaheadFrames_) % ringFrames;
      for (int channel = 0; channel < channels; ++channel) {
        const double delayed = lookaheadBuffer_[readFrame * static_cast<size_t>(channels) + static_cast<size_t>(channel)];
        current[channel] = static_cast<float>(std::clamp(delayed * gain_, -8.0, 8.0));
      }
      lookaheadWriteFrame_ = (lookaheadWriteFrame_ + 1) % ringFrames;
    }
    return;
  }

  for (size_t frame = 0; frame < frameCount; ++frame) {
    float* current = samples + frame * static_cast<size_t>(channels);
    double peak = 0.0;
    for (int channel = 0; channel < channels; ++channel) peak = std::max(peak, std::abs(static_cast<double>(current[channel])));
    const double coefficient = peak > envelope_ ? attackCoefficient_ : releaseCoefficient_;
    envelope_ = coefficient * envelope_ + (1.0 - coefficient) * peak;
    if (mode_ == DynamicsMode::Gate) {
      const double target = envelope_ >= thresholdLinear_ ? 1.0 : 0.0;
      const double gainCoefficient = target > gain_ ? attackCoefficient_ : releaseCoefficient_;
      gain_ = gainCoefficient * gain_ + (1.0 - gainCoefficient) * target;
      for (int channel = 0; channel < channels; ++channel) current[channel] = static_cast<float>(current[channel] * gain_);
      continue;
    }
    double target = makeupLinear_;
    if (envelope_ > thresholdLinear_) {
      const double inputDb = linearToDb(envelope_);
      const double outputDb = config_.compressorThresholdDb + (inputDb - config_.compressorThresholdDb) / ratio_;
      target = dbToLinear(outputDb - inputDb) * makeupLinear_;
    }
    const double gainCoefficient = target < gain_ ? attackCoefficient_ : releaseCoefficient_;
    gain_ = gainCoefficient * gain_ + (1.0 - gainCoefficient) * target;
    for (int channel = 0; channel < channels; ++channel) {
      current[channel] = static_cast<float>(std::clamp(current[channel] * gain_, -8.0, 8.0));
    }
  }
}

void DynamicsProcessor::reset() {
  envelope_ = 0.0;
  gain_ = 1.0;
  for (auto& detector : truePeakDetectors_) detector.reset();
  peakWindowHead_ = peakWindowSize_ = 0;
  peakFrame_ = 0;
  std::fill(lookaheadBuffer_.begin(), lookaheadBuffer_.end(), 0.0f);
  lookaheadWriteFrame_ = 0;
}

LoudnessMeterProcessor::~LoudnessMeterProcessor() {
  destroyEburState(eburState_);
}

void LoudnessMeterProcessor::configure(const DspConfig& config) {
  config_ = config;
  active_ = config_.enabled && config_.meterEnabled && format_.sampleRate > 0 && format_.channelCount > 0;
  if (!active_) reset();
}

void LoudnessMeterProcessor::prepare(const AudioFormat& format) {
  format_ = format;
  for (auto& detector : truePeakDetectors_) detector.prepare(format_.sampleRate);
  active_ = config_.enabled && config_.meterEnabled && format_.sampleRate > 0 && format_.channelCount > 0;
  reset();
}

void LoudnessMeterProcessor::process(float* samples, size_t frameCount) {
  if (!active_ || !samples || frameCount == 0) return;
  const int channels = std::clamp(format_.channelCount, 1, 8);
#if defined(TAE_HAS_EBUR128)
  if (auto* ebur = static_cast<ebur128_state*>(eburState_)) {
    ebur128_add_frames_float(ebur, samples, frameCount);
  }
#endif
  for (size_t frame = 0; frame < frameCount; ++frame) {
    double frameEnergy = 0.0;
    for (int channel = 0; channel < channels; ++channel) {
      const float value = samples[frame * static_cast<size_t>(channels) + static_cast<size_t>(channel)];
      const double sample = std::isfinite(value) ? static_cast<double>(value) : 0.0;
      frameEnergy += sample * sample;
      sumSquares_ += sample * sample;
      truePeak_ = std::max(truePeak_, truePeakDetectors_[static_cast<size_t>(channel)].add(value));
      if (std::abs(sample) > 1.0) ++clipCount_;
      ++sampleCount_;
    }
    frameEnergy /= static_cast<double>(channels);
    momentaryEnergy_ = momentaryCoefficient_ * momentaryEnergy_ + (1.0 - momentaryCoefficient_) * frameEnergy;
    shortTermEnergy_ = shortTermCoefficient_ * shortTermEnergy_ + (1.0 - shortTermCoefficient_) * frameEnergy;
    momentaryLufs_ = -0.691 + 10.0 * std::log10(std::max(momentaryEnergy_, 1.0e-15));
    shortTermLufs_ = -0.691 + 10.0 * std::log10(std::max(shortTermEnergy_, 1.0e-15));
    if (sampleCount_ >= static_cast<uint64_t>(std::max(1, format_.sampleRate)) * static_cast<uint64_t>(channels) * 3U) {
      shortTermMinLufs_ = std::min(shortTermMinLufs_, shortTermLufs_);
      shortTermMaxLufs_ = std::max(shortTermMaxLufs_, shortTermLufs_);
    }
    if (channels >= 2) {
      const double left = samples[frame * static_cast<size_t>(channels)];
      const double right = samples[frame * static_cast<size_t>(channels) + 1];
      correlationCross_ += left * right;
      correlationLeft_ += left * left;
      correlationRight_ += right * right;
    }
  }
  const double correlationDenominator = std::sqrt(correlationLeft_ * correlationRight_);
  correlation_ = correlationDenominator > 1.0e-15
                     ? std::clamp(correlationCross_ / correlationDenominator, -1.0, 1.0)
                     : 0.0;
}

void LoudnessMeterProcessor::reset() {
  sumSquares_ = 0.0;
  sampleCount_ = 0;
  truePeak_ = 0.0;
  for (auto& detector : truePeakDetectors_) detector.reset();
  momentaryEnergy_ = 0.0;
  shortTermEnergy_ = 0.0;
  momentaryCoefficient_ = coefficientForMs(400.0, format_.sampleRate);
  shortTermCoefficient_ = coefficientForMs(3000.0, format_.sampleRate);
  momentaryLufs_ = -std::numeric_limits<double>::infinity();
  shortTermLufs_ = -std::numeric_limits<double>::infinity();
  shortTermMinLufs_ = std::numeric_limits<double>::infinity();
  shortTermMaxLufs_ = -std::numeric_limits<double>::infinity();
  loudnessRangeLu_ = 0.0;
  correlation_ = 0.0;
  correlationCross_ = 0.0;
  correlationLeft_ = 0.0;
  correlationRight_ = 0.0;
  clipCount_ = 0;
  createEburState(eburState_, format_, active_);
}

double LoudnessMeterProcessor::integratedLufs() const {
#if defined(TAE_HAS_EBUR128)
  if (auto* ebur = static_cast<ebur128_state*>(eburState_)) {
    double value = 0.0;
    if (ebur128_loudness_global(ebur, &value) == EBUR128_SUCCESS) return value;
  }
#endif
  if (sampleCount_ == 0 || sumSquares_ <= 1.0e-15) return -std::numeric_limits<double>::infinity();
  return -0.691 + 10.0 * std::log10(sumSquares_ / static_cast<double>(sampleCount_));
}

double LoudnessMeterProcessor::momentaryLufs() const {
#if defined(TAE_HAS_EBUR128)
  if (auto* ebur = static_cast<ebur128_state*>(eburState_)) {
    double value = 0.0;
    if (ebur128_loudness_momentary(ebur, &value) == EBUR128_SUCCESS) return value;
  }
#endif
  return momentaryLufs_;
}

double LoudnessMeterProcessor::shortTermLufs() const {
#if defined(TAE_HAS_EBUR128)
  if (auto* ebur = static_cast<ebur128_state*>(eburState_)) {
    double value = 0.0;
    if (ebur128_loudness_shortterm(ebur, &value) == EBUR128_SUCCESS) return value;
  }
#endif
  return shortTermLufs_;
}

double LoudnessMeterProcessor::loudnessRangeLu() const {
#if defined(TAE_HAS_EBUR128)
  if (auto* ebur = static_cast<ebur128_state*>(eburState_)) {
    double value = 0.0;
    if (ebur128_loudness_range(ebur, &value) == 0 && std::isfinite(value)) return value;
  }
#endif
  if (std::isfinite(shortTermMinLufs_) && std::isfinite(shortTermMaxLufs_)) {
    return std::max(0.0, shortTermMaxLufs_ - shortTermMinLufs_);
  }
  return loudnessRangeLu_;
}

double LoudnessMeterProcessor::truePeakDb() const {
  return truePeak_ <= 1.0e-12 ? -std::numeric_limits<double>::infinity() : 20.0 * std::log10(truePeak_);
}

double LoudnessMeterProcessor::correlation() const {
  return correlation_;
}

uint64_t LoudnessMeterProcessor::clipCount() const {
  return clipCount_;
}

}  // namespace twilight::audio
