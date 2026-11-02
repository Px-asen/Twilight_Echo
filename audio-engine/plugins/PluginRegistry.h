#pragma once

#include "../dsp/IAudioProcessor.h"
#include "../include/twilight_audio_dsp_plugin.h"

#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace twilight::audio {

struct NativeDspPluginConfig {
  std::string id;
  std::string path;
  uint32_t abiVersion = 1;
  uint32_t supportedChannelLayouts = 0;
  uint32_t minimumSampleRate = 0;
  uint32_t maximumSampleRate = 0;
  uint32_t latencyFrames = 0;
  uint32_t tailFrames = 0;
  std::string graphPosition = "fixed-post-graph";
  bool enabled = true;
  std::unordered_map<std::string, double> parameters;
};

struct NativeDspPluginParameterStatus {
  std::string id;
  std::string name;
  std::string type;
  double defaultValue = 0.0;
  double minValue = 0.0;
  double maxValue = 0.0;
  double step = 0.0;
  std::string unit;
  std::string enumValuesJson;
  double currentValue = 0.0;
};

struct NativeDspPluginStatus {
  std::string id;
  std::string name;
  std::string version;
  std::string path;
  uint32_t abiVersion = TAE_DSP_PLUGIN_ABI_VERSION;
  uint32_t supportedChannelLayouts = 0;
  uint32_t minimumSampleRate = 0;
  uint32_t maximumSampleRate = 0;
  uint32_t latencyFrames = 0;
  uint32_t tailFrames = 0;
  std::string graphPosition = "fixed-post-graph";
  bool enabled = false;
  bool loaded = false;
  bool active = false;
  bool bypassed = false;
  std::string bypassReason;
  std::string lastError;
  uint64_t processCalls = 0;
  uint64_t overrunCount = 0;
  double lastProcessMs = 0.0;
  double maxProcessMs = 0.0;
  std::vector<NativeDspPluginParameterStatus> parameters;
};

class PluginRegistry final : public IAudioProcessor {
 public:
  PluginRegistry();
  ~PluginRegistry() override;

  PluginRegistry(const PluginRegistry&) = delete;
  PluginRegistry& operator=(const PluginRegistry&) = delete;

  void setPluginChain(std::vector<NativeDspPluginConfig> chain);
  std::vector<NativeDspPluginStatus> statuses() const;
  std::string statusJson() const;

  void configure(const DspConfig& config) override;
  void prepare(const AudioFormat& format) override;
  void setTrackContext(const DspTrackContext& context) override;
  void process(float* samples, size_t frameCount) override;
  void processDouble(double* samples, size_t frameCount) override {
    processFloatBridge(samples, frameCount, format_.channelCount);
  }
  void reset() override;
  bool isActive() const override;

  static std::vector<NativeDspPluginConfig> parseChainJson(const std::string& json);
  static std::string capabilitiesJson();

 private:
  class NativePlugin;
  std::vector<std::unique_ptr<NativePlugin>> plugins_;
  DspConfig config_;
  AudioFormat format_;
};

std::string pluginCapabilitiesJson();

}  // namespace twilight::audio
