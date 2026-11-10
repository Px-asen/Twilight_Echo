#include "DiagnosticLog.h"
#include "Utf8Path.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <regex>
#include <sstream>
#include <iomanip>
#include <cerrno>
#include "../utils/JsonUtils.h"
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <process.h>
#else
#include <unistd.h>
#endif

namespace twilight::audio {
namespace {

constexpr size_t kMaxEntries = 512;
constexpr size_t kMaxMessageChars = 512;
constexpr size_t kMaxDetailsChars = 8192;
constexpr size_t kMaxEventChars = 64;
thread_local std::string diagnosticOperationId, diagnosticRequestId;
std::mutex debugCaptureMutex;
std::string debugCaptureId, debugCaptureDirectory;
bool debugCaptureConfigured = false;

std::string truncated(std::string value, size_t maxChars) {
  if (value.size() <= maxChars) return value;
  value.resize(maxChars);
  return value;
}

std::string jsonEscape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (const char raw : value) {
    const unsigned char ch = static_cast<unsigned char>(raw);
    switch (ch) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (ch < 0x20) {
          char buffer[8];
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", ch);
          out += buffer;
        } else {
          out += raw;
        }
    }
  }
  return out;
}

uint64_t nowEpochMs() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(now).count());
}

}  // namespace

const char* diagnosticLevelName(DiagLevel level) {
  switch (level) {
    case DiagLevel::Info:
      return "info";
    case DiagLevel::Warning:
      return "warning";
    case DiagLevel::Error:
      return "error";
  }
  return "info";
}

std::string diagnosticIsoTimestamp(uint64_t epochMs) {
  const uint64_t msOfDay = epochMs % 86400000ULL;
  const int64_t days = static_cast<int64_t>(epochMs / 86400000ULL);
  // civil-from-days (Howard Hinnant's algorithm), epoch 1970-01-01.
  const int64_t z = days + 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const int64_t doe = z - era * 146097;
  const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const int64_t y = yoe + era * 400;
  const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const int64_t mp = (5 * doy + 2) / 153;
  const int64_t d = doy - (153 * mp + 2) / 5 + 1;
  const int64_t m = mp < 10 ? mp + 3 : mp - 9;
  const int year = static_cast<int>(y + (m <= 2 ? 1 : 0));
  char out[40];
  std::snprintf(out, sizeof(out), "%04d-%02lld-%02lldT%02llu:%02llu:%02llu.%03lluZ", year,
                static_cast<long long>(m), static_cast<long long>(d),
                static_cast<unsigned long long>(msOfDay / 3600000ULL),
                static_cast<unsigned long long>((msOfDay / 60000ULL) % 60ULL),
                static_cast<unsigned long long>((msOfDay / 1000ULL) % 60ULL),
                static_cast<unsigned long long>(msOfDay % 1000ULL));
  return out;
}

DiagnosticLog& DiagnosticLog::instance() {
  static DiagnosticLog log;
  return log;
}

void DiagnosticLog::append(DiagLevel level, const std::string& event, const std::string& message,
                           const std::string& detailsJson) {
  Entry entry;
  entry.epochMs = nowEpochMs();
  entry.level = level;
  entry.event = truncated(event, kMaxEventChars);
  entry.message = truncated(message, kMaxMessageChars);
  entry.detailsJson = truncated(detailsJson, kMaxDetailsChars);
  entry.operationId = diagnosticOperationId; entry.requestId = diagnosticRequestId;
  {
    std::lock_guard lock(mutex_);
    entry.sequence = ++sequence_;
    entries_.push_back(entry);
    while (entries_.size() > kMaxEntries) entries_.pop_front();
  }
}

std::string DiagnosticLog::toJson(uint64_t sinceSequence, size_t maxEntries,
                                  uint64_t* nextSequence) const {
  std::deque<Entry> snapshot;
  {
    std::lock_guard lock(mutex_);
    if (nextSequence) *nextSequence = sequence_;
    for (const Entry& entry : entries_) {
      if (entry.sequence > sinceSequence) snapshot.push_back(entry);
    }
  }
  if (maxEntries > 0 && snapshot.size() > maxEntries) {
    snapshot.erase(snapshot.begin(), snapshot.end() - static_cast<std::ptrdiff_t>(maxEntries));
  }

  std::string json = "[";
  bool first = true;
  for (const Entry& entry : snapshot) {
    if (!first) json += ',';
    first = false;
    json += "{\"sequence\":";
    json += std::to_string(entry.sequence);
    json += ",\"timestamp\":\"";
    json += diagnosticIsoTimestamp(entry.epochMs);
    json += "\",\"level\":\"";
    json += diagnosticLevelName(entry.level);
    json += "\",\"event\":\"";
    json += jsonEscape(entry.event);
    json += "\",\"message\":\"";
    json += jsonEscape(entry.message);
    json += "\",\"details\":";
    json += entry.detailsJson.empty() ? "{}" : entry.detailsJson;
    json += '}';
  }
  json += ']';
  return json;
}

