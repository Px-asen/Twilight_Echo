#include "output/asio/windows/AsioDriverCompatibility.h"
#include "output/asio/windows/AsioDriverSession.h"
#include "output/asio/AsioDsdBufferGeometry.h"

#include <array>
#include <cassert>
#include <cstring>
#include <iostream>
#include <memory>
#include <tuple>

using namespace twilight::audio;
using namespace twilight::audio::asio_abi;
using namespace twilight::audio::asio_windows;

namespace {
struct Behavior {
  double rate = 48000;
  double pendingRate = 0;
  int delayedReads = 0;
  int delayOnSet = 0;
  bool getterFails = false;
  bool requiresPivot = false;
  bool pivoted = false;
  bool createRequiresPivot = false;
  bool requiresDuplex = false;
  bool typesOnlyAfterCreate = false;
  bool wrongRateOnCreate = false;
  bool failPostChannels = false;
  bool changeRangeOnFailure = false;
  bool scaledDsdBuffers = false;
  bool restoreFormatFails = false;
  bool restoreRateIgnored = false;
  bool dirty = false;
  bool created = false;
  bool cleanupMissing = false;
  int32_t ioMode = kAsioIoFormatPcm;
  int32_t type = kAsioSampleFloat32Lsb;
  int32_t minSize = 0;
  int32_t preferredSize = 0;
  int32_t acceptedSize = 512;
  int32_t inputs = 2;
  int32_t outputs = 2;
  int32_t expectedChannelStart = 0;
  bool channelNumbersWrong = false;
  int channelQueries = 0, sets = 0, disposes = 0, starts = 0, releases = 0;
  bool windowValid = false;
  std::vector<std::tuple<int32_t, int32_t>> attempts;
  std::vector<std::vector<uint8_t>> storage;
};

class Driver final : public AsioDriver {
 public:
  explicit Driver(std::shared_ptr<Behavior> behavior) : b(std::move(behavior)) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void**) override { return E_NOINTERFACE; }
  ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
  ULONG STDMETHODCALLTYPE Release() override { ++b->releases; delete this; return 0; }
  AsioBool init(void* reference) override {
    const HWND window = static_cast<HWND>(reference);
    b->windowValid = IsWindow(window) && GetAncestor(window, GA_ROOT) == window &&
        GetParent(window) != HWND_MESSAGE && !IsWindowVisible(window);
    return b->windowValid;
  }
  void getDriverName(char* name) override { std::strcpy(name, "Compatibility fixture"); }
  int32_t getDriverVersion() override { return 1; }
  void getErrorMessage(char* message) override { std::strcpy(message, "fixture refusal"); }
  AsioError start() override { ++b->starts; return b->created ? kAsioSuccess : -1; }
  AsioError stop() override { return kAsioOk; }
  AsioError getChannels(int32_t* inputs, int32_t* outputs) override {
    if (++b->channelQueries > 1 && b->failPostChannels) return -1;
    *inputs = b->inputs; *outputs = b->outputs; return kAsioOk;
  }
  AsioError getLatencies(int32_t* input, int32_t* output) override {
    *input = 0; *output = b->created ? 777 : 0; return kAsioOk;
  }
  AsioError getBufferSize(int32_t* min, int32_t* max, int32_t* preferred, int32_t* granularity) override {
    const bool dsd = b->ioMode == kAsioIoFormatDsd;
    if (b->scaledDsdBuffers) {
      const int32_t scale = dsd ? static_cast<int32_t>(b->rate / 44100) : 1;
      *min = 8 * scale; *max = 2048 * scale;
      *preferred = b->preferredSize * scale; *granularity = -1;
      return kAsioOk;
    }
    *min = b->minSize > 0 ? b->minSize : (dsd ? 1024 : 64);
    *max = dsd ? 8192 : 4096;
    *preferred = b->preferredSize > 0
        ? b->preferredSize
        : (b->changeRangeOnFailure && !b->attempts.empty() ? 3072 : dsd ? 2048 : 512);
    *granularity = b->changeRangeOnFailure ? 0 : -1;
    return kAsioOk;
  }
  AsioError canSampleRate(double rate) override { return rate > 0 ? kAsioSuccess : -1; }
  AsioError getSampleRate(double* rate) override {
    if (b->getterFails) return -1;
    if (b->delayedReads > 0 && --b->delayedReads == 0) b->rate = b->pendingRate;
    *rate = b->rate; return kAsioOk;
  }
  AsioError setSampleRate(double rate) override {
    ++b->sets;
    if (b->restoreRateIgnored && rate == 48000) return kAsioOk;
    if (rate == 44100) b->pivoted = true;
    if (b->requiresPivot && rate == 96000 && !b->pivoted) return kAsioOk;
    b->pendingRate = rate;
    b->delayedReads = b->delayOnSet;
    if (!b->delayedReads) b->rate = rate;
    return kAsioSuccess;
  }
  AsioError getClockSources(AsioClockSource*, int32_t*) override { return -1; }
  AsioError setClockSource(int32_t) override { return -1; }
  AsioError getSamplePosition(AsioSamples*, AsioTimeStamp*) override { return -1; }
  AsioError getChannelInfo(AsioChannelInfo* info) override {
    if (b->typesOnlyAfterCreate && !b->created) return -1;
    info->type = b->ioMode == kAsioIoFormatDsd ? kAsioSampleDsdInt8Lsb1 : b->type;
    return kAsioSuccess;
  }
  AsioError createBuffers(AsioBufferInfo* buffers, int32_t count, int32_t frames, AsioCallbacks*) override {
    if (b->dirty) b->cleanupMissing = true;
    b->dirty = true;
    int32_t inputs = 0;
    for (int32_t i = 0; i < count; ++i) if (buffers[i].isInput) ++inputs;
    for (int32_t i = inputs; i < count; ++i)
      if (buffers[i].channelNum != b->expectedChannelStart + i - inputs) b->channelNumbersWrong = true;
    b->attempts.emplace_back(frames, inputs);
    // A failed create still owns a partial allocation: callers must dispose it.
    b->storage.assign(count * 2, std::vector<uint8_t>(frames * 8, 0xcd));
    if ((!b->scaledDsdBuffers && frames != b->acceptedSize) || (b->requiresDuplex && inputs != b->inputs) ||
        (b->createRequiresPivot && !b->pivoted)) return -995;
    if (b->scaledDsdBuffers) {
      const int32_t scale = b->ioMode == kAsioIoFormatDsd ? static_cast<int32_t>(b->rate / 44100) : 1;
      b->preferredSize = frames / scale;
    }
    for (int32_t i = 0; i < count; ++i) for (int j = 0; j < 2; ++j) buffers[i].buffers[j] = b->storage[i * 2 + j].data();
    b->created = true;
    if (b->wrongRateOnCreate) b->rate = 44100;
    return kAsioSuccess;
  }
  AsioError disposeBuffers() override { ++b->disposes; b->dirty = b->created = false; b->storage.clear(); return kAsioOk; }
  AsioError controlPanel() override { return kAsioOk; }
  AsioError future(int32_t selector, void* option) override {
    auto* format = static_cast<AsioIoFormat*>(option);
    if (selector == kFutureGetIoFormat) format->formatType = b->ioMode;
    else if (selector == kFutureSetIoFormat) {
      if (b->restoreFormatFails && format->formatType == kAsioIoFormatPcm) return -1;
      b->ioMode = format->formatType;
    }
    return kAsioSuccess;
  }
  AsioError outputReady() override { return kAsioSuccess; }
 private:
  std::shared_ptr<Behavior> b;
};

