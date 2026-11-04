#include "bridge_clock_fixture.h"
#include <algorithm>
#include <iomanip>
#include <sstream>

// A controllable physical clock boundary for the production receiver/SWR. Each
// command is one control or render operation; no sound device is constructed.
int main() {
  std::unique_ptr<Fixture> f;
  uint64_t inputFrames = 0, phaseChecks = 0;
  double mediaOffset = 0, target = 0, dspFrames = 0, downstreamFrames = 0;
  constexpr double omega = 6.2831853071795864769*1000/48000;
  const auto fill = [&](size_t highWater) {
    for (;;) {
      const auto facts = f->receiver.status();
      const auto buffered = static_cast<size_t>(number(facts, "bufferedFrames"));
      if (buffered >= highWater) break;
      const size_t count = std::min<size_t>({113 + inputFrames % 1936, highWater-buffered,
          static_cast<size_t>(number(facts, "inputCreditFrames"))});
      assert(count);
      std::vector<float> samples(count*2);
      for (size_t n = 0; n < count; ++n)
        samples[n*2] = samples[n*2+1] = static_cast<float>(.5*std::sin((mediaOffset+inputFrames+n-dspFrames)*omega));
      assert(f->receiver.write(samples.data(), count, &f->error)); inputFrames += count;
    }
  };
  const auto report = [&] {
    auto facts = f->receiver.status();
    // Configured analog delay is a model here. Query the same native history
    // at its delayed presentation point, independently from the controller's
    // phase estimate, and subtract the modeled upstream DSP latency.
    const auto physical = f->dac->clock.positionFrames;
    f->dac->clock.positionFrames = physical-downstreamFrames;
    const auto delayed = f->receiver.status();
    f->dac->clock.positionFrames = physical;
    std::ostringstream extra;
    extra << std::setprecision(17) << ",\"analogMediaFrames\":";
    if (delayed.find("\"presentedMediaFrames\":null") != std::string::npos) extra << "null";
    else extra << mediaOffset+number(delayed, "presentedMediaFrames")-dspFrames;
    extra << ",\"phaseChecks\":" << phaseChecks << '}';
    facts.pop_back(); std::cout << facts << extra.str() << std::endl;
  };
  std::string command;
  while (std::cin >> command) {
    if (command == "prepare") {
      size_t pipeline = 0;
      std::cin >> mediaOffset >> dspFrames >> downstreamFrames >> pipeline;
      f = std::make_unique<Fixture>(); inputFrames = 0; target = 0;
      f->dac->released = 96000; f->dac->clock.positionFrames = 96000-pipeline;
      assert(f->receiver.prepareAdaptiveTimed(&f->error)); fill(4800); report();
    } else if (command == "arm") {
      double lead = 0; uint64_t mediaFrame = 0;
      std::cin >> lead >> mediaFrame; target = outputMonotonicMs()+lead;
      assert(f->receiver.armTimed(target, f->generation(), mediaFrame, &f->error)); report();
    } else if (command == "rate") {
      double ppm = 0; std::cin >> ppm;
      assert(f->receiver.setTimedCorrection(ppm, f->generation(), &f->error)); report();
    } else if (command == "step") {
      double ppm = 0, firstDelta = 0, frameMs = 0;
      size_t frames = 0, pipeline = 0, highWater = 0;
      std::cin >> ppm >> frames >> firstDelta >> frameMs >> pipeline >> highWater;
      assert(f && target && frames && frames <= 24000 && highWater >= 1920 && highWater <= 9600);
      assert(f->receiver.setTimedCorrection(ppm, f->generation(), &f->error));
      size_t rendered = 0;
      while (rendered < frames) {
        fill(highWater);
        const size_t count = std::min<size_t>(480, frames-rendered), middle = count/2;
        const uint64_t first = f->dac->released;
        const auto data = f->dac->tick(count, target+firstDelta+rendered*frameMs);
        f->dac->clock.positionFrames = static_cast<double>(first+middle);
        const auto facts = f->receiver.status();
        if (facts.find("\"presentedMediaFrames\":null") == std::string::npos) {
          const double source = number(facts, "presentedMediaFrames");
          if (source > 256) {
            assert(std::abs(data[middle*2]-.5*std::sin((mediaOffset+source-dspFrames)*omega)) < 2e-6);
            ++phaseChecks;
          }
        }
        rendered += count;
      }
      f->dac->clock.positionFrames = static_cast<double>(f->dac->released-pipeline);
      const auto facts = f->receiver.status();
      assert(facts.find("\"failed\":true") == std::string::npos);
      assert(number(facts, "underruns") == 0); report();
    } else if (command == "close") {
      f.reset(); std::cout << "{\"closed\":true}" << std::endl;
    } else { assert(false && "Unknown fixture command"); }
  }
}
