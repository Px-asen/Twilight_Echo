#include "AutoMixAdapter.h"
#include "AutoMixJsonValidation.h"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <iomanip>
#include <memory>
#include <mutex>
#include <sstream>

#include "../decoder/FFmpegDecoder.h"
#include "../utils/JsonUtils.h"
#include "am_asset_lock.h"
#include "am_hash.h"
#if defined(_WIN32)
#include <windows.h>
#else
#include <atomic>
#include <cerrno>
#include <fcntl.h>
#include <unistd.h>
#if defined(__linux__) && !defined(__ANDROID__)
#include <dlfcn.h>
#endif
#endif

namespace twilight::audio {
namespace {
#if !defined(_WIN32)
class AutoMixFdInput final : public SeekableInput {
 public:
  explicit AutoMixFdInput(int fd) : fd_(fcntl(fd, F_DUPFD_CLOEXEC, 0)) {}
  ~AutoMixFdInput() override { if (fd_ >= 0) ::close(fd_); }
  int64_t size() override {
    ta_am_source_stamp s{};
    return !cancelled_ && ta_am_source_snapshot_fd(fd_, &s) ? static_cast<int64_t>(s.size) : -1;
  }
  int readAt(int64_t position, uint8_t* bytes, int count) override {
    if (cancelled_ || position < 0 || count < 0) return -1;
    ssize_t n;
    do { n = pread(fd_, bytes, static_cast<size_t>(count), position); } while (n < 0 && errno == EINTR && !cancelled_);
    return cancelled_ ? -1 : static_cast<int>(n);
  }
  void cancel() override { cancelled_ = true; }
  int localFileDescriptor() override { return fd_; }
 private:
  int fd_;
  std::atomic<bool> cancelled_{false};
};
#endif
std::string utf8(const std::filesystem::path &path) {
  auto s = path.u8string();
  return {reinterpret_cast<const char *>(s.data()), s.size()};
}
std::string assetDirectory() {
#if defined(_WIN32)
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                          reinterpret_cast<LPCWSTR>(&assetDirectory), &module))
    return {};
  std::wstring file(32768, L'\0');
  DWORD n =
      GetModuleFileNameW(module, file.data(), static_cast<DWORD>(file.size()));
  if (!n || n == file.size())
    return {};
  file.resize(n);
  return utf8(std::filesystem::path(file).parent_path() / "automix-native");
#elif defined(__linux__) && !defined(__ANDROID__)
  Dl_info module{};
  if (!dladdr(reinterpret_cast<const void *>(&assetDirectory), &module) || !module.dli_fname)
    return {};
  const std::filesystem::path file(module.dli_fname);
  if (!file.is_absolute()) return {}; // Never bind models to a caller's working directory.
  return utf8(file.parent_path() / "automix-native");
#else
  return {};
#endif
}
std::string failure(const std::string &reason, const std::string &detail = {}) {
  return "{\"ok\":false,\"algorithm\":\"Twilight AutoMix\",\"reason\":\"" +
         json_utils::escape(reason) + "\",\"error\":\"" +
         json_utils::escape(detail) + "\"}";
}
std::vector<float> downmix(const std::vector<float> &stereo) {
  std::vector<float> mono(stereo.size() / 2);
  ta_am_get_kernels(TA_AM_AUTO)->downmix(mono.data(), stereo.data(), mono.size());
  return mono;
}
template <class T>
void arrayJson(std::ostringstream &out, const T *values, size_t count) {
  out << '[';
  for (size_t i = 0; i < count; i++) {
    if (i)
      out << ',';
    out << values[i];
  }
  out << ']';
}
bool numberArray(const std::string &json, const char *name, double *values,
                 size_t limit, size_t *count) {
  auto pos = json_utils::topLevelFieldValueStart(json, name);
  if (!pos || json[*pos] != '[')
    return false;
  size_t i = *pos + 1;
  *count = 0;
  while (i < json.size()) {
    json_utils::skipWhitespace(json, &i);
    if (i >= json.size())
      return false;
    if (json[i] == ']')
      return true;
    if (*count == limit)
      return false;
    char *end = nullptr;
    double value = std::strtod(json.c_str() + i, &end);
    if (end == json.c_str() + i || !std::isfinite(value))
      return false;
    values[(*count)++] = value;
    i = static_cast<size_t>(end - json.c_str());
    json_utils::skipWhitespace(json, &i);
    if (i >= json.size())
      return false;
    if (json[i] == ']')
      return true;
    if (json[i++] != ',')
      return false;
  }
  return false;
}
} // namespace
AutoMixSource::AutoMixSource(std::string source, std::shared_ptr<SeekableInput> input)
    : path_(input ? input->localPath() : std::move(source)) {
#if !defined(_WIN32)
  if (input && input->localFileDescriptor() >= 0)
    file_ = std::make_shared<AutoMixFdInput>(input->localFileDescriptor());
#endif
}
bool AutoMixSource::snapshot(ta_am_source_stamp* s) const {
  return file_ ? ta_am_source_snapshot_fd(file_->localFileDescriptor(), s) :
      ta_am_source_snapshot(path_.c_str(), s);
}
bool AutoMixSource::identify(char hash[65], const ta_am_cancel* c) const {
  return file_ ? ta_am_source_sha256_fd(file_->localFileDescriptor(), hash, c) :
      ta_am_source_sha256(path_.c_str(), hash, c);
}
ta_am_source_lease* AutoMixSource::acquire(const ta_am_source_stamp* s, const char hash[65], const ta_am_cancel* c) const {
  return file_ ? ta_am_source_acquire_fd(file_->localFileDescriptor(), s, hash, c) :
      ta_am_source_acquire(path_.c_str(), s, hash, c);
}
std::shared_ptr<const SeekableInputFactory> AutoMixSource::decodeFactory() const {
#if !defined(_WIN32)
  if (file_) return std::make_shared<const SeekableInputFactory>([file = file_](const std::string&) {
    return std::make_shared<AutoMixFdInput>(file->localFileDescriptor());
  });
#endif
  return {};
}
bool decodeAutoMixFrames(const QueueItem &item, const AudioFormat &format,
                         uint64_t first, size_t frames, std::vector<float> *pcm,
                         std::string *error, const ta_am_cancel *cancel,
                         DspResamplerQuality quality,
                         std::shared_ptr<const SeekableInputFactory> factory,
                         DspResamplerPhase phase) {
  if (!pcm || format.sampleRate < 8000 || format.sampleRate > 384000 ||
      format.channelCount < 1 || format.channelCount > 8 ||
      frames > static_cast<size_t>(format.sampleRate) * 40 ||
      item.cueVirtualPregapSeconds > 0) {
    if (error)
      *error = "invalid bounded decode request";
    return false;
  }
  FFmpegDecoder decoder;
  decoder.setInputFactory(std::move(factory));
  decoder.setInterrupt([](void *p) { return ta_am_cancelled(static_cast<const ta_am_cancel *>(p)); },
                       const_cast<ta_am_cancel *>(cancel));
  if (!decoder.open(item.source, error))
    return false;
  switch (quality) {
  case DspResamplerQuality::SoxrVhq:
    decoder.setResamplerQuality(FFmpegDecoder::ResamplerQuality::SoxrVhq); break;
  case DspResamplerQuality::SoxrHq:
    decoder.setResamplerQuality(FFmpegDecoder::ResamplerQuality::SoxrHq); break;
  case DspResamplerQuality::Ultra:
    decoder.setResamplerQuality(FFmpegDecoder::ResamplerQuality::Ultra); break;
  case DspResamplerQuality::High:
    decoder.setResamplerQuality(FFmpegDecoder::ResamplerQuality::High); break;
  default:
    decoder.setResamplerQuality(FFmpegDecoder::ResamplerQuality::Native); break;
  }
  switch (phase) {
  case DspResamplerPhase::Minimum:
    decoder.setResamplerPhase(FFmpegDecoder::ResamplerPhase::Minimum); break;
  case DspResamplerPhase::MinimumSmooth:
    decoder.setResamplerPhase(FFmpegDecoder::ResamplerPhase::MinimumSmooth); break;
  case DspResamplerPhase::LinearSmooth:
    decoder.setResamplerPhase(FFmpegDecoder::ResamplerPhase::LinearSmooth); break;
  default:
    decoder.setResamplerPhase(FFmpegDecoder::ResamplerPhase::Linear); break;
  }
  AudioFormat f = format;
  f.bitDepth = 32;
  f.sampleFormat = AudioSampleFormat::Float32Interleaved;
  if (!decoder.setOutputFormat(f, error))
    return false;
  const double cueStart = item.cueStartSeconds.value_or(0);
  if (!std::isfinite(cueStart) || cueStart < 0 || cueStart > 604800 ||
      first > static_cast<uint64_t>(f.sampleRate) * 604800)
    return false;
  if (item.cueEndSeconds) {
    double length = *item.cueEndSeconds - cueStart;
    if (!std::isfinite(length) || length <= 0)
      return false;
    uint64_t logicalEnd =
        static_cast<uint64_t>(std::llround(length * f.sampleRate));
    if (first >= logicalEnd)
      return false;
    frames =
        static_cast<size_t>(std::min<uint64_t>(frames, logicalEnd - first));
  }
  const uint64_t offset =
      static_cast<uint64_t>(std::llround(cueStart * f.sampleRate));
  if (first + offset < first || !decoder.seekOutputFrame(first + offset, error))
    return false;
  pcm->resize(frames * static_cast<size_t>(f.channelCount));
  size_t read = 0;
  while (read < frames) {
    size_t got =
        decoder.readFrames(pcm->data() + read * f.channelCount,
                           std::min<size_t>(2048, frames - read), error);
    if (!got)
      break;
    read += got;
  }
  pcm->resize(read * static_cast<size_t>(f.channelCount));
  return read > 0;
}
std::string autoMixFeaturesJson(const ta_am_features &f,
                                const std::string &identity) {
  std::ostringstream out;
  out << std::setprecision(10)
      << "{\"ok\":true,\"algorithm\":\"Twilight AutoMix\",\"modelVersion\":\""
      << TA_AM_MODEL_VERSION << "\",\"sourceIdentity\":\""
      << json_utils::escape(identity)
      << "\",\"coverage\":{\"startSeconds\":" << f.start_seconds
      << ",\"endSeconds\":" << f.end_seconds
      << ",\"durationSeconds\":" << f.duration_seconds
      << ",\"complete\":" << (f.complete ? "true" : "false")
      << "},\"bpm\":" << f.bpm << ",\"tempoConfidence\":" << f.tempo_confidence
      << ",\"rmsDb\":" << f.rms_db << ",\"peak\":" << f.peak
      << ",\"key\":" << f.key << ",\"keyConfidence\":" << f.key_confidence
      << ",\"beats\":";
  arrayJson(out, f.beats, f.beat_count);
  out << ",\"downbeats\":";
  arrayJson(out, f.downbeats, f.downbeat_count);
  out << ",\"voice\":[";
  for (unsigned i = 0; i < f.voice_count; i++) {
    if (i)
      out << ',';
    out << "{\"startSeconds\":" << f.voice_start[i]
        << ",\"endSeconds\":" << f.voice_end[i]
        << ",\"probability\":" << f.voice[i] << ",\"music\":" << f.music[i]
        << '}';
  }
  out << "],\"frameDb\":";
  arrayJson(out, f.frame_db, f.frame_count);
  out << ",\"framePeak\":";
  arrayJson(out, f.frame_peak, f.frame_count);
  if (f.spectral_count) {
    out << ",\"frameOnset\":";
    arrayJson(out, f.frame_onset, f.frame_count);
    out << ",\"frameLowDb\":";
    arrayJson(out, f.frame_low_db, f.frame_count);
  }
  out << '}';
  return out.str();
}
bool parseAutoMixFeatures(const std::string &json, ta_am_features *f,
                          std::string *error) {
  if (!f || json.size() > 256 * 1024 || !AutoMixJsonValidation(json).valid() ||
      json_utils::fieldString(json, "algorithm").value_or("") !=
          "Twilight AutoMix" ||
      json_utils::fieldString(json, "modelVersion").value_or("") !=
          TA_AM_MODEL_VERSION ||
      !json_utils::fieldBool(json, "ok").value_or(false)) {
    if (error)
      *error = "stale or invalid Twilight AutoMix features";
    return false;
  }
  const auto identity =
      json_utils::fieldString(json, "sourceIdentity").value_or("");
  if (identity.size() != 64 ||
      identity.find_first_not_of("0123456789abcdef") != std::string::npos)
    return false;
  for (const char *name :
       {"bpm", "tempoConfidence", "rmsDb", "peak", "key", "keyConfidence"})
    if (!json_utils::fieldNumber(json, name))
      return false;
  *f = {};
  auto coverage = json_utils::fieldObject(json, "coverage");
  f->start_seconds =
      json_utils::fieldNumber(coverage, "startSeconds").value_or(-1);
  f->end_seconds = json_utils::fieldNumber(coverage, "endSeconds").value_or(-1);
  f->duration_seconds =
      json_utils::fieldNumber(coverage, "durationSeconds").value_or(0);
  f->complete = json_utils::fieldBool(coverage, "complete").value_or(false);
  f->bpm = static_cast<float>(json_utils::fieldNumber(json, "bpm").value_or(0));
  f->tempo_confidence = static_cast<float>(
      json_utils::fieldNumber(json, "tempoConfidence").value_or(0));
  f->rms_db =
      static_cast<float>(json_utils::fieldNumber(json, "rmsDb").value_or(-140));
  f->peak =
      static_cast<float>(json_utils::fieldNumber(json, "peak").value_or(0));
  double key = json_utils::fieldNumber(json, "key").value_or(-1);
  if (!std::isfinite(key) || key < -1 || key > 23 || key != std::floor(key))
    return false;
  f->key = static_cast<int32_t>(key);
  f->key_confidence = static_cast<float>(
      json_utils::fieldNumber(json, "keyConfidence").value_or(0));
  size_t count;
  double values[1500];
  if (!numberArray(json, "beats", f->beats, 1500, &count))
    return false;
  f->beat_count = static_cast<uint32_t>(count);
  if (!numberArray(json, "downbeats", f->downbeats, 1500, &count))
    return false;
  f->downbeat_count = static_cast<uint32_t>(count);
  if (!numberArray(json, "frameDb", values, 1500, &count))
    return false;
  f->frame_count = static_cast<uint32_t>(count);
  for (size_t i = 0; i < count; i++)
    f->frame_db[i] = static_cast<float>(values[i]);
  if (!numberArray(json, "framePeak", values, 1500, &count) ||
      count != f->frame_count)
    return false;
  for (size_t i = 0; i < count; i++)
    f->frame_peak[i] = static_cast<float>(values[i]);
  if (json_utils::topLevelFieldValueStart(json, "frameOnset") ||
      json_utils::topLevelFieldValueStart(json, "frameLowDb")) {
    if (!numberArray(json, "frameOnset", values, 1500, &count) || count != f->frame_count) return false;
    for (size_t i = 0; i < count; i++) f->frame_onset[i] = static_cast<float>(values[i]);
    if (!numberArray(json, "frameLowDb", values, 1500, &count) || count != f->frame_count) return false;
    for (size_t i = 0; i < count; i++) f->frame_low_db[i] = static_cast<float>(values[i]);
    f->spectral_count = f->frame_count;
  }
  const auto voiceArray = json_utils::fieldArray(json, "voice");
  if (voiceArray.empty())
    return false;
  size_t voicePos = 1;
  while (voicePos < voiceArray.size()) {
    json_utils::skipWhitespace(voiceArray, &voicePos);
    if (voiceArray[voicePos] == ']')
      break;
    if (voiceArray[voicePos] != '{')
      return false;
    auto end = json_utils::matchingContainerEnd(voiceArray, voicePos);
    if (!end)
      return false;
    auto entry = voiceArray.substr(voicePos, *end - voicePos);
    if (f->voice_count == 64)
      return false;
    unsigned i = f->voice_count++;
    f->voice_start[i] =
        json_utils::fieldNumber(entry, "startSeconds").value_or(-1);
    f->voice_end[i] = json_utils::fieldNumber(entry, "endSeconds").value_or(-1);
    f->voice[i] = static_cast<float>(
        json_utils::fieldNumber(entry, "probability").value_or(-1));
    f->music[i] = static_cast<float>(
        json_utils::fieldNumber(entry, "music").value_or(-1));
    voicePos = *end;
    json_utils::skipWhitespace(voiceArray, &voicePos);
    if (voiceArray[voicePos] == ']')
      break;
    if (voiceArray[voicePos++] != ',')
      return false;
  }
  return f->end_seconds - f->start_seconds <= 30.001 && ta_am_features_valid(f) != 0;
}
bool parseAutoMixWindows(const std::string& request, const char* name,
                         const char* legacy, ta_am_features* out, std::string* error) {
  const auto array = json_utils::fieldArray(request, name);
  if (array.empty()) return parseAutoMixFeatures(json_utils::fieldObject(request, legacy), out, error);
  std::vector<std::unique_ptr<ta_am_features>> windows;
  std::string identity;
  size_t pos = 1;
  while (pos < array.size()) {
    json_utils::skipWhitespace(array, &pos);
    if (array[pos] == ']') break;
    if (array[pos] != '{' || windows.size() >= 6) return false;
    auto end = json_utils::matchingContainerEnd(array, pos);
    if (!end) return false;
    auto entry = array.substr(pos, *end - pos);
    auto f = std::make_unique<ta_am_features>();
    if (!parseAutoMixFeatures(entry, f.get(), error)) return false;
    auto id = json_utils::fieldString(entry, "sourceIdentity").value_or("");
    if (!windows.empty() && (id != identity || std::abs(f->duration_seconds - windows[0]->duration_seconds) > 1e-7)) return false;
    identity = id;
    windows.push_back(std::move(f));
    pos = *end;
    json_utils::skipWhitespace(array, &pos);
    if (array[pos] == ']') break;
    if (array[pos++] != ',') return false;
  }
  if (windows.empty() || identity != json_utils::fieldString(json_utils::fieldObject(request, legacy), "sourceIdentity").value_or("")) return false;
  std::sort(windows.begin(), windows.end(), [](const auto& a, const auto& b) { return a->start_seconds < b->start_seconds; });
  *out = *windows[0];
  double covered = out->end_seconds;
  for (const auto& f : windows) {
    if (f->start_seconds > covered + 1e-6) { if (error) *error = "analysis_coverage_gap"; return false; }
    covered = std::max(covered, f->end_seconds);
  }
  out->end_seconds = covered;
  if (covered - out->start_seconds > 120.001) return false;
  out->complete = out->start_seconds == 0 && std::abs(covered - out->duration_seconds) < 1e-4;
  out->frame_count = static_cast<unsigned>(std::ceil((covered - out->start_seconds) * 50 - 1e-6));
  out->spectral_count = out->frame_count;
  out->beat_count = out->downbeat_count = out->voice_count = 0;
  std::vector<double> beats, downbeats, boundaries;
  const auto owner = [&](double time) {
    const ta_am_features* chosen = nullptr;
    double margin = -1;
    for (const auto& f : windows) if (time >= f->start_seconds && time <= f->end_seconds) {
      double m = std::min(time - f->start_seconds, f->end_seconds - time);
      if (m > margin) { chosen = f.get(); margin = m; }
    }
    return chosen;
  };
  double energy = 0;
  for (const auto& f : windows) {
    for (unsigned i = 0; i < f->beat_count; i++)
      if (owner(f->beats[i]) == f.get()) beats.push_back(f->beats[i]);
    for (unsigned i = 0; i < f->downbeat_count; i++)
      if (owner(f->downbeats[i]) == f.get()) downbeats.push_back(f->downbeats[i]);
    for (unsigned i = 0; i < f->voice_count; i++) { boundaries.push_back(f->voice_start[i]); boundaries.push_back(f->voice_end[i]); }
    boundaries.push_back(f->start_seconds); boundaries.push_back(f->end_seconds);
    for (const auto& g : windows) {
      double switch_time = (f->start_seconds + g->end_seconds) / 2;
      if (switch_time >= out->start_seconds && switch_time <= covered) boundaries.push_back(switch_time);
    }
    if (!f->spectral_count) out->spectral_count = 0;
    out->tempo_confidence = std::min(out->tempo_confidence, f->tempo_confidence);
    if (f->key != out->key) { out->key = -1; out->key_confidence = 0; }
  }
  for (unsigned i = 0; i < out->frame_count; i++) {
    double time = out->start_seconds + i / 50.;
    const ta_am_features* chosen = owner(time);
    if (!chosen) return false;
    unsigned j = std::min(chosen->frame_count - 1, static_cast<unsigned>(std::max(0., std::floor((time - chosen->start_seconds) * 50))));
    out->frame_db[i] = chosen->frame_db[j]; out->frame_peak[i] = chosen->frame_peak[j];
    out->frame_onset[i] = chosen->frame_onset[j]; out->frame_low_db[i] = chosen->frame_low_db[j];
    energy += std::pow(10., out->frame_db[i] / 10.);
  }
  out->rms_db = static_cast<float>(10 * std::log10(std::max(1e-16, energy / out->frame_count)));
  const auto events = [](std::vector<double>& v, double* dst, unsigned* n) {
    std::sort(v.begin(), v.end());
    for (double t : v) if (!*n || t - dst[*n - 1] > .08) { if (*n == TA_AM_MAX_EVENTS) return false; dst[(*n)++] = t; }
    return true;
  };
  if (!events(beats, out->beats, &out->beat_count) || !events(downbeats, out->downbeats, &out->downbeat_count)) return false;
  std::sort(boundaries.begin(), boundaries.end());
  boundaries.erase(std::unique(boundaries.begin(), boundaries.end()), boundaries.end());
  for (size_t i = 1; i < boundaries.size(); i++) {
    double s = boundaries[i - 1], e = boundaries[i], mid = (s + e) / 2;
    float voice = -1, music = 0;
    const ta_am_features* f = owner(mid);
    if (f) for (unsigned j = 0; j < f->voice_count; j++)
      if (mid >= f->voice_start[j] && mid < f->voice_end[j]) { voice = std::max(voice, f->voice[j]); music = std::max(music, f->music[j]); }
    if (voice < 0 || e - s < 1e-8) continue; // Coverage gaps remain unknown.
    unsigned n = out->voice_count;
    if (n && std::abs(out->voice_end[n - 1] - s) < 1e-7 && out->voice[n - 1] == voice && out->music[n - 1] == music) out->voice_end[n - 1] = e;
    else {
      if (n == TA_AM_MAX_VOICE) return false;
      out->voice_start[n] = s; out->voice_end[n] = e; out->voice[n] = voice; out->music[n] = music; out->voice_count++;
    }
  }
  return ta_am_features_valid(out) != 0;
}
std::string identifyAutoMixSourceJson(const std::string &source,
    std::shared_ptr<const SeekableInputFactory> factory, const ta_am_cancel* cancel) {
  auto input = factory ? (*factory)(source) : nullptr;
  const AutoMixSource backing(source, input);
  char hash[65]{};
  if (!backing.identify(hash, cancel))
    return failure(ta_am_cancelled(cancel) ? "analysis_cancelled" : "actual_source_identity_unavailable");
  return std::string("{\"ok\":true,\"sourceIdentity\":\"") + hash + "\"}";
}
std::string analyzeAutoMixJson(const std::string &source,
                               const std::string &options,
                               std::shared_ptr<const SeekableInputFactory> factory,
                               const ta_am_cancel* cancel) {
  if (options.size() > 64 * 1024 || !AutoMixJsonValidation(options).valid())
    return failure("invalid_analysis_options");
  const auto identity =
      json_utils::fieldString(options, "sourceIdentity").value_or("");
  if (identity.size() != 64 ||
      identity.find_first_not_of("0123456789abcdef") != std::string::npos)
    return failure("invalid_source_identity");
  if (ta_am_cancelled(cancel)) return failure("analysis_cancelled");
  auto input = factory ? (*factory)(source) : nullptr;
  const AutoMixSource backing(source, input);
  ta_am_source_stamp before{};
  if (!backing.snapshot(&before))
    return failure("actual_source_identity_unavailable");
  auto lease = std::unique_ptr<ta_am_source_lease, decltype(&ta_am_source_release)>(
      backing.acquire(&before, identity.c_str(), cancel), ta_am_source_release);
  if (!lease) return failure(ta_am_cancelled(cancel) ? "analysis_cancelled" : "source_changed_or_identity_unavailable");
  FFmpegDecoder probe;
  probe.setInputFactory(backing.decodeFactory());
  probe.setInterrupt([](void* p) { return ta_am_cancelled(static_cast<const ta_am_cancel*>(p)); },
      const_cast<ta_am_cancel*>(cancel));
  std::string error;
  if (!probe.open(backing.decodeSource(source), &error))
    return failure(ta_am_cancelled(cancel) ? "analysis_cancelled" : "decode_failed", error);
  const double physicalDuration = probe.streamInfo().durationSeconds;
  if (!std::isfinite(physicalDuration) || physicalDuration <= 0 || physicalDuration > 604800 ||
      probe.streamInfo().isDsd)
    return failure("unsupported_source");
  const double cueStart = json_utils::fieldNumber(options, "sourceStartSeconds")
                              .value_or(0),
               cueEnd = json_utils::fieldNumber(options, "sourceEndSeconds")
                            .value_or(physicalDuration);
  if (!std::isfinite(cueStart) || !std::isfinite(cueEnd) || cueStart < 0 ||
      cueEnd <= cueStart || cueEnd > physicalDuration + 0.05)
    return failure("invalid_source_range");
  const double duration = cueEnd - cueStart;
  double start =
      json_utils::fieldString(options, "boundary").value_or("head") == "tail"
          ? std::max(0.0, duration - 30)
          : json_utils::fieldNumber(options, "rangeStartSeconds").value_or(0);
  if (!std::isfinite(start) || start < 0 || start >= duration)
    return failure("invalid_analysis_range");
  const double length = std::min(30.0, duration - start);
  QueueItem item;
  item.source = backing.decodeSource(source);
  item.cueStartSeconds = cueStart;
  item.cueEndSeconds = cueEnd;
  AudioFormat format;
  format.channelCount = 2;
  format.sampleRate = 22050;
  std::vector<float> stereo;
  if (!decodeAutoMixFrames(
          item, format, static_cast<uint64_t>(std::llround(start * 22050)),
          static_cast<size_t>(std::floor(length * 22050)), &stereo, &error, cancel,
          DspResamplerQuality::High, backing.decodeFactory()))
    return failure(ta_am_cancelled(cancel) ? "analysis_cancelled" : "decode_failed", error);
  auto beat = downmix(stereo);
  format.sampleRate = 16000;
  if (!decodeAutoMixFrames(
          item, format, static_cast<uint64_t>(std::llround(start * 16000)),
          static_cast<size_t>(std::floor(length * 16000)), &stereo, &error, cancel,
          DspResamplerQuality::High, backing.decodeFactory()))
    return failure(ta_am_cancelled(cancel) ? "analysis_cancelled" : "decode_failed", error);
  auto voice = downmix(stereo);
  const std::string assets = json_utils::fieldString(options, "assetDirectory")
                                 .value_or(assetDirectory());
  if (assets.empty())
    return failure("public_assets_unavailable");
  // A utility worker runs one task at a time; the mutex also bounds direct ABI
  // callers to one model execution and protects the reusable arena.
  static std::mutex mutex;
  static std::string currentAssets;
  static std::unique_ptr<ta_am_analyser, decltype(&ta_am_analyser_free)>
      analyser(nullptr, ta_am_analyser_free);
  std::lock_guard lock(mutex);
  if (ta_am_cancelled(cancel)) return failure("analysis_cancelled");
  if (!analyser || currentAssets != assets) {
    char why[256] = {};
    const auto folder = std::filesystem::u8path(assets);
    analyser.reset(
        ta_am_analyser_create(utf8(folder / "beat-this.tamg").c_str(),
                              utf8(folder / "yamnet.tamg").c_str(),
                              ta_am_get_kernels(TA_AM_AUTO), why, sizeof(why)));
    if (!analyser)
      return failure("public_assets_unavailable", why);
    currentAssets = assets;
  }
  auto features = std::make_unique<ta_am_features>();
  int result = ta_am_analyse_window(analyser.get(), beat.data(), beat.size(),
                                    voice.data(), voice.size(), start, duration,
                                    features.get(), cancel);
  if (ta_am_cancelled(cancel)) return failure("analysis_cancelled");
  ta_am_source_stamp after{};
  if (!ta_am_source_valid(lease.get()) || !backing.snapshot(&after) ||
      !ta_am_source_stamp_equal(&before, &after)) return failure("source_changed_or_identity_unavailable");
  if (result)
    return failure("analysis_failed", std::to_string(result));
  return autoMixFeaturesJson(*features, identity);
}
} // namespace twilight::audio
