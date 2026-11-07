#include "../core/DsdMuteGuard.h"

#include <cassert>

using namespace twilight::audio;

int main() {
  DsdMuteGuard guard;
  guard.configure({3, 2, 9});
  const auto pcmDop = guard.arm(DsdMuteTransport::Pcm, DsdMuteTransport::Dop, 44100, 176400);
  assert(pcmDop.transition == DsdMuteTransition::PcmToDop);
  assert(guard.state() == DsdMuteState::Locking);
  assert(guard.consumePreRoll(2) == 2);
  assert(guard.preRollRemaining() == 1);
  assert(guard.consumePreRoll(8) == 1);
  assert(guard.state() == DsdMuteState::Locking);
  guard.confirmLock();
  assert(guard.muteNext(1));
  assert(guard.state() == DsdMuteState::Muting);
  assert(guard.consumePostRoll(1) == 1);
  assert(guard.consumePostRoll(4) == 0);
  assert(guard.state() == DsdMuteState::Ready);

  DsdMuteGuard timeout;
  timeout.configure({0, 0, 3});
  timeout.arm(DsdMuteTransport::Pcm, DsdMuteTransport::Dop, 44100, 176400);
  assert(timeout.state() == DsdMuteState::Locking);
  assert(timeout.muteNext(2));
  assert(timeout.state() == DsdMuteState::Locking);
  assert(timeout.muteNext(2));
  assert(timeout.state() == DsdMuteState::Fallback);

  DsdMuteGuard pcm;
  pcm.configure({0, 0, 3});
  pcm.arm(DsdMuteTransport::Pcm, DsdMuteTransport::Pcm, 44100, 44100);
  assert(!pcm.muteNext(1));
  assert(pcm.state() == DsdMuteState::Ready);
  // PCM device-rate changes must not acquire a DSD lock or insert roll silence.
  pcm.configure({256, 256, 4096});
  const auto pcmRate = pcm.arm(DsdMuteTransport::Pcm, DsdMuteTransport::Pcm, 44100, 48000);
  assert(pcmRate.rateChanged);
  assert(pcmRate.transition == DsdMuteTransition::None);
  assert(pcmRate.preRollFrames == 0 && pcmRate.postRollFrames == 0);
  assert(pcm.state() == DsdMuteState::Ready);
  assert(!pcm.muteNext(1000));
  assert(DsdMuteGuard::transitionFor(DsdMuteTransport::Pcm, DsdMuteTransport::Pcm, true) == DsdMuteTransition::None);
  assert(DsdMuteGuard::transitionFor(DsdMuteTransport::Dop, DsdMuteTransport::Pcm, false) == DsdMuteTransition::DopToPcm);
  assert(DsdMuteGuard::transitionFor(DsdMuteTransport::Pcm, DsdMuteTransport::Native, false) == DsdMuteTransition::PcmToNative);
  assert(DsdMuteGuard::transitionFor(DsdMuteTransport::Native, DsdMuteTransport::Pcm, false) == DsdMuteTransition::NativeToPcm);
  assert(DsdMuteGuard::transitionFor(DsdMuteTransport::Dop, DsdMuteTransport::Native, false) == DsdMuteTransition::DopToNative);
  assert(DsdMuteGuard::transitionFor(DsdMuteTransport::Native, DsdMuteTransport::Dop, false) == DsdMuteTransition::NativeToDop);
  assert(DsdMuteGuard::transitionFor(DsdMuteTransport::Native, DsdMuteTransport::Native, true) == DsdMuteTransition::RateChange);
  for (const auto transport : {DsdMuteTransport::Dop, DsdMuteTransport::Native}) {
    const auto rate = pcm.arm(transport, transport, 2822400, 5644800);
    assert(rate.transition == DsdMuteTransition::RateChange);
    assert(rate.preRollFrames == 256 && rate.postRollFrames == 256);
    assert(pcm.state() == DsdMuteState::Locking);
    assert(pcm.muteNext(256));
    assert(pcm.state() == DsdMuteState::Locking);
    pcm.confirmLock();
    assert(pcm.muteNext(256));
    assert(!pcm.muteNext(256));
    const auto fresh = pcm.arm(transport, transport, 2822400, 2822400);
    assert(fresh.transition == DsdMuteTransition::None);
    assert(pcm.state() == DsdMuteState::Locking);
    assert(pcm.muteNext(256));
  }
  guard.markFallback();
  assert(guard.state() == DsdMuteState::Fallback);
  guard.stop();
  assert(guard.state() == DsdMuteState::Stopped);
  assert(guard.plan().transition == DsdMuteTransition::None);
  assert(guard.plan().preRollFrames == 0 && guard.plan().postRollFrames == 0);
  assert(dsdMuteTransportForMode(DsdMode::Native, false) == DsdMuteTransport::Pcm);
  assert(DsdMuteGuard::silenceByte(DsdMuteTransport::Pcm, AudioSampleFormat::Float32Interleaved) == 0x00);
  assert(DsdMuteGuard::silenceByte(DsdMuteTransport::Dop, AudioSampleFormat::Int24Interleaved) == 0x96);
  assert(DsdMuteGuard::silenceByte(DsdMuteTransport::Native, AudioSampleFormat::DsdInt8Lsb1) == 0x69);
  assert(DsdMuteGuard::silenceByte(DsdMuteTransport::Native, AudioSampleFormat::DsdInt8Msb1) == 0x96);
  return 0;
}
