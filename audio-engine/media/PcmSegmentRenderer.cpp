#include "PcmSegmentRenderer.h"

#include "../core/AudioTypes.h"
#include "../core/Utf8Path.h"
#include "../decoder/FFmpegDecoder.h"
#include "../include/twilight_audio_engine.h"

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstring>
#include <fstream>
#include <limits>
#include <vector>

namespace twilight::audio {
namespace {
void word(std::vector<uint8_t>& bytes, uint32_t value, int width) {
  for (int i = 0; i < width; ++i) bytes.push_back(static_cast<uint8_t>(value >> (i * 8)));
}
void tag(std::vector<uint8_t>& bytes, const char* text) {
  bytes.insert(bytes.end(), text, text + 4);
}
bool fail(std::string* error, const std::string& message) {
  if (error) *error = message;
  return false;
}
}  // namespace

bool writePcmSegment(FFmpegDecoder& decoder, double startSeconds, double endSeconds,
                     double virtualPregapSeconds, std::ostream& output, std::string* error) {
  if (!std::isfinite(startSeconds) || !std::isfinite(endSeconds) ||
      !std::isfinite(virtualPregapSeconds) || startSeconds < 0 ||
      endSeconds <= startSeconds || virtualPregapSeconds < 0)
    return fail(error, "Invalid PCM segment range");

  // The decoder's default PCM rate also covers DSD-to-PCM inputs. Never use the DSD bit clock
  // as a PCM sample rate, and never apply a playback output policy or software gain here.
  AudioFormat format = decoder.outputFormat();
  const AudioFormat& source = decoder.streamInfo().sourceFormat;
  if (format.sampleRate <= 0 || format.channelCount <= 0)
    return fail(error, "PCM segment source format is unavailable");
  if (format.sampleFormat == AudioSampleFormat::Int24In32Interleaved)
    format.sampleFormat = AudioSampleFormat::Int24Interleaved;
  const bool floating = format.sampleFormat == AudioSampleFormat::Float32Interleaved;
  const int containerBits = floating ? 32 :
      format.sampleFormat == AudioSampleFormat::Int16Interleaved ? 16 :
      format.sampleFormat == AudioSampleFormat::Int24Interleaved ? 24 : 32;
  format.bitDepth = containerBits;
  if (!decoder.setOutputFormat(format, error)) return false;
  format = decoder.outputFormat();
  if ((format.channelMask >> 32) != 0)
    return fail(error, "PCM speaker layout cannot be represented by a WAVE channel mask");
  const int validBits = floating || decoder.streamInfo().isDsd ? containerBits :
      std::min(containerBits, source.bitDepth > 0 ? source.bitDepth : containerBits);
  const bool nonStandardSpeakers = format.channelMask != 0 &&
      format.channelMask != (format.channelCount == 1 ? 4u : format.channelCount == 2 ? 3u : 0u);
  const bool extensible = format.channelCount > 2 || validBits != containerBits || nonStandardSpeakers;
  const size_t stride = audioFormatBytesPerFrame(format);
  const uint32_t headerBytes = (extensible ? 68 : 44) + (floating ? 12 : 0);
  const double start = std::round(startSeconds * format.sampleRate);
  const double end = std::round(endSeconds * format.sampleRate);
  const double silence = std::round(virtualPregapSeconds * format.sampleRate);
  // RIFF has 32-bit chunk lengths. Do not produce a wrapping header or a truncated segment.
  const uint64_t maxFrames = (UINT32_MAX - headerBytes) / stride;
  if (!std::isfinite(end) || !std::isfinite(silence) || end >= static_cast<double>(INT64_MAX) ||
      end <= start || end - start + silence > static_cast<double>(maxFrames))
    return fail(error, "PCM segment exceeds WAV RIFF size or contains no source frames");
  const uint64_t startFrame = static_cast<uint64_t>(start);
  const uint64_t sourceFrames = static_cast<uint64_t>(end - start);
  const uint64_t silenceFrames = static_cast<uint64_t>(silence);
  const uint64_t totalFrames = sourceFrames + silenceFrames;
  const uint32_t dataBytes = static_cast<uint32_t>(totalFrames * stride);
  const uint32_t padding = dataBytes & 1u;
  if (!decoder.seekOutputFrame(startFrame, error)) return false;

  std::vector<uint8_t> header;
  tag(header, "RIFF"); word(header, headerBytes - 8 + dataBytes + padding, 4); tag(header, "WAVE");
  tag(header, "fmt "); word(header, extensible ? 40 : 16, 4);
  word(header, extensible ? 0xfffe : floating ? 3 : 1, 2);
  word(header, format.channelCount, 2); word(header, format.sampleRate, 4);
  word(header, static_cast<uint32_t>(format.sampleRate * stride), 4);
  word(header, static_cast<uint32_t>(stride), 2); word(header, containerBits, 2);
  if (extensible) {
    word(header, 22, 2); word(header, validBits, 2);
    word(header, static_cast<uint32_t>(format.channelMask), 4);
    word(header, floating ? 3 : 1, 4); word(header, 0x00100000, 4);
    word(header, 0xaa000080, 4); word(header, 0x719b3800, 4);
  }
  if (floating) { tag(header, "fact"); word(header, 4, 4); word(header, totalFrames, 4); }
  tag(header, "data"); word(header, dataBytes, 4);
  output.write(reinterpret_cast<const char*>(header.data()), header.size());
  constexpr size_t kBlockFrames = 4096;
  std::vector<uint8_t> block(kBlockFrames * stride, 0);
  for (uint64_t left = silenceFrames; left > 0;) {
    const size_t count = static_cast<size_t>(std::min<uint64_t>(left, kBlockFrames));
    output.write(reinterpret_cast<const char*>(block.data()), count * stride);
    if (!output) return fail(error, "Unable to write PCM segment silence");
    left -= count;
  }
  for (uint64_t left = sourceFrames; left > 0;) {
    const size_t count = static_cast<size_t>(std::min<uint64_t>(left, kBlockFrames));
    PcmBlock pcm{format, block.data(), count, block.size()};
    const size_t read = decoder.readFrames(pcm, error);
    if (error && !error->empty()) return false;
    if (!read) return fail(error, "PCM segment source ended before its declared boundary");
    output.write(reinterpret_cast<const char*>(block.data()), read * stride);
    if (!output) return fail(error, "Unable to write PCM segment audio");
    left -= read;
  }
  if (padding) output.put('\0');
  return output.good() || fail(error, "Unable to finish PCM segment WAV");
}
}  // namespace twilight::audio

