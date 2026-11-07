#pragma once

#include "ConvolverProcessor.h"
#include "CrossfeedProcessor.h"
#include "DspTypes.h"
#include "DspWorkspaceProcessors.h"
#include "ParametricEqProcessor.h"
#include "ReplayGainProcessor.h"
#include "Vst3BridgeProcessor.h"
#include "../plugins/PluginRegistry.h"

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace twilight::audio {

class DspChain {
 public:
  DspChain();

  void configure(const DspConfig& config);
  void configureFromJson(const std::string& json);
  bool configureGraphJson(const std::string& json, std::string* error);
  void prepare(const AudioFormat& format);
  void setTrackContext(const DspTrackContext& context);
  void process(float* samples, size_t frameCount);
  void processDouble(double* samples, size_t frameCount);
  /** Render-thread-only, allocation-free track handoff. Keep filter/plugin
   * histories; adopt the next track's prepared ReplayGain and processing order. */
  bool canContinueTrackFrom(const DspChain& prepared) const;
  bool continueTrackFrom(const DspChain& prepared);
  void reset();
  DspStatus status();
  DspConfig config() const;
  bool auditionTransition() const { return auditionTransition_; }
  bool crossfadeEqualPower() const { return config_.crossfadeEqualPower; }
  int crossfadeContent() const { return config_.crossfadeContent; }
  bool loadImpulseResponse(const std::string& path, std::string* error);
  void unloadImpulseResponse();
  ConvolverInfo convolverInfo() const;

  // Shares the convolver's realtime telemetry between this chain and the render clone
  // AudioPipeline builds for the same configuration. Without it, a bypass raised on the
  // audio thread never reaches convolverInfo() -- the two chains hold distinct processors.
  void setConvolverRealtimeState(std::shared_ptr<ConvolverRealtimeState> state);
  std::shared_ptr<ConvolverRealtimeState> convolverRealtimeState() const;

  void setEqBands(const std::vector<DspEqBand>& bands, EqMode mode, double preampDb, bool enabled);
  bool setEqBandsFromJson(const std::string& json, std::string* error);
  bool setEqPresetFromJson(const std::string& json, std::string* error);
  void setCrossfeedStrength(double strength);
  void setReplayGainMode(ReplayGainMode mode, double preampDb, double fallbackDb, bool clip);
  void setNativeDspPluginChain(const std::string& json);
  std::string nativeDspPluginStatusJson() const;
  std::string graphStatusJson() const;
  /** Prepared finite-history drain budget; no locks or JSON on the callback. */
  uint64_t tailFramesForRender() const noexcept { return renderTailFrames_.load(std::memory_order_relaxed); }

  static DspConfig parseConfigJson(const std::string& json);
  static std::vector<DspEqBand> parseEqBandsJson(const std::string& json, EqMode mode);

 private:
  struct GraphNodeRuntime {
    std::string id;
    std::string type;
    bool enabled = false;
    IAudioProcessor* processor = nullptr;
    Vst3BridgeProcessor* vst3Bridge = nullptr;
    std::string bypassReason;
  };

  void refreshStatusLocked();
  void clampOutput(float* samples, size_t frameCount);
  struct GraphTiming { uint64_t latency = 0, tail = 0, drain = 0; };
  GraphTiming graphTimingLocked(const ConvolverInfo& convolver, uint32_t limiterLatency) const;

  mutable std::mutex mutex_;
  DspConfig config_;
  AudioFormat format_;
  DspTrackContext trackContext_;
  DspStatus status_;
  std::atomic<bool> processingRequired_{false};
  std::atomic<uint64_t> renderTailFrames_{0};
  ReplayGainProcessor* replayGain_ = nullptr;
  ParametricEqProcessor* eq_ = nullptr;
  ConvolverProcessor* convolver_ = nullptr;
  CrossfeedProcessor* crossfeed_ = nullptr;
  ChannelMatrixProcessor* channelMatrix_ = nullptr;
  ChannelStripProcessor* channelStrip_ = nullptr;
  BassManagementProcessor* bassManagement_ = nullptr;
  DynamicsProcessor* gate_ = nullptr;
  DynamicsProcessor* compressor_ = nullptr;
  DynamicEqProcessor* dynamicEq_ = nullptr;
  MultibandCompressorProcessor* multibandCompressor_ = nullptr;
  StereoFieldProcessor* stereoField_ = nullptr;
  LoudnessContourProcessor* loudnessContour_ = nullptr;
  DynamicsProcessor* truePeakLimiter_ = nullptr;
  LoudnessMeterProcessor* meter_ = nullptr;
  PluginRegistry* nativePlugins_ = nullptr;
  std::vector<std::unique_ptr<IAudioProcessor>> processors_;
  std::vector<std::unique_ptr<PluginRegistry>> graphPluginNodes_;
  std::vector<std::unique_ptr<Vst3BridgeProcessor>> graphVst3Nodes_;
  std::vector<IAudioProcessor*> activeProcessors_;
  std::vector<GraphNodeRuntime> graphNodes_;
  bool graphConfigured_ = false;
  bool auditionTransition_ = false;
  uint64_t graphRevision_ = 0;
  std::string graphSceneId_;
};

}  // namespace twilight::audio
