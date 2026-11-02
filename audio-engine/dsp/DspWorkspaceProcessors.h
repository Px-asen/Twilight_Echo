#pragma once

#include "IAudioProcessor.h"
#include "TruePeakDetector.h"

#include <array>
#include <limits>
#include <vector>

namespace twilight::audio {

class ChannelMatrixProcessor final : public IAudioProcessor {
 public:
  void configure(const DspConfig& config) override;
  void prepare(const AudioFormat& format) override;
  void setTrackContext(const DspTrackContext&) override {}
  void process(float* samples, size_t frameCount) override;
  void processDouble(double* samples, size_t frameCount) override {
    processFloatBridge(samples, frameCount, format_.channelCount);
  }
  void reset() override {}
  bool isActive() const override { return active_; }

 private:
  void rebuild();

  DspConfig config_;
  AudioFormat format_;
  std::vector<double> matrix_;
  std::array<float, 8> frameScratch_{};
  bool active_ = false;
};

class ChannelStripProcessor final : public IAudioProcessor {
 public:
  void configure(const DspConfig& config) override;
  void prepare(const AudioFormat& format) override;
  void setTrackContext(const DspTrackContext&) override {}
  void process(float* samples, size_t frameCount) override;
  void processDouble(double* samples, size_t frameCount) override {
    processFloatBridge(samples, frameCount, format_.channelCount);
  }
  void reset() override;
  bool isActive() const override { return active_; }

 private:
  void rebuild();

  DspConfig config_;
  AudioFormat format_;
  std::vector<float> delayBuffer_;
  std::array<size_t, 8> delayFrames_{};
  std::array<double, 8> gain_{};
  std::array<bool, 8> inverted_{};
  std::array<bool, 8> muted_{};
  size_t ringFrames_ = 1;
  size_t writeFrame_ = 0;
  bool active_ = false;
};

class BassManagementProcessor final : public IAudioProcessor {
 public:
  void configure(const DspConfig& config) override;
  void prepare(const AudioFormat& format) override;
  void setTrackContext(const DspTrackContext&) override {}
  void process(float* samples, size_t frameCount) override;
  void processDouble(double* samples, size_t frameCount) override {
    processFloatBridge(samples, frameCount, format_.channelCount);
  }
  void reset() override;
  bool isActive() const override { return active_; }
  int lfeChannelIndex() const { return lfeChannel_; }
  bool usesLegacyChannelLayout() const { return format_.channelMask == 0; }

  struct Biquad {
    double b0 = 1.0;
    double b1 = 0.0;
    double b2 = 0.0;
    double a1 = 0.0;
    double a2 = 0.0;
  };
  struct State {
    double z1 = 0.0;
    double z2 = 0.0;
    float process(float input, const Biquad& filter);
    void reset();
  };

 private:
  void rebuild();

  DspConfig config_;
  AudioFormat format_;
  Biquad lowpass_;
  Biquad highpass_;
  std::array<std::array<State, 2>, 8> lowpassState_{};
  std::array<std::array<State, 2>, 8> highpassState_{};
  double lfeGain_ = 1.0;
  int lfeChannel_ = -1;
  bool active_ = false;
};

class DynamicEqProcessor final : public IAudioProcessor {
 public:
  void configure(const DspConfig& config) override;
  void prepare(const AudioFormat& format) override;
  void setTrackContext(const DspTrackContext&) override {}
  void process(float* samples, size_t frameCount) override;
  void processDouble(double* samples, size_t frameCount) override {
    processFloatBridge(samples, frameCount, format_.channelCount);
  }
  void reset() override;
  bool isActive() const override { return active_; }

 private:
  struct Biquad {
    double b0 = 1.0;
    double b1 = 0.0;
    double b2 = 0.0;
    double a1 = 0.0;
    double a2 = 0.0;
  };
  struct State {
    double x1 = 0.0, x2 = 0.0;
    double correction1 = 0.0, correction2 = 0.0;
    float process(float input, const Biquad& filter);
    void reset();
  };