AsioOpenConfig config(int rate = 48000, AudioSampleFormat type = AudioSampleFormat::Float32Interleaved) {
  AsioOpenConfig c;
  c.format.sampleRate = rate; c.format.channelCount = 2; c.format.sampleFormat = type;
  c.bufferSizeFrames = 128;
  return c;
}

void runSession(const std::shared_ptr<Behavior>& b, AsioOpenConfig c, bool expectedCreate = true) {
  auto control = std::make_shared<AsioControlThread>();
  AsioDriverSession session({.clsid = "{00000000-0000-0000-0000-000000000000}"}, control,
      [b] { return new Driver(b); });
  AsioOpenResult result;
  std::string error;
  assert(session.open(c, &result, &error));
  assert(b->windowValid);
  assert(session.createBuffers([](long) {}, {}, &error) == expectedCreate);
  if (expectedCreate) {
    assert(session.activeBufferSize() == b->acceptedSize);
    assert(session.activeSampleRate() == c.format.sampleRate);
    assert(session.activeLatencyFrames() == 777);
    assert(session.outputBuffer(0, 0) != nullptr);
    assert(session.outputChannelFormat(0).containerBits == (b->ioMode == kAsioIoFormatDsd ? 8 : channelFormatFor(b->type)->containerBits));
    assert(session.start(&error));
    session.stop();
  } else {
    assert(!session.start(&error));
    assert(!b->created);
  }
  assert(!b->cleanupMissing);
  assert(!b->channelNumbersWrong);
  session.close();
  assert(!b->dirty && b->releases == 1);
}

