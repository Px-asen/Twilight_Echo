#pragma once

#include <cstdint>
#include <string>

namespace twilight::audio {

enum class AsioArchitecture : uint32_t { X86 = 32, X64 = 64 };

constexpr AsioArchitecture nativeAsioArchitecture() noexcept {
  return sizeof(void*) == 8 ? AsioArchitecture::X64 : AsioArchitecture::X86;
}

constexpr const char* asioArchitectureName(AsioArchitecture architecture) noexcept {
  return architecture == AsioArchitecture::X86 ? "x86" : "x64";
}

inline std::string asioDeviceId(const std::string& clsid, AsioArchitecture architecture) {
  return (architecture == AsioArchitecture::X86 ? "asio:x86:" : "asio:") + clsid;
}

}  // namespace twilight::audio
