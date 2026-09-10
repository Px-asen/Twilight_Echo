#pragma once

#include "../abi/AsioAbi.h"

namespace twilight::audio::asio_windows {

inline bool restoreAsioPcmMode(asio_abi::AsioDriver& driver) {
  asio_abi::AsioIoFormat requested{};
  requested.formatType = asio_abi::kAsioIoFormatPcm;
  if (!asio_abi::asioErrorIsSuccess(driver.future(asio_abi::kFutureSetIoFormat, &requested)) ||
      requested.formatType != asio_abi::kAsioIoFormatPcm) {
    return false;
  }
  asio_abi::AsioIoFormat actual{};
  actual.formatType = asio_abi::kAsioIoFormatInvalid;
  return !asio_abi::asioErrorIsSuccess(driver.future(asio_abi::kFutureGetIoFormat, &actual)) ||
         actual.formatType == asio_abi::kAsioIoFormatPcm;
}

inline bool ensureAsioPcmMode(asio_abi::AsioDriver& driver) {
  asio_abi::AsioIoFormat actual{};
  actual.formatType = asio_abi::kAsioIoFormatInvalid;
  if (!asio_abi::asioErrorIsSuccess(driver.future(asio_abi::kFutureGetIoFormat, &actual))) return true;
  return actual.formatType == asio_abi::kAsioIoFormatPcm || restoreAsioPcmMode(driver);
}

}  // namespace twilight::audio::asio_windows
