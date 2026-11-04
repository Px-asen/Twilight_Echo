#include "BridgeResampler.h"
#include <algorithm>
#include <array>
#include <cmath>
#if defined(TAE_HAS_FFMPEG)
extern "C" {
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
}
#endif

namespace twilight::audio {
struct BridgeResampler::Impl {
#if defined(TAE_HAS_FFMPEG)
  SwrContext* swr = nullptr;
  ~Impl() { swr_free(&swr); }
#endif
  int rate = 0, delta = 0;
  uint64_t input = 0, timelineInput = 0;
  double position = 0, delay = 0, ppm = 0, effective = 0;
  bool ending = false, padded = false, done = false;
  // > twice the 256/.96-tap filter's right-hand lookahead, including tiny clips.
  std::array<float, 1024> tail{};
};
namespace {
constexpr int compensationDistance = 1 << 28;
constexpr int64_t subframes = 1 << 24;
bool fail(std::string* error, const char* message) { if (error) *error = message; return false; }
}
BridgeResampler::BridgeResampler() : impl_(std::make_unique<Impl>()) {}
BridgeResampler::~BridgeResampler() = default;
double BridgeResampler::Block::boundary(size_t n) const {
  return n == frames ? end : first + static_cast<double>(n) * step;
}
bool BridgeResampler::open(int rate, std::string* error) {
  impl_ = std::make_unique<Impl>();
#if defined(TAE_HAS_FFMPEG)
  auto& p = *impl_;
  AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
  if (rate < 44100 || rate > 192000 || swr_alloc_set_opts2(&p.swr,
      &stereo, AV_SAMPLE_FMT_FLT, rate, &stereo, AV_SAMPLE_FMT_FLT, rate, 0, nullptr) < 0 || !p.swr)
    return fail(error, "Cannot allocate Bridge clock resampler");
  // A band-limited Kaiser FIR, also at nominal unity. linear_interp interpolates
  // between FIR phase responses; it is not linear interpolation of PCM samples.
  if (av_opt_set_int(p.swr, "flags", SWR_FLAG_RESAMPLE, 0) < 0 ||
      av_opt_set_int(p.swr, "filter_size", 256, 0) < 0 ||
      av_opt_set_int(p.swr, "phase_shift", 10, 0) < 0 ||
      av_opt_set_int(p.swr, "exact_rational", 0, 0) < 0 ||
      av_opt_set_int(p.swr, "linear_interp", 1, 0) < 0 ||
      av_opt_set_double(p.swr, "cutoff", .96, 0) < 0 ||
      av_opt_set_int(p.swr, "filter_type", SWR_FILTER_TYPE_KAISER, 0) < 0 ||
      av_opt_set_double(p.swr, "kaiser_beta", 12, 0) < 0 || swr_init(p.swr) < 0)
    return fail(error, "Cannot initialize Bridge clock resampler");
  p.rate = rate;
  return true;
#else
  (void)rate;
  return fail(error, "Bridge adaptive PCM requires FFmpeg libswresample");
#endif
}
bool BridgeResampler::correction(double ppm, std::string* error) {
  auto& p = *impl_;
  if (!p.rate || p.ending || !std::isfinite(ppm) || std::abs(ppm) > 1000)
    return fail(error, "Bridge clock correction must be within +/-1000 ppm on an open stream");
  p.ppm = ppm;
  // Positive correction generates more output frames per source frame: a fast
  // DAC needs more samples, rather than advancing through the media faster.
  p.delta = static_cast<int>(std::lround(compensationDistance * (1 - 1 / (1 + ppm * 1e-6))));
  return true;
}
bool BridgeResampler::process(const float* input, size_t frames, float* output, size_t capacity,
    Block* block, std::string* error) {
  if (impl_->ending || !input || frames == 0 || frames > 2048)
    return fail(error, "Invalid adaptive Bridge input");
  // Genuine and padding input have separate counts. The drain path supplies
  // non-null input with count=0 so that it never implicitly flushes SWR.
  auto& p = *impl_;
#if defined(TAE_HAS_FFMPEG)
  if (!p.rate || !output || !block || capacity == 0 || capacity > 192000)
    return fail(error, "Invalid adaptive Bridge output");
  const double first = p.position;
  const uint8_t* in[] = {reinterpret_cast<const uint8_t*>(input)};
  uint8_t* out[] = {reinterpret_cast<uint8_t*>(output)};
  if (swr_set_compensation(p.swr, p.delta, compensationDistance) < 0)
    return fail(error, "Cannot apply Bridge clock correction");
  const int count = swr_convert(p.swr, out, static_cast<int>(capacity), in, static_cast<int>(frames));
  if (count < 0) return fail(error, "Bridge clock resampling failed");
  p.input += frames; p.timelineInput += frames;
  p.delay = swr_get_delay(p.swr, static_cast<int64_t>(p.rate) * subframes) / static_cast<double>(subframes);
  p.position = static_cast<double>(p.timelineInput) - p.delay;
  const double step = count ? (p.position - first) / count : 1;
  if (count) p.effective = (1 / step - 1) * 1e6;
  *block = {static_cast<size_t>(count), first, step, p.position};
  return true;
#else
  (void)p; (void)output; (void)capacity; (void)block;
  return fail(error, "Bridge adaptive PCM requires FFmpeg libswresample");
#endif
}
void BridgeResampler::endInput() { impl_->ending = true; }
bool BridgeResampler::drain(float* output, size_t capacity, Block* block, std::string* error) {
  auto& p = *impl_;
  if (p.done) { *block = {}; return true; }
#if defined(TAE_HAS_FFMPEG)
  if (!p.rate || !output || !block || capacity == 0 || capacity > 192000)
    return fail(error, "Invalid adaptive Bridge output");
  if (p.ending && p.input == 0) { p.done = true; *block = {}; return true; }
  const size_t padding = p.ending && !p.padded ? p.tail.size() / 2 : 0;
  const uint8_t* in[] = {reinterpret_cast<const uint8_t*>(p.tail.data())};
  uint8_t* out[] = {reinterpret_cast<uint8_t*>(output)};
  const double first = p.position;
  if (swr_set_compensation(p.swr, p.delta, compensationDistance) < 0)
    return fail(error, "Cannot apply Bridge clock correction");
  // Explicit right-hand zero extension keeps the public delay API meaningful.
  // swr_convert(NULL) instead reflects hidden input; its delay no longer gives
  // the source coordinate relative to our real input count. No padded samples
  // at or beyond the real media endpoint are returned to the DAC.
  const int count = swr_convert(p.swr, out, static_cast<int>(capacity), in, static_cast<int>(padding));
  if (count < 0) return fail(error, "Bridge clock resampling failed");
  if (padding) { p.timelineInput += padding; p.padded = true; }
  p.delay = swr_get_delay(p.swr, static_cast<int64_t>(p.rate) * subframes) / static_cast<double>(subframes);
  p.position = static_cast<double>(p.timelineInput) - p.delay;
  const double step = count ? (p.position - first) / count : 1;
  if (count) p.effective = (1 / step - 1) * 1e6;
  size_t take = static_cast<size_t>(count);
  if (p.ending) {
    take = std::min(take, static_cast<size_t>(std::max(0.0, std::ceil((p.input - first) / step - 1e-7))));
    p.done = p.position >= static_cast<double>(p.input) - 1e-7;
  }
  *block = {take, first, step, std::min(first + take * step,
      p.ending ? static_cast<double>(p.input) : p.position)};
  return true;
#else
  (void)output; (void)capacity; (void)block;
  return fail(error, "Bridge adaptive PCM requires FFmpeg libswresample");
#endif
}
uint64_t BridgeResampler::inputFrames() const { return impl_->input; }
double BridgeResampler::pendingFrames() const { return std::max(0.0, impl_->input - impl_->position); }
double BridgeResampler::delayFrames() const { return impl_->delay; }
double BridgeResampler::requestedPpm() const { return impl_->ppm; }
double BridgeResampler::effectivePpm() const { return impl_->effective; }
bool BridgeResampler::ended() const { return impl_->ending; }
bool BridgeResampler::completed() const { return impl_->done; }
} // namespace twilight::audio
