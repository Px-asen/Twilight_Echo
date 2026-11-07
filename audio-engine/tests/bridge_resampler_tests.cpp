#include "../output/bridge/BridgeResampler.h"
#include <algorithm>
#include <cassert>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <vector>
using namespace twilight::audio;
constexpr double pi = 3.14159265358979323846;

struct Result { double snr = 0, gain = 0, effectivePpm = 0; size_t frames = 0; };
Result tone(int rate, double frequency, double ppm, size_t length, bool changes = false, size_t outputBlock = 4096) {
  BridgeResampler src;
  std::string error;
  assert(src.open(rate, &error));
  assert(src.correction(ppm, &error));
  std::vector<float> input(4096), output(outputBlock * 2);
  double last = 0, energy = 0, residual = 0, referenceEnergy = 0;
  size_t checked = 0, produced = 0;
  const double omega = 2*pi*frequency/rate;
  const auto accept = [&](const BridgeResampler::Block& b) {
    if (!b.frames) return;
    assert(std::abs(b.first - last) < 1e-5);
    assert(b.step > .998 && b.step < 1.002);
    for (size_t n = 0; n < b.frames; ++n) {
      assert(std::isfinite(output[n*2]) && output[n*2] == output[n*2+1]);
      const double at = b.boundary(n);
      assert(at >= -1e-6 && at < length + 1e-6);
      if (at > 256 && at < length-256) {
        const double expected = .5*std::sin(at*omega);
        energy += output[n*2]*output[n*2];
        referenceEnergy += expected*expected;
        residual += std::pow(output[n*2]-expected, 2);
        ++checked;
      }
    }
    produced += b.frames; last = b.end;
  };
  for (size_t written = 0; written < length;) {
    const size_t frames = std::min<size_t>(480, length-written);
    if (changes && (written / 480) % 5 == 0) assert(src.correction(((written / 2400)%2 ? -1 : 1)*ppm, &error));
    for (size_t n = 0; n < frames; ++n)
      input[n*2] = input[n*2+1] = static_cast<float>(.5*std::sin((written+n)*omega));
    BridgeResampler::Block b;
    assert(src.process(input.data(), frames, output.data(), outputBlock, &b, &error));
    accept(b); written += frames;
    // Also exercise bounded output and draining without accidentally sending EOF.
    do { assert(src.drain(output.data(), outputBlock, &b, &error)); accept(b); } while (b.frames);
    assert(!src.ended() && !src.completed());
  }
  assert(src.inputFrames() == length);
  assert(src.pendingFrames() >= 0 && src.pendingFrames() < 280);
  src.endInput();
  assert(!src.correction(0, &error));
  for (size_t calls = 0; !src.completed(); ++calls) {
    assert(calls < 512);
    BridgeResampler::Block b;
    assert(src.drain(output.data(), outputBlock, &b, &error)); accept(b);
  }
  assert(std::abs(last-length) < 1e-5);
  BridgeResampler::Block empty;
  assert(src.drain(output.data(), outputBlock, &empty, &error) && empty.frames == 0);
  if (!changes) {
    const double ratio = 1+src.effectivePpm()*1e-6;
    assert(std::abs(static_cast<double>(produced) - std::ceil(length*ratio-1e-6)) <= 1);
  }
  return {checked ? 10*std::log10(referenceEnergy/residual) : 0,
    checked ? std::sqrt(energy/referenceEnergy) : 0, src.effectivePpm(), produced};
}
int main() {
  for (int rate : {44100, 48000, 96000, 192000}) {
    for (int ppm : {-1000, -200, 0, 200, 1000}) {
      for (size_t frames : {1, 2, 63, 64, 66, 67, 68, 129, 480, 48013}) {
        const auto r = tone(rate, 1000, ppm, frames, false, 127);
        assert(std::abs(r.effectivePpm-ppm) < 1.1);
        if (frames == 48013) assert(r.snr > 100 && std::abs(r.gain-1) < 1e-5);
      }
    }
  }
  for (double frequency : {1000, 10000, 20000, 23800}) {
    const auto r = tone(48000, frequency, 200, 144000, true);
    std::cout << std::setprecision(10) << frequency << " Hz: gain=" << 20*std::log10(r.gain)
              << " dB, waveform SNR=" << r.snr << " dB\n";
    if (frequency <= 20000) assert(r.snr > 90 && std::abs(r.gain-1) < 1e-4);
    else assert(20*std::log10(r.gain) < -55);
  }
  BridgeResampler src; std::string error;
  assert(src.open(48000, &error));
  assert(!src.correction(1001, &error) && !src.correction(NAN, &error));
  src.endInput();
  float output[2]; BridgeResampler::Block b;
  assert(src.drain(output, 1, &b, &error) && src.completed() && b.frames == 0);
  std::cout << "Adaptive PCM: source-coordinate continuity, ppm sign, bounded output, tiny/EOF tails, rates and Kaiser response passed\n";
}
