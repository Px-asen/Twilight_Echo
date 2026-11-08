#include "ConvolverProcessor.h"

#include "ConvolverProcessorUtils.h"
#include "KissFftAdapter.h"
#include "../core/Utf8Path.h"

#if defined(TAE_HAS_FFMPEG)
#include "../decoder/FFmpegDecoder.h"
#endif

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <limits>
#include <numbers>
#include <mutex>
#include <unordered_map>

namespace twilight::audio {
namespace {

// Control-thread cache. Weak entries do not retain retired IRs/graphs; the
// bounded index is independent of the number of live processor instances.
template<class T, class Build>
std::shared_ptr<const T> cachedPreparation(const std::string& key, Build build) {
  static std::mutex mutex;
  static std::unordered_map<std::string, std::weak_ptr<const T>> entries;
  if (key.empty()) return build();
  std::lock_guard lock(mutex);
  if (auto found = entries.find(key); found != entries.end())
    if (auto value = found->second.lock()) return value;
  for (auto it = entries.begin(); it != entries.end();)
    it = it->second.expired() ? entries.erase(it) : std::next(it);
  if (entries.size() >= 64) entries.erase(entries.begin());
  std::shared_ptr<const T> result = build();
  if (result) entries[key] = result;
  return result;
}

std::string impulseIdentity(const std::string& path) {
  std::error_code error;
  const auto file = std::filesystem::weakly_canonical(utf8Path(path), error);
  if (error) return {};
  const auto size = std::filesystem::file_size(file, error);
  if (error) return {};
  const auto modified = std::filesystem::last_write_time(file, error);
  if (error) return {};
  const auto name = file.u8string();
  return std::string(reinterpret_cast<const char*>(name.data()), name.size()) + ':' +
      std::to_string(size) + ':' +
      std::to_string(static_cast<long long>(modified.time_since_epoch().count()));
}

constexpr uint16_t kWavePcm = 0x0001;
constexpr uint16_t kWaveFloat = 0x0003;
constexpr uint16_t kWaveExtensible = 0xfffe;
constexpr std::array<unsigned char, 16> kWaveSubFormatPcm = {
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
    0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71};
constexpr std::array<unsigned char, 16> kWaveSubFormatFloat = {
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
    0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71};
constexpr const char* kConvolverRealtimeBypassReason = "convolver process exceeded realtime budget";
// First re-arm waits 500 ms, then 1 s, 2 s, ... Anything that keeps missing its budget this
// many times stays bypassed until the user changes the configuration.
constexpr std::chrono::milliseconds kConvolverRearmBaseCooldown{500};
constexpr uint32_t kConvolverMaxBypassGenerations = 5;
constexpr uint64_t kMaxImpulseFrames = 16ULL * 1024ULL * 1024ULL;
constexpr uint64_t kMaxImpulseSamples = kMaxImpulseFrames * 8ULL;

uint16_t readU16(const std::array<unsigned char, 2>& bytes) {
  return static_cast<uint16_t>(bytes[0] | (bytes[1] << 8));
}

uint32_t readU32(const std::array<unsigned char, 4>& bytes) {
  return static_cast<uint32_t>(bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24));
}

bool bytesEqual(const unsigned char* data, const std::array<unsigned char, 16>& expected) {
  return std::equal(expected.begin(), expected.end(), data);
}

float pcmToFloat(const unsigned char* data, uint16_t bitsPerSample, uint16_t formatTag) {
  if (formatTag == kWaveFloat && bitsPerSample == 32) {
    float value = 0.0f;
    std::memcpy(&value, data, sizeof(float));
    return std::isfinite(value) ? std::clamp(value, -8.0f, 8.0f) : 0.0f;
  }
  if (bitsPerSample == 16) {
    int16_t value = 0;
    std::memcpy(&value, data, sizeof(value));
    return static_cast<float>(value) / 32768.0f;
  }
  if (bitsPerSample == 24) {
    int32_t value = static_cast<int32_t>(data[0] | (data[1] << 8) | (data[2] << 16));
    if ((value & 0x00800000) != 0) value |= static_cast<int32_t>(0xff000000);
    return static_cast<float>(value) / 8388608.0f;
  }
  if (bitsPerSample == 32) {
    int32_t value = 0;
    std::memcpy(&value, data, sizeof(value));
    return static_cast<float>(static_cast<double>(value) / 2147483648.0);
  }
  return 0.0f;
}

std::string mappingModeFor(int irChannels, int outputChannels) {
  if (irChannels == 1) return "mono-to-all";
  if (irChannels == 2 && outputChannels == 2) return "stereo";
  if (irChannels == 2) return outputChannels == 1 ? "stereo-left" : "stereo-repeat";
  return "front-left-right";
}

bool hasRoutingMatrix(const DspConfig& config, int channels) {
  return channels > 0 && config.convolverMatrix.size() == static_cast<size_t>(channels * channels);
}

bool hasMonoToManyMatrix(const DspConfig& config, int channels) {
  return channels > 0 && config.convolverMatrix.size() == static_cast<size_t>(channels);
}

}  // namespace

struct ConvolverProcessor::FftChannel {
  using Complex = KissFftAdapter::Complex;

