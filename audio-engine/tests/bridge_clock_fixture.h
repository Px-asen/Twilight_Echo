#pragma once
#include "../output/bridge/BridgeReceiver.h"
#include <cassert>
#include <cmath>
#include <iostream>
using namespace twilight::audio;

class Dac final : public IOutputBackend {
 public:
  bool capable = true;
  uint64_t released = 480;
  int bufferFrames = 480;
  RenderCallback ordinary;
  ClockedRenderCallback clocked;
  ClockedCommitCallback committed;
  OutputEventCallback event;
  OutputClockSnapshot clock{true, true, true, 3, 0, 0, 48000};
  const char* id() const override { return "controlled-clocked-dac"; }
  bool open(const std::string&, const AudioFormat&, std::string*) override { clock.sampledAtMs = outputMonotonicMs(); return true; }
  bool setOutputConfig(const OutputConfig&, std::string*) override { return true; }
  bool start(RenderCallback callback, OutputEventCallback e, std::string*) override { ordinary = callback; event = e; return true; }
  bool supportsClockedRendering() const override { return capable; }
  bool startClocked(ClockedRenderCallback callback, ClockedCommitCallback commit, OutputEventCallback e, std::string*) override {
    clocked = callback; committed = commit; event = e; return capable; // 480 pure-silence prefill frames, no callback.
  }
  std::vector<float> tick(size_t frames, double firstAtMs, bool valid = true, bool releasedSuccessfully = true) {
    std::vector<float> out(frames * 2, -99);
    clocked(out.data(), frames, {valid, clock.epoch, released, firstAtMs, 48000});
    committed(released, frames, clock.epoch, releasedSuccessfully);
    if (releasedSuccessfully) released += frames;
    return out;
  }
  void stop() override { ordinary = {}; clocked = {}; committed = {}; }
  void close() override { stop(); }
  AudioFormat outputFormat() const override { return {48000, 2, 32, AudioSampleFormat::Float32Interleaved}; }
  OutputInfo outputInfo() const override { OutputInfo info; info.bufferSizeFrames = bufferFrames; return info; }
  OutputClockSnapshot outputClock() const override { auto c = clock; c.sampledAtMs = outputMonotonicMs(); return c; }
  DopRuntimeFacts dopRuntimeFacts() const override { return {}; }
  NativeDsdRuntimeFacts nativeDsdRuntimeFacts() const override { return {}; }
  std::string deviceName() const override { return "silent fixture"; }
};
double number(const std::string& json, const char* field) {
  const auto start = json.find(std::string("\"") + field + "\":"); assert(start != std::string::npos);
  return std::stod(json.substr(json.find(':', start) + 1));
}
void silence(const std::vector<float>& data) { for (const float value : data) assert(value == 0); }
struct Fixture {
  BridgeReceiver receiver;
  Dac* dac = nullptr;
  std::string error;
  Fixture(bool capable = true, int bufferFrames = 480) {
    auto output = std::make_unique<Dac>(); dac = output.get(); dac->capable = capable;
    dac->bufferFrames = bufferFrames;
    assert(receiver.open(std::move(output), "explicit-test-dac", 48000, 2, &error));
  }
  uint64_t generation() { return static_cast<uint64_t>(number(receiver.status(), "streamGeneration")); }
  void media(size_t count = 2048) {
    std::vector<float> samples(count * 2);
    for (size_t n = 0; n < count; n++) samples[n * 2] = samples[n * 2 + 1] = static_cast<float>(n + 1) / 4096;
    assert(receiver.write(samples.data(), count, &error));
  }
};
