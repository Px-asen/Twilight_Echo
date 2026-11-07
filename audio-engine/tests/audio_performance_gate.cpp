#include "../core/AudioPipeline.h"
#include "../core/TwilightAudioEngine.h"
#include "../dsp/Vst3BridgeProcessor.h"
#include "../output/IOutputBackend.h"
#include "../output/OutputBackendFactory.h"
#include "../automix-native/AutoMixAdapter.h"
#include "../automix-native/am_hash.h"
#include "../decoder/FFmpegDecoder.h"
#include "../utils/JsonUtils.h"
#include "AudioFixtureLibrary.h"
#include "ChannelLayoutFixture.h"
#include "PerformanceTestPriority.h"

#include <algorithm>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#ifdef _WIN32
#ifndef PSAPI_VERSION
#define PSAPI_VERSION 1
#endif
#include <windows.h>
#include <psapi.h>
#endif

using namespace twilight::audio;

namespace {

constexpr int kSampleRate = 44100;
constexpr int kChannels = 2;
constexpr size_t kCallbackFrames = 512;
constexpr double kLongScenarioAudioSeconds = 180.0;
constexpr double kPipelineMeanDeadlineLoadLimitPercent = 65.0;
constexpr uint64_t kPipelineDeadlineMissLimit = 0;

struct ControlledBackendState {
  mutable std::mutex mutex;
  AudioFormat format;
  OutputInfo info;
  RenderCallback render;
  TypedRenderCallback typedRender;
  OutputEventCallback event;
  bool started = false;
  uint64_t callbackInvocations = 0;
  uint64_t callbacksWithAudio = 0;
};

std::mutex g_backendMutex;
std::shared_ptr<ControlledBackendState> g_latestBackend;
// Emulate shared-mode negotiation for the PCM transparency probe. Other gates
// preserve their requested (including typed integer) formats.
bool g_pcmSharedFormat = false;

class ControlledPumpBackend final : public IOutputBackend {
 public:
  ControlledPumpBackend() : state_(std::make_shared<ControlledBackendState>()) {
    std::lock_guard lock(g_backendMutex);
    g_latestBackend = state_;
  }

  const char* id() const override { return "controlled-pump"; }

  bool open(const std::string& deviceId, const AudioFormat& requestedFormat, std::string*) override {
    std::lock_guard lock(state_->mutex);
    state_->format = requestedFormat;
    if (g_pcmSharedFormat) {
      state_->format.sampleRate = 48000;
      state_->format.bitDepth = 32;
      state_->format.channelCount = 2;
      state_->format.channelMask = 3;
      state_->format.sampleFormat = AudioSampleFormat::Float32Interleaved;
    }
    state_->info = {};
    state_->info.backend = id();
    state_->info.actualBackend = id();
    state_->info.deviceName = deviceId.empty() ? "Controlled callback pump" : deviceId;
    state_->info.actualDeviceName = state_->info.deviceName;
    state_->info.driverName = "test-controlled";
    state_->info.actualDriverName = state_->info.driverName;
    state_->info.outputSampleRate = state_->format.sampleRate;
    state_->info.outputBitDepth = state_->format.bitDepth;
    state_->info.actualSampleRate = state_->format.sampleRate;
    state_->info.actualBitDepth = state_->format.bitDepth;
    state_->info.actualChannels = state_->format.channelCount;
    state_->info.actualOutputFormat = sampleFormatToString(state_->format.sampleFormat);
    state_->info.bufferSizeFrames = static_cast<int>(kCallbackFrames);
    state_->info.latencyFrames = static_cast<int>(kCallbackFrames);
    state_->info.latencyMs =
        static_cast<double>(kCallbackFrames) * 1000.0 / static_cast<double>(std::max(1, requestedFormat.sampleRate));
    state_->info.latencyInfo.bufferLatencyMs = state_->info.latencyMs;
    state_->info.latencyInfo.totalLatencyMs = state_->info.latencyMs;
    state_->started = false;
    return true;
  }

  bool setOutputConfig(const OutputConfig&, std::string*) override { return true; }

  bool start(RenderCallback callback, OutputEventCallback eventCallback, std::string*) override {
    std::lock_guard lock(state_->mutex);
    state_->render = std::move(callback);
    state_->typedRender = nullptr;
    state_->event = std::move(eventCallback);
    state_->started = true;
    return true;
  }

  bool startTyped(
      TypedRenderCallback typedCallback,
      RenderCallback fallbackCallback,
      OutputEventCallback eventCallback,
      std::string*) override {
    std::lock_guard lock(state_->mutex);
    // The gate intentionally invokes the real float render path. It does not
    // emulate a hardware typed callback or make a device claim.
    state_->typedRender = std::move(typedCallback);
    state_->render = std::move(fallbackCallback);
    state_->event = std::move(eventCallback);
    state_->started = true;
    return true;
  }

  void stop() override {
    std::lock_guard lock(state_->mutex);
    state_->started = false;
  }

  void close() override { stop(); }

  AudioFormat outputFormat() const override {
    std::lock_guard lock(state_->mutex);
    return state_->format;
  }

  OutputInfo outputInfo() const override {
    std::lock_guard lock(state_->mutex);
    return state_->info;
  }

  DopRuntimeFacts dopRuntimeFacts() const override { return {}; }

  NativeDsdRuntimeFacts nativeDsdRuntimeFacts() const override {
    return unsupportedNativeDsdRuntimeFacts("Controlled callback pump does not provide Native DSD hardware");
  }

  std::string deviceName() const override {
    std::lock_guard lock(state_->mutex);
    return state_->info.deviceName;
  }

 private:
  std::shared_ptr<ControlledBackendState> state_;
};

class ScopedControlledBackendFactory {
 public:
  ScopedControlledBackendFactory() {
    AudioPipeline::setBackendFactoryForTests([](const std::string&) {
      return std::make_unique<ControlledPumpBackend>();
    });
  }

  ~ScopedControlledBackendFactory() {
    AudioPipeline::setBackendFactoryForTests({});
  }