  // Larger tail tiers have at least one whole block of lookahead. Their FFT,
  // multiply/add and inverse FFT are resumable work, rather than one burst at
  // a partition boundary. The head still has exactly the advertised latency.
  struct Plan {
    size_t size = 0;
    std::vector<size_t> reversed;
    std::vector<Complex> roots;
    void prepare(size_t n) {
      size = n;
      reversed.resize(n);
      roots.resize(n / 2);
      for (size_t i = 1; i < n; ++i) reversed[i] = (reversed[i >> 1] >> 1) | ((i & 1) ? n / 2 : 0);
      for (size_t i = 0; i < n / 2; ++i) {
        const double angle = -2.0 * std::numbers::pi * i / n;
        roots[i] = Complex(static_cast<float>(std::cos(angle)), static_cast<float>(std::sin(angle)));
      }
    }
    void butterfly(std::vector<Complex>& data, size_t group, size_t offset, size_t half, size_t stride, bool inverse) const {
      const Complex root = roots[offset * stride];
      const float wi = inverse ? -root.imag() : root.imag();
      const Complex u = data[group + offset], v = data[group + offset + half];
      const float vr = v.real() * root.real() - v.imag() * wi;
      const float vi = v.real() * wi + v.imag() * root.real();
      data[group + offset] = Complex(u.real() + vr, u.imag() + vi);
      data[group + offset + half] = Complex(u.real() - vr, u.imag() - vi);
    }
    void transform(std::vector<Complex>& data, bool inverse) const {
      for (size_t i = 0; i < size; ++i) if (i < reversed[i]) std::swap(data[i], data[reversed[i]]);
      for (size_t length = 2; length <= size; length *= 2) {
        const size_t stride = size / length;
        for (size_t group = 0; group < size; group += length)
          for (size_t offset = 0; offset < length / 2; ++offset) butterfly(data, group, offset, length / 2, stride, inverse);
      }
    }
    void forward(std::vector<Complex>& data) const { transform(data, false); }
  };

  struct Kernel {
    size_t blockSize = 0, irOffset = 0;
    Plan plan;
    std::vector<std::vector<Complex>> impulse;
    Kernel(const std::vector<float>& ir, size_t offset, size_t end, size_t block)
        : blockSize(block), irOffset(offset) {
      const size_t n = block * 2, bins = block + 1;
      plan.prepare(n);
      const size_t count = std::max<size_t>(1, (end - offset + block - 1) / block);
      impulse.assign(count, std::vector<Complex>(bins));
      std::vector<Complex> scratch(n);
      for (size_t part = 0; part < count; ++part) {
        std::fill(scratch.begin(), scratch.end(), Complex{});
        for (size_t i = 0; i < block; ++i) {
          const size_t index = offset + part * block + i;
          scratch[i] = Complex(index < end ? ir[index] : 0.0f, 0.0f);
        }
        plan.forward(scratch);
        std::copy_n(scratch.begin(), bins, impulse[part].begin());
      }
    }
  };
  struct Tier {
    enum class Phase { Idle, Input, Forward, History, Product, Reflect, Inverse, Output };
    size_t blockSize = 0, irOffset = 0, inputPos = 0, currentIndex = 0, validHistory = 0;
    size_t cursor = 0, productPartition = 0, fftLength = 0, fftGroup = 0, fftOffset = 0;
    uint64_t outputStart = 0;
    size_t workPerSample = 0;
    size_t pendingWorkFrames = 0;
    Phase phase = Phase::Idle;
    std::shared_ptr<const Kernel> kernel;
    std::vector<float> input, jobInput;
    std::vector<std::vector<Complex>> history;
    std::vector<Complex> product;
    void configure(std::shared_ptr<const Kernel> prepared) {
      kernel = std::move(prepared);
      blockSize = kernel->blockSize; irOffset = kernel->irOffset;
      const size_t n = blockSize * 2, bins = blockSize + 1;
      const size_t count = kernel->impulse.size();
      history.assign(count, std::vector<Complex>(bins));
      input.assign(blockSize, 0.0f); jobInput.assign(blockSize, 0.0f); product.assign(n, Complex{});
      size_t levels = 0;
      for (size_t value = n; value > 1; value /= 2) ++levels;
      const size_t operations = n * (5 + levels) + bins * count;
      workPerSample = (operations + blockSize - 2) / (blockSize - 1);
      reset();
    }
    void reset() {
      inputPos = 0; currentIndex = 0; validHistory = 0; pendingWorkFrames = 0; phase = Phase::Idle;
      // History validity replaces clearing O(IR length) memory on re-arm.
    }
    uint64_t memoryBytes() const {
      uint64_t bytes = sizeof(*this) + (input.capacity() + jobInput.capacity()) * sizeof(float) +
          (product.capacity() + kernel->plan.roots.capacity()) * sizeof(Complex) + kernel->plan.reversed.capacity() * sizeof(size_t);
      for (const auto& value : kernel->impulse) bytes += value.capacity() * sizeof(Complex);
      for (const auto& value : history) bytes += value.capacity() * sizeof(Complex);
      return bytes;
    }
    void start(uint64_t blockEnd, size_t latency) {
      input.swap(jobInput);
      currentIndex = (currentIndex + history.size() - 1) % history.size();
      validHistory = std::min(validHistory + 1, history.size());
      outputStart = blockEnd - blockSize + irOffset + latency;
      cursor = 0; phase = Phase::Input;
    }
    void startTransform(Phase next) { cursor = 0; fftLength = 0; fftGroup = 0; fftOffset = 0; phase = next; }
    bool transformWork(std::vector<Complex>& data, bool inverse, size_t& operations) {
      if (fftLength == 0) {
        const size_t count = std::min(operations, kernel->plan.size - cursor);
        for (size_t end = cursor + count; cursor < end; ++cursor)
          if (cursor < kernel->plan.reversed[cursor]) std::swap(data[cursor], data[kernel->plan.reversed[cursor]]);
        operations -= count;
        if (cursor != kernel->plan.size) return false;
        fftLength = 2; cursor = 0;
      }
      while (operations > 0 && fftLength <= kernel->plan.size) {
        const size_t count = std::min(operations, fftLength / 2 - fftOffset);
        const size_t stride = kernel->plan.size / fftLength, half = fftLength / 2;
        for (size_t end = fftOffset + count; fftOffset < end; ++fftOffset)
          kernel->plan.butterfly(data, fftGroup, fftOffset, half, stride, inverse);
        operations -= count;
        if (fftOffset == fftLength / 2) {
          fftOffset = 0; fftGroup += fftLength;
          if (fftGroup == kernel->plan.size) { fftGroup = 0; fftLength *= 2; }
        }
      }
      return fftLength > kernel->plan.size;
    }
    void work(size_t operations, std::vector<float>& output) {
      const size_t n = kernel->plan.size;
      const size_t bins = blockSize + 1;
      const bool synchronous = operations == std::numeric_limits<size_t>::max();
      while (operations > 0 && phase != Phase::Idle) {
        if (phase == Phase::Input) {
          const size_t count = std::min(operations, (cursor < blockSize ? blockSize : n) - cursor);
          auto& data = product;
          if (cursor < blockSize) {
            for (size_t end = cursor + count; cursor < end; ++cursor) data[cursor] = Complex(jobInput[cursor], 0.0f);
          } else {
            std::fill_n(data.begin() + static_cast<std::ptrdiff_t>(cursor), count, Complex{});
            cursor += count;
          }
          operations -= count;
          if (cursor == n) startTransform(Phase::Forward);
        } else if (phase == Phase::Forward) {
          // The head finishes in this call; it needs no resumable FFT cursor
          // bookkeeping at each butterfly group. Tail work remains bounded.
          if (synchronous) {
            kernel->plan.forward(product); phase = Phase::History; cursor = 0;
          } else if (transformWork(product, false, operations)) {
            phase = Phase::History; cursor = 0;
          }
        } else if (phase == Phase::History) {
          const size_t count = std::min(operations, bins - cursor);
          std::copy_n(product.begin() + static_cast<std::ptrdiff_t>(cursor), count,
              history[currentIndex].begin() + static_cast<std::ptrdiff_t>(cursor));
          cursor += count; operations -= count;
          if (cursor == bins) { phase = Phase::Product; cursor = 0; productPartition = 0; }
        } else if (phase == Phase::Product) {
          const size_t count = std::min(operations, bins - cursor);
          const auto& data = history[(currentIndex + productPartition) % history.size()];
          const auto& ir = kernel->impulse[productPartition];
          if (productPartition == 0) {
            for (size_t end = cursor + count; cursor < end; ++cursor) {
              const Complex x = data[cursor], h = ir[cursor];
              product[cursor] = Complex(x.real() * h.real() - x.imag() * h.imag(), x.real() * h.imag() + x.imag() * h.real());
            }
          } else {
            for (size_t end = cursor + count; cursor < end; ++cursor) {
              const Complex x = data[cursor], h = ir[cursor];
              product[cursor] += Complex(x.real() * h.real() - x.imag() * h.imag(), x.real() * h.imag() + x.imag() * h.real());
            }
          }
          operations -= count;
          if (cursor == bins) {
            cursor = 0;
            if (++productPartition == validHistory) { phase = Phase::Reflect; cursor = bins; }
          }
        } else if (phase == Phase::Reflect) {
          const size_t count = std::min(operations, n - cursor);
          for (size_t end = cursor + count; cursor < end; ++cursor) product[cursor] = std::conj(product[n - cursor]);
          operations -= count;
          if (cursor == n) startTransform(Phase::Inverse);
        } else if (phase == Phase::Inverse) {
          if (synchronous) {
            kernel->plan.transform(product, true); phase = Phase::Output; cursor = 0;
          } else if (transformWork(product, true, operations)) {
            phase = Phase::Output; cursor = 0;
          }
        } else {
          const size_t slot = (outputStart + cursor) % output.size();
          const size_t count = std::min({operations, n - cursor, output.size() - slot});
          const float scale = 1.0f / static_cast<float>(n);
          for (size_t i = 0; i < count; ++i) output[slot + i] += product[cursor + i].real() * scale;
          cursor += count; operations -= count;
          if (cursor == n) phase = Phase::Idle;
        }
      }
    }
  };

