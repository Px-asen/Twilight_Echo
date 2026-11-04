#pragma once
#include "../IOutputBackend.h"
#include "BridgeResampler.h"
#include "BridgePresentationHistory.h"
#include <atomic>

namespace twilight::audio {
// One network producer, one driver consumer. Opening/closing is control-thread
// only. The driver callback performs bounded copies/zero-fill, not IO or DSP.
class BridgeReceiver {
 public:
  ~BridgeReceiver() { close(); }
  bool open(std::unique_ptr<IOutputBackend> backend, const std::string& device,
            int rate, int channels, std::string* error);
  bool write(const float* samples, size_t frames, std::string* error);
  bool start(std::string* error);
  bool prepareTimed(std::string* error);
  bool prepareAdaptiveTimed(std::string* error);
  bool setTimedCorrection(double ppm, uint64_t expectedGeneration, std::string* error);
  bool armTimed(double startAtMs, uint64_t expectedGeneration, uint64_t mediaFrame, std::string* error);
  bool endTimed(std::string* error);
  void close();
  std::string status();
 private:
  size_t render(float* samples, size_t frames);
  size_t renderTimed(float*, size_t, const ClockedRenderContext&);
  void commitTimed(uint64_t, size_t, uint64_t, bool);
  enum class TimedPhase { Disabled, Prepared, Armed, Running, Failed };
  enum class TimedError { None, Clock, Epoch, Late, Underrun, Driver, FrameSequence };
  void timedFailure(TimedError reason);
  bool pumpAdaptive(std::string* error);
  void appendAdaptive(const BridgeResampler::Block& block);
  size_t inputCredit() const;
  std::unique_ptr<IOutputBackend> backend_;
  AudioFormat format_;
  std::vector<float> ring_;
  size_t capacity_ = 0;
  size_t prebufferFrames_ = 0;
  // Counts requested callback frames, not hardware presentation or successful
  // driver submission (exclusive-mode prefill may discard callback data).
  std::atomic<uint64_t> read_{0}, written_{0}, consumed_{0}, callbackRequested_{0}, underruns_{0};
  uint64_t generation_ = 0;
  std::atomic<bool> failed_{false};
  bool started_ = false;
  bool timed_ = false;
  std::atomic<TimedPhase> timedPhase_{TimedPhase::Disabled};
  std::atomic<TimedError> timedError_{TimedError::None};
  std::atomic<bool> ended_{false}, anchored_{false};
  std::atomic<double> targetAtMs_{0}, mediaStartAtMs_{0};
  std::atomic<uint64_t> clockEpoch_{0}, mediaFrame_{0}, mediaStartDeviceFrame_{0};
  uint64_t nextDeviceFrame_ = 0; // Render-thread only.
  struct PendingPacket {
    uint64_t firstFrame = 0, epoch = 0;
    size_t frames = 0, mediaFrames = 0, leadingSilence = 0;
    double firstFrameAtMs = 0;
    bool startsMedia = false;
  } pendingPacket_;
  std::atomic<uint64_t> committedMediaFrames_{0};
  std::unique_ptr<BridgeResampler> resampler_;
  std::vector<float> resampled_;
  struct SourceFrame { double first = 0, end = 0; };
  std::vector<SourceFrame> sourceRing_, pendingSources_;
  BridgePresentationHistory presentation_;
  std::atomic<double> sourceConsumed_{0};
};
} // namespace twilight::audio
