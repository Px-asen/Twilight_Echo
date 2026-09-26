#pragma once

#include "AudioTypes.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

namespace twilight::audio::render {

inline void resizeFloatScratchForOverwrite(std::vector<float>& scratch, size_t sampleCount) {
  if (scratch.size() != sampleCount) scratch.resize(sampleCount);
}

inline int32_t signed24FromBytes(uint8_t low, uint8_t mid, uint8_t high) {
  int32_t value = static_cast<int32_t>(low) | (static_cast<int32_t>(mid) << 8) |
                  (static_cast<int32_t>(high) << 16);
  if ((value & 0x800000) != 0) value |= ~0x00ffffff;
  return value;
}

inline int16_t signed16FromBytes(const uint8_t* bytes) {
  const uint16_t value = static_cast<uint16_t>(bytes[0]) | (static_cast<uint16_t>(bytes[1]) << 8);
  return static_cast<int16_t>(value);
}

inline int32_t signed32FromBytes(const uint8_t* bytes) {
  uint32_t value = 0;
  std::memcpy(&value, bytes, sizeof(value));
  return static_cast<int32_t>(value);
}

inline float signed24ToFloat(int32_t value) {
  return static_cast<float>(std::clamp(static_cast<double>(value) / 8388608.0, -1.0, 1.0));
}

inline float int16ToFloat(int16_t value) {
  return static_cast<float>(std::clamp(static_cast<double>(value) / 32768.0, -1.0, 1.0));
}

inline float int32ToFloat(int32_t value) {
  return static_cast<float>(std::clamp(static_cast<double>(value) / 2147483648.0, -1.0, 1.0));
}

inline bool float32PcmCopyNeeded(const PcmBlock& block, const float* output, size_t sampleCount) {
  if (!block.data || !output || sampleCount == 0) return false;
  return block.data != reinterpret_cast<const uint8_t*>(output);
}

inline bool volumeNeedsProcessing(size_t renderedFrames, size_t requestedFrames, int channels, double volume) {
  return renderedFrames > 0 && requestedFrames > 0 && channels > 0 && std::abs(volume - 1.0) > 1.0e-9;
}

inline bool volumeSilencesRenderedFrames(size_t renderedFrames, size_t requestedFrames, int channels, double volume) {
  return volumeNeedsProcessing(renderedFrames, requestedFrames, channels, volume) && std::abs(volume) <= 1.0e-9;
}

inline size_t typedPcmToFloatWithTailSilence(const PcmBlock& block, float* output, size_t requestedFrames) {
  if (!block.data || !output || requestedFrames == 0 || block.format.channelCount <= 0) return 0;

  const int channels = std::max(1, block.format.channelCount);
  const size_t frames = std::min(requestedFrames, block.frames);
  const size_t samples = frames * static_cast<size_t>(channels);

  switch (block.format.sampleFormat) {
    case AudioSampleFormat::Int16Interleaved: {
      for (size_t i = 0; i < samples; ++i) output[i] = int16ToFloat(signed16FromBytes(block.data + i * 2));
      break;
    }
    case AudioSampleFormat::Int24Interleaved: {
      for (size_t i = 0; i < samples; ++i) {
        const size_t offset = i * 3;
        output[i] =
            signed24ToFloat(signed24FromBytes(block.data[offset], block.data[offset + 1], block.data[offset + 2]));
      }
      break;
    }
    case AudioSampleFormat::Int24In32Interleaved: {
      for (size_t i = 0; i < samples; ++i) output[i] = signed24ToFloat(signed32FromBytes(block.data + i * 4) >> 8);
      break;
    }
    case AudioSampleFormat::Int32Interleaved: {
      for (size_t i = 0; i < samples; ++i) output[i] = int32ToFloat(signed32FromBytes(block.data + i * 4));
      break;
    }
    case AudioSampleFormat::Float32Interleaved:
    default:
      if (float32PcmCopyNeeded(block, output, samples)) {
        std::memmove(output, block.data, samples * sizeof(float));
      }
      break;
  }

  if (frames < requestedFrames) {
    const size_t convertedSamples = frames * static_cast<size_t>(channels);
    const size_t requestedSamples = requestedFrames * static_cast<size_t>(channels);
    std::fill(output + convertedSamples, output + requestedSamples, 0.0f);
  }
  return frames;
}

inline void applyVolumeToRenderedFrames(
    float* samples,
    size_t renderedFrames,
    size_t requestedFrames,
    int channels,
    double volume) {
  if (!samples || !volumeNeedsProcessing(renderedFrames, requestedFrames, channels, volume)) return;

  const size_t framesToProcess = std::min(renderedFrames, requestedFrames);
  const size_t sampleCount = framesToProcess * static_cast<size_t>(channels);
  if (volumeSilencesRenderedFrames(renderedFrames, requestedFrames, channels, volume)) {
    std::fill(samples, samples + sampleCount, 0.0f);
    return;
  }

  for (size_t i = 0; i < sampleCount; ++i) {
    samples[i] = static_cast<float>(std::clamp(static_cast<double>(samples[i]) * volume, -1.0, 1.0));
  }
}

/**
 * Final output-boundary clamp for the float render path.
 *
 * The DSP chain deliberately works with +12 dB of internal headroom (EQ,
 * convolver and router all clamp to +/-4.0) so intermediate stages do not clip
 * before the chain ends. That headroom has to be given back at the output
 * boundary, and none of the existing clamps cover every case:
 *
 * - applyVolumeToRenderedFrames clamps, but only runs when volume != 1.0.
 * - applyOutputDither clamps, but returns early for non-integer PCM.
 * - The integer pack/convert helpers clamp, but float32 output never reaches
 *   them; both WASAPI and ASIO hand the callback buffer straight to the driver.
 *
 * So float32 output at exactly unity volume with an EQ boost used to deliver up
 * to +12 dB to the device. Clamping unconditionally here is a no-op for values
 * already in range, which is every sample on the integer paths.
 */
inline void clampRenderedFramesToFullScale(float* samples, size_t frames, int channels) {
  if (!samples || frames == 0 || channels <= 0) return;
  const size_t sampleCount = frames * static_cast<size_t>(channels);
  for (size_t i = 0; i < sampleCount; ++i) {
    const float value = samples[i];
    // Also normalizes NaN to silence: a NaN reaching an exclusive-mode driver
    // is far worse than a dropped sample.
    if (!(value >= -1.0f && value <= 1.0f)) {
      samples[i] = value > 0.0f ? 1.0f : (value < 0.0f ? -1.0f : 0.0f);
    }
  }
}

inline bool crossfadeSegmentFadeIsBounded(size_t frames, uint64_t framesProcessed, uint64_t totalFrames) {
  if (frames == 0 || totalFrames == 0 || framesProcessed > totalFrames) return false;
  const uint64_t lastFrameOffset = static_cast<uint64_t>(frames - 1);
  return lastFrameOffset <= totalFrames - framesProcessed;
}

inline void mixCrossfadeSegment(
    float* output,
    const float* preload,
    size_t frames,
    int channels,
    uint64_t framesProcessed,
    uint64_t totalFrames,
    bool equalPower = false) {
  if (!output || !preload || frames == 0 || channels <= 0) return;

  const double denominator = static_cast<double>(std::max<uint64_t>(1, totalFrames));
  double fadeIn = std::clamp(static_cast<double>(framesProcessed) / denominator, 0.0, 1.0);
  const double fadeStep = 1.0 / denominator;
  const size_t channelCount = static_cast<size_t>(channels);

  if (equalPower) {
    for (size_t frame = 0; frame < frames; ++frame) {
      const double t = std::clamp(fadeIn, 0.0, 1.0);
      const double incoming = std::sin(t * 1.5707963267948966);
      const double outgoing = std::cos(t * 1.5707963267948966);
      for (size_t channel = 0; channel < channelCount; ++channel) {
        const size_t index = frame * channelCount + channel;
        output[index] = static_cast<float>(std::clamp(output[index] * outgoing + preload[index] * incoming, -1.0, 1.0));
      }
      fadeIn += fadeStep;
    }
    return;
  }

  if (crossfadeSegmentFadeIsBounded(frames, framesProcessed, totalFrames)) {
    fadeIn = static_cast<double>(framesProcessed) / denominator;
    for (size_t frame = 0; frame < frames; ++frame) {
      const double fadeOut = 1.0 - fadeIn;
      const size_t frameOffset = frame * channelCount;
      for (int channel = 0; channel < channels; ++channel) {
        const size_t index = frameOffset + static_cast<size_t>(channel);
        output[index] = static_cast<float>(std::clamp(
            static_cast<double>(output[index]) * fadeOut + static_cast<double>(preload[index]) * fadeIn,
            -1.0,
            1.0));
      }
      fadeIn += fadeStep;
    }
    return;
  }

  for (size_t frame = 0; frame < frames; ++frame) {
    const double clampedFadeIn = std::clamp(fadeIn, 0.0, 1.0);
    const double fadeOut = 1.0 - clampedFadeIn;
    const size_t frameOffset = frame * channelCount;
    for (int channel = 0; channel < channels; ++channel) {
      const size_t index = frameOffset + static_cast<size_t>(channel);
      output[index] = static_cast<float>(std::clamp(
          static_cast<double>(output[index]) * fadeOut +
              static_cast<double>(preload[index]) * clampedFadeIn,
          -1.0,
          1.0));
    }
    fadeIn += fadeStep;
  }
}

}  // namespace twilight::audio::render