  void rebuild();

  DspConfig config_;
  AudioFormat format_;
  std::array<DspDynamicEqBand, 8> bands_{};
  std::array<Biquad, 8> filters_{};
  std::array<Biquad, 8> detectorFilters_{};
  std::array<std::array<State, 8>, 8> states_{};
  std::array<std::array<State, 8>, 8> detectorStates_{};
  std::array<double, 8> envelopes_{};
  std::array<double, 8> dynamicGainDb_{};
  std::array<double, 8> attackCoefficient_{};
  std::array<double, 8> releaseCoefficient_{};
  size_t bandCount_ = 0;
  bool active_ = false;
};

class MultibandCompressorProcessor final : public IAudioProcessor {
 public:
  void configure(const DspConfig& config) override;
  void prepare(const AudioFormat& format) override;
  void setTrackContext(const DspTrackContext&) override {}
  void process(float* samples, size_t frameCount) override;
  void processDouble(double* samples, size_t frameCount) override {
    processFloatBridge(samples, frameCount, format_.channelCount);
  }
  void reset() override;
  bool isActive() const override { return active_; }

 private:
  struct Biquad {
    double b0 = 1.0;
    double b1 = 0.0;
    double b2 = 0.0;
    double a1 = 0.0;
    double a2 = 0.0;
  };
  struct State {
    double z1 = 0.0;
    double z2 = 0.0;
    float process(float input, const Biquad& filter);
    void reset();
  };

  void rebuild();

  DspConfig config_;
  AudioFormat format_;
  std::array<Biquad, 3> lowpass_{};
  std::array<Biquad, 3> highpass_{};
  std::array<Biquad, 2> phaseCorrection_{};
  std::array<std::array<std::array<State, 2>, 8>, 3> lowpassState_{};
  std::array<std::array<std::array<State, 2>, 8>, 3> highpassState_{};
  std::array<std::array<std::array<State, 8>, 2>, 2> phaseCorrectionState_{};
  std::array<double, 4> envelope_{};
  std::array<double, 4> gain_{};
  std::array<double, 4> attackCoefficient_{};
  std::array<double, 4> releaseCoefficient_{};
  std::array<double, 4> thresholdLinear_{};
  std::array<double, 4> ratio_{};
  std::array<double, 4> makeupLinear_{};
  std::array<DspMultibandCompressorBand, 4> bands_{};
  std::array<std::array<float, 4>, 8> frameBands_{};
  size_t bandCount_ = 0;
  bool active_ = false;
};

class StereoFieldProcessor final : public IAudioProcessor {
 public:
  void configure(const DspConfig& config) override;
  void prepare(const AudioFormat& format) override;
  void setTrackContext(const DspTrackContext&) override {}
  void process(float* samples, size_t frameCount) override;
  void processDouble(double* samples, size_t frameCount) override {
    processFloatBridge(samples, frameCount, format_.channelCount);
  }
  void reset() override {}
 bool isActive() const override { return active_; }

 private:
  void rebuild();

  DspConfig config_;
  AudioFormat format_;
  double leftGain_ = 1.0;
  double rightGain_ = 1.0;
  double midGain_ = 1.0;
  double sideGain_ = 1.0;
  bool active_ = false;
};

class LoudnessContourProcessor final : public IAudioProcessor {
 public:
  void configure(const DspConfig& config) override;
  void prepare(const AudioFormat& format) override;
  void setTrackContext(const DspTrackContext&) override {}
  void process(float* samples, size_t frameCount) override;
  void processDouble(double* samples, size_t frameCount) override {
    processFloatBridge(samples, frameCount, format_.channelCount);
  }
  void reset() override;
  bool isActive() const override { return active_; }

