#include "AudioMetadataService.h"
#include "../decoder/FFmpegFileInput.h"

#include "AudioMetadataTypes.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include "../core/DsdRate.h"
#include "../decoder/FFmpegDsdRate.h"
#include "../decoder/WavPackSource.h"
#include "../decoder/SacdIsoDemuxer.h"
#include "../decoder/SacdIsoProbe.h"
#include "../decoder/SeekableInputStream.h"

#if defined(TAE_HAS_FFMPEG)
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/avutil.h>
#include <libavutil/dict.h>
}
#endif

namespace twilight::audio {
namespace {

std::string escapeJson(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (char ch : value) {
    switch (ch) {
      case '\\':
        out += "\\\\";
        break;
      case '"':
        out += "\\\"";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        out += ch;
        break;
    }
  }
  return out;
}

std::string toUpper(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::toupper(ch));
  });
  return value;
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

bool textMentions(const std::string& haystack, const std::string& needle) {
  return toLower(haystack).find(needle) != std::string::npos;
}

bool codecLooksDsd(const std::string& codec) {
  const std::string normalized = toLower(codec);
  return normalized.rfind("dsd", 0) == 0 || normalized == "dsf" || normalized == "dff" ||
         normalized == "dst" || normalized == "dop" || normalized.find("dsd_") != std::string::npos ||
         normalized.find("dop") != std::string::npos;
}

bool containerLooksDsd(const std::string& container, const std::string& extension) {
  return extension == "dsf" || extension == "dff" || extension == "dop" ||
         textMentions(container, "dsd") || textMentions(container, "dsf") ||
         textMentions(container, "dff") || textMentions(container, "dsdiff") || textMentions(container, "dop");
}

bool looksDop(const std::string& codec, const std::string& container, const std::string& extension) {
  return extension == "dop" || textMentions(codec, "dop") || textMentions(container, "dop");
}

bool sourceLooksSacdIso(const std::string& source) {
  return probeSacdIsoEntry(source).isSacdIso();
}

void markSacdIsoUnsupported(AudioMetadata* metadata) {
  if (!metadata) return;
  metadata->codec = "sacd_iso";
  metadata->container = "SACD ISO";
  metadata->isDsd = true;
  metadata->dsdMode = dsdModeToString(DsdMode::Unsupported);
}

void assignMetadataField(AudioMetadata* metadata, const std::string& key, const char* value) {
  if (!metadata || !value) return;
  if (key == "TITLE") metadata->title = value;
  if (key == "ARTIST") metadata->artist = value;
  if (key == "ALBUM") metadata->album = value;
  if (key == "ALBUMARTIST" || key == "ALBUM_ARTIST") metadata->albumArtist = value;
  if (key == "COMPOSER") metadata->composer = value;
  if (key == "DATE" || key == "YEAR") metadata->year = value;
  if (key == "GENRE") metadata->genre = value;
  if (key == "TRACK" || key == "TRACKNUMBER") metadata->trackNumber = value;
  if (key == "DISC" || key == "DISCNUMBER") metadata->discNumber = value;
  if (key == "COMMENT" || key == "DESCRIPTION") metadata->comment = value;

  if (key == "REPLAYGAIN_TRACK_GAIN") metadata->replayGain.trackGainDb = parseGainDb(value, false);
  if (key == "REPLAYGAIN_ALBUM_GAIN") metadata->replayGain.albumGainDb = parseGainDb(value, false);
  if (key == "R128_TRACK_GAIN") metadata->replayGain.r128TrackGainDb = parseGainDb(value, true);
  if (key == "R128_ALBUM_GAIN") metadata->replayGain.r128AlbumGainDb = parseGainDb(value, true);
}

#if defined(TAE_HAS_FFMPEG)
void readDictionary(AVDictionary* dictionary, AudioMetadata* metadata) {
  if (!dictionary || !metadata) return;
  const AVDictionaryEntry* entry = nullptr;
  while ((entry = av_dict_get(dictionary, "", entry, AV_DICT_IGNORE_SUFFIX)) != nullptr) {
    assignMetadataField(metadata, toUpper(entry->key ? entry->key : ""), entry->value);
  }
}

