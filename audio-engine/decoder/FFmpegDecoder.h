#pragma once

#include "../core/AudioTypes.h"
#include "SeekableInput.h"

#include <cstddef>
#include <memory>
#include <string>

namespace twilight::audio {

class FFmpegDecoder {
 public:
  enum class ResamplerQuality {
    Native,
    High,
    Ultra,
    // SoX engine tiers (libswresample "resampler=soxr", precision 20 / 28).
    // When the linked FFmpeg lacks libsoxr they fall back to Ultra swr settings.
    SoxrHq,
    SoxrVhq
  };
  enum class ResamplerPhase { Linear, Minimum, LinearSmooth, MinimumSmooth };
  enum class ResamplerEngine { Unknown, None, Swr, Soxr };

  FFmpegDecoder();
  ~FFmpegDecoder();

  FFmpegDecoder(const FFmpegDecoder&) = delete;
  FFmpegDecoder& operator=(const FFmpegDecoder&) = delete;

  bool open(const std::string& source, std::string* error);
  /* Set before open. Callback/context must outlive decoder IO; callback must
   * be thread-safe and nonblocking. Used by bounded background preparation. */
  void setInterrupt(int (*callback)(void*), void* context);
  void setInputFactory(std::shared_ptr<const SeekableInputFactory> factory);
  // Returns true when a custom input was cancelled and must be reopened for seek.
  bool cancelInput();
  void close();

  bool setOutputFormat(const AudioFormat& format, std::string* error);
  void setResamplerQuality(ResamplerQuality quality);
  void setResamplerPhase(ResamplerPhase phase);
  // Observations of the last successful setOutputFormat, not the next request.
  ResamplerEngine resamplerEngine() const;
  ResamplerQuality effectiveResamplerQuality() const;
  ResamplerPhase effectiveResamplerPhase() const;
  // Saved request, retained for compatibility. Minimum variants are legacy
  // aliases until a backend with actual minimum-phase control is integrated.
  ResamplerPhase resamplerPhase() const;
  size_t readFrames(float* output, size_t frameCount, std::string* error);
  size_t readFrames(PcmBlock& output, std::string* error);
  bool seek(double seconds, std::string* error);
  /** Background-only: align decoded/resampled PCM to an absolute output frame.
   * Requires continuous frame timestamps; fails instead of inventing a clock. */
  bool seekOutputFrame(uint64_t frame, std::string* error);
  bool eof() const;

  const AudioStreamInfo& streamInfo() const;
  const AudioFormat& outputFormat() const;

  /**
   * Latest ICY / container StreamTitle (empty when none).
   * Thread-safe; may update during decode of live HTTP(S) streams.
   */
  std::string streamTitle() const;
  /** Refresh StreamTitle from demuxer metadata (call from decode thread). */
  void pollStreamMetadata();

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace twilight::audio
