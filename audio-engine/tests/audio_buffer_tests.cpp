#include "../core/AudioBuffer.h"
#include "../core/AudioBufferResetUtils.h"
#include "../core/StreamBufferGate.h"

#include <array>
#include <atomic>
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <thread>
#include <vector>

using namespace twilight::audio;

namespace {

void testNetworkBufferHysteresisAndShortTail() {
  StreamBufferGate gate;
  gate.configure(48000, true);
  assert(gate.waiting());
  assert(!gate.allow(47999, 480, false));
  assert(gate.allow(48000, 480, false));
  assert(!gate.waiting());
  assert(gate.allow(480, 480, false));
  assert(!gate.allow(479, 480, false));
  assert(gate.waiting());
  // A single new packet/callback must not produce another short audible burst.
  assert(!gate.allow(48000, 480, false));
  assert(!gate.allow(143999, 480, false));
  assert(gate.allow(144000, 480, false));
  assert(!gate.waiting());
  assert(!gate.allow(0, 480, false));
  assert(gate.allow(123, 480, true));
  assert(!gate.waiting());
  gate.reset();
  assert(!gate.allow(47999, 480, false));
  assert(gate.allow(48000, 480, false));
  for (int rate : {8000, 44100, 96000, 192000, 768000}) {
    gate.configure(rate, true);
    assert(gate.prerollFrames(480) == static_cast<size_t>(rate));
    assert(gate.ready(rate, false));
    assert(!gate.ready(rate - 1, false));
    assert(gate.ready(1, true));
    assert(gate.allow(1, 480, true));
  }
  gate.configure(48000, false);
  assert(!gate.waiting());
  assert(gate.prerollFrames(480) == 480);
  assert(gate.ready(1, false));
  assert(gate.allow(1, 480, false));
  // High-rate/multichannel streams hit the PCM memory bound before three seconds.
  // Both thresholds must fit that bound, including oversized consumer requests.
  gate.configure(768000, true, 524288);
  assert(gate.prerollFrames(480) == 524288);
  assert(!gate.allow(524287, 480, false));
  assert(gate.allow(524288, 480, false));
  assert(!gate.allow(0, 480, false));
  assert(gate.allow(524288, 600000, false));
}

std::string readTextFile(const std::filesystem::path& path) {
  std::ifstream in(path, std::ios::binary);
  std::ostringstream buffer;
  buffer << in.rdbuf();
  return buffer.str();
}

std::string extractFunctionBody(const std::string& source, const std::string& signature) {
  const size_t signaturePos = source.find(signature);
  assert(signaturePos != std::string::npos);
  const size_t bodyStart = source.find('{', signaturePos);
  assert(bodyStart != std::string::npos);
  int depth = 0;
  for (size_t i = bodyStart; i < source.size(); ++i) {
    if (source[i] == '{') {
      ++depth;
    } else if (source[i] == '}') {
      --depth;
      if (depth == 0) return source.substr(bodyStart, i - bodyStart + 1);
    }
  }
  assert(false);
  return {};
}

void testAudioBufferRenderReadsUseSpscAtomicsWithoutMutexFallback() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioBuffer.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string readFloatBody = extractFunctionBody(source, "size_t AudioBuffer::read(float* data, size_t frames)");
  const std::string readBlockBody = extractFunctionBody(source, "size_t AudioBuffer::read(PcmBlock& block)");
  const std::string readFramesBody = extractFunctionBody(source, "size_t AudioBuffer::readFrames(PcmBlock& block, size_t targetBytesPerFrame)");

  const std::string realtimeBodies = readFloatBody + readBlockBody + readFramesBody;
  assert(realtimeBodies.find("std::try_to_lock") == std::string::npos);
  assert(realtimeBodies.find("std::lock_guard") == std::string::npos);
  assert(realtimeBodies.find("std::unique_lock") == std::string::npos);
  assert(readFramesBody.find("readPosition_.load") != std::string::npos);
  assert(readFramesBody.find("writePosition_.load") != std::string::npos);
  assert(readFramesBody.find("readPosition_.store") != std::string::npos);
  assert(readBlockBody.find("tryBeginRead()") != std::string::npos);
  assert(readBlockBody.find("endRead()") != std::string::npos);
  assert(readBlockBody.find("producerWakeEpoch_.fetch_add") != std::string::npos);
  assert(readBlockBody.find("producerWakeEpoch_.notify_one") != std::string::npos);
}

