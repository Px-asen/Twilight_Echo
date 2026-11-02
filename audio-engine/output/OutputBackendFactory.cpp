#include "OutputBackendFactory.h"
#include "bridge/BridgeCaptureBackend.h"

#include <cstdlib>

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

#if defined(__ANDROID__) && defined(TAE_ENABLE_OBOE)
#include "android/OboeOutputBackend.h"
#endif

#if defined(__ANDROID__) && defined(TAE_ENABLE_USB_DIRECT)
#include "usb/LibusbOutputBackend.h"
#endif

#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
#include "wasapi/WasapiExclusiveBackend.h"
#include "wasapi/WasapiSharedBackend.h"
#endif

#if defined(_WIN32) && defined(TAE_ENABLE_MINIAUDIO)
#include "miniaudio/MiniaudioPcmBackend.h"
#endif

#if defined(_WIN32) && defined(TAE_ENABLE_ASIO)
#include "asio/AsioBackend.h"
#endif

#if defined(__APPLE__) && defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE && defined(TAE_ENABLE_IOS_AUDIOUNIT)
#include "ios/IosAudioUnitBackend.h"
#elif defined(__APPLE__) && (!defined(TARGET_OS_IPHONE) || !TARGET_OS_IPHONE) && defined(TAE_ENABLE_COREAUDIO)
#include "coreaudio/CoreAudioBackend.h"
#include "coreaudio/CoreAudioExclusiveBackend.h"
#endif

#if defined(__linux__) && !defined(__ANDROID__) && defined(TAE_ENABLE_ALSA)
#include "alsa/AlsaBackend.h"
#endif

