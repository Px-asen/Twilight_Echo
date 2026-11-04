#pragma once
#include "../OutputClock.h"
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
#include <audioclient.h>
#include <wrl/client.h>

namespace twilight::audio::wasapi {
class PresentationClock {
 public:
  void attach(IAudioClient* client, int sampleRate) {
    clock_.Reset(); frequency_ = 0; rate_ = sampleRate; ++epoch_;
    if (client && SUCCEEDED(client->GetService(IID_PPV_ARGS(&clock_)))) {
      if (FAILED(clock_->GetFrequency(&frequency_)) || frequency_ == 0) clock_.Reset();
    }
    invalidate();
  }
  void begin() { ++epoch_; invalidate(); }
  void invalidate() { cache_.publish({clock_ != nullptr, false, false, epoch_, 0, 0, rate_}); }
  void detach() { clock_.Reset(); frequency_ = 0; ++epoch_; invalidate(); }
  void sample() {
    UINT64 position = 0, qpc100ns = 0;
    // S_FALSE means the timestamp's accuracy is uncertain. Do not promote it to
    // a valid synchronization observation merely because SUCCEEDED is true.
    const bool valid = clock_ && clock_->GetPosition(&position, &qpc100ns) == S_OK && qpc100ns > 0;
    cache_.publish({clock_ != nullptr, valid, true, epoch_,
      valid ? static_cast<double>(position) * rate_ / static_cast<double>(frequency_) : 0,
      valid ? static_cast<double>(qpc100ns) / 10000.0 : 0, rate_});
  }
  OutputClockSnapshot read() const { return cache_.read(); }
 private:
  Microsoft::WRL::ComPtr<IAudioClock> clock_;
  UINT64 frequency_ = 0, epoch_ = 0;
  int rate_ = 0;
  OutputClockCache cache_;
};
} // namespace twilight::audio::wasapi
#endif
