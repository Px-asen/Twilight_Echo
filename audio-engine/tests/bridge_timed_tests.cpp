#include "bridge_clock_fixture.h"
int main() {
  const auto context = clockedRenderContext({true, true, true, 7, 64, 1000, 48000}, 128, 480, 1001);
  assert(context.valid && context.firstFrame == 128 && context.epoch == 7);
  assert(std::abs(context.firstFrameAtMs - (1000 + 64.0 / 48)) < 1e-8);
  assert(!clockedRenderContext({true, true, true, 7, 129, 1000, 48000}, 128, 480, 1001).valid);
  assert(!clockedRenderContext({true, true, true, 7, 0, 1000, 48000}, 128, 480, 1300).valid);
  {
    Fixture f;
    assert(f.receiver.prepareTimed(&f.error));
    f.media();
    const double target = outputMonotonicMs() + 500;
    silence(f.dac->tick(480, target - 20));
    assert(number(f.receiver.status(), "consumedFrames") == 0);
    assert(!f.receiver.armTimed(target, f.generation() + 1, 900, &f.error));
    assert(!f.receiver.armTimed(outputMonotonicMs(), f.generation(), 900, &f.error));
    assert(!f.receiver.armTimed(outputMonotonicMs() + 50, f.generation(), 900, &f.error));
    assert(f.receiver.armTimed(target, f.generation(), 900, &f.error));
    assert(!f.receiver.armTimed(target, f.generation(), 900, &f.error));
    const auto packet = f.dac->tick(480, target - 5);
    for (size_t n = 0; n < 480; n++) {
      const float expected = n < 240 ? 0 : static_cast<float>(n - 239) / 4096;
      assert(packet[n * 2] == expected && packet[n * 2 + 1] == expected);
    }
    auto info = f.receiver.status();
    assert(number(info, "consumedFrames") == 240);
    assert(number(info, "deviceStartFrame") == 1200);
    assert(number(info, "mediaFrame") == 900);
    assert(std::abs(number(info, "deviceStartAtMs") - target) < .00001);
    // Media can be dequeued while still queued at the driver: presentation is separate.
    f.dac->clock.positionFrames = 1190;
    assert(number(f.receiver.status(), "presentedMediaFrames") == 0);
    f.dac->clock.positionFrames = 1232;
    assert(number(f.receiver.status(), "presentedMediaFrames") == 32);
    const auto next = f.dac->tick(480, target + 5);
    assert(next.front() == 241.0f / 4096); // no prefill loss or duplicated media.
    const auto late = f.dac->clocked;
    f.receiver.close();
    std::vector<float> cancelled(960, 1);
    late(cancelled.data(), 480, {true, 3, 1920, target + 15, 48000});
    silence(cancelled);
  }
  {
    Fixture f; assert(f.receiver.prepareTimed(&f.error)); f.media(64);
    const double target = outputMonotonicMs() + 500;
    assert(!f.receiver.armTimed(target, f.generation(), 0, &f.error)); // short prebuffer needs EOF.
    assert(f.receiver.endTimed(&f.error));
    assert(f.receiver.armTimed(target, f.generation(), 0, &f.error));
    const auto packet = f.dac->tick(480, target);
    assert(packet.front() == 1.0f / 4096 && packet[126] == 64.0f / 4096 && packet[128] == 0);
    assert(number(f.receiver.status(), "underruns") == 0);
    f.dac->clock.positionFrames = 544;
    assert(f.receiver.status().find("\"state\":\"completed\"") != std::string::npos);
    std::vector<float> extra(128, .1f);
    assert(!f.receiver.write(extra.data(), 64, &f.error));
  }
  for (int failure = 0; failure < 4; ++failure) {
    Fixture f; assert(f.receiver.prepareTimed(&f.error)); f.media();
    const double target = outputMonotonicMs() + 500;
    assert(f.receiver.armTimed(target, f.generation(), 0, &f.error));
    if (failure == 0) ++f.dac->clock.epoch;
    if (failure == 2) { f.dac->tick(2048, target); }
    silence(f.dac->tick(480, failure == 1 ? target + 5 : failure == 2 ? target + 2048.0 / 48 : target, failure != 3));
    assert(f.receiver.status().find("\"state\":\"failed\"") != std::string::npos);
  }
  {
    Fixture f; assert(f.receiver.prepareTimed(&f.error)); f.media();
    const double target = outputMonotonicMs() + 500;
    assert(f.receiver.armTimed(target, f.generation(), 0, &f.error));
    std::vector<float> rendered(960);
    f.dac->clocked(rendered.data(), 480, {true, 3, 480, target, 48000});
    assert(number(f.receiver.status(), "consumedFrames") == 480);
    assert(f.receiver.status().find("\"deviceStartFrame\":null") != std::string::npos);
    f.dac->committed(480, 480, 3, false); // Rendered PCM was never accepted by the driver.
    assert(f.receiver.status().find("\"state\":\"failed\"") != std::string::npos);
    assert(f.receiver.status().find("\"deviceStartFrame\":null") != std::string::npos);
    assert(f.receiver.status().find("\"presentedMediaFrames\":null") != std::string::npos);
  }
  {
    Fixture f; assert(f.receiver.prepareTimed(&f.error)); f.media();
    ++f.dac->clock.epoch;
    assert(!f.receiver.armTimed(outputMonotonicMs() + 500, f.generation(), 0, &f.error));
    assert(number(f.receiver.status(), "consumedFrames") == 0);
  }
  for (int duplicate = 0; duplicate < 2; duplicate++) {
    Fixture f; assert(f.receiver.prepareTimed(&f.error)); f.media();
    const double target = outputMonotonicMs() + 500;
    assert(f.receiver.armTimed(target, f.generation(), 0, &f.error));
    f.dac->tick(480, target);
    if (duplicate) f.dac->committed(480, 480, 3, true);
    else { ++f.dac->released; silence(f.dac->tick(480, target + 10)); }
    assert(f.receiver.status().find("\"error\":\"device_frame_discontinuity\"") != std::string::npos);
    assert(f.receiver.status().find("\"presentedMediaFrames\":null") != std::string::npos);
  }
  {
    Fixture f(false);
    assert(!f.receiver.prepareTimed(&f.error));
    f.media(); assert(f.dac->ordinary); // clock support is never a prerequisite for legacy playback.
  }
  // Different packet phases still place the first sample within one nominal frame.
  const double target = outputMonotonicMs() + 500;
  double anchors[2];
  for (int i = 0; i < 2; ++i) {
    Fixture f; assert(f.receiver.prepareTimed(&f.error)); f.media();
    assert(f.receiver.armTimed(target, f.generation(), 0, &f.error));
    f.dac->tick(480, target - (i == 0 ? 4.107 : 7.319));
    anchors[i] = number(f.receiver.status(), "deviceStartAtMs");
    assert(anchors[i] >= target - .00001 && anchors[i] - target < 1.0 / 48);
  }
  assert(std::abs(anchors[0] - anchors[1]) < 1.0 / 48);
  std::cout << "Timed PCM: silent preparation, exact first sample, cancellation, presentation mapping, EOF and failure isolation passed\n";
}
