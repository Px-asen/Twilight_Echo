#include "../output/bridge/BridgeReceiver.h"
#include "../output/bridge/BridgeCaptureBackend.h"
#include <cassert>
#include <cstring>
#include <iostream>
using namespace twilight::audio;

class FormatDac final : public IOutputBackend {
 public:
  AudioFormat format;
  TypedRenderCallback typed;
  RenderCallback pcm;
  OutputEventCallback event;
  bool mismatch = false;
  bool open(const std::string&, const AudioFormat& requested, std::string*) override {
    format = requested;
    if (requested.dopEncoded) format.sampleFormat = AudioSampleFormat::Int24In32Interleaved;
    if (mismatch) format.channelCount = 2;
    return true;
  }
  const char* id() const override { return "format-fixture"; }
  bool setOutputConfig(const OutputConfig&, std::string*) override { return true; }
  bool start(RenderCallback cb, OutputEventCallback ev, std::string*) override { pcm = cb; event = ev; return true; }
  bool startTyped(TypedRenderCallback cb, RenderCallback, OutputEventCallback ev, std::string*) override { typed = cb; event = ev; return true; }
  void stop() override { pcm = {}; typed = {}; }
  void close() override { stop(); }
  AudioFormat outputFormat() const override { return format; }
  OutputInfo outputInfo() const override { OutputInfo i; i.backend = "format-fixture"; i.actualSampleRate = format.sampleRate;
    i.actualChannels = format.channelCount; i.actualBitDepth = format.bitDepth; i.actualOutputFormat = sampleFormatToString(format.sampleFormat); return i; }
  DopRuntimeFacts dopRuntimeFacts() const override { DopRuntimeFacts f; f.state = DopRuntimeFactState::Proven; f.explicitlyCapable = true; f.actualFormat = f.candidateFormat = format; return f; }
  NativeDsdRuntimeFacts nativeDsdRuntimeFacts() const override { NativeDsdRuntimeFacts f; f.state = NativeDsdRuntimeFactState::Proven;
    f.explicitlyCapable = true; f.actualDsdRate = f.requestedDsdRate = format.sampleRate; f.channelCount = format.channelCount; return f; }
  std::string deviceName() const override { return "controlled format DAC"; }
};

