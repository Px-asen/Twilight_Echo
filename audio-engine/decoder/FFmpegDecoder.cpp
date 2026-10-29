#include "FFmpegDecoder.h"
#include "../core/DiagnosticLog.h"
#include "FFmpegFileInput.h"

#include "FFmpegDecoderUtils.h"
#include "FFmpegDsdRate.h"
#include "SacdIsoProbe.h"
#include "../core/DsdRate.h"
#include "../core/Utf8Path.h"
#include "../dsp/DspTypes.h"

#include <algorithm>
#include <atomic>
#include <array>
#include <cctype>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <limits>
#include <mutex>
#include <numeric>
#include <optional>
#include <string>
#include <vector>

#if defined(TAE_HAS_FFMPEG)
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/dict.h>
#include <libavutil/error.h>
#include <libavutil/opt.h>
#include <libavutil/samplefmt.h>
#include <libswresample/swresample.h>
}
#endif

namespace twilight::audio {

#if defined(TAE_HAS_FFMPEG)
namespace {

std::string normalizeMetadataKey(std::string key) {
  std::transform(key.begin(), key.end(), key.begin(), [](unsigned char ch) {
    return static_cast<char>(std::toupper(ch));
  });
  return key;
}

std::string toLower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

std::string extensionOf(const std::string& source) {
  const size_t slash = source.find_last_of("/\\");
  const size_t dot = source.find_last_of('.');
  if (dot == std::string::npos || (slash != std::string::npos && dot < slash)) return "";
  return toLower(source.substr(dot + 1));
}

std::optional<double> parseGainDb(const char* rawValue, bool r128) {
  if (!rawValue) return std::nullopt;
  std::string value(rawValue);
  value.erase(value.begin(), std::find_if(value.begin(), value.end(), [](unsigned char ch) {
                return !std::isspace(ch);
              }));
  value.erase(std::find_if(value.rbegin(), value.rend(), [](unsigned char ch) {
                return !std::isspace(ch);
              }).base(),
              value.end());
  if (value.empty()) return std::nullopt;

  std::string lower = value;
  std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });

  char* end = nullptr;
  const double parsed = std::strtod(value.c_str(), &end);
  if (end == value.c_str()) return std::nullopt;
  if (r128 && lower.find("db") == std::string::npos) return parsed / 256.0;
  return parsed;
}

void readReplayGainDictionary(AVDictionary* metadata, ReplayGainInfo* replayGain) {
  if (!metadata || !replayGain) return;

  const AVDictionaryEntry* entry = nullptr;
  while ((entry = av_dict_get(metadata, "", entry, AV_DICT_IGNORE_SUFFIX)) != nullptr) {
    const std::string key = normalizeMetadataKey(entry->key ? entry->key : "");
    if (key == "REPLAYGAIN_TRACK_GAIN") {
      replayGain->trackGainDb = parseGainDb(entry->value, false);
    } else if (key == "REPLAYGAIN_ALBUM_GAIN") {
      replayGain->albumGainDb = parseGainDb(entry->value, false);
    } else if (key == "R128_TRACK_GAIN") {
      replayGain->r128TrackGainDb = parseGainDb(entry->value, true);
    } else if (key == "R128_ALBUM_GAIN") {
      replayGain->r128AlbumGainDb = parseGainDb(entry->value, true);
    }
  }
}

AudioSampleFormat mapSampleFormat(AVSampleFormat sampleFormat) {
  const AVSampleFormat packed = av_get_packed_sample_fmt(sampleFormat);
  switch (packed) {
    case AV_SAMPLE_FMT_S16:
      return AudioSampleFormat::Int16Interleaved;
    case AV_SAMPLE_FMT_S32:
      return AudioSampleFormat::Int32Interleaved;
    case AV_SAMPLE_FMT_FLT:
    case AV_SAMPLE_FMT_DBL:
      return AudioSampleFormat::Float32Interleaved;
    default:
      return AudioSampleFormat::Float32Interleaved;
  }
}

AudioSampleFormat sourceSampleFormat(int bitDepth, AVSampleFormat sampleFormat) {
  if (bitDepth > 0 && bitDepth <= 16) return AudioSampleFormat::Int16Interleaved;
  if (bitDepth > 16 && bitDepth <= 24) return AudioSampleFormat::Int24Interleaved;
  return mapSampleFormat(sampleFormat);
}

int sampleBitDepth(AVSampleFormat sampleFormat) {
  const AVSampleFormat packed = av_get_packed_sample_fmt(sampleFormat);
  switch (packed) {
    case AV_SAMPLE_FMT_U8:
      return 8;
    case AV_SAMPLE_FMT_S16:
      return 16;
    case AV_SAMPLE_FMT_S32:
    case AV_SAMPLE_FMT_FLT:
      return 32;
    case AV_SAMPLE_FMT_DBL:
      return 64;
    default:
      return av_get_bytes_per_sample(sampleFormat) * 8;
  }
}

bool codecLooksLossless(const AVCodecDescriptor* descriptor, const std::string& codecName) {
  if (descriptor && (descriptor->props & AV_CODEC_PROP_LOSSLESS) != 0) return true;
  const std::string normalized = toLower(codecName);
  return normalized == "flac" || normalized == "alac" || normalized == "wavpack" || normalized == "ape" ||
         normalized == "tta" || normalized == "pcm_s16le" || normalized == "pcm_s24le" ||
         normalized == "pcm_s32le" || normalized == "pcm_f32le" || normalized.rfind("pcm_", 0) == 0;
}

bool textMentions(const std::string& haystack, const std::string& needle) {
  return toLower(haystack).find(needle) != std::string::npos;
}

bool codecLooksDsd(AVCodecID codecId, const std::string& codecName, const std::string& containerName, const std::string& extension) {
  switch (codecId) {
    case AV_CODEC_ID_DSD_LSBF:
    case AV_CODEC_ID_DSD_MSBF:
    case AV_CODEC_ID_DSD_LSBF_PLANAR:
    case AV_CODEC_ID_DSD_MSBF_PLANAR:
      return true;
    default:
      break;
  }
  const std::string normalizedCodec = toLower(codecName);
  return normalizedCodec.rfind("dsd", 0) == 0 || normalizedCodec == "dsf" || normalizedCodec == "dff" ||
         normalizedCodec == "dst" || normalizedCodec == "dop" || normalizedCodec.find("dop") != std::string::npos ||
         extension == "dsf" || extension == "dff" || extension == "dop" ||
         textMentions(containerName, "dsd") || textMentions(containerName, "dsf") ||
         textMentions(containerName, "dff") || textMentions(containerName, "dsdiff") ||
         textMentions(containerName, "dop");
}

bool sourceLooksSacdIso(const std::string& source) {
  return probeSacdIsoEntry(source).isSacdIso();
}

bool endsWithHost(const std::string& host, const std::string& suffix) {
  return host.size() >= suffix.size() && host.compare(host.size() - suffix.size(), suffix.size(), suffix) == 0;
}