void testLifecycle() {
  auto normal = std::make_shared<Behavior>();
  normal->typesOnlyAfterCreate = true;
  normal->type = kAsioSampleFloat64Msb;
  runSession(normal, config());
  assert(normal->sets == 0); // Redundant rate writes disturb some drivers.
  assert(normal->disposes > 1);

  auto delayed = std::make_shared<Behavior>();
  delayed->delayOnSet = 5;
  runSession(delayed, config(96000));
  assert(delayed->rate == 96000);

  auto duplex = std::make_shared<Behavior>();
  duplex->requiresDuplex = duplex->failPostChannels = true;
  runSession(duplex, config());
  assert(std::get<1>(duplex->attempts.back()) == 2);

  auto range = std::make_shared<Behavior>();
  range->changeRangeOnFailure = true;
  range->acceptedSize = 3072;
  runSession(range, config());

  auto clock = std::make_shared<Behavior>();
  clock->requiresPivot = true;
  runSession(clock, config(96000));
  assert(clock->pivoted);

  auto bufferClock = std::make_shared<Behavior>();
  bufferClock->createRequiresPivot = true;
  runSession(bufferClock, config());
  assert(bufferClock->pivoted);

  auto wrongRate = std::make_shared<Behavior>();
  wrongRate->wrongRateOnCreate = true;
  runSession(wrongRate, config(), false);
  assert(wrongRate->starts == 0);

  auto unknownType = std::make_shared<Behavior>();
  unknownType->type = 99;
  runSession(unknownType, config(), false);
  assert(unknownType->starts == 0);

  auto dsd = std::make_shared<Behavior>();
  dsd->ioMode = kAsioIoFormatDsd; dsd->rate = 2822400; dsd->acceptedSize = 2048;
  runSession(dsd, config(2822400, AudioSampleFormat::DsdInt8Lsb1));
  assert(dsd->ioMode == kAsioIoFormatDsd && dsd->rate == 2822400);

  auto routed = std::make_shared<Behavior>();
  routed->outputs = 8; routed->expectedChannelStart = 4; routed->requiresDuplex = true;
  auto routingConfig = config(); routingConfig.outputChannelStart = 4;
  runSession(routed, routingConfig);

  auto tinyPreferred = std::make_shared<Behavior>();
  tinyPreferred->minSize = 8;
  tinyPreferred->preferredSize = 16;
  tinyPreferred->acceptedSize = 256;
  auto tinyConfig = config(96000);
  tinyConfig.bufferSizeFrames = 16;
  runSession(tinyPreferred, tinyConfig);
  assert(!tinyPreferred->attempts.empty());
  for (const auto& [size, inputs] : tinyPreferred->attempts) {
    (void)inputs;
    assert(size >= 256);
  }
}

