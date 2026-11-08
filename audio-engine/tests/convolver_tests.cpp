#include "../dsp/ConvolverProcessor.h"
#include "../dsp/ConvolverRealtimeBudget.h"
#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <new>
#include <vector>
using namespace twilight::audio;

namespace {
// Track live C++ allocations, rather than RSS, which may keep freed heap pages.
struct alignas(std::max_align_t) AllocationHeader { size_t size; };
size_t liveAllocationBytes = 0;
}

void* operator new(size_t size) {
  auto* allocation = static_cast<AllocationHeader*>(std::malloc(sizeof(AllocationHeader) + (size ? size : 1)));
  if (!allocation) throw std::bad_alloc();
  allocation->size = size;
  liveAllocationBytes += size;
  return allocation + 1;
}
void* operator new[](size_t size) { return ::operator new(size); }
void operator delete(void* pointer) noexcept {
  if (!pointer) return;
  auto* allocation = static_cast<AllocationHeader*>(pointer) - 1;
  liveAllocationBytes -= allocation->size;
  std::free(allocation);
}
void operator delete[](void* pointer) noexcept { ::operator delete(pointer); }
void operator delete(void* pointer, size_t) noexcept { ::operator delete(pointer); }
void operator delete[](void* pointer, size_t) noexcept { ::operator delete(pointer); }

void writeImpulse(const std::filesystem::path& path, const std::vector<float>& impulse) {
  std::ofstream file(path, std::ios::binary);
  const auto u16 = [&](uint16_t value) { file.write(reinterpret_cast<const char*>(&value), 2); };
  const auto u32 = [&](uint32_t value) { file.write(reinterpret_cast<const char*>(&value), 4); };
  file.write("RIFF", 4); u32(36 + impulse.size() * 4); file.write("WAVEfmt ", 8);
  u32(16); u16(3); u16(1); u32(8000); u32(32000); u16(4); u16(32);
  file.write("data", 4); u32(impulse.size() * 4);
  file.write(reinterpret_cast<const char*>(impulse.data()), impulse.size() * 4);
}

std::vector<float> render(ConvolverProcessor& processor, const std::vector<float>& input, const std::vector<size_t>& chunks) {
  std::vector<float> output = input;
  size_t offset = 0, chunk = 0;
  while (offset < output.size()) {
    const size_t count = std::min(chunks[chunk++ % chunks.size()], output.size() - offset);
    processor.process(output.data() + offset, count);
    offset += count;
  }
  assert(processor.isActive());
  return output;
}

