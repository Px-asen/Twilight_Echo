#pragma once

#include "../../devices/DeviceCatalog.h"
#include "../IOutputBackend.h"

#include <memory>
#include <string>
#include <vector>

namespace twilight::audio {

class OboeOutputBackend final : public IOutputBackend {
 public:
  OboeOutputBackend();
  ~OboeOutputBackend() override;

  const char* id() const override;
  const char* getBackendName() const;

  std::vector<PcmDeviceCatalogEntry> enumerateDevices() const;

  bool open(const std::string& deviceId, const AudioFormat& requestedFormat, std::string* error) override;
  bool setOutputConfig(const OutputConfig& config, std::string* error) override;
  void setUsbPcmPolicy(std::shared_ptr<UsbPcmPolicy> policy) override;
  bool startTyped(TypedRenderCallback callback, RenderCallback fallback, OutputEventCallback event, std::string* error) override;
  void setExclusiveMode(bool exclusive);
  bool isExclusiveModeRequested() const;
  bool start(RenderCallback callback, OutputEventCallback eventCallback, std::string* error) override;
  void stop() override;
  void close() override;

  bool isOpen() const;
  bool isRunning() const;
  int getSampleRate() const;
  int getChannels() const;
  int getLatencyFrames() const;

  AudioFormat outputFormat() const override;
  OutputInfo outputInfo() const override;
  DopRuntimeFacts dopRuntimeFacts() const override;
  NativeDsdRuntimeFacts nativeDsdRuntimeFacts() const override;
  std::string deviceName() const override;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

bool oboeBackendAvailable();

}  // namespace twilight::audio