void testDriverDsdGeometry() {
  asio::DsdBufferGeometry geometry;
  // N=3528 at DSD64 gives exactly 10ms byte-frame or 1.25ms bit cadence.
  geometry.reset(3528, 2822400, false, 2);
  geometry.observe(10000000); geometry.observe(20000000);
  assert(geometry.capacity() == 441 && !geometry.confirmed());
  geometry.observe(30000000);
  geometry.observe(60000000); // A gap breaks the consecutive evidence.
  geometry.observe(70000000);
  assert(geometry.capacity() == 441 && !geometry.confirmed());
  geometry.observe(80000000);
  assert(geometry.capacity() == 3528 && geometry.confirmed());

  geometry.reset(3528, 2822400, false, 2);
  for (uint64_t i = 1; i <= 4; ++i) geometry.observe(i * 1250000);
  assert(geometry.capacity() == 441 && geometry.confirmed());
  geometry.reset(3528, 2822400, false, 2);
  geometry.observe(10000000); geometry.observe(20000000); geometry.observe(30000000);
  geometry.observe(29000000); geometry.observe(39000000);
  assert(!geometry.confirmed());

  geometry.reset(3528, 2822400, true, 2);
  for (uint64_t i = 1; i < 20; ++i) geometry.observe(i * 10000000);
  assert(geometry.capacity() == 441); // Expanded NER8 never uses packed N.
  const auto format = *channelFormatFor(kAsioSampleDsdInt8Ner8);
  std::array<uint8_t, 17> output; output.fill(0xa5);
  const uint8_t packed[]{0x81, 0x69};
  asio::writeInterleavedTypedChannelToPlanar(packed, 2, 1, 0, format, output.data());
  for (size_t i = 0; i < 16; ++i) assert(output[i] == ((packed[i / 8] >> (i % 8)) & 1));
  assert(output[16] == 0xa5 && asio::wireBytesForFrames(format, 2) == 16);

  // Large bit-sample buffers fit as packed bytes; the same count interpreted
  // as byte frames must fail explicitly when it exceeds transport capacity.
  geometry.reset(524288, 11289600, false, 2, 262144);
  for (uint64_t i = 1; i <= 5; ++i) geometry.observe(i * 46439909);
  assert(geometry.confirmed() && !geometry.exceedsCapacity() && geometry.capacity() == 65536);
  geometry.reset(524288, 11289600, false, 2, 262144);
  for (uint64_t i = 1; i <= 5; ++i) geometry.observe(i * 371519274);
  assert(geometry.exceedsCapacity() && geometry.capacity() == 65536);
  geometry.reset(524288, 11289600, true, 2, 32768);
  assert(geometry.exceedsCapacity());
}

void testNativeDsdPreservesPcmBufferPreference() {
  auto b = std::make_shared<Behavior>();
  b->scaledDsdBuffers = true;
  b->preferredSize = 1024;
  auto control = std::make_shared<AsioControlThread>();
  AsioDriverSession session({.clsid = "{00000000-0000-0000-0000-000000000000}"}, control,
      [b] { return new Driver(b); });
  for (const auto [rate, preference] : {std::pair{11289600, 1024}, {2822400, 256},
                                      {11289600, 2048}, {11289600, 32768}, {11289600, 1024}}) {
    auto c = config(rate, AudioSampleFormat::DsdInt8Lsb1);
    c.bufferSizeFrames = preference;
    c.bufferSizeInPcmFrames = true;
    AsioOpenResult result;
    std::string error;
    assert(session.open(c, &result, &error));
    assert(session.createBuffers([](long) {}, {}, &error));
    const int legalPreference = std::min(preference, 2048);
    assert(session.activeBufferSize() == legalPreference * (rate / 44100));
    assert(b->preferredSize == legalPreference);
    session.close();
    assert(session.lastCloseError().empty());
    assert(b->ioMode == kAsioIoFormatPcm && b->rate == 48000);
    assert(b->preferredSize == legalPreference);
  }
  // Direct host clients may still request raw DSD counts explicitly.
  auto raw = config(11289600, AudioSampleFormat::DsdInt8Lsb1);
  raw.bufferSizeFrames = 2048;
  AsioOpenResult result;
  std::string error;
  assert(session.open(raw, &result, &error));
  assert(session.createBuffers([](long) {}, {}, &error));
  assert(session.activeBufferSize() == 2048);
  session.close();

  // A driver whose PCM and DSD ranges do not scale uniformly retains its
  // original driver-count selection even when the UI preference flag is set.
  auto unscaled = std::make_shared<Behavior>();
  unscaled->acceptedSize = 2048;
  auto c = config(11289600, AudioSampleFormat::DsdInt8Lsb1);
  c.bufferSizeFrames = 2048;
  c.bufferSizeInPcmFrames = true;
  runSession(unscaled, c);
}

