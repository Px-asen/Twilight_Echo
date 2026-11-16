#pragma once

#include "AudioTypes.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <vector>

namespace twilight::audio {

// Single-producer/single-consumer decoded-audio ring buffer.
//
// The decoder is the only writer and the platform render callback is the only
// reader while a stream is running. Reset/clear are control-path operations and
// are only called after the decoder writer has stopped. The reader never takes
// a mutex: a short producer copy must not turn into a complete audio callback
// of silence.
class AudioBuffer {
 public:
  AudioBuffer() = default;

  void reset(int channels, size_t capacityFrames);
  void reset(const AudioFormat& format, size_t capacityFrames);
  void clear();
  void notifyAll();

  size_t writeBlocking(const float* data, size_t frames, const std::atomic<bool>& running);
  size_t writeBlocking(const PcmBlock& block, const std::atomic<bool>& running);
  size_t read(float* data, size_t frames);
  size_t read(PcmBlock& block);
  /** Advance the consumer cursor without reading PCM (prepared transitions). */
  size_t discard(size_t frames) noexcept;
  size_t waitForAvailableFrames(
      size_t targetFrames,
      std::chrono::milliseconds timeout,
      const std::atomic<bool>& running,
      const std::atomic<bool>& eof) const;

  size_t availableFrames() const;
  size_t freeFrames() const;
  int channels() const;
  AudioFormat format() const;

 private:
  size_t readFrames(PcmBlock& block, size_t targetBytesPerFrame);
  bool tryBeginRead() noexcept;
  void endRead() noexcept;
  void beginControlReset();
  void endControlReset();
  void waitForProducerWake(uint64_t epoch) noexcept;
  void notifyProducer(bool all = false) noexcept;

  // waitMutex_/notEmpty_ are only used for bounded control-path preroll waits.
  // A full-buffer decoder parks on this epoch. Windows uses WaitOnAddress:
  // MinGW's std::atomic::notify_* takes a shared runtime mutex even with no
  // waiters, which must not run on the audio callback. Other platforms retain
  // the existing C++20 wait/notify path. The epoch prevents lost wakeups.
  mutable std::mutex waitMutex_;
  mutable std::condition_variable notEmpty_;
  std::atomic<uint64_t> producerWakeEpoch_{0};
  std::vector<uint8_t> data_;
  size_t bytesPerFrame_ = 0;
  size_t capacityFrames_ = 0;

  // Monotonic SPSC cursors. Producer publishes writePosition_ after copying;
  // consumer publishes readPosition_ after copying.
  std::atomic<size_t> readPosition_{0};
  std::atomic<size_t> writePosition_{0};

  // Reset/clear may resize or invalidate storage. The high bit closes the
  // reader gate atomically with reader registration; low bits count in-flight
  // reads. This avoids a check-then-increment race with control-path reset.
  static constexpr uint32_t kControlResetBit = uint32_t{1} << 31;
  std::atomic<uint32_t> readerState_{0};

  std::atomic<int> sampleRateSnapshot_{0};
  std::atomic<int> channelSnapshot_{1};
  std::atomic<uint64_t> channelMaskSnapshot_{0};
  std::atomic<int> bitDepthSnapshot_{32};
  std::atomic<int> sampleFormatSnapshot_{static_cast<int>(AudioSampleFormat::Float32Interleaved)};
};

}  // namespace twilight::audio
