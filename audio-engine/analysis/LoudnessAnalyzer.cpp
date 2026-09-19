#include "LoudnessAnalyzer.h"

#include "../core/AudioTypes.h"
#include "../decoder/FFmpegDecoder.h"
#include "../utils/JsonUtils.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <ctime>
#include <limits>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#if defined(TAE_HAS_EBUR128)
#include <ebur128.h>
#endif

namespace twilight::audio {
namespace {

constexpr int kAlgorithmVersion = 2;
constexpr size_t kMaxAlbumTracks = 256;
constexpr double kHardMaxAnalysisSeconds = 3600.0 * 4.0;

std::string isoTimestampUtc() {
  const auto now = std::chrono::system_clock::now();
  const std::time_t time = std::chrono::system_clock::to_time_t(now);
  std::tm tm = {};
#if defined(_WIN32)
  gmtime_s(&tm, &time);
#else
  gmtime_r(&time, &tm);
#endif
  char buffer[32] = {};
  std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &tm);
  return buffer;
}

std::string errorJson(const std::string& message, bool available) {
  return "{\"error\":\"" + json_utils::escape(message) + "\",\"available\":" +
         (available ? "true}" : "false}");
}

#if defined(TAE_HAS_FFMPEG) && defined(TAE_HAS_EBUR128)
struct EburDeleter {
  void operator()(ebur128_state* state) const { ebur128_destroy(&state); }
};

struct Measurement {
  std::unique_ptr<ebur128_state, EburDeleter> state;
  int sampleRate = 0;
  int channels = 0;
  size_t frames = 0;
  double integratedLufs = 0.0;
  double truePeakDb = 0.0;
};

bool measureSegment(const std::string& source, double start, double end, double limit,
                    Measurement& result, std::string& error) {
  if (source.empty() || !std::isfinite(start) || !std::isfinite(end) || start < 0.0 ||
      end < 0.0 || (end > 0.0 && end <= start)) {
    error = "invalid loudness source or measurement range";
    return false;
  }
  FFmpegDecoder decoder;
  if (!decoder.open(source, &error)) return false;
  AudioFormat format = decoder.streamInfo().sourceFormat;
  if (format.sampleRate <= 0) format.sampleRate = 48000;
  format.channelCount = std::clamp(format.channelCount, 1, 8);
  format.bitDepth = 32;
  format.sampleFormat = AudioSampleFormat::Float32Interleaved;
  if (!decoder.setOutputFormat(format, &error)) return false;
  format = decoder.outputFormat();
  result.sampleRate = std::max(1, format.sampleRate);
  result.channels = std::clamp(format.channelCount, 1, 8);
  result.state.reset(ebur128_init(static_cast<unsigned int>(result.channels),
                                static_cast<unsigned long>(result.sampleRate),
                                EBUR128_MODE_I | EBUR128_MODE_TRUE_PEAK));
  if (!result.state) {
    error = "failed to initialize libebur128";
    return false;
  }
  const double maxSeconds = static_cast<double>(std::numeric_limits<size_t>::max() / result.sampleRate);
  if (start >= maxSeconds || end >= maxSeconds) {
    error = "loudness measurement range is too large";
    return false;
  }
  const size_t startFrame = static_cast<size_t>(std::round(start * result.sampleRate));
  size_t maxFrames = end > 0.0
      ? static_cast<size_t>(std::round(end * result.sampleRate)) - startFrame : 0;
  if (end > 0.0 && maxFrames == 0) {
    error = "loudness measurement range contains no samples";
    return false;
  }
  if (limit > 0.0) {
    const size_t limitFrames = static_cast<size_t>(std::ceil(limit * result.sampleRate));
    maxFrames = maxFrames > 0 ? std::min(maxFrames, limitFrames) : limitFrames;
  }
  constexpr size_t kChunkFrames = 4096;
  std::vector<float> chunk(kChunkFrames * static_cast<size_t>(result.channels));
  size_t skipped = 0;
  while (skipped < startFrame) {
    error.clear();
    const size_t read = decoder.readFrames(chunk.data(), std::min(kChunkFrames, startFrame - skipped), &error);
    if (!error.empty()) return false;
    if (read == 0) {
      error = "file ended before the requested CUE start";
      return false;
    }
    skipped += read;
  }
  while (!decoder.eof()) {
    if (maxFrames > 0 && result.frames >= maxFrames) break;
    const size_t want = maxFrames > 0 ? std::min(kChunkFrames, maxFrames - result.frames) : kChunkFrames;
    error.clear();
    const size_t read = decoder.readFrames(chunk.data(), want, &error);
    if (!error.empty()) return false;
    if (read == 0) break;
    if (ebur128_add_frames_float(result.state.get(), chunk.data(), read) != EBUR128_SUCCESS) {
      error = "libebur128 failed while adding frames";
      return false;
    }
    result.frames += read;
  }
  if (end > 0.0 && result.frames < maxFrames) {
    error = "file ended before the requested CUE boundary";
    return false;
  }
  if (result.frames == 0 ||
      ebur128_loudness_global(result.state.get(), &result.integratedLufs) != EBUR128_SUCCESS ||
      !std::isfinite(result.integratedLufs)) {
    error = "not enough non-silent PCM for integrated loudness measurement";
    return false;
  }
  double peak = 0.0;
  for (int channel = 0; channel < result.channels; ++channel) {
    double channelPeak = 0.0;
    if (ebur128_true_peak(result.state.get(), static_cast<unsigned int>(channel), &channelPeak) !=
        EBUR128_SUCCESS || !std::isfinite(channelPeak)) {
      error = "failed to compute true peak";
      return false;
    }
    peak = std::max(peak, channelPeak);
  }
  result.truePeakDb = peak <= 1.0e-12 ? -120.0 : 20.0 * std::log10(peak);
  return true;
}

void writeMeasurement(std::ostream& json, double lufs, double peakDb, const Measurement* track = nullptr) {
  json << "{\"integratedLufs\":" << std::round(lufs * 1000.0) / 1000.0
       << ",\"truePeakDb\":" << std::round(peakDb * 1000.0) / 1000.0;
  if (track) {
    json << ",\"sampleRate\":" << track->sampleRate << ",\"channels\":" << track->channels
         << ",\"analyzedFrames\":" << track->frames;
  }
  json << ",\"source\":\"analyzed\",\"analyzedAt\":\"" << isoTimestampUtc()
       << "\",\"algorithmVersion\":" << kAlgorithmVersion << ",\"available\":true}";
}
#endif

}