void testRestoreFailureRemainsVisible() {
  for (bool failFormat : {false, true}) {
    auto b = std::make_shared<Behavior>();
    b->acceptedSize = 2048;
    auto control = std::make_shared<AsioControlThread>();
    AsioDriverSession session({.clsid = "{00000000-0000-0000-0000-000000000000}"}, control,
        [b] { return new Driver(b); });
    const auto c = config(2822400, AudioSampleFormat::DsdInt8Lsb1);
    AsioOpenResult result;
    std::string error;
    assert(session.open(c, &result, &error));
    assert(session.createBuffers([](long) {}, {}, &error));
    assert(session.start(&error));
    session.stop();
    b->restoreFormatFails = failFormat;
    b->restoreRateIgnored = !failFormat;
    session.close();
    const auto failure = session.lastCloseError();
    assert(failure.find(failFormat ? "I/O format" : "sample rate") != std::string::npos);
    assert(!b->dirty && b->releases == 1);
    const int sets = b->sets;
    session.close();
    assert(session.lastCloseError() == failure && b->sets == sets && b->releases == 1);
    assert(!session.open(c, &result, &error));
    assert(error == failure && result.failureKind == AsioOpenFailureKind::Driver);
    assert(b->releases == 1);
  }
}

void testStrictReadbackAndDeadline() {
  auto b = std::make_shared<Behavior>();
  Driver driver(b);
  AsioRateNegotiator negotiation(driver, {}, std::chrono::milliseconds(25));
  double observed = 0;
  b->getterFails = true;
  assert(!negotiation.select(48000, &observed, std::chrono::steady_clock::now() + std::chrono::milliseconds(30)));
  assert(observed == 0);
  const int sets = b->sets;
  assert(!negotiation.select(96000, &observed, std::chrono::steady_clock::now()));
  assert(b->sets == sets);
  b->getterFails = false;
  for (double invalid : {0.0, -1.0, 48000.5, std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()}) {
    b->rate = invalid; assert(!negotiation.read(&observed));
  }
}

void testLegalCandidates() {
  const AsioBufferRange pcm{8, 2048, 1024, -1};
  assert(nativeDsdBufferScale(pcm, {2048, 524288, 262144, -1}) == 256);
  assert(nativeDsdBufferScale(pcm, pcm) == 1);
  assert(nativeDsdBufferScale(pcm, {2048, 32768, 262144, -1}) == 1);
  assert(nativeDsdBufferScale(pcm, {2048, 524288, 131072, -1}) == 1);
  assert(nativeDsdBufferScale({}, {2048, 524288, 262144, -1}) == 1);
  assert(nativeDsdBufferScale(pcm, {2048, 524288, 262144, 64}) == 1);
  const auto dsd = bufferSizeCandidates({2048, 524288, 262144, -1}, 262144, 0,
                                         asio::kMaximumDsdBufferSamples);
  assert(!dsd.empty() && dsd.front() == 262144);
  assert(bufferSizeCandidates({0, 1024, 512, -1}, 256).empty());
  assert(bufferSizeCandidates({65536, 131072, 65536, -1}, 256).empty());
  for (const AsioBufferRange r : {AsioBufferRange{64, 8192, 512, -1}, {128, 3000, 1000, 192},
                                {1, INT32_MAX, 1024, INT32_MAX}, {100, 4000, 512, 0}}) {
    const auto candidates = bufferSizeCandidates(r, 777, 256);
    for (size_t i = 0; i < candidates.size(); ++i) {
      assert(r.accepts(candidates[i]) && candidates[i] >= 256);
      assert(std::count(candidates.begin(), candidates.end(), candidates[i]) == 1);
    }
  }
  const auto powers = bufferSizeCandidates({64, 32768, 512, -1}, 700);
  assert(powers.front() == 512);
  assert(std::find(powers.begin(), powers.end(), 32768) != powers.end());
  const auto halved = bufferSizeCandidates({8, 2048, 16, -1}, 256, 256);
  assert(!halved.empty() && halved.front() == 256);
  for (int32_t candidate : halved) assert(candidate >= 256);
}

