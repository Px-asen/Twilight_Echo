#pragma once
#include <string>
#include <vector>

#include "../core/AudioTypes.h"
#include "../dsp/DspTypes.h"
#include "../decoder/SeekableInput.h"
#include "am_analysis.h"
#include "am_plan.h"
#include "am_hash.h"

namespace twilight::audio {
// Captures the exact backing file of a decoder. Descriptor-backed sources use
// independent pread readers, never reopen a SAF path or share JNI read buffers.
class AutoMixSource {
 public:
  AutoMixSource() = default;
  explicit AutoMixSource(std::string source, std::shared_ptr<SeekableInput> input = {});
  bool snapshot(ta_am_source_stamp*) const;
  bool identify(char hash[65], const ta_am_cancel*) const;
  ta_am_source_lease* acquire(const ta_am_source_stamp*, const char hash[65], const ta_am_cancel*) const;
  std::shared_ptr<const SeekableInputFactory> decodeFactory() const;
  std::string decodeSource(const std::string& original) const { return file_ ? original : path_; }
 private:
  std::string path_;
  std::shared_ptr<SeekableInput> file_;
};
// Thin FFmpeg/JSON adapter. Timing, analysis and transition policy live in C.
std::string analyzeAutoMixJson(const std::string& source, const std::string& optionsJson,
    std::shared_ptr<const SeekableInputFactory> factory = {}, const ta_am_cancel* cancel = nullptr);
std::string identifyAutoMixSourceJson(const std::string& source,
    std::shared_ptr<const SeekableInputFactory> factory, const ta_am_cancel* cancel);
std::string autoMixFeaturesJson(const ta_am_features& features, const std::string& identity);
bool parseAutoMixFeatures(const std::string& json, ta_am_features* features, std::string* error);
bool parseAutoMixWindows(const std::string& request, const char* windows,
                         const char* legacy, ta_am_features*, std::string* error);
bool decodeAutoMixFrames(const QueueItem& item, const AudioFormat& format,
                         uint64_t firstLogicalFrame, size_t frames, std::vector<float>* pcm,
                         std::string* error, const ta_am_cancel* cancel = nullptr,
                         DspResamplerQuality quality = DspResamplerQuality::High,
                         std::shared_ptr<const SeekableInputFactory> factory = {},
                         DspResamplerPhase phase = DspResamplerPhase::Linear);
}  // namespace twilight::audio
