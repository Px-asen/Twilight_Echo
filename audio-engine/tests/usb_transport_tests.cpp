#include "../output/usb/UsbPacketScheduler.h"
#include "../output/usb/UsbPcmRender.h"
#include "../output/usb/UsbDsdRender.h"
#include "../output/usb/UsbImplicitFeedback.h"

#include <array>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

using namespace twilight::audio;
namespace {
void check(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }

void pacing() {
  for (auto speed : {UsbBusSpeed::Full, UsbBusSpeed::High}) {
    const int ticks = speed == UsbBusSpeed::Full ? 1000 : 8000;
    for (int rate : {44100, 48000, 88200, 96000}) {
      UsbPacketScheduler scheduler;
      std::string error;
      check(scheduler.configure({speed, 1020, 1}, rate, 6, &error), error.c_str());
      size_t frames = 0;
      for (int i = 0; i < ticks * 10; ++i) {
        const auto n = scheduler.nextFrames();
        check(n == static_cast<size_t>(rate / ticks) || n == static_cast<size_t>(rate / ticks + 1), "nominal packet jitter");
        frames += n;
      }
      check(frames == static_cast<size_t>(rate * 10), "nominal pacing lost a fractional frame");
    }
  }
  UsbPacketScheduler scheduler;
  std::string error;
  check(scheduler.configure({UsbBusSpeed::High, 1024 | (2 << 11), 4}, 384000, 8, &error), error.c_str());
  check(scheduler.maxPacketBytes() == 3072 && scheduler.nextFrames() == 384, "HS transactions or bInterval ignored");
  check(!scheduler.configure({UsbBusSpeed::High, 1024 | (3 << 11), 1}, 48000, 8, &error), "reserved HS transactions accepted");
  check(!scheduler.configure({UsbBusSpeed::Full, 1024, 1}, 48000, 8, &error), "oversized FS packet accepted");
  check(!scheduler.configure({UsbBusSpeed::High, 1024, 1}, 1536000, 8, &error), "insufficient bandwidth accepted");
  check(scheduler.configure({UsbBusSpeed::Super, 1024, 1, 2048}, 1536000, 8, &error), error.c_str());
  check(scheduler.maxFrames() == 256 && scheduler.nextFrames() == 192, "SS bytes per interval ignored");
  check(!scheduler.configure({UsbBusSpeed::Full, 264, 1}, 44100, 6, &error), "fractional frame capacity rounded down");
  check(!scheduler.configure({UsbBusSpeed::High, 1024, 0}, 48000, 8, &error), "zero interval accepted");
}

void feedback() {
  UsbPacketScheduler fs;
  std::string error;
  check(fs.configure({UsbBusSpeed::Full, 300, 1}, 44100, 6, &error), error.c_str());
  for (int i = 0; i < 5; ++i) check(fs.nextFrames() == 44, "44.1 phase setup");
  const std::array<uint8_t, 3> rate445{0, 0x20, 0x0b}; // 44.5 samples per frame, 10.14 LE.
  check(fs.applyFeedback(rate445, &error), error.c_str());
  check(fs.nextFrames() == 45, "feedback update reset the nominal fractional phase");
  check(fs.applyFeedback({}, &error) && fs.nextFrames() == 44, "null feedback changed rate or phase");
  fs.reset();
  size_t total = 0;
  for (int i = 0; i < 10; ++i) total += fs.nextFrames();
  check(total == 441, "restart did not restore nominal pacing");
  const std::array<uint8_t, 3> zero{};
  const std::array<uint8_t, 3> tooFast{0, 0, 0x10}; // 64 frames > 50 complete-frame capacity.
  const std::array<uint8_t, 2> truncated{};
  check(!fs.applyFeedback(zero, &error), "zero feedback accepted");
  check(!fs.applyFeedback(tooFast, &error), "oversized feedback accepted");
  check(!fs.applyFeedback(truncated, &error), "truncated feedback accepted");
  UsbPacketScheduler hs;
  check(hs.configure({UsbBusSpeed::High, 1024, 3}, 48000, 8, &error), error.c_str());
  const std::array<uint8_t, 4> rate625{0, 0x40, 6, 0}; // 6.25 samples per microframe, 16.16.
  check(hs.applyFeedback(rate625, &error), error.c_str());
  check(hs.nextFrames() == 25, "HS feedback did not scale by service interval");
}

void implicitFeedback() {
  UsbImplicitFeedback queue;
  queue.configure(2, 50, 3); // Mono I16 source clocks a stereo packed-I24 OUT endpoint.
  UsbImplicitFeedback::Frames measured{};
  std::string error;
  check(!queue.pop(measured), "implicit OUT was primed from nominal rather than measured frames");
  const std::array<size_t, 8> empty{};
  check(queue.push(empty, &error) && !queue.pop(measured), "null source transfer created a zero-byte OUT transfer");
  size_t sourceFrames = 0, outputFrames = 0;
  for (size_t block = 0; block < 1250; ++block) {
    std::array<size_t, 8> source{};
    for (size_t i = 0; i < source.size(); ++i) {
      const size_t frames = (block * 8 + i) % 10 == 9 ? 45 : 44;
      source[i] = frames * 2;
      sourceFrames += frames;
    }
    check(queue.push(source, &error), error.c_str());
    check(queue.pop(measured), "implicit packet layout missing");
    for (size_t i = 0; i < measured.size(); ++i) {
      check(measured[i] == source[i] / 2, "implicit packet pattern was averaged or scaled by OUT channel count");
      outputFrames += measured[i];
    }
  }
  check(sourceFrames == 441000 && outputFrames == sourceFrames, "implicit 44.1 kHz lost source frames");
  std::array<size_t, 8> first{88, 90, 88, 90, 0, 88, 90, 88};
  std::array<size_t, 8> second{90, 88, 90, 88, 90, 88, 90, 88};
  check(queue.push(first, &error) && queue.push(second, &error), "implicit burst enqueue failed");
  check(queue.pop(measured) && measured[0] == 44 && measured[4] == 0, "implicit FIFO order or in-transfer null packet changed");
  check(queue.pop(measured) && measured[0] == 45, "implicit FIFO second transfer changed");
  auto invalid = first;
  invalid[3] = 89;
  check(!queue.push(invalid, &error) && !queue.pop(measured), "partial source sample silently truncated");
  invalid[3] = 102;
  check(!queue.push(invalid, &error) && !queue.pop(measured), "implicit OUT over-capacity accepted or partly enqueued");
  check(queue.push(first, &error) && queue.push(second, &error) && queue.push(first, &error), "implicit queue capacity wrong");
  check(!queue.push(second, &error), "implicit overflow silently discarded feedback");
  queue.reset();
  check(!queue.pop(measured), "restart retained previous lease feedback");

  // High-speed bInterval=3 means 4 microframes per service interval; packet
  // lengths already include that interval, so no second interval scaling.
  queue.configure(4, 128, 2);
  const std::array<size_t, 8> hs{24 * 4, 25 * 4, 24 * 4, 25 * 4, 24 * 4, 25 * 4, 24 * 4, 25 * 4};
  check(queue.push(hs, &error) && queue.pop(measured) && measured[0] == 24 && measured[1] == 25,
      "implicit HS service interval was applied twice");
  // Native DSD source and sink use USB words, not DSD bit-clock or byte frames.
  queue.configure(8, 128, 2);
  std::array<size_t, 8> words{};
  words.fill(11 * 8);
  check(queue.push(words, &error) && queue.pop(measured) && measured[0] == 11, "implicit Native DSD changed word-clock units");
}

void packing() {
  const std::array<float, 5> samples{-1.f, -0.5f, 0.f, 0.5f, 1.f};
  const auto verify = [&](AudioSampleFormat format, std::initializer_list<uint8_t> expected) {
    std::vector<uint8_t> output(expected.size() + 8, 0xa5);
    packUsbPcm(samples, format, output.data());
    check(std::equal(expected.begin(), expected.end(), output.begin()), "PCM packing differs from little-endian wire bytes");
    check(std::all_of(output.end() - 8, output.end(), [](auto b) { return b == 0xa5; }), "PCM packing exceeded destination");
  };
  verify(AudioSampleFormat::Int16Interleaved, {0,0x80, 0,0xc0, 0,0, 0,0x40, 0xff,0x7f});
  verify(AudioSampleFormat::Int24Interleaved, {0,0,0x80, 0,0,0xc0, 0,0,0, 0,0,0x40, 0xff,0xff,0x7f});
  verify(AudioSampleFormat::Int24In32Interleaved, {0,0,0,0x80, 0,0,0,0xc0, 0,0,0,0, 0,0,0,0x40, 0,0xff,0xff,0x7f});
  verify(AudioSampleFormat::Int32Interleaved, {0,0,0,0x80, 0,0,0,0xc0, 0,0,0,0, 0,0,0,0x40, 0xff,0xff,0xff,0x7f});
  verify(AudioSampleFormat::Float32Interleaved, {0,0,0x80,0xbf, 0,0,0,0xbf, 0,0,0,0, 0,0,0,0x3f, 0,0,0x80,0x3f});
  const std::array<float, 5> outside{-2.f, 2.f, std::numeric_limits<float>::infinity(),
      -std::numeric_limits<float>::infinity(), std::numeric_limits<float>::quiet_NaN()};
  std::array<uint8_t, 10> output{};
  packUsbPcm(outside, AudioSampleFormat::Int16Interleaved, output.data());
  check(output == std::array<uint8_t, 10>{0,0x80,0xff,0x7f,0,0,0,0,0,0}, "integer clipping or non-finite silence incorrect");
}

void render() {
  const AudioFormat format{48000, 2, 32, AudioSampleFormat::Int32Interleaved, false};
  const std::array<uint8_t, 16> source{1,0,0,0x40, 0xff,0xff,0xff,0x7f, 1,0,0,0x80, 0x55,0x55,0x55,0x55};
  std::array<uint8_t, 32> output;
  std::array<float, 6> scratch{};
  const auto noFloat = [](float*, size_t) -> size_t { throw std::runtime_error("typed I32 entered float callback"); };
  output.fill(0xa5);
  const auto rendered = renderUsbPcm(output.data(), 3, format, [&](PcmBlock& block) {
    check(block.frames == 3 && block.byteSize == 24, "typed callback received wrong capacity");
    std::memcpy(block.data, source.data(), source.size());
    return size_t{2};
  }, noFloat, scratch);
  check(rendered == 2 && std::equal(source.begin(), source.end(), output.begin()), "typed integer low bits changed");
  check(std::all_of(output.begin() + 16, output.begin() + 24, [](auto b) { return b == 0; }), "typed short tail not silent");
  check(std::all_of(output.begin() + 24, output.end(), [](auto b) { return b == 0xa5; }), "render exceeded buffer");
  const AudioFormat packed{44100, 1, 24, AudioSampleFormat::Int24Interleaved, false};
  output.fill(0xa5);
  bool floatsCalled = false;
  check(renderUsbPcm(output.data(), 3, packed, [](PcmBlock&) { return size_t{0}; }, [&](float* data, size_t frames) {
    check(frames == 3, "float callback frame count wrong"); floatsCalled = true; data[0] = -1; data[1] = 1; return size_t{2};
  }, scratch) == 2 && floatsCalled, "ordinary PCM did not use float fallback");
  const std::array<uint8_t, 9> expected{0,0,0x80,0xff,0xff,0x7f,0,0,0};
  check(std::equal(expected.begin(), expected.end(), output.begin()), "float fallback packing or tail wrong");
  output.fill(0xa5);
  check(renderUsbPcm(output.data(), 3, packed, {}, {}, scratch) == 0, "empty callback rendered frames");
  check(std::all_of(output.begin(), output.begin() + 9, [](auto b) { return b == 0; }), "empty callback did not produce silence");
}

void dopRendering() {
  for (const auto sampleFormat : {AudioSampleFormat::Int24Interleaved, AudioSampleFormat::Int24In32Interleaved}) {
    for (int channels : {1, 2}) {
      const AudioFormat format{176400, channels, 24, sampleFormat, true};
      const size_t width = audioSampleFormatBytes(sampleFormat), stride = width * channels;
      std::vector<uint8_t> output(5 * stride + 8, 0xa5);
      uint64_t markerIndex = 0;
      check(renderUsbDop(output.data(), 5, format, [&](PcmBlock& block) {
        check(block.format.dopEncoded && block.frames == 5 && block.byteSize == 5 * stride, "DoP typed block geometry");
        for (size_t frame = 0; frame < 3; ++frame) for (int channel = 0; channel < channels; ++channel) {
          auto* sample = block.data + frame * stride + channel * width;
          if (width == 4) sample[0] = 0;
          sample[width - 3] = static_cast<uint8_t>(frame + channel + 1);
          sample[width - 2] = static_cast<uint8_t>(0x81 + frame + channel);
          sample[width - 1] = 0; // The USB session supplies the continuous marker phase.
        }
        return size_t{3};
      }, markerIndex) == 3, "DoP typed render count");
      for (size_t frame = 0; frame < 5; ++frame) for (int channel = 0; channel < channels; ++channel) {
        const auto* sample = output.data() + frame * stride + channel * width;
        check(sample[width - 1] == ((frame & 1) ? 0xfa : 0x05), "DoP marker lost phase");
        check(sample[width - 3] == (frame < 3 ? frame + channel + 1 : 0x96), "DoP payload or idle changed");
        check(sample[width - 2] == (frame < 3 ? 0x81 + frame + channel : 0x96), "DoP payload high byte or idle changed");
        if (width == 4) check(sample[0] == 0, "DoP 24-in-32 padding");
      }
      check(markerIndex == 5, "DoP marker cursor did not consume the short tail");
      check(std::all_of(output.begin() + 5 * stride, output.end(), [](auto b) { return b == 0xa5; }), "DoP overrun");
      renderUsbDop(output.data(), 3, format, {}, markerIndex);
      check(output[width - 1] == 0xfa && markerIndex == 8, "DoP marker reset at a transfer boundary");
      check(output[width - 3] == 0x96 && output[width - 2] == 0x96, "Empty DoP callback used PCM zero silence");
    }
  }
}

void nativeDsdRendering() {
  for (const bool littleEndian : {false, true}) for (int channels : {1, 2}) {
    const AudioFormat format{2822400, channels, 1, AudioSampleFormat::DsdInt8Msb1, false};
    const size_t bytes = 8 * channels;
    std::vector<uint8_t> output(bytes + 8, 0xa5), scratch(bytes + 8, 0xa5);
    check(renderUsbNativeDsd(output.data(), 2, format, littleEndian, [&](PcmBlock& block) {
      check(block.frames == 8 && block.byteSize == bytes && block.format.sampleRate == 2822400, "Native DSD confused bit-clock and byte frames");
      for (size_t frame = 0; frame < 5; ++frame) for (int channel = 0; channel < channels; ++channel)
        block.data[frame * channels + channel] = static_cast<uint8_t>(frame * 16 + channel + 1);
      return size_t{5};
    }, scratch) == 5, "Native DSD short callback count");
    for (size_t frame = 0; frame < 2; ++frame) for (int channel = 0; channel < channels; ++channel) {
      for (size_t byte = 0; byte < 4; ++byte) {
        const size_t time = frame * 4 + (littleEndian ? 3 - byte : byte);
        const auto expected = time < 5 ? time * 16 + channel + 1 : 0x96;
        check(output[(frame * channels + channel) * 4 + byte] == expected, "Native DSD word endian, channel grouping or idle changed");
      }
    }
    check(std::all_of(output.begin() + bytes, output.end(), [](auto b) { return b == 0xa5; }), "Native DSD output overrun");
    check(std::all_of(scratch.begin() + bytes, scratch.end(), [](auto b) { return b == 0xa5; }), "Native DSD scratch overrun");
    renderUsbNativeDsd(output.data(), 2, format, littleEndian, {}, scratch);
    check(std::all_of(output.begin(), output.begin() + bytes, [](auto b) { return b == 0x96; }), "Empty Native DSD callback used PCM zero silence");
  }
  UsbPacketScheduler scheduler;
  std::string error;
  check(scheduler.configure({UsbBusSpeed::Full, 1023, 1}, 2822400 / 32, 8, &error), error.c_str());
  size_t words = 0;
  for (int i = 0; i < 10000; ++i) words += scheduler.nextFrames();
  check(words * 32 == 2822400 * 10, "Native DSD scheduler lost bit-clock precision");
  check(!scheduler.configure({UsbBusSpeed::Full, 1023, 1}, 176400, 6, &error), "FS stereo DoP exceeded bus capacity");
  check(scheduler.configure({UsbBusSpeed::High, 1024, 1}, 176400, 6, &error), error.c_str());
}
}  // namespace

int main() {
  try { pacing(); feedback(); implicitFeedback(); packing(); render(); dopRendering(); nativeDsdRendering(); }
  catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
  std::cout << "USB pacing, explicit/implicit feedback, PCM, DoP marker/idle and Native DSD word packing passed\n";
}
