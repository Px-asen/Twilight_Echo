/*
 * Named-filter coefficients and recurrence adapted from libbs2b 3.1.0.
 * Copyright (c) 2005 Boris Mikhaylov
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
#include "CrossfeedProcessor.h"
#include "CrossfeedProcessorUtils.h"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace twilight::audio {

void CrossfeedProcessor::configure(const DspConfig& config) {
  const bool modelChanged = config.crossfeedAlgorithm != config_.crossfeedAlgorithm ||
      (config.crossfeedAlgorithm == CrossfeedAlgorithm::Custom &&
       (config.crossfeedDelayMs != config_.crossfeedDelayMs || config.crossfeedCutoffHz != config_.crossfeedCutoffHz));
  const bool wasActive = active_;
  config_ = config;
  if (modelChanged) {
    rebuildFilters();
    reset();
  }
  active_ = config_.enabled && config_.crossfeedEnabled && config_.crossfeedStrength > 0.0001 &&
            format_.channelCount == 2 && format_.sampleRate > 0;
  if (wasActive && !active_) reset();
}

void CrossfeedProcessor::prepare(const AudioFormat& format) {
  const bool formatChanged = format.sampleRate != format_.sampleRate || format.channelCount != format_.channelCount;
  format_ = format;
  if (formatChanged) {
    rebuildFilters();
    reset();
  }
  active_ = config_.enabled && config_.crossfeedEnabled && config_.crossfeedStrength > 0.0001 &&
            format_.channelCount == 2 && format_.sampleRate > 0;
}

void CrossfeedProcessor::setTrackContext(const DspTrackContext&) {
}

void CrossfeedProcessor::process(float* samples, size_t frameCount) {
  processSamples(samples, frameCount);
}

void CrossfeedProcessor::processDouble(double* samples, size_t frameCount) {
  processSamples(samples, frameCount);
}

template <typename Sample>
void CrossfeedProcessor::processSamples(Sample* samples, size_t frameCount) {
  if (!active_ || !samples || frameCount == 0) return;
  const double strength = std::clamp(config_.crossfeedStrength, 0.0, 1.0);
  if (config_.crossfeedAlgorithm == CrossfeedAlgorithm::Custom) {
    const double directGain = 1.0 - 0.08 * strength;
    const double crossGain = 0.38 * strength;
    for (size_t frame = 0; frame < frameCount; ++frame) {
      const size_t index = frame * 2;
      const double left = samples[index], right = samples[index + 1];
      const double delayedLeft = delayLeft_[delayIndex_], delayedRight = delayRight_[delayIndex_];
      // Keep the original custom delay precision, including double callers.
      delayLeft_[delayIndex_] = static_cast<float>(left);
      delayRight_[delayIndex_] = static_cast<float>(right);
      crossfeed::advanceDelayIndex(delayIndex_, delayLeft_.size());
      lowpassLeft_ += alpha_ * (delayedLeft - lowpassLeft_);
      lowpassRight_ += alpha_ * (delayedRight - lowpassRight_);
      samples[index] = static_cast<Sample>(std::clamp(left * directGain + lowpassRight_ * crossGain, -4.0, 4.0));
      samples[index + 1] = static_cast<Sample>(std::clamp(right * directGain + lowpassLeft_ * crossGain, -4.0, 4.0));
    }
    return;
  }

  for (size_t frame = 0; frame < frameCount; ++frame) {
    const size_t index = frame * 2;
    const double input[2] = {samples[index], samples[index + 1]};
    for (size_t ch = 0; ch < 2; ++ch) {
      namedLow_[ch] = lowA0_ * input[ch] + lowB1_ * namedLow_[ch];
      namedHigh_[ch] = highA0_ * input[ch] + highA1_ * namedInput_[ch] + highB1_ * namedHigh_[ch];
      namedInput_[ch] = input[ch];
    }
    for (size_t ch = 0; ch < 2; ++ch) {
      const double wet = (namedHigh_[ch] + namedLow_[1 - ch]) * namedGain_;
      // strength=1 is the BS2B profile; zero remains an exact bypass.
      // Retain the DSP's +/-4 headroom rather than libbs2b's sample-format clip.
      samples[index + ch] = static_cast<Sample>(std::clamp((1.0 - strength) * input[ch] + strength * wet, -4.0, 4.0));
    }
  }
}

void CrossfeedProcessor::reset() {
  std::fill(delayLeft_.begin(), delayLeft_.end(), 0.0f);
  std::fill(delayRight_.begin(), delayRight_.end(), 0.0f);
  delayIndex_ = 0;
  lowpassLeft_ = lowpassRight_ = 0.0;
  namedInput_.fill(0.0);
  namedLow_.fill(0.0);
  namedHigh_.fill(0.0);
}

bool CrossfeedProcessor::isActive() const {
  return active_;
}

double CrossfeedProcessor::strength() const {
  return active_ ? std::clamp(config_.crossfeedStrength, 0.0, 1.0) : 0.0;
}

void CrossfeedProcessor::rebuildFilters() {
  if (format_.sampleRate <= 0) return;
  if (config_.crossfeedAlgorithm == CrossfeedAlgorithm::Custom) {
    const double delayMs = std::clamp(config_.crossfeedDelayMs, 0.05, 2.0);
    const size_t delaySamples = static_cast<size_t>(
        std::max(1.0, std::round(static_cast<double>(format_.sampleRate) * delayMs / 1000.0)));
    delayLeft_.assign(delaySamples, 0.0f);
    delayRight_.assign(delaySamples, 0.0f);
    const double cutoff = std::clamp(config_.crossfeedCutoffHz, 80.0, 4000.0);
    const double dt = 1.0 / static_cast<double>(format_.sampleRate);
    const double rc = 1.0 / (2.0 * std::numbers::pi * cutoff);
    alpha_ = dt / (rc + dt);
    return;
  }

  delayLeft_.clear();
  delayRight_.clear();
  // Bauer is the theory behind BS2B, so the two saved values are aliases.
  // Meier is libbs2b's documented JMEIER profile, not an exact CORDA circuit.
  const bool meier = config_.crossfeedAlgorithm == CrossfeedAlgorithm::Meier;
  const double cutoff = meier ? 650.0 : 700.0;
  const double feedDb = meier ? 9.5 : 4.5;
  const double lowDb = feedDb * -5.0 / 6.0 - 3.0;
  const double highDb = feedDb / 6.0 - 3.0;
  const double lowGain = std::pow(10.0, lowDb / 20.0);
  const double highLoss = 1.0 - std::pow(10.0, highDb / 20.0);
  const double highCutoff = cutoff * std::pow(2.0, (lowDb - 20.0 * std::log10(highLoss)) / 12.0);
  // Use the actual engine rate, including 705.6/768 kHz. The upstream public
  // setter silently substitutes 44.1 kHz above its older 384 kHz API limit.
  lowB1_ = std::exp(-2.0 * std::numbers::pi * cutoff / format_.sampleRate);
  lowA0_ = lowGain * (1.0 - lowB1_);
  highB1_ = std::exp(-2.0 * std::numbers::pi * highCutoff / format_.sampleRate);
  highA0_ = 1.0 - highLoss * (1.0 - highB1_);
  highA1_ = -highB1_;
  namedGain_ = 1.0 / (1.0 - highLoss + lowGain);
}

}  // namespace twilight::audio
