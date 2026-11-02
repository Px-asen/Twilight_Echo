#include "LoudnessAnalyzer.h"

#include "../core/AudioTypes.h"
#include "../decoder/FFmpegDecoder.h"
#include "../dsp/DspChain.h"
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
#include "Ebur128ChannelLayout.h"
#endif

namespace twilight::audio {
namespace {

constexpr int kAlgorithmVersion = 3;
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
constexpr size_t kWaveformBins = 2000;
constexpr size_t kEnvelopeBlockFrames = 256;
constexpr float kSilenceThresholdLinear = 0.00025118864f; // -72 dBFS

std::string encodeBase64(const std::vector<uint8_t>& bytes) {
  static constexpr char kTable[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((bytes.size() + 2) / 3) * 4);
  for (size_t i = 0; i < bytes.size(); i += 3) {
    const uint32_t b0 = bytes[i];
    const uint32_t b1 = (i + 1 < bytes.size()) ? bytes[i + 1] : 0U;
    const uint32_t b2 = (i + 2 < bytes.size()) ? bytes[i + 2] : 0U;
    const uint32_t triple = (b0 << 16U) | (b1 << 8U) | b2;
    out.push_back(kTable[(triple >> 18U) & 0x3FU]);
    out.push_back(kTable[(triple >> 12U) & 0x3FU]);
    out.push_back((i + 1 < bytes.size()) ? kTable[(triple >> 6U) & 0x3FU] : '=');
    out.push_back((i + 2 < bytes.size()) ? kTable[triple & 0x3FU] : '=');
  }
  return out;
}

std::string buildWaveformPeaksBase64(const std::vector<float>& blockPeaks) {
  if (blockPeaks.empty()) return {};
  std::vector<uint8_t> quantized(kWaveformBins, 0);
  const size_t n = blockPeaks.size();
  for (size_t bin = 0; bin < kWaveformBins; ++bin) {
    const size_t startIdx = (bin * n) / kWaveformBins;
    const size_t endIdx = std::max(startIdx + 1, ((bin + 1) * n) / kWaveformBins);
    float maxPeak = 0.0f;
    for (size_t i = startIdx; i < endIdx && i < n; ++i) {
      maxPeak = std::max(maxPeak, blockPeaks[i]);
    }
    const float clamped = std::clamp(maxPeak, 0.0f, 1.0f);
    const float perceptual = std::sqrt(clamped);
    quantized[bin] = static_cast<uint8_t>(std::clamp(std::lround(perceptual * 255.0f), 0L, 255L));
  }
  return encodeBase64(quantized);
}

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
  double loudnessRangeLu = 0.0;
  double noiseStartMs = 0.0;
  double noiseEndMs = 0.0;
  std::string waveformPeaks;
};

bool measureSegment(const std::string& source, double start, double end, double limit,
                    const std::string& graph,
                    Measurement& result, std::string& error) {
  if (source.empty() || !std::isfinite(start) || !std::isfinite(end) || start < 0.0 ||
      end < 0.0 || (end > 0.0 && end <= start)) {
    error = "invalid loudness source or measurement range";
    return false;
  }
  FFmpegDecoder decoder;
  if (!decoder.open(source, &error)) return false;
  if (!graph.empty() && (decoder.streamInfo().isDsd ||
      decoder.streamInfo().sourceFormat.channelCount > 2)) {
    error = "processed loudness requires mono/stereo PCM";
    return false;
  }
  AudioFormat format = decoder.streamInfo().sourceFormat;
  if (format.sampleRate <= 0) format.sampleRate = 48000;
  const int channels = std::clamp(format.channelCount, 1, 8);
  if (channels != format.channelCount) format.channelMask = 0;
  format.channelCount = channels;
  format.bitDepth = 32;
  format.sampleFormat = AudioSampleFormat::Float32Interleaved;
  if (!decoder.setOutputFormat(format, &error)) return false;
  format = decoder.outputFormat();
  DspChain chain;
  if (!graph.empty()) {
    if (!chain.configureGraphJson(graph, &error)) return false;
    chain.prepare(format);
    chain.reset();
  }
  result.sampleRate = std::max(1, format.sampleRate);
  result.channels = std::clamp(format.channelCount, 1, 8);
  result.state.reset(ebur128_init(
      static_cast<unsigned int>(result.channels),
      static_cast<unsigned long>(result.sampleRate),
      EBUR128_MODE_I | EBUR128_MODE_TRUE_PEAK | EBUR128_MODE_LRA));
  if (!result.state) {
    error = "failed to initialize libebur128";
    return false;
  }
  applyEbur128ChannelLayout(result.state.get(), format.channelMask);
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
  std::vector<float> blockPeaks;
  blockPeaks.reserve(65536);
  float currentBlockPeak = 0.0f;
  size_t currentBlockFrames = 0;
  bool foundNonSilent = false;
  size_t firstNonSilentFrame = 0;
  size_t lastNonSilentFrame = 0;
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
    if (!graph.empty()) chain.process(chunk.data(), read);
  }
  const size_t chCount = static_cast<size_t>(result.channels);
  while (!decoder.eof()) {
    if (maxFrames > 0 && result.frames >= maxFrames) break;
    const size_t want = maxFrames > 0 ? std::min(kChunkFrames, maxFrames - result.frames) : kChunkFrames;
    error.clear();
    const size_t read = decoder.readFrames(chunk.data(), want, &error);
    if (!error.empty()) return false;
    if (read == 0) break;
    if (!graph.empty()) {
      chain.process(chunk.data(), read);
      for (size_t sample = 0; sample < read * chCount; ++sample) {
        if (!std::isfinite(chunk[sample]) || std::abs(chunk[sample]) >= 0.999999f) {
          error = "processed signal clips; reduce EQ preamp before matching";
          return false;
        }
      }
    }
    for (size_t f = 0; f < read; ++f) {
      float framePeak = 0.0f;
      const size_t base = f * chCount;
      for (size_t c = 0; c < chCount; ++c) {
        const float v = chunk[base + c];
        if (std::isfinite(v)) {
          framePeak = std::max(framePeak, std::abs(v));
        }
      }
      if (framePeak >= kSilenceThresholdLinear) {
        const size_t globalFrame = result.frames + f;
        if (!foundNonSilent) {
          foundNonSilent = true;
          firstNonSilentFrame = globalFrame;
        }
        lastNonSilentFrame = globalFrame;
      }
      currentBlockPeak = std::max(currentBlockPeak, framePeak);
      if (++currentBlockFrames >= kEnvelopeBlockFrames) {
        blockPeaks.push_back(currentBlockPeak);
        currentBlockPeak = 0.0f;
        currentBlockFrames = 0;
      }
    }
    if (ebur128_add_frames_float(result.state.get(), chunk.data(), read) != EBUR128_SUCCESS) {
      error = "libebur128 failed while adding frames";
      return false;
    }
    result.frames += read;
  }
  if (currentBlockFrames > 0) {
    blockPeaks.push_back(currentBlockPeak);
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
  double lra = 0.0;
  if (ebur128_loudness_range(result.state.get(), &lra) == EBUR128_SUCCESS && std::isfinite(lra)) {
    result.loudnessRangeLu = std::max(0.0, lra);
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
  if (foundNonSilent) {
    result.noiseStartMs =
        std::round((static_cast<double>(firstNonSilentFrame) * 1000.0) / result.sampleRate);
    result.noiseEndMs =
        std::round((static_cast<double>(lastNonSilentFrame + 1) * 1000.0) / result.sampleRate);
  } else {
    result.noiseStartMs = 0.0;
    result.noiseEndMs =
        std::round((static_cast<double>(result.frames) * 1000.0) / result.sampleRate);
  }
  if (graph.empty()) {
    result.waveformPeaks = buildWaveformPeaksBase64(blockPeaks);
  }
  return true;
}

void writeMeasurement(std::ostream& json, double lufs, double peakDb, const Measurement* track = nullptr,
                      bool processed = false, double albumLra = 0.0) {
  json << "{\"integratedLufs\":" << std::round(lufs * 1000.0) / 1000.0
       << ",\"truePeakDb\":" << std::round(peakDb * 1000.0) / 1000.0;
  if (track) {
    json << ",\"loudnessRangeLu\":" << std::round(track->loudnessRangeLu * 1000.0) / 1000.0
         << ",\"noiseStartMs\":" << static_cast<int64_t>(track->noiseStartMs)
         << ",\"noiseEndMs\":" << static_cast<int64_t>(track->noiseEndMs);
    if (!track->waveformPeaks.empty()) {
      json << ",\"waveformPeaks\":\"" << json_utils::escape(track->waveformPeaks) << "\"";
    }
    json << ",\"sampleRate\":" << track->sampleRate << ",\"channels\":" << track->channels
         << ",\"analyzedFrames\":" << track->frames;
  } else if (std::isfinite(albumLra) && albumLra >= 0.0) {
    json << ",\"loudnessRangeLu\":" << std::round(albumLra * 1000.0) / 1000.0;
  }
  json << ",\"source\":\"analyzed\",\"analyzedAt\":\"" << isoTimestampUtc()
       << "\",\"algorithmVersion\":" << kAlgorithmVersion
       << ",\"processingVersion\":" << (processed ? 1 : 0) << ",\"available\":true}";
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
  const std::string graph = json_utils::fieldObject(optionsJson, "processedGraph");
  if (!graph.empty()) {
    const auto stage = json_utils::fieldObject(graph, "outputStage");
    if (json_utils::fieldString(stage, "targetSampleRate").value_or("") != "device" ||
        json_utils::fieldString(stage, "resamplerQuality").value_or("") != "native" ||
        json_utils::fieldString(stage, "dither").value_or("") != "off")
      return errorJson("processed loudness does not support output conversion", true);
    size_t equalizers = 0;
    for (const auto& node : json_utils::splitTopLevelObjects(json_utils::fieldArray(graph, "nodes"))) {
      if (!json_utils::fieldBool(node, "enabled").value_or(false)) continue;
      if (json_utils::fieldString(node, "type").value_or("") != "equalizer" || ++equalizers > 1)
        return errorJson("processed loudness supports one built-in equalizer only", true);
    }
    const double start = json_utils::fieldNumber(optionsJson, "startSeconds").value_or(0);
    const double end = json_utils::fieldNumber(optionsJson, "endSeconds").value_or(0);
    if (start < 0 || start > 600 || end - start < 10 || end - start > 60 ||
        json_utils::topLevelFieldValueStart(optionsJson, "segments").has_value())
      return errorJson("processed loudness requires a 10 to 60 second interval within the first 11 minutes", true);
  }
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
    if (!measureSegment(path, start, end, limit, graph, measurement, error))
      return errorJson("track " + std::to_string(measurements.size() + 1) + ": " + error, true);
    measurements.push_back(std::move(measurement));
  }
  std::ostringstream json;
  if (!batch) {
    const auto& track = measurements.front();
    writeMeasurement(json, track.integratedLufs, track.truePeakDb, &track, !graph.empty());
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
    double albumLra = 0.0;
    if (ebur128_loudness_range_multiple(states.data(), states.size(), &albumLra) != EBUR128_SUCCESS ||
        !std::isfinite(albumLra)) {
      albumLra = 0.0;
    }
    writeMeasurement(json, lufs, peakDb, nullptr, false, std::max(0.0, albumLra));
  } else {
    json << "null";
  }
  json << '}';
  return json.str();
#endif
}

}