bool hostLooksLikeNetEase(const std::string& source) {
  // Match hostnames such as music.163.com, p1.music.126.net, m701.music.126.net.
  const std::string lower = toLower(source);
  const size_t scheme = lower.find("://");
  if (scheme == std::string::npos) return false;
  size_t hostBegin = scheme + 3;
  size_t hostEnd = lower.find_first_of("/?#", hostBegin);
  if (hostEnd == std::string::npos) hostEnd = lower.size();
  // Strip userinfo if present (should never appear for authorized sources).
  const size_t at = lower.find('@', hostBegin);
  if (at != std::string::npos && at < hostEnd) hostBegin = at + 1;
  // Strip port.
  const size_t colon = lower.find(':', hostBegin);
  if (colon != std::string::npos && colon < hostEnd) hostEnd = colon;
  if (hostBegin >= hostEnd) return false;
  const std::string host = lower.substr(hostBegin, hostEnd - hostBegin);
  return host == "music.163.com" || endsWithHost(host, ".music.163.com") ||
         endsWithHost(host, ".126.net") || endsWithHost(host, ".163.com");
}

// FFmpeg expects CRLF-terminated header lines in the "headers" option.
std::string buildHttpOpenHeaders(const std::string& source) {
  std::string headers = "Accept: */*\r\nAccept-Language: zh-CN,zh;q=0.9,en;q=0.8\r\n";
  if (hostLooksLikeNetEase(source)) {
    headers += "Referer: https://music.163.com/\r\n";
  }
  return headers;
}

AVSampleFormat swrSampleFormatFor(AudioSampleFormat format) {
  switch (format) {
    case AudioSampleFormat::Int16Interleaved:
      return AV_SAMPLE_FMT_S16;
    case AudioSampleFormat::Int24Interleaved:
    case AudioSampleFormat::Int24In32Interleaved:
    case AudioSampleFormat::Int32Interleaved:
      return AV_SAMPLE_FMT_S32;
    case AudioSampleFormat::Float32Interleaved:
    default:
      return AV_SAMPLE_FMT_FLT;
  }
}

bool isTypedIntegerFormat(AudioSampleFormat format) {
  return format == AudioSampleFormat::Int16Interleaved || format == AudioSampleFormat::Int24Interleaved ||
         format == AudioSampleFormat::Int24In32Interleaved || format == AudioSampleFormat::Int32Interleaved;
}

}  // namespace
#endif

struct FFmpegDecoder::Impl {
  int (*interrupt)(void*) = nullptr;
  void* interruptContext = nullptr;
  bool remoteIo = false;
  std::chrono::steady_clock::time_point ioDeadline{};

  static int interruptIo(void* context) {
    const auto* impl = static_cast<const Impl*>(context);
    return (impl->interrupt && impl->interrupt(impl->interruptContext)) ||
        (impl->remoteIo && impl->ioDeadline != std::chrono::steady_clock::time_point{} &&
         std::chrono::steady_clock::now() >= impl->ioDeadline);
  }

  // Each remote operation has a total deadline, including FFmpeg reconnects.
  // Idle time between reads (a full PCM ring / paused playback) is excluded.
  struct IoBudget {
    Impl& impl;
    std::chrono::steady_clock::time_point previous;
    IoBudget(Impl& value, std::chrono::seconds duration) : impl(value), previous(value.ioDeadline) {
      if (impl.remoteIo) {
        const auto deadline = std::chrono::steady_clock::now() + duration;
        impl.ioDeadline = previous == std::chrono::steady_clock::time_point{}
            ? deadline : std::min(previous, deadline);
      }
    }
    ~IoBudget() { impl.ioDeadline = previous; }
  };
  std::shared_ptr<const SeekableInputFactory> inputFactory;
  std::shared_ptr<SeekableInput> customInput;
  AudioStreamInfo streamInfo;
  AudioFormat outputFormat;
  bool eof = false;
  std::string terminalReadError;
  FFmpegDecoder::ResamplerQuality resamplerQuality = FFmpegDecoder::ResamplerQuality::Native;
  FFmpegDecoder::ResamplerQuality effectiveResamplerQuality = FFmpegDecoder::ResamplerQuality::Native;
  FFmpegDecoder::ResamplerPhase resamplerPhase = FFmpegDecoder::ResamplerPhase::Linear;
  FFmpegDecoder::ResamplerPhase effectiveResamplerPhase = FFmpegDecoder::ResamplerPhase::Linear;
  FFmpegDecoder::ResamplerEngine resamplerEngine = FFmpegDecoder::ResamplerEngine::Unknown;
  // ICY StreamTitle snapshot (decode-thread writes; control/status may read).
  mutable std::mutex streamTitleMutex;
  std::string streamTitle;

#if defined(TAE_HAS_FFMPEG)
  AVFormatContext* formatContext = nullptr;
  FFmpegFileInput fileInput;
  AVIOContext* customIo = nullptr;
  int64_t inputPosition = 0;

  static int readInput(void* context, uint8_t* bytes, int count) {
    auto& self = *static_cast<Impl*>(context);
    if (interruptIo(&self)) return AVERROR_EXIT;
    auto input = std::atomic_load(&self.customInput);
    const int read = input ? input->readAt(self.inputPosition, bytes, count) : -1;
    if (interruptIo(&self)) return AVERROR_EXIT;
    if (read > 0 && read <= count) { self.inputPosition += read; return read; }
    return read == 0 ? AVERROR_EOF : AVERROR(EIO);
  }

  static int64_t seekInput(void* context, int64_t offset, int whence) {
    auto& self = *static_cast<Impl*>(context);
    if (interruptIo(&self)) return AVERROR_EXIT;
    auto input = std::atomic_load(&self.customInput);
    if (!input) return AVERROR(EIO);
    whence &= ~AVSEEK_FORCE;
    if (whence == AVSEEK_SIZE) return input->size();
    int64_t base = whence == SEEK_SET ? 0 : whence == SEEK_CUR ? self.inputPosition :
        whence == SEEK_END ? input->size() : -1;
    if (base < 0 || (offset > 0 && base > std::numeric_limits<int64_t>::max() - offset) ||
        (offset < 0 && offset < -base)) return AVERROR(EINVAL);
    self.inputPosition = base + offset;
    return self.inputPosition;
  }
  AVCodecContext* codecContext = nullptr;
  AVPacket* packet = nullptr;
  AVFrame* frame = nullptr;
  SwrContext* swr = nullptr;
  int audioStreamIndex = -1;
  bool inputEof = false;
  bool resamplerFlushed = false;
  uint64_t declaredFlacSamples = 0;
  std::optional<uint64_t> decodedFlacEndSample = uint64_t{0};
  bool flacSampleTimelineValid = true;
  bool flacAfterSeek = false;
  bool icyEnabled = false;
  std::vector<uint8_t> pending;
  std::vector<uint8_t> convertedScratch;
  size_t pendingFrameOffset = 0;
  bool exactSeek = false;
  bool exactFromStart = false;
  uint64_t exactTarget = 0;
  std::optional<int64_t> exactInputCursor;
  int64_t exactOutputCursor = 0;
  AVChannelLayout targetLayout{};

