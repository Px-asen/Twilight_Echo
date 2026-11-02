#pragma once

#include "../core/AudioTypes.h"
#include "../decoder/DsdReader.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace twilight::audio {

struct PcmToDsdModulatorConfig {
  int inputSampleRate = 0;
  int channelCount = 0;
  // DSD rate multiplier relative to the source base family: 64, 128, 256 or 512.
  // 44.1 kHz family sources target 44100 * N, 48 kHz family sources target 48000 * N.
  int targetDsdRate = 0;
  // Bit order of the produced per-channel DSD bytes (8 bits per byte).
  // MsbFirst: the earliest bit in time occupies bit 7 (DFF/DoP convention).
  DsdBitOrder bitOrder = DsdBitOrder::MsbFirst;
  // Sigma-delta loop filter order: 5 (default) or 7, with a Butterworth NTF and CIFB recurrence.
  int modulatorOrder = 5;
};

/**
 * PCM float32/float64 -> 1-bit DSD sigma-delta modulator.
 *
 * Interpolation is a cascade of x2 polyphase halfband FIR stages (up to x64,
 * 6 stages), followed by zero-order hold for any residual ratio; the 5th-order
 * or 7th-order Butterworth-NTF CIFB sigma-delta quantizer runs at the full DSD
 * rate with double-precision per-channel state. A fixed -6 dB headroom scale
 * is applied at the input so full-scale PCM maps to +/-0.5 FS at the modulator
 * (stable operating range); an integrator magnitude guard resets the loop state
 * on instability instead of emitting garbage.
 *
 * Render-thread friendly: no locks, no allocations in process() after
 * configure().
 */
class PcmToDsdModulator {
 public:
  static constexpr int kMaxChannels = 8;
  static constexpr int kMaxHalfbandStages = 6;
  static constexpr int kMaxModulatorOrder = 7;
  static constexpr double kInputHeadroomScale = 0.5;

  bool configure(const PcmToDsdModulatorConfig& config, std::string* error);
  void reset();

  /**
   * Modulate `frames` interleaved float32 PCM frames into per-channel DSD
   * bytes. `channelOutputs[c]` receives outputBytesPerChannel(frames) bytes
   * for channel c (8 DSD bits per byte, oldest bit per the configured order).
   * `channelCapacityBytes` is the writable size of each channel buffer.
   * Returns the number of bytes written per channel, or 0 on error
   * (not configured, null buffers, insufficient capacity).
   */
  size_t process(
      const float* interleavedInput,
      size_t frames,
      uint8_t* const* channelOutputs,
      size_t channelCapacityBytes);

  /**
   * Modulate `frames` interleaved 64-bit double PCM frames directly into
   * per-channel DSD bytes without intermediate float32 quantization.
   */
  size_t processDouble(
      const double* interleavedInput,
      size_t frames,
      uint8_t* const* channelOutputs,
      size_t channelCapacityBytes);

  bool configured() const { return configured_; }
  const PcmToDsdModulatorConfig& config() const { return config_; }
  int channelCount() const { return config_.channelCount; }
  /** Output DSD sample rate in bits per second per channel (e.g. 2822400). */
  int dsdSampleRate() const { return dsdSampleRate_; }
  /** Total oversampling ratio (DSD bits per input frame); a power of two >= 8. */
  int upsampleRatio() const { return upsampleRatio_; }
  /** Number of active x2 polyphase halfband FIR stages (up to 6 -> x64). */
  int halfbandStageCount() const { return halfbandStageCount_; }
  int modulatorOrder() const { return modulatorOrder_; }
  DsdBitOrder bitOrder() const { return config_.bitOrder; }
  /** DsdInt8Msb1 or DsdInt8Lsb1 depending on the configured bit order. */
  AudioSampleFormat outputSampleFormat() const;
  size_t outputBytesPerChannel(size_t frames) const {
    return frames * static_cast<size_t>(upsampleRatio_) / 8;
  }
  /** Number of times the instability guard reset the integrators since configure()/reset(). */
  uint64_t instabilityResetCount() const { return instabilityResets_; }

  /**
   * Diagnostic/test hook: force the loop state of every channel into an
   * unstable region so the guard path can be exercised deterministically.
   */
  void injectInstabilityForTest();

 private:
  // Mirrored ring histories keep each FIR window contiguous without shifting.
  static constexpr size_t kFilterHistoryLength = 140;  // 2 * (32 + 16 + 8 + 6 + 4 + 4)

  struct ChannelState {
    std::array<double, kFilterHistoryLength> filterHistory{};
    std::array<int, kMaxHalfbandStages> historyPositions{};
    std::array<double, kMaxModulatorOrder> integrators{};
    uint8_t pendingByte = 0;
    int pendingBits = 0;
  };

  PcmToDsdModulatorConfig config_;
  bool configured_ = false;
  int dsdSampleRate_ = 0;
  int upsampleRatio_ = 0;
  int halfbandStageCount_ = 0;
  int holdFactor_ = 1;
  int modulatorOrder_ = 5;
  uint64_t instabilityResets_ = 0;
  std::vector<ChannelState> channels_;
};

}  // namespace twilight::audio
