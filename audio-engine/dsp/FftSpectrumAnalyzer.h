#pragma once

#include "../core/AudioTypes.h"

#include <cstddef>
#include <cstdint>
#include <complex>
#include <mutex>
#include <string>
#include <vector>

namespace twilight::audio {

class FftSpectrumAnalyzer {
 public:
  void prepare(const AudioFormat& format, size_t resolution);
  // Configure the decoupled oscilloscope ring buffer size (clamped to
  // [64, 4096], default 1024). Independent of fftResolution so the
  // visualization tap can serve high-resolution time-domain samples.
  void prepareOscilloscope(size_t points);
  void setEnabled(bool enabled);
  void resetCapture();
  bool tryResetCapture();
  void capture(const float* interleaved, size_t frames, int channels);
  size_t read(float* output, size_t points, double idlePhase = 0.0) const;
  std::string readVisualizationJson(
      size_t spectrumPoints,
      size_t waveformPoints,
      size_t spectrogramFrames,
      size_t oscilloscopePoints = 1024,
      size_t visualizerBarCount = 0,
      bool visualizerBandPeaks = false) const;
  bool isActive() const;

 private:
  struct SpectrumUpdateSnapshot {
    bool computeSpectrum = false;
    bool retainSpectrogram = false;
    std::uint64_t generation = 0;
    size_t resolution = 0;
    std::vector<float> timeDomain;
    std::vector<float> window;
    std::vector<float> magnitudes;
  };

  void resetCaptureLocked();
  static void copyRingWindow(
      const std::vector<float>& ring,
      size_t writeIndex,
      size_t filled,
      std::vector<float>* output);
  static void writeRingSample(
      std::vector<float>* ring,
      size_t* writeIndex,
      size_t* filled,
      float sample);
  bool buildSpectrumUpdateSnapshot(bool retainSpectrogram, SpectrumUpdateSnapshot& snapshot) const;
  void publishSpectrumUpdate(SpectrumUpdateSnapshot& snapshot) const;
  void updateSpectrumForRead(bool retainSpectrogram) const;

  mutable std::mutex mutex_;
  mutable std::mutex spectrumUpdateMutex_;
  AudioFormat format_;
  size_t resolution_ = 64;
  size_t oscilloscopeResolution_ = 1024;
  bool enabled_ = true;
  bool hasCapture_ = false;
  bool captureBuffersSilent_ = true;
  mutable bool spectrumDirty_ = false;
  mutable bool spectrogramDirty_ = false;
  std::uint64_t spectrumGeneration_ = 0;
  std::uint64_t resetGeneration_ = 0;
  double peakDb_ = -120.0;
  double rmsDb_ = -120.0;
  double lufsMomentary_ = -70.0;
  std::vector<float> window_;
  std::vector<float> timeDomain_;
  std::vector<float> oscilloscopeBuffer_;
  size_t timeDomainWriteIndex_ = 0;
  size_t timeDomainFilled_ = 0;
  size_t oscilloscopeWriteIndex_ = 0;
  size_t oscilloscopeFilled_ = 0;
  mutable std::vector<float> magnitudes_;
  mutable std::vector<std::vector<float>> spectrogram_;
  mutable std::vector<float> fftInputScratch_;
  mutable std::vector<std::complex<float>> spectrumScratch_;
};

void fillIdleSpectrum(float* buffer, size_t count, double phase);

}  // namespace twilight::audio