 private:
  struct Biquad {
    double b0 = 1.0;
    double b1 = 0.0;
    double b2 = 0.0;
    double a1 = 0.0;
    double a2 = 0.0;
  };
  struct State {
    double z1 = 0.0;
    double z2 = 0.0;
    float process(float input, const Biquad& filter);
    void reset();
  };

  void rebuild();

  DspConfig config_;
  AudioFormat format_;
  Biquad lowShelf_;
  Biquad highShelf_;
  std::array<State, 8> lowState_{};
  std::array<State, 8> highState_{};
  bool active_ = false;
};

enum class DynamicsMode { Gate, Compressor, TruePeakLimiter };

class DynamicsProcessor final : public IAudioProcessor {
 public:
  explicit DynamicsProcessor(DynamicsMode mode) : mode_(mode) {}

  void configure(const DspConfig& config) override;
  void prepare(const AudioFormat& format) override;
  void setTrackContext(const DspTrackContext&) override {}
  void process(float* samples, size_t frameCount) override;
  void processDouble(double* samples, size_t frameCount) override {
    processFloatBridge(samples, frameCount, format_.channelCount);
  }
  void reset() override;
  bool isActive() const override { return active_; }
  size_t latencyFrames() const { return active_ ? lookaheadFrames_ : 0; }

 private:
  DspConfig config_;
  AudioFormat format_;
  DynamicsMode mode_;
  double envelope_ = 0.0;
  double gain_ = 1.0;
  double attackCoefficient_ = 0.0;
  double releaseCoefficient_ = 0.0;
  double thresholdLinear_ = 1.0;
  double ceilingLinear_ = 1.0;
  double makeupLinear_ = 1.0;
  double ratio_ = 1.0;
  std::vector<float> lookaheadBuffer_;
  std::array<TruePeakDetector, 8> truePeakDetectors_{};
  struct PeakEntry { uint64_t frame; double peak; };
  std::vector<PeakEntry> peakWindow_;
  size_t peakWindowHead_ = 0;
  size_t peakWindowSize_ = 0;
  uint64_t peakFrame_ = 0;
  size_t lookaheadFrames_ = 0;
  size_t lookaheadWriteFrame_ = 0;
  bool active_ = false;
};

class LoudnessMeterProcessor final : public IAudioProcessor {
 public:
  ~LoudnessMeterProcessor() override;
  void configure(const DspConfig& config) override;
  void prepare(const AudioFormat& format) override;
  void setTrackContext(const DspTrackContext&) override {}
  void process(float* samples, size_t frameCount) override;
  void processDouble(double* samples, size_t frameCount) override {
    processFloatBridge(samples, frameCount, format_.channelCount);
  }
  void reset() override;
  bool isActive() const override { return active_; }

  double integratedLufs() const;
  double momentaryLufs() const;
  double shortTermLufs() const;
  double loudnessRangeLu() const;
  double truePeakDb() const;
  double correlation() const;
  uint64_t clipCount() const;

 private:
  DspConfig config_;
  AudioFormat format_;
  double sumSquares_ = 0.0;
  uint64_t sampleCount_ = 0;
  double truePeak_ = 0.0;
  std::array<TruePeakDetector, 8> truePeakDetectors_{};
  double momentaryEnergy_ = 0.0;
  double shortTermEnergy_ = 0.0;
  double momentaryCoefficient_ = 0.0;
  double shortTermCoefficient_ = 0.0;
  double shortTermMinLufs_ = std::numeric_limits<double>::infinity();
  double shortTermMaxLufs_ = -std::numeric_limits<double>::infinity();
  double momentaryLufs_ = -std::numeric_limits<double>::infinity();
  double shortTermLufs_ = -std::numeric_limits<double>::infinity();
  double loudnessRangeLu_ = 0.0;
  double correlation_ = 0.0;
  double correlationCross_ = 0.0;
  double correlationLeft_ = 0.0;
  double correlationRight_ = 0.0;
  uint64_t clipCount_ = 0;
  void* eburState_ = nullptr;
  bool active_ = false;
};

}  // namespace twilight::audio