namespace twilight::audio {

namespace {

constexpr const char* kPcmProviderEnvironment = "TWILIGHT_AUDIO_PCM_PROVIDER";

bool miniaudioProviderBuilt() {
#if defined(_WIN32) && \
    (defined(TAE_ENABLE_MINIAUDIO) || (defined(TAE_TEST_MINIAUDIO_AVAILABLE) && TAE_TEST_MINIAUDIO_AVAILABLE))
  return true;
#else
  return false;
#endif
}

const char* compiledDefaultPcmProviderControlValueImpl() {
#if defined(TAE_DEFAULT_PCM_PROVIDER_MINIAUDIO) && TAE_DEFAULT_PCM_PROVIDER_MINIAUDIO
  return "miniaudio";
#else
  return "legacy";
#endif
}

}  // namespace

const char* compiledDefaultPcmProviderControlValue() {
  return compiledDefaultPcmProviderControlValueImpl();
}

PcmOutputProviderSelection resolvePcmOutputProvider(const char* configuredValue, bool miniaudioBuilt) {
  if (!configuredValue || configuredValue[0] == '\0' || std::string(configuredValue) == "legacy") {
    return {};
  }
  if (std::string(configuredValue) == "miniaudio") {
    if (miniaudioBuilt) {
      return {PcmOutputProvider::Miniaudio, PcmOutputProviderStatus::Ready, {}};
    }
    return {
        PcmOutputProvider::Miniaudio,
        PcmOutputProviderStatus::ProviderUnavailable,
        "TWILIGHT_AUDIO_PCM_PROVIDER=miniaudio was requested, but this audio engine build does not include "
        "miniaudio (TAE_ENABLE_MINIAUDIO=OFF)"};
  }
  return {
      PcmOutputProvider::Legacy,
      PcmOutputProviderStatus::InvalidConfiguration,
      std::string(kPcmProviderEnvironment) + " must be 'legacy' or 'miniaudio'; received '" +
          configuredValue + "'"};
}

const PcmOutputProviderSelection& configuredPcmOutputProvider() {
  const char* configuredValue = std::getenv(kPcmProviderEnvironment);
  if (!configuredValue || configuredValue[0] == '\0') {
    configuredValue = compiledDefaultPcmProviderControlValueImpl();
  }
  static const PcmOutputProviderSelection selection =
      resolvePcmOutputProvider(configuredValue, miniaudioProviderBuilt());
  return selection;
}

bool outputBackendUsesPcmProvider(const std::string& backendId) {
  return backendId == "wasapi" || backendId == "wasapi-shared";
}

PcmOutputProviderStatus validatePcmOutputProviderForBackend(
    const std::string& backendId,
    std::string* error) {
  if (!outputBackendUsesPcmProvider(backendId)) return PcmOutputProviderStatus::Ready;
  const PcmOutputProviderSelection& selection = configuredPcmOutputProvider();
  if (selection.status != PcmOutputProviderStatus::Ready && error) *error = selection.error;
  return selection.status;
}

std::string defaultBackendId() {
#if defined(__ANDROID__) && defined(TAE_ENABLE_OBOE)
  return "oboe";
#elif defined(__APPLE__) && defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE && defined(TAE_ENABLE_IOS_AUDIOUNIT)
  return "audiounit";
#elif defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  return "wasapi";
#elif defined(_WIN32) && defined(TAE_ENABLE_ASIO)
  return "asio";
#elif defined(__APPLE__) && (!defined(TARGET_OS_IPHONE) || !TARGET_OS_IPHONE) && defined(TAE_ENABLE_COREAUDIO)
  return "coreaudio";
#elif defined(__linux__) && !defined(__ANDROID__) && defined(TAE_ENABLE_ALSA)
  return "alsa";
#else
  return {};
#endif
}

bool isOutputBackendAvailable(const std::string& backendId) {
  if (backendId == "bridge-pcm") return true;
  (void)backendId;  // Builds with every platform backend disabled still compile cleanly.
#if defined(__ANDROID__) && defined(TAE_ENABLE_OBOE)
  if (backendId == "oboe") return true;
#endif
#if defined(__ANDROID__) && defined(TAE_ENABLE_USB_DIRECT)
  if (backendId == "usb-direct") return true;
#endif
#if defined(__APPLE__) && defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE && defined(TAE_ENABLE_IOS_AUDIOUNIT)
  if (backendId == "audiounit") return true;
#endif
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  if (backendId == "wasapi" || backendId == "wasapi-shared" || backendId == "wasapi-exclusive") return true;
#endif
#if defined(_WIN32) && defined(TAE_ENABLE_ASIO)
  if (backendId == "asio") return true;
#endif
#if defined(__APPLE__) && (!defined(TARGET_OS_IPHONE) || !TARGET_OS_IPHONE) && defined(TAE_ENABLE_COREAUDIO)
  if (backendId == "coreaudio" || backendId == "coreaudio-exclusive") return true;
#endif
#if defined(__linux__) && !defined(__ANDROID__) && defined(TAE_ENABLE_ALSA)
  if (backendId == "alsa") return true;
#endif
  return false;
}

std::unique_ptr<IOutputBackend> createOutputBackend(const std::string& backendId, std::string* error) {
  if (backendId == "bridge-pcm") return std::make_unique<BridgeCaptureBackend>();
  if (!isOutputBackendAvailable(backendId)) {
    if (error) *error = "Output backend is not available in this build: " + backendId;
    return nullptr;
  }
#if defined(__ANDROID__) && defined(TAE_ENABLE_USB_DIRECT)
  if (backendId == "usb-direct") return std::make_unique<LibusbOutputBackend>();
#endif
#if defined(__ANDROID__) && defined(TAE_ENABLE_OBOE)
  if (backendId == "oboe") {
    return std::make_unique<OboeOutputBackend>();
  }
#endif
#if defined(__APPLE__) && defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE && defined(TAE_ENABLE_IOS_AUDIOUNIT)
  if (backendId == "audiounit") {
    return std::make_unique<IosAudioUnitBackend>();
  }
#endif
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  if (backendId == "wasapi" || backendId == "wasapi-shared") {
    const PcmOutputProviderSelection& selection = configuredPcmOutputProvider();
    if (selection.status != PcmOutputProviderStatus::Ready) {
      if (error) *error = selection.error;
      return nullptr;
    }
#if defined(TAE_ENABLE_MINIAUDIO)
    if (selection.provider == PcmOutputProvider::Miniaudio) {
      return std::make_unique<MiniaudioPcmBackend>();
    }
#endif
    return std::make_unique<WasapiSharedBackend>();
  }
  if (backendId == "wasapi-exclusive") {
    return std::make_unique<WasapiExclusiveBackend>();
  }
#endif
#if defined(_WIN32) && defined(TAE_ENABLE_ASIO)
  if (backendId == "asio") {
    return std::make_unique<AsioBackend>();
  }
#endif
#if defined(__APPLE__) && (!defined(TARGET_OS_IPHONE) || !TARGET_OS_IPHONE) && defined(TAE_ENABLE_COREAUDIO)
  if (backendId == "coreaudio") {
    return std::make_unique<CoreAudioBackend>();
  }
  if (backendId == "coreaudio-exclusive") {
    return std::make_unique<CoreAudioExclusiveBackend>();
  }
#endif
#if defined(__linux__) && !defined(__ANDROID__) && defined(TAE_ENABLE_ALSA)
  if (backendId == "alsa") {
    return std::make_unique<AlsaBackend>();
  }
#endif
  return nullptr;
}

}  // namespace twilight::audio