std::string base64Encode(const uint8_t* data, size_t size) {
  static constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((size + 2) / 3) * 4);
  for (size_t i = 0; i < size; i += 3) {
    const uint32_t b0 = data[i];
    const uint32_t b1 = i + 1 < size ? data[i + 1] : 0;
    const uint32_t b2 = i + 2 < size ? data[i + 2] : 0;
    const uint32_t triple = (b0 << 16) | (b1 << 8) | b2;
    out.push_back(alphabet[(triple >> 18) & 0x3f]);
    out.push_back(alphabet[(triple >> 12) & 0x3f]);
    out.push_back(i + 1 < size ? alphabet[(triple >> 6) & 0x3f] : '=');
    out.push_back(i + 2 < size ? alphabet[triple & 0x3f] : '=');
  }
  return out;
}

std::string coverMimeForCodec(AVCodecID codecId) {
  if (codecId == AV_CODEC_ID_PNG) return "image/png";
  if (codecId == AV_CODEC_ID_MJPEG) return "image/jpeg";
  if (codecId == AV_CODEC_ID_GIF) return "image/gif";
  if (codecId == AV_CODEC_ID_BMP) return "image/bmp";
  return "application/octet-stream";
}

struct FormatContextHandle {
  FFmpegFileInput fileInput;
  AVFormatContext* context = nullptr;
  ~FormatContextHandle() {
    if (context) avformat_close_input(&context);
  }
};
#endif

std::string optionalNumber(std::optional<double> value) {
  if (!value) return "null";
  std::ostringstream out;
  out << *value;
  return out.str();
}

void writeStringArray(std::ostringstream& json, const std::vector<std::string>& values) {
  json << "[";
  for (size_t i = 0; i < values.size(); ++i) {
    if (i > 0) json << ",";
    json << "\"" << escapeJson(values[i]) << "\"";
  }
  json << "]";
}

std::string metadataToJson(const AudioMetadata& metadata, const std::string& error = {}) {
  std::ostringstream json;
  json << "{"
       << "\"source\":\"" << escapeJson(metadata.source) << "\","
       << "\"title\":\"" << escapeJson(metadata.title) << "\","
       << "\"artist\":\"" << escapeJson(metadata.artist) << "\","
       << "\"album\":\"" << escapeJson(metadata.album) << "\","
       << "\"albumArtist\":\"" << escapeJson(metadata.albumArtist) << "\","
       << "\"composer\":\"" << escapeJson(metadata.composer) << "\","
       << "\"year\":\"" << escapeJson(metadata.year) << "\","
       << "\"genre\":\"" << escapeJson(metadata.genre) << "\","
       << "\"trackNumber\":\"" << escapeJson(metadata.trackNumber) << "\","
       << "\"discNumber\":\"" << escapeJson(metadata.discNumber) << "\","
       << "\"comment\":\"" << escapeJson(metadata.comment) << "\","
       << "\"codec\":\"" << escapeJson(metadata.codec) << "\","
       << "\"container\":\"" << escapeJson(metadata.container) << "\","
       << "\"channelLayout\":\"" << escapeJson(metadata.channelLayout) << "\","
       << "\"sampleRate\":" << metadata.sampleRate << ","
       << "\"channelCount\":" << metadata.channelCount << ","
       << "\"bitDepth\":" << metadata.bitDepth << ","
       << "\"bitrate\":" << metadata.bitrate << ","
       << "\"duration\":" << metadata.durationSeconds << ","
       << "\"playable\":" << (metadata.playable ? "true" : "false") << ","
       << "\"reasonCode\":\"" << escapeJson(metadata.reasonCode) << "\","
       << "\"isDsd\":" << (metadata.isDsd ? "true" : "false") << ","
       << "\"dsdMode\":\"" << escapeJson(metadata.dsdMode) << "\","
       << "\"dsdRate\":" << metadata.dsdRate << ","
       << "\"coverMime\":\"" << escapeJson(metadata.coverMime) << "\","
       << "\"coverDataBase64\":\"" << escapeJson(metadata.coverDataBase64) << "\","
       << "\"replayGainTrackGain\":" << optionalNumber(metadata.replayGain.trackGainDb) << ","
       << "\"replayGainAlbumGain\":" << optionalNumber(metadata.replayGain.albumGainDb) << ","
       << "\"r128TrackGain\":" << optionalNumber(metadata.replayGain.r128TrackGainDb) << ","
       << "\"r128AlbumGain\":" << optionalNumber(metadata.replayGain.r128AlbumGainDb) << ","
       << "\"outputModes\":";
  writeStringArray(json, metadata.outputModes);
  json << ",";
  
  if (!metadata.isoTracks.empty()) {
    json << "\"isoTracks\":[";
    for (size_t i = 0; i < metadata.isoTracks.size(); ++i) {
      json << metadataToJson(metadata.isoTracks[i]);
      if (i + 1 < metadata.isoTracks.size()) json << ",";
    }
    json << "],";
  }

  json << "\"error\":\"" << escapeJson(error) << "\""
       << "}";
  return json.str();
}

}  // namespace

