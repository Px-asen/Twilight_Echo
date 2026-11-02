#pragma once

#include <iosfwd>
#include <string>

namespace twilight::audio {
class FFmpegDecoder;

/** Background-only. Decoder is already open; no playback graph, gain or output device is used.
 * Absolute source bounds become a zero-based WAV, preceded only by explicit virtual PREGAP. */
bool writePcmSegment(FFmpegDecoder& decoder, double startSeconds, double endSeconds,
                     double virtualPregapSeconds, std::ostream& output, std::string* error);
}  // namespace twilight::audio