  ScopedControlledBackendFactory(const ScopedControlledBackendFactory&) = delete;
  ScopedControlledBackendFactory& operator=(const ScopedControlledBackendFactory&) = delete;
};

std::shared_ptr<ControlledBackendState> latestBackend() {
  std::lock_guard lock(g_backendMutex);
  return g_latestBackend;
}

void resetBackend() {
  std::lock_guard lock(g_backendMutex);
  g_latestBackend.reset();
}

void writeLe16(std::ofstream& out, uint16_t value) {
  const char bytes[2] = {static_cast<char>(value & 0xff), static_cast<char>((value >> 8) & 0xff)};
  out.write(bytes, sizeof(bytes));
}

void writeLe32(std::ofstream& out, uint32_t value) {
  const char bytes[4] = {
      static_cast<char>(value & 0xff),
      static_cast<char>((value >> 8) & 0xff),
      static_cast<char>((value >> 16) & 0xff),
      static_cast<char>((value >> 24) & 0xff)};
  out.write(bytes, sizeof(bytes));
}

std::filesystem::path writePcmWav(
    const std::filesystem::path& path,
    double seconds,
    bool impulseResponse,
    double frequency = 440.0, unsigned sourceRate = kSampleRate) {
  const uint64_t frameCount = static_cast<uint64_t>(std::llround(seconds * static_cast<double>(sourceRate)));
  const uint64_t dataBytes64 = frameCount * kChannels * sizeof(int16_t);
  assert(dataBytes64 <= UINT32_MAX - 36U);
  const uint32_t dataBytes = static_cast<uint32_t>(dataBytes64);

  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  assert(out.good());
  out.write("RIFF", 4);
  writeLe32(out, 36U + dataBytes);
  out.write("WAVEfmt ", 8);
  writeLe32(out, 16);
  writeLe16(out, 1);
  writeLe16(out, kChannels);
  writeLe32(out, sourceRate);
  writeLe32(out, sourceRate * kChannels * sizeof(int16_t));
  writeLe16(out, kChannels * sizeof(int16_t));
  writeLe16(out, 16);
  out.write("data", 4);
  writeLe32(out, dataBytes);

  for (uint64_t frame = 0; frame < frameCount; ++frame) {
    double sample = 0.0;
    if (impulseResponse) {
      const double decay = std::exp(-static_cast<double>(frame) / static_cast<double>(sourceRate) * 7.0);
      sample = frame == 0 ? 0.85 : ((frame % 97 == 0) ? decay * 0.18 : 0.0);
    } else {
      sample = std::sin((2.0 * 3.14159265358979323846 * frequency * static_cast<double>(frame)) /
                        static_cast<double>(sourceRate)) *
               0.20;
    }
    const auto encoded = static_cast<int16_t>(std::clamp(sample, -1.0, 1.0) * 32767.0);
    for (int channel = 0; channel < kChannels; ++channel) writeLe16(out, static_cast<uint16_t>(encoded));
  }
  assert(out.good());
  return path;
}

std::vector<uint8_t> writeTypedGaplessWav(
    const std::filesystem::path& path, int bitsPerSample, bool floatingPoint,
    size_t firstFrame, size_t frameCount) {
  const size_t bytesPerSample = static_cast<size_t>(bitsPerSample / 8);
  const size_t bytesPerFrame = kChannels * bytesPerSample;
  std::vector<uint8_t> payload(frameCount * bytesPerFrame);
  for (size_t frame = 0; frame < frameCount; ++frame) {
    for (size_t channel = 0; channel < kChannels; ++channel) {
      const uint32_t ordinal = static_cast<uint32_t>((firstFrame + frame) * kChannels + channel);
      uint32_t bits = ordinal * 100003u + 12345u;
      if (floatingPoint) bits = 0x3e000000u | (bits & 0x007fffffu) | ((ordinal & 1u) << 31);
      for (size_t byte = 0; byte < bytesPerSample; ++byte) {
        payload[frame * bytesPerFrame + channel * bytesPerSample + byte] =
            static_cast<uint8_t>(bits >> (byte * 8));
      }
    }
  }
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  assert(out.good());
  out.write("RIFF", 4);
  writeLe32(out, static_cast<uint32_t>(36 + payload.size()));
  out.write("WAVEfmt ", 8);
  writeLe32(out, 16);
  writeLe16(out, floatingPoint ? 3 : 1);
  writeLe16(out, kChannels);
  writeLe32(out, kSampleRate);
  writeLe32(out, static_cast<uint32_t>(kSampleRate * bytesPerFrame));
  writeLe16(out, static_cast<uint16_t>(bytesPerFrame));
  writeLe16(out, static_cast<uint16_t>(bitsPerSample));
  out.write("data", 4);
  writeLe32(out, static_cast<uint32_t>(payload.size()));
  out.write(reinterpret_cast<const char*>(payload.data()), static_cast<std::streamsize>(payload.size()));
  // Stereo fixtures have even-sized payloads, so no RIFF pad byte is needed.
  assert(out.good());
  return payload;
}

void verifyTypedGaplessWithRealDecoder(const std::filesystem::path& fixtureRoot) {
  for (const auto& format : {std::pair{16, false}, std::pair{24, false},
                             std::pair{32, false}, std::pair{32, true}}) {
    const auto firstPath = fixtureRoot / "typed-gapless-first.wav";
    const auto nextPath = fixtureRoot / "typed-gapless-next.wav";
    auto expected = writeTypedGaplessWav(firstPath, format.first, format.second, 0, 1031);
    const auto nextPayload = writeTypedGaplessWav(nextPath, format.first, format.second, 1031, 8193);
    expected.insert(expected.end(), nextPayload.begin(), nextPayload.end());
    const size_t bytesPerFrame = kChannels * static_cast<size_t>(format.first / 8);
    expected.resize(3 * kCallbackFrames * bytesPerFrame);

    resetBackend();
    AudioPipeline pipeline;
    QueueItem first, next;
    first.id = "first";
    first.source = firstPath.string();
    next.id = "next";
    next.source = nextPath.string();
    std::string error;
    // The injected pump captures bytes from the real decoder and pipeline;
    // the requested backend exercises typed routing without a hardware claim.
    assert(pipeline.play(first, next, 0, "wasapi-exclusive", "controlled", 1.0,
                         "{\"gapless\":true,\"fftEnabled\":false}", true, &error) == TAE_RESULT_OK);
    const auto backend = latestBackend();
    assert(backend);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (!pipeline.status().preloadReady && std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    assert(pipeline.status().gaplessActive);
    std::vector<uint8_t> actual(expected.size(), 0xff);
    for (size_t callback = 0; callback < 3; ++callback) {
      PcmBlock output;
      output.format = backend->format;
      output.frames = kCallbackFrames;
      output.byteSize = kCallbackFrames * bytesPerFrame;
      output.data = actual.data() + callback * output.byteSize;
      assert(backend->typedRender(output) == kCallbackFrames);
    }
    assert(actual == expected);
    assert(latestBackend() == backend);
    const auto status = pipeline.status();
    assert(status.currentItem.id == next.id);
    assert(status.outputInfo.pcmPassthrough);
    assert(!status.outputInfo.resampled);
    assert(std::abs(status.positionSeconds - 505.0 / kSampleRate) < 1e-9);
    assert(!pipeline.consumeEnded());
    pipeline.stop();
  }
}

struct ProcessMemorySnapshot {
  uint64_t workingSetBytes = 0;
  uint64_t peakWorkingSetBytes = 0;
};

ProcessMemorySnapshot processMemorySnapshot() {
  ProcessMemorySnapshot snapshot;
#ifdef _WIN32
  PROCESS_MEMORY_COUNTERS_EX counters{};
  counters.cb = sizeof(counters);
  if (GetProcessMemoryInfo(
          GetCurrentProcess(),
          reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&counters),
          sizeof(counters))) {
    snapshot.workingSetBytes = static_cast<uint64_t>(counters.WorkingSetSize);
    snapshot.peakWorkingSetBytes = static_cast<uint64_t>(counters.PeakWorkingSetSize);
  }
#endif
  return snapshot;
}

OutputInfo::Diagnostics diagnosticDelta(
    const OutputInfo::Diagnostics& before,
    const OutputInfo::Diagnostics& after) {
  OutputInfo::Diagnostics delta;
  delta.sessionUnderrunCount = after.sessionUnderrunCount - before.sessionUnderrunCount;
  delta.sessionBufferDropCount = after.sessionBufferDropCount - before.sessionBufferDropCount;
  delta.sessionRecoveryCount = after.sessionRecoveryCount - before.sessionRecoveryCount;
  delta.lifetimeUnderrunCount = after.lifetimeUnderrunCount - before.lifetimeUnderrunCount;
  delta.lifetimeBufferDropCount = after.lifetimeBufferDropCount - before.lifetimeBufferDropCount;
  delta.lifetimeRecoveryCount = after.lifetimeRecoveryCount - before.lifetimeRecoveryCount;
  delta.driverRestartCount = after.driverRestartCount - before.driverRestartCount;
  delta.deviceLostCount = after.deviceLostCount - before.deviceLostCount;
  delta.lastError = after.lastError;
  return delta;
}

OutputInfo::RenderPerformanceSnapshot performanceDelta(
    const OutputInfo::RenderPerformanceSnapshot& before,
    const OutputInfo::RenderPerformanceSnapshot& after) {
  OutputInfo::RenderPerformanceSnapshot delta;
  delta.callbackCount = after.callbackCount - before.callbackCount;
  delta.totalCallbackNanoseconds = after.totalCallbackNanoseconds - before.totalCallbackNanoseconds;
  delta.peakCallbackNanoseconds = after.peakCallbackNanoseconds;
  delta.totalDeadlineNanoseconds = after.totalDeadlineNanoseconds - before.totalDeadlineNanoseconds;
  delta.deadlineMissCount = after.deadlineMissCount - before.deadlineMissCount;
  return delta;
}

double meanCallbackLoadPercent(const OutputInfo::RenderPerformanceSnapshot& snapshot) {
  if (snapshot.totalDeadlineNanoseconds == 0) return 0.0;
  return static_cast<double>(snapshot.totalCallbackNanoseconds) * 100.0 /
         static_cast<double>(snapshot.totalDeadlineNanoseconds);
}

double meanCallbackMilliseconds(const OutputInfo::RenderPerformanceSnapshot& snapshot) {
  if (snapshot.callbackCount == 0) return 0.0;
  return static_cast<double>(snapshot.totalCallbackNanoseconds) /
         static_cast<double>(snapshot.callbackCount) / 1000000.0;
}

ta_am_features autoMixFixtureFeatures(double duration, bool tail, float bpm) {
  ta_am_features f{};
  f.duration_seconds = duration; f.start_seconds = tail ? std::max(0.0, duration - 30) : 0;
  f.end_seconds = tail ? duration : std::min(duration, 30.0);
  f.bpm = bpm; f.tempo_confidence = .9f; f.rms_db = -17; f.peak = .2f; f.key = -1;
  for (double t = f.start_seconds; t < f.end_seconds; t += 60.0 / bpm) f.beats[f.beat_count++] = t;
  f.frame_count = static_cast<uint32_t>(std::llround((f.end_seconds - f.start_seconds) * 50));
  for (unsigned i = 0; i < f.frame_count; i++) { f.frame_db[i] = -17; f.frame_peak[i] = .2f; }
  return f;
}
void verifyRoutedDeckReuse(const std::filesystem::path& root) {
  const auto textPath = [](const auto& p) {
    auto u = p.u8string(); return std::string(reinterpret_cast<const char*>(u.data()), u.size());
  };
  QueueItem a, b, c;
  a.id = "routed-first"; a.source = textPath(writePcmWav(root / "routed-first.wav", 4, false, 421));
  b.id = "routed-second"; b.source = textPath(writePcmWav(root / "routed-second.wav", 4, false, 523));
  c.id = "routed-third"; c.source = textPath(writePcmWav(root / "routed-third-silence.wav", 4, false, 0));
  resetBackend(); AudioPipeline pipeline; std::string error;
  OutputConfig config; config.routingMode = ChannelRoutingMode::StereoTo51;
  config.upmixSurroundDelayMs = 20;
  assert(pipeline.setOutputConfig(config, &error));
  assert(pipeline.play(a, b, 0, "controlled-pump", "controlled", 1,
      "{\"gapless\":true,\"crossfadeSeconds\":0,\"fftEnabled\":false}", true, &error) == TAE_RESULT_OK);
  const auto backend = latestBackend(); assert(backend->format.channelCount == 6);
  std::vector<float> scratch(kCallbackFrames * 6);
  unsigned promotions = 0, silentBlocks = 0;
  bool thirdActive = false;
  for (unsigned i = 0; i < 3000 && silentBlocks < 4; ++i) {
    backend->render(scratch.data(), kCallbackFrames);
    if (thirdActive) {
      // Includes LFE and delayed surround slots from the reused track-one router.
      for (auto sample : scratch) assert(sample == 0);
      ++silentBlocks;
    }
    QueueItem started;
    if (pipeline.consumeTrackStarted(&started)) {
      ++promotions;
      if (started.id == b.id) assert(pipeline.preloadNext(c, &error));
      else { assert(started.id == c.id); thirdActive = true; }
    }
    if (i % 8 == 0) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  assert(promotions == 2 && silentBlocks == 4);
  pipeline.stop();
  std::cout << "PASS three-track routed gapless, independent LFE/delay history and clean deck reuse\n";
}

void verifyAutoMixWindowOwnership() {
  auto a = std::make_unique<ta_am_features>(autoMixFixtureFeatures(60, false, 120));
  auto b = std::make_unique<ta_am_features>(*a);
  b->start_seconds = 25; b->end_seconds = 55;
  b->beat_count = 0;
  for (double t = 25.1; t < 55; t += .5) b->beats[b->beat_count++] = t;
  a->voice_count = b->voice_count = 1;
  a->voice_start[0] = 0; a->voice_end[0] = 30; a->voice[0] = .01f; a->music[0] = .9f;
  b->voice_start[0] = 25; b->voice_end[0] = 55; b->voice[0] = .8f; b->music[0] = .2f;
  const std::string identity(64, 'a'), ja = autoMixFeaturesJson(*a, identity), jb = autoMixFeaturesJson(*b, identity);
  auto merged = std::make_unique<ta_am_features>(); std::string error;
  auto request = "{\"currentFeatures\":" + ja + ",\"currentWindows\":[" + jb + "," + ja + "]}";
  assert(parseAutoMixWindows(request, "currentWindows", "currentFeatures", merged.get(), &error));
  assert(std::abs(ta_am_voice_between(merged.get(), 25, 27, 0) - .01f) < 1e-6f);
  assert(std::abs(ta_am_voice_between(merged.get(), 28, 30, 0) - .8f) < 1e-6f);
  bool owned = false, spurious = false;
  for (unsigned i = 0; i < merged->beat_count; i++) {
    owned |= std::abs(merged->beats[i] - 26) < 1e-6;
    spurious |= std::abs(merged->beats[i] - 26.1) < 1e-6;
  }
  assert(owned && !spurious);
  b->voice_count = 0;
  request = "{\"currentFeatures\":" + ja + ",\"currentWindows\":[" + ja + "," + autoMixFeaturesJson(*b, identity) + "]}";
  assert(parseAutoMixWindows(request, "currentWindows", "currentFeatures", merged.get(), &error));
  assert(ta_am_voice_between(merged.get(), 28, 29, 0) < 0);
  b->start_seconds = 31; b->end_seconds = 60; b->frame_count = 1450;
  b->beat_count = 0;
  request = "{\"currentFeatures\":" + ja + ",\"currentWindows\":[" + ja + "," + autoMixFeaturesJson(*b, identity) + "]}";
  assert(!parseAutoMixWindows(request, "currentWindows", "currentFeatures", merged.get(), &error));
  std::cout << "PASS context-owned beats and voice, missing voice and coverage gaps\n";
}
void verifyAutoMixQueueContinuation(
    const QueueItem& current, const QueueItem& next, const std::string& request) {
  resetBackend();
  TwilightAudioEngine engine;
  assert(engine.setVolume(.5) == TAE_RESULT_OK);
  assert(engine.setDspConfig("{\"gapless\":true,\"crossfadeSeconds\":0,\"fftEnabled\":false}") == TAE_RESULT_OK);
  assert(engine.setAutoMixMode("natural") == TAE_RESULT_OK);
  const auto row = [](const QueueItem& item) {
    return "{\"id\":\"" + json_utils::escape(item.id) + "\",\"source\":\"" +
        json_utils::escape(item.source) + "\"}";
  };
  QueueItem last = current;
  last.id = "automix-last";
  assert(engine.loadQueue("[" + row(current) + "," + row(next) + "," + row(last) + "]", 0) == TAE_RESULT_OK);
  assert(engine.play(current.source, 0) == TAE_RESULT_OK);
  auto backend = latestBackend();
  std::vector<float> scratch(kCallbackFrames * kChannels);
  backend->render(scratch.data(), kCallbackFrames);
  assert(engine.prepareAutoMix(request) == TAE_RESULT_OK);
  auto info = engine.getPlaybackInfoJson();
  const auto readyDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (json_utils::fieldString(info, "autoMixState") == "preparing" &&
         std::chrono::steady_clock::now() < readyDeadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    info = engine.getPlaybackInfoJson();
  }
  assert(json_utils::fieldString(info, "autoMixState") == "ready");
  const auto plan = json_utils::fieldNumber(info, "autoMixPlanId").value_or(0);
  assert(plan > 0 && engine.submitAutoMix(static_cast<uint64_t>(plan)) == TAE_RESULT_OK);
  bool mixed = false, advanced = false;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
  for (unsigned i = 0; std::chrono::steady_clock::now() < deadline; ++i) {
    backend = latestBackend();
    RenderCallback render;
    {
      std::lock_guard lock(backend->mutex);
      if (backend->started) render = backend->render;
    }
    if (render) render(scratch.data(), kCallbackFrames);
    if (i % 8 == 0) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    info = engine.getPlaybackInfoJson();
    mixed = mixed || json_utils::fieldString(info, "autoMixState") == "mixing";
    if (json_utils::fieldNumber(info, "queueIndex") == 2) {
      advanced = true;
      break;
    }
  }
  if (!advanced) std::cerr << "AutoMix queue did not advance after continuation EOF: " << info << '\n';
  assert(mixed && advanced);
  assert(json_utils::fieldString(info, "source") == last.source);
  assert(json_utils::fieldString(info, "state") == "playing");
  assert(json_utils::fieldNumber(json_utils::fieldObject(info, "naturalBoundaries"), "trackSerial") == 2);
  assert(engine.stop() == TAE_RESULT_OK);
  std::cout << "PASS AutoMix queue automatically starts the third track after the mixed-in track ends\n";
}

void verifyAutoMixTransport(const std::filesystem::path& root,
                           DspResamplerPhase phase = DspResamplerPhase::Linear) {
  const auto a = writePcmWav(root / "automix-a.wav", 24.125, false, 421, 48000);
  const auto b = writePcmWav(root / "automix-b.wav", 24.125, false, 523, 44100);
  const auto cueA =
      writePcmWav(root / u8"自动混音-当前-CUE.wav", 32, false, 421, 48000);
  const auto cueB =
      writePcmWav(root / u8"自动混音-下一曲-CUE.wav", 32, false, 523, 44100);
  const auto textPath = [](const auto &p) {
    auto u = p.u8string();
    return std::string(reinterpret_cast<const char *>(u.data()), u.size());
  };
  struct TransportCase {
    std::filesystem::path current, next;
    bool cue;
    bool external;
  };
  std::vector<TransportCase> cases{{a, b, false, false},
                                   {cueA, cueB, true, false}};
  // Development-only compressed fixtures stay outside the checkout. Labels
  // below exercise transport with deterministic supplied features; they never
  // count as model quality, suitability or listening evidence.
  if (const char *manifestPath = std::getenv("TAE_AUTOMIX_TRANSPORT_FIXTURE")) {
    std::ifstream input(manifestPath, std::ios::binary);
    assert(input.good());
    const std::string json(std::istreambuf_iterator<char>{input}, {});
    const auto current = json_utils::fieldString(json, "currentSource");
    const auto next = json_utils::fieldString(json, "nextSource");
    assert(current && next);
    cases.push_back({std::filesystem::u8path(*current),
                     std::filesystem::u8path(*next), true, true});
  }
  for (const auto &fixture : cases) {
    const bool cue = fixture.cue;
    char ah[65], bh[65];
    assert(!ta_am_sha256_file(textPath(fixture.current).c_str(), ah) &&
           !ta_am_sha256_file(textPath(fixture.next).c_str(), bh));
    for (const auto setting :
         {std::pair{"natural", DspResamplerQuality::Native},
          std::pair{"dj", DspResamplerQuality::Ultra}}) {
      const auto mode = setting.first;
      const auto quality = setting.second;
      const std::string dspJson =
          std::string("{\"gapless\":true,\"crossfadeSeconds\":2,\"fftEnabled\":"
                      "false,\"resamplerQuality\":\"") +
          (quality == DspResamplerQuality::Ultra ? "ultra" : "native") +
          "\",\"resamplerPhase\":\"" +
          (phase == DspResamplerPhase::MinimumSmooth ? "minimum-smooth" : "linear") + "\"}";
      resetBackend();
      AudioPipeline pipeline;
      std::string error;
      if (fixture.external) {
        OutputConfig output;
        output.continuityFirst = true;
        output.continuitySampleRate = 48000;
        assert(pipeline.setOutputConfig(output, &error));
      }
      QueueItem current, next;
      current.id = "automix-current";
      current.source = textPath(fixture.current);
      next.id = "automix-next";
      next.source = textPath(fixture.next);
      // Library metadata may round up or down; decoder timelines remain exact.
      current.durationSeconds = 25;
      next.durationSeconds = 23;
      if (cue) {
        current.cueStartSeconds = next.cueStartSeconds = 3;
        current.cueEndSeconds = next.cueEndSeconds = 27;
      }
      assert(pipeline.setAutoMixMode(mode, &error));
      assert(pipeline.play(current, next, 0, "controlled-pump", "controlled", 1,
                           dspJson, true, &error) == TAE_RESULT_OK);
      auto backend = latestBackend();
      assert(backend && backend->render);
      const int renderRate = backend->format.sampleRate;
      assert(renderRate == 48000);
      std::vector<float> scratch(kCallbackFrames * kChannels);
      backend->render(scratch.data(), kCallbackFrames); // ACK preload graph
      const auto decoded = pipeline.status();
      const double duration = cue ? 24 : 24.125;
      assert(std::abs(decoded.stream.durationSeconds - duration) < 0.00002);
      assert(decoded.preloadedItem &&
             std::abs(decoded.preloadedItem->durationSeconds - duration) < 0.00002);
      auto fa = autoMixFixtureFeatures(decoded.stream.durationSeconds, true, 120),
           fb = autoMixFixtureFeatures(decoded.preloadedItem->durationSeconds, false, 123);
      const auto secondsJson = [](double seconds) {
        std::ostringstream value;
        value << std::setprecision(17) << seconds;
        return value.str();
      };
      const std::string request =
          "{\"currentSource\":\"" + json_utils::escape(current.source) +
          "\",\"nextSource\":\"" + json_utils::escape(next.source) +
          "\",\"currentSourceStartSeconds\":" + (cue ? "3" : "0") +
          ",\"currentSourceEndSeconds\":" + (cue ? "27" : secondsJson(decoded.stream.durationSeconds)) +
          ",\"nextSourceStartSeconds\":" + (cue ? "3" : "0") +
          ",\"nextSourceEndSeconds\":" + (cue ? "27" : secondsJson(decoded.preloadedItem->durationSeconds)) +
          ",\"currentFeatures\":" + autoMixFeaturesJson(fa, ah) +
          ",\"nextFeatures\":" + autoMixFeaturesJson(fb, bh) + "}";

      const auto selectRequest = request.substr(0, request.size() - 1) + ",\"ruleVersion\":\"twilight-rules-5\"}";
      const auto oldRuleRequest = request.substr(0, request.size() - 1) + ",\"ruleVersion\":\"twilight-rules-3\"}";
      assert(!json_utils::fieldBool(pipeline.selectAutoMix(oldRuleRequest), "ok").value_or(false));
      auto selection = pipeline.selectAutoMix(selectRequest);
      assert(json_utils::fieldBool(selection, "ok").value_or(false));
      auto selectionId = json_utils::fieldNumber(selection, "selectionId").value_or(0);
      assert(selectionId > 0);
      pipeline.cancelAutoMix("selection_invalidated_test");
      const auto stale = selectRequest.substr(0, selectRequest.size() - 1) + ",\"selectionId\":" + std::to_string(selectionId) + "}";
      assert(!pipeline.prepareAutoMix(stale, &error) && error == "stale_selection_ticket");
      selection = pipeline.selectAutoMix(selectRequest);
      assert(json_utils::fieldBool(selection, "ok").value_or(false));
      selectionId = json_utils::fieldNumber(selection, "selectionId").value_or(0);
      const auto selectedRequest = selectRequest.substr(0, selectRequest.size() - 1) + ",\"selectionId\":" + std::to_string(selectionId) + "}";
      assert(pipeline.prepareAutoMix(selectedRequest, &error));
      auto waitReady = [&] {
        for (unsigned i = 0; i < 2000; i++) {
          pipeline.pollAutoMix();
          auto status = pipeline.status();
          if (status.autoMixState != "preparing")
            return status;
          std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
        return pipeline.status();
      };
      auto status = waitReady();
      if (status.autoMixState != "ready")
        std::cerr << "AutoMix reason: " << status.autoMixReason << '\n';
      assert(status.autoMixState == "ready");
      assert(!pipeline.submitAutoMix(status.autoMixPlanId + 1, &error));
      assert(pipeline.submitAutoMix(status.autoMixPlanId, &error));
      uint64_t previous = 0;
      unsigned promotions = 0;
      bool sawMix = false, pauseVerified = false;
      for (unsigned i = 0; i < 4000; i++) {
        backend->render(scratch.data(), kCallbackFrames);
        if (i % 8 == 0)
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
        const auto after = pipeline.status();
        if (after.autoMixState == "mixing") {
          sawMix = true;
          assert(!after.outputPerfect &&
                 after.autoMixOutputSeconds * renderRate >= previous);
          previous = static_cast<uint64_t>(
              std::llround(after.autoMixOutputSeconds * renderRate));
          if (!pauseVerified) {
            assert(pipeline.togglePause() == TAE_RESULT_OK);
            const auto paused = pipeline.status();
            backend->render(scratch.data(), kCallbackFrames);
            backend->render(scratch.data(), kCallbackFrames);
            const auto frozen = pipeline.status();
            assert(frozen.positionSeconds == paused.positionSeconds &&
                   frozen.autoMixOutputSeconds == paused.autoMixOutputSeconds &&
                   frozen.autoMixNextSourceSeconds ==
                       paused.autoMixNextSourceSeconds);
            assert(pipeline.togglePause() == TAE_RESULT_OK);
            pauseVerified = true;
          }
        }
        QueueItem started;
        if (pipeline.consumeTrackStarted(&started)) {
          promotions++;
          assert(started.id == next.id);
        }
        if (after.currentItem.id == next.id) {
          assert(sawMix && promotions == 1 && after.positionSeconds > 4);
          // The following block must match the original source at the mapped
          // incoming clock. This catches repeating/skipping a continuation
          // frame.
          const auto frame = static_cast<uint64_t>(
              std::llround(after.positionSeconds * renderRate));
          AudioFormat format;
          format.sampleRate = renderRate;
          format.channelCount = kChannels;
          std::vector<float> reference;
          assert(decodeAutoMixFrames(next, format, frame, kCallbackFrames,
                                     &reference, &error, nullptr, quality, {}, phase));
          backend->render(scratch.data(), kCallbackFrames);
          assert(reference.size() == scratch.size());
          for (size_t sample = 0; sample < scratch.size(); sample++)
            assert(std::abs(reference[sample] - scratch[sample]) < 1e-5f);
          if (phase == DspResamplerPhase::MinimumSmooth) {
            const auto output = json_utils::fieldObject(pipeline.dspGraphStatusJson(), "outputStage");
            assert(json_utils::fieldString(output, "effectiveResampler") == "soxr");
            assert(json_utils::fieldString(output, "effectiveResamplerPhase") ==
                (quality == DspResamplerQuality::Native ? "minimum" : "minimum-smooth"));
          }
          assert(!pipeline.consumeTrackStarted(nullptr));
          break;
        }
      }
      assert(sawMix && promotions == 1);
      const auto performance = pipeline.renderPerformanceSnapshot();
      assert(performance.deadlineMissCount == 0 &&
             performance.totalDeadlineNanoseconds > 0 &&
             100.0 * performance.totalCallbackNanoseconds /
                     performance.totalDeadlineNanoseconds <
                 kPipelineMeanDeadlineLoadLimitPercent);
      // Preparation has already joined/freed its cancellation token. Keep
      // rendering the incoming decoder all the way to EOF, not just its first
      // block: a borrowed preparation token can otherwise suppress EOF and
      // leave the queue playing silence forever after a successful overlap.
      bool ended = false;
      const auto endDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
      for (unsigned i = 0; std::chrono::steady_clock::now() < endDeadline; ++i) {
        backend->render(scratch.data(), kCallbackFrames);
        if (i % 8 == 0) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        status = pipeline.status();
        assert(!pipeline.consumeTrackStarted(nullptr));
        if (pipeline.consumeEnded()) {
          ended = true;
          break;
        }
      }
      if (!ended) {
        OutputInfo::Diagnostics health;
        pipeline.sampleDecodeHealth(health);
        std::cerr << "AutoMix continuation did not reach EOF: mode=" << mode
                  << " cue=" << cue << " position=" << status.positionSeconds
                  << " duration=" << status.stream.durationSeconds
                  << " stage=" << health.decodeStage << " eof=" << health.decodeEof
                  << " stopped=" << health.decodeStopRequested << '\n';
      }
      assert(ended);
      assert(status.currentItem.id == next.id && status.state == PipelineState::Stopped);
      assert(std::abs(status.positionSeconds - status.stream.durationSeconds) < 0.001);
      assert(!pipeline.consumeEnded());
      assert(!pipeline.consumeDecodeError(&error));
      pipeline.stop();
      if (!cue && std::string(mode) == "natural")
        verifyAutoMixQueueContinuation(current, next, request);
      // A source hash mismatch must never produce a ready plan.
      assert(pipeline.play(current, next, 0, "controlled-pump", "controlled", 1,
                           "{\"gapless\":true,\"fftEnabled\":false}", true,
                           &error) == TAE_RESULT_OK);
      backend = latestBackend();
      backend->render(scratch.data(), kCallbackFrames);
      std::string mismatch = request;
      const auto where = mismatch.find(ah);
      assert(where != std::string::npos);
      mismatch[where] = ah[0] == 'a' ? 'b' : 'a';
      assert(pipeline.prepareAutoMix(mismatch, &error));
      status = waitReady();
      assert(status.autoMixState == "degraded" &&
             status.autoMixReason == "source_changed_or_identity_unavailable");
      // Cancelling a live overlap resumes the original outgoing stream at the
      // mapped source clock; the untouched fallback preload remains at zero.
      assert(pipeline.prepareAutoMix(request, &error));
      status = waitReady();
      assert(status.autoMixState == "ready" &&
             pipeline.submitAutoMix(status.autoMixPlanId, &error));
      bool cancelled = false;
      for (unsigned i = 0; i < 4000; i++) {
        backend->render(scratch.data(), kCallbackFrames);
        if (i % 8 == 0)
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
        status = pipeline.status();
        if (status.autoMixState != "mixing")
          continue;
        pipeline.cancelAutoMix("test_cancel");
        status = pipeline.status();
        const auto frame = static_cast<uint64_t>(
            std::llround(status.positionSeconds * renderRate));
        AudioFormat format;
        format.sampleRate = renderRate;
        format.channelCount = kChannels;
        std::vector<float> reference;
        // This replay uses the default native resampler. Analysis decoding's
        // default High quality is a different waveform for resampled music.
        assert(decodeAutoMixFrames(current, format, frame, kCallbackFrames,
                                   &reference, &error, nullptr,
                                   DspResamplerQuality::Native));
        backend->render(scratch.data(), kCallbackFrames);
        for (size_t sample = 0; sample < scratch.size(); sample++) {
          if (std::abs(reference[sample] - scratch[sample]) >= 1e-5f) {
            std::cerr << "Cancel continuation mismatch mode=" << mode
                      << " frame=" << frame << " sample=" << sample
                      << " expected=" << reference[sample]
                      << " actual=" << scratch[sample]
                      << " crossfade=" << pipeline.status().crossfadeMixActive
                      << '\n';
          }
          assert(std::abs(reference[sample] - scratch[sample]) < 1e-5f);
        }
        assert(!pipeline.consumeTrackStarted(nullptr));
        cancelled = true;
        break;
      }
      assert(cancelled);
      assert(pipeline.seek(1, &error) == TAE_RESULT_OK);
      assert(!pipeline.submitAutoMix(status.autoMixPlanId, &error));
      pipeline.stop();
      if (!cue) {
        // Enabling smart mixing after an ordinary approximate seek must not
        // pretend that the decoder and planned source-frame grid agree.
        assert(pipeline.setAutoMixMode("off", &error));
        // Force PCM. While mode is off, ordinary gapless deliberately does not
        // preload unequal-rate sources; prepare it after enabling AutoMix.
        assert(pipeline.play(current, next, 1.25, "controlled-pump", "controlled", .75,
            "{\"gapless\":true,\"fftEnabled\":false}", true, &error) == TAE_RESULT_OK);
        backend = latestBackend(); backend->render(scratch.data(), kCallbackFrames);
        assert(pipeline.setAutoMixMode(mode, &error));
        assert(pipeline.preloadNext(next, &error));
        backend->render(scratch.data(), kCallbackFrames);
        const bool prepared = pipeline.prepareAutoMix(request, &error);
        if (prepared || error != "source_timeline_not_exact")
          std::cerr << "Approximate timeline guard prepared=" << prepared
                    << " reason=" << error << '\n';
        assert(!prepared && error == "source_timeline_not_exact");
        pipeline.stop();
      }
    }
  }
  std::cout << "PASS AutoMix real decoder natural/DJ, UTF-8 CUE ranges, single "
               "promotion, exact continuation and stale source; phase="
            << (phase == DspResamplerPhase::MinimumSmooth ? "minimum-smooth" : "linear") << '\n';
}
bool pumpCallback(const std::shared_ptr<ControlledBackendState> &backend,
                  std::vector<float> *scratch) {
  assert(backend && scratch);
  RenderCallback render;
  AudioFormat format;
  {
    std::lock_guard lock(backend->mutex);
    assert(backend->started);
    render = backend->render;
    format = backend->format;
  }
  assert(render);
  scratch->assign(kCallbackFrames *
                      static_cast<size_t>(std::max(1, format.channelCount)),
                  0.0f);
  const size_t written = render(scratch->data(), kCallbackFrames);
  assert(written == kCallbackFrames);
  const bool containsAudio =
      std::any_of(scratch->begin(), scratch->end(),
                  [](float value) { return std::abs(value) > 0.0001f; });
  {
    std::lock_guard lock(backend->mutex);
    ++backend->callbackInvocations;
    if (containsAudio)
      ++backend->callbacksWithAudio;
  }
  return containsAudio;
}

int verifyChannelLayout() {
  constexpr size_t sourceFrames = 16384, captureFrames = 4096;
  const std::string graph = R"({"dspEnabled":true,"graph":{"nodes":[
    {"id":"bass","type":"bassManagement","enabled":true,"params":{"crossoverHz":80,"lfeGainDb":0,"redirectLfe":true}}
  ]}})";
  int scenarios = 0;
  for (const uint32_t mask : {7u, 0xbu, 0x3bu, 0x37u, 0x3fu, 0x707u, 0x63fu}) {
    for (int mode = 0; mode < (mask == 7 ? 4 : 1); ++mode) {
      resetBackend();
      g_pcmSharedFormat = mode == 3;
      auto currentBytes = std::make_shared<const std::vector<uint8_t>>(layout_fixture::wave(mask, sourceFrames));
      auto nextBytes = std::make_shared<const std::vector<uint8_t>>(layout_fixture::wave(mask, sourceFrames, 1));
      auto differentBytes = std::make_shared<const std::vector<uint8_t>>(layout_fixture::wave(0xb, sourceFrames, 1));
      auto factory = std::make_shared<const SeekableInputFactory>([=](const std::string& source) {
        return std::make_shared<layout_fixture::MemoryInput>(source.find("different") != std::string::npos
            ? differentBytes : source.find("next") != std::string::npos ? nextBytes : currentBytes);
      });
      AudioPipeline pipeline;
      pipeline.setInputFactory(factory);
      OutputConfig config; config.allowedSampleRates = {48000};
      if (mode == 1) config.routingMode = ChannelRoutingMode::Stereo;
      if (mode == 2) config.continuityFirst = true;
      std::string error;
      assert(pipeline.setOutputConfig(config, &error));
      assert(pipeline.setDspGraph(graph, &error));
      QueueItem item; item.id = "current"; item.source = "memory-layout://current.wav";
      assert(pipeline.play(item, std::nullopt, 0, "controlled-pump", "layout", 1,
          R"({"dspEnabled":true,"clipGuard":false,"fftEnabled":false,"headroomEnabled":false,"crossfadeSeconds":0})",
          true, &error) == TAE_RESULT_OK);
      const auto backend = latestBackend();
      const auto status = pipeline.status();
      const uint64_t decodedMask = mode >= 2 ? 3 : mask;
      assert(status.stream.sourceFormat.channelMask == mask);
      assert(status.stream.decodedFormat.channelMask == decodedMask);
      assert(status.outputFormat.channelMask == (mode == 0 ? mask : 3));
      const int expectedLfe = decodedMask & 8 ? std::popcount(decodedMask & 7) : -1;
      std::vector<float> actual, block;
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
      while (actual.size() < captureFrames * status.outputFormat.channelCount && std::chrono::steady_clock::now() < deadline) {
        const double before = pipeline.status().positionSeconds;
        pumpCallback(backend, &block);
        if (pipeline.status().positionSeconds > before) actual.insert(actual.end(), block.begin(), block.end());
        else std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      assert(actual.size() == captureFrames * status.outputFormat.channelCount);
      assert(std::all_of(actual.begin(), actual.end(), [](float value) { return std::isfinite(value); }));
      const auto applied = pipeline.status();
      if (applied.dspGraphJson.find("\"lfeChannelIndex\":" + std::to_string(expectedLfe)) == std::string::npos)
        std::cerr << "Layout graph mask=" << mask << " decoded=" << decodedMask << " mode=" << mode
                  << " requested/applied=" << applied.requestedConfigRevision << '/' << applied.appliedConfigRevision
                  << " json=" << applied.dspGraphJson << '\n';
      assert(applied.dspGraphJson.find("\"lfeChannelIndex\":" + std::to_string(expectedLfe)) != std::string::npos);
      assert((applied.dspGraphJson.find("no LFE") != std::string::npos) == (expectedLfe < 0));
      double maxError = 0;
      if (mode == 0) {
        auto expected = layout_fixture::samples(mask, captureFrames);
        BassManagementProcessor reference;
        DspConfig dsp; dsp.enabled = dsp.bassManagementEnabled = true;
        reference.configure(dsp); reference.prepare(status.stream.decodedFormat);
        reference.process(expected.data(), captureFrames);
        for (size_t i = 0; i < actual.size(); ++i) maxError = std::max(maxError, std::abs(double(actual[i]) - expected[i]));
        if (maxError > 1e-7) std::cerr << "Channel layout callback mismatch mask=" << mask << " error=" << maxError << '\n';
        assert(maxError == 0);
      }
      if (mask == 7 && mode != 1 && mode != 3) {
        QueueItem different; different.id = "different"; different.source = "memory-layout://different.wav";
        const bool prepared = pipeline.preloadNext(different, &error);
        assert(prepared == (mode == 2)); // Continuity converts both to the same stereo stream.
        error.clear();
      }
      QueueItem next; next.id = "next"; next.source = "memory-layout://next.wav";
      assert(pipeline.preloadNext(next, &error));
      const auto readyDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
      while (!pipeline.status().preloadReady && std::chrono::steady_clock::now() < readyDeadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      assert(pipeline.status().preloadReady && pipeline.skipToPreloaded(next, &error));
      const auto promoted = pipeline.status();
      assert(promoted.stream.sourceFormat.channelMask == mask && promoted.stream.decodedFormat.channelMask == decodedMask);
      assert(promoted.outputFormat.channelMask == (mode == 0 ? mask : 3));
      pumpCallback(backend, &block);
      double preloadDifference = 0;
      if (mode == 0) {
        auto expected = layout_fixture::samples(mask, kCallbackFrames, 1);
        BassManagementProcessor reference;
        DspConfig dsp; dsp.enabled = dsp.bassManagementEnabled = true;
        reference.configure(dsp); reference.prepare(promoted.stream.decodedFormat);
        reference.process(expected.data(), kCallbackFrames);
        for (size_t i = 0; i < block.size(); ++i)
          preloadDifference = std::max(preloadDifference, std::abs(double(block[i]) - expected[i]));
        assert(preloadDifference == 0);
      }
      pipeline.stop();
      std::cout << "{\"case\":\"pipeline-layout\",\"sourceMask\":\"" << channelMaskToString(mask)
                << "\",\"decodedMask\":\"" << channelMaskToString(decodedMask) << "\",\"mode\":" << mode
                << ",\"maxCallbackDifference\":" << (mode == 0 ? std::to_string(maxError) : "null")
                << ",\"preloadCallbackDifference\":" << (mode == 0 ? std::to_string(preloadDifference) : "null")
                << ",\"preloadPromoted\":true}\n";
      ++scenarios;
    }
  }
  g_pcmSharedFormat = false;
  {
    TwilightAudioEngine engine;
    engine.setInputFactory(layout_fixture::factory(7, sourceFrames));
    assert(engine.setDspConfig(R"({"dspEnabled":true,"clipGuard":false,"fftEnabled":false})") == TAE_RESULT_OK);
    assert(engine.setDspGraph(graph) == TAE_RESULT_OK);
    assert(engine.play("memory-layout://diagnostics.wav", 0) == TAE_RESULT_OK);
    const auto json = engine.getPlaybackInfoJson();
    assert(json_utils::fieldString(json, "sourceChannelMask") == "0x7");
    assert(json_utils::fieldString(json, "decodedChannelMask") == "0x7");
    assert(json_utils::fieldString(json, "outputChannelMask") == "0x7");
    assert(engine.stop() == TAE_RESULT_OK);
    assert(json_utils::fieldString(engine.getPlaybackInfoJson(), "outputChannelMask") == "0x0");
    ++scenarios;
  }
  std::cout << "{\"suite\":\"channel-layout-pipeline\",\"scenarios\":" << scenarios << ",\"passed\":true}\n";
  return 0;
}

int verifyFlacTailContinuation() {
  using namespace twilight::audio::test;
  const auto first = writeFlacTailFixture("twilight-continuation-tail.flac", true, false, true, 40);
  const auto next = writePcmWavFixture({"twilight-continuation-next.wav", 44100, 2, 16, 88200, false});
  g_pcmSharedFormat = true; // Match FLAC 44.1 kHz -> shared output 48 kHz.
  for (const bool gapless : {false, true}) {
    // Ordinary playback, resume near the end, and dragging the progress bar.
    for (const int seekMode : {0, 1, 2}) {
      resetBackend();
      std::atomic<int> errors{0};
      TwilightAudioEngine engine;
      engine.setEventCallback([](const char* type, const char* payload, void* context) {
        if (std::string(type) == "error" ||
            (std::string(type) == "end-file" && json_utils::fieldString(payload, "reason") == "error"))
          static_cast<std::atomic<int>*>(context)->fetch_add(1);
      }, &errors);
      assert(engine.setVolume(.2) == TAE_RESULT_OK);
      assert(engine.setDspConfig(std::string("{\"gapless\":") + (gapless ? "true" : "false") +
                                 ",\"crossfadeSeconds\":0,\"fftEnabled\":false}") == TAE_RESULT_OK);
      const std::string queue = "[{\"id\":\"first\",\"source\":\"" + json_utils::escape(first.string()) +
          "\"},{\"id\":\"next\",\"source\":\"" + json_utils::escape(next.string()) + "\"}]";
      assert(engine.loadQueue(queue, 0) == TAE_RESULT_OK);
      assert(engine.play(first.string(), seekMode == 1 ? 4.15 : 0) == TAE_RESULT_OK);
      if (seekMode == 2) assert(engine.seek(4.15) == TAE_RESULT_OK);
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
      bool advanced = false;
      while (std::chrono::steady_clock::now() < deadline && errors.load() == 0) {
        const auto backend = latestBackend();
        RenderCallback render;
        AudioFormat format;
        if (backend) {
          std::lock_guard lock(backend->mutex);
          if (backend->started) { render = backend->render; format = backend->format; }
        }
        // The clock may close/reopen output for a non-gapless transition.
        if (render) {
          std::vector<float> block(kCallbackFrames * format.channelCount);
          render(block.data(), kCallbackFrames);
        }
        const auto info = engine.getPlaybackInfoJson();
        if (json_utils::fieldString(info, "source") == next.string() &&
            json_utils::fieldNumber(info, "queueIndex") == 1) {
          assert(json_utils::fieldString(info, "state") == "playing");
          assert(json_utils::fieldNumber(json_utils::fieldObject(info, "naturalBoundaries"), "trackSerial") == 1);
          advanced = true;
          break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
      }
      if (!advanced) std::cerr << "FLAC continuation failed: gapless=" << gapless << " seekMode=" << seekMode
                               << " info=" << engine.getPlaybackInfoJson() << '\n';
      assert(errors.load() == 0);
      assert(advanced);
      assert(engine.stop() == TAE_RESULT_OK);
    }
  }
  g_pcmSharedFormat = false;
  std::cout << "PASS FLAC trailing-data auto-next: normal/resume/seek, gapless on/off, 44.1 -> 48 kHz\n";
  return 0;
}

// Capture the production float callback without a device or muted software
// volume. This checks ordinary playback, before any transition is submitted.
int verifyPcmTransparency(const std::filesystem::path& manifestPath) {
  std::ifstream manifest(manifestPath);
  const std::string json{std::istreambuf_iterator<char>(manifest), {}};
  const std::string source = json_utils::fieldString(json, "source").value_or("");
  const double seconds = json_utils::fieldNumber(json, "seconds").value_or(90);
  const double volume = json_utils::fieldNumber(json, "volume").value_or(.54);
  const std::string outputDir = json_utils::fieldString(json, "outputDir").value_or("");
  assert(!source.empty() && seconds > 0 && seconds <= 600 && volume > 0 && volume <= 1);
  const std::string graph = json_utils::fieldObject(json, "graph");
  assert(!graph.empty());
  g_pcmSharedFormat = true;
  AudioFormat format;
  format.sampleRate = 48000;
  format.bitDepth = 32;
  format.channelCount = 2;
  format.sampleFormat = AudioSampleFormat::Float32Interleaved;
  const size_t frames = static_cast<size_t>(seconds * format.sampleRate) / kCallbackFrames * kCallbackFrames;
  std::vector<float> decoded(frames * 2), block(kCallbackFrames * 2);
  FFmpegDecoder decoder;
  std::string error;
  assert(decoder.open(source, &error));
  decoder.setResamplerQuality(FFmpegDecoder::ResamplerQuality::Native);
  assert(decoder.setOutputFormat(format, &error));
  assert(decoder.readFrames(decoded.data(), frames, &error) == frames);
  const auto writeCapture = [&](const std::string& name, const std::vector<float>& pcm) {
    if (outputDir.empty()) return;
    std::filesystem::create_directories(std::filesystem::u8path(outputDir));
    std::ofstream out(std::filesystem::u8path(outputDir) / (name + ".f32"), std::ios::binary);
    out.write(reinterpret_cast<const char*>(pcm.data()), pcm.size() * sizeof(float));
    assert(out.good());
  };
  writeCapture("decoded", decoded);
  double decodedPeak = 0;
  uint64_t decodedOverFullScale = 0;
  for (const float value : decoded) {
    decodedPeak = std::max(decodedPeak, std::abs(static_cast<double>(value)));
    decodedOverFullScale += std::abs(value) > 1;
  }
  std::vector<float> baseline;
  bool passed = true;
  std::cout << std::setprecision(12)
            << "{\"source\":\"" << json_utils::escape(source) << "\",\"frames\":" << frames
            << ",\"sampleRate\":48000,\"volume\":" << volume
            << ",\"decodedPeak\":" << decodedPeak
            << ",\"decodedOverFullScale\":" << decodedOverFullScale << ",\"scenarios\":[";
  size_t scenarioIndex = 0;
  for (const bool dspEnabled : {false, true}) {
    for (const std::string mode : {"off", "natural", "dj", "dj-to-off"}) {
      resetBackend();
      AudioPipeline pipeline;
      OutputConfig config;
      assert(pipeline.setOutputConfig(config, &error));
      assert(pipeline.setDspGraph("{\"dspEnabled\":" + std::string(dspEnabled ? "true" : "false") +
          ",\"graph\":" + graph + "}", &error));
      assert(pipeline.setAutoMixMode(mode == "dj-to-off" ? "dj" : mode, &error));
      QueueItem item;
      item.id = "transparency";
      item.source = source;
      const std::string processing = "{\"dspEnabled\":" + std::string(dspEnabled ? "true" : "false") +
          ",\"clipGuard\":true,\"fftEnabled\":true,\"fftResolution\":8192,\"highResolution\":true}";
      assert(pipeline.play(item, std::nullopt, 0, "controlled-pump", "controlled", volume,
          processing, true, &error) == TAE_RESULT_OK);
      const auto backend = latestBackend();
      assert(backend->format.sampleRate == 48000);
      std::vector<float> actual(frames * 2);
      size_t rendered = 0;
      uint64_t starvationCallbacks = 0;
      while (rendered < frames) {
        if (mode == "dj-to-off" && rendered == kCallbackFrames * 32)
          assert(pipeline.setAutoMixMode("off", &error));
        // Exercise the same atomic graph replacement used by the UI, including
        // a master bypass and restoration while audio continues.
        if (rendered == kCallbackFrames * 64 || rendered == kCallbackFrames * 128) {
          const bool enabled = rendered == kCallbackFrames * 64 ? !dspEnabled : dspEnabled;
          const uint64_t revision = rendered == kCallbackFrames * 64 ? 100 : 101;
          const std::string nextProcessing = "{\"dspEnabled\":" + std::string(enabled ? "true" : "false") +
              ",\"clipGuard\":true,\"fftEnabled\":true,\"fftResolution\":8192,\"highResolution\":true}";
          assert(pipeline.applyDspState(revision,
              "{\"revision\":" + std::to_string(revision) + ",\"processing\":" + nextProcessing +
              ",\"graph\":" + graph + "}", &error));
        }
        const double before = pipeline.status().positionSeconds;
        pumpCallback(backend, &block);
        const double after = pipeline.status().positionSeconds;
        if (after <= before) {
          ++starvationCallbacks;
          assert(starvationCallbacks < 10000);
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
          continue;
        }
        assert(std::abs(after - before - static_cast<double>(kCallbackFrames) / 48000) < 1e-8);
        std::copy(block.begin(), block.end(), actual.begin() + rendered * 2);
        rendered += kCallbackFrames;
        if ((rendered / kCallbackFrames) % 8 == 0)
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      double peak = 0, maxError = 0, squaredError = 0, maxBaselineDifference = 0;
      uint64_t clipped = 0, nonfinite = 0;
      for (size_t i = 0; i < actual.size(); ++i) {
        const float expected = static_cast<float>(std::clamp(static_cast<double>(decoded[i]) * volume, -1., 1.));
        const double difference = static_cast<double>(actual[i]) - expected;
        maxError = std::max(maxError, std::abs(difference));
        squaredError += difference * difference;
        peak = std::max(peak, std::abs(static_cast<double>(actual[i])));
        clipped += std::abs(actual[i]) >= 1;
        nonfinite += !std::isfinite(actual[i]);
        if (!baseline.empty()) maxBaselineDifference = std::max(maxBaselineDifference,
            std::abs(static_cast<double>(actual[i]) - baseline[i]));
      }
      if (baseline.empty()) baseline = actual;
      const auto status = pipeline.status();
      pipeline.stop();
      const std::string name = std::string(dspEnabled ? "dsp-on-" : "dsp-off-") + mode;
      writeCapture(name, actual);
      if (scenarioIndex++) std::cout << ',';
      std::cout << "{\"name\":\"" << name << "\",\"peak\":" << peak
                << ",\"clipped\":" << clipped << ",\"nonfinite\":" << nonfinite
                << ",\"maxError\":" << maxError << ",\"rmsError\":" << std::sqrt(squaredError / actual.size())
                << ",\"maxBaselineDifference\":" << maxBaselineDifference
                << ",\"starvationCallbacks\":" << starvationCallbacks
                << ",\"positionSeconds\":" << status.positionSeconds << '}';
      passed = passed && maxError <= 1e-7 && maxBaselineDifference == 0 && nonfinite == 0 && starvationCallbacks == 0;
    }
  }
  std::cout << "],\"passed\":" << (passed ? "true" : "false") << "}\n";
  g_pcmSharedFormat = false;
  return passed ? 0 : 1;
}

struct PumpResult {
  PipelineStatus status;
  uint64_t callbackCount = 0;
  uint64_t callbacksWithAudio = 0;
};

PumpResult pumpAudioTime(
    AudioPipeline &pipeline,
    const std::shared_ptr<ControlledBackendState> &backend,
    double targetAudioSeconds,
    const std::optional<std::string> &expectedCurrentItemId = std::nullopt) {
  const uint64_t expectedFrames = static_cast<uint64_t>(targetAudioSeconds * static_cast<double>(kSampleRate));
  const uint64_t expectedCallbacks = (expectedFrames + kCallbackFrames - 1) / kCallbackFrames;
  std::vector<float> scratch;
  uint64_t callbacks = 0;
  uint64_t callbacksWithAudio = 0;
  const uint64_t callbackLimit = expectedCallbacks * 4 + 1024;

  while (callbacks < callbackLimit) {
    callbacksWithAudio += pumpCallback(backend, &scratch) ? 1U : 0U;
    ++callbacks;
    if ((callbacks % 16U) == 0U) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    const PipelineStatus status = pipeline.status();
    const bool expectedTrackPromoted =
        expectedCurrentItemId && status.currentItem.id == *expectedCurrentItemId;
    if (callbacks >= expectedCallbacks &&
        (expectedTrackPromoted || (!expectedCurrentItemId && status.positionSeconds >= targetAudioSeconds * 0.98))) {
      break;
    }
  }

  PumpResult result;
  result.status = pipeline.status();
  result.callbackCount = callbacks;
  result.callbacksWithAudio = callbacksWithAudio;
  if (expectedCurrentItemId) {
    assert(result.status.currentItem.id == *expectedCurrentItemId);
    // The 12-second transition scenarios contain eight seconds of the first
    // source, so promotion must leave several seconds of actual next-track
    // rendering rather than merely toggling a pending flag.
    assert(result.status.positionSeconds >= 2.0);
  } else {
    assert(result.status.positionSeconds >= targetAudioSeconds * 0.98);
  }
  assert(callbacksWithAudio > expectedCallbacks / 2);
  return result;
}

struct ScenarioReport {
  std::string name;
  std::string execution = "controlled-pump";
  double audioSeconds = 0.0;
  OutputInfo::RenderPerformanceSnapshot performance;
  OutputInfo::Diagnostics diagnostics;
  uint64_t workingSetBeforeBytes = 0;
  uint64_t workingSetAfterBytes = 0;
  uint64_t peakWorkingSetBytes = 0;
  uint64_t callbackPumpCount = 0;
  uint64_t callbackPumpAudioCount = 0;
  bool upcomingTrackPromoted = false;
  bool vst3ControlledHelper = false;
};

void enforcePipelineThresholds(const ScenarioReport& report) {
  assert(report.performance.callbackCount > 0);
  assert(report.performance.totalDeadlineNanoseconds > 0);
  assert(report.performance.deadlineMissCount <= kPipelineDeadlineMissLimit);
  assert(meanCallbackLoadPercent(report.performance) <= kPipelineMeanDeadlineLoadLimitPercent);
  assert(report.diagnostics.sessionUnderrunCount == 0);
  assert(report.diagnostics.sessionBufferDropCount == 0);
  assert(report.diagnostics.sessionRecoveryCount == 0);
  assert(report.diagnostics.deviceLostCount == 0);
  assert(report.diagnostics.lastError.empty());
#ifdef _WIN32
  assert(report.workingSetBeforeBytes > 0);
  assert(report.workingSetAfterBytes > 0);
  assert(report.peakWorkingSetBytes >= report.workingSetAfterBytes);
#endif
}

ScenarioReport runPipelineScenario(
    const std::string& name,
    const std::filesystem::path& source,
    double targetAudioSeconds,
    const std::string& dspConfigJson,
    const std::optional<std::filesystem::path>& upcoming = std::nullopt,
    const std::optional<std::filesystem::path>& impulseResponse = std::nullopt) {
  resetBackend();
  AudioPipeline pipeline;
  QueueItem item;
  item.id = name + "-current";
  item.source = source.string();
  std::optional<QueueItem> next;
  if (upcoming) {
    QueueItem nextItem;
    nextItem.id = name + "-next";
    nextItem.source = upcoming->string();
    next = nextItem;
  }

  std::string error;
  assert(pipeline.play(item, next, 0.0, "controlled-pump", "controlled", 0.9, dspConfigJson, true, &error) == TAE_RESULT_OK);
  const auto backend = latestBackend();
  assert(backend);
  if (impulseResponse) {
    assert(pipeline.loadImpulseResponse(impulseResponse->string(), &error));
    assert(pipeline.convolverInfo().active);
  }

  const PipelineStatus before = pipeline.status();
  const ProcessMemorySnapshot memoryBefore = processMemorySnapshot();
  const PumpResult pump = pumpAudioTime(
      pipeline,
      backend,
      targetAudioSeconds,
      next ? std::optional<std::string>(next->id) : std::nullopt);
  const PipelineStatus after = pump.status;
  const ProcessMemorySnapshot memoryAfter = processMemorySnapshot();

  ScenarioReport report;
  report.name = name;
  report.audioSeconds = targetAudioSeconds;
  report.performance = performanceDelta(before.outputInfo.renderPerformance, after.outputInfo.renderPerformance);
  report.diagnostics = diagnosticDelta(before.outputInfo.diagnostics, after.outputInfo.diagnostics);
  report.workingSetBeforeBytes = memoryBefore.workingSetBytes;
  report.workingSetAfterBytes = memoryAfter.workingSetBytes;
  report.peakWorkingSetBytes = memoryAfter.peakWorkingSetBytes;
  report.callbackPumpCount = pump.callbackCount;
  report.callbackPumpAudioCount = pump.callbacksWithAudio;
  report.upcomingTrackPromoted = next && after.currentItem.id == next->id;
  if (next) assert(report.upcomingTrackPromoted);
  enforcePipelineThresholds(report);
  pipeline.stop();
  return report;
}

#ifdef _WIN32
ScenarioReport runControlledVst3Scenario() {
  Vst3BridgeConfig config;
  config.modulePath = "controlled-vst3-helper.vst3";
  config.classId = "0123456789ABCDEF0123456789ABCDEF";
  config.parametersJson = "{}";
  Vst3BridgeProcessor bridge(config);
  AudioFormat format;
  format.sampleRate = kSampleRate;
  format.channelCount = kChannels;
  format.bitDepth = 32;
  format.sampleFormat = AudioSampleFormat::Float32Interleaved;
  bridge.prepare(format);
  assert(bridge.isActive());

  const ProcessMemorySnapshot memoryBefore = processMemorySnapshot();
  const uint64_t callbacks = static_cast<uint64_t>(kLongScenarioAudioSeconds * kSampleRate) / kCallbackFrames;
  const uint64_t deadlineNs = (kCallbackFrames * 1000000000ULL) / kSampleRate;
  std::vector<float> samples(kCallbackFrames * kChannels, 0.1f);
  OutputInfo::RenderPerformanceSnapshot performance;
  performance.callbackCount = callbacks;
  performance.totalDeadlineNanoseconds = callbacks * deadlineNs;
  for (uint64_t index = 0; index < callbacks; ++index) {
    const auto started = std::chrono::steady_clock::now();
    bridge.process(samples.data(), kCallbackFrames);
    const uint64_t elapsed = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - started).count());
    performance.totalCallbackNanoseconds += elapsed;
    performance.peakCallbackNanoseconds = std::max(performance.peakCallbackNanoseconds, elapsed);
    if (elapsed > deadlineNs) ++performance.deadlineMissCount;
    if ((index % 16U) == 0U) std::this_thread::yield();
  }
  assert(bridge.isActive());
  assert(bridge.processCalls() >= callbacks);
  const ProcessMemorySnapshot memoryAfter = processMemorySnapshot();

  ScenarioReport report;
  report.name = "controlled-vst3-bridge";
  report.audioSeconds = kLongScenarioAudioSeconds;
  report.performance = performance;
  report.workingSetBeforeBytes = memoryBefore.workingSetBytes;
  report.workingSetAfterBytes = memoryAfter.workingSetBytes;
  report.peakWorkingSetBytes = memoryAfter.peakWorkingSetBytes;
  report.vst3ControlledHelper = true;
  assert(report.performance.deadlineMissCount == 0);
  assert(meanCallbackLoadPercent(report.performance) <= kPipelineMeanDeadlineLoadLimitPercent);
#ifdef _WIN32
  assert(report.workingSetBeforeBytes > 0);
  assert(report.workingSetAfterBytes > 0);
  assert(report.peakWorkingSetBytes >= report.workingSetAfterBytes);
#endif
  return report;
}
#endif

void writeJsonString(std::ostream& out, const std::string& value) {
  out << '"';
  for (const char character : value) {
    if (character == '"' || character == '\\') out << '\\';
    out << character;
  }
  out << '"';
}

void writeScenarioJson(std::ostream& out, const ScenarioReport& report, bool trailingComma) {
  out << "    {\"name\":";
  writeJsonString(out, report.name);
  out << ",\"execution\":";
  writeJsonString(out, report.execution);
  out << ",\"audioSeconds\":" << report.audioSeconds
      << ",\"vst3ControlledHelper\":" << (report.vst3ControlledHelper ? "true" : "false")
      << ",\"transition\":{\"upcomingTrackPromoted\":"
      << (report.upcomingTrackPromoted ? "true" : "false")
      << ",\"callbackPumpCount\":" << report.callbackPumpCount
      << ",\"callbackPumpAudioCount\":" << report.callbackPumpAudioCount << "}"
      << ",\"renderPerformance\":{\"callbackCount\":" << report.performance.callbackCount
      << ",\"meanCallbackMilliseconds\":" << meanCallbackMilliseconds(report.performance)
      << ",\"peakCallbackNanoseconds\":" << report.performance.peakCallbackNanoseconds
      << ",\"totalDeadlineNanoseconds\":" << report.performance.totalDeadlineNanoseconds
      << ",\"deadlineMissCount\":" << report.performance.deadlineMissCount
      << ",\"callbackDeadlineLoadPercent\":" << meanCallbackLoadPercent(report.performance)
      << "},\"diagnosticDelta\":{\"sessionUnderrunCount\":" << report.diagnostics.sessionUnderrunCount
      << ",\"sessionBufferDropCount\":" << report.diagnostics.sessionBufferDropCount
      << ",\"sessionRecoveryCount\":" << report.diagnostics.sessionRecoveryCount
      << ",\"deviceLostCount\":" << report.diagnostics.deviceLostCount
      << "},\"memory\":{\"workingSetBeforeBytes\":" << report.workingSetBeforeBytes
      << ",\"workingSetAfterBytes\":" << report.workingSetAfterBytes
      << ",\"peakWorkingSetBytes\":" << report.peakWorkingSetBytes << "}}";
  if (trailingComma) out << ',';
  out << '\n';
}

}  // namespace

