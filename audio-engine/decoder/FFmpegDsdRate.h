#pragma once

// FFmpeg's raw-DSD decoders (dsd_lsbf/dsd_msbf and their planar variants) run a fixed
// 8:1 decimation: one input byte per channel carries eight DSD bits and produces exactly
// one PCM sample. The demuxers therefore publish codecpar->sample_rate as the *decoded
// PCM* rate, not the DSD bit rate -- a DSD64 .dsf whose fmt chunk says 2822400 shows up
// as 352800.
//
// Everything else in the engine (DsdReader, SacdIsoDemuxer, dopCarrierFormatForDsd,
// AudioStreamInfo::sourceFormat for DSD sources) uses the true DSD rate, so the FFmpeg
// path has to scale back up before inferring anything. Without that, inferDsdRate() sees
// 352800, falls through every threshold, and reports dsdRate = 0 -- which silently
// disables DoP carrier selection for every DSF/DFF file.

#if defined(TAE_HAS_FFMPEG)

extern "C" {
#include <libavcodec/avcodec.h>
}

namespace twilight::audio::ffmpeg {

// Bits packed into each byte of a raw DSD stream, i.e. the decoder's decimation factor.
constexpr int kDsdBitsPerByte = 8;

// True only for FFmpeg's native raw-DSD codecs. DoP is PCM-framed and never reports one
// of these ids, so a DoP-in-WAV stream keeps its real carrier rate untouched.
inline bool isRawDsdCodec(AVCodecID codecId) {
  switch (codecId) {
    case AV_CODEC_ID_DSD_LSBF:
    case AV_CODEC_ID_DSD_MSBF:
    case AV_CODEC_ID_DSD_LSBF_PLANAR:
    case AV_CODEC_ID_DSD_MSBF_PLANAR:
      return true;
    default:
      return false;
  }
}

// Converts the rate FFmpeg reports into the DSD bit rate the rest of the engine expects.
// Non-raw-DSD streams (including DoP) pass through unchanged.
inline int dsdSampleRateFromCodecRate(AVCodecID codecId, int reportedSampleRate) {
  // DSDIFF DST is decoded through the same 8:1 DSD-to-PCM filter; IFF's FS
  // property is likewise divided by eight before entering codec parameters.
  if (reportedSampleRate <= 0 || (!isRawDsdCodec(codecId) && codecId != AV_CODEC_ID_DST)) return reportedSampleRate;
  return reportedSampleRate * kDsdBitsPerByte;
}

}  // namespace twilight::audio::ffmpeg

#endif  // TAE_HAS_FFMPEG