  uint32_t partitionSize = 0;
  uint64_t position = 0;
  std::vector<Tier> tiers;
  std::vector<float> output;

  using Prepared = std::vector<std::shared_ptr<const Kernel>>;
  std::shared_ptr<const Prepared> prepared;
  void configure(const std::vector<float>& impulse, uint32_t requestedPartitionSize, const std::string& key) {
    partitionSize = std::max<uint32_t>(64, requestedPartitionSize);
    prepared = cachedPreparation<Prepared>(key, [&]() {
      auto result = std::make_shared<Prepared>();
      const size_t firstEnd = std::min(impulse.size(), size_t(partitionSize) * 8);
      result->push_back(std::make_shared<Kernel>(impulse, 0, firstEnd, partitionSize));
      size_t offset = firstEnd, block = size_t(partitionSize) * 4;
      while (offset < impulse.size()) {
        const size_t end = block >= 65536 ? impulse.size() : std::min(impulse.size(), block * 8);
        result->push_back(std::make_shared<Kernel>(impulse, offset, end, block));
        offset = end; block *= 4;
      }
      return result;
    });
    tiers.clear(); tiers.reserve(prepared->size());
    for (const auto& kernel : *prepared) {
      tiers.emplace_back(); tiers.back().configure(kernel);
    }
    const Tier& last = tiers.back();
    output.assign(last.irOffset + last.blockSize * 2 + partitionSize + 1, 0.0f);
    position = 0;
  }
  void reset() {
    for (auto& tier : tiers) tier.reset();
    std::fill(output.begin(), output.end(), 0.0f);
    position = 0;
  }
  uint64_t memoryBytes() const {
    uint64_t bytes = sizeof(*this) + output.capacity() * sizeof(float);
    for (const auto& tier : tiers) bytes += tier.memoryBytes();
    return bytes;
  }
  float process(float input) {
    if (tiers.empty()) return input;
    // Process before reading: the synchronous head finishes just before its
    // first delayed output sample is due, for any host callback size.
    for (size_t index = 0; index < tiers.size(); ++index) {
      Tier& tier = tiers[index];
      if (index > 0 && tier.phase != Tier::Phase::Idle) ++tier.pendingWorkFrames;
      tier.input[tier.inputPos++] = input;
      if (tier.inputPos == tier.blockSize) {
        tier.inputPos = 0;
        if (index > 0) {
          tier.work(tier.workPerSample * tier.pendingWorkFrames, output);
          tier.pendingWorkFrames = 0;
        }
        tier.start(position + 1, partitionSize);
        if (index == 0) tier.work(std::numeric_limits<size_t>::max(), output);
      }
    }
    const size_t slot = position++ % output.size();
    const float value = output[slot]; output[slot] = 0.0f;
    return std::isfinite(value) ? std::clamp(value, -8.0f, 8.0f) : 0.0f;
  }
  size_t framesUntilBoundary() const { return partitionSize - tiers.front().inputPos; }
  void finishChunk() {
    for (size_t index = 1; index < tiers.size(); ++index) {
      Tier& tier = tiers[index];
      tier.work(tier.workPerSample * tier.pendingWorkFrames, output);
      tier.pendingWorkFrames = 0;
    }
  }
};