std::string readMetadataJson(const std::string& source, std::shared_ptr<const SeekableInputFactory> inputFactory) {
  AudioMetadata metadata;
  metadata.source = source;
  if (source.empty()) return metadataToJson(metadata, "音频地址为空");
  const auto inputSource = parseSacdSource(source).path;
  auto input = inputFactory ? (*inputFactory)(inputSource) : nullptr;
  SeekableInputStream probeInput;
  bool sacd = false;
  if (sacdIsoExtensionOf(inputSource) == "iso" || source.rfind("content://", 0) == 0) {
    if (input) probeInput.open(input);
    else probeInput.open(inputSource);
    std::array<char, 4> magic{};
    probeInput.read(magic.data(), magic.size());
    sacd = probeInput.is_open() && std::memcmp(magic.data(), "DSD ", 4) != 0 &&
        std::memcmp(magic.data(), "FRM8", 4) != 0 && probeSacdIsoEntry(source, probeInput).isSacdIso();
  }
  if (sacd) {
    metadata.container = "SACD ISO";
    metadata.isDsd = true;
#if defined(TAE_HAS_FFMPEG)
    const bool pcmAvailable = avcodec_find_decoder(AV_CODEC_ID_DSD_MSBF) != nullptr;
#else
    const bool pcmAvailable = false;
#endif
    metadata.dsdMode = dsdModeToString(pcmAvailable ? DsdMode::Pcm : DsdMode::Unsupported);
    
    SacdIsoDemuxer demuxer;
    auto dstProvider = createDefaultSacdDstDecoderProvider();
    demuxer.setDstDecoderProvider(dstProvider.get());
    std::string error;
    if (!demuxer.open(source, probeInput.input(), &error)) {
      return metadataToJson(metadata, error.empty() ? "Unable to read SACD ISO metadata" : error);
    }
    
    for (const auto& track : demuxer.tracks()) {
      AudioMetadata trackMeta;
      trackMeta.source = sacdTrackSource(source, track.area, track.trackNumber);
      trackMeta.title = track.title.empty() ? "Track " + std::to_string(track.trackNumber) : track.title;
      trackMeta.artist = track.artist;
      trackMeta.album = track.albumTitle;
      if (track.year > 0 && track.year <= 9999) trackMeta.year = std::to_string(track.year);
      trackMeta.trackNumber = std::to_string(track.trackNumber);
      trackMeta.durationSeconds = track.durationSeconds;
      trackMeta.channelCount = track.channelCount;
      trackMeta.sampleRate = track.sampleRate;
      trackMeta.bitDepth = 1;
      trackMeta.isDsd = true;
      trackMeta.dsdMode = metadata.dsdMode;
      trackMeta.dsdRate = inferDsdRate(track.sampleRate);
      trackMeta.container = "SACD ISO";
      trackMeta.codec = track.isDst ? "dst" : "dsd";
      trackMeta.playable = track.playable;
      trackMeta.reasonCode = track.playable ? "" : track.reasonCode;
      if (track.playable) {
        trackMeta.outputModes = {"native", "dop"};
        if (pcmAvailable) trackMeta.outputModes.push_back("pcm");
      }
      trackMeta.comment = track.playable ? "" : (track.reason.empty() ? "SACD ISO DST track unsupported" : track.reason);
      metadata.isoTracks.push_back(trackMeta);
    }
    
    return metadataToJson(metadata);
  }

#if defined(TAE_HAS_FFMPEG)
  FormatContextHandle handle;
  if (!handle.fileInput.open(source, &handle.context, input) ||
      avformat_open_input(&handle.context, source.c_str(), nullptr, nullptr) < 0 || !handle.context) {
    return metadataToJson(metadata, "无法打开音频文件");
  }
  if (avformat_find_stream_info(handle.context, nullptr) < 0) {
    return metadataToJson(metadata, "无法读取音频流信息");
  }

  readDictionary(handle.context->metadata, &metadata);
  const std::string sourceExtension = extensionOf(source);
  if (handle.context->iformat) {
    metadata.container = handle.context->iformat->long_name ? handle.context->iformat->long_name
                                                            : (handle.context->iformat->name ? handle.context->iformat->name : "");
  }
  metadata.durationSeconds =
      handle.context->duration != AV_NOPTS_VALUE
          ? static_cast<double>(handle.context->duration) / static_cast<double>(AV_TIME_BASE)
          : 0.0;
  metadata.bitrate = handle.context->bit_rate;

  for (unsigned int i = 0; i < handle.context->nb_streams; ++i) {
    AVStream* stream = handle.context->streams[i];
    if (!stream || !stream->codecpar) continue;
    readDictionary(stream->metadata, &metadata);
    if (stream->codecpar->codec_type == AVMEDIA_TYPE_AUDIO && metadata.sampleRate == 0) {
      const AVCodecDescriptor* descriptor = avcodec_descriptor_get(stream->codecpar->codec_id);
      metadata.codec = descriptor && descriptor->name ? descriptor->name : "";
      const auto wavPack = stream->codecpar->codec_id == AV_CODEC_ID_WAVPACK &&
          (input || source.find("://") == std::string::npos)
          ? readWavPackSource(source, input) : std::optional<WavPackSource>{};
      const bool wavPackDsd = wavPack && wavPack->isDsd;
      // Raw-DSD demuxers report the post-decimation PCM rate; publish the DSD bit rate
      // so it matches every other DSD source. See FFmpegDsdRate.h.
      metadata.sampleRate = wavPackDsd ? stream->codecpar->sample_rate * ffmpeg::kDsdBitsPerByte :
          ffmpeg::dsdSampleRateFromCodecRate(stream->codecpar->codec_id, stream->codecpar->sample_rate);
      metadata.channelCount = stream->codecpar->ch_layout.nb_channels;
      char layout[128] = {};
      if (av_channel_layout_describe(&stream->codecpar->ch_layout, layout, sizeof(layout)) >= 0) {
        metadata.channelLayout = layout;
      }
      metadata.bitDepth = stream->codecpar->bits_per_raw_sample > 0
                              ? stream->codecpar->bits_per_raw_sample
                              : stream->codecpar->bits_per_coded_sample;
      if (wavPack) {
        metadata.bitDepth = wavPack->bitDepth;
        if (wavPack->totalSamples > 0 && stream->codecpar->sample_rate > 0) {
          metadata.durationSeconds = static_cast<double>(wavPack->totalSamples) / stream->codecpar->sample_rate;
        }
      }
      if (stream->codecpar->bit_rate > 0) metadata.bitrate = stream->codecpar->bit_rate;
      const bool dopCarrier = looksDop(metadata.codec, metadata.container, sourceExtension);
      metadata.isDsd = wavPackDsd || codecLooksDsd(metadata.codec) || containerLooksDsd(metadata.container, sourceExtension);
      // DSD is 1 bit per sample by definition. FFmpeg reports bits_per_coded_sample = 8
      // for raw DSD, which describes the byte packing, not the audio bit depth, so the
      // old `<= 0` guard never fired and DSD files were published as 8-bit.
      if (metadata.isDsd) metadata.bitDepth = 1;
      metadata.dsdRate = metadata.isDsd ? inferDsdRate(metadata.sampleRate, dopCarrier) : 0;
      if (metadata.isDsd) {
        metadata.playable = avcodec_find_decoder(stream->codecpar->codec_id) != nullptr;
        metadata.dsdMode = dsdModeToString(metadata.playable ? DsdMode::Pcm : DsdMode::Unsupported);
        if (!metadata.playable) metadata.reasonCode = "decoder_unavailable";
        if (wavPackDsd && metadata.playable) metadata.outputModes = {"pcm"};
        if (ffmpeg::isRawDsdCodec(stream->codecpar->codec_id) || stream->codecpar->codec_id == AV_CODEC_ID_DST) {
          metadata.outputModes = {"native", "dop"};
          if (metadata.playable) metadata.outputModes.push_back("pcm");
        }
      }
    }
    if ((stream->disposition & AV_DISPOSITION_ATTACHED_PIC) != 0 && stream->attached_pic.data &&
        stream->attached_pic.size > 0 && metadata.coverDataBase64.empty()) {
      metadata.coverMime = coverMimeForCodec(stream->codecpar->codec_id);
      metadata.coverDataBase64 =
          base64Encode(stream->attached_pic.data, static_cast<size_t>(stream->attached_pic.size));
    }
  }
  return metadataToJson(metadata);
#else
  return metadataToJson(metadata, "当前构建未启用元数据读取支持");
#endif
}

}  // namespace twilight::audio
