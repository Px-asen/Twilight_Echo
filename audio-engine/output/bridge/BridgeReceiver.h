#pragma once
#include "../IOutputBackend.h"
#include <atomic>

namespace twilight::audio {
// One network producer, one driver consumer. Opening/closing is control-thread
// only. The driver callback performs bounded copies/zero-fill, not IO or DSP.
class BridgeReceiver {
 public:
  ~BridgeReceiver() { close(); }
  bool open(std::unique_ptr<IOutputBackend> backend, const std::string& device,
            int rate, int channels, std::string* error);
  bool write(const float* samples, size_t frames, std::string* error);
  bool start(std::string* error);
  void close();
  std::string status() const;
 private:
  size_t render(float* samples, size_t frames);
  std::unique_ptr<IOutputBackend> backend_;
  AudioFormat format_;
  std::vector<float> ring_;
  size_t capacity_ = 0;
  size_t prebufferFrames_ = 0;
  std::atomic<uint64_t> read_{0}, written_{0}, consumed_{0}, underruns_{0};
  std::atomic<bool> failed_{false};
  bool started_ = false;
};
} // namespace twilight::audio
