#pragma once
#include "OutputClock.h"
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <functional>

namespace twilight::audio {
// The frame address belongs to the current device stream, not to media. A
// clocked backend must count every successfully released frame, including its
// silent prefill, and reset that ledger before starting a new clocked stream.
struct ClockedRenderContext {
  bool valid = false;
  uint64_t epoch = 0, firstFrame = 0;
  double firstFrameAtMs = 0;
  int sampleRate = 0;
};
using ClockedRenderCallback = std::function<size_t(float*, size_t, const ClockedRenderContext&)>;
// Rendering consumes input before the driver accepts its buffer. A media/device
// mapping becomes authoritative only after this release acknowledgement.
// Invoke once on the render thread after ReleaseBuffer, before the next render.
using ClockedCommitCallback = std::function<void(uint64_t, size_t, uint64_t, bool)>;

inline ClockedRenderContext clockedRenderContext(const OutputClockSnapshot& clock,
    uint64_t releasedFrames, size_t bufferFrames, double nowMs) {
  ClockedRenderContext result{false, clock.epoch, releasedFrames, 0, clock.sampleRate};
  const double queued = static_cast<double>(releasedFrames) - clock.positionFrames;
  if (!clock.supported || !clock.valid || !clock.running || clock.sampleRate <= 0 ||
      !std::isfinite(queued) || queued < 0 || queued > static_cast<double>(bufferFrames) ||
      clock.sampledAtMs <= 0 || clock.sampledAtMs > nowMs || nowMs - clock.sampledAtMs > 250) return result;
  result.valid = true;
  result.firstFrameAtMs = clock.sampledAtMs + queued * 1000.0 / clock.sampleRate;
  return result;
}
} // namespace twilight::audio