uint64_t decode(const uint8_t* data, size_t bytes, bool littleEndian) {
  uint64_t result = 0;
  for (size_t byte = 0; byte < bytes; ++byte) result |= uint64_t{data[byte]} << (8 * (littleEndian ? byte : bytes - 1 - byte));
  return result;
}

void testAllPcmWireTypes() {
  for (int32_t type : {0, 1, 2, 3, 4, 8, 9, 10, 11, 16, 17, 18, 19, 20, 24, 25, 26, 27}) {
    const auto f = channelFormatFor(type);
    assert(f && asio::isSupportedChannelFormat(*f));
    const size_t bytes = asio::bytesPerSample(*f);
    std::array<uint8_t, 48> output; output.fill(0xa5);
    const float samples[]{-1, 0, 0.5f, 1};
    asio::writePackedChannelFromFloatScratch(samples, 4, 1, 0, ChannelRoutingMode::Auto, *f, output.data());
    for (size_t i = 0; i < 4; ++i) {
      const uint64_t bits = decode(output.data() + i * bytes, bytes, f->littleEndian);
      if (f->logicalFormat == AudioSampleFormat::Float32Interleaved) {
        if (bytes == 8) { double value = 0; std::memcpy(&value, &bits, 8); assert(value == samples[i]); }
        else { const uint32_t low = static_cast<uint32_t>(bits); float value = 0; std::memcpy(&value, &low, 4); assert(value == samples[i]); }
      } else {
        const int64_t peak = int64_t{1} << (f->validBits - 1);
        const int64_t expected = i == 0 ? -peak : i == 1 ? 0 : i == 2 ? peak / 2 : peak - 1;
        const uint64_t mask = (uint64_t{1} << (bytes * 8)) - 1;
        assert(bits == (static_cast<uint64_t>(expected) & mask));
      }
    }
    assert(output[bytes * 4] == 0xa5);
    // Typed integer data must retain low-order detail and sign extension.
    std::array<uint8_t, 4> source{};
    const uint32_t value = f->logicalFormat == AudioSampleFormat::Int24In32Interleaved ? 0xffedcb00u : 0xffedcba9u;
    std::memcpy(source.data(), &value, 4);
    if (f->logicalFormat == AudioSampleFormat::Float32Interleaved) std::memcpy(source.data(), &samples[2], 4);
    asio::writeInterleavedTypedChannelToPlanar(source.data(), 1, 1, 0, *f, output.data());
    if (f->logicalFormat != AudioSampleFormat::Float32Interleaved) {
      const int32_t expected = f->containerBits == 32 && f->validBits < 32
          ? static_cast<int32_t>(value) >> (32 - f->validBits) : static_cast<int32_t>(value);
      const uint64_t mask = (uint64_t{1} << (bytes * 8)) - 1;
      assert(decode(output.data(), bytes, f->littleEndian) == (static_cast<uint32_t>(expected) & mask));
    } else if (bytes == 8) {
      const uint64_t bits = decode(output.data(), bytes, f->littleEndian);
      double sample = 0; std::memcpy(&sample, &bits, 8); assert(sample == 0.5);
    }
  }
}
}  // namespace

int main() {
  testStrictReadbackAndDeadline(); testLegalCandidates(); testAllPcmWireTypes(); testDriverDsdGeometry(); testLifecycle();
  testRestoreFailureRemainsVisible();
  testNativeDsdPreservesPcmBufferPreference();
  std::cout << "ASIO driver compatibility behavior passed\n";
}
