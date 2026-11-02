#pragma once

#include "../IOutputBackend.h"

namespace twilight::audio {

class LibusbOutputBackend final : public IOutputBackend {
 public:
  LibusbOutputBackend();
  ~LibusbOutputBackend() override;
  const char* id() const override { return "usb-direct"; }
  void setUsbDirectHost(std::shared_ptr<UsbDirectHost> host) override;
  bool open(const std::string& device, const AudioFormat& format, std::string* error) override;
  bool setOutputConfig(const OutputConfig& config, std::string* error) override;
  bool start(RenderCallback callback, OutputEventCallback event, std::string* error) override;
  bool startTyped(TypedRenderCallback typed, RenderCallback floats, OutputEventCallback event, std::string* error) override;
  void stop() override;
  void close() override;
  AudioFormat outputFormat() const override;
  OutputInfo outputInfo() const override;
  DopRuntimeFacts dopRuntimeFacts() const override;
  NativeDsdRuntimeFacts nativeDsdRuntimeFacts() const override;
  std::string deviceName() const override;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace twilight::audio
