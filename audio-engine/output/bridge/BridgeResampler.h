#pragma once
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>

namespace twilight::audio {
// Network/control-thread only. No resampling or allocation in the DAC callback.
// Coordinates are input-media frame boundaries, not delayed output counters.
class BridgeResampler {
 public:
  // Full 256/.96 FIR length (rounded even) bounds startup lookahead and gives
  // the producer room to fill the DAC's entire callback before timed arm.
  static constexpr size_t lookaheadReserveFrames = 268;
  struct Block {
    size_t frames = 0;
    double first = 0, step = 1, end = 0;
    double boundary(size_t n) const;
  };
  BridgeResampler();
  ~BridgeResampler();
  bool open(int rate, std::string* error);
  bool correction(double outputRatePpm, std::string* error);
  bool process(const float* input, size_t frames, float* output, size_t capacity,
               Block* block, std::string* error);
  void endInput();
  bool drain(float* output, size_t capacity, Block* block, std::string* error);
  uint64_t inputFrames() const;
  double pendingFrames() const;
  double delayFrames() const;
  double requestedPpm() const;
  double effectivePpm() const;
  bool ended() const;
  bool completed() const;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
} // namespace twilight::audio
