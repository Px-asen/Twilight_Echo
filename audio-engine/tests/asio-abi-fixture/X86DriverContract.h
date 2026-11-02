#pragma once

// Test-only, separately declared x86 boundary. Do not include the host ABI here:
// the fake DLL must be able to detect host layout/calling-convention mistakes.
#include <Unknwn.h>
#include <cstdint>

namespace twilight::audio::asio_abi {
using AsioBool = int32_t;
using AsioError = int32_t;
using AsioSampleRate = double;
using AsioIoFormatType = int32_t;
constexpr int kAsioAbiContractVersion = 2;
constexpr int kAsioFalse = 0, kAsioTrue = 1, kAsioOk = 0;
constexpr int kAsioIoFormatPcm = 0, kAsioIoFormatDsd = 1, kAsioIoFormatInvalid = -1;
constexpr int kAsioSampleDsdInt8Lsb1 = 32, kAsioSampleFloat32Lsb = 19;
constexpr int kFutureCanDoIoFormat = 0x23112004, kFutureGetIoFormat = 0x23111983,
              kFutureSetIoFormat = 0x23111961;
constexpr int kSelectorEngineVersion = 2, kSelectorResetRequest = 3;

#pragma pack(push, 4)
struct AsioSamples {
  uint32_t high, low;
  AsioSamples(uint64_t value = 0) : high(uint32_t(value >> 32)), low(uint32_t(value)) {}
};
using AsioTimeStamp = AsioSamples;
struct AsioBufferInfo { int32_t isInput, channelNum; void* buffers[2]; };
struct AsioClockSource { int32_t index, associatedChannel, associatedGroup, isCurrentSource; char name[32]; };
struct AsioChannelInfo { int32_t channel, isInput, isActive, channelGroup, type; char name[32]; };
struct AsioIoFormat { int32_t formatType; uint8_t reserved[508]; };
struct AsioTimeInfo {
  double speed;
  AsioTimeStamp systemTime;
  AsioSamples samplePosition;
  double sampleRate;
  uint32_t flags;
  char reserved[12];
};
struct AsioTimeCode { double speed; AsioSamples timeCodeSamples; uint32_t flags; char future[64]; };
struct AsioTime { int32_t reserved[4]; AsioTimeInfo timeInfo; AsioTimeCode timeCode; };
struct AsioCallbacks {
  void (__cdecl *bufferSwitch)(int32_t, int32_t);
  void (__cdecl *sampleRateDidChange)(double);
  int32_t (__cdecl *asioMessage)(int32_t, int32_t, void*, double*);
  AsioTime* (__cdecl *bufferSwitchTimeInfo)(AsioTime*, int32_t, int32_t);
};
#pragma pack(pop)

class AsioDriver : public IUnknown {
 public:
  virtual int32_t __thiscall init(void*) = 0;
  virtual void __thiscall getDriverName(char*) = 0;
  virtual int32_t __thiscall getDriverVersion() = 0;
  virtual void __thiscall getErrorMessage(char*) = 0;
  virtual int32_t __thiscall start() = 0;
  virtual int32_t __thiscall stop() = 0;
  virtual int32_t __thiscall getChannels(int32_t*, int32_t*) = 0;
  virtual int32_t __thiscall getLatencies(int32_t*, int32_t*) = 0;
  virtual int32_t __thiscall getBufferSize(int32_t*, int32_t*, int32_t*, int32_t*) = 0;
  virtual int32_t __thiscall canSampleRate(double) = 0;
  virtual int32_t __thiscall getSampleRate(double*) = 0;
  virtual int32_t __thiscall setSampleRate(double) = 0;
  virtual int32_t __thiscall getClockSources(AsioClockSource*, int32_t*) = 0;
  virtual int32_t __thiscall setClockSource(int32_t) = 0;
  virtual int32_t __thiscall getSamplePosition(AsioSamples*, AsioTimeStamp*) = 0;
  virtual int32_t __thiscall getChannelInfo(AsioChannelInfo*) = 0;
  virtual int32_t __thiscall createBuffers(AsioBufferInfo*, int32_t, int32_t, AsioCallbacks*) = 0;
  virtual int32_t __thiscall disposeBuffers() = 0;
  virtual int32_t __thiscall controlPanel() = 0;
  virtual int32_t __thiscall future(int32_t, void*) = 0;
  virtual int32_t __thiscall outputReady() = 0;
};
static_assert(sizeof(void*) == 4 && sizeof(AsioBufferInfo) == 16);
static_assert(sizeof(AsioTimeInfo) == 48 && sizeof(AsioTimeCode) == 84 && sizeof(AsioTime) == 148);
}  // namespace twilight::audio::asio_abi
