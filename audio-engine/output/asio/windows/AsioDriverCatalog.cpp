#include "AsioDriverCatalog.h"

#include <Windows.h>
#include <objbase.h>

#include <algorithm>
#include <iterator>

namespace twilight::audio::asio_windows {
namespace {

std::wstring_view trimWide(std::wstring_view value) {
  constexpr std::wstring_view kWhitespace = L" \t\r\n";
  const size_t first = value.find_first_not_of(kWhitespace);
  if (first == std::wstring_view::npos) return {};
  const size_t last = value.find_last_not_of(kWhitespace);
  return value.substr(first, last - first + 1);
}

std::string utf8(std::wstring_view value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string result(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
  return result;
}

std::wstring readString(HKEY key, const wchar_t* name) {
  DWORD type = 0;
  DWORD bytes = 0;
  if (RegQueryValueExW(key, name, nullptr, &type, nullptr, &bytes) != ERROR_SUCCESS ||
      (type != REG_SZ && type != REG_EXPAND_SZ) || bytes < sizeof(wchar_t)) {
    return {};
  }
  const size_t wcharCount = (static_cast<size_t>(bytes) + sizeof(wchar_t) - 1) / sizeof(wchar_t);
  std::wstring value(wcharCount, L'\0');
  DWORD queryBytes = static_cast<DWORD>(value.size() * sizeof(wchar_t));
  if (RegQueryValueExW(
          key, name, nullptr, &type, reinterpret_cast<LPBYTE>(value.data()), &queryBytes) != ERROR_SUCCESS) {
    return {};
  }
  const size_t maxChars = std::min(value.size(), static_cast<size_t>(queryBytes) / sizeof(wchar_t));
  value.resize(wcsnlen(value.c_str(), maxChars));
  return value;
}

bool hasInProcessServerAt(HKEY rootKey, const std::wstring& path, REGSAM registryView) {
  HKEY key = nullptr;
  const LSTATUS status = RegOpenKeyExW(rootKey, path.c_str(), 0, KEY_READ | registryView, &key);
  if (status != ERROR_SUCCESS) return false;
  const bool hasPath = !trimWide(readString(key, nullptr)).empty();
  RegCloseKey(key);
  return hasPath;
}

bool hasInProcessServer(const std::wstring& canonicalClsid, REGSAM registryView) {
  return hasInProcessServerAt(
             HKEY_LOCAL_MACHINE, L"SOFTWARE\\Classes\\CLSID\\" + canonicalClsid + L"\\InprocServer32", registryView) ||
         hasInProcessServerAt(
             HKEY_CLASSES_ROOT, L"CLSID\\" + canonicalClsid + L"\\InprocServer32", registryView);
}

int countRegisteredDrivers(REGSAM registryView) {
  HKEY catalog = nullptr;
  if (RegOpenKeyExW(
          HKEY_LOCAL_MACHINE,
          L"SOFTWARE\\ASIO",
          0,
          KEY_READ | registryView,
          &catalog) != ERROR_SUCCESS) {
    return 0;
  }
  DWORD subkeyCount = 0;
  const LSTATUS status = RegQueryInfoKeyW(
      catalog,
      nullptr,
      nullptr,
      nullptr,
      &subkeyCount,
      nullptr,
      nullptr,
      nullptr,
      nullptr,
      nullptr,
      nullptr,
      nullptr);
  RegCloseKey(catalog);
  return status == ERROR_SUCCESS ? static_cast<int>(subkeyCount) : 0;
}

}  // namespace

std::optional<std::wstring> AsioDriverCatalog::normalizeClsid(std::wstring_view rawClsid) {
  const std::wstring_view trimmed = trimWide(rawClsid);
  if (trimmed.empty()) return std::nullopt;
  std::wstring candidate;
  if (trimmed.size() == 36 && trimmed.front() != L'{' && trimmed.back() != L'}') {
    candidate = L"{" + std::wstring(trimmed) + L"}";
  } else {
    candidate = std::wstring(trimmed);
  }
  // Reject malformed strings or COM ProgIDs before invoking CLSIDFromString.
  if (candidate.size() != 38 || candidate.front() != L'{' || candidate.back() != L'}') {
    return std::nullopt;
  }
  CLSID clsid{};
  if (FAILED(CLSIDFromString(candidate.c_str(), &clsid))) {
    return std::nullopt;
  }
  wchar_t canonical[64] = {};
  if (StringFromGUID2(clsid, canonical, static_cast<int>(std::size(canonical))) <= 0) {
    return std::nullopt;
  }
  return std::wstring(canonical);
}

std::string AsioDriverCatalog::selectDisplayName(
    std::wstring_view description,
    std::wstring_view defaultValue,
    std::wstring_view keyName) {
  if (const auto trimmedDescription = trimWide(description); !trimmedDescription.empty()) {
    return utf8(trimmedDescription);
  }
  if (const auto trimmedDefault = trimWide(defaultValue); !trimmedDefault.empty()) {
    return utf8(trimmedDefault);
  }
  return utf8(std::wstring(keyName));
}

std::vector<AsioDriverEntry> AsioDriverCatalog::enumerate(AsioArchitecture architecture) {
  const REGSAM registryView = architecture == AsioArchitecture::X86 ? KEY_WOW64_32KEY : KEY_WOW64_64KEY;
  std::vector<AsioDriverEntry> entries;
  HKEY catalog = nullptr;
  if (RegOpenKeyExW(
          HKEY_LOCAL_MACHINE, L"SOFTWARE\\ASIO", 0, KEY_READ | registryView, &catalog) != ERROR_SUCCESS) {
    return entries;
  }

  for (DWORD index = 0;; ++index) {
    wchar_t keyName[256] = {};
    DWORD keyNameSize = static_cast<DWORD>(std::size(keyName));
    const LSTATUS enumStatus = RegEnumKeyExW(catalog, index, keyName, &keyNameSize, nullptr, nullptr, nullptr, nullptr);
    if (enumStatus == ERROR_NO_MORE_ITEMS) break;
    if (enumStatus != ERROR_SUCCESS) continue;

    HKEY driverKey = nullptr;
    if (RegOpenKeyExW(catalog, keyName, 0, KEY_READ | registryView, &driverKey) != ERROR_SUCCESS) continue;
    const std::wstring clsidText = readString(driverKey, L"CLSID");
    const std::wstring description = readString(driverKey, L"Description");
    const std::wstring defaultDescription = readString(driverKey, nullptr);
    RegCloseKey(driverKey);

    const auto canonical = normalizeClsid(clsidText);
    if (!canonical || !hasInProcessServer(*canonical, registryView)) {
      continue;
    }

    AsioDriverEntry entry;
    entry.clsid = utf8(*canonical);
    entry.architecture = architecture;
    entry.id = asioDeviceId(entry.clsid, architecture);
    entry.displayName = selectDisplayName(
        description, defaultDescription, std::wstring_view(keyName, keyNameSize));
    entries.push_back(std::move(entry));
  }

  RegCloseKey(catalog);
  std::sort(entries.begin(), entries.end(), [](const AsioDriverEntry& left, const AsioDriverEntry& right) {
    return left.id < right.id;
  });
  entries.erase(std::unique(entries.begin(), entries.end(), [](const auto& left, const auto& right) {
    return left.id == right.id;
  }), entries.end());
  return entries;
}

std::vector<AsioDriverEntry> AsioDriverCatalog::enumerateAll() {
  auto entries = enumerate(AsioArchitecture::X64);
  auto x86 = enumerate(AsioArchitecture::X86);
  entries.insert(entries.end(), x86.begin(), x86.end());
  return entries;
}

AsioDriverCatalogDiagnostics AsioDriverCatalog::diagnostics() {
  AsioDriverCatalogDiagnostics result;
  result.registeredDriverCount32 = countRegisteredDrivers(KEY_WOW64_32KEY);
  result.registeredDriverCount64 = countRegisteredDrivers(KEY_WOW64_64KEY);
  result.loadableDriverCount64 = static_cast<int>(enumerate(AsioArchitecture::X64).size());
  result.loadableDriverCount32 = static_cast<int>(enumerate(AsioArchitecture::X86).size());
  return result;
}

std::optional<AsioDriverEntry> AsioDriverCatalog::resolve(const std::string& id) {
  return resolveEntries(enumerate(), id);
}

std::optional<AsioDriverEntry> AsioDriverCatalog::resolveEntries(
    const std::vector<AsioDriverEntry>& entries, const std::string& id) {
  if (id.empty() || id == "auto") {
    const auto x64 = std::find_if(entries.begin(), entries.end(), [](const auto& entry) {
      return entry.architecture == AsioArchitecture::X64;
    });
    return x64 != entries.end() ? std::optional(*x64) : entries.empty() ? std::nullopt : std::optional(entries.front());
  }

  const auto exact = std::find_if(entries.begin(), entries.end(), [&](const AsioDriverEntry& entry) {
    return entry.id == id;
  });
  if (exact != entries.end()) return *exact;
  if (id.starts_with("asio:x86:") || id.starts_with("asio:{")) return std::nullopt;
  const auto name = id.starts_with("asio:") ? id.substr(5) : id;
  for (const auto architecture : {AsioArchitecture::X64, AsioArchitecture::X86}) {
    std::optional<AsioDriverEntry> legacy;
    for (const auto& entry : entries) {
      if (entry.architecture != architecture || entry.displayName != name) continue;
      if (legacy) return std::nullopt;
      legacy = entry;
    }
    if (legacy) return legacy;
  }
  return std::nullopt;
}

}  // namespace twilight::audio::asio_windows