ConvolverProcessor::ConvolverProcessor() = default;

ConvolverProcessor::~ConvolverProcessor() = default;

void ConvolverProcessor::configure(const DspConfig& config) {
  const bool changed = config.enabled != config_.enabled ||
      config.convolverEnabled != config_.convolverEnabled ||
      config.convolverWet != config_.convolverWet || config.convolverDry != config_.convolverDry ||
      config.convolverGainDb != config_.convolverGainDb ||
      config.convolverPolarityInverted != config_.convolverPolarityInverted ||
      config.convolverDelayMs != config_.convolverDelayMs ||
      config.convolverPartitionSize != config_.convolverPartitionSize ||
      config.convolverMatrix != config_.convolverMatrix;
  config_ = config;
  if (changed) rebuild();
}

void ConvolverProcessor::prepare(const AudioFormat& format) {
  const bool formatChanged = format.sampleRate != format_.sampleRate || format.channelCount != format_.channelCount;
  format_ = format;
  if (formatChanged) rebuild();
}

void ConvolverProcessor::setTrackContext(const DspTrackContext&) {
}

void ConvolverProcessor::process(float* samples, size_t frameCount) {
  if (!samples || frameCount == 0) return;
  // A realtime bypass is a temporary retreat, not a permanent one: give it another go once
  // the backoff elapses so a single scheduling hiccup does not mute convolution for the
  // rest of this graph generation.
  if (!active_ && !shouldRearmAfterBypass()) return;
  const auto started = std::chrono::steady_clock::now();
  const int channels = std::clamp(format_.channelCount, 1, 8);
  const bool routed = hasRoutingMatrix(config_, channels);
  const bool monoToMany = hasMonoToManyMatrix(config_, channels);
  size_t processed = 0;
  while (processed < frameCount) {
    const size_t chunk = std::min(frameCount - processed, channels_.front()->framesUntilBoundary());
    for (size_t frame = processed; frame < processed + chunk; ++frame) {
      float* current = samples + frame * static_cast<size_t>(channels);
      for (int output = 0; output < channels; ++output) {
        double input = 0.0;
        if (routed) {
          for (int inputChannel = 0; inputChannel < channels; ++inputChannel) {
            input += config_.convolverMatrix[static_cast<size_t>(output * channels + inputChannel)] * current[inputChannel];
          }
        } else if (monoToMany) {
          input = config_.convolverMatrix[static_cast<size_t>(output)] * current[0];
        } else {
          input = current[output];
        }
        routedInput_[static_cast<size_t>(output)] = static_cast<float>(std::clamp(input, -8.0, 8.0));
      }
      for (int output = 0; output < channels; ++output) {
        wetOutput_[static_cast<size_t>(output)] = channels_[static_cast<size_t>(output)]->process(
            routedInput_[static_cast<size_t>(output)]);
      }
      const size_t delayRingFrames = wetDelayFrames_ + 1;
      for (int channel = 0; channel < channels; ++channel) {
        const size_t channelIndex = static_cast<size_t>(channel);
        float wet = wetOutput_[channelIndex];
        if (!wetDelayBuffer_.empty()) {
          wetDelayBuffer_[wetDelayWriteFrame_ * static_cast<size_t>(channels) + channelIndex] = wet;
          const size_t readFrame =
              (wetDelayWriteFrame_ + delayRingFrames - wetDelayFrames_) % delayRingFrames;
          wet = wetDelayBuffer_[readFrame * static_cast<size_t>(channels) + channelIndex];
        }
        current[channel] = static_cast<float>(std::clamp(
            static_cast<double>(current[channel]) * config_.convolverDry +
                static_cast<double>(wet) * config_.convolverWet * wetGain_,
            -8.0,
            8.0));
      }
      wetDelayWriteFrame_ = (wetDelayWriteFrame_ + 1) % delayRingFrames;
    }
    for (auto& channel : channels_) channel->finishChunk();
    processed += chunk;
  }
  const auto elapsed = std::chrono::steady_clock::now() - started;
  const double elapsedMs = std::chrono::duration<double, std::milli>(elapsed).count();
  const double budgetMs = convolver::RealtimeBudget::milliseconds(frameCount, format_.sampleRate);
  info_.lastProcessMs = elapsedMs;
  info_.maxProcessMs = std::max(info_.maxProcessMs, elapsedMs);
  if (realtimeState_) {
    realtimeState_->lastProcessMs.store(elapsedMs, std::memory_order_relaxed);
    double previousMax = realtimeState_->maxProcessMs.load(std::memory_order_relaxed);
    while (elapsedMs > previousMax &&
           !realtimeState_->maxProcessMs.compare_exchange_weak(
               previousMax, elapsedMs, std::memory_order_relaxed, std::memory_order_relaxed)) {
    }
  }
  if (elapsedMs > budgetMs) {
    info_.overrunCount += 1;
    if (realtimeState_) realtimeState_->overrunCount.fetch_add(1, std::memory_order_relaxed);
  }
  if (realtimeBudget_.observe(elapsedMs > budgetMs, frameCount, format_.sampleRate, info_.partitionSize))
    bypassRealtime();
}

