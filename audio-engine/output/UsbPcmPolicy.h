#pragma once
#include "../core/AudioTypes.h"
#include <functional>
#include <string>
namespace twilight::audio {
// Acquired and released by exactly one output lifecycle. Never called on the audio callback.
struct UsbPcmPolicy {
  std::function<int(const std::string&, const AudioFormat&, std::string*)> acquire;
  std::function<bool()> valid;
  std::function<void()> release;
};
}
