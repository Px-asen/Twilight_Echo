#pragma once

#include "../AsioRenderUtils.h"
#include "../AsioBufferLimits.h"
#include "../abi/AsioAbi.h"

#include <Windows.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <functional>
#include <limits>
#include <optional>
#include <string>
#include <vector>
#include <utility>

namespace twilight::audio::asio_windows {

inline constexpr int32_t kMaximumAsioBufferFrames = asio::kMaximumPcmBufferFrames;
inline constexpr int32_t kMaximumAsioChannels = 32;

inline std::optional<AsioChannelFormat> channelFormatFor(
    asio_abi::AsioSampleType type,
    const std::optional<AsioSampleFormatMapping>& mapping = std::nullopt) {
  using namespace asio_abi;
  AsioChannelFormat format;
  format.littleEndian = type >= 16;
  switch (type) {
    case kAsioSampleInt16Lsb: case kAsioSampleInt16Msb:
      format.logicalFormat = AudioSampleFormat::Int16Interleaved;
      format.containerBits = format.validBits = 16; break;
    case kAsioSampleInt24Lsb: case kAsioSampleInt24Msb:
      format.logicalFormat = AudioSampleFormat::Int24Interleaved;
      format.containerBits = format.validBits = 24; break;
    case kAsioSampleInt32Lsb: case kAsioSampleInt32Msb:
      format.logicalFormat = AudioSampleFormat::Int32Interleaved; break;
    case kAsioSampleInt32Lsb16: case kAsioSampleInt32Msb16:
    case kAsioSampleInt32Lsb18: case kAsioSampleInt32Msb18:
    case kAsioSampleInt32Lsb20: case kAsioSampleInt32Msb20:
      format.logicalFormat = AudioSampleFormat::Int32Interleaved;
      format.validBits = (type == 24 || type == 8) ? 16 : (type == 25 || type == 9) ? 18 : 20;
      break;
    case kAsioSampleInt32Lsb24: case kAsioSampleInt32Msb24:
      format.logicalFormat = AudioSampleFormat::Int24In32Interleaved;
      format.validBits = 24; break;
    case kAsioSampleFloat32Lsb: case kAsioSampleFloat32Msb:
      format.logicalFormat = AudioSampleFormat::Float32Interleaved; break;
    case kAsioSampleFloat64Lsb: case kAsioSampleFloat64Msb:
      // The engine supplies float32; conversion to the driver's double container
      // happens only at the wire boundary, without changing the engine's ABI.
      format.logicalFormat = AudioSampleFormat::Float32Interleaved;
      format.containerBits = format.validBits = 64; break;
    case kAsioSampleDsdInt8Lsb1: case kAsioSampleDsdInt8Msb1: case kAsioSampleDsdInt8Ner8:
      format.logicalFormat = type == 32 ? AudioSampleFormat::DsdInt8Lsb1
          : type == 33 ? AudioSampleFormat::DsdInt8Msb1 : AudioSampleFormat::DsdInt8Ner8;
      format.containerBits = 8;
      format.validBits = type == 40 ? 8 : 1;
      format.dsdPacking = type == 32 ? AsioDsdPacking::Lsb1
          : type == 33 ? AsioDsdPacking::Msb1 : AsioDsdPacking::Ner8;
      break;
    default: return std::nullopt;
  }
  if (mapping && format.logicalFormat == mapping->reported) {
    format.logicalFormat = mapping->interpreted;
    format.validBits = mapping->interpreted == AudioSampleFormat::DsdInt8Ner8 ? 8 : 1;
    format.dsdPacking = mapping->interpreted == AudioSampleFormat::DsdInt8Lsb1 ? AsioDsdPacking::Lsb1
        : mapping->interpreted == AudioSampleFormat::DsdInt8Msb1 ? AsioDsdPacking::Msb1 : AsioDsdPacking::Ner8;
  }
  return format;
}

struct AsioBufferRange {
  int32_t minimum = 0, maximum = 0, preferred = 0, granularity = 0;
  bool valid() const { return minimum > 0 && maximum >= minimum; }
  bool accepts(int32_t size, int32_t limit = kMaximumAsioBufferFrames) const {
    if (!valid() || size < minimum || size > maximum || size > limit) return false;
    if (granularity < 0) return (size & (size - 1)) == 0;
    return granularity == 0 || (size - minimum) % granularity == 0;
  }
};

inline std::vector<int32_t> bufferSizeCandidates(const AsioBufferRange& range, int32_t requested,
                                                int32_t minimumRequired = 0,
                                                int32_t limit = kMaximumAsioBufferFrames) {
  std::vector<int32_t> result;
  const auto add = [&](int32_t value) {
    if (value >= minimumRequired && range.accepts(value, limit) &&
        std::find(result.begin(), result.end(), value) == result.end()) result.push_back(value);
  };
  if (!range.valid() || range.minimum > limit) return result;
  const int32_t ceiling = std::min(range.maximum, limit);
  const auto nearest = [&](int32_t value) {
    value = std::clamp(std::max(value, minimumRequired), range.minimum, ceiling);
    if (range.granularity < 0) {
      int32_t lower = 1;
      while (lower <= value / 2) lower *= 2;
      const int32_t upper = lower == value ? lower : lower * 2;
      if (value - lower <= upper - value) { add(lower); add(upper); }
      else { add(upper); add(lower); }
    } else if (range.granularity > 0) {
      const int32_t lower = range.minimum + ((value - range.minimum) / range.granularity) * range.granularity;
      const int64_t upper = static_cast<int64_t>(lower) + range.granularity;
      if (upper <= ceiling && upper - value < value - lower) add(static_cast<int32_t>(upper));
      add(lower);
      if (upper <= ceiling) add(static_cast<int32_t>(upper));
    } else add(value);
  };
  if (requested > 0) nearest(requested);
  nearest(range.preferred > 0 ? range.preferred : range.minimum);
  for (int32_t size : {512, 1024, 2048, 4096, 8192, 256, 16384, 32768}) nearest(size);
  nearest(range.minimum); nearest(ceiling);
  return result;
}

// Use the driver's complete before/after range as evidence, rather than a
// vendor name or an assumed DSD packing. FiiO 6.16 scales all three counts by
// 256 at DSD256 (PCM 8/2048/1024 -> DSD 2048/524288/262144).
inline int32_t nativeDsdBufferScale(const AsioBufferRange& pcm, const AsioBufferRange& dsd) {
  if (!pcm.valid() || !dsd.valid() || pcm.preferred <= 0 || dsd.minimum % pcm.minimum != 0) return 1;
  const int32_t scale = dsd.minimum / pcm.minimum;
  if (scale <= 1 || int64_t{pcm.maximum} * scale != dsd.maximum ||
      int64_t{pcm.preferred} * scale != dsd.preferred) return 1;
  if (pcm.granularity <= 0 ? pcm.granularity != dsd.granularity
                           : int64_t{pcm.granularity} * scale != dsd.granularity) return 1;
  return scale;
}

inline void asioControlPause(std::chrono::milliseconds duration) {
  // Keep the STA's messages moving while a driver's asynchronous rate change
  // settles. No queued playback commands are run recursively here.
  const auto until = std::chrono::steady_clock::now() + duration;
  do {
    MSG message{};
    while (std::chrono::steady_clock::now() < until && PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      TranslateMessage(&message); DispatchMessageW(&message);
    }
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
        until - std::chrono::steady_clock::now()).count();
    if (remaining > 0) MsgWaitForMultipleObjectsEx(0, nullptr, static_cast<DWORD>(remaining), QS_ALLINPUT, MWMO_INPUTAVAILABLE);
  } while (std::chrono::steady_clock::now() < until);
}