uint64_t DiagnosticLog::nextSequence() const {
  std::lock_guard lock(mutex_);
  return sequence_;
}

void DiagnosticLog::clearForTests() {
  std::lock_guard lock(mutex_);
  entries_.clear();
  sequence_ = 0;
}

bool DiagnosticLog::trySnapshot(uint64_t since, std::vector<Entry>& entries) const {
  std::unique_lock lock(mutex_, std::try_to_lock);
  if (!lock.owns_lock()) return false;
  for (const auto& entry : entries_) if (entry.sequence > since) entries.push_back(entry);
  return true;
}

void DiagnosticLog::setContext(const std::string& json) {
  const auto read = [&json](const char* key) {
    const auto start = json_utils::topLevelFieldValueStart(json, key);
    if (!start) return std::string{};
    const auto value = json_utils::parseStringToken(json, *start, nullptr);
    if (!value || value->size() > 128 || !std::all_of(value->begin(), value->end(), [](unsigned char ch) { return std::isalnum(ch) || ch == '-' || ch == '_'; })) return std::string{};
    return *value;
  };
  diagnosticOperationId = read("operationId"); diagnosticRequestId = read("requestId");
}
void DiagnosticLog::setDebugCapture(const std::string& id, const std::string& directory) {
  std::lock_guard lock(debugCaptureMutex);
  debugCaptureConfigured = true;
  debugCaptureId = id; debugCaptureDirectory = directory;
}

namespace {
std::string fingerprint(const std::string& value) {
  uint64_t hash = 14695981039346656037ULL;
  for (unsigned char ch : value) { hash ^= ch; hash *= 1099511628211ULL; }
  std::ostringstream out; out << std::hex << std::setw(16) << std::setfill('0') << hash;
  return out.str();
}
std::string safeIdentifier(std::string value) {
  if (value.size() > 128) value.resize(128);
  for (char& ch : value) if (!std::isalnum(static_cast<unsigned char>(ch)) && ch != '-' && ch != '_' && ch != '.') ch = '_';
  return value;
}
uint64_t steadyMs() {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
}

std::filesystem::path environmentPath(const char* name) {
#ifdef _WIN32
  // getenv() uses the Windows ANSI code page, not Node's UTF-8. Passing its
  // bytes to u8path throws for Chinese profile paths before the journal's
  // write error handler can run, taking down the entire audio service.
  const std::wstring wideName(name, name + std::char_traits<char>::length(name));
  DWORD size = GetEnvironmentVariableW(wideName.c_str(), nullptr, 0);
  while (size) {
    std::wstring value(size, L'\0');
    const DWORD length = GetEnvironmentVariableW(wideName.c_str(), value.data(), size);
    if (!length) return {};
    if (length < size) {
      value.resize(length);
      return std::filesystem::path(value);
    }
    size = length;
  }
  return {};
#else
  const char* value = std::getenv(name);
  return value ? std::filesystem::path(value) : std::filesystem::path{};
#endif
}
}

