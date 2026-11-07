#pragma once
#include "am_plan.h"
#include "AutoMixJsonValidation.h"
#include "../utils/JsonUtils.h"
#include <cmath>
#include <cstring>
#include <iomanip>
#include <limits>
#include <optional>
#include <sstream>
#include <string>

namespace twilight::audio {

/** Private Core/audio-service contract. Occurrences may contain legacy paths;
 * this document must never enter a remote Zone or Bridge wire response. */
struct BridgeAutoMixSources {
  std::string entry[2];
  double start[2]{}, end[2]{};
};

inline std::string bridgeAutoMixPlanJson(const ta_am_plan_spec& s, const BridgeAutoMixSources& sources) {
  std::ostringstream out;
  out << std::setprecision(std::numeric_limits<double>::max_digits10)
      << "{\"version\":1,\"ruleVersion\":\"twilight-rules-5\",\"mode\":\""
      << (s.mode == TA_AM_DJ ? "dj" : "natural") << "\",\"sampleRate\":" << s.binding.sample_rate
      << ",\"channels\":" << s.binding.channels;
  for (unsigned d = 0; d < 2; ++d) {
    const char* prefix = d ? "next" : "current";
    out << ",\"" << prefix << "Identity\":\"" << (d ? s.binding.next_identity : s.binding.current_identity)
        << "\",\"" << prefix << "EntryId\":\"" << json_utils::escape(sources.entry[d])
        << "\",\"" << prefix << "SourceStartSeconds\":" << sources.start[d]
        << ",\"" << prefix << "SourceEndSeconds\":" << sources.end[d];
  }
  out << ",\"currentStartFrame\":" << s.current_start << ",\"currentEndFrame\":" << s.current_end
      << ",\"nextStartFrame\":" << s.next_start << ",\"nextEndFrame\":" << s.next_end
      << ",\"outputFrames\":" << s.output_frames << ",\"currentRate\":" << s.current_rate
      << ",\"nextRate\":" << s.next_rate << ",\"nextGain\":" << s.next_gain
      << ",\"effect\":" << s.effect << ",\"kind\":" << s.kind << ",\"bpm\":" << s.bpm
      << ",\"confidence\":" << s.confidence << ",\"score\":" << s.score
      << ",\"lowClash\":" << s.low_clash << ",\"vocalClash\":" << s.vocal_clash << "}";
  return out.str();
}

/** Bind the already selected policy, never invoke a local selector. Quantize
 * the same time intervals into this member's frame domain, then revalidate the
 * local source-consumption equation. Native queue/format/transport IDs remain
 * local and are deliberately absent from the shared document. */
inline bool bindBridgeAutoMixPlan(const std::string& json, const ta_am_binding& local,
    const BridgeAutoMixSources& sources, ta_am_mode mode, uint64_t minimumStart,
    double currentDuration, double nextDuration, const ta_am_kernels* kernels,
    ta_am_plan_spec* bound, std::string* reason) {
  const auto fail = [&](const char* why) { if (reason) *reason = why; return false; };
  if (!bound || !kernels || json.size() > 256 * 1024 || !AutoMixJsonValidation(json).valid() ||
      local.sample_rate < 44100 || local.sample_rate > 192000 || local.channels < 1 || local.channels > 8 ||
      json_utils::fieldNumber(json, "version").value_or(0) != 1 ||
      json_utils::fieldString(json, "ruleVersion").value_or("") != "twilight-rules-5" ||
      (mode != TA_AM_NATURAL && mode != TA_AM_DJ) ||
      json_utils::fieldString(json, "mode").value_or("") != (mode == TA_AM_DJ ? "dj" : "natural"))
    return fail("invalid_shared_plan");
  const auto number = [&](const char* key, double low, double high) -> std::optional<double> {
    const auto value = json_utils::fieldNumber(json, key);
    return value && std::isfinite(*value) && *value >= low && *value <= high ? value : std::nullopt;
  };
  const auto integer = [&](const char* key, double low, double high) -> std::optional<uint64_t> {
    const auto value = number(key, low, high);
    return value && std::floor(*value) == *value ? std::optional<uint64_t>(static_cast<uint64_t>(*value)) : std::nullopt;
  };
  const auto rate = integer("sampleRate", 44100, 192000), channels = integer("channels", 1, 8);
  if (!rate || !channels || *channels != local.channels) return fail("shared_format_mismatch");
  ta_am_plan_spec spec{};
  spec.binding = local; spec.binding.sample_rate = static_cast<unsigned>(*rate); spec.mode = mode;
  for (unsigned d = 0; d < 2; ++d) {
    const std::string prefix = d ? "next" : "current";
    const auto start = number((prefix + "SourceStartSeconds").c_str(), 0, 604800);
    const auto end = number((prefix + "SourceEndSeconds").c_str(), 0, 604800);
    if (!start || !end || sources.entry[d].empty() || sources.entry[d].size() > 8192 ||
        sources.entry[d].find('\0') != std::string::npos ||
        json_utils::fieldString(json, prefix + "EntryId").value_or("") != sources.entry[d] ||
        json_utils::fieldString(json, prefix + "Identity").value_or("") != (d ? local.next_identity : local.current_identity) ||
        std::abs(*start - sources.start[d]) > 1e-7 || std::abs(*end - sources.end[d]) > 1e-7)
      return fail("shared_source_binding_mismatch");
  }
  const uint64_t maxFrames = *rate * 604800;
  const auto aStart = integer("currentStartFrame", 0, maxFrames), aEnd = integer("currentEndFrame", 1, maxFrames),
      bStart = integer("nextStartFrame", 0, maxFrames), bEnd = integer("nextEndFrame", 1, maxFrames),
      output = integer("outputFrames", 2, *rate * 32), effect = integer("effect", 0, TA_AM_REPEAT),
      kind = integer("kind", 0, TA_AM_RELEASE_BOUNDARY);
  const auto ar = number("currentRate", .88, 1.12), br = number("nextRate", .88, 1.12),
      gain = number("nextGain", .5, 2), bpm = number("bpm", 0, 300), confidence = number("confidence", 0, 1),
      score = number("score", -1e6, 1e6), low = number("lowClash", 0, 1), vocal = number("vocalClash", 0, 1);
  if (!aStart || !aEnd || !bStart || !bEnd || !output || !effect || !kind || !ar || !br || !gain ||
      !bpm || !confidence || !score || !low || !vocal) return fail("invalid_shared_plan");
  spec.current_start = *aStart; spec.current_end = *aEnd; spec.next_start = *bStart; spec.next_end = *bEnd;
  spec.output_frames = *output; spec.effect = static_cast<ta_am_effect>(*effect); spec.kind = static_cast<ta_am_transition_kind>(*kind);
  spec.current_rate = static_cast<float>(*ar); spec.next_rate = static_cast<float>(*br); spec.next_gain = static_cast<float>(*gain);
  spec.bpm = static_cast<float>(*bpm); spec.confidence = static_cast<float>(*confidence); spec.score = static_cast<float>(*score);
  spec.low_clash = static_cast<float>(*low); spec.vocal_clash = static_cast<float>(*vocal);
  if (!ta_am_plan_valid(&spec, kernels)) return fail("invalid_shared_plan");
  if (!std::isfinite(currentDuration) || !std::isfinite(nextDuration) || currentDuration <= 0 || nextDuration <= 0 ||
      currentDuration > 604800 || nextDuration > 604800 ||
      static_cast<double>(spec.current_end) / *rate > currentDuration + .5 / *rate + 1e-7 ||
      static_cast<double>(spec.next_end) / *rate > nextDuration + .5 / *rate + 1e-7)
    return fail("shared_boundary_out_of_range");
  const auto rescale = [&](uint64_t frames) {
    return static_cast<uint64_t>(std::llround(static_cast<double>(frames) * local.sample_rate / *rate));
  };
  spec.binding = local;
  spec.current_start = rescale(spec.current_start); spec.next_start = rescale(spec.next_start);
  spec.output_frames = rescale(spec.output_frames);
  spec.current_end = ta_am_plan_source_frame(&spec, 0, static_cast<double>(spec.output_frames));
  spec.next_end = ta_am_plan_source_frame(&spec, 1, static_cast<double>(spec.output_frames));
  // Independent endpoint rounding can put a rescaled end beyond EOF. Bound
  // that correction by two local frames plus one canonical frame; preserve
  // the complete overlap rather than truncating its source-consumption curve.
  const auto fit = [&](unsigned d, double duration) {
    uint64_t& start = d ? spec.next_start : spec.current_start;
    uint64_t& end = d ? spec.next_end : spec.current_end;
    const auto boundary = static_cast<uint64_t>(std::llround(duration * local.sample_rate));
    if (end <= boundary) return true;
    const auto excess = end - boundary;
    const auto roundingBound = static_cast<uint64_t>(std::ceil(2.0 + static_cast<double>(local.sample_rate) / *rate));
    if (excess > roundingBound || start < excess) return false;
    start -= excess; end -= excess; return true;
  };
  if (!fit(0, currentDuration) || !fit(1, nextDuration) || !ta_am_plan_valid(&spec, kernels))
    return fail("shared_boundary_out_of_range");
  if (spec.current_start < minimumStart) return fail("preparation_missed_boundary");
  *bound = spec;
  return true;
}

} // namespace twilight::audio
