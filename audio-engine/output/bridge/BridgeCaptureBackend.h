#pragma once

#include "../IOutputBackend.h"
#include "BridgeFormat.h"
#include <cstdio>

namespace twilight::audio {

// No timer and no sound device: the remote DAC grants frames to the network
// worker, which pulls the ordinary post-DSP pipeline through this backend.
class BridgeCaptureBackend final : public IOutputBackend {
 public:
  explicit BridgeCaptureBackend(bool extended = false) : extended_(extended) {}
  const char* id() const override { return extended_ ? "bridge-stream" : "bridge-pcm"; }
  bool open(const std::string& device, const AudioFormat& requested, std::string* error) override {
    int rate = 0, channels = 0;
    char tail = 0;
    if (extended_) {
      int code = 0; unsigned long long mask = 0;
      if (std::sscanf(device.c_str(), "%d/%d/%d/%llu%c", &rate, &channels, &code, &mask, &tail) != 4 ||
          !validBridgeFormat(rate, channels, static_cast<BridgeWireFormat>(code), mask)) {
        if (error) *error = "Invalid negotiated Bridge format"; return false;
      }
      wire_ = static_cast<BridgeWireFormat>(code);
      format_ = bridgeAudioFormat(rate, channels, wire_, mask);
      // A DSD-only invitation must not turn PCM/DSP fallback into raw DSD noise.
      if (wire_ != BridgeWireFormat::Float32 && (requested.sampleRate != rate || requested.channelCount != channels ||
          (wire_ == BridgeWireFormat::Dop24 ? (!requested.dopEncoded || !isDopCarrierFormat(requested)) : !isDsdSampleFormat(requested.sampleFormat)))) {
        if (error) *error = "Bridge DSD/DoP requires a matching DSD source, unity volume and no PCM processing";
        return false;
      }
      return true;
    }
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
  bool startTyped(TypedRenderCallback typed, RenderCallback pcm, OutputEventCallback, std::string*) override {
    typed_ = std::move(typed); callback_ = std::move(pcm); return true;
  }
  void stop() override { callback_ = {}; typed_ = {}; }
  void close() override { stop(); }
  size_t pull(float* data, size_t frames) { return callback_ ? callback_(data, frames) : 0; }
  size_t pullAudio(uint8_t* data, size_t frames) {
    if (wire_ == BridgeWireFormat::Float32) return pull(reinterpret_cast<float*>(data), frames);
    PcmBlock block{format_, data, frames, frames * audioFormatBytesPerFrame(format_)};
    return typed_ ? typed_(block) : 0;
  }
  BridgeWireFormat wireFormat() const { return wire_; }
  AudioFormat outputFormat() const override { return format_; }
  OutputInfo outputInfo() const override {
    OutputInfo info;
    info.backend = info.actualBackend = id();
    info.deviceName = info.actualDeviceName = "Twilight Bridge · network audio";
    info.accessMode = "network";
    info.outputSampleRate = info.actualSampleRate = format_.sampleRate;
    info.outputChannels = info.actualChannels = format_.channelCount;
    info.outputBitDepth = info.actualBitDepth = format_.bitDepth;
    info.outputSampleFormat = info.actualOutputFormat = sampleFormatToString(format_.sampleFormat);
    info.bufferSizeFrames = 2048;
    info.perfectReason = "Network transport only; DAC facts are reported by Bridge";
    return info;
  }
  DopRuntimeFacts dopRuntimeFacts() const override {
    DopRuntimeFacts f;
    if (wire_ == BridgeWireFormat::Dop24) { f.state = DopRuntimeFactState::Proven; f.explicitlyCapable = true;
      f.candidateFormat = f.actualFormat = format_; f.reason = "Negotiated network carrier; DAC facts belong to receiver"; }
    return f;
  }
  NativeDsdRuntimeFacts nativeDsdRuntimeFacts() const override {
    NativeDsdRuntimeFacts f;
    if (static_cast<int>(wire_) >= 3) { f.state = NativeDsdRuntimeFactState::Proven; f.explicitlyCapable = true;
      f.requestedDsdRate = f.actualDsdRate = format_.sampleRate; f.channelCount = format_.channelCount;
      f.reason = "Negotiated network DSD; DAC facts belong to receiver"; }
    return f;
  }
  std::string deviceName() const override { return "Twilight Bridge"; }
 private:
  AudioFormat format_;
  RenderCallback callback_;
  TypedRenderCallback typed_;
  bool extended_ = false;
  BridgeWireFormat wire_ = BridgeWireFormat::Float32;
};
} // namespace twilight::audio
