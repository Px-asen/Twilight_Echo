#pragma once

#if !defined(_WIN32) || (!defined(_M_IX86) && !defined(_M_X64) && !defined(__x86_64__))
#error "Twilight Echo ASIO ABI requires Windows x86 (MSVC) or x64"
#endif

#include <Unknwn.h>

#include <cstdint>

namespace twilight::audio::asio_abi {

using AsioBool = int32_t;
using AsioError = int32_t;
using AsioSampleRate = double;
#if defined(_WIN64)
using AsioSamples = int64_t;
using AsioTimeStamp = int64_t;
#define TAE_ASIO_METHOD
#else
// The 32-bit driver boundary stores the high word first, not a native int64_t.
struct AsioInt64 {
  uint32_t high;
  uint32_t low;
  constexpr AsioInt64(uint64_t value = 0) : high(static_cast<uint32_t>(value >> 32)), low(static_cast<uint32_t>(value)) {}
  constexpr operator uint64_t() const { return (uint64_t{high} << 32) | low; }
};
using AsioSamples = AsioInt64;
using AsioTimeStamp = AsioInt64;
#define TAE_ASIO_METHOD __thiscall
#endif
using AsioSampleType = int32_t;
using AsioIoFormatType = int32_t;

inline constexpr AsioError kAsioOk = 0;
inline constexpr AsioError kAsioSuccess = static_cast<AsioError>(0x3f4847a0U);
inline constexpr AsioBool kAsioFalse = 0;
inline constexpr AsioBool kAsioTrue = 1;
inline constexpr int32_t kAsioAbiContractVersion = 2;

constexpr bool asioBoolIsTrue(AsioBool value) {
  return value != kAsioFalse;
}

constexpr bool asioErrorIsSuccess(AsioError value) {
  return value == kAsioOk || value == kAsioSuccess;
}

inline constexpr AsioSampleType kAsioSampleInt16Lsb = 16;
inline constexpr AsioSampleType kAsioSampleInt16Msb = 0;
inline constexpr AsioSampleType kAsioSampleInt24Msb = 1;
inline constexpr AsioSampleType kAsioSampleInt32Msb = 2;
inline constexpr AsioSampleType kAsioSampleFloat32Msb = 3;
inline constexpr AsioSampleType kAsioSampleFloat64Msb = 4;
inline constexpr AsioSampleType kAsioSampleInt32Msb16 = 8;
inline constexpr AsioSampleType kAsioSampleInt32Msb18 = 9;
inline constexpr AsioSampleType kAsioSampleInt32Msb20 = 10;
inline constexpr AsioSampleType kAsioSampleInt32Msb24 = 11;
inline constexpr AsioSampleType kAsioSampleInt24Lsb = 17;
inline constexpr AsioSampleType kAsioSampleInt32Lsb = 18;
inline constexpr AsioSampleType kAsioSampleFloat32Lsb = 19;
inline constexpr AsioSampleType kAsioSampleFloat64Lsb = 20;
inline constexpr AsioSampleType kAsioSampleInt32Lsb16 = 24;
inline constexpr AsioSampleType kAsioSampleInt32Lsb18 = 25;
inline constexpr AsioSampleType kAsioSampleInt32Lsb20 = 26;
inline constexpr AsioSampleType kAsioSampleInt32Lsb24 = 27;
inline constexpr AsioSampleType kAsioSampleDsdInt8Lsb1 = 32;
inline constexpr AsioSampleType kAsioSampleDsdInt8Msb1 = 33;
inline constexpr AsioSampleType kAsioSampleDsdInt8Ner8 = 40;

// The SDK's contract for kAsioCanDoIoFormat / kAsioSetIoFormat: the caller fills
// in the requested type, and a driver that cannot honor it rewrites that field
// to Invalid. Return codes vary between drivers, so the rewritten field is the
// only unambiguous refusal.
inline constexpr AsioIoFormatType kAsioIoFormatInvalid = -1;
inline constexpr AsioIoFormatType kAsioIoFormatPcm = 0;
inline constexpr AsioIoFormatType kAsioIoFormatDsd = 1;

inline constexpr int32_t kSelectorSupported = 1;
inline constexpr int32_t kSelectorEngineVersion = 2;
inline constexpr int32_t kSelectorResetRequest = 3;
inline constexpr int32_t kSelectorBufferSizeChange = 4;
inline constexpr int32_t kSelectorResyncRequest = 5;
inline constexpr int32_t kSelectorLatenciesChanged = 6;
inline constexpr int32_t kSelectorSupportsTimeInfo = 7;
inline constexpr int32_t kSelectorSupportsTimeCode = 8;
inline constexpr int32_t kSelectorOverload = 9;

inline constexpr int32_t kFutureSetIoFormat = 0x23111961;
inline constexpr int32_t kFutureGetIoFormat = 0x23111983;
inline constexpr int32_t kFutureCanDoIoFormat = 0x23112004;

#if !defined(_WIN64)
#pragma pack(push, 4)
#endif

struct AsioBufferInfo {
  AsioBool isInput;
  int32_t channelNum;
  void* buffers[2];
};

struct AsioClockSource {
  int32_t index;
  int32_t associatedChannel;
  int32_t associatedGroup;
  AsioBool isCurrentSource;
  char name[32];
};

struct AsioChannelInfo {
  int32_t channel;
  AsioBool isInput;
  AsioBool isActive;
  int32_t channelGroup;
  AsioSampleType type;
  char name[32];
};

struct AsioIoFormat {
  AsioIoFormatType formatType;
  uint8_t reserved[508];
};

struct AsioTimeInfo {
  double speed;
#if defined(_WIN64)
  AsioSamples samplePosition;
  AsioTimeStamp systemTime;
#else
  AsioTimeStamp systemTime;
  AsioSamples samplePosition;
  AsioSampleRate sampleRate;
#endif
  uint32_t flags;
  char reserved[12];
};

struct AsioTimeCode {
  double speed;
  AsioSamples timeCodeSamples;
  uint32_t flags;
  char future[64];
};

struct AsioTime {
  int32_t reserved[4];
  AsioTimeInfo timeInfo;
  AsioTimeCode timeCode;
};

using AsioBufferSwitch = void (__cdecl *)(int32_t bufferIndex, AsioBool processNow);
using AsioSampleRateDidChange = void (__cdecl *)(AsioSampleRate sampleRate);
using AsioMessage = int32_t (__cdecl *)(int32_t selector, int32_t value, void* message, double* option);
using AsioBufferSwitchTimeInfo = AsioTime* (__cdecl *)(AsioTime* parameters, int32_t bufferIndex, AsioBool processNow);

struct AsioCallbacks {
  AsioBufferSwitch bufferSwitch;
  AsioSampleRateDidChange sampleRateDidChange;
  AsioMessage asioMessage;
  AsioBufferSwitchTimeInfo bufferSwitchTimeInfo;
};

#if !defined(_WIN64)
#pragma pack(pop)
#endif

class AsioDriver : public IUnknown {
 public:
  virtual AsioBool TAE_ASIO_METHOD init(void* systemReference) = 0;
  virtual void TAE_ASIO_METHOD getDriverName(char* name) = 0;
  virtual int32_t TAE_ASIO_METHOD getDriverVersion() = 0;
  virtual void TAE_ASIO_METHOD getErrorMessage(char* message) = 0;
  virtual AsioError TAE_ASIO_METHOD start() = 0;
  virtual AsioError TAE_ASIO_METHOD stop() = 0;
  virtual AsioError TAE_ASIO_METHOD getChannels(int32_t* inputChannels, int32_t* outputChannels) = 0;
  virtual AsioError TAE_ASIO_METHOD getLatencies(int32_t* inputLatency, int32_t* outputLatency) = 0;
  virtual AsioError TAE_ASIO_METHOD getBufferSize(
      int32_t* minimum,
      int32_t* maximum,
      int32_t* preferred,
      int32_t* granularity) = 0;
  virtual AsioError TAE_ASIO_METHOD canSampleRate(AsioSampleRate sampleRate) = 0;
  virtual AsioError TAE_ASIO_METHOD getSampleRate(AsioSampleRate* sampleRate) = 0;
  virtual AsioError TAE_ASIO_METHOD setSampleRate(AsioSampleRate sampleRate) = 0;
  virtual AsioError TAE_ASIO_METHOD getClockSources(AsioClockSource* clocks, int32_t* count) = 0;
  virtual AsioError TAE_ASIO_METHOD setClockSource(int32_t reference) = 0;
  virtual AsioError TAE_ASIO_METHOD getSamplePosition(AsioSamples* samplePosition, AsioTimeStamp* systemTime) = 0;
  virtual AsioError TAE_ASIO_METHOD getChannelInfo(AsioChannelInfo* channelInfo) = 0;
  virtual AsioError TAE_ASIO_METHOD createBuffers(
      AsioBufferInfo* bufferInfos,
      int32_t count,
      int32_t bufferSize,
      AsioCallbacks* callbacks) = 0;
  virtual AsioError TAE_ASIO_METHOD disposeBuffers() = 0;
  virtual AsioError TAE_ASIO_METHOD controlPanel() = 0;
  virtual AsioError TAE_ASIO_METHOD future(int32_t selector, void* option) = 0;
  virtual AsioError TAE_ASIO_METHOD outputReady() = 0;
};

#undef TAE_ASIO_METHOD

}  // namespace twilight::audio::asio_abi