TAE_Result TAE_RenderPcmSegment(const char* source, const char* output_path,
    double start_seconds, double end_seconds, double virtual_pregap_seconds,
    char* error_buffer, size_t error_capacity) {
  std::string error;
  TAE_Result result = TAE_RESULT_INTERNAL_ERROR;
  if (!source || !*source || !output_path || !*output_path || std::strcmp(source, output_path) == 0) {
    error = "PCM segment requires distinct source and output paths";
    result = TAE_RESULT_INVALID_ARGUMENT;
  } else {
    twilight::audio::FFmpegDecoder decoder;
    if (decoder.open(source, &error)) {
      std::ofstream output(twilight::audio::utf8Path(output_path), std::ios::binary | std::ios::trunc);
      if (!output) error = std::string("Unable to create PCM segment: ") + output_path + ": " + std::strerror(errno);
      else if (twilight::audio::writePcmSegment(decoder, start_seconds, end_seconds,
          virtual_pregap_seconds, output, &error)) {
        output.flush();
        if (output.good()) result = TAE_RESULT_OK;
        else error = "Unable to flush PCM segment WAV";
      }
    }
  }
  if (error_buffer && error_capacity > 0) {
    const size_t count = std::min(error.size(), error_capacity - 1);
    std::memcpy(error_buffer, error.data(), count);
    error_buffer[count] = '\0';
  }
  return result;
}
