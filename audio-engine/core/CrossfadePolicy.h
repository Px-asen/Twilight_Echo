#pragma once

#include "AudioTypes.h"
#include <algorithm>
#include <cmath>

namespace twilight::audio {

struct CrossfadeDecision {
  double seconds = 0;
  const char* reason = "";
};

inline CrossfadeDecision decideCrossfade(
    double requested, int content, const QueueItem& current, const QueueItem* next,
    double currentDuration, double nextDuration, bool dsd, double rate) {
  if (requested <= 0) return {0, "disabled"};
  if (dsd) return {0, "dsd_path"};
  if (std::abs(rate - 1.0) > 0.0001) return {0, "playback_rate"};
  if (!next) return {0, "no_preload"};
  if (current.cueStartSeconds.has_value() || next->cueStartSeconds.has_value()) return {0, "cue"};
  if (content == 2) return {0, "live"};
  if (currentDuration <= 0 || nextDuration <= 0) return {0, "unknown_duration"};
  if (content == 0) {
    if (!current.album.empty() && current.album == next->album && current.artist == next->artist)
      return {0, "album"};
    if (std::min(currentDuration, nextDuration) < std::max(10.0, requested * 2))
      return {0, "short_track"};
  }
  return {std::min({requested, currentDuration * 0.5, nextDuration * 0.5}), ""};
}

}