void testProducerWaitUsesAtomicEpochWithoutLostWake() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioBuffer.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string writeBody = extractFunctionBody(
      source,
      "size_t AudioBuffer::writeBlocking(const PcmBlock& block, const std::atomic<bool>& running)");

  assert(writeBody.find("producerWakeEpoch_.wait") != std::string::npos);
  assert(writeBody.find("notFull_.wait") == std::string::npos);
  assert(writeBody.find("std::unique_lock") == std::string::npos);
}

void testControlResetGateAtomicallyExcludesNewReaders() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "core" / "AudioBuffer.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string beginReadBody = extractFunctionBody(source, "bool AudioBuffer::tryBeginRead() noexcept");
  const std::string beginResetBody = extractFunctionBody(source, "void AudioBuffer::beginControlReset()");

  assert(beginReadBody.find("readerState_.compare_exchange_weak") != std::string::npos);
  assert(beginReadBody.find("kControlResetBit") != std::string::npos);
  assert(beginResetBody.find("readerState_.compare_exchange_weak") != std::string::npos);
  assert(beginResetBody.find("kControlResetBit") != std::string::npos);
}

void testSpscProducerConsumerDoesNotDropPublishedFrames() {
  constexpr size_t frameCount = 200000;
  AudioBuffer buffer;
  buffer.reset(2, 257);
  std::atomic<bool> running{true};
  std::atomic<bool> producerDone{false};

  std::thread producer([&] {
    std::array<float, 62> chunk{};
    size_t produced = 0;
    while (produced < frameCount) {
      const size_t frames = std::min<size_t>(31, frameCount - produced);
      for (size_t frame = 0; frame < frames; ++frame) {
        const float value = static_cast<float>(produced + frame + 1);
        chunk[frame * 2] = value;
        chunk[frame * 2 + 1] = -value;
      }
      const size_t written = buffer.writeBlocking(chunk.data(), frames, running);
      assert(written == frames);
      produced += written;
    }
    producerDone.store(true, std::memory_order_release);
  });

  std::array<float, 34> output{};
  size_t consumed = 0;
  while (consumed < frameCount) {
    const size_t frames = std::min<size_t>(17, frameCount - consumed);
    const size_t read = buffer.read(output.data(), frames);
    if (read == 0) {
      assert(!producerDone.load(std::memory_order_acquire) || buffer.availableFrames() > 0);
      std::this_thread::yield();
      continue;
    }
    for (size_t frame = 0; frame < read; ++frame) {
      const float expected = static_cast<float>(consumed + frame + 1);
      assert(output[frame * 2] == expected);
      assert(output[frame * 2 + 1] == -expected);
    }
    consumed += read;
  }

  running.store(false, std::memory_order_release);
  buffer.notifyAll();
  producer.join();
  assert(buffer.availableFrames() == 0);
}

void testResetMakesOldFramesUnreadableAndEmptyReadsSilent() {
  AudioBuffer buffer;
  buffer.reset(2, 4);

  std::atomic<bool> running{true};
  const std::array<float, 4> input{0.25f, -0.25f, 0.5f, -0.5f};
  assert(buffer.writeBlocking(input.data(), 2, running) == 2);
  assert(buffer.availableFrames() == 2);

  buffer.reset(2, 4);

  std::array<float, 4> output{9.0f, 9.0f, 9.0f, 9.0f};
  assert(buffer.read(output.data(), 2) == 0);
  for (float sample : output) {
    assert(sample == 0.0f);
  }
}

