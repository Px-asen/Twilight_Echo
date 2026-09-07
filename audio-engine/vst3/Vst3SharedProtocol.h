#pragma once

#include <cstddef>
#include <cstdint>
#include <type_traits>

namespace twilight::vst3::ipc {

constexpr uint32_t kProtocolMagic = 0x33564554u;  // "TEV3"
constexpr uint32_t kProtocolVersion = 2;
constexpr uint32_t kSlotCount = 4;
constexpr uint32_t kMaxChannels = 8;
constexpr uint32_t kMaxFrames = 4096;
constexpr uint32_t kMaxParameters = 2048;
constexpr uint32_t kMaxParameterJsonBytes = kMaxParameters * 64 + 1;
constexpr uint32_t kMaxStatusMessageBytes = 512;

enum class HostState : int32_t {
  Initializing = 0,
  Ready = 1,
  Failed = 2,
  Stopping = 3,
  Stopped = 4
};

enum class SlotState : int32_t {
  Empty = 0,
  Ready = 1,
  Processing = 2,
  OutputReady = 3
};

struct alignas(64) AudioSlot {
  volatile int32_t state = static_cast<int32_t>(SlotState::Empty);
  uint32_t sequence = 0;
  uint32_t frames = 0;
  uint32_t channels = 0;
  float input[kMaxFrames * kMaxChannels]{};
  float output[kMaxFrames * kMaxChannels]{};
};

struct alignas(64) SharedMemory {
  uint32_t magic = kProtocolMagic;
  uint32_t version = kProtocolVersion;
  uint32_t sampleRate = 0;
  uint32_t channels = 0;
  uint32_t maxFrames = kMaxFrames;
  uint32_t reserved = 0;
  volatile int32_t hostState = static_cast<int32_t>(HostState::Initializing);
  volatile int32_t hostHeartbeat = 0;
  volatile int32_t hostErrorCode = 0;
  volatile int32_t reservedAtomic = 0;
  uint32_t pluginLatencyFrames = 0;
  uint32_t pluginTailFrames = 0;
  uint32_t parameterJsonLength = 0;
  char parameterJson[kMaxParameterJsonBytes]{};
  char statusMessage[kMaxStatusMessageBytes]{};
  AudioSlot slots[kSlotCount]{};
};

static_assert(std::is_standard_layout_v<AudioSlot>);
static_assert(std::is_standard_layout_v<SharedMemory>);
static_assert(sizeof(int32_t) == 4);

}  // namespace twilight::vst3::ipc