  static std::string avError(int code) {
    char buffer[AV_ERROR_MAX_STRING_SIZE] = {};
    av_strerror(code, buffer, sizeof(buffer));
    return buffer;
  }

  void resetPending() {
    pending.clear();
    pendingFrameOffset = 0;
  }

  static std::string dictValue(AVDictionary* metadata, const char* key) {
    if (!metadata || !key) return {};
    const AVDictionaryEntry* entry = av_dict_get(metadata, key, nullptr, 0);
    if (!entry || !entry->value) return {};
    return entry->value;
  }

  static std::string extractStreamTitle(AVDictionary* metadata) {
    if (!metadata) return {};
    // ICY StreamTitle is the primary radio metadata field; fall back to common tags.
    const char* keys[] = {"StreamTitle", "icy-title", "title", "TITLE", "streamtitle"};
    for (const char* key : keys) {
      std::string value = dictValue(metadata, key);
      if (!value.empty()) return value;
    }
    return {};
  }

  void refreshStreamTitleFromContext() {
    if (!formatContext) return;
    std::string title = extractStreamTitle(formatContext->metadata);
    if (title.empty() && audioStreamIndex >= 0 &&
        audioStreamIndex < static_cast<int>(formatContext->nb_streams) &&
        formatContext->streams[audioStreamIndex]) {
      title = extractStreamTitle(formatContext->streams[audioStreamIndex]->metadata);
    }
    if (title.empty()) return;
    // Trim whitespace / control characters common in ICY payloads.
    while (!title.empty() &&
           (static_cast<unsigned char>(title.front()) <= 0x20 || title.front() == '\'')) {
      title.erase(title.begin());
    }
    while (!title.empty() &&
           (static_cast<unsigned char>(title.back()) <= 0x20 || title.back() == '\'')) {
      title.pop_back();
    }
    if (title.empty()) return;
    std::lock_guard lock(streamTitleMutex);
    if (streamTitle != title) streamTitle = std::move(title);
  }

  void close() {
    resamplerEngine = FFmpegDecoder::ResamplerEngine::Unknown;
    if (swr) {
      swr_free(&swr);
    }
    av_channel_layout_uninit(&targetLayout);
    if (frame) {
      av_frame_free(&frame);
    }
    if (packet) {
      av_packet_free(&packet);
    }
    if (codecContext) {
      avcodec_free_context(&codecContext);
    }
    if (formatContext) {
      avformat_close_input(&formatContext);
    }
    if (customIo) {
      av_freep(&customIo->buffer);
      avio_context_free(&customIo);
    }
    std::atomic_store(&customInput, std::shared_ptr<SeekableInput>{});
    fileInput.close();
    audioStreamIndex = -1;
    inputEof = false;
    resamplerFlushed = false;
    declaredFlacSamples = 0;
    decodedFlacEndSample = uint64_t{0};
    flacSampleTimelineValid = true;
    flacAfterSeek = false;
    icyEnabled = false;
    eof = false;
    terminalReadError.clear();
    resetPending();
    exactSeek = false;
    exactInputCursor.reset();
    streamInfo = {};
    outputFormat = {};
    {
      std::lock_guard lock(streamTitleMutex);
      streamTitle.clear();
    }
  }

  // Drains whatever the resampler still holds once the decoder has run dry. swr keeps up
  // to a filter-length of history buffered, so without this the tail of every resampled
  // track is silently dropped -- and an input shorter than the filter (Ultra uses
  // filter_size 64) decodes to nothing at all.
  bool flushResampler(std::string* error) {
    if (!swr || !codecContext) return true;
    const int pendingOut = swr_get_out_samples(swr, 0);
    if (pendingOut <= 0) return true;
    return convertSamples(nullptr, 0, pendingOut, error);
  }

  bool convertFrame(std::string* error) {
    if (!swr) {
      if (error) *error = "解码重采样器尚未初始化";
      return false;
    }

    int skip = 0;
    if (exactSeek) {
      const auto* stream = formatContext->streams[audioStreamIndex];
      const int64_t pts = frame->best_effort_timestamp;
      if (pts == AV_NOPTS_VALUE || codecContext->sample_rate <= 0) {
        if (error) *error = "Precise PCM seek requires frame timestamps";
        return false;
      }
      const auto origin = stream->start_time == AV_NOPTS_VALUE ? 0 : stream->start_time;
      int64_t first = av_rescale_q_rnd(pts - origin, stream->time_base,
          AVRational{1, codecContext->sample_rate}, AV_ROUND_NEAR_INF);
      if (!exactInputCursor) {
        // Some codecs have already removed priming samples without updating
        // the first frame PTS (FFmpeg's skipped-samples warning). At source
        // start the decoded first sample is the same sample as normal open.
        if (exactFromStart) first = 0;
        // Start on the global rational resampling grid. After preroll, the
        // filter phase matches decoding from source time zero.
        const int period = codecContext->sample_rate /
            std::gcd(codecContext->sample_rate, outputFormat.sampleRate);
        const int64_t aligned = std::max<int64_t>(0, first + period - 1) / period * period;
        if (aligned - first >= frame->nb_samples) return true;
        skip = static_cast<int>(aligned - first);
        exactInputCursor = aligned;
        exactOutputCursor = aligned / period *
            (outputFormat.sampleRate / std::gcd(codecContext->sample_rate, outputFormat.sampleRate));
      } else if (std::abs(first - *exactInputCursor) > 1) {
        if (error) *error = "Precise PCM seek encountered discontinuous timestamps";
        return false;
      }
      *exactInputCursor = first + frame->nb_samples;
    }
    const int inputSamples = frame->nb_samples - skip;
    const int outSamples = static_cast<int>(av_rescale_rnd(
        swr_get_delay(swr, codecContext->sample_rate) + inputSamples,
        outputFormat.sampleRate,
        codecContext->sample_rate,
        AV_ROUND_UP));
    if (outSamples <= 0) return true;
    if (!skip) return convertSamples(
        const_cast<const uint8_t**>(frame->extended_data), inputSamples, outSamples, error);
    const bool planar = av_sample_fmt_is_planar(codecContext->sample_fmt);
    const int planes = planar ? codecContext->ch_layout.nb_channels : 1;
    std::vector<const uint8_t*> input(planes);
    const size_t stride = av_get_bytes_per_sample(codecContext->sample_fmt) *
        (planar ? 1 : codecContext->ch_layout.nb_channels);
    for (int channel = 0; channel < planes; ++channel) input[channel] = frame->extended_data[channel] + skip * stride;
    return convertSamples(input.data(), inputSamples, outSamples, error);
  }

