#pragma once

#include "../../core/AudioTypes.h"
#include <functional>
#include <string>

namespace twilight::audio {

// Installed per engine before playback. All calls are on control threads, never
// the USB event/render thread. One acquire owns one Android connection until release.
struct UsbDirectHost {
  std::function<std::string(const std::string&, const AudioFormat&)> acquire;
  // After claim; UAC1 after selecting its alternate, UAC2 before selecting it.
  std::function<std::string(int profile, int rate)> configure;
  // Restore controls while interfaces are still claimed; then native releases them.
  std::function<std::string()> restore;
  std::function<void()> release;
};

}  // namespace twilight::audio