void ConvolverProcessor::reset() {
  for (auto& channel : channels_) {
    if (channel) channel->reset();
  }
  std::fill(wetDelayBuffer_.begin(), wetDelayBuffer_.end(), 0.0f);
  wetDelayWriteFrame_ = 0;
  realtimeBudget_.reset();
}

bool ConvolverProcessor::isActive() const {
  return active_;
}

bool ConvolverProcessor::loadImpulseResponse(const std::string& path, std::string* error) {
  const auto identity = impulseIdentity(path);
  auto ir = cachedPreparation<IrData>(identity, [&]() -> std::shared_ptr<const IrData> {
    auto loaded = std::make_shared<IrData>();
    return readImpulse(path, loaded.get(), error) ? loaded : nullptr;
  });
  if (!ir) {
    info_.lastError = error && !error->empty() ? *error : "无法读取脉冲响应文件";
    return false;
  }

  originalIr_ = std::move(ir);
  irIdentity_ = identity;
  runtimeIr_.reset();
  info_ = {};
  realtimeBudget_.reset();
  info_.loaded = true;
  info_.path = path;
  info_.sampleRate = originalIr_->sampleRate;
  info_.channels = originalIr_->channels;
  info_.lengthFrames = originalIr_->frames;
  info_.lengthMs =
      originalIr_->sampleRate > 0
          ? static_cast<double>(originalIr_->frames) * 1000.0 / static_cast<double>(originalIr_->sampleRate)
          : 0.0;
  config_.impulseResponsePath = path;
  config_.convolverEnabled = true;
  rebuild();
  return true;
}

void ConvolverProcessor::unloadImpulseResponse() {
  originalIr_.reset();
  runtimeIr_.reset();
  channels_.clear();
  routedInput_.fill(0.0f);
  wetOutput_.fill(0.0f);
  std::vector<float>{}.swap(wetDelayBuffer_);
  wetDelayFrames_ = 0;
  wetDelayWriteFrame_ = 0;
  wetGain_ = 1.0;
  active_ = false;
  info_ = {};
  realtimeBudget_.reset();
  realtimeBypassed_ = false;
  bypassGeneration_ = 0;
  if (realtimeState_) {
    realtimeState_->bypassed.store(false, std::memory_order_release);
    realtimeState_->overrunCount.store(0, std::memory_order_relaxed);
    realtimeState_->bypassCount.store(0, std::memory_order_relaxed);
    realtimeState_->lastProcessMs.store(0.0, std::memory_order_relaxed);
    realtimeState_->maxProcessMs.store(0.0, std::memory_order_relaxed);
  }
  config_.convolverEnabled = false;
  config_.impulseResponsePath.clear();
}

ConvolverInfo ConvolverProcessor::info() const {
  ConvolverInfo copy = info_;
  copy.active = active_;
  if (!realtimeState_) return copy;

  // Fold in what the render clone reported. This instance is not the one that runs on the
  // audio thread, so without the shared state a realtime bypass would never show up here.
  const uint64_t realtimeOverruns = realtimeState_->overrunCount.load(std::memory_order_relaxed);
  copy.overrunCount = std::max(copy.overrunCount, realtimeOverruns);
  copy.bypassCount = realtimeState_->bypassCount.load(std::memory_order_relaxed);
  const double realtimeLast = realtimeState_->lastProcessMs.load(std::memory_order_relaxed);
  if (realtimeLast > 0.0) copy.lastProcessMs = realtimeLast;
  copy.maxProcessMs =
      std::max(copy.maxProcessMs, realtimeState_->maxProcessMs.load(std::memory_order_relaxed));
  if (realtimeState_->bypassed.load(std::memory_order_acquire)) {
    copy.bypassed = true;
    copy.active = false;
    if (copy.lastError.empty()) copy.lastError = kConvolverRealtimeBypassReason;
  }
  return copy;
}

bool ConvolverProcessor::readImpulse(const std::string& path, IrData* out, std::string* error) {
  std::string waveError;
  if (readWaveImpulse(path, out, &waveError)) return true;

#if defined(TAE_HAS_FFMPEG)
  std::string decoderError;
  if (readFfmpegImpulse(path, out, &decoderError)) return true;
  if (error) {
    *error = decoderError.empty() ? waveError : decoderError;
  }
#else
  if (error) {
    *error = waveError.empty() ? "Only WAV impulse responses are available in this native build" : waveError;
  }
#endif
  return false;
}