std::string sanitizeNativeDiagnosticJson(const std::string& json, bool preservePaths) {
  // Token based, including escaped JSON strings; no raw string payload reaches disk.
  if (json.size() > 8192) return "{\"truncated\":true}";
  static const std::regex secret("password|passwd|secret|cookie|authorization|credential|^token$|(?:access|refresh|auth|bearer).?token|signature|api.?key", std::regex::icase);
  static const std::regex enums("^(idle|reading|writing|exited|playing|paused|stopped|pcm|dsd|asio|wasapi|shared|exclusive|stream_retired|transport_stop|seek|stop|queue_update|transition_completed|unavailable|pipeline-lock-busy|no-active-stream)$");
  std::string out;
  for (size_t i = 0; i < json.size();) {
    if (json[i] != '"') { out += json[i++]; continue; }
    size_t end = i;
    const auto value = json_utils::parseStringToken(json, i, &end);
    if (!value) return "{\"invalidDetails\":true}";
    size_t next = end; json_utils::skipWhitespace(json, &next);
    if (next < json.size() && json[next] == ':') {
      out += '"' + jsonEscape(safeIdentifier(*value)) + "\":";
      i = next + 1; json_utils::skipWhitespace(json, &i);
      if (std::regex_search(*value, secret)) {
        if (i < json.size() && json[i] == '"') {
          if (!json_utils::parseStringToken(json, i, &end)) return "{}";
          i = end;
        } else if (i < json.size() && (json[i] == '{' || json[i] == '[')) {
          const auto containerEnd = json_utils::matchingContainerEnd(json, i);
          if (!containerEnd) return "{}";
          i = *containerEnd;
        } else { while (i < json.size() && json[i] != ',' && json[i] != '}') ++i; }
        out += "\"[redacted]\"";
      }
    } else {
      if (preservePaths && (value->rfind("/", 0) == 0 || value->rfind("\\\\", 0) == 0 ||
          (value->size() > 2 && (*value)[1] == ':' && ((*value)[2] == '\\' || (*value)[2] == '/')))) out += '"' + jsonEscape(*value) + '"';
      else if (std::regex_match(*value, enums)) out += '"' + *value + '"';
      else out += "{\"kind\":\"identifier\",\"fingerprint\":\"" + fingerprint(*value) + "\"}";
      i = end;
    }
  }
  return out;
}

DiagnosticJournal::DiagnosticJournal() {
  startMs_ = steadyMs();
  try {
    directory_ = environmentPath("TAE_DIAGNOSTICS_DIR");
    if (directory_.empty()) return;
    const char* session = std::getenv("TWILIGHT_LOG_SESSION_ID");
    session_ = safeIdentifier(session ? session : "native-standalone");
    instance_ = "native-" + std::to_string(getpid()) + '-' + std::to_string(nowEpochMs()) + '-' + fingerprint(std::to_string(reinterpret_cast<uintptr_t>(this)));
  } catch (const std::exception& error) {
    std::fprintf(stderr, "[TwilightDiagnostics] native journal unavailable; stage=initialize reason=%s\n", error.what());
    directory_.clear();
  }
}

