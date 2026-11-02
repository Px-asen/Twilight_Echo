#include "AsioAbi.h"

#include <cstddef>
#include <type_traits>

using namespace twilight::audio::asio_abi;

static_assert(sizeof(bool) == 1);
static_assert(sizeof(long) == 4);
static_assert(sizeof(double) == 8);
static_assert(sizeof(AsioBool) == 4);
static_assert(sizeof(AsioBufferInfo) == (sizeof(void*) == 8 ? 24 : 16));
static_assert(alignof(AsioBufferInfo) == sizeof(void*));
static_assert(offsetof(AsioBufferInfo, channelNum) == 4);
static_assert(offsetof(AsioBufferInfo, buffers) == 8);
static_assert(sizeof(AsioClockSource) == 48);
static_assert(offsetof(AsioClockSource, name) == 16);
static_assert(sizeof(AsioChannelInfo) == 52);
static_assert(offsetof(AsioChannelInfo, type) == 16);
static_assert(offsetof(AsioChannelInfo, name) == 20);
static_assert(sizeof(AsioIoFormat) == 512);
static_assert(alignof(AsioIoFormat) == 4);
static_assert(offsetof(AsioIoFormat, formatType) == 0);
static_assert(offsetof(AsioIoFormat, reserved) == 4);
#if defined(_WIN64)
static_assert(sizeof(AsioTimeInfo) == 40);
static_assert(offsetof(AsioTimeInfo, samplePosition) == 8);
static_assert(offsetof(AsioTimeInfo, systemTime) == 16);
static_assert(sizeof(AsioTimeCode) == 88);
static_assert(sizeof(AsioTime) == 144);
#else
static_assert(sizeof(AsioSamples) == 8 && alignof(AsioSamples) == 4);
static_assert(offsetof(AsioSamples, high) == 0 && offsetof(AsioSamples, low) == 4);
static_assert(sizeof(AsioTimeInfo) == 48 && alignof(AsioTimeInfo) == 4);
static_assert(offsetof(AsioTimeInfo, systemTime) == 8);
static_assert(offsetof(AsioTimeInfo, samplePosition) == 16);
static_assert(offsetof(AsioTimeInfo, sampleRate) == 24);
static_assert(offsetof(AsioTimeInfo, flags) == 32);
static_assert(sizeof(AsioTimeCode) == 84);
static_assert(sizeof(AsioTime) == 148);
#endif
static_assert(sizeof(AsioCallbacks) == 4 * sizeof(void*));
static_assert(std::is_standard_layout_v<AsioIoFormat>);
static_assert(std::is_polymorphic_v<AsioDriver>);

int main() {
  return 0;
}
