#include "bridge_clock_fixture.h"
#include <thread>
constexpr double omega = 6.2831853071795864769 * 1000 / 48000;
void writeTone(Fixture& f, uint64_t first, size_t count) {
  std::vector<float> input(count*2);
  for (size_t n = 0; n < count; ++n) input[n*2] = input[n*2+1] = static_cast<float>(.5*std::sin((first+n)*omega));
  assert(f.receiver.write(input.data(), count, &f.error));
}
int main() {
  {
    Fixture f(true, 12000); // A full-capacity callback cannot coexist with FIR lookahead.
    assert(!f.receiver.prepareAdaptiveTimed(&f.error));
    assert(f.error.find("lookahead") != std::string::npos);
    assert(f.receiver.prepareTimed(&f.error)); // Existing 1:1 timing retains its original buffer contract.
  }
  // The history retains the mapping committed with each sample, not whichever
  // correction happens to be current when the control thread queries position.
  for (double ppm : {-200, 0, 200}) {
    Fixture f; assert(f.receiver.prepareAdaptiveTimed(&f.error));
    assert(!f.receiver.setTimedCorrection(ppm, f.generation()+1, &f.error));
    assert(f.receiver.setTimedCorrection(ppm, f.generation(), &f.error));
    for (int n = 0; n < 4; ++n) writeTone(f, n*2000, 2000);
    assert(f.receiver.endTimed(&f.error));
    const double target = outputMonotonicMs()+500;
    assert(f.receiver.armTimed(target, f.generation(), 100000, &f.error));
    assert(number(f.receiver.status(), "consumedFrames") == 0);
    double prior = 0, last = 0;
    size_t outputFrames = 0;
    for (int packet = 0; packet < 18; ++packet) {
      const uint64_t first = f.dac->released;
      const auto audio = f.dac->tick(480, target+packet*10);
      f.dac->clock.positionFrames = first;
      const double source = number(f.receiver.status(), "presentedMediaFrames");
      assert(source >= prior); prior = source;
      for (int offset : {0, 120, 240, 360}) {
        f.dac->clock.positionFrames = first+offset+.25;
        const double at = number(f.receiver.status(), "presentedMediaFrames");
        assert(at >= last && at <= 8000); last = at;
        if (at > 256 && at < 7744) {
          f.dac->clock.positionFrames = first+offset;
          const double exact = number(f.receiver.status(), "presentedMediaFrames");
          assert(std::abs(audio[offset*2] - .5*std::sin(exact*omega)) < 2e-6);
        }
      }
      outputFrames += 480;
    }
    assert(last == 8000);
    assert(f.receiver.status().find("\"state\":\"completed\"") != std::string::npos);
    const double consumed = number(f.receiver.status(), "consumedFrames");
    if (ppm > 0) assert(consumed > 8000); else if (ppm < 0) assert(consumed < 8000); else assert(consumed == 8000);
    assert(number(f.receiver.status(), "inputCreditFrames") == 0);
    assert(number(f.receiver.status(), "underruns") == 0);
  }
  {
    Fixture f; assert(f.receiver.prepareAdaptiveTimed(&f.error));
    assert(f.receiver.setTimedCorrection(200, f.generation(), &f.error));
    for (int n = 0; n < 5; ++n) writeTone(f, n*2000, 2000);
    const double target = outputMonotonicMs()+500;
    assert(f.receiver.armTimed(target, f.generation(), 0, &f.error));
    f.dac->tick(480, target);
    f.dac->clock.positionFrames = 600;
    const double before = number(f.receiver.status(), "presentedMediaFrames");
    assert(f.receiver.setTimedCorrection(-200, f.generation(), &f.error));
    assert(number(f.receiver.status(), "presentedMediaFrames") == before); // already queued samples keep their coordinates.
    const auto frames = static_cast<size_t>(number(f.receiver.status(), "inputCreditFrames"));
    assert(frames > 0 && frames < 3000);
    writeTone(f, 10000, std::min<size_t>(frames, 2048));
    std::vector<float> extra(4096);
    assert(!f.receiver.write(extra.data(), 2048, &f.error)); // pending SRC input counts toward credit.
    f.dac->tick(480, target+10, true, false);
    assert(f.receiver.status().find("\"presentedMediaFrames\":null") != std::string::npos);
  }
  for (size_t count : {1, 64, 128}) {
    Fixture f; assert(f.receiver.prepareAdaptiveTimed(&f.error)); writeTone(f, 0, count);
    assert(f.receiver.endTimed(&f.error));
    const double target = outputMonotonicMs()+500;
    assert(f.receiver.armTimed(target, f.generation(), 0, &f.error));
    f.dac->tick(480, target);
    f.dac->clock.positionFrames = 480+count-.5;
    assert(f.receiver.status().find("\"state\":\"running\"") != std::string::npos);
    f.dac->clock.positionFrames = 480+count;
    assert(f.receiver.status().find("\"state\":\"completed\"") != std::string::npos);
    assert(number(f.receiver.status(), "presentedMediaFrames") == count);
  }
  {
    BridgePresentationHistory history; history.reset(4096);
    std::atomic<bool> done{false};
    std::thread writer([&] {
      for (uint64_t n = 0; n < 200000; ++n) {
        history.record(n, n*.9998, (n+1)*.9998); history.publish(n+1);
      }
      done = true;
    });
    while (!done.load()) {
      const auto end = history.committedEnd();
      if (end > 500) {
        const double device = end-500+.5;
        if (auto position = history.sourceAt(device)) assert(std::abs(*position-device*.9998) < 1e-7);
      }
    }
    writer.join();
    assert(!history.sourceAt(0)); // overwritten history is unavailable, not an invented extrapolation.
    assert(std::abs(*history.sourceAt(200001)-200000*.9998) < 1e-7);
  }
  std::cout << "Adaptive receiver: committed source mapping, EOF presentation, credit, queued-ratio identity and concurrent history passed\n";
}