int main() {
  for (const int channels : {1, 2, 6, 8}) {
    const uint64_t mask = channels == 1 ? 4 : channels == 2 ? 3 : channels == 6 ? 0x60f : 0x63f;
    BridgeReceiver receiver; std::string error;
    auto backend = std::make_unique<FormatDac>(); auto* dac = backend.get();
    assert(receiver.open(std::move(backend), "explicit-dac", 48000, channels, &error, BridgeWireFormat::Float32, mask, true));
    assert(receiver.acceptsLegacyPcm() == (channels == 2));
    std::vector<float> input(2048*channels), output(2048*channels+2, -17);
    for (size_t n = 0; n < input.size(); ++n) input[n] = static_cast<float>(n%channels+1)/16;
    assert(receiver.writeAudio(reinterpret_cast<uint8_t*>(input.data()), input.size()*4, &error));
    assert(dac->pcm);
    dac->pcm(output.data()+1, 2048);
    assert(output.front() == -17 && output.back() == -17);
    assert(std::memcmp(input.data(), output.data()+1, input.size()*4) == 0);
    if (channels != 2) assert(!receiver.prepareTimed(&error));
  }
  for (const auto wire : {BridgeWireFormat::Dop24, BridgeWireFormat::DsdLsb, BridgeWireFormat::DsdMsb, BridgeWireFormat::DsdNer8}) {
    BridgeReceiver receiver; std::string error;
    const int rate = wire == BridgeWireFormat::Dop24 ? 176400 : 2822400;
    const int channels = 6; const size_t bpf = channels*bridgeSampleBytes(wire);
    auto backend = std::make_unique<FormatDac>(); auto* dac = backend.get();
    assert(receiver.open(std::move(backend), "explicit-dac", rate, channels, &error, wire, 0x60f, true));
    assert(!receiver.acceptsLegacyPcm());
    assert(!receiver.prepareTimed(&error));
    std::vector<uint8_t> input(2048*bpf);
    for (size_t n = 0; n < 2048; ++n) for (int c = 0; c < channels; ++c) {
      input[n*bpf+c*bridgeSampleBytes(wire)] = static_cast<uint8_t>(n+c);
      if (wire == BridgeWireFormat::Dop24) { input[n*bpf+c*3+1] = static_cast<uint8_t>(c+9); input[n*bpf+c*3+2] = n%2 ? 0xfa : 5; }
    }
    if (wire == BridgeWireFormat::Dop24) {
      auto bad = input; bad[2] = 0;
      assert(!receiver.writeAudio(bad.data(), bad.size(), &error));
    }
    // Prebuffer remains 40 ms in byte-frames, not DSD bit-clock frames.
    const int blocks = (bridgeFrameRate(rate, wire)/25+2047)/2048;
    for (int n = 0; n < blocks; ++n) assert(receiver.writeAudio(input.data(), input.size(), &error));
    assert(dac->typed);
    const size_t sampleBytes = audioSampleFormatBytes(dac->format.sampleFormat);
    std::vector<uint8_t> out(2049*channels*sampleBytes+2, 0x13);
    PcmBlock block{dac->format, out.data()+1, 2049, out.size()-2};
    dac->typed(block);
    assert(out.front() == 0x13 && out.back() == 0x13);
    for (size_t n = 0; n < 2048; ++n) for (int c = 0; c < channels; ++c) {
      const auto* value = block.data+(n*channels+c)*sampleBytes;
      if (wire == BridgeWireFormat::Dop24) { assert(value[0] == 0); assert(value[1] == static_cast<uint8_t>(n+c));
        assert(value[2] == c+9); assert(value[3] == (n%2 ? 0xfa : 5)); }
      else assert(value[0] == static_cast<uint8_t>(n+c));
    }
    dac->event(OutputBackendEvent::DeviceInvalidated, "unplugged");
    dac->typed(block);
    for (int c = 0; c < channels; ++c) {
      if (wire == BridgeWireFormat::Dop24) { assert(block.data[c*4+1] == 0x96); assert(block.data[c*4+2] == 0x96); assert(block.data[c*4+3] == 0xfa); }
      else assert(block.data[c] == (wire == BridgeWireFormat::DsdMsb ? 0x96 : 0x69));
    }
    assert(!receiver.writeAudio(input.data(), input.size(), &error));
  }
  BridgeReceiver receiver; std::string error;
  auto bad = std::make_unique<FormatDac>(); bad->mismatch = true;
  assert(!receiver.open(std::move(bad), "explicit-dac", 48000, 6, &error, BridgeWireFormat::Float32, 0x60f, true));
  assert(!receiver.open(std::make_unique<FormatDac>(), "explicit-dac", 48000, 6, &error, BridgeWireFormat::Float32, 3, true));
  BridgeCaptureBackend capture(true);
  assert(!capture.open("2822400/2/3/3", {48000, 2, 32, AudioSampleFormat::Float32Interleaved}, &error));
  // Hi-rate int24 PCM is not DoP, even when its byte geometry is identical.
  assert(!capture.open("176400/2/2/3", {176400, 2, 24, AudioSampleFormat::Int24Interleaved, false, 3}, &error));
  assert(capture.open("176400/2/2/3", {176400, 2, 24, AudioSampleFormat::Int24Interleaved, true, 3}, &error));
  assert(capture.open("2822400/2/3/3", {2822400, 2, 1, AudioSampleFormat::DsdInt8Msb1}, &error));
  std::cout << "Bridge formats: multichannel layout, exact DSD bytes, DoP markers/container, idle and format rejection passed\n";
}
