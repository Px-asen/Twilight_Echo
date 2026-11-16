#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <vector>
#include <fstream>
#include <filesystem>

namespace twilight::audio {

enum class DiagLevel {
  Info,
  Warning,
  Error
};

const char* diagnosticLevelName(DiagLevel level);

// ISO-8601 UTC ("2026-08-27T12:34:56.789Z") for an epoch-millisecond value.
std::string diagnosticIsoTimestamp(uint64_t epochMs);

// Bounded process-wide ring of engine events that feed the diagnostics export.
// Route decisions, DSD probe failures and PCM fallbacks land here with
// timestamps and levels, so an exported report can answer "what did the engine
// decide, why, and in which order" without the low-level TAE_ASIO_TRACE_PATH
// environment tracing being enabled.
class DiagnosticLog {
 public:
  struct Entry {
    uint64_t sequence = 0;
    uint64_t epochMs = 0;
    DiagLevel level = DiagLevel::Info;
    std::string event;
    std::string message;
    std::string detailsJson;
    std::string operationId, requestId;
  };

  static DiagnosticLog& instance();

  void append(DiagLevel level, const std::string& event, const std::string& message,
              const std::string& detailsJson = "{}");

  // JSON array of the newest entries with sequence > sinceSequence, oldest
  // first. nextSequence (when non-null) receives the value to pass on the next
  // call so callers only ever see new events.
  std::string toJson(uint64_t sinceSequence, size_t maxEntries, uint64_t* nextSequence) const;

  // The sequence the next appended entry will receive.
  uint64_t nextSequence() const;
  bool trySnapshot(uint64_t sinceSequence, std::vector<Entry>& entries) const;
  static void setContext(const std::string& json);
  static void setDebugCapture(const std::string& id, const std::string& directory);

  void clearForTests();

 private:
  DiagnosticLog() = default;

  mutable std::mutex mutex_;
  std::deque<Entry> entries_;
  uint64_t sequence_ = 0;
};

}  // namespace twilight::audio

namespace twilight::audio {
// Used exclusively by the diagnostic thread; never by a render callback.
class DiagnosticJournal {
 public:
  DiagnosticJournal();
  void write(const std::string& event, const std::string& details, DiagLevel level = DiagLevel::Info,
             uint64_t originalSequence = 0, uint64_t epochMs = 0, const std::string& operationId = {}, const std::string& requestId = {});
  void drain();
 private:
  std::filesystem::path directory_, file_;
  std::string instance_, session_;
  uint64_t sequence_ = 0, ringSequence_ = 0, bytes_ = 0;
  uint64_t startMs_ = 0;
  unsigned part_ = 0;
  bool reportedFailure_ = false;
  bool reportedDebugFailure_ = false;
};
// Conservative token sanitizer: retain numeric counters and known enums,
// fingerprint other strings, and redact authentication fields recursively.
std::string sanitizeNativeDiagnosticJson(const std::string& json, bool preservePaths = false);
struct EmptyOutputDetector {
  uint64_t token = 0, callbacks = 0, consumed = 0;
  unsigned consecutive = 0;
  bool marked = false;
  bool sample(bool available, bool playing, bool eof, bool stopped, uint64_t nextToken,
              uint64_t nextCallbacks, uint64_t nextConsumed);
};
struct HealthSampleGate {
  std::string lastIdleSignature;
  bool hasIdleSample = false;
  bool shouldWrite(bool active, uint64_t clockAgeMs, const std::string& signature);
};
}
