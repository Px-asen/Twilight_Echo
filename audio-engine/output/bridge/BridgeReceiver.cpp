#include "BridgeReceiver.h"
#include "../../utils/JsonUtils.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <sstream>
#include <iomanip>

namespace twilight::audio {
namespace { std::atomic<uint64_t> nextReceiverGeneration{0}; }
bool BridgeReceiver::open(std::unique_ptr<IOutputBackend> backend, const std::string& device,
                          int rate, int channels, std::string* error) {
  close();
  const bool defaultAlias = device.empty() || device == "auto" || device == "default" ||
      device == "System Default" || device == "system default" || device == "system-default" || device == "系统默认";
  const std::string alsaDevice = device.rfind("alsa:", 0) == 0 ? device.substr(5) : device;
  const bool alsaHardware = !backend || std::string(backend->id()) != "alsa" ||
      alsaDevice.rfind("hw:", 0) == 0 || alsaDevice.rfind("plughw:", 0) == 0;
  if (!backend || defaultAlias || !alsaHardware ||
      rate < 44100 || rate > 192000 || channels != 2) {
    if (error) *error = "Choose an explicit DAC and a stereo PCM format";
    return false;
  }
  AudioFormat request{rate, channels, 32, AudioSampleFormat::Float32Interleaved, false, 3};
  if (!backend->setOutputConfig(OutputConfig{}, error) || !backend->open(device, request, error)) return false;
  format_ = backend->outputFormat();
  // The Core will render to this negotiated format, not to a guessed DAC rate.
  if (format_.sampleRate < 44100 || format_.sampleRate > 192000 || format_.channelCount != 2 ||
      isDsdSampleFormat(format_.sampleFormat) || format_.dopEncoded) {
    if (error) *error = "The selected DAC did not negotiate supported stereo PCM";
    backend->close();
    return false;
  }
  capacity_ = static_cast<size_t>(format_.sampleRate / 4);
  const int driverBuffer = backend->outputInfo().bufferSizeFrames;
  prebufferFrames_ = std::max(static_cast<size_t>(format_.sampleRate / 25),
      static_cast<size_t>(std::max(0, driverBuffer)));
  if (prebufferFrames_ > capacity_) {
    if (error) *error = "The selected driver buffer exceeds the Bridge's 250 ms limit";
    backend->close();
    capacity_ = prebufferFrames_ = 0;
    return false;
  }
  ring_.assign(capacity_ * 2, 0);
  read_ = written_ = consumed_ = callbackRequested_ = underruns_ = 0;
  generation_ = ++nextReceiverGeneration;
  failed_ = false;
  backend_ = std::move(backend);
  return true;
}
bool BridgeReceiver::write(const float* data, size_t frames, std::string* error) {
  if (!backend_ || failed_.load() || (timed_ && ended_.load()) || !data || frames == 0 || frames > 2048) {
    if (error) *error = "Bridge receiver is unavailable or PCM block is invalid";
    return false;
  }
  const uint64_t w = written_.load(std::memory_order_relaxed), r = read_.load(std::memory_order_acquire);
  if (frames > inputCredit()) {
    if (error) *error = "Bridge buffer overflow";
    return false;
  }
  for (size_t n = 0; n < frames * 2; ++n) {
    if (!std::isfinite(data[n])) { if (error) *error = "Non-finite PCM"; return false; }
  }
  if (resampler_) {
    BridgeResampler::Block block;
    if (!resampler_->process(data, frames, resampled_.data(), capacity_ - static_cast<size_t>(w-r), &block, error)) {
      timedFailure(TimedError::Driver); return false;
    }
    appendAdaptive(block);
    return true;
  }
  for (size_t n = 0; n < frames; ++n)
    std::memcpy(&ring_[((w + n) % capacity_) * 2], data + n * 2, 2 * sizeof(float));
  written_.store(w + frames, std::memory_order_release);
  if (!timed_ && !started_ && w + frames - r >= prebufferFrames_) {
    return start(error);
  }
  return true;
}
bool BridgeReceiver::start(std::string* error) {
  if (timed_) { if (error) *error = "Timed receivers require an explicit arm"; return false; }
  if (!backend_ || failed_.load()) return false;
  if (started_ || written_.load() == read_.load()) return true;
  started_ = backend_->start([this](float* out, size_t count) { return render(out, count); },
      [this](OutputBackendEvent, const std::string&) { failed_.store(true, std::memory_order_release); }, error);
  if (!started_) failed_ = true;
  return started_;
}
void BridgeReceiver::timedFailure(TimedError reason) {
  timedError_.store(reason, std::memory_order_relaxed);
  failed_.store(true, std::memory_order_release);
  timedPhase_.store(TimedPhase::Failed, std::memory_order_release);
}
bool BridgeReceiver::prepareTimed(std::string* error) {
  if (!backend_ || started_ || written_.load() != 0 || !backend_->supportsClockedRendering()) {
    if (error) *error = "Timed preparation requires a fresh PCM receiver with a device clock";
    return false;
  }
  timed_ = true;
  timedPhase_.store(TimedPhase::Prepared, std::memory_order_release);
  started_ = backend_->startClocked(
      [this](float* out, size_t frames, const ClockedRenderContext& context) { return renderTimed(out, frames, context); },
      [this](uint64_t frame, size_t count, uint64_t epoch, bool success) { commitTimed(frame, count, epoch, success); },
      [this](OutputBackendEvent, const std::string&) { timedFailure(TimedError::Driver); }, error);
  if (!started_) timedFailure(TimedError::Driver);
  else clockEpoch_.store(backend_->outputClock().epoch, std::memory_order_release);
  return started_;
}
bool BridgeReceiver::prepareAdaptiveTimed(std::string* error) {
  if (!backend_ || started_ || written_.load() != 0 || !backend_->supportsClockedRendering()) {
    if (error) *error = "Adaptive preparation requires a fresh clocked PCM receiver";
    return false;
  }
  if (std::ceil(prebufferFrames_ * 1.001) + BridgeResampler::lookaheadReserveFrames + 2 > capacity_) {
    if (error) *error = "The driver buffer leaves no SRC lookahead within the Bridge's 250 ms limit";
    return false;
  }
  auto resampler = std::make_unique<BridgeResampler>();
  if (!resampler->open(format_.sampleRate, error)) return false;
  resampled_.resize(capacity_ * 2);
  sourceRing_.resize(capacity_); pendingSources_.resize(capacity_);
  presentation_.reset(static_cast<size_t>(format_.sampleRate) * 2);
  resampler_ = std::move(resampler);
  return prepareTimed(error);
}
bool BridgeReceiver::setTimedCorrection(double ppm, uint64_t generation, std::string* error) {
  if (!resampler_ || failed_.load() || generation != generation_ || timedPhase_.load() == TimedPhase::Disabled) {
    if (error) *error = "No matching adaptive Bridge stream";
    return false;
  }
  return resampler_->correction(ppm, error);
}
size_t BridgeReceiver::inputCredit() const {
  const auto free = capacity_ - static_cast<size_t>(written_.load(std::memory_order_acquire) - read_.load(std::memory_order_acquire));
  if (!resampler_) return free;
  if (resampler_->ended()) return 0;
  // Include SWR-held input and the maximum expansion at +1000 ppm. The guard
  // frames cover ceiling quantization; accepted input cannot overflow the ring.
  return static_cast<size_t>(std::max(0.0, std::floor(free / 1.001 - resampler_->pendingFrames() - 2)));
}
void BridgeReceiver::appendAdaptive(const BridgeResampler::Block& block) {
  const auto w = written_.load(std::memory_order_relaxed);
  for (size_t n = 0; n < block.frames; ++n) {
    const auto at = (w+n) % capacity_;
    std::memcpy(&ring_[at*2], &resampled_[n*2], 2*sizeof(float));
    sourceRing_[at] = {block.boundary(n), block.boundary(n+1)};
  }
  written_.store(w+block.frames, std::memory_order_release);
}
bool BridgeReceiver::pumpAdaptive(std::string* error) {
  if (!resampler_ || failed_.load() || resampler_->completed()) return true;
  const auto free = capacity_ - static_cast<size_t>(written_.load(std::memory_order_relaxed) - read_.load(std::memory_order_acquire));
  if (!free) return true;
  BridgeResampler::Block block;
  if (!resampler_->drain(resampled_.data(), free, &block, error)) { timedFailure(TimedError::Driver); return false; }
  appendAdaptive(block);
  if (resampler_->completed()) ended_.store(true, std::memory_order_release);
  return true;
}
bool BridgeReceiver::armTimed(double startAtMs, uint64_t expectedGeneration, uint64_t mediaFrame, std::string* error) {
  const auto clock = backend_ ? backend_->outputClock() : OutputClockSnapshot{};
  const double now = outputMonotonicMs();
  const auto buffered = written_.load(std::memory_order_acquire) - read_.load(std::memory_order_acquire);
  if (!timed_ || timedPhase_.load(std::memory_order_acquire) != TimedPhase::Prepared ||
      expectedGeneration != generation_ || !clock.supported || !clock.valid || !clock.running ||
      clock.epoch != clockEpoch_.load(std::memory_order_acquire) ||
      clock.sampleRate != format_.sampleRate || clock.sampledAtMs > now || now - clock.sampledAtMs > 250 ||
      // Cover both already queued silence and a Prepared callback in flight.
      !std::isfinite(startAtMs) || startAtMs <= now + prebufferFrames_ * 2000.0 / format_.sampleRate || startAtMs > now + 2000 ||
      (buffered < prebufferFrames_ && !(ended_.load(std::memory_order_acquire) && buffered > 0))) {
    if (error) *error = "Timed start requires a current clock, matching stream, buffered PCM and a future deadline";
    return false;
  }
  targetAtMs_.store(startAtMs); mediaFrame_.store(mediaFrame);
  timedPhase_.store(TimedPhase::Armed, std::memory_order_release);
  return true;
}
bool BridgeReceiver::endTimed(std::string* error) {
  if (!timed_ || failed_.load()) { if (error) *error = "No healthy timed receiver"; return false; }
  if (resampler_) { resampler_->endInput(); return pumpAdaptive(error); }
  ended_.store(true, std::memory_order_release);
  return true;
}
size_t BridgeReceiver::renderTimed(float* out, size_t frames, const ClockedRenderContext& context) {
  pendingPacket_ = {context.firstFrame, context.epoch, frames, 0, 0, context.firstFrameAtMs, false};
  std::fill(out, out + frames * 2, 0.0f);
  callbackRequested_.fetch_add(frames, std::memory_order_relaxed);
  const auto phase = timedPhase_.load(std::memory_order_acquire);
  if (phase != TimedPhase::Armed && phase != TimedPhase::Running) return frames;
  if (!context.valid || context.sampleRate != format_.sampleRate) { timedFailure(TimedError::Clock); return frames; }
  if (context.epoch != clockEpoch_.load()) { timedFailure(TimedError::Epoch); return frames; }
  size_t silence = 0;
  if (phase == TimedPhase::Armed) {
    const double until = (targetAtMs_.load() - context.firstFrameAtMs) * format_.sampleRate / 1000.0;
    if (until >= static_cast<double>(frames)) return frames;
    if (until < -1.0) { timedFailure(TimedError::Late); return frames; }
    silence = static_cast<size_t>(std::max(0.0, std::ceil(until - 1e-7)));
  } else if (context.firstFrame != nextDeviceFrame_) { timedFailure(TimedError::FrameSequence); return frames; }
  const auto r = read_.load(std::memory_order_relaxed), w = written_.load(std::memory_order_acquire);
  const size_t available = frames - silence, count = std::min(available, static_cast<size_t>(w - r));
  if (count < available && !ended_.load(std::memory_order_acquire)) {
    underruns_.fetch_add(1, std::memory_order_relaxed);
    timedFailure(TimedError::Underrun); return frames;
  }
  if (phase == TimedPhase::Armed && count > 0) {
    pendingPacket_.startsMedia = true;
  }
  pendingPacket_.mediaFrames = count; pendingPacket_.leadingSilence = silence;
  for (size_t n = 0; n < count; ++n) {
    std::memcpy(out + (silence + n) * 2, &ring_[((r + n) % capacity_) * 2], 2 * sizeof(float));
    if (resampler_) pendingSources_[n] = sourceRing_[(r+n) % capacity_];
  }
  if (resampler_ && count) sourceConsumed_.store(pendingSources_[count-1].end, std::memory_order_relaxed);
  read_.store(r + count, std::memory_order_release);
  consumed_.fetch_add(count, std::memory_order_relaxed);
  nextDeviceFrame_ = context.firstFrame + frames;
  return frames;
}
void BridgeReceiver::commitTimed(uint64_t firstFrame, size_t frames, uint64_t epoch, bool success) {
  const auto phase = timedPhase_.load(std::memory_order_acquire);
  if (phase == TimedPhase::Disabled || phase == TimedPhase::Failed) return;
  if (!success) { timedFailure(TimedError::Driver); return; }
  if (firstFrame != pendingPacket_.firstFrame || frames != pendingPacket_.frames || epoch != pendingPacket_.epoch) {
    timedFailure(TimedError::FrameSequence); return;
  }
  committedMediaFrames_.fetch_add(pendingPacket_.mediaFrames, std::memory_order_release);
  if (resampler_ && pendingPacket_.mediaFrames) {
    const auto start = firstFrame + pendingPacket_.leadingSilence;
    for (size_t n = 0; n < pendingPacket_.mediaFrames; ++n)
      presentation_.record(start+n, pendingSources_[n].first, pendingSources_[n].end);
    presentation_.publish(start+pendingPacket_.mediaFrames);
  }
  if (pendingPacket_.startsMedia) {
    mediaStartDeviceFrame_.store(firstFrame + pendingPacket_.leadingSilence);
    mediaStartAtMs_.store(pendingPacket_.firstFrameAtMs + pendingPacket_.leadingSilence * 1000.0 / format_.sampleRate);
    anchored_.store(true, std::memory_order_release);
    timedPhase_.store(TimedPhase::Running, std::memory_order_release);
  }
  pendingPacket_.frames = 0; // A duplicate driver acknowledgement is not another media submission.
}
size_t BridgeReceiver::render(float* out, size_t frames) {
  const uint64_t r = read_.load(std::memory_order_relaxed), w = written_.load(std::memory_order_acquire);
  const size_t count = failed_.load(std::memory_order_acquire) ? 0 :
      std::min(frames, static_cast<size_t>(w - r));
  for (size_t n = 0; n < count; ++n)
    std::memcpy(out + n * 2, &ring_[((r + n) % capacity_) * 2], 2 * sizeof(float));
  std::fill(out + count * 2, out + frames * 2, 0.0f);
  read_.store(r + count, std::memory_order_release);
  consumed_.fetch_add(count, std::memory_order_relaxed);
  callbackRequested_.fetch_add(frames, std::memory_order_relaxed);
  if (count < frames) underruns_.fetch_add(1, std::memory_order_relaxed);
  return frames;
}
void BridgeReceiver::close() {
  timedPhase_.store(TimedPhase::Disabled, std::memory_order_release);
  if (backend_) { backend_->stop(); backend_->close(); backend_.reset(); }
  timedPhase_.store(TimedPhase::Disabled, std::memory_order_release);
  started_ = false;
  ring_.clear();
  capacity_ = 0;
  prebufferFrames_ = 0;
  read_ = written_ = consumed_ = callbackRequested_ = underruns_ = 0;
  timed_ = false; ended_ = false; anchored_ = false;
  targetAtMs_ = mediaStartAtMs_ = 0;
  clockEpoch_ = mediaFrame_ = mediaStartDeviceFrame_ = 0;
  timedError_ = TimedError::None;
  committedMediaFrames_ = 0; pendingPacket_ = {}; nextDeviceFrame_ = 0;
  resampler_.reset(); resampled_.clear(); sourceRing_.clear(); pendingSources_.clear();
  presentation_.reset(); sourceConsumed_ = 0;
}
std::string BridgeReceiver::status() {
  // Status is queried on the same control/network thread as Write. It pumps
  // buffered SRC output and EOF tails; no work is deferred to the DAC callback.
  pumpAdaptive(nullptr);
  const OutputInfo info = backend_ ? backend_->outputInfo() : OutputInfo{};
  auto clock = backend_ ? backend_->outputClock() : OutputClockSnapshot{};
  const double readAtMs = outputMonotonicMs();
  // An unavailable/corrupt driver timestamp disables observation, not PCM.
  if (!std::isfinite(clock.positionFrames) || clock.positionFrames < 0 ||
      !std::isfinite(clock.sampledAtMs) || clock.sampledAtMs <= 0 || clock.sampledAtMs > readAtMs) {
    clock.valid = false; clock.positionFrames = 0; clock.sampledAtMs = 0;
  }
  const auto r = read_.load(std::memory_order_acquire), w = written_.load(std::memory_order_acquire);
  const auto phase = timedPhase_.load(std::memory_order_acquire);
  const bool anchored = anchored_.load(std::memory_order_acquire);
  const bool clockMapped = anchored && phase == TimedPhase::Running && clock.valid && clock.epoch == clockEpoch_.load();
  std::optional<double> sourcePosition;
  if (clockMapped && resampler_) sourcePosition = clock.positionFrames < static_cast<double>(mediaStartDeviceFrame_.load()) ?
      std::optional<double>{0} : presentation_.sourceAt(clock.positionFrames);
  const bool mapped = clockMapped && (!resampler_ || sourcePosition.has_value());
  const double presented = mapped ? (resampler_ ? *sourcePosition :
      std::clamp(clock.positionFrames - static_cast<double>(mediaStartDeviceFrame_.load()),
      0.0, static_cast<double>(committedMediaFrames_.load(std::memory_order_acquire)))) : 0;
  const auto mediaEnd = resampler_ ? presentation_.committedEnd() : mediaStartDeviceFrame_.load() + committedMediaFrames_.load();
  const char* state = phase == TimedPhase::Disabled ? "disabled" : phase == TimedPhase::Prepared ? "prepared" :
      phase == TimedPhase::Armed ? "armed" : phase == TimedPhase::Failed ? "failed" :
      ended_.load() && mapped && r == w && clock.positionFrames >= static_cast<double>(mediaEnd) ? "completed" : "running";
  const char* reasons[] = {"", "clock_unavailable", "clock_epoch_changed", "deadline_missed", "media_underrun", "driver_failed", "device_frame_discontinuity"};
  std::ostringstream json;
  json << std::setprecision(17);
  json << "{\"sampleRate\":" << format_.sampleRate << ",\"channels\":2,\"bufferedFrames\":" << w - r
       << ",\"capacityFrames\":" << capacity_ << ",\"prebufferFrames\":" << prebufferFrames_
       << ",\"consumedFrames\":" << consumed_.load()
       << ",\"underruns\":" << underruns_.load() << ",\"started\":" << (started_ ? "true" : "false")
       << ",\"failed\":" << (failed_.load() ? "true" : "false")
       << ",\"backend\":\"" << json_utils::escape(info.backend) << "\",\"deviceName\":\""
       << json_utils::escape(info.deviceName) << "\",\"actualSampleRate\":" << info.actualSampleRate
       << ",\"actualBitDepth\":" << info.actualBitDepth << ",\"actualChannels\":" << info.actualChannels
       << ",\"actualOutputFormat\":\"" << json_utils::escape(info.actualOutputFormat)
       << "\",\"exclusive\":" << (info.exclusive ? "true" : "false")
       << ",\"clock\":{\"supported\":" << (clock.supported ? "true" : "false")
       << ",\"valid\":" << (clock.valid ? "true" : "false")
       << ",\"running\":" << (clock.running ? "true" : "false")
       << ",\"source\":\"" << (clock.supported ? "wasapi-audio-clock" : "unsupported")
       << "\",\"streamGeneration\":" << generation_ << ",\"epoch\":" << clock.epoch
       << ",\"positionFrames\":" << clock.positionFrames << ",\"sampledAtMs\":" << clock.sampledAtMs
       << ",\"readAtMs\":" << readAtMs << ",\"sampleRate\":" << clock.sampleRate
       << ",\"callbackRequestedFrames\":" << callbackRequested_.load() << "}"
       << ",\"timedStart\":{\"supported\":" << (backend_ && backend_->supportsClockedRendering() ? "true" : "false")
       << ",\"state\":\"" << state << "\",\"error\":\"" << reasons[static_cast<int>(timedError_.load())]
       << "\",\"ended\":" << (ended_.load() ? "true" : "false")
       << ",\"targetAtMs\":" << targetAtMs_.load() << ",\"mediaFrame\":" << mediaFrame_.load()
       << ",\"deviceStartFrame\":" << (anchored ? std::to_string(mediaStartDeviceFrame_.load()) : "null")
       << ",\"deviceStartAtMs\":" << (anchored ? std::to_string(mediaStartAtMs_.load()) : "null")
       << ",\"presentedMediaFrames\":" << (mapped ? std::to_string(presented) : "null") << "}"
       << ",\"adaptiveSupported\":";
#if defined(TAE_HAS_FFMPEG)
  json << (backend_ && backend_->supportsClockedRendering() ? "true" : "false");
#else
  json << "false";
#endif
  json << ",\"adaptive\":";
  if (resampler_) json << "{\"requestedPpm\":" << resampler_->requestedPpm()
       << ",\"effectivePpm\":" << resampler_->effectivePpm() << ",\"inputFrames\":" << resampler_->inputFrames()
       << ",\"pendingInputFrames\":" << resampler_->pendingFrames() << ",\"resamplerDelayFrames\":" << resampler_->delayFrames()
       << ",\"sourceConsumedFrames\":" << sourceConsumed_.load() << ",\"inputCreditFrames\":" << inputCredit() << "}";
  else json << "null";
  json << "}";
  return json.str();
}
} // namespace twilight::audio
