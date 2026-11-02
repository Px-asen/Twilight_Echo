#pragma once

#include "../core/AudioTypes.h"
#include "SeekableInput.h"
#include <string>
#include <vector>
#include <memory>
#include <cstdint>

namespace twilight::audio {

class SacdDstDecoderProvider;

struct SacdIsoTrackInfo {
  int trackNumber = 0;
  std::string area = "stereo";
  std::string title;
  std::string artist;
  std::string albumTitle;
  int year = 0;
  double durationSeconds = 0.0;
  uint64_t startSector = 0;
  uint64_t sectorCount = 0;
  uint64_t dataOffset = 0;
  uint64_t dataSize = 0;
  int channelCount = 2;
  int sampleRate = 2822400;
  bool isDst = false;
  // True when the track comes from a real Scarletbook TOC: its data range is
  // multiplexed 2048-byte audio sectors (packet demux) rather than raw bytes.
  bool scarletbook = false;
  std::vector<uint32_t> dstFrameSizes;
  bool playable = false;
  std::string reasonCode;
  std::string reason;
};

class SacdIsoDemuxer {
 public:
  SacdIsoDemuxer();
  ~SacdIsoDemuxer();

  bool open(const std::string& path, std::string* error);
  bool open(const std::string& source, std::shared_ptr<SeekableInput> input, std::string* error);
  void setInputFactory(std::shared_ptr<const SeekableInputFactory> factory);
  bool cancelInput();
  void close();

  const std::vector<SacdIsoTrackInfo>& tracks() const;

  bool selectTrack(int trackNumber, std::string* error);
  bool selectTrack(const std::string& area, int trackNumber, std::string* error);
  size_t readBytes(uint8_t* output, size_t maxBytes, std::string* error = nullptr);
  size_t readFrames(PcmBlock& output, std::string* error);
  bool seek(double seconds, std::string* error);
  bool eof() const;

  const AudioStreamInfo& streamInfo() const;

  // Inject a DSD-preserving DST decoder provider. When set, DST-compressed
  // SACD tracks become playable: readBytes decodes DST frames into raw DSD
  // bytes via the provider. When unset, DST tracks remain unplayable with
  // reason dst_dsd_provider_unavailable. The demuxer does not take ownership
  // of the pointer; the caller must keep it alive for the demuxer's lifetime.
  void setDstDecoderProvider(SacdDstDecoderProvider* provider);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;

  size_t readDstBytes(const SacdIsoTrackInfo& track, uint8_t* output, size_t maxBytes);
  size_t readScarletbookBytes(const SacdIsoTrackInfo& track, uint8_t* output, size_t maxBytes);
};

} // namespace twilight::audio
