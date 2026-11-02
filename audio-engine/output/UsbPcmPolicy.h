#pragma once
#include "../core/AudioTypes.h"
#include <functional>
#include <string>
namespace twilight::audio {
// Acquired and released by exactly one output lifecycle. Never called on the audio callback.
struct UsbPcmPolicy {
  std::function<int(const std::string&, const AudioFormat&, std::string*)> acquire;
  std::function<bool()> valid;
  // False retains the UID lease: ordinary output must wait for a successful explicit cleanup.
  std::function<bool()> release;
};
}
