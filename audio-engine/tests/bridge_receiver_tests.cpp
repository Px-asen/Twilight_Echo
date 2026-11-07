#include "../output/bridge/BridgeReceiver.h"
#include <cassert>
#include <limits>
#include <iostream>
#include <thread>
using namespace twilight::audio;

class FakeDac final : public IOutputBackend {
 public:
  RenderCallback render;
  OutputEventCallback event;
  bool stopped = false;
  int bufferFrames = 0;
  OutputClockSnapshot clock;
  const char* id() const override { return "test-dac"; }
  bool open(const std::string&, const AudioFormat&, std::string*) override { return true; }
  bool setOutputConfig(const OutputConfig&, std::string*) override { return true; }
  bool start(RenderCallback r, OutputEventCallback e, std::string*) override { render = r; event = e; return true; }
  void stop() override { stopped = true; render = {}; }
  void close() override { stop(); }
  AudioFormat outputFormat() const override { return {48000, 2, 32, AudioSampleFormat::Float32Interleaved}; }
  OutputInfo outputInfo() const override { OutputInfo info; info.actualSampleRate = 48000; info.bufferSizeFrames = bufferFrames; return info; }
  OutputClockSnapshot outputClock() const override { return clock; }
  DopRuntimeFacts dopRuntimeFacts() const override { return {}; }
  NativeDsdRuntimeFacts nativeDsdRuntimeFacts() const override { return {}; }
  std::string deviceName() const override { return "test"; }
};
int main() {
  OutputClockCache cache;
  std::atomic<bool> complete{false};
  std::thread writer([&] {
    for (uint64_t n = 1; n <= 100000; ++n) cache.publish({true, true, true, n, double(n * 2), double(n * 3), 48000});
    complete = true;
  });
  while (!complete.load()) {
    const auto value = cache.read();
    if (value.valid) {
      assert(value.positionFrames == value.epoch * 2);
      assert(value.sampledAtMs == value.epoch * 3);
      assert(value.sampleRate == 48000);
    }
  }
  writer.join();
  const auto mono = outputMonotonicMs();
  assert(mono > 0 && outputMonotonicMs() >= mono);
  BridgeReceiver receiver;
  std::string error;
  assert(!receiver.open(std::make_unique<FakeDac>(), "auto", 48000, 2, &error));
  for (const auto* alias : {"default", "System Default", "system default", "system-default", "系统默认"})
    assert(!receiver.open(std::make_unique<FakeDac>(), alias, 48000, 2, &error));
  auto backend = std::make_unique<FakeDac>(); auto* dac = backend.get();
  assert(receiver.open(std::move(backend), "explicit-usb-dac", 44100, 2, &error));
  assert(receiver.status().find("\"sampleRate\":48000") != std::string::npos); // actual negotiation
  std::vector<float> input(4096, .125f), output(4096, -1);
  assert(receiver.write(input.data(), 64, &error));
  assert(!dac->render); // short clips wait for an explicit drain, not a timer
  assert(receiver.start(&error));
  dac->render(output.data(), 128);
  for (size_t n = 0; n < 128; ++n) assert(output[n] == .125f); // DSP bypass, sample exact
  for (size_t n = 128; n < 256; ++n) assert(output[n] == 0); // bounded underflow silence
  assert(receiver.status().find("\"consumedFrames\":64") != std::string::npos);
  dac->clock = {true, true, true, 7, 32, mono, 48000};
  const auto clockStatus = receiver.status();
  assert(clockStatus.find("\"callbackRequestedFrames\":128") != std::string::npos);
  assert(clockStatus.find("\"positionFrames\":32") != std::string::npos);
  assert(clockStatus.find("\"source\":\"wasapi-audio-clock\"") != std::string::npos);
  assert(clockStatus.find("\"epoch\":7") != std::string::npos);
  dac->clock.sampledAtMs = outputMonotonicMs() + 1000000;
  assert(receiver.status().find("\"valid\":false") != std::string::npos);
  assert(receiver.write(input.data(), 64, &error)); // A bad timestamp never disables legacy PCM.
  for (int n = 0; n < 5; ++n) assert(receiver.write(input.data(), 2048, &error));
  assert(!receiver.write(input.data(), 2048, &error)); // no overwrite/drop-oldest
  dac->event(OutputBackendEvent::DeviceInvalidated, "unplugged");
  dac->render(output.data(), 2048);
  for (float value : output) assert(value == 0); // never escape to another device
  assert(!receiver.write(input.data(), 64, &error));
  assert(receiver.status().find("\"failed\":true") != std::string::npos);
  receiver.close();
  backend = std::make_unique<FakeDac>(); dac = backend.get();
  assert(receiver.open(std::move(backend), "explicit-usb-dac", 48000, 2, &error));
  assert(receiver.status().find("\"bufferedFrames\":0") != std::string::npos);
  assert(receiver.status().find("\"supported\":false") != std::string::npos);
  assert(receiver.status().find("\"callbackRequestedFrames\":0") != std::string::npos);
  input[0] = std::numeric_limits<float>::quiet_NaN();
  assert(!receiver.write(input.data(), 64, &error));
  assert(receiver.status().find("\"bufferedFrames\":0") != std::string::npos);
  receiver.close();
  backend = std::make_unique<FakeDac>(); dac = backend.get(); dac->bufferFrames = 8192;
  assert(receiver.open(std::move(backend), "explicit-usb-dac", 48000, 2, &error));
  assert(receiver.status().find("\"prebufferFrames\":8192") != std::string::npos);
  input[0] = .125f;
  for (int n = 0; n < 3; ++n) assert(receiver.write(input.data(), 2048, &error));
  assert(!dac->render);
  assert(receiver.write(input.data(), 2048, &error));
  assert(dac->render); // large driver callbacks cannot start with only 40 ms
  receiver.close();
  backend = std::make_unique<FakeDac>(); backend->bufferFrames = 16384;
  assert(!receiver.open(std::move(backend), "explicit-usb-dac", 48000, 2, &error));
  std::cout << "Bridge receiver: negotiation, exact PCM, short-tail drain, bounds, underrun, unplug and reset passed\n";
}