void DiagnosticJournal::write(const std::string& event, const std::string& details, DiagLevel level,
                              uint64_t originalSequence, uint64_t epochMs, const std::string& operationId, const std::string& requestId) {
  if (directory_.empty()) return;
  try {
    const uint64_t number = ++sequence_;
    const char* generation = std::getenv("TAE_SERVICE_GENERATION");
    std::string line = "{\"schemaVersion\":1,\"timestamp\":\"" + diagnosticIsoTimestamp(epochMs ? epochMs : nowEpochMs()) +
      "\",\"monotonicMs\":" + std::to_string(steadyMs() - startMs_) + ",\"sessionId\":\"" + session_ + "\",\"processRole\":\"native\",\"processId\":" + std::to_string(getpid()) +
      ",\"processInstanceId\":\"" + instance_ + "\",\"sequence\":" + std::to_string(number) + ",\"eventId\":\"" + instance_ + ':' + std::to_string(number) +
      "\",\"serviceGeneration\":" + std::to_string(generation ? std::strtoull(generation, nullptr, 10) : 0) +
      ",\"module\":\"audio.native\",\"event\":\"" + safeIdentifier(event) + "\",\"level\":\"" + (level == DiagLevel::Warning ? "warn" : diagnosticLevelName(level)) +
      "\",\"operationId\":\"" + safeIdentifier(operationId) + "\",\"requestId\":\"" + safeIdentifier(requestId) + "\",\"details\":" + sanitizeNativeDiagnosticJson(details) + ",\"nativeSequence\":" + std::to_string(originalSequence) + "}\n";
    std::filesystem::create_directories(directory_);
    if (bytes_ && bytes_ + line.size() > 8 * 1024 * 1024) {
      std::filesystem::rename(file_, directory_ / (instance_ + '-' + std::to_string(part_) + ".jsonl"));
      ++part_; bytes_ = 0;
    }
    // Other processes may own active files. Never delete them to make room.
    uint64_t total = 0;
    for (const auto& entry : std::filesystem::directory_iterator(directory_)) {
      const auto name = entry.path().filename().u8string();
      if (entry.is_regular_file() && entry.path().extension() == ".jsonl" &&
          (name.rfind(u8"app-", 0) == 0 || name.rfind(u8"native-", 0) == 0 || name.rfind(u8"emergency-", 0) == 0)) total += entry.file_size();
    }
    if (total + line.size() > 256 * 1024 * 1024) throw std::runtime_error("diagnostic capacity reached");
    file_ = directory_ / (instance_ + '-' + std::to_string(part_) + ".active.jsonl");
    std::ofstream file(file_, std::ios::binary | std::ios::app);
    file.write(line.data(), static_cast<std::streamsize>(line.size())); file.flush();
    if (!file) throw std::runtime_error("diagnostic write failed");
    bytes_ += line.size(); reportedFailure_ = false;
  } catch (const std::exception& error) {
    if (!reportedFailure_) std::fprintf(stderr, "[TwilightDiagnostics] native journal unavailable; stage=write errno=%d reason=%s\n", errno, error.what());
    reportedFailure_ = true;
  }
  try {
    std::string debugId;
    std::filesystem::path debugDirectory;
    {
      std::lock_guard lock(debugCaptureMutex);
      if (debugCaptureConfigured) {
        debugId = debugCaptureId;
        // Live N-API strings are UTF-8; environment paths are native UTF-16.
        debugDirectory = utf8Path(debugCaptureDirectory);
      } else {
        const char* id = std::getenv("TWILIGHT_DEBUG_SESSION_ID");
        if (id) debugId = id;
        debugDirectory = environmentPath("TWILIGHT_DEBUG_DIRECTORY");
      }
    }
    if (debugId.empty() || debugDirectory.empty()) return;
    if (std::filesystem::exists(debugDirectory / "capacity-reached")) return;
    const auto directory = debugDirectory / "logs";
    std::filesystem::create_directories(directory);
    const auto file = directory / (instance_ + "-debug.active.jsonl");
    const auto size = std::filesystem::exists(file) ? std::filesystem::file_size(file) : 0;
    if (size > 64 * 1024 * 1024) throw std::runtime_error("native debug journal capacity reached");
    std::ofstream output(file, std::ios::binary | std::ios::app);
    output << "{\"schemaVersion\":1,\"eventId\":\"" << instance_ << ":" << sequence_
      << "\",\"debugSessionId\":\"" << safeIdentifier(debugId) << "\",\"sessionId\":\"" << session_
      << "\",\"processId\":" << getpid() << ",\"processRole\":\"native\",\"processInstanceId\":\"" << instance_
      << "\",\"timestamp\":\"" << diagnosticIsoTimestamp(epochMs ? epochMs : nowEpochMs()) << "\",\"module\":\"audio.native\",\"event\":\"" << safeIdentifier(event)
      << "\",\"level\":\"" << (level == DiagLevel::Warning ? "warn" : diagnosticLevelName(level))
      << "\",\"operationId\":\"" << safeIdentifier(operationId) << "\",\"requestId\":\"" << safeIdentifier(requestId)
      << "\",\"details\":" << sanitizeNativeDiagnosticJson(details, true) << ",\"nativeSequence\":" << originalSequence << "}\n";
    output.flush();
    if (!output) throw std::runtime_error("native debug journal write failed");
    reportedDebugFailure_ = false;
  } catch (const std::exception& error) {
    if (!reportedDebugFailure_) std::fprintf(stderr, "[TwilightDiagnostics] native journal unavailable; stage=debug-write errno=%d reason=%s\n", errno, error.what());
    reportedDebugFailure_ = true;
  }
}

void DiagnosticJournal::drain() {
  std::vector<DiagnosticLog::Entry> entries;
  if (!DiagnosticLog::instance().trySnapshot(ringSequence_, entries)) { write("journal.ring-unavailable", "{}"); return; }
  for (const auto& entry : entries) {
    if (entry.sequence > ringSequence_ + 1) write("events.dropped", "{\"count\":" + std::to_string(entry.sequence - ringSequence_ - 1) + "}", DiagLevel::Warning);
    write(entry.event, entry.detailsJson, entry.level, entry.sequence, entry.epochMs, entry.operationId, entry.requestId);
    ringSequence_ = entry.sequence;
  }
}

bool EmptyOutputDetector::sample(bool available, bool playing, bool eof, bool stopped, uint64_t nextToken,
                                uint64_t nextCallbacks, uint64_t nextConsumed) {
  const bool empty = available && playing && !eof && !stopped && nextToken && nextToken == token &&
      nextCallbacks > callbacks && nextConsumed == consumed;
  consecutive = empty ? consecutive + 1 : 0;
  if (!empty) marked = false;
  token = nextToken; callbacks = nextCallbacks; consumed = nextConsumed;
  if (consecutive >= 3 && !marked) { marked = true; return true; }
  return false;
}

}  // namespace twilight::audio