int main() {
  convolver::RealtimeBudget budget;
  assert(convolver::RealtimeBudget::milliseconds(256, 192000) < 256000.0 / 192000);
  for (size_t call = 0; call < 48; ++call) {
    const bool overrun = call % 16 == 15;
    assert(budget.observe(overrun, 256, 192000, 4096) == (call == 47));
  }
  budget.reset();
  assert(!budget.observe(true, 256, 48000, 64));
  for (size_t call = 0; call < 100; ++call) assert(!budget.observe(false, 256, 48000, 64));
  assert(!budget.observe(true, 256, 48000, 64));
  assert(!budget.observe(true, 256, 48000, 64));

  const auto path = std::filesystem::temp_directory_path() / "twilight-nonuniform-convolver-test.wav";
  // Dense early response plus impulses on both sides of every tier boundary,
  // and beyond the final tier's first partition (history wrap/overlap-add).
  std::vector<float> impulse(140000, 0.0f);
  for (size_t i = 0; i < 257; ++i) impulse[i] = static_cast<float>(0.01 * std::sin(i * .13));
  for (size_t i : {size_t(0), size_t(255), size_t(256), size_t(511), size_t(512), size_t(1023), size_t(1024), size_t(4095), size_t(4096), size_t(8191), size_t(8192), size_t(32767), size_t(32768), size_t(65535), size_t(65536), size_t(100003), size_t(131071), size_t(131072), size_t(139999)}) impulse[i] += .05f;
  writeImpulse(path, impulse);
  ConvolverProcessor processor;
  AudioFormat format; format.sampleRate = 8000; format.channelCount = 1;
  processor.prepare(format);
  DspConfig config; config.enabled = true; config.convolverEnabled = true;
  config.convolverPartitionSize = 64; config.convolverDry = 0; config.convolverWet = 1;
  processor.configure(config);
  std::string error;
  assert(processor.loadImpulseResponse(path.string(), &error));
  std::vector<float> input(impulse.size() + 71024, 0.0f);
  input[0] = .5f; input[137] = -.25f; input[600] = .1f; input[70000] = .2f;
  const auto result = render(processor, input, {1024});
  const auto latency = processor.info().latencyFrames;
  assert(latency == 64);
  for (size_t i = 0; i < result.size(); ++i) {
    double expected = 0;
    for (size_t offset : {size_t(0), size_t(137), size_t(600), size_t(70000)})
      if (i >= latency + offset && i - latency - offset < impulse.size()) expected += input[offset] * impulse[i - latency - offset];
    assert(std::abs(result[i] - expected) < .00002);
  }
  processor.reset();
  const auto fragmented = render(processor, input, {17, 127, 300, 63, 2048});
  for (size_t i = 0; i < result.size(); ++i) assert(std::abs(result[i] - fragmented[i]) < .00002);
  processor.reset();
  const auto silent = render(processor, std::vector<float>(input.size(), 0.0f), {1024});
  for (float value : silent) assert(std::abs(value) < .000001);
  processor.reset();
  // Reconfiguration outside this processor and same-format prepare must not
  // erase the pending convolution tail.
  std::vector<float> first(32, 0); first[0] = .5f;
  processor.process(first.data(), first.size());
  config.eqPreampDb = 3;
  processor.configure(config); processor.prepare(format);
  std::vector<float> tail(512, 0);
  processor.process(tail.data(), tail.size());
  assert(std::abs(tail[32] - .5f * impulse[0]) < .00002);
  // Clones share immutable preparation, but do not inherit runtime history.
  ConvolverProcessor clone; clone.configure(config); clone.prepare(format);
  assert(clone.loadImpulseResponse(path.string(), &error));
  const auto independent = render(clone, std::vector<float>(1024, 0), {17, 127});
  for (float value : independent) assert(std::abs(value) < .000001);
  // The Float32-only node's double bridge must not convert eight channels
  // when this prepared convolver has only one interleaved channel.
  constexpr size_t doubleFrames = 1024;
  constexpr double sentinel = 0.123456789012345;
  std::vector<double> doubleData(doubleFrames * 8 + 8, sentinel);
  std::vector<float> floatReference(doubleFrames, 0);
  floatReference[0] = .5f;
  for (size_t i = 0; i < doubleFrames; ++i) doubleData[i] = floatReference[i];
  clone.reset(); clone.process(floatReference.data(), doubleFrames);
  clone.reset(); clone.processDouble(doubleData.data(), doubleFrames);
  for (size_t i = 0; i < doubleFrames; ++i) assert(std::abs(doubleData[i] - floatReference[i]) < .00002);
  for (size_t i = doubleFrames; i < doubleData.size(); ++i) assert(doubleData[i] == sentinel);
  impulse[0] = .8f;
  writeImpulse(path, impulse);
  std::filesystem::last_write_time(path, std::filesystem::last_write_time(path) + std::chrono::seconds(1));
  assert(clone.loadImpulseResponse(path.string(), &error));
  std::vector<float> changed(512, 0); changed[0] = .5f;
  const auto reloaded = render(clone, changed, {64});
  assert(std::abs(reloaded[64] - .4f) < .00002);

  // Returning to the original format must release inactive resampled IRs.
  // The immutable preparation index may retain a few weak keys, not samples.
  const auto beforeRateChanges = liveAllocationBytes;
  for (int rate : {16000, 32000, 48000, 96000}) {
    auto nextFormat = format; nextFormat.sampleRate = rate;
    clone.prepare(nextFormat);
    assert(clone.isActive());
  }
  clone.prepare(format);
  const auto afterRateChanges = liveAllocationBytes;
  std::cout << "convolver retained bytes after rate cycle: "
            << static_cast<int64_t>(afterRateChanges) - static_cast<int64_t>(beforeRateChanges) << '\n';
  assert(afterRateChanges < beforeRateChanges + 64 * 1024);
  const auto returned = render(clone, changed, {64});
  for (size_t i = 0; i < returned.size(); ++i) assert(std::abs(returned[i] - reloaded[i]) < .00002);

  // A disabled node retains its source IR for re-enable; delay storage belongs
  // to the active configuration and must be released on disable and unload.
  auto highRate = format; highRate.sampleRate = 96000; highRate.channelCount = 8;
  clone.prepare(highRate);
  config.convolverEnabled = false;
  clone.configure(config);
  const auto beforeDelay = liveAllocationBytes;
  config.convolverEnabled = true;
  config.convolverDelayMs = 250;
  clone.configure(config);
  assert(clone.isActive());
  config.convolverEnabled = false;
  clone.configure(config);
  const auto disabledWithDelay = liveAllocationBytes;
  assert(disabledWithDelay < beforeDelay + 64 * 1024);
  config.convolverEnabled = true;
  clone.configure(config);
  assert(clone.isActive());
  clone.unloadImpulseResponse();
  const auto unloaded = liveAllocationBytes;
  assert(clone.loadImpulseResponse(path.string(), &error));
  assert(clone.isActive());
  clone.unloadImpulseResponse();
  assert(!clone.isActive());
  assert(liveAllocationBytes < unloaded + 64 * 1024);
  std::filesystem::remove(path);
  std::cout << "convolver reference, tier boundaries, fragmentation, reset and periodic budget tests passed\n";
}