bool ConvolverProcessor::readFfmpegImpulse(const std::string& path, IrData* out, std::string* error) {
#if defined(TAE_HAS_FFMPEG)
  if (!out) return false;
  FFmpegDecoder decoder;
  if (!decoder.open(path, error)) return false;

  AudioFormat format = decoder.streamInfo().decodedFormat;
  if (format.sampleRate <= 0 || format.channelCount <= 0 || format.channelCount > 8) {
    if (error) *error = "Impulse response must have between one and eight channels";
    return false;
  }
  format.sampleFormat = AudioSampleFormat::Float32Interleaved;
  format.bitDepth = 32;
  if (!decoder.setOutputFormat(format, error)) return false;

  constexpr size_t kDecodeBlockFrames = 4096;
  const size_t channels = static_cast<size_t>(format.channelCount);
  std::vector<float> scratch(kDecodeBlockFrames * channels, 0.0f);
  std::vector<float> interleaved;
  while (!decoder.eof()) {
    std::string decodeError;
    const size_t frames = decoder.readFrames(scratch.data(), kDecodeBlockFrames, &decodeError);
    if (frames == 0) {
      if (!decodeError.empty() && error) *error = decodeError;
      break;
    }
    const uint64_t nextSamples = static_cast<uint64_t>(interleaved.size()) + frames * channels;
    if (nextSamples > kMaxImpulseSamples) {
      if (error) *error = "Impulse response exceeds the managed runtime size limit";
      return false;
    }
    interleaved.insert(interleaved.end(), scratch.begin(), scratch.begin() + static_cast<std::ptrdiff_t>(frames * channels));
  }
  if (interleaved.empty() || interleaved.size() % channels != 0) {
    if (error && error->empty()) *error = "Impulse response contains no decoded audio";
    return false;
  }

  const uint64_t frames = static_cast<uint64_t>(interleaved.size() / channels);
  if (frames > kMaxImpulseFrames) {
    if (error) *error = "Impulse response exceeds the managed runtime frame limit";
    return false;
  }
  IrData ir;
  ir.sampleRate = format.sampleRate;
  ir.channels = format.channelCount;
  ir.frames = frames;
  ir.samples.assign(channels, std::vector<float>(static_cast<size_t>(frames), 0.0f));
  for (size_t frame = 0; frame < static_cast<size_t>(frames); ++frame) {
    for (size_t channel = 0; channel < channels; ++channel) {
      ir.samples[channel][frame] = std::clamp(interleaved[frame * channels + channel], -8.0f, 8.0f);
    }
  }
  *out = std::move(ir);
  return true;
#else
  (void)path;
  (void)out;
  if (error) *error = "FFmpeg impulse-response decoding is not enabled in this native build";
  return false;
#endif
}

bool ConvolverProcessor::readWaveImpulse(const std::string& path, IrData* out, std::string* error) {
  if (!out) return false;
  std::ifstream file(utf8Path(path), std::ios::binary);
  if (!file) {
    if (error) *error = "无法打开脉冲响应文件";
    return false;
  }

  char riff[4] = {};
  std::array<unsigned char, 4> chunkSize{};
  char wave[4] = {};
  file.read(riff, 4);
  file.read(reinterpret_cast<char*>(chunkSize.data()), 4);
  file.read(wave, 4);
  if (std::strncmp(riff, "RIFF", 4) != 0 || std::strncmp(wave, "WAVE", 4) != 0) {
    if (error) *error = "脉冲响应文件不是有效的 WAV";
    return false;
  }

  uint16_t formatTag = 0;
  uint16_t channels = 0;
  uint32_t sampleRate = 0;
  uint16_t blockAlign = 0;
  uint16_t bitsPerSample = 0;
  std::vector<unsigned char> audioData;

  while (file) {
    char id[4] = {};
    std::array<unsigned char, 4> sizeBytes{};
    file.read(id, 4);
    file.read(reinterpret_cast<char*>(sizeBytes.data()), 4);
    if (!file) break;
    const uint32_t size = readU32(sizeBytes);

    if (std::strncmp(id, "fmt ", 4) == 0) {
      std::vector<unsigned char> fmt(size);
      file.read(reinterpret_cast<char*>(fmt.data()), static_cast<std::streamsize>(fmt.size()));
      if (fmt.size() < 16) {
        if (error) *error = "WAV 格式块不完整";
        return false;
      }
      formatTag = static_cast<uint16_t>(fmt[0] | (fmt[1] << 8));
      channels = static_cast<uint16_t>(fmt[2] | (fmt[3] << 8));
      sampleRate = static_cast<uint32_t>(fmt[4] | (fmt[5] << 8) | (fmt[6] << 16) | (fmt[7] << 24));
      blockAlign = static_cast<uint16_t>(fmt[12] | (fmt[13] << 8));
      bitsPerSample = static_cast<uint16_t>(fmt[14] | (fmt[15] << 8));
      if (formatTag == kWaveExtensible && fmt.size() >= 40) {
        const uint16_t cbSize = static_cast<uint16_t>(fmt[16] | (fmt[17] << 8));
        const unsigned char* subFormat = fmt.data() + 24;
        if (cbSize >= 22 && bytesEqual(subFormat, kWaveSubFormatPcm)) {
          formatTag = kWavePcm;
        } else if (cbSize >= 22 && bytesEqual(subFormat, kWaveSubFormatFloat)) {
          formatTag = kWaveFloat;
        }
      }
    } else if (std::strncmp(id, "data", 4) == 0) {
      if (size > kMaxImpulseSamples * sizeof(float)) {
        if (error) *error = "Impulse response exceeds the managed runtime size limit";
        return false;
      }
      audioData.resize(size);
      file.read(reinterpret_cast<char*>(audioData.data()), static_cast<std::streamsize>(audioData.size()));
    } else {
      file.seekg(size, std::ios::cur);
    }
    if ((size & 1U) != 0U) file.seekg(1, std::ios::cur);
  }

  if (channels == 0 || channels > 8 || sampleRate == 0 || blockAlign == 0 || audioData.empty()) {
    if (error) *error = "WAV 脉冲响应缺少音频数据";
    return false;
  }
  if (formatTag != kWavePcm && formatTag != kWaveFloat) {
    if (error) *error = "当前仅支持 PCM 或 Float WAV 脉冲响应";
    return false;
  }

  const size_t frameCount = audioData.size() / blockAlign;
  if (frameCount > kMaxImpulseFrames) {
    if (error) *error = "Impulse response exceeds the managed runtime frame limit";
    return false;
  }
  const size_t bytesPerSample = std::max<size_t>(1, bitsPerSample / 8);
  IrData ir;
  ir.sampleRate = static_cast<int>(sampleRate);
  ir.channels = static_cast<int>(channels);
  ir.frames = static_cast<uint64_t>(frameCount);
  ir.samples.assign(channels, std::vector<float>(frameCount, 0.0f));
  for (size_t frame = 0; frame < frameCount; ++frame) {
    const size_t frameOffset = frame * blockAlign;
    for (uint16_t channel = 0; channel < channels; ++channel) {
      const size_t offset = frameOffset + static_cast<size_t>(channel) * bytesPerSample;
      if (offset + bytesPerSample <= audioData.size()) {
        ir.samples[channel][frame] = pcmToFloat(audioData.data() + offset, bitsPerSample, formatTag);
      }
    }
  }

  *out = std::move(ir);
  return true;
}