namespace twilight::audio {

// Keep device discovery/provider selection on the same controlled route as
// the callback pump. Decoding, metadata, queue and engine clock remain real.
std::string defaultBackendId() { return "controlled-pump"; }
bool isOutputBackendAvailable(const std::string&) { return true; }
PcmOutputProviderStatus validatePcmOutputProviderForBackend(const std::string&, std::string*) {
  return PcmOutputProviderStatus::Ready;
}
std::string enumeratePlatformDevicesJson() { return "[]"; }

std::unique_ptr<IOutputBackend> createOutputBackend(const std::string&, std::string*) {
  return std::make_unique<ControlledPumpBackend>();
}

}  // namespace twilight::audio

int main(int argc, char** argv) {
  if (argc == 4 && std::string(argv[1]) == "--export-automix-windows") {
    std::ifstream input(std::filesystem::u8path(argv[2]), std::ios::binary);
    if (!input) return 2;
    const std::string json(std::istreambuf_iterator<char>{input}, {});
    auto merged = std::make_unique<ta_am_features>(); std::string error;
    if (!parseAutoMixWindows(json, "windows", "features", merged.get(), &error)) return 2;
    std::ofstream output(std::filesystem::u8path(argv[3]), std::ios::binary);
    output.write(reinterpret_cast<const char*>(merged.get()), sizeof(*merged));
    return output.good() ? 0 : 2;
  }
  verifyAutoMixWindowOwnership();
#ifndef TAE_HAS_FFMPEG
  std::cout << "audio-performance-gate skipped: FFmpeg support is not compiled\n";
  return 77;
#else
  ScopedPerformanceTestThreadPriority performanceTestThreadPriority;
  ScopedControlledBackendFactory controlledBackendFactory;
  if (argc == 2 && std::string(argv[1]) == "--verify-channel-layout")
    return verifyChannelLayout();
  if (argc == 2 && std::string(argv[1]) == "--verify-flac-tail")
    return verifyFlacTailContinuation();
  if (argc == 2 && std::string(argv[1]) == "--verify-automix-transport") {
    const auto root = std::filesystem::temp_directory_path() / "twilight-automix-transport";
    std::filesystem::create_directories(root);
    verifyAutoMixTransport(root);
    return 0;
  }
  if (argc == 2 && std::string(argv[1]) == "--verify-automix-minimum-phase") {
    const auto root = std::filesystem::temp_directory_path() / "twilight-automix-minimum-phase";
    std::filesystem::create_directories(root);
    verifyAutoMixTransport(root, DspResamplerPhase::MinimumSmooth);
    return 0;
  }
  if (argc == 3 && std::string(argv[1]) == "--verify-pcm")
    return verifyPcmTransparency(std::filesystem::u8path(argv[2]));
  if (argc == 2 && std::string(argv[1]) == "--verify-neutral-pcm") {
    const auto probeRoot = std::filesystem::temp_directory_path() / "twilight-neutral-pcm";
    std::filesystem::create_directories(probeRoot);
    const auto source = writePcmWav(probeRoot / "neutral.wav", 6, false, 997);
    const auto manifestPath = probeRoot / "manifest.json";
    std::ofstream manifest(manifestPath);
    manifest << "{\"source\":\"" << json_utils::escape(source.string())
             << "\",\"seconds\":5,\"volume\":0.54,\"graph\":{\"nodes\":["
                "{\"id\":\"meter\",\"type\":\"meter\",\"enabled\":true,\"params\":{}}],"
                "\"outputStage\":{\"resamplerQuality\":\"native\",\"dither\":\"off\",\"safetyClamp\":true}}}";
    manifest.close();
    const int result = verifyPcmTransparency(manifestPath);
    std::filesystem::remove(manifestPath);
    std::filesystem::remove(source);
    return result;
  }
  std::cout << std::fixed << std::setprecision(3);
  const std::filesystem::path fixtureRoot =
      std::filesystem::temp_directory_path() / "twilight-audio-performance-gate";
  std::error_code ignored;
  std::filesystem::remove_all(fixtureRoot, ignored);
  std::filesystem::create_directories(fixtureRoot);
  verifyTypedGaplessWithRealDecoder(fixtureRoot);
  verifyAutoMixTransport(fixtureRoot);
  verifyRoutedDeckReuse(fixtureRoot);

  const auto pcmLong = writePcmWav(fixtureRoot / "pcm-long.wav", kLongScenarioAudioSeconds + 4.0, false, 311.0);
  const auto gaplessA = writePcmWav(fixtureRoot / "gapless-a.wav", 8.0, false, 421.0);
  const auto gaplessB = writePcmWav(fixtureRoot / "gapless-b.wav", 8.0, false, 523.0);
  const auto crossfadeA = writePcmWav(fixtureRoot / "crossfade-a.wav", 8.0, false, 631.0);
  const auto crossfadeB = writePcmWav(fixtureRoot / "crossfade-b.wav", 8.0, false, 733.0);
  const auto shortIr = writePcmWav(fixtureRoot / "short-ir.wav", 0.030, true);
  const auto longIr = writePcmWav(fixtureRoot / "long-ir.wav", 1.000, true);

  std::vector<ScenarioReport> reports;
  reports.push_back(runPipelineScenario(
      "pcm-steady-180s",
      pcmLong,
      kLongScenarioAudioSeconds,
      "{\"dspEnabled\":true,\"fftEnabled\":false}"));
  reports.push_back(runPipelineScenario(
      "gapless-promote",
      gaplessA,
      12.0,
      "{\"dspEnabled\":true,\"gapless\":true,\"crossfadeSeconds\":0}",
      gaplessB));
  reports.push_back(runPipelineScenario(
      "crossfade-promote",
      crossfadeA,
      12.0,
      "{\"dspEnabled\":true,\"gapless\":true,\"crossfadeSeconds\":0.25,\"crossfadeContent\":\"all\"}",
      crossfadeB));
  reports.push_back(runPipelineScenario(
      "convolution-short-ir",
      pcmLong,
      30.0,
      "{\"dspEnabled\":true,\"convolverEnabled\":true}",
      std::nullopt,
      shortIr));
  reports.push_back(runPipelineScenario(
      "convolution-long-ir",
      pcmLong,
      30.0,
      "{\"dspEnabled\":true,\"convolverEnabled\":true}",
      std::nullopt,
      longIr));
#ifdef _WIN32
  reports.push_back(runControlledVst3Scenario());
#endif

  const ProcessMemorySnapshot memory = processMemorySnapshot();
  std::cout << "{\n"
            << "  \"schemaVersion\": 1,\n"
            << "  \"gate\": \"audio-performance\",\n"
            << "  \"execution\": \"controlled-pump\",\n"
            << "  \"hardwareClaim\": false,\n"
            << "  \"callbackMetric\": \"elapsed callback time divided by audio buffer deadline; not system CPU\",\n"
            << "  \"thresholds\": {\"meanCallbackDeadlineLoadPercentMax\": "
            << kPipelineMeanDeadlineLoadLimitPercent
            << ", \"deadlineMissCountMax\": " << kPipelineDeadlineMissLimit << "},\n"
            << "  \"processMemory\": {\"workingSetBytes\": " << memory.workingSetBytes
            << ", \"peakWorkingSetBytes\": " << memory.peakWorkingSetBytes << "},\n"
            << "  \"scenarios\": [\n";
  for (size_t index = 0; index < reports.size(); ++index) {
    writeScenarioJson(std::cout, reports[index], index + 1 < reports.size());
  }
  std::cout << "  ]\n}" << std::endl;

  std::filesystem::remove_all(fixtureRoot, ignored);
  return 0;
#endif
}