using AsioCallTrace = std::function<void(const std::string&, asio_abi::AsioError, double)>;

class AsioRateNegotiator {
 public:
  explicit AsioRateNegotiator(asio_abi::AsioDriver& driver, AsioCallTrace trace = {},
      std::chrono::milliseconds settle = std::chrono::milliseconds(500))
      : driver_(driver), trace_(std::move(trace)), settle_(settle) {}

  bool read(double* value) {
    double observed = 0;
    const auto result = driver_.getSampleRate(&observed);
    log("get-sample-rate", result, observed);
    if (!asio_abi::asioErrorIsSuccess(result) || !std::isfinite(observed) || observed <= 0 ||
        observed > std::numeric_limits<int>::max() || std::abs(observed - std::round(observed)) > 0.01) return false;
    *value = observed; return true;
  }

  bool wait(double requested, double* observed, std::chrono::steady_clock::time_point deadline) {
    int matches = 0;
    do {
      double actual = 0;
      if (read(&actual)) {
        *observed = actual;
        matches = std::abs(actual - requested) <= 0.01 ? matches + 1 : 0;
        if (matches >= 2) return true;
      } else matches = 0;
      if (std::chrono::steady_clock::now() >= deadline) break;
      asioControlPause(std::chrono::milliseconds(10));
    } while (std::chrono::steady_clock::now() <= deadline);
    return false;
  }

  bool select(double requested, double* observed, std::chrono::steady_clock::time_point deadline,
              bool force = false) {
    if (!observed || !std::isfinite(requested) || requested <= 0 ||
        std::chrono::steady_clock::now() >= deadline) return false;
    double current = 0;
    if (!force && read(&current) && std::abs(current - requested) <= 0.01) {
      *observed = current;
      return wait(requested, observed, std::min(deadline, std::chrono::steady_clock::now() + settle_));
    }
    auto result = driver_.canSampleRate(requested); log("can-sample-rate", result, requested);
    if (!asio_abi::asioErrorIsSuccess(result)) return false;
    result = driver_.setSampleRate(requested); log("set-sample-rate", result, requested);
    if (!asio_abi::asioErrorIsSuccess(result)) return false;
    return wait(requested, observed, std::min(deadline, std::chrono::steady_clock::now() + settle_));
  }

  bool pivot(double requested, bool dsd, double* observed,
             std::chrono::steady_clock::time_point deadline) {
    const std::vector<double> rates = dsd ? std::vector<double>{2822400, 3072000, 5644800, 6144000}
        : std::vector<double>{48000, 44100, 96000, 88200, 192000, 176400};
    int attempts = 0;
    for (double rate : rates) {
      if (std::abs(rate - requested) <= 0.01) continue;
      // Reserve a complete settling interval for returning to the target.
      if (std::chrono::steady_clock::now() + settle_ >= deadline || attempts >= 3) break;
      const auto can = driver_.canSampleRate(rate); log("can-pivot-rate", can, rate);
      if (!asio_abi::asioErrorIsSuccess(can)) continue;
      ++attempts;
      const bool atPivot = select(rate, observed, deadline - settle_, true);
      // Always attempt to return to the requested rate, including when the
      // pivot set partially changed hardware but its readback failed.
      if (atPivot && std::chrono::steady_clock::now() + settle_ + std::chrono::milliseconds(30) < deadline)
        asioControlPause(std::chrono::milliseconds(30));
      if (select(requested, observed, deadline, true)) return true;
    }
    return false;
  }

 private:
  void log(const std::string& name, asio_abi::AsioError result, double value) {
    if (trace_) trace_(name, result, value);
  }
  asio_abi::AsioDriver& driver_;
  AsioCallTrace trace_;
  std::chrono::milliseconds settle_;
};

}  // namespace twilight::audio::asio_windows
