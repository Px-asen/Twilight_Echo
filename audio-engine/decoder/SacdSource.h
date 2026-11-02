#pragma once

#include <algorithm>
#include <cctype>
#include <string>

namespace twilight::audio {

struct SacdSource {
  std::string path;
  std::string area;
  int track = -1;
};

// URI tracks use a reserved suffix rather than modifying the provider's query
// or document ID. Desktop .iso?area=...&track=... sources retain their contract.
inline SacdSource parseSacdSource(const std::string& source) {
  SacdSource result{source};
  const auto lower = [](std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
      return static_cast<char>(std::tolower(ch));
    });
    return value;
  };
  const bool uri = source.find("://") != std::string::npos;
  constexpr const char* marker = "#twilight-sacd=";
  const auto fragment = source.rfind(marker);
  if (uri && fragment != std::string::npos) {
    const auto selector = source.substr(fragment + std::char_traits<char>::length(marker));
    const auto colon = selector.find(':');
    result.path = source.substr(0, fragment);
    result.area = lower(selector.substr(0, colon));
    if (colon != std::string::npos) {
      try { result.track = std::stoi(selector.substr(colon + 1)); } catch (...) {}
    }
    return result;
  }
  // A URI's ordinary query belongs to its provider, not to the SACD reader.
  if (uri) return result;
  const auto query = source.find('?');
  if (query == std::string::npos) return result;
  // Only the legacy ISO track entry point owns this query syntax. Other
  // local names, including a literal '?' on Unix, remain byte-for-byte intact.
  if (query < 4 || lower(source.substr(query - 4, 4)) != ".iso") return result;
  result.path.resize(query);
  size_t start = query + 1;
  while (start < source.size()) {
    const auto end = source.find('&', start);
    const auto pair = source.substr(start, end == std::string::npos ? end : end - start);
    const auto equals = pair.find('=');
    const auto key = lower(pair.substr(0, equals));
    const auto value = equals == std::string::npos ? "" : pair.substr(equals + 1);
    if (key == "area") result.area = lower(value);
    else if (key == "track") {
      try { result.track = std::stoi(value); } catch (...) {}
    }
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return result;
}

inline std::string sacdTrackSource(const std::string& source, const std::string& area, int track) {
  const auto path = parseSacdSource(source).path;
  return path + (path.find("://") == std::string::npos ? "?area=" + area + "&track=" : "#twilight-sacd=" + area + ":") +
      std::to_string(track);
}

}  // namespace twilight::audio
