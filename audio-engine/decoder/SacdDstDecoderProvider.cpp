#include "SacdIsoProbe.h"

#include "DstDecoder.h"
#include "vendor/dstdec/dstdec.h"

namespace twilight::audio {

namespace {

// Built-in DSD-preserving DST provider backed by the vendored dstdec arithmetic
// core (see decoder/vendor/dstdec). Outputs raw DSD bytes (MSB-first,
// DffInterleaved) suitable for the DoP / native-DSD pipeline.
class DstDecoderProvider final : public SacdDstDecoderProvider {
 public:
  const char* name() const override { return "twilight-dstdec"; }

  bool available(std::string* reason) const override {
    // The vendored dstdec is always built into the library (LGPL). It is
    // available as long as a valid channel/sample-rate configuration is
    // supplied to open(); the capability itself is unconditionally present.
    if (reason) reason->clear();
    return true;
  }

  bool open(int channels, int sampleRate, std::string* error) override {
    return decoder_.init(channels, sampleRate, error);
  }

  size_t decodeFrame(const uint8_t* dstFrameBytes,
                     size_t dstFrameSize,
                     uint8_t* dsdOut,
                     size_t dsdOutSize,
                     std::string* error) override {
    return decoder_.decodeFrame(dstFrameBytes, dstFrameSize, dsdOut, dsdOutSize, error);
  }

  size_t frameBytesPerChannel(int sampleRate) const override {
    return dstdec::frameBytesPerChannelForSampleRate(sampleRate);
  }

  // Each access unit is independently decoded; seeking has no filter/history
  // to flush. Keep the track geometry established by open().
  void reset() override {}

 private:
  DstDecoder decoder_;
};

}  // namespace

std::unique_ptr<SacdDstDecoderProvider> createDefaultSacdDstDecoderProvider() {
  return std::make_unique<DstDecoderProvider>();
}

}  // namespace twilight::audio