ConvolverProcessor::IrData ConvolverProcessor::resampleIr(const IrData& source, int targetSampleRate) {
  if (source.sampleRate <= 0 || targetSampleRate <= 0 || source.sampleRate == targetSampleRate) return source;

  IrData out;
  out.sampleRate = targetSampleRate;
  out.channels = source.channels;
  out.frames = static_cast<uint64_t>(
      std::max<double>(1.0, std::round(static_cast<double>(source.frames) * targetSampleRate / source.sampleRate)));
  out.samples.assign(static_cast<size_t>(out.channels), std::vector<float>(static_cast<size_t>(out.frames), 0.0f));

  for (int channel = 0; channel < out.channels; ++channel) {
    const auto& input = source.samples[static_cast<size_t>(channel)];
    auto& output = out.samples[static_cast<size_t>(channel)];
    for (size_t i = 0; i < output.size(); ++i) {
      const double position = static_cast<double>(i) * source.sampleRate / targetSampleRate;
      const size_t left = std::min(input.size() - 1, static_cast<size_t>(std::floor(position)));
      const size_t right = std::min(input.size() - 1, left + 1);
      const double t = position - static_cast<double>(left);
      output[i] = static_cast<float>((1.0 - t) * input[left] + t * input[right]);
    }
  }
  return out;
}

void ConvolverProcessor::rebuild() {
  active_ = false;
  // Retain old immutable kernels until the replacement has acquired them.
  // Runtime histories remain private and are destroyed on the control thread.
  auto previousChannels = std::move(channels_);
  wetDelayBuffer_.clear();
  wetDelayFrames_ = 0;
  wetDelayWriteFrame_ = 0;
  wetGain_ = 1.0;
  if (!config_.enabled || !config_.convolverEnabled || !originalIr_ || format_.sampleRate <= 0 ||
      format_.channelCount <= 0 || format_.channelCount > 8) {
    runtimeIr_.reset();
    std::vector<float>{}.swap(wetDelayBuffer_);
    info_.active = false;
    return;
  }

  std::string error;
  if (!prepareRuntimeIr(&error)) {
    info_.lastError = error;
    info_.active = false;
    return;
  }
  info_.active = active_;
}

void ConvolverProcessor::bypassRealtime() {
  active_ = false;
  realtimeBypassed_ = true;
  info_.active = false;
  info_.bypassed = true;
  // No std::string assignment here: this runs on the audio thread and the old
  // info_.lastError write allocated. info() reconstitutes the reason from the shared flag.
  if (bypassGeneration_ < kConvolverMaxBypassGenerations) ++bypassGeneration_;
  lastBypassAt_ = std::chrono::steady_clock::now();
  if (realtimeState_) {
    realtimeState_->bypassed.store(true, std::memory_order_release);
    realtimeState_->bypassCount.fetch_add(1, std::memory_order_relaxed);
    realtimeState_->lastBypassTicks.store(
        std::chrono::steady_clock::now().time_since_epoch().count(), std::memory_order_relaxed);
  }
}

bool ConvolverProcessor::shouldRearmAfterBypass() {
  if (!realtimeBypassed_) return false;
  if (channels_.empty()) return false;
  if (bypassGeneration_ >= kConvolverMaxBypassGenerations) return false;

  const auto cooldown = kConvolverRearmBaseCooldown * (1u << (bypassGeneration_ - 1));
  const auto elapsed = std::chrono::steady_clock::now() - lastBypassAt_;
  if (elapsed < cooldown) return false;

  // Re-arm. Filter state is stale after the gap, so clear it -- FftChannel::reset() only
  // fills existing buffers and never allocates, so this is realtime-safe.
  for (auto& channel : channels_) {
    if (channel) channel->reset();
  }
  std::fill(wetDelayBuffer_.begin(), wetDelayBuffer_.end(), 0.0f);
  wetDelayWriteFrame_ = 0;
  realtimeBudget_.reset();
  realtimeBypassed_ = false;
  active_ = true;
  info_.active = true;
  info_.bypassed = false;
  if (realtimeState_) realtimeState_->bypassed.store(false, std::memory_order_release);
  return true;
}

void ConvolverProcessor::setRealtimeState(std::shared_ptr<ConvolverRealtimeState> state) {
  if (!state) return;
  realtimeState_ = std::move(state);
}