void testReadPcmBlockCapsFramesToByteSize() {
  AudioBuffer buffer;
  buffer.reset(2, 4);

  std::atomic<bool> running{true};
  const std::array<float, 4> input{0.25f, -0.25f, 0.5f, -0.5f};
  assert(buffer.writeBlocking(input.data(), 2, running) == 2);

  std::array<uint8_t, 16> output{};
  output.fill(0xee);
  PcmBlock block;
  block.format = buffer.format();
  block.data = output.data();
  block.frames = 2;
  block.byteSize = sizeof(float) * 2;

  assert(buffer.read(block) == 1);
  assert(buffer.availableFrames() == 1);
  assert(reinterpret_cast<float*>(output.data())[0] == 0.25f);
  assert(reinterpret_cast<float*>(output.data())[1] == -0.25f);
  for (size_t index = block.byteSize; index < output.size(); ++index) {
    assert(output[index] == 0xee);
  }
}

void testWritePcmBlockCapsFramesToByteSize() {
  AudioBuffer buffer;
  buffer.reset(2, 4);

  std::atomic<bool> running{true};
  std::array<float, 4> input{0.25f, -0.25f, 99.0f, 99.0f};
  PcmBlock block;
  block.format = buffer.format();
  block.data = reinterpret_cast<uint8_t*>(input.data());
  block.frames = 2;
  block.byteSize = sizeof(float) * 2;

  assert(buffer.writeBlocking(block, running) == 1);
  assert(buffer.availableFrames() == 1);

  std::array<float, 4> output{0.0f, 0.0f, 0.0f, 0.0f};
  assert(buffer.read(output.data(), 2) == 1);
  assert(output[0] == 0.25f);
  assert(output[1] == -0.25f);
  assert(output[2] == 0.0f);
  assert(output[3] == 0.0f);
}

void testResetStorageResizeDoesNotRewriteSameSizedStorage() {
  std::vector<uint8_t> storage{0x11, 0x22, 0x33, 0x44};
  const uint8_t* before = storage.data();

  resetStorageForAudioBuffer(storage, storage.size());

  assert(storage.data() == before);
  assert((storage == std::vector<uint8_t>{0x11, 0x22, 0x33, 0x44}));
}

void testResetStorageResizeShrinksWithoutClearingPrefix() {
  std::vector<uint8_t> storage{0x10, 0x20, 0x30, 0x40};

  resetStorageForAudioBuffer(storage, 2);

  assert((storage == std::vector<uint8_t>{0x10, 0x20}));
}

void testPcmSpeakerLayoutSurvivesTheRingBuffer() {
  AudioFormat format{48000, 3, 32}; format.channelMask = 7;
  AudioBuffer buffer; buffer.reset(format, 4);
  assert(buffer.format().channelMask == 7);
  std::atomic<bool> running{true};
  std::array<float, 3> input{.0125f, -.025f, .05f}, output{};
  AudioFormat other = format; other.channelMask = 0xb;
  PcmBlock source{other, reinterpret_cast<uint8_t*>(input.data()), 1, sizeof(input)};
  assert(buffer.writeBlocking(source, running) == 0 && buffer.availableFrames() == 0);
  source.format = format;
  assert(buffer.writeBlocking(source, running) == 1);
  PcmBlock target{other, reinterpret_cast<uint8_t*>(output.data()), 1, sizeof(output)};
  assert(buffer.read(target) == 0 && buffer.availableFrames() == 1);
  // Original count-only callers still use the buffer without a new prerequisite.
  target.format.channelMask = 0;
  assert(buffer.read(target) == 1 && output == input);
  buffer.clear();
  assert(buffer.format().channelMask == 7);
  buffer.reset(3, 4);
  assert(buffer.format().channelMask == 0);
}

}  // namespace

int main() {
  testNetworkBufferHysteresisAndShortTail();
  testAudioBufferRenderReadsUseSpscAtomicsWithoutMutexFallback();
  testProducerWaitUsesAtomicEpochWithoutLostWake();
  testControlResetGateAtomicallyExcludesNewReaders();
  testSpscProducerConsumerDoesNotDropPublishedFrames();
  testResetMakesOldFramesUnreadableAndEmptyReadsSilent();
  testReadPcmBlockCapsFramesToByteSize();
  testWritePcmBlockCapsFramesToByteSize();
  testResetStorageResizeDoesNotRewriteSameSizedStorage();
  testResetStorageResizeShrinksWithoutClearingPrefix();
  testPcmSpeakerLayoutSurvivesTheRingBuffer();
  return 0;
}
