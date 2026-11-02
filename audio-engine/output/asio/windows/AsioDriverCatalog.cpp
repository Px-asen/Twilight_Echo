#include "AsioDriverCatalog.h"

#include <Windows.h>
#include <objbase.h>

#include <algorithm>

namespace twilight::audio::asio_windows {
namespace {

std::string utf8(const std::wstring& value) {
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
  std::wstring value(bytes / sizeof(wchar_t), L'\0');
  if (RegQueryValueExW(
          key, name, nullptr, &type, reinterpret_cast<LPBYTE>(value.data()), &bytes) != ERROR_SUCCESS) {
    return {};
  }
  value.resize(wcsnlen(value.c_str(), value.size()));
  return value;
}

bool hasInProcessServer(const std::wstring& clsid, REGSAM registryView) {
  HKEY key = nullptr;
  const std::wstring path = L"CLSID\\" + clsid + L"\\InprocServer32";
  const LSTATUS status = RegOpenKeyExW(
      HKEY_CLASSES_ROOT, path.c_str(), 0, KEY_READ | registryView, &key);
  if (status != ERROR_SUCCESS) return false;
  const bool hasPath = !readString(key, nullptr).empty();
  RegCloseKey(key);
  return hasPath;
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
    RegCloseKey(driverKey);

    CLSID clsid{};
    if (clsidText.empty() || FAILED(CLSIDFromString(clsidText.c_str(), &clsid)) || !hasInProcessServer(clsidText, registryView)) {
      continue;
    }
    wchar_t canonical[64] = {};
    if (StringFromGUID2(clsid, canonical, static_cast<int>(std::size(canonical))) <= 0) continue;

    AsioDriverEntry entry;
    entry.clsid = utf8(canonical);
    entry.architecture = architecture;
    entry.id = asioDeviceId(entry.clsid, architecture);
    entry.displayName = utf8(description.empty() ? std::wstring(keyName, keyNameSize) : description);
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
