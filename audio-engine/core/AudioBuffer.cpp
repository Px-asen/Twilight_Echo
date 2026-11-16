#include "AudioBuffer.h"
#include "AudioBufferResetUtils.h"

#include <algorithm>
#include <cstring>
#include <thread>

#ifdef _WIN32
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif
#include <windows.h>
#endif

namespace twilight::audio {
namespace {

bool bufferFormatsCompatible(const AudioFormat& left, const AudioFormat& right) {
  const bool sampleRateCompatible = left.sampleRate <= 0 || right.sampleRate <= 0 || left.sampleRate == right.sampleRate;
  if (isDsdSampleFormat(left.sampleFormat) || isDsdSampleFormat(right.sampleFormat)) {
    return sampleRateCompatible && left.channelCount > 0 && right.channelCount > 0 &&
           left.channelCount == right.channelCount && dsdFormatsExactMatch(left, right);
  }
  return sampleRateCompatible && pcmChannelLayoutsCompatible(left, right) &&
         effectivePcmBitDepth(left) == effectivePcmBitDepth(right) &&
         left.sampleFormat == right.sampleFormat;
}

void zeroBlockFrames(PcmBlock& block, size_t startFrame, size_t frameCount, size_t bytesPerFrame) {
  if (!block.data || block.byteSize == 0 || frameCount == 0 || bytesPerFrame == 0) return;
  const size_t offset = startFrame * bytesPerFrame;
  if (offset >= block.byteSize) return;
  const size_t byteCount = std::min(frameCount * bytesPerFrame, block.byteSize - offset);
  std::memset(block.data + offset, 0, byteCount);
}

size_t pcmBlockFrameCapacity(const PcmBlock& block, size_t bytesPerFrame) {
  if (block.byteSize == 0 || bytesPerFrame == 0) return 0;
  return block.byteSize / bytesPerFrame;
}

}  // namespace

bool AudioBuffer::tryBeginRead() noexcept {
  uint32_t state = readerState_.load(std::memory_order_acquire);
  while ((state & kControlResetBit) == 0) {
    if (readerState_.compare_exchange_weak(
            state,
            state + 1,
            std::memory_order_acquire,
            std::memory_order_relaxed)) {
      return true;
    }
  }
  return false;
}

void AudioBuffer::endRead() noexcept {
  readerState_.fetch_sub(1, std::memory_order_release);
}

void AudioBuffer::beginControlReset() {
  uint32_t expected = 0;
  while (!readerState_.compare_exchange_weak(
      expected,
      kControlResetBit,
      std::memory_order_acq_rel,
      std::memory_order_acquire)) {
    expected = 0;
    std::this_thread::yield();
  }
}

void AudioBuffer::endControlReset() {
  readerState_.store(0, std::memory_order_release);
  notifyProducer(true);
  notEmpty_.notify_all();
}

void AudioBuffer::waitForProducerWake(uint64_t epoch) noexcept {
#ifdef _WIN32
  static_assert(std::atomic<uint64_t>::is_always_lock_free);
  static_assert(sizeof(producerWakeEpoch_) == sizeof(epoch));
  // The producer rechecks free space and cancellation after every wake. If
  // the consumer advanced the epoch before this call, it returns immediately.
  WaitOnAddress(&producerWakeEpoch_, &epoch, sizeof(epoch), INFINITE);
#else
  producerWakeEpoch_.wait(epoch, std::memory_order_acquire);
#endif
}

void AudioBuffer::notifyProducer(bool all) noexcept {
  producerWakeEpoch_.fetch_add(1, std::memory_order_release);
#ifdef _WIN32
  if (all) WakeByAddressAll(&producerWakeEpoch_);
  else WakeByAddressSingle(&producerWakeEpoch_);
#else
  if (all) producerWakeEpoch_.notify_all();
  else producerWakeEpoch_.notify_one();
#endif
}

void AudioBuffer::reset(int channels, size_t capacityFrames) {
  AudioFormat format;
  format.sampleRate = 0;
  format.channelCount = channels;
  format.bitDepth = 32;
  format.sampleFormat = AudioSampleFormat::Float32Interleaved;
  reset(format, capacityFrames);
}

void AudioBuffer::reset(const AudioFormat& format, size_t capacityFrames) {
  beginControlReset();
  AudioFormat normalized = format;
  normalized.channelCount = std::max(1, normalized.channelCount);
  if (normalized.bitDepth <= 0) normalized.bitDepth = effectivePcmBitDepth(normalized);
  size_t bytesPerFrame = audioFormatBytesPerFrame(normalized);
  if (bytesPerFrame == 0) {
    normalized.sampleFormat = AudioSampleFormat::Float32Interleaved;
    normalized.bitDepth = 32;
    bytesPerFrame = sizeof(float) * static_cast<size_t>(normalized.channelCount);
  }

  capacityFrames_ = std::max<size_t>(1, capacityFrames);
  bytesPerFrame_ = bytesPerFrame;
  resetStorageForAudioBuffer(data_, capacityFrames_ * bytesPerFrame_);
  readPosition_.store(0, std::memory_order_relaxed);
  writePosition_.store(0, std::memory_order_relaxed);
  sampleRateSnapshot_.store(normalized.sampleRate, std::memory_order_relaxed);
  channelSnapshot_.store(normalized.channelCount, std::memory_order_relaxed);
  channelMaskSnapshot_.store(normalized.channelMask, std::memory_order_relaxed);
  bitDepthSnapshot_.store(normalized.bitDepth, std::memory_order_relaxed);
  sampleFormatSnapshot_.store(static_cast<int>(normalized.sampleFormat), std::memory_order_relaxed);
  endControlReset();
}

void AudioBuffer::clear() {
  beginControlReset();
  readPosition_.store(0, std::memory_order_relaxed);
  writePosition_.store(0, std::memory_order_relaxed);
  endControlReset();
}

void AudioBuffer::notifyAll() {
  notifyProducer(true);
  notEmpty_.notify_all();
}

size_t AudioBuffer::writeBlocking(const float* data, size_t frames, const std::atomic<bool>& running) {
  if (!data || frames == 0) return 0;
  const AudioFormat formatSnapshot = format();
  if (formatSnapshot.sampleFormat != AudioSampleFormat::Float32Interleaved) return 0;
  PcmBlock block;
  block.format = formatSnapshot;
  block.data = reinterpret_cast<uint8_t*>(const_cast<float*>(data));
  block.frames = frames;
  block.byteSize = frames * audioFormatBytesPerFrame(block.format);
  return writeBlocking(block, running);
}

size_t AudioBuffer::writeBlocking(const PcmBlock& block, const std::atomic<bool>& running) {
  if (!block.data || block.frames == 0) return 0;
  const size_t sourceBytesPerFrame = audioFormatBytesPerFrame(block.format);
  if (sourceBytesPerFrame == 0 || sourceBytesPerFrame != bytesPerFrame_ ||
      !bufferFormatsCompatible(block.format, format())) {
    return 0;
  }
  const size_t sourceFrames = std::min(block.frames, pcmBlockFrameCapacity(block, sourceBytesPerFrame));
  if (sourceFrames == 0) return 0;

  size_t written = 0;
  while (written < sourceFrames && running.load(std::memory_order_acquire)) {
    if ((readerState_.load(std::memory_order_acquire) & kControlResetBit) != 0) return written;
    const size_t write = writePosition_.load(std::memory_order_relaxed);
    const size_t read = readPosition_.load(std::memory_order_acquire);
    const size_t used = write - read;
    const size_t free = used < capacityFrames_ ? capacityFrames_ - used : 0;
    if (free == 0) {
      const uint64_t wakeEpoch = producerWakeEpoch_.load(std::memory_order_acquire);
      const size_t currentWrite = writePosition_.load(std::memory_order_relaxed);
      const size_t currentRead = readPosition_.load(std::memory_order_acquire);
      if (currentWrite - currentRead >= capacityFrames_ && running.load(std::memory_order_acquire) &&
          (readerState_.load(std::memory_order_acquire) & kControlResetBit) == 0) {
        waitForProducerWake(wakeEpoch);
      }
      continue;
    }

    const size_t writeIndex = write % capacityFrames_;
    const size_t contiguous = std::min({sourceFrames - written, free, capacityFrames_ - writeIndex});
    std::memcpy(
        data_.data() + writeIndex * bytesPerFrame_,
        block.data + written * sourceBytesPerFrame,
        contiguous * bytesPerFrame_);
    writePosition_.store(write + contiguous, std::memory_order_release);
    written += contiguous;
    notEmpty_.notify_one();
  }
  return written;
}

size_t AudioBuffer::read(float* data, size_t frames) {
  if (!data || frames == 0) return 0;
  const AudioFormat formatSnapshot = format();
  const int channels = std::max(1, formatSnapshot.channelCount);
  if (formatSnapshot.sampleFormat != AudioSampleFormat::Float32Interleaved) {
    std::fill(data, data + frames * static_cast<size_t>(channels), 0.0f);
    return 0;
  }
  PcmBlock block;
  block.format = formatSnapshot;
  block.data = reinterpret_cast<uint8_t*>(data);
  block.frames = frames;
  block.byteSize = frames * audioFormatBytesPerFrame(block.format);
  return read(block);
}

size_t AudioBuffer::read(PcmBlock& block) {
  if (!block.data || block.frames == 0) return 0;
  const size_t targetBytesPerFrame = audioFormatBytesPerFrame(block.format);
  if (targetBytesPerFrame == 0) {
    if (block.byteSize > 0) std::memset(block.data, 0, block.byteSize);
    return 0;
  }
  const size_t targetFrames = std::min(block.frames, pcmBlockFrameCapacity(block, targetBytesPerFrame));
  if (targetFrames == 0) {
    if (block.byteSize > 0) std::memset(block.data, 0, block.byteSize);
    return 0;
  }
  PcmBlock boundedBlock = block;
  boundedBlock.frames = targetFrames;

  if (!tryBeginRead()) {
    zeroBlockFrames(boundedBlock, 0, boundedBlock.frames, targetBytesPerFrame);
    return 0;
  }

  const size_t read = readFrames(boundedBlock, targetBytesPerFrame);
  endRead();
  if (read > 0) {
    notifyProducer();
  }
  return read;
}

size_t AudioBuffer::readFrames(PcmBlock& block, size_t targetBytesPerFrame) {
  if (targetBytesPerFrame != bytesPerFrame_ || !bufferFormatsCompatible(block.format, format()) ||
      capacityFrames_ == 0) {
    zeroBlockFrames(block, 0, block.frames, targetBytesPerFrame);
    return 0;
  }

  size_t read = readPosition_.load(std::memory_order_relaxed);
  const size_t write = writePosition_.load(std::memory_order_acquire);
  size_t readable = std::min(block.frames, write - read);
  size_t copied = 0;
  while (copied < readable) {
    const size_t readIndex = read % capacityFrames_;
    const size_t contiguous = std::min(readable - copied, capacityFrames_ - readIndex);
    std::memcpy(
        block.data + copied * targetBytesPerFrame,
        data_.data() + readIndex * bytesPerFrame_,
        contiguous * bytesPerFrame_);
    read += contiguous;
    copied += contiguous;
  }
  readPosition_.store(read, std::memory_order_release);
  if (copied < block.frames) {
    zeroBlockFrames(block, copied, block.frames - copied, targetBytesPerFrame);
  }
  return copied;
}

size_t AudioBuffer::discard(size_t frames) noexcept {
  if (!frames || !tryBeginRead()) return 0;
  const auto read = readPosition_.load(std::memory_order_relaxed);
  const auto write = writePosition_.load(std::memory_order_acquire);
  const auto skipped = std::min(frames,write-read);
  readPosition_.store(read+skipped,std::memory_order_release);
  endRead();
  if (skipped) {
    notifyProducer();
  }
  return skipped;
}

size_t AudioBuffer::waitForAvailableFrames(
    size_t targetFrames,
    std::chrono::milliseconds timeout,
    const std::atomic<bool>& running,
    const std::atomic<bool>& eof) const {
  if (targetFrames == 0) return 0;
  const auto ready = [&] {
    return availableFrames() >= targetFrames || !running.load(std::memory_order_acquire) ||
           eof.load(std::memory_order_acquire);
  };
  if (timeout.count() <= 0) return availableFrames();
  std::unique_lock lock(waitMutex_);
  notEmpty_.wait_for(lock, timeout, ready);
  return availableFrames();
}

size_t AudioBuffer::availableFrames() const {
  const size_t write = writePosition_.load(std::memory_order_acquire);
  const size_t read = readPosition_.load(std::memory_order_acquire);
  return write - read;
}

size_t AudioBuffer::freeFrames() const {
  const size_t available = availableFrames();
  return available < capacityFrames_ ? capacityFrames_ - available : 0;
}

int AudioBuffer::channels() const {
  return channelSnapshot_.load(std::memory_order_relaxed);
}

AudioFormat AudioBuffer::format() const {
  AudioFormat snapshot;
  snapshot.sampleRate = sampleRateSnapshot_.load(std::memory_order_relaxed);
  snapshot.channelCount = channelSnapshot_.load(std::memory_order_relaxed);
  snapshot.channelMask = channelMaskSnapshot_.load(std::memory_order_relaxed);
  snapshot.bitDepth = bitDepthSnapshot_.load(std::memory_order_relaxed);
  snapshot.sampleFormat = static_cast<AudioSampleFormat>(sampleFormatSnapshot_.load(std::memory_order_relaxed));
  return snapshot;
}

}  // namespace twilight::audio
