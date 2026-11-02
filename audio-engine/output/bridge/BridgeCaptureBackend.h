#pragma once

#include "../IOutputBackend.h"
#include <cstdio>

namespace twilight::audio {

// No timer and no sound device: the remote DAC grants frames to the network
// worker, which pulls the ordinary post-DSP pipeline through this backend.
class BridgeCaptureBackend final : public IOutputBackend {
 public:
  const char* id() const override { return "bridge-pcm"; }
  bool open(const std::string& device, const AudioFormat&, std::string* error) override {
    int rate = 0, channels = 0;
    char tail = 0;
    if (std::sscanf(device.c_str(), "%d/%d%c", &rate, &channels, &tail) != 2 ||
        rate < 44100 || rate > 192000 || channels != 2) {
      if (error) *error = "Bridge requires a negotiated stereo PCM format (44.1–192 kHz)";
      return false;
    }
    format_ = {rate, channels, 32, AudioSampleFormat::Float32Interleaved, false, 3};
    return true;
  }
  bool setOutputConfig(const OutputConfig&, std::string*) override { return true; }
  bool start(RenderCallback callback, OutputEventCallback, std::string*) override {
    callback_ = std::move(callback);
    return true;
  }
  void stop() override { callback_ = {}; }
  void close() override { stop(); }
  size_t pull(float* data, size_t frames) { return callback_ ? callback_(data, frames) : 0; }
  AudioFormat outputFormat() const override { return format_; }
  OutputInfo outputInfo() const override {
    OutputInfo info;
    info.backend = info.actualBackend = "bridge-pcm";
    info.deviceName = info.actualDeviceName = "Twilight Bridge · network PCM";
    info.accessMode = "network";
    info.outputSampleRate = info.actualSampleRate = format_.sampleRate;
    info.outputChannels = info.actualChannels = format_.channelCount;
    info.outputBitDepth = info.actualBitDepth = 32;
    info.outputSampleFormat = info.actualOutputFormat = "float32";
    info.bufferSizeFrames = 2048;
    info.perfectReason = "Network Float32 transport; DAC facts are reported by Bridge";
    return info;
  }
  DopRuntimeFacts dopRuntimeFacts() const override { return {}; }
  NativeDsdRuntimeFacts nativeDsdRuntimeFacts() const override { return {}; }
  std::string deviceName() const override { return "Twilight Bridge"; }
 private:
  AudioFormat format_;
  RenderCallback callback_;
};
} // namespace twilight::audio
