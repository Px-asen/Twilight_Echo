#include "FftSpectrumAnalyzer.h"

#include "FftSpectrumAnalyzerUtils.h"
#include "KissFftAdapter.h"

#include <algorithm>
#include <cmath>
#include <complex>
#include <numbers>
#include <sstream>
#include <utility>

namespace twilight::audio {
namespace {

size_t normalizeResolution(size_t value) {
  const size_t allowed[] = {64, 128, 256, 512, 1024, 2048, 4096, 8192};
  size_t best = allowed[0];
  size_t bestDistance = value > best ? value - best : best - value;
  for (size_t candidate : allowed) {
    const size_t distance = value > candidate ? value - candidate : candidate - value;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

float webAudioNormalizedMagnitude(double magnitude, size_t resolution) {
  if (resolution == 0) return 0.0f;
  // Approximate WebAudio AnalyserNode.getByteFrequencyData() for a display analyzer.
  //
  // The divisor is the reference level: a Hann window sums to resolution/2, so a
  // full-scale sine sitting on an exact bin centre produces |X| = resolution/4. Dividing
  // by that puts 0 dB exactly at "full-scale sine".
  //
  // The dB window used to be [-92, -18], which put full scale at +1.24 before the clamp.
  // Everything from quarter-scale upward therefore pinned to 1.0 and the spectrum
  // flat-topped on any normally-mastered material. The renderer draws these values
  // directly, so there was nothing downstream to recover the lost headroom. Keep the
  // ceiling above 0 dB: a single sine is not the loudest thing a bin can hold.
  const double amplitude = magnitude / std::max(1.0, static_cast<double>(resolution) * 0.25);
  constexpr double minDb = -90.0;
  constexpr double maxDb = 10.0;
  const double db = 20.0 * std::log10(std::max(amplitude, 1.0e-6));
  return static_cast<float>(std::clamp((db - minDb) / (maxDb - minDb), 0.0, 1.0));
}

}  // namespace

void fillIdleSpectrum(float* buffer, size_t count, double phase) {
  if (!buffer) return;
  for (size_t i = 0; i < count; ++i) {
    const double x = static_cast<double>(i) / static_cast<double>(count == 0 ? 1 : count);
    buffer[i] = static_cast<float>((std::sin((x * 12.0 + phase) * std::numbers::pi) + 1.0) * 0.25);
  }
}

void FftSpectrumAnalyzer::prepare(const AudioFormat& format, size_t resolution) {
  std::lock_guard lock(mutex_);
  const size_t normalized = normalizeResolution(resolution);
  if (format_.sampleRate == format.sampleRate &&
      format_.channelCount == format.channelCount &&
      resolution_ == normalized &&
      window_.size() == normalized &&
      timeDomain_.size() == normalized &&
      magnitudes_.size() == normalized / 2) {
    format_ = format;
    return;
  }
  format_ = format;
  resolution_ = normalized;
  fft::resizeWindowForOverwrite(window_, resolution_);
  for (size_t i = 0; i < resolution_; ++i) {
    window_[i] = static_cast<float>(0.5 - 0.5 * std::cos(2.0 * std::numbers::pi * static_cast<double>(i) /
                                                        static_cast<double>(std::max<size_t>(1, resolution_ - 1))));
  }
  timeDomain_.assign(resolution_, 0.0f);
  timeDomainWriteIndex_ = 0;
  timeDomainFilled_ = 0;
  // (Re)initialize the decoupled oscilloscope ring buffer. Its size is
  // independent of resolution_ so the visualization tap can serve more
  // time-domain samples than the FFT window allows.
  oscilloscopeBuffer_.assign(oscilloscopeResolution_, 0.0f);
  oscilloscopeWriteIndex_ = 0;
  oscilloscopeFilled_ = 0;
  magnitudes_.assign(resolution_ / 2, 0.0f);
  spectrogram_.clear();
  peakDb_ = -120.0;
  rmsDb_ = -120.0;
  lufsMomentary_ = -70.0;
  hasCapture_ = false;
  captureBuffersSilent_ = true;
  spectrumDirty_ = false;
  spectrogramDirty_ = false;
  ++spectrumGeneration_;
  ++resetGeneration_;
}

void FftSpectrumAnalyzer::prepareOscilloscope(size_t points) {
  std::lock_guard lock(mutex_);
  oscilloscopeResolution_ = std::clamp<size_t>(points == 0 ? 1024 : points, 64, 4096);
  oscilloscopeBuffer_.assign(oscilloscopeResolution_, 0.0f);
  oscilloscopeWriteIndex_ = 0;
  oscilloscopeFilled_ = 0;
}

void FftSpectrumAnalyzer::setEnabled(bool enabled) {
  std::lock_guard lock(mutex_);
  enabled_ = enabled;
  if (!enabled_) {
    hasCapture_ = false;
    spectrogram_.clear();
    peakDb_ = -120.0;
    rmsDb_ = -120.0;
    lufsMomentary_ = -70.0;
    spectrumDirty_ = false;
    spectrogramDirty_ = false;
    ++spectrumGeneration_;
    ++resetGeneration_;
    std::fill(magnitudes_.begin(), magnitudes_.end(), 0.0f);
  }
}

void FftSpectrumAnalyzer::resetCapture() {
  std::lock_guard lock(mutex_);
  resetCaptureLocked();
}

bool FftSpectrumAnalyzer::tryResetCapture() {
  std::unique_lock lock(mutex_, std::try_to_lock);
  if (!lock.owns_lock()) return false;
  resetCaptureLocked();
  return true;
}

void FftSpectrumAnalyzer::resetCaptureLocked() {
  if (fft::resetCaptureCanSkipBufferClear(
          hasCapture_,
          spectrumDirty_,
          spectrogram_.empty(),
          captureBuffersSilent_,
          peakDb_,
          rmsDb_,
          lufsMomentary_)) {
    return;
  }
  hasCapture_ = false;
  spectrogram_.clear();
  peakDb_ = -120.0;
  rmsDb_ = -120.0;
  lufsMomentary_ = -70.0;
  spectrumDirty_ = false;
  spectrogramDirty_ = false;
  std::fill(timeDomain_.begin(), timeDomain_.end(), 0.0f);
  std::fill(oscilloscopeBuffer_.begin(), oscilloscopeBuffer_.end(), 0.0f);
  timeDomainWriteIndex_ = 0;
  timeDomainFilled_ = 0;
  oscilloscopeWriteIndex_ = 0;
  oscilloscopeFilled_ = 0;
  std::fill(magnitudes_.begin(), magnitudes_.end(), 0.0f);
  captureBuffersSilent_ = true;
  ++spectrumGeneration_;
  ++resetGeneration_;
}

void FftSpectrumAnalyzer::copyRingWindow(
    const std::vector<float>& ring,
    size_t writeIndex,
    size_t filled,
    std::vector<float>* output) {
  if (!output) return;
  output->assign(ring.size(), 0.0f);
  if (ring.empty() || filled == 0) return;

  const size_t available = std::min(filled, ring.size());
  const size_t dstStart = ring.size() - available;
  const size_t srcStart = (writeIndex + ring.size() - available) % ring.size();
  for (size_t i = 0; i < available; ++i) {
    (*output)[dstStart + i] = ring[(srcStart + i) % ring.size()];
  }
}

void FftSpectrumAnalyzer::writeRingSample(
    std::vector<float>* ring,
    size_t* writeIndex,
    size_t* filled,
    float sample) {
  if (!ring || ring->empty() || !writeIndex || !filled) return;
  (*ring)[*writeIndex] = sample;
  *writeIndex = (*writeIndex + 1) % ring->size();
  *filled = std::min(*filled + 1, ring->size());
}

void FftSpectrumAnalyzer::capture(const float* interleaved, size_t frames, int channels) {
  if (!interleaved || frames == 0 || channels <= 0) return;

  std::unique_lock lock(mutex_, std::try_to_lock);
  if (!lock.owns_lock()) return;
  if (!enabled_ || resolution_ == 0) return;

  // FFT window (timeDomain_) — sized by resolution_.
  const size_t timeCopyFrames = std::min(frames, resolution_);
  const size_t timeSrcStart = frames - timeCopyFrames;

  // Decoupled oscilloscope window — sized by oscilloscopeResolution_,
  // independent of resolution_ so the tap can serve more time-domain samples
  // than the FFT window allows. The buffers are stored as rings and expanded to
  // newest-at-end windows on read.
  const size_t oscResolution =
      (oscilloscopeResolution_ > 0 && !oscilloscopeBuffer_.empty()) ? oscilloscopeResolution_ : 0;
  const size_t oscCopyFrames = oscResolution > 0 ? std::min(frames, oscResolution) : 0;
  const size_t oscSrcStart = frames - oscCopyFrames;

  double peakSample = 0.0;
  double sumSquares = 0.0;
  size_t measuredSamples = 0;

  // Process the union of both windows in a single pass. Each source frame's
  // mono value is computed once and distributed to whichever buffer(s) include
  // it, so the oscilloscope tap adds zero extra per-channel cost for frames
  // already needed by the FFT window. Peak/RMS measurement scope is kept on
  // the FFT window (timeCopyFrames) to preserve existing behavior.
  const size_t primaryCopyFrames = std::max(timeCopyFrames, oscCopyFrames);
  const size_t primarySrcStart = frames - primaryCopyFrames;
  for (size_t i = 0; i < primaryCopyFrames; ++i) {
    const size_t srcIdx = primarySrcStart + i;
    double mono = 0.0;
    for (int channel = 0; channel < channels; ++channel) {
      const float sample = interleaved[srcIdx * static_cast<size_t>(channels) + static_cast<size_t>(channel)];
      mono += sample;
      if (srcIdx >= timeSrcStart) {
        peakSample = std::max(peakSample, std::abs(static_cast<double>(sample)));
        sumSquares += static_cast<double>(sample) * static_cast<double>(sample);
        ++measuredSamples;
      }
    }
    const float monoValue = static_cast<float>(mono / static_cast<double>(channels));
    if (srcIdx >= timeSrcStart) {
      writeRingSample(&timeDomain_, &timeDomainWriteIndex_, &timeDomainFilled_, monoValue);
    }
    if (oscCopyFrames > 0 && srcIdx >= oscSrcStart) {
      writeRingSample(&oscilloscopeBuffer_, &oscilloscopeWriteIndex_, &oscilloscopeFilled_, monoValue);
    }
  }
  const double rms = measuredSamples > 0 ? std::sqrt(sumSquares / static_cast<double>(measuredSamples)) : 0.0;
  peakDb_ = 20.0 * std::log10(std::max(peakSample, 1.0e-6));
  rmsDb_ = 20.0 * std::log10(std::max(rms, 1.0e-6));
  lufsMomentary_ = std::max(-70.0, rmsDb_ - 0.691);
  spectrumDirty_ = true;
  spectrogramDirty_ = true;
  hasCapture_ = true;
  captureBuffersSilent_ = false;
  ++spectrumGeneration_;
}

bool FftSpectrumAnalyzer::buildSpectrumUpdateSnapshot(
    bool retainSpectrogram,
    SpectrumUpdateSnapshot& snapshot) const {
  std::lock_guard lock(mutex_);
  if (!enabled_ || !hasCapture_ || resolution_ == 0 || timeDomain_.empty()) return false;

  const bool needsSpectrum = spectrumDirty_;
  const bool needsSpectrogram = retainSpectrogram && spectrogramDirty_;
  if (!needsSpectrum && !needsSpectrogram) return false;

  snapshot.computeSpectrum = needsSpectrum;
  snapshot.retainSpectrogram = needsSpectrogram;
  snapshot.generation = resetGeneration_;
  snapshot.resolution = resolution_;
  if (needsSpectrum) {
    copyRingWindow(timeDomain_, timeDomainWriteIndex_, timeDomainFilled_, &snapshot.timeDomain);
    snapshot.window = window_;
  }
  return true;
}

void FftSpectrumAnalyzer::publishSpectrumUpdate(SpectrumUpdateSnapshot& snapshot) const {
  std::lock_guard lock(mutex_);
  if (resetGeneration_ != snapshot.generation || !enabled_ || !hasCapture_) return;

  if (snapshot.computeSpectrum && spectrumDirty_) {
    magnitudes_ = std::move(snapshot.magnitudes);
    spectrumDirty_ = false;
  }

  if (snapshot.retainSpectrogram && spectrogramDirty_) {
    spectrogram_.push_back(magnitudes_);
    constexpr size_t kMaxSpectrogramFrames = 96;
    if (spectrogram_.size() > kMaxSpectrogramFrames) {
      spectrogram_.erase(
          spectrogram_.begin(),
          spectrogram_.begin() +
              static_cast<std::ptrdiff_t>(spectrogram_.size() - kMaxSpectrogramFrames));
    }
    spectrogramDirty_ = false;
  }
}

void FftSpectrumAnalyzer::updateSpectrumForRead(bool retainSpectrogram) const {
  std::lock_guard updateLock(spectrumUpdateMutex_);
  SpectrumUpdateSnapshot snapshot;
  if (!buildSpectrumUpdateSnapshot(retainSpectrogram, snapshot)) return;

  if (snapshot.computeSpectrum) {
    fft::writeWindowedFftInput(snapshot.timeDomain, snapshot.window, snapshot.resolution, fftInputScratch_);

    KissFftAdapter::forward(fftInputScratch_, &spectrumScratch_);
    const size_t bins = snapshot.resolution / 2;
    fft::resizeMagnitudesForOverwrite(snapshot.magnitudes, bins);
    for (size_t i = 0; i < bins; ++i) {
      const double magnitude = std::abs(spectrumScratch_[i]);
      snapshot.magnitudes[i] = webAudioNormalizedMagnitude(magnitude, snapshot.resolution);
    }
  }

  publishSpectrumUpdate(snapshot);
}

size_t FftSpectrumAnalyzer::read(float* output, size_t points, double idlePhase) const {
  if (!output || points == 0) return 0;
  updateSpectrumForRead(false);

  std::lock_guard lock(mutex_);
  if (!enabled_ || !hasCapture_ || magnitudes_.empty()) {
    fillIdleSpectrum(output, points, idlePhase);
    return points;
  }

  for (size_t i = 0; i < points; ++i) {
    const size_t bucket = i * magnitudes_.size() / points;
    output[i] = magnitudes_[std::min(bucket, magnitudes_.size() - 1)];
  }
  return points;
}

std::string FftSpectrumAnalyzer::readVisualizationJson(
    size_t spectrumPoints,
    size_t waveformPoints,
    size_t spectrogramFrames,
    size_t oscilloscopePoints,
    size_t visualizerBarCount,
    bool visualizerBandPeaks) const {
  spectrumPoints = std::clamp<size_t>(spectrumPoints == 0 ? 64 : spectrumPoints, 8, 4096);
  waveformPoints = std::clamp<size_t>(waveformPoints == 0 ? 128 : waveformPoints, 16, 512);
  spectrogramFrames = std::clamp<size_t>(spectrogramFrames, 0, 96);
  oscilloscopePoints = std::clamp<size_t>(oscilloscopePoints, 0, 4096);
  visualizerBarCount = std::clamp<size_t>(visualizerBarCount, 0, 256);
  if (visualizerBarCount > 0) { spectrogramFrames = 0; oscilloscopePoints = 0; }

  bool active = false;
  bool enabled = false;
  double peakDb = -120.0;
  double rmsDb = -120.0;
  double lufsMomentary = -70.0;
  int sampleRate = 0;
  std::vector<float> magnitudes;
  std::vector<float> timeDomain;
  std::vector<float> oscilloscopeBuffer;
  std::vector<std::vector<float>> spectrogram;
  updateSpectrumForRead(spectrogramFrames > 0);
  {
    std::lock_guard lock(mutex_);
    enabled = enabled_;
    active = enabled_ && hasCapture_;
    peakDb = active ? peakDb_ : -120.0;
    rmsDb = active ? rmsDb_ : -120.0;
    lufsMomentary = active ? lufsMomentary_ : -70.0;
    sampleRate = format_.sampleRate;
    if (active) {
      magnitudes = magnitudes_;
      if (waveformPoints > 0) {
        copyRingWindow(timeDomain_, timeDomainWriteIndex_, timeDomainFilled_, &timeDomain);
      }
      if (oscilloscopePoints > 0) {
        copyRingWindow(
            oscilloscopeBuffer_,
            oscilloscopeWriteIndex_,
            oscilloscopeFilled_,
            &oscilloscopeBuffer);
      }
      if (spectrogramFrames > 0) {
        const size_t firstFrame =
            spectrogram_.size() > spectrogramFrames ? spectrogram_.size() - spectrogramFrames : 0;
        spectrogram.reserve(spectrogram_.size() - firstFrame);
        for (size_t frame = firstFrame; frame < spectrogram_.size(); ++frame) {
          spectrogram.push_back(spectrogram_[frame]);
        }
      }
    }
  }

  auto writeReducedArray = [](std::ostringstream& json, const std::vector<float>& values, size_t points) {
    json << "[";
    for (size_t i = 0; i < points; ++i) {
      if (i > 0) json << ",";
      if (values.empty()) {
        json << 0.0f;
      } else {
        const size_t bucket = i * values.size() / points;
        json << values[std::min(bucket, values.size() - 1)];
      }
    }
    json << "]";
  };

  std::ostringstream json;
  json << "{\"spectrum\":";
  fft::writeReducedArrayJson(json, magnitudes, visualizerBarCount > 0 ? 0 : spectrumPoints, active);
  if (visualizerBarCount > 0) {
    json << ",\"visualizerBarMode\":\"" << (visualizerBandPeaks ? "peak" : "interpolated")
         << "\",\"visualizerBars\":[";
    const double rate = sampleRate > 0 ? sampleRate : 44100;
    const double ratio = std::max(20.0, std::min(20000.0, rate / 2)) / 20.0;
    const double binWidth = rate / (spectrumPoints * 2);
    const auto valueAt = [&](size_t bin) {
      return active && !magnitudes.empty() ? magnitudes[std::min(bin * magnitudes.size() / spectrumPoints, magnitudes.size() - 1)] : 0.0f;
    };
    for (size_t bar = 0; bar < visualizerBarCount; ++bar) {
      double value = 0.0;
      if (visualizerBandPeaks) {
        // Non-overlapping log-Hz bands cover every native FFT bin in the
        // audible interval. Sparse point interpolation can miss a narrow tone
        // completely; taking each band's peak keeps its existing display level.
        const double lower = 20.0 * std::pow(ratio, static_cast<double>(bar) / visualizerBarCount);
        const double upper = 20.0 * std::pow(ratio, static_cast<double>(bar + 1) / visualizerBarCount);
        if (active && !magnitudes.empty()) {
          const double nativeBinWidth = rate / (magnitudes.size() * 2);
          const size_t first = std::min(magnitudes.size(), static_cast<size_t>(std::ceil(lower / nativeBinWidth)));
          const size_t end = std::min(magnitudes.size(), static_cast<size_t>(
              bar + 1 == visualizerBarCount ? std::floor(upper / nativeBinWidth) + 1 : std::ceil(upper / nativeBinWidth)));
          for (size_t bin = first; bin < end; ++bin) value = std::max(value, static_cast<double>(magnitudes[bin]));
        }
      } else {
        // Keep the existing desktop/WebAudio interpolation contract.
        const double frequency = 20.0 * std::pow(ratio, static_cast<double>(bar) / std::max<size_t>(1, visualizerBarCount - 1));
        const double decimal = frequency / binWidth;
        const size_t low = std::min(static_cast<size_t>(decimal), spectrumPoints - 1), high = std::min(low + 1, spectrumPoints - 1);
        value = valueAt(low) + (valueAt(high) - valueAt(low)) * (decimal - low);
      }
      if (bar > 0) json << ',';
      json << (std::isfinite(value) ? std::clamp(value, 0.0, 1.0) : 0.0);
    }
    json << ']';
  }
  json << ",\"waveform\":";
  fft::writeReducedArrayJson(json, timeDomain, waveformPoints, active, true);
  json << ",\"oscilloscope\":";
  fft::writeReducedArrayJson(json, oscilloscopeBuffer, oscilloscopePoints, active, true);
  json << ",\"peakDb\":" << peakDb
       << ",\"rmsDb\":" << rmsDb
       << ",\"lufsMomentary\":";
  if (active) {
    json << lufsMomentary;
  } else {
    json << "null";
  }
  json << ",\"spectrogram\":[";
  if (active) {
    for (size_t frame = 0; frame < spectrogram.size(); ++frame) {
      if (frame > 0) json << ",";
      writeReducedArray(json, spectrogram[frame], spectrumPoints);
    }
  }
  const char* tapStatus = active ? "active" : (enabled ? "no-samples" : "disabled");
  const char* reason =
      active ? "" : (enabled ? "Native visualization tap returned no samples" : "Native visualization tap disabled");
  json << "],\"sampleRate\":" << sampleRate
       << ",\"active\":" << (active ? "true" : "false")
       << ",\"tapStatus\":\"" << tapStatus << "\",\"reason\":\"" << reason << "\"}";
  return json.str();
}

bool FftSpectrumAnalyzer::isActive() const {
  std::lock_guard lock(mutex_);
  return enabled_ && hasCapture_;
}

}  // namespace twilight::audio
