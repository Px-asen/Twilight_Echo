#pragma once

#include "../AsioArchitecture.h"

#include <optional>
#include <string>
#include <vector>

namespace twilight::audio::asio_windows {

struct AsioDriverEntry {
  std::string id;
  std::string displayName;
  std::string clsid;
  AsioArchitecture architecture = nativeAsioArchitecture();
};

struct AsioDriverCatalogDiagnostics {
  int registeredDriverCount32 = 0;
  int registeredDriverCount64 = 0;
  int loadableDriverCount64 = 0;
  int loadableDriverCount32 = 0;
};

class AsioDriverCatalog final {
 public:
  static std::vector<AsioDriverEntry> enumerate(AsioArchitecture architecture = nativeAsioArchitecture());
  static std::vector<AsioDriverEntry> enumerateAll();
  static std::optional<AsioDriverEntry> resolve(const std::string& id);
  static std::optional<AsioDriverEntry> resolveEntries(
      const std::vector<AsioDriverEntry>& entries, const std::string& id);
  static AsioDriverCatalogDiagnostics diagnostics();
};

}  // namespace twilight::audio::asio_windows