bool ConvolverProcessor::prepareRuntimeIr(std::string* error) {
  if (!originalIr_) {
    if (error) *error = "尚未加载脉冲响应";
    return false;
  }

  const bool needsResample = originalIr_->sampleRate != format_.sampleRate;
  if (!runtimeIr_ || runtimeIr_->sampleRate != format_.sampleRate) {
    // Keep only the active rate. Other live graphs can still share their IR
    // through the weak preparation index without pinning retired rates here.
    runtimeIr_ = needsResample
        ? cachedPreparation<IrData>(irIdentity_.empty() ? "" : irIdentity_ + ":rate:" + std::to_string(format_.sampleRate),
            [&]() { return std::make_shared<IrData>(resampleIr(*originalIr_, format_.sampleRate)); })
        : originalIr_;
  }

  const IrData& ir = *runtimeIr_;
  if (ir.samples.empty() || ir.frames == 0) {
    if (error) *error = "脉冲响应没有可用采样";
    return false;
  }

  updateInfoFromRuntime(ir, needsResample);
  const int outputChannels = format_.channelCount;
  if (!config_.convolverMatrix.empty() && !hasRoutingMatrix(config_, outputChannels) &&
      !hasMonoToManyMatrix(config_, outputChannels)) {
    if (error) *error = "Convolution routing must be a 1xN or NxN matrix for the active channel layout";
    return false;
  }
  const uint32_t partitionSize = choosePartitionSize(ir);
  channels_.clear();
  channels_.reserve(static_cast<size_t>(format_.channelCount));
  for (int channel = 0; channel < format_.channelCount; ++channel) {
    auto fftChannel = std::make_unique<FftChannel>();
    const int sourceChannel = std::clamp(channel, 0, ir.channels - 1);
    const auto key = irIdentity_.empty() ? "" : irIdentity_ + ":fft:" +
        std::to_string(format_.sampleRate) + ':' + std::to_string(partitionSize) + ':' + std::to_string(sourceChannel);
    fftChannel->configure(impulseForOutputChannel(ir, channel), partitionSize, key);
    channels_.push_back(std::move(fftChannel));
  }
  wetGain_ = std::pow(10.0, std::clamp(config_.convolverGainDb, -60.0, 24.0) / 20.0);
  if (config_.convolverPolarityInverted) wetGain_ = -wetGain_;
  wetDelayFrames_ = static_cast<size_t>(std::round(
      std::clamp(config_.convolverDelayMs, 0.0, 250.0) * static_cast<double>(format_.sampleRate) / 1000.0));
  const size_t delayRingFrames = wetDelayFrames_ + 1;
  wetDelayBuffer_.assign(delayRingFrames * static_cast<size_t>(format_.channelCount), 0.0f);
  wetDelayWriteFrame_ = 0;
  info_.partitionSize = partitionSize;
  info_.latencyFrames = partitionSize + static_cast<uint32_t>(wetDelayFrames_);
  info_.tailFrames = ir.frames + partitionSize + wetDelayFrames_;
  info_.memoryBytes = 0;
  for (const auto& channel : channels_) {
    if (channel) info_.memoryBytes += channel->memoryBytes();
  }
  info_.memoryBytes += static_cast<uint64_t>(wetDelayBuffer_.capacity()) * sizeof(float);
  if (hasRoutingMatrix(config_, outputChannels)) {
    info_.channelMappingMode = "matrix-nxn";
  } else if (hasMonoToManyMatrix(config_, outputChannels)) {
    info_.channelMappingMode = "matrix-1xn";
  }
  active_ = true;
  info_.active = true;
  info_.bypassed = false;
  realtimeBudget_.reset();
  // A fresh runtime IR is a clean slate: drop the accumulated backoff so a reconfigured
  // convolver is not still serving a penalty earned by the previous setup.
  realtimeBypassed_ = false;
  bypassGeneration_ = 0;
  if (realtimeState_) realtimeState_->bypassed.store(false, std::memory_order_release);
  return true;
}

uint32_t ConvolverProcessor::choosePartitionSize(const IrData& ir) const {
  if (config_.convolverPartitionSize > 0) {
    uint32_t partitionSize = 64;
    const uint32_t requested = std::clamp(config_.convolverPartitionSize, 64U, 8192U);
    while (partitionSize < requested && partitionSize < 8192U) partitionSize *= 2;
    return partitionSize;
  }
  if (ir.sampleRate >= 176400) return 256;
  if (ir.sampleRate > 48000) return 512;
  return 1024;
}

const std::vector<float>& ConvolverProcessor::impulseForOutputChannel(const IrData& ir, int outputChannel) const {
  if (ir.channels <= 1) return ir.samples[0];
  const size_t sourceChannel = static_cast<size_t>(std::clamp(outputChannel, 0, ir.channels - 1));
  return ir.samples[std::min(sourceChannel, ir.samples.size() - 1)];
}

void ConvolverProcessor::updateInfoFromRuntime(const IrData& ir, bool resampled) {
  info_.loaded = static_cast<bool>(originalIr_);
  info_.active = active_;
  info_.irResampled = resampled;
  info_.sampleRate = ir.sampleRate;
  info_.channels = ir.channels;
  info_.lengthFrames = ir.frames;
  info_.lengthMs =
      ir.sampleRate > 0 ? static_cast<double>(ir.frames) * 1000.0 / static_cast<double>(ir.sampleRate) : 0.0;
  info_.channelMappingMode = mappingModeFor(ir.channels, format_.channelCount);
  info_.warning.clear();
  info_.lastError.clear();
  info_.bypassed = false;
  if (ir.channels > 2) {
    info_.warning = "多声道脉冲响应已使用前左和前右声道";
  }
}

}  // namespace twilight::audio
