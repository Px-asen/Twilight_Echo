#include "IAsioHost.h"
#include "DeviceCapabilityCache.h"

#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
#include "windows/AsioDriverCatalog.h"
#endif

#include <cstdlib>
#include <memory>
#include <sstream>
#include <string_view>

namespace twilight::audio {
namespace {

#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
bool asioEnabled() {
  const char* value = std::getenv("TWILIGHT_DISABLE_ASIO");
  return !value || std::string_view(value) != "1";
}

std::vector<AsioDeviceInfo> enumerateCatalogAsioDevices() {
  if (!asioEnabled()) return {};
  std::vector<AsioDeviceInfo> devices;
  for (const auto& entry : asio_windows::AsioDriverCatalog::enumerateAll()) {
    AsioDeviceInfo device;
    device.id = entry.id;
    device.name = entry.displayName;
    device.driverName = entry.displayName;
    device.driverArchitecture = asioArchitectureName(entry.architecture);
    if (const auto cached = DeviceCapabilityCache::instance().get(device.id)) {
      AsioDeviceInfo merged = *cached;
      merged.id = device.id;
      merged.name = device.name;
      merged.driverArchitecture = device.driverArchitecture;
      if (merged.driverName.empty()) merged.driverName = device.driverName;
      device = std::move(merged);
    }
    devices.push_back(std::move(device));
  }
  return devices;
}
#endif

std::string jsonEscape(const std::string& value) {
  std::string escaped;
  escaped.reserve(value.size());
  for (unsigned char character : value) {
    switch (character) {
      case '\\':
        escaped += "\\\\";
        break;
      case '"':
        escaped += "\\\"";
        break;
      case '\n':
        escaped += "\\n";
        break;
      case '\r':
        escaped += "\\r";
        break;
      case '\t':
        escaped += "\\t";
        break;
      default:
        if (character >= 0x20) escaped += static_cast<char>(character);
        break;
    }
  }
  return escaped;
}

}  // namespace

#if !defined(_WIN32) || !defined(_WIN64) || !defined(TAE_ENABLE_ASIO)
/**
 * The real isolated host spawns the Windows helper process, but the portable
 * backend TU still references the factory. Non-ASIO builds link this fail-closed
 * stub instead, so device enumeration degrades to an empty list and every open
 * attempt reports ASIO as unavailable rather than failing to link.
 */
class UnsupportedAsioHost final : public IAsioHost {
 public:
  std::vector<AsioDeviceInfo> enumerateDevices() override { return {}; }
  AsioHostDiagnostics diagnostics() const override { return {}; }
  bool probeDevice(const std::string&, AsioDeviceInfo*, std::string*) override { return false; }
  bool open(const AsioOpenConfig&, AsioOpenResult*, std::string* error) override {
    if (error) *error = "ASIO is only supported on Windows x64";
    return false;
  }
  bool createBuffers(AsioBufferSwitchCallback, AsioEventCallback, std::string*) override {
    return false;
  }
  bool start(std::string*) override { return false; }
  void stop() override {}
  void close() override {}
  void* outputBuffer(long, long) override { return nullptr; }
  AudioSampleFormat outputSampleFormat(long) const override {
    return AudioSampleFormat::Float32Interleaved;
  }
  AsioChannelFormat outputChannelFormat(long) const override { return {}; }
  bool outputReady() override { return false; }
  long activeBufferSize() const override { return 0; }
};

std::unique_ptr<IAsioHost> createIsolatedAsioHost() {
  return std::make_unique<UnsupportedAsioHost>();
}
#endif

std::string enumerateAsioDevicesJson() {
  std::ostringstream json;
  json << '[';
  bool first = true;
#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
  const auto devices = enumerateCatalogAsioDevices();
#else
  const auto devices = createIsolatedAsioHost()->enumerateDevices();
#endif
  for (const auto& device : devices) {
    if (!first) json << ',';
    first = false;
    json << "{\"id\":\"" << jsonEscape(device.id) << "\",\"label\":\""
         << jsonEscape(device.name + (device.driverArchitecture.empty() ? "" : " (ASIO " + device.driverArchitecture + ")")) << "\",\"name\":\"" << jsonEscape(device.name)
         << "\",\"driverArchitecture\":\"" << jsonEscape(device.driverArchitecture)
         << "\",\"backend\":\"asio\",\"isDefault\":"
         << (device.isDefault ? "true" : "false") << ",\"capabilityProbed\":"
         << (device.capabilityProbed ? "true" : "false");
    if (device.capabilityProbed) {
      json << ",\"supportsNativeDsd\":" << (device.nativeDsdCapable ? "true" : "false")
           << ",\"supportsDop\":" << (device.dopCapable ? "true" : "false");
      if (!device.nativeDsdSampleRates.empty()) {
        json << ",\"nativeDsdSampleRates\":[";
        for (size_t index = 0; index < device.nativeDsdSampleRates.size(); ++index) {
          if (index > 0) json << ',';
          json << device.nativeDsdSampleRates[index];
        }
        json << ']';
      }
      if (!device.dopCarrierSampleRates.empty()) {
        json << ",\"dopCarrierSampleRates\":[";
        for (size_t index = 0; index < device.dopCarrierSampleRates.size(); ++index) {
          if (index > 0) json << ',';
          json << device.dopCarrierSampleRates[index];
        }
        json << ']';
      }
    }
    json << '}';
  }
  json << ']';
  return json.str();
}

}  // namespace twilight::audio