  // inputData == nullptr / inputSamples == 0 flushes the resampler instead of feeding it.
  bool convertSamples(const uint8_t** inputData, int inputSamples, int outSamples, std::string* error) {
    const int channels = std::max(1, outputFormat.channelCount);
    const AVSampleFormat swrOutputFormat = swrSampleFormatFor(outputFormat.sampleFormat);
    const size_t swrBytesPerSample = static_cast<size_t>(std::max(1, av_get_bytes_per_sample(swrOutputFormat)));
    const size_t outputSamples = static_cast<size_t>(outSamples) * static_cast<size_t>(channels);
    const bool directPendingWrite = ffmpeg::canDirectWriteConvertedSamples(outputFormat.sampleFormat);
    const size_t pendingStart = pending.size();
    uint8_t* directOutput = directPendingWrite
                                ? ffmpeg::resizePendingForDirectWrite(pending, outputSamples, outputFormat.sampleFormat)
                                : nullptr;
    if (!directPendingWrite) {
      convertedScratch.resize(outputSamples * swrBytesPerSample);
    }
    uint8_t* outData[] = {directPendingWrite ? directOutput : convertedScratch.data()};
    const int actualSamples = swr_convert(swr, outData, outSamples, inputData, inputSamples);
    if (actualSamples < 0) {
      if (directPendingWrite) pending.resize(pendingStart);
      if (error) *error = "解码重采样失败，错误码：" + std::to_string(actualSamples);
      return false;
    }

    const size_t actualOutputSamples = static_cast<size_t>(actualSamples) * static_cast<size_t>(channels);
    if (directPendingWrite) {
      ffmpeg::commitPendingDirectWrite(pending, pendingStart, actualOutputSamples, outputFormat.sampleFormat);
    } else {
      ffmpeg::appendConvertedSamples(
          convertedScratch.data(),
          actualOutputSamples,
          outputFormat.sampleFormat,
          &pending);
    }
    if (exactSeek) {
      if (exactOutputCursor < 0 || static_cast<uint64_t>(exactOutputCursor) > exactTarget) {
        if (error) *error = "Precise PCM seek began beyond the requested frame";
        resetPending(); return false;
      }
      const uint64_t remaining = exactTarget - static_cast<uint64_t>(exactOutputCursor);
      exactOutputCursor += actualSamples;
      if (remaining >= static_cast<uint64_t>(actualSamples)) {
        resetPending();
      } else {
        pendingFrameOffset = static_cast<size_t>(remaining);
        exactSeek = false;
      }
    }
    return true;
  }

  // Runs the resampler drain exactly once per stream, so the EOF exits below cannot loop
  // on a flush that keeps reporting leftovers.
  bool drainResamplerOnce(std::string* error) {
    if (resamplerFlushed) return true;
    resamplerFlushed = true;
    return flushResampler(error);
  }

  void recordFlacFrame() {
    if (declaredFlacSamples == 0 || !flacSampleTimelineValid) return;
    if (flacAfterSeek) {
      // Anchor to decoded source samples, not the requested seek time or a
      // rounded duration. Each following frame must continue that sample grid.
      const AVStream* stream = formatContext->streams[audioStreamIndex];
      const int64_t pts = frame->best_effort_timestamp;
      const int64_t origin = stream->start_time == AV_NOPTS_VALUE ? 0 : stream->start_time;
      const AVRational sampleTimeBase{1, codecContext->sample_rate};
      if (pts == AV_NOPTS_VALUE || pts < origin || codecContext->sample_rate <= 0 ||
          stream->time_base.num <= 0 || stream->time_base.den <= 0 ||
          av_cmp_q(stream->time_base, sampleTimeBase) > 0) {
        flacSampleTimelineValid = false;
        return;
      }
      const int64_t sample = av_rescale_q(pts - origin, stream->time_base, sampleTimeBase);
      if (sample < 0 || av_rescale_q(sample, sampleTimeBase, stream->time_base) != pts - origin ||
          (decodedFlacEndSample && *decodedFlacEndSample != static_cast<uint64_t>(sample))) {
        flacSampleTimelineValid = false;
        return;
      }
      decodedFlacEndSample = static_cast<uint64_t>(sample);
    }
    if (!decodedFlacEndSample || *decodedFlacEndSample > declaredFlacSamples || frame->nb_samples <= 0 ||
        static_cast<uint64_t>(frame->nb_samples) > declaredFlacSamples - *decodedFlacEndSample) {
      flacSampleTimelineValid = false;
      return;
    }
    *decodedFlacEndSample += frame->nb_samples;
  }

  bool decodeOneFrame(std::string* error) {
    resetPending();
    if (eof) return false;

    while (true) {
      int ret = avcodec_receive_frame(codecContext, frame);
      if (ret == 0) {
        recordFlacFrame();
        const bool ok = convertFrame(error);
        av_frame_unref(frame);
        if (!ok) return failRead(error && !error->empty() ? *error : "Audio frame conversion failed", error);
        if (pending.empty()) {
          continue;
        }
        return true;
      }
      if (ret == AVERROR_EOF) {
        if (!drainResamplerOnce(error)) return failRead(error && !error->empty() ? *error : "Audio resampler flush failed", error);
        if (!pending.empty()) return true;
        eof = true;
        return false;
      }
      if (ret != AVERROR(EAGAIN)) {
        if (isCompletedFlacTail(ret)) return finishCompletedFlacTail(error);
        return failRead("Audio decoder receive failed, code: " + std::to_string(ret), error);
      }

      if (inputEof) {
        ret = avcodec_send_packet(codecContext, nullptr);
        if (ret == AVERROR_EOF) {
          if (!drainResamplerOnce(error)) return failRead(error && !error->empty() ? *error : "Audio resampler flush failed", error);
          if (!pending.empty()) return true;
          eof = true;
          return false;
        }
        if (ret < 0 && ret != AVERROR(EAGAIN)) {
          return failRead("Audio decoder flush failed, code: " + std::to_string(ret), error);
        }
        continue;
      }

      ret = av_read_frame(formatContext, packet);
      if (ret < 0) {
        if (ret != AVERROR_EOF) {
          DiagnosticLog::instance().append(DiagLevel::Error, "ffmpeg.read.failed", "read failed",
              "{\"code\":" + std::to_string(ret) + ",\"timeoutOrCancel\":" + (ret == AVERROR_EXIT ? "true" : "false") + "}");
          return failRead("Audio source read failed, code: " + std::to_string(ret), error);
        }
        inputEof = true;
        continue;
      }

      // ICY metadata can land in format-context tags between packets on live streams.
      if (icyEnabled) refreshStreamTitleFromContext();

      if (packet->stream_index == audioStreamIndex) {
        ret = avcodec_send_packet(codecContext, packet);
        av_packet_unref(packet);
        if (ret < 0 && ret != AVERROR(EAGAIN)) {
          if (isCompletedFlacTail(ret)) return finishCompletedFlacTail(error);
          return failRead("Audio decoder send failed, code: " + std::to_string(ret), error);
        }
      } else {
        av_packet_unref(packet);
      }
    }
  }
  bool isCompletedFlacTail(int code) const {
    // Only tolerate invalid data beyond the exact STREAMINFO sample boundary.
    // After a seek, decoded frame timestamps establish the source position.
    return code == AVERROR_INVALIDDATA && flacSampleTimelineValid &&
        declaredFlacSamples > 0 && decodedFlacEndSample == declaredFlacSamples;
  }
  bool finishCompletedFlacTail(std::string* error) {
    DiagnosticLog::instance().append(DiagLevel::Warning, "ffmpeg.flac.trailing-data",
        "Ignored invalid trailing data after decoded audio reached the declared FLAC sample boundary",
        "{\"decodedEndSample\":" + std::to_string(*decodedFlacEndSample) +
        ",\"declaredSamples\":" + std::to_string(declaredFlacSamples) +
        ",\"afterSeek\":" + (flacAfterSeek ? "true" : "false") + "}");
    if (!drainResamplerOnce(error))
      return failRead(error && !error->empty() ? *error : "Audio resampler flush failed", error);
    eof = true;
    return !pending.empty();
  }
  bool failRead(const std::string& message, std::string* error) {
    terminalReadError = message;
    eof = false;
    if (error) *error = terminalReadError;
    return false;
  }
#else
  void close() {
    streamInfo = {};
    outputFormat = {};
    eof = false;
    terminalReadError.clear();
    {
      std::lock_guard lock(streamTitleMutex);
      streamTitle.clear();
    }
  }

