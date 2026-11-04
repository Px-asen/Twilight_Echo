#include "bridge_clock_fixture.h"
#include <algorithm>
#include <iomanip>

// stdin: requested ppm, number of hardware frames to present. stdout: the
// production receiver's facts. Only DAC time is controlled; PCM runs through
// the real SWR, ring, render/commit callbacks and source-presentation history.
int main() {
  Fixture f;
  assert(f.receiver.prepareAdaptiveTimed(&f.error));
  uint64_t inputFrames = 0, outputFrames = 0;
  constexpr double omega = 6.2831853071795864769*1000/48000;
  const auto fill = [&] {
    for (;;) {
      const auto facts = f.receiver.status();
      const auto buffered = static_cast<size_t>(number(facts, "bufferedFrames"));
      if (buffered >= 4800) break;
      const size_t count = std::min<size_t>({2048, 4800-buffered,
          static_cast<size_t>(number(facts, "inputCreditFrames"))});
      assert(count);
      std::vector<float> input(count*2);
      for (size_t n = 0; n < count; ++n)
        input[n*2] = input[n*2+1] = static_cast<float>(.5*std::sin((inputFrames+n)*omega));
      assert(f.receiver.write(input.data(), count, &f.error)); inputFrames += count;
    }
  };
  fill();
  f.dac->released = 48480; f.dac->clock.positionFrames = 48480; // One second of silent clock preroll.
  const double target = outputMonotonicMs()+500;
  assert(f.receiver.armTimed(target, f.generation(), 900, &f.error));
  std::cout << f.receiver.status() << std::endl;
  double ppm = 0; size_t frames = 0;
  while (std::cin >> ppm >> frames) {
    assert(std::isfinite(ppm) && std::abs(ppm) <= 1000 && frames > 0 && frames <= 24000);
    assert(f.receiver.setTimedCorrection(ppm, f.generation(), &f.error));
    std::vector<float> last; uint64_t first = 0; size_t count = 0;
    while (frames) {
      fill(); count = std::min<size_t>(frames, 480); first = f.dac->released;
      last = f.dac->tick(count, target+outputFrames/48.0);
      outputFrames += count; frames -= count;
      f.dac->clock.positionFrames = static_cast<double>(f.dac->released);
    }
    // Independent sample-phase check, rather than trusting only frame counters.
    const size_t middle = count/2;
    f.dac->clock.positionFrames = static_cast<double>(first+middle);
    const double source = number(f.receiver.status(), "presentedMediaFrames");
    if (source > 256) assert(std::abs(last[middle*2]-.5*std::sin(source*omega)) < 2e-6);
    f.dac->clock.positionFrames = static_cast<double>(f.dac->released);
    auto facts = f.receiver.status();
    assert(facts.find("\"state\":\"running\"") != std::string::npos);
    assert(number(facts, "underruns") == 0);
    std::cout << facts << std::endl;
  }
}