std::string analyzeLoudnessJson(const std::string& source, const std::string& optionsJson) {
#if !defined(TAE_HAS_FFMPEG)
  (void)source;
  (void)optionsJson;
  return errorJson("loudness analysis requires FFmpeg", false);
#elif !defined(TAE_HAS_EBUR128)
  (void)source;
  (void)optionsJson;
  return errorJson("libebur128 unavailable; loudnorm measurement disabled", false);
#else
  const bool batch = json_utils::topLevelFieldValueStart(optionsJson, "segments").has_value();
  const auto segments = batch
      ? json_utils::splitTopLevelObjects(json_utils::fieldArray(optionsJson, "segments"))
      : std::vector<std::string>{optionsJson};
  if (segments.empty() || segments.size() > kMaxAlbumTracks)
    return errorJson("loudness batch requires 1 to 256 segments", true);
  const double requestedLimit = json_utils::fieldNumber(optionsJson, "maxAnalysisSeconds").value_or(0.0);
  if (!std::isfinite(requestedLimit)) return errorJson("invalid loudness analysis limit", true);
  const double limit = std::clamp(requestedLimit, 0.0, kHardMaxAnalysisSeconds);
  if (batch && requestedLimit != 0.0) return errorJson("batch loudness requires complete source ranges", true);
  std::vector<Measurement> measurements;
  measurements.reserve(segments.size());
  for (const auto& segment : segments) {
    Measurement measurement;
    std::string error;
    const std::string path = batch ? json_utils::fieldString(segment, "source").value_or("") : source;
    const double start = json_utils::fieldNumber(segment, "startSeconds").value_or(0.0);
    const double end = json_utils::fieldNumber(segment, "endSeconds").value_or(0.0);
    if (!measureSegment(path, start, end, limit, measurement, error))
      return errorJson("track " + std::to_string(measurements.size() + 1) + ": " + error, true);
    measurements.push_back(std::move(measurement));
  }
  std::ostringstream json;
  if (!batch) {
    const auto& track = measurements.front();
    writeMeasurement(json, track.integratedLufs, track.truePeakDb, &track);
    return json.str();
  }
  json << "{\"tracks\":[";
  std::vector<ebur128_state*> states;
  double peakDb = -120.0;
  for (size_t index = 0; index < measurements.size(); ++index) {
    if (index > 0) json << ',';
    const auto& track = measurements[index];
    writeMeasurement(json, track.integratedLufs, track.truePeakDb, &track);
    states.push_back(track.state.get());
    peakDb = std::max(peakDb, track.truePeakDb);
  }
  json << "],\"album\":";
  if (json_utils::fieldBool(optionsJson, "album").value_or(false)) {
    double lufs = 0.0;
    if (ebur128_loudness_global_multiple(states.data(), states.size(), &lufs) != EBUR128_SUCCESS ||
        !std::isfinite(lufs)) return errorJson("failed to compute complete album loudness", true);
    writeMeasurement(json, lufs, peakDb);
  } else {
    json << "null";
  }
  json << '}';
  return json.str();
#endif
}

}
