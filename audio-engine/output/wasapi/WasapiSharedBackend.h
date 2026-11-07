#pragma once

#include "../IOutputBackend.h"

#include <atomic>
#include <memory>
#include <string>
#include <thread>

namespace twilight::audio {

class WasapiSharedBackend final : public IOutputBackend {
 public:
  WasapiSharedBackend();
  ~WasapiSharedBackend() override;

  const char* id() const override;
  bool open(const std::string& deviceId, const AudioFormat& requestedFormat, std::string* error) override;
  bool setOutputConfig(const OutputConfig& config, std::string* error) override;
  bool start(RenderCallback callback, OutputEventCallback eventCallback, std::string* error) override;
  bool supportsClockedRendering() const override;
  bool startClocked(ClockedRenderCallback callback, ClockedCommitCallback commit, OutputEventCallback eventCallback, std::string* error) override;
  void stop() override;
  void close() override;

  AudioFormat outputFormat() const override;
  OutputInfo outputInfo() const override;
  OutputClockSnapshot outputClock() const override;
  DopRuntimeFacts dopRuntimeFacts() const override;
  NativeDsdRuntimeFacts nativeDsdRuntimeFacts() const override;
  std::string deviceName() const override;

 private:
  bool startInternal(RenderCallback, ClockedRenderCallback, ClockedCommitCallback, OutputEventCallback, std::string*);
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace twilight::audio
