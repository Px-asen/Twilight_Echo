#include "BridgeReceiver.h"
#include "../../utils/JsonUtils.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <sstream>

namespace twilight::audio {
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
  read_ = written_ = consumed_ = underruns_ = 0;
  failed_ = false;
  backend_ = std::move(backend);
  return true;
}
bool BridgeReceiver::write(const float* data, size_t frames, std::string* error) {
  if (!backend_ || failed_.load() || !data || frames == 0 || frames > 2048) {
    if (error) *error = "Bridge receiver is unavailable or PCM block is invalid";
    return false;
  }
  const uint64_t w = written_.load(std::memory_order_relaxed), r = read_.load(std::memory_order_acquire);
  if (frames > capacity_ - static_cast<size_t>(w - r)) {
    if (error) *error = "Bridge buffer overflow";
    return false;
  }
  for (size_t n = 0; n < frames * 2; ++n) {
    if (!std::isfinite(data[n])) { if (error) *error = "Non-finite PCM"; return false; }
  }
  for (size_t n = 0; n < frames; ++n)
    std::memcpy(&ring_[((w + n) % capacity_) * 2], data + n * 2, 2 * sizeof(float));
  written_.store(w + frames, std::memory_order_release);
  if (!started_ && w + frames - r >= prebufferFrames_) {
    return start(error);
  }
  return true;
}
bool BridgeReceiver::start(std::string* error) {
  if (!backend_ || failed_.load()) return false;
  if (started_ || written_.load() == read_.load()) return true;
  started_ = backend_->start([this](float* out, size_t count) { return render(out, count); },
      [this](OutputBackendEvent, const std::string&) { failed_.store(true, std::memory_order_release); }, error);
  if (!started_) failed_ = true;
  return started_;
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
  if (count < frames) underruns_.fetch_add(1, std::memory_order_relaxed);
  return frames;
}
void BridgeReceiver::close() {
  if (backend_) { backend_->stop(); backend_->close(); backend_.reset(); }
  started_ = false;
  ring_.clear();
  capacity_ = 0;
  prebufferFrames_ = 0;
  read_ = written_ = consumed_ = underruns_ = 0;
}
std::string BridgeReceiver::status() const {
  const OutputInfo info = backend_ ? backend_->outputInfo() : OutputInfo{};
  const auto r = read_.load(std::memory_order_acquire), w = written_.load(std::memory_order_acquire);
  std::ostringstream json;
  json << "{\"sampleRate\":" << format_.sampleRate << ",\"channels\":2,\"bufferedFrames\":" << w - r
       << ",\"capacityFrames\":" << capacity_ << ",\"prebufferFrames\":" << prebufferFrames_
       << ",\"consumedFrames\":" << consumed_.load()
       << ",\"underruns\":" << underruns_.load() << ",\"started\":" << (started_ ? "true" : "false")
       << ",\"failed\":" << (failed_.load() ? "true" : "false")
       << ",\"backend\":\"" << json_utils::escape(info.backend) << "\",\"deviceName\":\""
       << json_utils::escape(info.deviceName) << "\",\"actualSampleRate\":" << info.actualSampleRate
       << ",\"actualBitDepth\":" << info.actualBitDepth << ",\"actualChannels\":" << info.actualChannels
       << ",\"actualOutputFormat\":\"" << json_utils::escape(info.actualOutputFormat)
       << "\",\"exclusive\":" << (info.exclusive ? "true" : "false") << "}";
  return json.str();
}
} // namespace twilight::audio