  void refreshStreamTitleFromContext() {}
#endif
};

FFmpegDecoder::FFmpegDecoder() : impl_(std::make_unique<Impl>()) {}

FFmpegDecoder::~FFmpegDecoder() {
  close();
}

void FFmpegDecoder::setInterrupt(int (*callback)(void*), void* context) {
  impl_->interrupt = callback;
  impl_->interruptContext = context;
}

void FFmpegDecoder::setInputFactory(std::shared_ptr<const SeekableInputFactory> factory) {
  impl_->inputFactory = std::move(factory);
}

bool FFmpegDecoder::cancelInput() {
  auto input = std::atomic_load(&impl_->customInput);
  if (!input) return false;
  input->cancel();
  return true;
}

bool FFmpegDecoder::open(const std::string& source, std::string* error) {
  close();
  impl_->remoteIo = source.find("://") != std::string::npos && source.rfind("file://", 0) != 0;
  Impl::IoBudget ioBudget(*impl_, std::chrono::seconds(15));
  if (impl_->interrupt && impl_->interrupt(impl_->interruptContext)) {
    if (error) *error = "decode_cancelled";
    return false;
  }

#if defined(TAE_HAS_FFMPEG)
  // Every failed open must release its partially allocated IO and decoder.
  const auto cleanup = [](Impl* impl) { impl->close(); };
  std::unique_ptr<Impl, decltype(cleanup)> failedOpen(impl_.get(), cleanup);
  if (sourceLooksSacdIso(source)) {
    const SacdIsoEntryProbe probe = probeSacdIsoEntry(source);
    const SacdDstProviderSelection dstProvider = selectSacdDstProvider(avcodec_find_decoder_by_name(kSacdDstCodecName) != nullptr, nullptr);
    if (error) {
      *error = probe.reason.empty() ? kSacdIsoUnsupportedReason : probe.reason;
      if (!dstProvider.available && !dstProvider.reason.empty()) {
        *error += "; " + dstProvider.reason;
      }
    }
    return false;
  }

  // Recovery on decode workers can open concurrently with control-path preload.
  static const int networkInitResult = avformat_network_init();
  if (networkInitResult < 0) {
    if (error) *error = "FFmpeg network initialization failed, code: " + std::to_string(networkInitResult);
    return false;
  }

  // Enable ICY metadata for live HTTP(S) radio streams so StreamTitle updates appear.
  const bool looksHttp =
      source.rfind("http://", 0) == 0 || source.rfind("https://", 0) == 0 ||
      source.rfind("HTTP://", 0) == 0 || source.rfind("HTTPS://", 0) == 0;
  AVDictionary* openOptions = nullptr;
  if (looksHttp) {
    av_dict_set(&openOptions, "icy", "1", 0);
    // Prefer reconnect behavior for flaky radio CDNs without blocking open forever.
    av_dict_set(&openOptions, "reconnect", "1", 0);
    av_dict_set(&openOptions, "reconnect_streamed", "1", 0);
    av_dict_set(&openOptions, "reconnect_delay_max", "5", 0);
    av_dict_set(&openOptions, "rw_timeout", "10000000", 0);
    // NetEase (and many CDNs) reject bare FFmpeg clients. Attach a browser-like
    // UA and, for NetEase hosts, the music.163.com Referer so stream open succeeds.
    av_dict_set(
        &openOptions,
        "user_agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36",
        0);
    av_dict_set(&openOptions, "headers", buildHttpOpenHeaders(source).c_str(), 0);
    impl_->icyEnabled = true;
  }

  // Highly periodic PCM can outscore WAV in FFmpeg's generic MPEG-TS probe.
  // Prefer WAV only after validating the local container signature; a renamed
  // non-WAV file and all network sources retain ordinary format discovery.
  const AVInputFormat* inputFormat = nullptr;
  if (!looksHttp && (extensionOf(source) == "wav" || extensionOf(source) == "wave")) {
    std::array<char, 12> header{};
    SharedInputFile input(utf8Path(source), std::ios::binary);
    input.read(header.data(), header.size());
    if (input.gcount() == static_cast<std::streamsize>(header.size()) &&
        (std::memcmp(header.data(), "RIFF", 4) == 0 || std::memcmp(header.data(), "RF64", 4) == 0 ||
         std::memcmp(header.data(), "RIFX", 4) == 0) && std::memcmp(header.data() + 8, "WAVE", 4) == 0) {
      inputFormat = av_find_input_format("wav");
    }
  }
  if (impl_->inputFactory) std::atomic_store(&impl_->customInput, (*impl_->inputFactory)(source));
  if (std::atomic_load(&impl_->customInput)) {
    auto* buffer = static_cast<unsigned char*>(av_malloc(32768));
    if (!buffer) { av_dict_free(&openOptions); if (error) *error = "Cannot allocate input buffer"; return false; }
    impl_->customIo = avio_alloc_context(buffer, 32768, 0, impl_.get(), Impl::readInput, nullptr, Impl::seekInput);
    if (!impl_->customIo) { av_free(buffer); av_dict_free(&openOptions); return false; }
    impl_->inputPosition = 0;
    impl_->formatContext = avformat_alloc_context();
    if (!impl_->formatContext) {
      av_dict_free(&openOptions);
      if (error) *error = "Cannot allocate input context";
      close();
      return false;
    }
    impl_->formatContext->pb = impl_->customIo;
    impl_->formatContext->flags |= AVFMT_FLAG_CUSTOM_IO;
  } else if (!impl_->fileInput.open(source, &impl_->formatContext)) {
    av_dict_free(&openOptions);
    if (error) *error = "无法打开本地音频文件";
    return false;
  }
  if (!impl_->formatContext) impl_->formatContext = avformat_alloc_context();
  if (!impl_->formatContext) {
    av_dict_free(&openOptions);
    if (error) *error = "Cannot allocate demuxer";
    return false;
  }
  impl_->formatContext->interrupt_callback = {Impl::interruptIo, impl_.get()};
  int ret = avformat_open_input(&impl_->formatContext, impl_->customIo ? nullptr : source.c_str(), inputFormat, &openOptions);
  av_dict_free(&openOptions);
  if (ret < 0) {
    if (error) *error = "打开音频失败，错误码：" + std::to_string(ret);
    DiagnosticLog::instance().append(DiagLevel::Error, "ffmpeg.open.failed", "open failed", "{\"code\":" + std::to_string(ret) + "}");
    return false;
  }

  ret = avformat_find_stream_info(impl_->formatContext, nullptr);
  if (ret < 0) {
    if (error) *error = "解析音频信息失败，错误码：" + std::to_string(ret);
    DiagnosticLog::instance().append(DiagLevel::Error, "ffmpeg.probe.failed", "probe failed", "{\"code\":" + std::to_string(ret) + "}");
    return false;
  }

  ret = av_find_best_stream(impl_->formatContext, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
  if (ret < 0) {
    if (error) *error = "未找到音频流";
    return false;
  }
  impl_->audioStreamIndex = ret;

  AVStream* stream = impl_->formatContext->streams[impl_->audioStreamIndex];
  const AVCodecParameters* params = stream->codecpar;
  if (params->codec_id == AV_CODEC_ID_FLAC && params->extradata && params->extradata_size == 34) {
    const uint8_t* info = params->extradata;
    impl_->declaredFlacSamples = (static_cast<uint64_t>(info[13] & 0x0f) << 32) |
        (static_cast<uint64_t>(info[14]) << 24) | (static_cast<uint64_t>(info[15]) << 16) |
        (static_cast<uint64_t>(info[16]) << 8) | info[17];
  }
  const AVCodec* codec = avcodec_find_decoder(params->codec_id);
  if (!codec) {
    if (error) *error = "当前音频格式没有可用解码器";
    return false;
  }

  impl_->codecContext = avcodec_alloc_context3(codec);
  if (!impl_->codecContext) {
    if (error) *error = "无法分配解码器上下文";
    return false;
  }

  ret = avcodec_parameters_to_context(impl_->codecContext, params);
  if (ret < 0) {
    if (error) *error = "无法读取解码参数，错误码：" + std::to_string(ret);
    return false;
  }

  ret = avcodec_open2(impl_->codecContext, codec, nullptr);
  if (ret < 0) {
    if (error) *error = "无法打开解码器，错误码：" + std::to_string(ret);
    return false;
  }

  impl_->packet = av_packet_alloc();
  impl_->frame = av_frame_alloc();
  if (!impl_->packet || !impl_->frame) {
    if (error) *error = "无法分配解码缓冲";
    return false;
  }

  const int parameterChannels = params->ch_layout.nb_channels;
  const int decodedChannels = impl_->codecContext->ch_layout.nb_channels;
  const int channels = std::max(1, parameterChannels > 0 ? parameterChannels : decodedChannels);
  const int rawBitDepth = params->bits_per_raw_sample > 0
                              ? params->bits_per_raw_sample
                              : (params->bits_per_coded_sample > 0 ? params->bits_per_coded_sample : 0);
  const int decodedBitDepth = sampleBitDepth(impl_->codecContext->sample_fmt);
  const AVCodecDescriptor* descriptor = avcodec_descriptor_get(params->codec_id);
  const std::string codecName = codec->name ? codec->name : "未知";
  const std::string containerName =
      impl_->formatContext->iformat
          ? (impl_->formatContext->iformat->long_name ? impl_->formatContext->iformat->long_name
                                                      : (impl_->formatContext->iformat->name ? impl_->formatContext->iformat->name : ""))
          : "";
  bool wavPackDsd = false;
  if (!impl_->remoteIo && params->codec_id == AV_CODEC_ID_WAVPACK) {
    // Read only the local block header; never infer DSD from a high PCM rate.
    std::array<uint8_t, 32> header{};
    SharedInputFile input(utf8Path(source), std::ios::binary);
    input.read(reinterpret_cast<char*>(header.data()), header.size());
    wavPackDsd = ffmpeg::wavPackHeaderIsDsd(header.data(), static_cast<size_t>(input.gcount()));
  }
  const bool sourceDsd = wavPackDsd || codecLooksDsd(params->codec_id, codecName, containerName, extensionOf(source));
  const bool dopCarrier = sourceDsd && (textMentions(codecName, "dop") || textMentions(containerName, "dop"));
  const int reportedSampleRate = params->sample_rate > 0 ? params->sample_rate : impl_->codecContext->sample_rate;
  // Raw-DSD demuxers report the post-decimation PCM rate; the engine wants the DSD bit
  // rate here. See FFmpegDsdRate.h.
  const int sourceSampleRate = wavPackDsd
                                   ? reportedSampleRate * ffmpeg::kDsdBitsPerByte
                                   : ffmpeg::dsdSampleRateFromCodecRate(params->codec_id, reportedSampleRate);

  impl_->streamInfo.source = source;
  impl_->streamInfo.codec = codecName;
  impl_->streamInfo.bitrate =
      params->bit_rate > 0 ? params->bit_rate : impl_->formatContext->bit_rate;
  impl_->streamInfo.sourceFormat.sampleRate = sourceSampleRate;
  impl_->streamInfo.sourceFormat.channelCount = channels;
  impl_->streamInfo.sourceFormat.bitDepth = sourceDsd ? 1 : (rawBitDepth > 0 ? rawBitDepth : decodedBitDepth);
  impl_->streamInfo.sourceFormat.sampleFormat =
      sourceDsd ? AudioSampleFormat::Float32Interleaved : sourceSampleFormat(rawBitDepth, impl_->codecContext->sample_fmt);
  impl_->streamInfo.decodedFormat = impl_->streamInfo.sourceFormat;
  impl_->streamInfo.sourceLossless = sourceDsd || codecLooksLossless(descriptor, codecName);
  impl_->streamInfo.isDsd = sourceDsd;
  impl_->streamInfo.dsdMode = sourceDsd ? DsdMode::Pcm : DsdMode::Pcm;
  impl_->streamInfo.dsdRate = sourceDsd ? inferDsdRate(sourceSampleRate, dopCarrier) : 0;
  readReplayGainDictionary(impl_->formatContext->metadata, &impl_->streamInfo.replayGain);
  readReplayGainDictionary(stream->metadata, &impl_->streamInfo.replayGain);

  if (stream->duration != AV_NOPTS_VALUE) {
    impl_->streamInfo.durationSeconds = static_cast<double>(stream->duration) * av_q2d(stream->time_base);
  } else if (impl_->formatContext->duration != AV_NOPTS_VALUE) {
    impl_->streamInfo.durationSeconds =
        static_cast<double>(impl_->formatContext->duration) / static_cast<double>(AV_TIME_BASE);
  }

  impl_->refreshStreamTitleFromContext();
  {
    std::lock_guard lock(impl_->streamTitleMutex);
    impl_->streamInfo.streamTitle = impl_->streamTitle;
  }

  AudioFormat defaultOutput = impl_->streamInfo.sourceFormat;
  if (sourceDsd && impl_->codecContext->sample_rate > 0) {
    defaultOutput.sampleRate = impl_->codecContext->sample_rate;
    defaultOutput.bitDepth = 32;
    defaultOutput.sampleFormat = AudioSampleFormat::Float32Interleaved;
  }
  if (!setOutputFormat(defaultOutput, error)) return false;
  failedOpen.release();
  return true;
#else
  (void)source;
  if (error) *error = "当前构建未启用音频解码支持";
  return false;
#endif
}

void FFmpegDecoder::close() {
  impl_->close();
}

bool FFmpegDecoder::setOutputFormat(const AudioFormat& format, std::string* error) {
#if defined(TAE_HAS_FFMPEG)
  if (!impl_->codecContext) {
    if (error) *error = "解码器尚未打开";
    return false;
  }
  if (format.sampleRate <= 0 || format.channelCount <= 0) {
    if (error) *error = "请求的输出格式无效";
    return false;
  }
  if (impl_->streamInfo.isDsd && isTypedIntegerFormat(format.sampleFormat)) {
    if (error) *error = "DSD PCM fallback 只能输出 Float32 工作格式";
    return false;
  }

  if (impl_->swr) {
    swr_free(&impl_->swr);
  }
  av_channel_layout_uninit(&impl_->targetLayout);
  av_channel_layout_default(&impl_->targetLayout, format.channelCount);

  const auto allocateSwr = [&]() -> int {
    if (impl_->swr) swr_free(&impl_->swr);
    return swr_alloc_set_opts2(
        &impl_->swr,
        &impl_->targetLayout,
        swrSampleFormatFor(format.sampleFormat),
        format.sampleRate,
        &impl_->codecContext->ch_layout,
        impl_->codecContext->sample_fmt,
        impl_->codecContext->sample_rate,
        0,
        nullptr);
  };
  const auto applySwrQuality = [&](ResamplerQuality quality) {
    const bool smoothRolloff = impl_->resamplerPhase == ResamplerPhase::LinearSmooth ||
                               impl_->resamplerPhase == ResamplerPhase::MinimumSmooth;
    switch (quality) {
      case ResamplerQuality::Ultra:
        av_opt_set_int(impl_->swr, "filter_size", 128, 0);
        av_opt_set_int(impl_->swr, "phase_shift", 10, 0);
        av_opt_set_double(impl_->swr, "cutoff", smoothRolloff ? 0.91 : 0.96, 0);
        break;
      case ResamplerQuality::High:
        av_opt_set_int(impl_->swr, "filter_size", 64, 0);
        av_opt_set_int(impl_->swr, "phase_shift", 10, 0);
        av_opt_set_double(impl_->swr, "cutoff", smoothRolloff ? 0.91 : 0.94, 0);
        break;
      case ResamplerQuality::Native:
      default:
        av_opt_set_int(impl_->swr, "filter_size", 16, 0);
        av_opt_set_int(impl_->swr, "phase_shift", 8, 0);
        av_opt_set_double(impl_->swr, "cutoff", 0.90, 0);
        break;
    }
  };

  int ret = allocateSwr();
  if (ret < 0 || !impl_->swr) {
    if (error) *error = "无法分配解码重采样器";
    return false;
  }

  const bool wantsSoxr = impl_->resamplerQuality == ResamplerQuality::SoxrHq ||
                         impl_->resamplerQuality == ResamplerQuality::SoxrVhq;
  bool initialized = false;
  if (wantsSoxr && soxrRuntimeAvailability() != SoxrRuntimeState::Unavailable) {
    // Probe the SoX engine at runtime. FFmpeg accepts the "resampler"/"engine"
    // option name even when libsoxr is absent — the failure only shows up at
    // swr_init ("Requested resampling engine is unavailable").
    const int engineSet = av_opt_set(impl_->swr, "resampler", "soxr", 0);
    if (engineSet >= 0) {
      av_opt_set_int(
          impl_->swr,
          "precision",
          impl_->resamplerQuality == ResamplerQuality::SoxrVhq ? 28 : 20,
          0);
      if (swr_init(impl_->swr) >= 0) {
        initialized = true;
        reportSoxrRuntimeAvailability(true);
      }
    }
    if (!initialized) {
      reportSoxrRuntimeAvailability(false);
      // Recreate with the default swr engine; a failed init leaves the
      // context poisoned with the unavailable engine selection.
      ret = allocateSwr();
      if (ret < 0 || !impl_->swr) {
        if (error) *error = "无法分配解码重采样器";
        return false;
      }
    }
  }

  if (!initialized) {
    // Soxr tiers degrade to the strongest built-in swr settings when the
    // engine is unavailable, keeping playback honest instead of failing.
    applySwrQuality(wantsSoxr ? ResamplerQuality::Ultra : impl_->resamplerQuality);
    ret = swr_init(impl_->swr);
    if (ret < 0) {
      if (error) *error = "无法初始化解码重采样器，错误码：" + std::to_string(ret);
      return false;
    }
  }

  impl_->outputFormat = format;
  if (impl_->outputFormat.bitDepth <= 0) {
    impl_->outputFormat.bitDepth = effectivePcmBitDepth(impl_->outputFormat);
  }
  impl_->streamInfo.decodedFormat = impl_->outputFormat;
  impl_->effectiveResamplerQuality = wantsSoxr && !initialized ? ResamplerQuality::Ultra : impl_->resamplerQuality;
  impl_->resamplerEngine = format.sampleRate == impl_->codecContext->sample_rate
      ? ResamplerEngine::None : initialized ? ResamplerEngine::Soxr : ResamplerEngine::Swr;
  // phase_shift is the polyphase table resolution, not a phase response.
  // SWR is linear phase; FFmpeg's SoX wrapper also uses the default linear
  // response. Only the High/Ultra SWR tiers apply our smooth cutoff.
  const bool smooth = impl_->resamplerPhase == ResamplerPhase::LinearSmooth ||
                      impl_->resamplerPhase == ResamplerPhase::MinimumSmooth;
  impl_->effectiveResamplerPhase = !initialized && smooth &&
      impl_->effectiveResamplerQuality != ResamplerQuality::Native
      ? ResamplerPhase::LinearSmooth : ResamplerPhase::Linear;
  // A brand new swr context has nothing buffered yet, so the drain has to be re-armed.
  impl_->resamplerFlushed = false;
  impl_->resetPending();
  return true;
#else
  (void)format;
  if (error) *error = "当前构建未启用音频解码支持";
  return false;
#endif
}

void FFmpegDecoder::setResamplerQuality(ResamplerQuality quality) {
  impl_->resamplerQuality = quality;
}

void FFmpegDecoder::setResamplerPhase(ResamplerPhase phase) {
  impl_->resamplerPhase = phase;
}

size_t FFmpegDecoder::readFrames(float* output, size_t frameCount, std::string* error) {
  if (!output || frameCount == 0) return 0;
  if (impl_->outputFormat.sampleFormat != AudioSampleFormat::Float32Interleaved) {
    std::fill(output, output + frameCount * static_cast<size_t>(std::max(1, impl_->outputFormat.channelCount)), 0.0f);
    return 0;
  }

  PcmBlock block;
  block.format = impl_->outputFormat;
  block.data = reinterpret_cast<uint8_t*>(output);
  block.frames = frameCount;
  block.byteSize = frameCount * audioFormatBytesPerFrame(block.format);
  return readFrames(block, error);
}

size_t FFmpegDecoder::readFrames(PcmBlock& output, std::string* error) {
  Impl::IoBudget ioBudget(*impl_, std::chrono::seconds(10));
  if (impl_->interrupt && impl_->interrupt(impl_->interruptContext)) {
    if (error) *error = "decode_cancelled";
    return 0;
  }
  if (!output.data || output.frames == 0) return 0;

#if defined(TAE_HAS_FFMPEG)
  if (!impl_->terminalReadError.empty()) {
    if (error) *error = impl_->terminalReadError;
    ffmpeg::zeroPcmBlock(output);
    return 0;
  }
  if (!impl_->codecContext || !impl_->swr) {
    if (error) *error = "Audio decoder is not open";
    ffmpeg::zeroPcmBlock(output);
    return 0;
  }
  if (!pcmFormatsExactMatch(output.format, impl_->outputFormat)) {
    ffmpeg::zeroPcmBlock(output);
    return 0;
  }

  const size_t channels = static_cast<size_t>(std::max(1, impl_->outputFormat.channelCount));
  const size_t bytesPerFrame = audioFormatBytesPerFrame(impl_->outputFormat);
  if (bytesPerFrame == 0) {
    ffmpeg::zeroPcmBlock(output);
    return 0;
  }
  size_t copiedFrames = 0;

  while (copiedFrames < output.frames) {
    const size_t pendingFrames =
        impl_->pending.size() / bytesPerFrame > impl_->pendingFrameOffset
            ? impl_->pending.size() / bytesPerFrame - impl_->pendingFrameOffset
            : 0;
    if (pendingFrames == 0) {
      if (!impl_->decodeOneFrame(error)) break;
      continue;
    }

    const size_t toCopy = std::min(output.frames - copiedFrames, pendingFrames);
    const size_t srcOffset = impl_->pendingFrameOffset * bytesPerFrame;
    const size_t dstOffset = copiedFrames * bytesPerFrame;
    std::memcpy(output.data + dstOffset, impl_->pending.data() + srcOffset, toCopy * bytesPerFrame);

    impl_->pendingFrameOffset += toCopy;
    copiedFrames += toCopy;
    if (impl_->pendingFrameOffset >= impl_->pending.size() / bytesPerFrame) {
      impl_->resetPending();
    }
  }

  ffmpeg::zeroPcmBlockTail(output, copiedFrames);
  return copiedFrames;
#else
  (void)error;
  ffmpeg::zeroPcmBlock(output);
  return 0;
#endif
}

bool FFmpegDecoder::seek(double seconds, std::string* error) {
  Impl::IoBudget ioBudget(*impl_, std::chrono::seconds(10));
#if defined(TAE_HAS_FFMPEG)
  if (!impl_->formatContext || impl_->audioStreamIndex < 0) {
    if (error) *error = "Audio source is not open";
    return false;
  }
  AVStream* stream = impl_->formatContext->streams[impl_->audioStreamIndex];
  const int64_t timestamp = static_cast<int64_t>(seconds / av_q2d(stream->time_base));
  const int ret = av_seek_frame(impl_->formatContext, impl_->audioStreamIndex, timestamp, AVSEEK_FLAG_BACKWARD);
  if (ret < 0) {
    if (error) *error = "音频跳转失败，错误码：" + std::to_string(ret);
    DiagnosticLog::instance().append(DiagLevel::Error, "ffmpeg.seek.failed", "seek failed", "{\"code\":" + std::to_string(ret) + "}");
    return false;
  }
  avcodec_flush_buffers(impl_->codecContext);
  // Decoder flush does not clear swr history from the old playback position.
  if (impl_->swr) {
    swr_close(impl_->swr);
    if (swr_init(impl_->swr) < 0) { if (error) *error = "Unable to reset seek resampler"; return false; }
  }
  impl_->inputEof = false;
  impl_->resamplerFlushed = false;
  impl_->eof = false;
  impl_->terminalReadError.clear();
  impl_->resetPending();
  impl_->exactSeek = false;
  impl_->exactInputCursor.reset();
  // The first decoded frame must establish the new source-sample position.
  impl_->decodedFlacEndSample.reset();
  impl_->flacSampleTimelineValid = true;
  impl_->flacAfterSeek = true;
  return true;
#else
  (void)seconds;
  if (error) *error = "当前构建未启用音频解码支持";
  return false;
#endif
}

bool FFmpegDecoder::seekOutputFrame(uint64_t frame, std::string* error) {
  Impl::IoBudget ioBudget(*impl_, std::chrono::seconds(10));
#if defined(TAE_HAS_FFMPEG)
  if (!impl_->formatContext || !impl_->swr || impl_->outputFormat.sampleRate <= 0 ||
      frame >= static_cast<uint64_t>(INT64_MAX)) return false;
  // One second supplies codec and resampler history, bounded independent of
  // song duration. The final trim is in integer output frames, not seconds.
  const auto rate = static_cast<uint64_t>(impl_->outputFormat.sampleRate);
  const auto preroll = frame > rate ? frame - rate : 0;
  if (!seek(static_cast<double>(preroll) / rate, error)) return false;
  impl_->exactSeek = true;
  impl_->exactFromStart = preroll == 0;
  impl_->exactTarget = frame;
  impl_->exactInputCursor.reset();
  while (impl_->exactSeek) {
    if (!impl_->decodeOneFrame(error)) {
      if (error && error->empty()) *error = "Precise PCM seek reached end of source";
      impl_->exactSeek = false;
      return false;
    }
  }
  return true;
#else
  (void)frame;
  if (error) *error = "当前构建未启用音频解码支持";
  return false;
#endif
}

bool FFmpegDecoder::eof() const {
  return impl_->eof;
}

FFmpegDecoder::ResamplerEngine FFmpegDecoder::resamplerEngine() const {
  return impl_->resamplerEngine;
}

FFmpegDecoder::ResamplerQuality FFmpegDecoder::effectiveResamplerQuality() const {
  return impl_->effectiveResamplerQuality;
}

FFmpegDecoder::ResamplerPhase FFmpegDecoder::resamplerPhase() const {
  return impl_->resamplerPhase;
}

FFmpegDecoder::ResamplerPhase FFmpegDecoder::effectiveResamplerPhase() const {
  return impl_->effectiveResamplerPhase;
}

const AudioStreamInfo& FFmpegDecoder::streamInfo() const {
  return impl_->streamInfo;
}

const AudioFormat& FFmpegDecoder::outputFormat() const {
  return impl_->outputFormat;
}

std::string FFmpegDecoder::streamTitle() const {
  std::lock_guard lock(impl_->streamTitleMutex);
  return impl_->streamTitle;
}

void FFmpegDecoder::pollStreamMetadata() {
#if defined(TAE_HAS_FFMPEG)
  impl_->refreshStreamTitleFromContext();
  {
    std::lock_guard lock(impl_->streamTitleMutex);
    impl_->streamInfo.streamTitle = impl_->streamTitle;
  }
#else
  // No-op without FFmpeg.
#endif
}

}  // namespace twilight::audio
