#include "TwilightAudioEngine.h"

#include "../analysis/BpmAnalyzer.h"
#include "../analysis/LoudnessAnalyzer.h"
#include "../automix-native/AutoMixAdapter.h"
#include "../decoder/SacdIsoProbe.h"
#include "../devices/DeviceManager.h"
#include "../metadata/AudioMetadataService.h"
#include "../output/OutputBackendFactory.h"
#include "../utils/JsonUtils.h"
#include "DiagnosticLog.h"
#include "PcmSampleRatePolicy.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstring>
#include <memory>
#include <optional>
#include <sstream>

namespace twilight::audio {

std::string enumerateAsioDevicesJson();
std::string pluginCapabilitiesJson();

namespace {

const char* stateToString(PlaybackState state) {
  switch (state) {
    case PlaybackState::Playing:
      return "playing";
    case PlaybackState::Paused:
      return "paused";
    case PlaybackState::Stopped:
    default:
      return "stopped";
  }
}

const char* resultToString(TAE_Result result) {
  switch (result) {
    case TAE_RESULT_OK:
      return "TAE_RESULT_OK";
    case TAE_RESULT_INVALID_ARGUMENT:
      return "TAE_RESULT_INVALID_ARGUMENT";
    case TAE_RESULT_NOT_INITIALIZED:
      return "TAE_RESULT_NOT_INITIALIZED";
    case TAE_RESULT_BACKEND_UNAVAILABLE:
      return "TAE_RESULT_BACKEND_UNAVAILABLE";
    case TAE_RESULT_INTERNAL_ERROR:
    default:
      return "TAE_RESULT_INTERNAL_ERROR";
  }
}

void writeLatencyInfoJson(std::ostringstream& json, const OutputInfo::LatencyInfo& latency) {
  json << "{"
       << "\"bufferLatencyMs\":" << latency.bufferLatencyMs << ","
       << "\"outputLatencyMs\":" << latency.outputLatencyMs << ","
       << "\"totalLatencyMs\":" << latency.totalLatencyMs
       << "}";
}

void writeDiagnosticsJson(std::ostringstream& json, const OutputInfo::Diagnostics& diagnostics) {
  json << "{"
       << "\"decodeHealthAvailable\":" << (diagnostics.decodeHealthAvailable ? "true" : "false") << ","
       << "\"decodeStreamToken\":" << diagnostics.decodeStreamToken << ","
       << "\"decodeRunning\":" << (diagnostics.decodeRunning ? "true" : "false") << ","
       << "\"decodeEof\":" << (diagnostics.decodeEof ? "true" : "false") << ","
       << "\"decodeStopRequested\":" << (diagnostics.decodeStopRequested ? "true" : "false") << ","
       << "\"decodeBufferedFrames\":" << diagnostics.decodeBufferedFrames << ","
       << "\"decodeProducedFrames\":" << diagnostics.decodeProducedFrames << ","
       << "\"decodeLastProgressAgeMs\":" << diagnostics.decodeLastProgressAgeMs << ","
       << "\"decodeStage\":\"" << json_utils::escape(diagnostics.decodeStage) << "\","
       << "\"liveRenderState\":" << diagnostics.liveRenderState << ","
       << "\"liveRenderedFrames\":" << diagnostics.liveRenderedFrames << ","
       << "\"liveRenderCallbackCount\":" << diagnostics.liveRenderCallbackCount << ","
       << "\"asioHelperCallbackCount\":" << diagnostics.asioHelperCallbackCount << ","
       << "\"asioHelperUnderrunCount\":" << diagnostics.asioHelperUnderrunCount << ","
       << "\"asioHelperBufferDropCount\":" << diagnostics.asioHelperBufferDropCount << ","
       << "\"sessionUnderrunCount\":" << diagnostics.sessionUnderrunCount << ","
       << "\"sessionBufferDropCount\":" << diagnostics.sessionBufferDropCount << ","
       << "\"sessionRecoveryCount\":" << diagnostics.sessionRecoveryCount << ","
       << "\"lifetimeUnderrunCount\":" << diagnostics.lifetimeUnderrunCount << ","
       << "\"lifetimeBufferDropCount\":" << diagnostics.lifetimeBufferDropCount << ","
       << "\"lifetimeRecoveryCount\":" << diagnostics.lifetimeRecoveryCount << ","
       << "\"driverRestartCount\":" << diagnostics.driverRestartCount << ","
       << "\"deviceLostCount\":" << diagnostics.deviceLostCount << ","
       << "\"driverXrunCount\":" << diagnostics.driverXrunCount << ","
       << "\"dsdIdleFrameCount\":" << diagnostics.dsdIdleFrameCount << ","
       << "\"dsdShortReadCount\":" << diagnostics.dsdShortReadCount << ","
       << "\"dsdTransport\":\"" << json_utils::escape(diagnostics.dsdTransport) << "\","
       << "\"dsdSourceBitOrder\":\"" << json_utils::escape(diagnostics.dsdSourceBitOrder) << "\","
       << "\"dsdSourcePacking\":\"" << json_utils::escape(diagnostics.dsdSourcePacking) << "\","
       << "\"requestedWireFormat\":\"" << json_utils::escape(diagnostics.requestedWireFormat) << "\","
       << "\"actualWireFormat\":\"" << json_utils::escape(diagnostics.actualWireFormat) << "\","
       << "\"containerBits\":" << diagnostics.containerBits << ","
       << "\"validBits\":" << diagnostics.validBits << ","
       << "\"blockAlign\":" << diagnostics.blockAlign << ","
       << "\"semanticSampleRate\":" << diagnostics.semanticSampleRate << ","
       << "\"transportSampleRate\":" << diagnostics.transportSampleRate << ","
       << "\"typedRawPath\":" << (diagnostics.typedRawPath ? "true" : "false") << ","
       << "\"processingBypassed\":" << (diagnostics.processingBypassed ? "true" : "false") << ","
       << "\"nativeDsdNegotiation\":\"" << json_utils::escape(diagnostics.nativeDsdNegotiation) << "\","
       << "\"asioStartupSummary\":\"" << json_utils::escape(diagnostics.asioStartupSummary) << "\","
       << "\"wireLittleEndian\":" << (diagnostics.wireLittleEndian ? "true" : "false") << ","
       << "\"dopRuntimeEvidence\":\"" << json_utils::escape(diagnostics.dopRuntimeEvidence) << "\","
       << "\"quirkRegistryState\":\"" << json_utils::escape(diagnostics.quirkRegistryState) << "\","
       << "\"quirkFingerprint\":\"" << json_utils::escape(diagnostics.quirkFingerprint) << "\","
       << "\"quirkApplied\":\"" << json_utils::escape(diagnostics.quirkApplied) << "\","
       << "\"dsdMuteState\":\"" << json_utils::escape(diagnostics.dsdMuteState) << "\","
       << "\"dsdMuteTransition\":\"" << json_utils::escape(diagnostics.dsdMuteTransition) << "\","
       << "\"dsdMutePreRollFrames\":" << diagnostics.dsdMutePreRollFrames << ","
       << "\"dsdMutePostRollFrames\":" << diagnostics.dsdMutePostRollFrames << ","
       << "\"dsdMuteTimeoutFrames\":" << diagnostics.dsdMuteTimeoutFrames << ","
       << "\"dsdMuteFallback\":\"" << json_utils::escape(diagnostics.dsdMuteFallback) << "\","
       << "\"firstBufferSummary\":\"" << json_utils::escape(diagnostics.firstBufferSummary) << "\","
       << "\"processArchitecture\":\"" << json_utils::escape(diagnostics.processArchitecture) << "\","
       << "\"asioBuildEnabled\":" << (diagnostics.asioBuildEnabled ? "true" : "false") << ","
       << "\"asioEnvironmentDisabled\":" << (diagnostics.asioEnvironmentDisabled ? "true" : "false") << ","
       << "\"asioRegisteredDriverCount32\":" << diagnostics.asioRegisteredDriverCount32 << ","
       << "\"asioRegisteredDriverCount64\":" << diagnostics.asioRegisteredDriverCount64 << ","
       << "\"asioLoadableDriverCount64\":" << diagnostics.asioLoadableDriverCount64 << ","
       << "\"dsdRouteOverrideActive\":" << (diagnostics.dsdRouteOverrideActive ? "true" : "false") << ","
       << "\"dsdRouteBackend\":\"" << json_utils::escape(diagnostics.dsdRouteBackend) << "\","
       << "\"dsdRouteDevice\":\"" << json_utils::escape(diagnostics.dsdRouteDevice) << "\","
       << "\"dsdRouteFallbackReason\":\"" << json_utils::escape(diagnostics.dsdRouteFallbackReason) << "\","
       << "\"lastError\":\"" << json_utils::escape(diagnostics.lastError) << "\""
       << "}";
}

void writeRenderPerformanceJson(
    std::ostringstream& json,
    const OutputInfo::RenderPerformanceSnapshot& performance) {
  const double meanCallbackNanoseconds = performance.callbackCount == 0
                                            ? 0.0
                                            : static_cast<double>(performance.totalCallbackNanoseconds) /
                                                  static_cast<double>(performance.callbackCount);
  const double callbackDeadlineLoadPercent = performance.totalDeadlineNanoseconds == 0
                                                 ? 0.0
                                                 : (static_cast<double>(performance.totalCallbackNanoseconds) * 100.0) /
                                                       static_cast<double>(performance.totalDeadlineNanoseconds);
  json << "{"
       << "\"callbackCount\":" << performance.callbackCount << ","
       << "\"totalCallbackNanoseconds\":" << performance.totalCallbackNanoseconds << ","
       << "\"meanCallbackNanoseconds\":" << meanCallbackNanoseconds << ","
       << "\"peakCallbackNanoseconds\":" << performance.peakCallbackNanoseconds << ","
       << "\"p999DeadlineRatioUpper\":" << performance.p999DeadlineRatioUpper << ","
       << "\"totalDeadlineNanoseconds\":" << performance.totalDeadlineNanoseconds << ","
       << "\"deadlineMissCount\":" << performance.deadlineMissCount << ","
       << "\"callbackDeadlineLoadPercent\":" << callbackDeadlineLoadPercent
       << "}";
}

std::string boolJson(bool value) {
  return value ? "true" : "false";
}

bool jsonArrayHasItems(const std::string& json) {
  return json.find('{') != std::string::npos;
}

void writeBackendCapabilityJson(
    std::ostringstream& json,
    const char* id,
    const char* label,
    bool compiled,
    bool runtimeAvailable,
    bool supportsExclusive,
    bool supportsOutputPerfect,
    const char* accessMode,
    const char* devicePathKind,
    const std::string& unavailableReason = {},
    bool optional = false) {
  json << "{\"id\":\"" << json_utils::escape(id) << "\",\"label\":\"" << json_utils::escape(label) << "\","
       << "\"compiled\":" << boolJson(compiled) << ","
       << "\"runtimeAvailable\":" << boolJson(runtimeAvailable) << ","
       << "\"supportsExclusive\":" << boolJson(supportsExclusive) << ","
       << "\"supportsOutputPerfect\":" << boolJson(supportsOutputPerfect) << ","
       << "\"accessMode\":\"" << json_utils::escape(accessMode) << "\","
       << "\"devicePathKind\":\"" << json_utils::escape(devicePathKind) << "\","
       << "\"unavailableReason\":\"" << json_utils::escape(runtimeAvailable ? std::string{} : unavailableReason) << "\"";
  if (optional) json << ",\"optional\":true";
  json << "}";
}

std::string backendCapabilitiesJson() {
  std::ostringstream json;
  json << "[";
  bool first = true;
  auto append = [&](const char* id,
                    const char* label,
                    bool compiled,
                    bool runtimeAvailable,
                    bool supportsExclusive,
                    bool supportsOutputPerfect,
                    const char* accessMode,
                    const char* devicePathKind,
                    const std::string& unavailableReason = {},
                    bool optional = false) {
    if (!first) json << ",";
    first = false;
    writeBackendCapabilityJson(
        json,
        id,
        label,
        compiled,
        runtimeAvailable,
        supportsExclusive,
        supportsOutputPerfect,
        accessMode,
        devicePathKind,
        unavailableReason,
        optional);
  };

#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  append("wasapi", "共享输出", true, true, false, false, "shared", "default");
  append("wasapi-exclusive", "独占输出", true, true, true, true, "exclusive", "default");
#else
  append(
      "wasapi",
      "共享输出",
      false,
      false,
      false,
      false,
      "shared",
      "default",
      "WASAPI is only available in Windows builds with TAE_ENABLE_WASAPI");
  append(
      "wasapi-exclusive",
      "独占输出",
      false,
      false,
      true,
      false,
      "exclusive",
      "default",
      "WASAPI Exclusive is only available in Windows builds with TAE_ENABLE_WASAPI");
#endif

#if defined(_WIN32) && defined(TAE_ENABLE_ASIO)
  const std::string asioDevices = enumerateAsioDevicesJson();
  append(
      "asio",
      "专业声卡输出",
      true,
      jsonArrayHasItems(asioDevices),
      true,
      true,
      "exclusive",
      "asio",
      "No ASIO drivers were enumerated",
      true);
#else
  append(
      "asio",
      "专业声卡输出",
      false,
      false,
      true,
      false,
      "exclusive",
      "asio",
      "ASIO compatibility backend is unavailable for this build",
      true);
#endif

#if defined(__APPLE__) && defined(TAE_ENABLE_COREAUDIO)
  append("coreaudio", "苹果系统音频", true, true, false, false, "shared", "hal");
  append("coreaudio-exclusive", "独占输出 (Hog Mode)", true, true, true, true, "exclusive", "hal");
#else
  append(
      "coreaudio",
      "苹果系统音频",
      false,
      false,
      false,
      false,
      "shared",
      "hal",
      "CoreAudio is only available in macOS builds with TAE_ENABLE_COREAUDIO");
  append(
      "coreaudio-exclusive",
      "独占输出 (Hog Mode)",
      false,
      false,
      true,
      false,
      "exclusive",
      "hal",
      "CoreAudio Hog Mode exclusive is only available in macOS builds with TAE_ENABLE_COREAUDIO");
#endif

#if defined(__linux__) && !defined(__ANDROID__) && defined(TAE_ENABLE_ALSA)
  append("alsa", "Linux ALSA 输出", true, true, false, false, "plugin", "default");
#else
  append(
      "alsa",
      "Linux ALSA 输出",
      false,
      false,
      false,
      false,
      "plugin",
      "default",
      "ALSA is only available in Linux builds with TAE_ENABLE_ALSA and ALSA development libraries");
#endif

#if defined(__ANDROID__) && defined(TAE_ENABLE_OBOE)
  append("oboe", "Android Oboe 输出", true, true, false, false, "shared", "default");
#endif

#if defined(__APPLE__) && defined(TAE_ENABLE_IOS_AUDIOUNIT)
  append("audiounit", "iOS AudioUnit 输出", true, true, false, false, "shared", "default");
#endif

  json << "]";
  return json.str();
}

void normalizeOutputInfoMirror(PlaybackInfo& info) {
  OutputInfo& out = info.outputInfo;
  synchronizeOutputConversionInfo(out);
  if (out.backend.empty()) out.backend = info.outputBackend;
  if (out.actualBackend.empty()) out.actualBackend = out.backend;
  if (out.accessMode.empty()) out.accessMode = out.exclusive ? "exclusive" : "shared";
  if (out.devicePathKind.empty()) out.devicePathKind = "default";
  if (out.deviceName.empty()) out.deviceName = info.outputDevice;
  if (out.actualDeviceName.empty()) out.actualDeviceName = out.deviceName;
  if (out.actualDriverName.empty()) out.actualDriverName = out.driverName;
  if (out.actualDriverVersion == 0) out.actualDriverVersion = out.driverVersion;
  if (out.outputSampleRate <= 0 && info.outputSampleRate > 0) out.outputSampleRate = info.outputSampleRate;
  if (out.outputBitDepth <= 0 && info.outputBitDepth > 0) out.outputBitDepth = info.outputBitDepth;
  if (out.actualSampleRate <= 0) out.actualSampleRate = out.outputSampleRate;
  if (out.actualBitDepth <= 0) out.actualBitDepth = out.outputBitDepth;

  info.actualBackend = out.actualBackend;
  info.driverName = out.driverName.empty() ? out.actualDriverName : out.driverName;
  info.driverVersion = out.driverVersion != 0 ? out.driverVersion : out.actualDriverVersion;
  info.actualOutputFormat = out.actualOutputFormat;
  info.actualSampleRate = out.actualSampleRate;
  info.actualBitDepth = out.actualBitDepth;
  info.actualChannels = out.actualChannels;
  info.bufferSizeFrames = out.bufferSizeFrames;
  info.latencyFrames = out.latencyFrames;
  info.latencyMs = out.latencyMs;
  info.deviceRecovered = out.deviceRecovered;
  info.recoveryCount = out.recoveryCount;
  info.outputSampleRate = out.outputSampleRate;
  info.outputBitDepth = out.outputBitDepth;
  info.supportsOutputPerfect = out.supportsOutputPerfect;
  info.sourceExact = out.sourceExact;
  info.outputPerfect = out.outputPerfect;
  info.pcmPassthrough = out.pcmPassthrough;
  info.perfectReasonCode = out.perfectReasonCode;
  info.perfectReason = out.perfectReason;
  info.isDsd = out.isDsd;
  info.dsdMode = out.dsdMode.empty() ? (out.isDsd ? dsdModeToString(DsdMode::Unsupported) : dsdModeToString(DsdMode::Pcm)) : out.dsdMode;
  info.dsdRate = out.isDsd ? out.dsdRate : 0;
}

std::string inferCodec(const std::string& source) {
  const auto dot = source.find_last_of('.');
  if (dot == std::string::npos) return "未知";
  std::string ext = source.substr(dot + 1);
  std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (ext == "m4a" || ext == "mp4") return "aac/alac";
  if (ext == "aif" || ext == "aiff") return "aiff";
  if (ext == "dsf" || ext == "dff") return "dsd";
  return ext;
}

bool codecLooksLossless(const std::string& codec) {
  return codec == "flac" || codec == "wav" || codec == "alac" || codec == "aiff" || codec == "aif" ||
         codec == "ape" || codec == "wv" || codec == "tta" || codec == "pcm";
}

AudioSampleFormat sampleFormatFromText(const std::string& format, int bitDepth) {
  if (format == "int16") return AudioSampleFormat::Int16Interleaved;
  if (format == "int24") return AudioSampleFormat::Int24Interleaved;
  if (format == "int24-in32") return AudioSampleFormat::Int24In32Interleaved;
  if (format == "int32") return AudioSampleFormat::Int32Interleaved;
  if (format == "float32") return AudioSampleFormat::Float32Interleaved;
  if (bitDepth <= 16) return AudioSampleFormat::Int16Interleaved;
  if (bitDepth <= 24) return AudioSampleFormat::Int24Interleaved;
  return AudioSampleFormat::Float32Interleaved;
}

DsdMode parseDsdMode(const std::string& mode) {
  if (mode == "dop") return DsdMode::Dop;
  if (mode == "native") return DsdMode::Native;
  if (mode == "unsupported") return DsdMode::Unsupported;
  return DsdMode::Pcm;
}

std::string playbackInfoToJson(const PlaybackInfo& info) {
  OutputInfo out = info.outputInfo;
  synchronizeOutputConversionInfo(out);
  std::ostringstream json;
  json << "{"
       << "\"state\":\"" << stateToString(info.state) << "\","
       << "\"position\":" << json_utils::number(info.positionSeconds) << ","
       << "\"duration\":" << json_utils::number(info.durationSeconds) << ","
       << "\"volume\":" << info.volume << ","
       << "\"playbackRate\":" << info.playbackRate << ","
       << "\"requestedConfigRevision\":" << info.requestedConfigRevision << ","
       << "\"appliedConfigRevision\":" << info.appliedConfigRevision << ","
       << "\"queueIndex\":" << info.queueIndex << ","
       << "\"queueRevision\":" << info.queueRevision << ","
       << "\"naturalBoundaries\":{\"trackSerial\":" << info.naturalBoundaries.trackSerial
       << ",\"queueSerial\":" << info.naturalBoundaries.queueSerial
       << ",\"trackTimeMs\":" << info.naturalBoundaries.trackTimeMs
       << ",\"queueTimeMs\":" << info.naturalBoundaries.queueTimeMs << "},"
       << "\"upcomingQueueIndex\":" << info.upcomingQueueIndex << ","
       << "\"playMode\":\"" << json_utils::escape(info.playMode) << "\","
       << "\"source\":\"" << json_utils::escape(info.source) << "\","
       << "\"codec\":\"" << json_utils::escape(info.codec) << "\","
       << "\"bitrate\":" << info.bitrate << ","
       << "\"sourceSampleRate\":" << info.sourceSampleRate << ","
       << "\"sourceChannels\":" << info.sourceChannels << ","
       << "\"sourceBitDepth\":" << info.sourceBitDepth << ","
       << "\"decodedSampleRate\":" << info.decodedSampleRate << ","
       << "\"decodedBitDepth\":" << info.decodedBitDepth << ","
       << "\"decodedChannels\":" << info.decodedChannels << ","
       << "\"decodedSampleFormat\":\"" << json_utils::escape(info.decodedSampleFormat) << "\","
       << "\"outputBackend\":\"" << json_utils::escape(info.outputBackend) << "\","
       << "\"outputDevice\":\"" << json_utils::escape(info.outputDevice) << "\","
       << "\"outputInfo\":{"
       << "\"exclusive\":" << (out.exclusive ? "true" : "false") << ","
       << "\"outputReleased\":" << (out.outputReleased ? "true" : "false") << ","
       << "\"usbPcmPreferenceAccepted\":" << (out.usbPcmPreferenceAccepted ? "true" : "false") << ","
       << "\"usbPcmFormatMatched\":" << (out.usbPcmFormatMatched ? "true" : "false") << ","
       << "\"accessMode\":\"" << json_utils::escape(out.accessMode) << "\","
       << "\"supportsOutputPerfect\":" << (out.supportsOutputPerfect ? "true" : "false") << ","
       << "\"sourceExact\":" << (out.sourceExact ? "true" : "false") << ","
       << "\"outputPerfect\":" << (out.outputPerfect ? "true" : "false") << ","
       << "\"pcmPassthrough\":" << (out.pcmPassthrough ? "true" : "false") << ","
       << "\"resampled\":" << (out.resampled ? "true" : "false") << ","
       << "\"providerImplementation\":\"" << json_utils::escape(out.providerImplementation) << "\","
       << "\"conversionInfo\":{"
       << "\"sampleFormatConverted\":" << (out.conversionInfo.sampleFormatConverted ? "true" : "false") << ","
       << "\"sampleRateConverted\":" << (out.conversionInfo.sampleRateConverted ? "true" : "false") << ","
       << "\"channelLayoutConverted\":" << (out.conversionInfo.channelLayoutConverted ? "true" : "false") << ","
       << "\"source\":\"" << json_utils::escape(out.conversionInfo.source) << "\"},"
       << "\"isDsd\":" << (out.isDsd ? "true" : "false") << ","
       << "\"dsdMode\":\"" << json_utils::escape(out.dsdMode) << "\","
       << "\"dsdRate\":" << out.dsdRate << ","
       << "\"actualDsdRate\":" << out.actualDsdRate << ","
       << "\"dsdRatePolicy\":\"" << json_utils::escape(out.dsdRatePolicy) << "\","
       << "\"dsdConversion\":\"" << json_utils::escape(out.dsdConversion) << "\","
       << "\"dsdConversionReason\":\"" << json_utils::escape(out.dsdConversionReason) << "\","
       << "\"outputSampleRate\":" << out.outputSampleRate << ","
       << "\"outputBitDepth\":" << out.outputBitDepth << ","
       << "\"outputChannels\":" << out.outputChannels << ","
       << "\"outputSampleFormat\":\"" << json_utils::escape(out.outputSampleFormat) << "\","
       << "\"backend\":\"" << json_utils::escape(out.backend) << "\","
       << "\"actualBackend\":\"" << json_utils::escape(out.actualBackend) << "\","
       << "\"devicePathKind\":\"" << json_utils::escape(out.devicePathKind) << "\","
       << "\"deviceName\":\"" << json_utils::escape(out.deviceName) << "\","
       << "\"actualDeviceName\":\"" << json_utils::escape(out.actualDeviceName) << "\","
       << "\"actualDeviceId\":\"" << json_utils::escape(out.actualDeviceId) << "\","
       << "\"driverName\":\"" << json_utils::escape(out.driverName) << "\","
       << "\"actualDriverName\":\"" << json_utils::escape(out.actualDriverName) << "\","
       << "\"driverVersion\":" << out.driverVersion << ","
       << "\"actualDriverVersion\":" << out.actualDriverVersion << ","
       << "\"actualOutputFormat\":\"" << json_utils::escape(out.actualOutputFormat) << "\","
       << "\"actualSampleRate\":" << out.actualSampleRate << ","
       << "\"actualBitDepth\":" << out.actualBitDepth << ","
       << "\"actualChannels\":" << out.actualChannels << ","
       << "\"requestedSampleRate\":" << out.requestedSampleRate << ","
       << "\"requestedSampleFormat\":\"" << json_utils::escape(out.requestedSampleFormat) << "\","
       << "\"hardwareSampleRate\":" << out.hardwareSampleRate << ","
       << "\"hardwareBitDepth\":" << out.hardwareBitDepth << ","
       << "\"hardwareChannels\":" << out.hardwareChannels << ","
       << "\"hardwareSampleFormat\":\"" << json_utils::escape(out.hardwareSampleFormat) << "\","
       << "\"perfectReasonCode\":\"" << json_utils::escape(out.perfectReasonCode) << "\","
       << "\"capabilityReason\":\"" << json_utils::escape(out.capabilityReason) << "\","
       << "\"driverDopCapable\":" << (out.driverDopCapable ? "true" : "false") << ","
       << "\"driverNativeDsdCapable\":" << (out.driverNativeDsdCapable ? "true" : "false") << ","
       << "\"driverDopCarrierSampleRates\":[";
  for (size_t i = 0; i < out.driverDopCarrierSampleRates.size(); ++i) {
    if (i > 0) json << ",";
    json << out.driverDopCarrierSampleRates[i];
  }
  json << "],\"driverDopCarrierFormats\":[";
  for (size_t i = 0; i < out.driverDopCarrierFormats.size(); ++i) {
    if (i > 0) json << ",";
    json << "\"" << json_utils::escape(out.driverDopCarrierFormats[i]) << "\"";
  }
  json << "],\"driverNativeDsdSampleRates\":[";
  for (size_t i = 0; i < out.driverNativeDsdSampleRates.size(); ++i) {
    if (i > 0) json << ",";
    json << out.driverNativeDsdSampleRates[i];
  }
  json << "],"
       << "\"nativeDsdRuntimeState\":\"" << json_utils::escape(out.nativeDsdRuntimeState) << "\","
       << "\"nativeDsdRequestedRate\":" << out.nativeDsdRequestedRate << ","
       << "\"nativeDsdActualRate\":" << out.nativeDsdActualRate << ","
       << "\"nativeDsdChannels\":" << out.nativeDsdChannels << ","
       << "\"nativeDsdExplicitlyCapable\":" << (out.nativeDsdExplicitlyCapable ? "true" : "false") << ","
       << "\"nativeDsdAdvertisedSampleRates\":[";
  for (size_t i = 0; i < out.nativeDsdAdvertisedSampleRates.size(); ++i) {
    if (i > 0) json << ",";
    json << out.nativeDsdAdvertisedSampleRates[i];
  }
  json << "],"
       << "\"nativeDsdRuntimeReason\":\"" << json_utils::escape(out.nativeDsdRuntimeReason) << "\","
       << "\"bufferSizeFrames\":" << out.bufferSizeFrames << ","
       << "\"latencyFrames\":" << out.latencyFrames << ","
       << "\"latencyMs\":" << out.latencyMs << ","
       << "\"latencyInfo\":";
  writeLatencyInfoJson(json, out.latencyInfo);
  json << ","
       << "\"channelRoutingMode\":\"" << json_utils::escape(out.channelRoutingMode) << "\","
       << "\"perfectReason\":\"" << json_utils::escape(out.perfectReason) << "\","
       << "\"diagnostics\":";
  writeDiagnosticsJson(json, out.diagnostics);
  json << ",\"renderPerformance\":";
  writeRenderPerformanceJson(json, out.renderPerformance);
  json << ","
       << "\"deviceRecovered\":" << (out.deviceRecovered ? "true" : "false") << ","
       << "\"recoveryCount\":" << out.recoveryCount << ","
       << "\"nativeDsp\":" << (out.nativeDspJson.empty() ? "{\"plugins\":[]}" : out.nativeDspJson)
       << "},"
       << "\"actualBackend\":\"" << json_utils::escape(out.actualBackend) << "\","
       << "\"driverName\":\"" << json_utils::escape(out.driverName.empty() ? out.actualDriverName : out.driverName) << "\","
       << "\"driverVersion\":" << (out.driverVersion != 0 ? out.driverVersion : out.actualDriverVersion) << ","
       << "\"actualOutputFormat\":\"" << json_utils::escape(out.actualOutputFormat) << "\","
       << "\"actualSampleRate\":" << out.actualSampleRate << ","
       << "\"actualBitDepth\":" << out.actualBitDepth << ","
       << "\"actualChannels\":" << out.actualChannels << ","
       << "\"bufferSizeFrames\":" << out.bufferSizeFrames << ","
       << "\"latencyFrames\":" << out.latencyFrames << ","
       << "\"latencyMs\":" << out.latencyMs << ","
       << "\"latencyInfo\":";
  writeLatencyInfoJson(json, out.latencyInfo);
  json << ","
       << "\"channelRoutingMode\":\"" << json_utils::escape(out.channelRoutingMode) << "\","
       << "\"diagnostics\":";
  writeDiagnosticsJson(json, out.diagnostics);
  json << ",\"renderPerformance\":";
  writeRenderPerformanceJson(json, out.renderPerformance);
  json << ","
       << "\"deviceRecovered\":" << (out.deviceRecovered ? "true" : "false") << ","
       << "\"recoveryCount\":" << out.recoveryCount << ","
       << "\"outputSampleRate\":" << out.outputSampleRate << ","
       << "\"outputBitDepth\":" << out.outputBitDepth << ","
       << "\"channelCount\":" << info.channelCount << ","
       << "\"supportsOutputPerfect\":" << (out.supportsOutputPerfect ? "true" : "false") << ","
       << "\"sourceExact\":" << (out.sourceExact ? "true" : "false") << ","
       << "\"outputPerfect\":" << (out.outputPerfect ? "true" : "false") << ","
       << "\"pcmPassthrough\":" << (out.pcmPassthrough ? "true" : "false") << ","
       << "\"dspActive\":" << (info.dspActive ? "true" : "false") << ","
       << "\"replayGainActive\":" << (info.replayGainActive ? "true" : "false") << ","
       << "\"loudnormActive\":" << (info.loudnormActive ? "true" : "false") << ","
       << "\"eqActive\":" << (info.eqActive ? "true" : "false") << ","
       << "\"convolverActive\":" << (info.convolverActive ? "true" : "false") << ","
       << "\"crossfeedActive\":" << (info.crossfeedActive ? "true" : "false") << ","
       << "\"crossfadeActive\":" << (info.crossfadeActive ? "true" : "false") << ","
       << "\"fftActive\":" << (info.fftActive ? "true" : "false") << ","
       << "\"irResampled\":" << (info.irResampled ? "true" : "false") << ","
       << "\"replayGainDb\":" << info.replayGainDb << ","
       << "\"crossfeedStrength\":" << info.crossfeedStrength << ","
       << "\"crossfadeSeconds\":" << info.crossfadeSeconds << ","
       << "\"crossfadeMixActive\":" << (info.crossfadeMixActive ? "true" : "false") << ","
       << "\"crossfadeEffectiveSeconds\":" << info.crossfadeEffectiveSeconds << ","
       << "\"crossfadeCurve\":\"" << info.crossfadeCurve << "\","
       << "\"crossfadeBlockedReason\":\"" << info.crossfadeBlockedReason << "\","
       << "\"autoMixMode\":\"" << info.autoMixMode << "\","
       << "\"autoMixState\":\"" << info.autoMixState << "\","
       << "\"autoMixReason\":\"" << json_utils::escape(info.autoMixReason) << "\","
       << "\"autoMixDurationSeconds\":" << info.autoMixDurationSeconds << ",\"autoMixStemEnhanced\":" << (info.autoMixStemEnhanced ? "true" : "false") << ","
       << "\"autoMixDecodeMs\":" << info.autoMixDecodeMs << ",\"autoMixPrepareMs\":" << info.autoMixPrepareMs << ","
       << "\"autoMixStrategy\":\"" << info.autoMixStrategy << "\","
       << "\"autoMixPlanId\":" << info.autoMixPlanId << ','
       << "\"autoMixOutputSeconds\":" << json_utils::number(info.autoMixOutputSeconds) << ','
       << "\"autoMixNextSourceSeconds\":" << json_utils::number(info.autoMixNextSourceSeconds) << ','
       << "\"convolverLatencyFrames\":" << info.convolverLatencyFrames << ","
       << "\"partitionSize\":" << info.partitionSize << ","
       << "\"channelMappingMode\":\"" << json_utils::escape(info.channelMappingMode) << "\","
       << "\"perfectReasonCode\":\"" << json_utils::escape(info.perfectReasonCode) << "\","
       << "\"perfectReason\":\"" << json_utils::escape(info.perfectReason) << "\","
       << "\"isDsd\":" << (info.isDsd ? "true" : "false") << ","
       << "\"dsdMode\":\"" << json_utils::escape(info.dsdMode) << "\","
       << "\"dsdRate\":" << info.dsdRate << ","
       << "\"actualDsdRate\":" << info.outputInfo.actualDsdRate << ","
       << "\"dsdRatePolicy\":\"" << json_utils::escape(info.outputInfo.dsdRatePolicy) << "\","
       << "\"dsdConversion\":\"" << json_utils::escape(info.outputInfo.dsdConversion) << "\","
       << "\"dsdConversionReason\":\"" << json_utils::escape(info.outputInfo.dsdConversionReason) << "\","
       << "\"gaplessActive\":" << (info.gaplessActive ? "true" : "false") << ","
       << "\"preloadReady\":" << (info.preloadReady ? "true" : "false") << ","
       << "\"gaplessBlockedReason\":\"" << json_utils::escape(info.gaplessBlockedReason) << "\","
       << "\"streamTitle\":\"" << json_utils::escape(info.streamTitle) << "\","
       << "\"upcomingTrack\":"
       << QueueManager::itemToJson(info.hasUpcomingTrack ? std::optional<QueueItem>(info.upcomingTrack) : std::nullopt)
       << "}";
  return json.str();
}

DspStatus configuredDspStatusFromConfig(const DspConfig& config) {
  DspStatus status;
  status.crossfadeActive = config.crossfadeSeconds > 0.0001;
  status.crossfadeSeconds = status.crossfadeActive ? config.crossfadeSeconds : 0.0;
  if (config.enabled) {
    status.replayGainActive = config.replayGainMode != ReplayGainMode::Off;
    status.loudnormActive = config.replayGainMode == ReplayGainMode::Loudnorm;
    status.eqActive = config.eqEnabled;
    status.crossfeedActive = config.crossfeedEnabled && config.crossfeedStrength > 0.0001;
  }
  status.crossfeedStrength = status.crossfeedActive ? config.crossfeedStrength : 0.0;
  status.dspActive =
      status.replayGainActive || status.eqActive || status.convolverActive || status.crossfeedActive ||
      status.crossfadeActive;
  return status;
}

ReplayGainMode parseReplayGainModeId(const std::string& mode) {
  std::string normalized = mode;
  std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (normalized == "track") return ReplayGainMode::Track;
  if (normalized == "album") return ReplayGainMode::Album;
  if (normalized == "loudnorm") return ReplayGainMode::Loudnorm;
  return ReplayGainMode::Off;
}

std::string convolverInfoToJson(const ConvolverInfo& info) {
  std::ostringstream json;
  json << "{"
       << "\"loaded\":" << (info.loaded ? "true" : "false") << ","
       << "\"active\":" << (info.active ? "true" : "false") << ","
       << "\"bypassed\":" << (info.bypassed ? "true" : "false") << ","
       << "\"irResampled\":" << (info.irResampled ? "true" : "false") << ","
       << "\"path\":\"" << json_utils::escape(info.path) << "\","
       << "\"sampleRate\":" << info.sampleRate << ","
       << "\"channels\":" << info.channels << ","
       << "\"lengthFrames\":" << info.lengthFrames << ","
       << "\"lengthMs\":" << info.lengthMs << ","
        << "\"partitionSize\":" << info.partitionSize << ","
        << "\"latencyFrames\":" << info.latencyFrames << ","
        << "\"tailFrames\":" << info.tailFrames << ","
        << "\"memoryBytes\":" << info.memoryBytes << ","
        << "\"loading\":" << (info.loading ? "true" : "false") << ","
        << "\"overrunCount\":" << info.overrunCount << ","
        << "\"bypassCount\":" << info.bypassCount << ","
       << "\"lastProcessMs\":" << info.lastProcessMs << ","
       << "\"maxProcessMs\":" << info.maxProcessMs << ","
       << "\"channelMappingMode\":\"" << json_utils::escape(info.channelMappingMode) << "\","
       << "\"warning\":\"" << json_utils::escape(info.warning) << "\","
       << "\"lastError\":\"" << json_utils::escape(info.lastError) << "\""
       << "}";
  return json.str();
}

bool gaplessEnabledFromConfig(const DspConfig& config) {
  return config.gapless || config.crossfadeSeconds > 0.0001;
}

uint32_t parseUintField(const std::string& json, const std::string& key, uint32_t fallback) {
  const std::optional<double> value = json_utils::fieldNumber(json, key);
  if (!value.has_value() || *value < 0.0) return fallback;
  return static_cast<uint32_t>(*value);
}

std::string parseStringField(const std::string& json, const std::string& key, const std::string& fallback) {
  return json_utils::fieldString(json, key).value_or(fallback);
}

bool parseBoolField(const std::string& json, const std::string& key, bool fallback) {
  return json_utils::fieldBool(json, key).value_or(fallback);
}

float parseFloatField(const std::string& json, const std::string& key, float fallback) {
  const std::optional<double> value = json_utils::fieldNumber(json, key);
  return value.has_value() ? static_cast<float>(*value) : fallback;
}

OutputConfig parseOutputConfigJson(const std::string& json) {
  OutputConfig config;
  config.usbPcmPassthrough = json_utils::fieldBool(json, "usbPcmPassthrough").value_or(false);
  config.sampleRateFamilySync = json_utils::fieldBool(json, "sampleRateFamilySync").value_or(false);
  const auto parseRates = [&](const char* key) {
    std::vector<int> rates;
    const std::string array = json_utils::fieldArray(json, key);
    if (array.empty()) return json_utils::topLevelFieldValueStart(json, key) ? std::vector<int>{-1} : rates;
    std::istringstream input(array.substr(1, array.size() - 2));
    input >> std::ws;
    while (input.peek() != EOF) {
      double rate = 0;
      if (!(input >> rate) || !std::isfinite(rate) || rate < kMinPcmSampleRate || rate > kMaxPcmSampleRate || std::floor(rate) != rate) {
        return std::vector<int>{-1};
      }
      rates.push_back(static_cast<int>(rate));
      input >> std::ws;
      if (input.peek() == EOF) break;
      if (input.get() != ',') return std::vector<int>{-1};
      input >> std::ws;
      if (input.peek() == EOF) return std::vector<int>{-1};
    }
    return rates;
  };
  config.allowedSampleRates = parseRates("allowedSampleRates");
  config.deviceSampleRates = parseRates("deviceSampleRates");
  if (json_utils::topLevelFieldValueStart(json, "sampleRateFamilySync") &&
      !json_utils::fieldBool(json, "sampleRateFamilySync").has_value()) config.allowedSampleRates = {-1};
  std::sort(config.allowedSampleRates.begin(), config.allowedSampleRates.end());
  std::sort(config.deviceSampleRates.begin(), config.deviceSampleRates.end());
  config.preferredBufferSize = parseUintField(json, "preferredBufferSize", 0);
  config.asioOutputChannelStart = std::min<uint32_t>(255, parseUintField(json, "asioOutputChannelStart", 0));
  config.routingMode = parseChannelRoutingMode(parseStringField(json, "routingMode", "auto"));
  config.wasapiExclusivePushMode = parseBoolField(json, "wasapiExclusivePushMode", false);
  config.releaseExclusiveOnPause = parseBoolField(json, "releaseExclusiveOnPause", false);
  config.continuityFirst = parseStringField(json, "playbackPolicy", "bit-perfect-first") == "continuity-first";
  const int continuityRate = static_cast<int>(parseUintField(json, "continuitySampleRate", 48000));
  config.continuitySampleRate = continuityRate == 44100 || continuityRate == 96000 ? continuityRate : 48000;
  config.pcmToDsdMode = parsePcmToDsdMode(parseStringField(json, "pcmToDsdMode", "off"));
  config.dsdMutePreRollFrames = parseUintField(json, "dsdMutePreRollFrames", 256);
  config.dsdMutePostRollFrames = parseUintField(json, "dsdMutePostRollFrames", 256);
  config.dsdMuteTimeoutFrames = parseUintField(json, "dsdMuteTimeoutFrames", 4096);
  // 上混参数（可选，缺省走 OutputConfig 默认值）
  config.upmixCenterGain = parseFloatField(json, "upmixCenterGain", config.upmixCenterGain);
  config.upmixLfeGain = parseFloatField(json, "upmixLfeGain", config.upmixLfeGain);
  config.upmixLfeLowpassHz = parseFloatField(json, "upmixLfeLowpassHz", config.upmixLfeLowpassHz);
  config.upmixSurroundGain = parseFloatField(json, "upmixSurroundGain", config.upmixSurroundGain);
  config.upmixSideGain = parseFloatField(json, "upmixSideGain", config.upmixSideGain);
  config.upmixSurroundDelayMs = parseFloatField(json, "upmixSurroundDelayMs", config.upmixSurroundDelayMs);
  return config;
}

struct VisualizationQuery {
  size_t spectrumPoints = 64;
  size_t waveformPoints = 128;
  size_t spectrogramFrames = 48;
  size_t oscilloscopePoints = 1024;
  size_t visualizerBarCount = 0;
};

VisualizationQuery parseVisualizationQueryJson(const std::string& json) {
  VisualizationQuery query;
  query.spectrumPoints = std::clamp<uint32_t>(parseUintField(json, "spectrumPoints", 64), 8, 4096);
  query.waveformPoints = std::clamp<uint32_t>(parseUintField(json, "waveformPoints", 128), 16, 512);
  query.spectrogramFrames = std::clamp<uint32_t>(parseUintField(json, "spectrogramFrames", 48), 0, 96);
  query.oscilloscopePoints = std::clamp<uint32_t>(parseUintField(json, "oscilloscopePoints", 1024), 0, 4096);
  query.visualizerBarCount = std::clamp<uint32_t>(parseUintField(json, "visualizerBarCount", 0), 0, 256);
  return query;
}

std::string inactiveVisualizationJson(const VisualizationQuery& query, int sampleRate) {
  std::ostringstream json;
  auto writeZeros = [](std::ostringstream& out, size_t count) {
    out << "[";
    for (size_t i = 0; i < count; ++i) {
      if (i > 0) out << ",";
      out << "0";
    }
    out << "]";
  };
  json << "{\"spectrum\":";
  writeZeros(json, query.visualizerBarCount > 0 ? 0 : query.spectrumPoints);
  if (query.visualizerBarCount > 0) {
    json << ",\"visualizerBars\":";
    writeZeros(json, query.visualizerBarCount);
  }
  json << ",\"waveform\":";
  writeZeros(json, query.waveformPoints);
  json << ",\"oscilloscope\":";
  writeZeros(json, query.visualizerBarCount > 0 ? 0 : query.oscilloscopePoints);
  json << ",\"peakDb\":-120,\"rmsDb\":-120,\"lufsMomentary\":null,\"spectrogram\":[],"
       << "\"sampleRate\":" << sampleRate
       << ",\"active\":false,\"tapStatus\":\"stopped\",\"reason\":\"Audio pipeline is stopped\"}";
  return json.str();
}

QueueItem makeManualQueueItem(const std::string& source) {
  QueueItem item;
  item.id = "manual";
  item.source = source;
  item.title = source;
  return item;
}

}  // namespace

TwilightAudioEngine::TwilightAudioEngine() {
  pipeline_ = std::make_unique<AudioPipeline>();
  info_.outputBackend = defaultBackendId();
  if (info_.outputBackend.empty()) info_.outputBackend = "none";
  info_.outputInfo.backend = info_.outputBackend;
  info_.outputInfo.actualBackend = info_.outputBackend;
  info_.outputInfo.exclusive = false;
  info_.outputInfo.accessMode = "shared";
  info_.outputInfo.supportsOutputPerfect = false;
  info_.outputInfo.devicePathKind = "default";
  updatePerfectLocked();
  lastTick_ = std::chrono::steady_clock::now();
  startClock();
  diagnosticThread_ = std::thread([this] { diagnosticLoop(); });
}

TwilightAudioEngine::~TwilightAudioEngine() {
  if (pipeline_) pipeline_->stop();
  stopClock();
  diagnosticRunning_.store(false);
  clockCv_.notify_all();
  if (diagnosticThread_.joinable()) diagnosticThread_.join();
}

void TwilightAudioEngine::setEventCallback(TAE_EventCallback callback, void* userData) {
  std::lock_guard lock(mutex_);
  eventCallback_ = callback;
  eventUserData_ = userData;
}

void TwilightAudioEngine::setStateEventsEnabled(bool enabled) {
  stateEventsEnabled_.store(enabled, std::memory_order_relaxed);
}

void TwilightAudioEngine::setUsbPcmPolicy(std::shared_ptr<UsbPcmPolicy> policy) {
  pipeline_->setUsbPcmPolicy(std::move(policy));
}

void TwilightAudioEngine::suspendUsbPcm(const std::string& reason) {
  std::lock_guard transportLock(transportMutex_);
  {
    std::lock_guard lock(mutex_);
    if (!outputConfig_.usbPcmPassthrough || pausedOutputReleased_ || info_.state == PlaybackState::Stopped) return;
    if (pipeline_) info_.positionSeconds = pipeline_->status().positionSeconds;
    info_.state = PlaybackState::Paused;
  }
  releasePausedOutput();
  emitError(reason, TAE_RESULT_BACKEND_UNAVAILABLE, "usb-pcm");
}

void TwilightAudioEngine::setInputFactory(std::shared_ptr<const SeekableInputFactory> factory) {
  pipeline_->setInputFactory(std::move(factory));
}

TAE_Result TwilightAudioEngine::play(const std::string& source, double startTimeSeconds, bool initiallyPaused) {
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  if (source.empty()) return TAE_RESULT_INVALID_ARGUMENT;

  std::string backend;
  std::string device;
  double volume = 1.0;
  std::string dspConfigJson;
  bool gaplessEnabled = true;
  QueueItem item;
  std::optional<QueueItem> upcoming;
  {
    std::lock_guard lock(mutex_);
    if (queue_.empty()) {
      item = makeManualQueueItem(source);
      info_.queueIndex = 0;
    } else {
      item = queue_.current().value_or(makeManualQueueItem(source));
      if (item.source.empty() || item.source != source) {
        // Prefer the queued item matching this source so host-injected loudnorm
        // measurements (measuredIntegratedLufs / measuredTruePeakDb) are kept.
        if (auto matched = queue_.findBySource(source)) {
          item = *matched;
        } else {
          item = makeManualQueueItem(source);
        }
      }
      info_.queueIndex = queue_.currentIndex();
    }
    upcoming = queue_.upcoming();
    info_.source = item.source;
    info_.positionSeconds = std::max(0.0, startTimeSeconds);
    info_.durationSeconds = item.durationSeconds;
    info_.codec = inferCodec(item.source);
    info_.state = initiallyPaused ? PlaybackState::Paused : PlaybackState::Playing;
    info_.isDsd = info_.codec == "dsd";
    info_.dsdMode = info_.isDsd ? dsdModeToString(DsdMode::Unsupported) : dsdModeToString(DsdMode::Pcm);
    info_.dsdRate = 0;
    info_.outputInfo.isDsd = info_.isDsd;
    info_.outputInfo.dsdMode = info_.dsdMode;
    info_.outputInfo.dsdRate = 0;
    info_.playMode = queue_.playModeId();
    info_.hasUpcomingTrack = upcoming.has_value();
    info_.upcomingTrack = upcoming.value_or(QueueItem{});
    pausedOutputReleased_ = false;
    info_.outputInfo.outputReleased = false;
    backend = info_.outputBackend;
    device = info_.outputDevice;
    volume = info_.volume;
    dspConfigJson = dspConfigJson_;
    gaplessEnabled = gaplessEnabledFromConfig(dspConfig_);
  }

  std::string error;
  const TAE_Result result =
      pipeline_ ? pipeline_->play(item, upcoming, startTimeSeconds, backend, device, volume, dspConfigJson, gaplessEnabled, &error, initiallyPaused)
                : TAE_RESULT_NOT_INITIALIZED;
  if (result != TAE_RESULT_OK) {
    {
      std::lock_guard lock(mutex_);
      info_.state = PlaybackState::Stopped;
      info_.positionSeconds = 0.0;
    }
    emitError(error.empty() ? "无法启动原生音频播放" : error, result, "play");
    return result;
  }

  std::lock_guard lock(mutex_);
  // play()/playQueueItem pass volume into the pipeline; reassert rate so non-unity rates survive.
  if (pipeline_ && std::abs(info_.playbackRate - 1.0) > 0.0001) {
    pipeline_->setPlaybackRate(info_.playbackRate);
  }
  applyPipelineStatusLocked(pipeline_->status());
  lastTick_ = std::chrono::steady_clock::now();
  publishStateLocked();
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::playQueueItem(const QueueItem& item, double startTimeSeconds) {
  std::lock_guard transportLock(transportMutex_);
  if (item.source.empty()) return TAE_RESULT_INVALID_ARGUMENT;

  std::string backend;
  std::string device;
  double volume = 1.0;
  std::string dspConfigJson;
  bool gaplessEnabled = true;
  std::optional<QueueItem> upcoming;
  {
    std::lock_guard lock(mutex_);
    upcoming = queue_.upcoming();
    info_.queueIndex = queue_.currentIndex();
    info_.source = item.source;
    info_.positionSeconds = std::max(0.0, startTimeSeconds);
    info_.durationSeconds = item.durationSeconds;
    info_.codec = inferCodec(item.source);
    info_.state = PlaybackState::Playing;
    info_.isDsd = info_.codec == "dsd";
    info_.dsdMode = info_.isDsd ? dsdModeToString(DsdMode::Unsupported) : dsdModeToString(DsdMode::Pcm);
    info_.dsdRate = 0;
    info_.outputInfo.isDsd = info_.isDsd;
    info_.outputInfo.dsdMode = info_.dsdMode;
    info_.outputInfo.dsdRate = 0;
    info_.playMode = queue_.playModeId();
    info_.hasUpcomingTrack = upcoming.has_value();
    info_.upcomingTrack = upcoming.value_or(QueueItem{});
    pausedOutputReleased_ = false;
    info_.outputInfo.outputReleased = false;
    backend = info_.outputBackend;
    device = info_.outputDevice;
    volume = info_.volume;
    dspConfigJson = dspConfigJson_;
    gaplessEnabled = gaplessEnabledFromConfig(dspConfig_);
  }

  std::string error;
  const TAE_Result result =
      pipeline_ ? pipeline_->play(item, upcoming, startTimeSeconds, backend, device, volume, dspConfigJson, gaplessEnabled, &error)
                : TAE_RESULT_NOT_INITIALIZED;
  if (result != TAE_RESULT_OK) {
    {
      std::lock_guard lock(mutex_);
      info_.state = PlaybackState::Stopped;
      info_.positionSeconds = 0.0;
    }
    emitError(error.empty() ? "无法启动原生音频播放" : error, result, "play");
    return result;
  }

  std::lock_guard lock(mutex_);
  // play()/playQueueItem pass volume into the pipeline; reassert rate so non-unity rates survive.
  if (pipeline_ && std::abs(info_.playbackRate - 1.0) > 0.0001) {
    pipeline_->setPlaybackRate(info_.playbackRate);
  }
  applyPipelineStatusLocked(pipeline_->status());
  lastTick_ = std::chrono::steady_clock::now();
  publishStateLocked();
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setPaused(bool paused) {
  std::lock_guard transportLock(transportMutex_);
  {
    std::lock_guard lock(mutex_);
    if (info_.state == PlaybackState::Stopped ||
        (info_.state == PlaybackState::Paused) == paused) return TAE_RESULT_OK;
  }
  return pause();
}

TAE_Result TwilightAudioEngine::pause() {
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  {
    std::lock_guard lock(mutex_);
    if (info_.state == PlaybackState::Stopped) return TAE_RESULT_OK;
  }
  if (pausedOutputReleased_) return resumeReleasedOutput();
  if (pipeline_) pipeline_->togglePause();
  bool release = false;
  {
    std::lock_guard lock(mutex_);
    if (pipeline_) {
      applyPipelineStatusLocked(pipeline_->status());
    } else {
      info_.state = info_.state == PlaybackState::Paused ? PlaybackState::Playing : PlaybackState::Paused;
    }
    release = info_.state == PlaybackState::Paused && shouldReleaseOutputLocked();
    lastTick_ = std::chrono::steady_clock::now();
    if (!release) publishStateLocked();
  }
  if (release) releasePausedOutput();
  return TAE_RESULT_OK;
}

bool TwilightAudioEngine::shouldReleaseOutputLocked() const {
  const auto& backend = info_.outputInfo.actualBackend;
  return outputConfig_.usbPcmPassthrough || (outputConfig_.releaseExclusiveOnPause &&
         (info_.outputInfo.exclusive || backend == "wasapi-exclusive" ||
          backend == "coreaudio-exclusive" || backend == "asio"));
}

void TwilightAudioEngine::markOutputReleasedLocked() {
  info_.outputInfo.outputReleased = true;
  info_.outputInfo.usbPcmPreferenceAccepted = false;
  info_.outputInfo.usbPcmFormatMatched = false;
  info_.outputInfo.exclusive = false;
  info_.outputInfo.outputPerfect = false;
  info_.outputInfo.pcmPassthrough = false;
  info_.outputInfo.accessMode = "released";
  info_.outputInfo.perfectReasonCode = "output_released";
  info_.outputInfo.perfectReason = "Audio output device released";
  info_.gaplessActive = false;
  info_.preloadReady = false;
  normalizeOutputInfoMirror(info_);
}

void TwilightAudioEngine::releasePausedOutput() {
  {
    std::lock_guard lock(mutex_);
    pausedOutputReleased_ = true;
  }
  if (pipeline_) pipeline_->stop();
  std::lock_guard lock(mutex_);
  markOutputReleasedLocked();
  publishStateLocked();
}

TAE_Result TwilightAudioEngine::resumeReleasedOutput() {
  PlaybackInfo paused;
  {
    std::lock_guard lock(mutex_);
    paused = info_;
  }
  const bool liveStream = paused.durationSeconds <= 0.0 &&
                          (paused.source.rfind("http://", 0) == 0 || paused.source.rfind("https://", 0) == 0);
  const TAE_Result result = play(paused.source, liveStream ? 0.0 : paused.positionSeconds);
  if (result != TAE_RESULT_OK) {
    std::lock_guard lock(mutex_);
    info_ = paused;
    pausedOutputReleased_ = true;
    publishStateLocked();
  }
  return result;
}

TAE_Result TwilightAudioEngine::stop() {
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  if (pipeline_) {
    pipeline_->clearLoopRange();
    pipeline_->stop();
  }
  std::lock_guard lock(mutex_);
  info_.state = PlaybackState::Stopped;
  info_.positionSeconds = 0.0;
  if (outputConfig_.usbPcmPassthrough || outputConfig_.releaseExclusiveOnPause || pausedOutputReleased_) markOutputReleasedLocked();
  pausedOutputReleased_ = false;
  publishStateLocked();
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::seek(double positionSeconds) {
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  if (!std::isfinite(positionSeconds)) return TAE_RESULT_INVALID_ARGUMENT;
  std::string error;
  PlaybackState currentState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    if (pausedOutputReleased_) {
      info_.positionSeconds = info_.durationSeconds > 0.0
                                  ? std::clamp(positionSeconds, 0.0, info_.durationSeconds)
                                  : std::max(0.0, positionSeconds);
      publishStateLocked();
      return TAE_RESULT_OK;
    }
    currentState = info_.state;
  }
  if (pipeline_ && currentState != PlaybackState::Stopped) {
    if (pipeline_->isDopPathActive() || pipeline_->isNativeDsdPathActive()) {
      return restartCurrentPlaybackForReroute(
          std::max(0.0, positionSeconds),
          currentState,
          {},
          "seek");
    }
    const TAE_Result result = pipeline_->seek(positionSeconds, &error);
    if (result != TAE_RESULT_OK) {
      emitError(error.empty() ? "无法跳转原生音频播放位置" : error, result, "seek");
      return result;
    }
  }
  std::lock_guard lock(mutex_);
  if (pipeline_) {
    applyPipelineStatusLocked(pipeline_->status());
  } else {
    info_.positionSeconds = std::max(0.0, positionSeconds);
  }
  lastTick_ = std::chrono::steady_clock::now();
  publishStateLocked();
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setVolume(double volume) {
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  if (!std::isfinite(volume)) return TAE_RESULT_INVALID_ARGUMENT;
  if (volume != 1.0) suspendUsbPcm("应用音量或焦点衰减改变，USB 原样 PCM 已暂停；关闭此模式后可使用软件音量");
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    info_.volume = std::clamp(volume, 0.0, 1.0);
    if (pipeline_) {
      pipeline_->setVolume(info_.volume);
      applyPipelineStatusLocked(pipeline_->status());
    }
    if (pipeline_ && info_.state != PlaybackState::Stopped && !pausedOutputReleased_) {
      if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
        publishStateLocked();
      }
    } else {
      updatePerfectLocked();
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "volume");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setPlaybackRate(double rate) {
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  if (!std::isfinite(rate)) return TAE_RESULT_INVALID_ARGUMENT;
  if (rate != 1.0) suspendUsbPcm("播放速度改变，USB 原样 PCM 已暂停");
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    info_.playbackRate = std::clamp(rate, 0.5, 2.0);
    if (pipeline_) {
      pipeline_->setPlaybackRate(info_.playbackRate);
      applyPipelineStatusLocked(pipeline_->status());
    }
    if (pipeline_ && info_.state != PlaybackState::Stopped && !pausedOutputReleased_) {
      if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
        publishStateLocked();
      }
    } else {
      updatePerfectLocked();
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "playbackRate");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setLoopRange(double startSeconds, double endSeconds) {
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  if (pipeline_) {
    pipeline_->setLoopRange(startSeconds, endSeconds);
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setOutputDevice(const std::string& deviceId) {
  std::lock_guard transportLock(transportMutex_);
  std::lock_guard lock(mutex_);
  const std::string nextDevice = deviceId.empty() ? "auto" : deviceId;
  if (nextDevice != info_.outputDevice ||
      (nextDevice == "auto" && info_.state != PlaybackState::Stopped)) {
    outputRoutePending_ = true;
  }
  info_.outputDevice = nextDevice;
  if (info_.state == PlaybackState::Stopped) {
    info_.outputInfo.deviceName = nextDevice;
    info_.outputInfo.actualDeviceName = nextDevice;
  }
  publishStateLocked();
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setOutputBackend(const std::string& backendId) {
  std::lock_guard transportLock(transportMutex_);
  if (backendId.empty()) return TAE_RESULT_INVALID_ARGUMENT;
  const std::string nextBackend = backendId == "wasapi-shared" ? "wasapi" : backendId;
  std::string providerError;
  const PcmOutputProviderStatus providerStatus =
      validatePcmOutputProviderForBackend(nextBackend, &providerError);
  if (providerStatus != PcmOutputProviderStatus::Ready) {
    const TAE_Result result = providerStatus == PcmOutputProviderStatus::InvalidConfiguration
                                  ? TAE_RESULT_INVALID_ARGUMENT
                                  : TAE_RESULT_BACKEND_UNAVAILABLE;
    emitError(providerError, result, "output-backend");
    return result;
  }
  if (!isOutputBackendAvailable(nextBackend)) {
    emitError(
        "Output backend is not available in this build: " + nextBackend,
        TAE_RESULT_BACKEND_UNAVAILABLE,
        "output-backend");
    return TAE_RESULT_BACKEND_UNAVAILABLE;
  }
  std::lock_guard lock(mutex_);
  if (pausedOutputReleased_) info_.outputInfo.backend = nextBackend;
  if (nextBackend != info_.outputBackend) outputRoutePending_ = true;
  info_.outputBackend = nextBackend;
  if (info_.state == PlaybackState::Stopped) {
    info_.outputInfo = {};
    info_.outputInfo.backend = info_.outputBackend;
    info_.outputInfo.actualBackend = info_.outputBackend;
    info_.outputInfo.channelRoutingMode = channelRoutingModeToString(outputConfig_.routingMode);
  }
  updatePerfectLocked();
  publishStateLocked();
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::selectQueueIndex(int index) {
  std::lock_guard transportLock(transportMutex_);
  if (pipeline_) pipeline_->cancelAutoMix("queue_selection_changed");
  const ClockWake wake(*this);
  std::lock_guard lock(mutex_);
  if (index < 0 || static_cast<size_t>(index) >= queue_.size()) return TAE_RESULT_INVALID_ARGUMENT;
  queue_.setCurrentIndex(index);
  info_.queueIndex = index;
  const auto upcoming = queue_.upcoming();
  info_.hasUpcomingTrack = upcoming.has_value();
  info_.upcomingTrack = upcoming.value_or(QueueItem{});
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setAutoMixMode(const std::string& mode) {
  ClockWake wake(*this);
  std::lock_guard transportLock(transportMutex_);
  if (!pipeline_) return TAE_RESULT_NOT_INITIALIZED;
  const auto before = pipeline_->status();
  std::string error;
  if (!pipeline_->setAutoMixMode(mode, &error)) {
    emitError(error, TAE_RESULT_INVALID_ARGUMENT, "set-auto-mix-mode");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  if (mode != "off" && before.autoMixMode != mode && !before.stream.isDsd &&
      (before.outputInfo.pcmPassthrough || !before.sourceTimelineExact) &&
      before.state != PipelineState::Stopped) {
    return restartCurrentPlaybackForReroute(before.positionSeconds,
        before.state == PipelineState::Paused ? PlaybackState::Paused : PlaybackState::Playing,
        "automix_pcm_processing", "set-auto-mix-mode");
  }
  if (mode != "off" && before.state != PipelineState::Stopped) {
    std::optional<QueueItem> upcoming;
    { std::lock_guard lock(mutex_); upcoming = queue_.upcoming(); }
    std::string preloadError;
    pipeline_->preloadNext(upcoming, &preloadError);
  }
  std::lock_guard lock(mutex_);
  applyPipelineStatusLocked(pipeline_->status());
  return TAE_RESULT_OK;
}
std::string TwilightAudioEngine::selectAutoMix(const std::string& json) {
  ClockWake wake(*this);
  std::lock_guard transportLock(transportMutex_);
  return pipeline_ ? pipeline_->selectAutoMix(json) : "{\"ok\":false,\"reason\":\"audio_service_unavailable\"}";
}
TAE_Result TwilightAudioEngine::prepareAutoMix(const std::string& json) {
  ClockWake wake(*this);
  std::lock_guard transportLock(transportMutex_);
  std::string error;
  if (!pipeline_ || !pipeline_->prepareAutoMix(json, &error)) {
    if (pipeline_) {
      std::lock_guard lock(mutex_);
      applyPipelineStatusLocked(pipeline_->status());
    }
    emitError(error, TAE_RESULT_INVALID_ARGUMENT, "prepare-auto-mix");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  std::lock_guard lock(mutex_);
  applyPipelineStatusLocked(pipeline_->status());
  return TAE_RESULT_OK;
}
TAE_Result TwilightAudioEngine::submitAutoMix(uint64_t id) {
  ClockWake wake(*this);
  std::lock_guard transportLock(transportMutex_);
  std::string error;
  if (!pipeline_ || !pipeline_->submitAutoMix(id, &error)) {
    emitError(error, TAE_RESULT_INVALID_ARGUMENT, "submit-auto-mix");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  return TAE_RESULT_OK;
}
TAE_Result TwilightAudioEngine::cancelAutoMix() {
  ClockWake wake(*this);
  std::lock_guard transportLock(transportMutex_);
  if (pipeline_) pipeline_->cancelAutoMix("host_cancelled");
  return TAE_RESULT_OK;
}
TAE_Result TwilightAudioEngine::loadQueue(const std::string& queueJson, int startIndex) {
  DiagnosticLog::instance().append(DiagLevel::Info, "queue.update.start", "queue update", "{\"bytes\":" + std::to_string(queueJson.size()) + ",\"startIndex\":" + std::to_string(startIndex) + "}");
  std::lock_guard transportLock(transportMutex_);
  if (pipeline_) pipeline_->cancelAutoMix("queue_changed");
  const ClockWake wake(*this);
  std::string error;
  std::lock_guard lock(mutex_);
  if (!queue_.loadFromJson(queueJson, startIndex, &error)) {
    emitError(error.empty() ? "播放队列加载失败" : error, TAE_RESULT_INVALID_ARGUMENT, "queue");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  info_.queueIndex = queue_.currentIndex();
  info_.playMode = queue_.playModeId();
  const auto upcoming = queue_.upcoming();
  info_.hasUpcomingTrack = upcoming.has_value();
  info_.upcomingTrack = upcoming.value_or(QueueItem{});
  // Mid-play loudnorm / library RG injection: overlay measurements onto the
  // active (and matching preload) stream without reopening the device.
  if (pipeline_) {
    if (const auto current = queue_.current()) {
      pipeline_->refreshQueueReplayGainTags(*current);
    }
    if (upcoming) {
      pipeline_->refreshQueueReplayGainTags(*upcoming);
    }
  }
  emit("queue-change", queue_.queueJson());
  DiagnosticLog::instance().append(DiagLevel::Info, "queue.update.complete", "queue update", "{\"queueIndex\":" + std::to_string(info_.queueIndex) + "}");
  return TAE_RESULT_OK;
}

namespace {

bool sameQueuePosition(
    const std::optional<QueueItem>& left,
    const std::optional<QueueItem>& right) {
  if (left.has_value() != right.has_value()) return false;
  if (!left) return true;
  return left->id == right->id && left->source == right->source &&
         left->cueStartSeconds == right->cueStartSeconds &&
         left->cueEndSeconds == right->cueEndSeconds &&
         left->cueVirtualPregapSeconds == right->cueVirtualPregapSeconds;
}

}  // namespace

TAE_Result TwilightAudioEngine::rebindQueue(const std::string& queueJson, int startIndex,
                                           const std::string& mode,
                                           const std::string& expectedJson, int expectedIndex,
                                           int* outApplied) {
  if (outApplied) *outApplied = 0;
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  if (startIndex < 0 || expectedIndex < 0 ||
      (mode != "sequential" && mode != "repeat" && mode != "shuffle" && mode != "listLoop"))
    return TAE_RESULT_INVALID_ARGUMENT;

  QueueManager expectedQueue;
  std::string error;
  if (!expectedQueue.loadFromJson("[" + expectedJson + "]", 0, &error) || expectedQueue.size() != 1)
    return TAE_RESULT_INVALID_ARGUMENT;
  const auto expected = expectedQueue.current();
  std::optional<QueueItem> upcoming;
  bool transportActive = false;
  bool preloadNeeded = false;
  {
    std::lock_guard lock(mutex_);
    if (queue_.currentIndex() != expectedIndex || !sameQueuePosition(queue_.current(), expected))
      return TAE_RESULT_OK;
    if (info_.state != PlaybackState::Stopped && info_.source != expected->source)
      return TAE_RESULT_OK;
    // Parse into a copy: the legacy parser clears its target on invalid input.
    // Its revision therefore stays monotonic without changing LoadQueue's API.
    QueueManager replacement = queue_;
    if (!replacement.loadFromJson(queueJson, startIndex, &error) ||
        startIndex >= static_cast<int>(replacement.size()) ||
        !sameQueuePosition(replacement.current(), expected))
      return TAE_RESULT_INVALID_ARGUMENT;
    replacement.setPlayMode(QueueManager::parsePlayMode(mode));
    upcoming = replacement.upcoming();
    const auto commit = [&] {
      queue_ = std::move(replacement);
      info_.queueIndex = queue_.currentIndex();
      info_.playMode = queue_.playModeId();
      info_.hasUpcomingTrack = upcoming.has_value();
      info_.upcomingTrack = upcoming.value_or(QueueItem{});
    };
    if (pipeline_) {
      if (!pipeline_->rebindQueue(*expected, upcoming, commit, &preloadNeeded)) return TAE_RESULT_OK;
    } else commit();
    if (!upcoming || preloadNeeded) info_.preloadReady = false;
    transportActive = info_.state != PlaybackState::Stopped && !pausedOutputReleased_;
  }
  if (outApplied) *outApplied = 1;
  // Preloading is outside the short render/control handoff. Failure only loses
  // lookahead, never undoes a committed handoff or restarts the current stream.
  if (pipeline_ && transportActive && preloadNeeded) {
    std::string preloadError;
    pipeline_->preloadNext(upcoming, &preloadError);
  }
  emit("queue-change", queueJson);
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::appendQueueItems(const std::string& itemsJson, int* outFirstIndex) {
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  std::optional<QueueItem> beforeUpcoming;
  std::optional<QueueItem> afterUpcoming;
  int firstIndex = -1;
  int appendedCount = 0;
  uint64_t revision = 0;
  bool transportActive = false;
  {
    std::lock_guard lock(mutex_);
    beforeUpcoming = queue_.upcoming();
    std::string error;
    if (!queue_.appendFromJsonBatch(itemsJson, &firstIndex, &error)) {
      emitError(
          error.empty() ? "追加播放队列失败" : error,
          TAE_RESULT_INVALID_ARGUMENT,
          "queue");
      return TAE_RESULT_INVALID_ARGUMENT;
    }
    appendedCount = static_cast<int>(queue_.size()) - firstIndex;
    revision = queue_.queueRevision();
    afterUpcoming = queue_.upcoming();
    info_.queueIndex = queue_.currentIndex();
    info_.playMode = queue_.playModeId();
    info_.hasUpcomingTrack = afterUpcoming.has_value();
    info_.upcomingTrack = afterUpcoming.value_or(QueueItem{});
    transportActive = info_.state != PlaybackState::Stopped;
  }
  if (outFirstIndex) *outFirstIndex = firstIndex;

  // Appending past an already preloaded next item must not churn the decoder;
  // only a changed upcoming identity needs a fresh preload.
  if (appendedCount > 0 && transportActive && pipeline_ &&
      !sameQueuePosition(beforeUpcoming, afterUpcoming)) {
    if (afterUpcoming) {
      pipeline_->refreshQueueReplayGainTags(*afterUpcoming);
      std::string preloadError;
      if (!pipeline_->preloadNext(afterUpcoming, &preloadError)) {
        emitError(
            preloadError.empty() ? "追加队列后预加载失败" : preloadError,
            TAE_RESULT_INTERNAL_ERROR,
            "queue");
      }
    }
  }

  if (appendedCount > 0) {
    std::ostringstream payload;
    payload << "{\"firstIndex\":" << firstIndex << ",\"count\":" << appendedCount
            << ",\"revision\":" << revision << "}";
    emit("queue-appended", payload.str());
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::updateQueueItemSource(int index, const std::string& source) {
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  std::optional<QueueItem> beforeUpcoming;
  std::optional<QueueItem> afterUpcoming;
  uint64_t revision = 0;
  bool transportActive = false;
  {
    std::lock_guard lock(mutex_);
    if (index < 0 || index >= static_cast<int>(queue_.size())) {
      emitError("队列索引越界", TAE_RESULT_INVALID_ARGUMENT, "queue");
      return TAE_RESULT_INVALID_ARGUMENT;
    }
    if (index == queue_.currentIndex()) {
      emitError(
          "当前播放条目的音频地址不可热更新",
          TAE_RESULT_INVALID_ARGUMENT,
          "queue");
      return TAE_RESULT_INVALID_ARGUMENT;
    }
    beforeUpcoming = queue_.upcoming();
    std::string error;
    if (!queue_.updateItemSource(index, source, &error)) {
      emitError(
          error.empty() ? "更新队列音频地址失败" : error,
          TAE_RESULT_INVALID_ARGUMENT,
          "queue");
      return TAE_RESULT_INVALID_ARGUMENT;
    }
    revision = queue_.queueRevision();
    afterUpcoming = queue_.upcoming();
    info_.hasUpcomingTrack = afterUpcoming.has_value();
    info_.upcomingTrack = afterUpcoming.value_or(QueueItem{});
    transportActive = info_.state != PlaybackState::Stopped;
  }

  std::string preload = "not_needed";
  if (pipeline_ && !sameQueuePosition(beforeUpcoming, afterUpcoming) && afterUpcoming) {
    pipeline_->cancelAutoMix("queue_item_source_changed");
    if (transportActive) {
      pipeline_->refreshQueueReplayGainTags(*afterUpcoming);
      std::string preloadError;
      preload = pipeline_->preloadNext(afterUpcoming, &preloadError) ? "refreshed" : "failed";
      if (preload == "failed") {
        emitError(
            preloadError.empty() ? "刷新预加载失败" : preloadError,
            TAE_RESULT_INTERNAL_ERROR,
            "queue");
      }
    }
  }

  std::ostringstream payload;
  payload << "{\"index\":" << index << ",\"revision\":" << revision
          << ",\"preload\":\"" << preload << "\"}";
  emit("queue-item-source-updated", payload.str());
  return TAE_RESULT_OK;
}

std::string TwilightAudioEngine::getQueueStateJson() const {
  std::lock_guard lock(mutex_);
  std::ostringstream json;
  json << "{\"revision\":" << queue_.queueRevision()
       << ",\"size\":" << queue_.size()
       << ",\"currentIndex\":" << queue_.currentIndex()
       << ",\"upcomingIndex\":" << queue_.upcomingIndex().value_or(-1)
       << ",\"playMode\":\"" << queue_.playModeId() << "\"}";
  return json.str();
}

TAE_Result TwilightAudioEngine::next() {
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  std::optional<QueueItem> item;
  std::optional<QueueItem> upcoming;
  PlaybackState state = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    item = queue_.next();
    if (!item) return TAE_RESULT_OK;
    upcoming = queue_.upcoming();
    state = info_.state;
    info_.queueIndex = queue_.currentIndex();
    info_.positionSeconds = 0.0;
    info_.source = item->source;
    info_.durationSeconds = item->durationSeconds;
    info_.codec = inferCodec(item->source);
    info_.hasUpcomingTrack = upcoming.has_value();
    info_.upcomingTrack = upcoming.value_or(QueueItem{});
    publishStateLocked();
  }

  if (state != PlaybackState::Stopped && item) {
    std::string error;
    bool usedPreload = pipeline_ && pipeline_->skipToPreloaded(*item, &error);
    if (usedPreload) {
      if (pipeline_) pipeline_->consumeTrackStarted(nullptr);
      if (pipeline_) pipeline_->preloadNext(upcoming, &error);
      std::lock_guard lock(mutex_);
      applyPipelineStatusLocked(pipeline_->status());
      publishStateLocked();
    } else {
      const TAE_Result result = playQueueItem(*item, 0.0);
      if (result != TAE_RESULT_OK) return result;
    }
  }
  emit("next", getPlaybackInfoJson());
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::previous() {
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  std::optional<QueueItem> item;
  PlaybackState state = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    item = queue_.previous();
    if (!item) return TAE_RESULT_OK;
    state = info_.state;
    info_.queueIndex = queue_.currentIndex();
    info_.positionSeconds = 0.0;
    info_.source = item->source;
    info_.durationSeconds = item->durationSeconds;
    info_.codec = inferCodec(item->source);
    const auto upcoming = queue_.upcoming();
    info_.hasUpcomingTrack = upcoming.has_value();
    info_.upcomingTrack = upcoming.value_or(QueueItem{});
    publishStateLocked();
  }

  if (state != PlaybackState::Stopped && item) {
    const TAE_Result result = playQueueItem(*item, 0.0);
    if (result != TAE_RESULT_OK) return result;
  }
  emit("previous", getPlaybackInfoJson());
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setPlayMode(const std::string& mode) {
  std::lock_guard transportLock(transportMutex_);
  if (pipeline_) pipeline_->cancelAutoMix("queue_mode_changed");
  const ClockWake wake(*this);
  std::optional<QueueItem> upcoming;
  {
    std::lock_guard lock(mutex_);
    queue_.setPlayMode(QueueManager::parsePlayMode(mode));
    info_.playMode = queue_.playModeId();
    info_.queueIndex = queue_.currentIndex();
    upcoming = queue_.upcoming();
    info_.hasUpcomingTrack = upcoming.has_value();
    info_.upcomingTrack = upcoming.value_or(QueueItem{});
    publishStateLocked();
  }
  std::string error;
  if (pipeline_) pipeline_->preloadNext(upcoming, &error);
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setDspConfig(const std::string& dspJson) {
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  DspConfig previousConfig;
  const DspConfig nextConfig = DspChain::parseConfigJson(dspJson.empty() ? "{}" : dspJson);
  {
    std::lock_guard lock(mutex_);
    previousConfig = dspConfig_;
    dspConfigJson_ = dspJson.empty() ? "{}" : dspJson;
    dspConfig_ = nextConfig;
    if (pipeline_) pipeline_->setDspConfig(dspConfigJson_);
    if (pipeline_ && info_.state != PlaybackState::Stopped && !pausedOutputReleased_) {
      applyPipelineStatusLocked(pipeline_->status());
      if (info_.isDsd) {
        const bool wantsPcm = nextConfig.dsdOutputMode == DsdOutputMode::Pcm;
        const bool wantsNative =
            nextConfig.dsdOutputMode == DsdOutputMode::Auto || nextConfig.dsdOutputMode == DsdOutputMode::Native;
        const bool wantsDop =
            nextConfig.dsdOutputMode == DsdOutputMode::Auto || nextConfig.dsdOutputMode == DsdOutputMode::Dop ||
            nextConfig.dsdOutputMode == DsdOutputMode::Native;
        // A compatibility-route edit moves the stream to a different device, so it
        // must re-negotiate even when the requested DSD mode itself is unchanged.
        const bool routeChanged = !dsdRouteOverrideEquals(previousConfig.dsdRoute, nextConfig.dsdRoute);
        const bool modeChanged = previousConfig.dsdOutputMode != nextConfig.dsdOutputMode || routeChanged;
        const bool dopActive = pipeline_->isDopPathActive();
        const bool nativeActive = pipeline_->isNativeDsdPathActive();
        // Entering a DSD transport is pointless while processing still forces
        // PCM: the open path applies the same check and lands back in PCM, so
        // the listener only hears the gap. Leaving a DSD transport is never
        // gated — a fallback must always be able to take effect.
        const bool processingForcesPcm = pipeline_->processingForcesDsdPcmFallback();
        if ((dopActive || nativeActive) && wantsPcm) {
          rerouteReason = "DSD output mode forced PCM";
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
        } else if (nativeActive && nextConfig.dsdOutputMode == DsdOutputMode::Dop) {
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
          rerouteReason = "Re-enter DoP output mode";
        } else if (routeChanged && !wantsPcm) {
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
          rerouteReason = "DSD compatibility route changed";
        } else if (modeChanged && wantsNative && !nativeActive && !processingForcesPcm) {
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
          rerouteReason = "Re-enter Native DSD output mode";
        } else if (modeChanged && wantsDop && !dopActive && !nativeActive && !processingForcesPcm) {
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
          rerouteReason = wantsNative ? "Re-enter Native DSD output mode" : "Re-enter DoP output mode";
        }
      }
      if (rerouteReason.empty() &&
          !shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
        publishStateLocked();
      }
    } else {
      const DspStatus configStatus = configuredDspStatusFromConfig(nextConfig);
      info_.replayGainActive = configStatus.replayGainActive;
      info_.loudnormActive = configStatus.loudnormActive;
      info_.eqActive = configStatus.eqActive;
      info_.crossfeedActive = configStatus.crossfeedActive;
      info_.crossfeedStrength = configStatus.crossfeedStrength;
      info_.crossfadeActive = configStatus.crossfadeActive;
      info_.crossfadeSeconds = configStatus.crossfadeSeconds;
      if (!nextConfig.enabled) info_.convolverActive = false;
      updatePerfectLocked();
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "dsp");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setDspGraph(const std::string& graphJson) {
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  const std::string next = graphJson.empty() ? "{\"graph\":{\"nodes\":[]}}" : graphJson;
  std::string error;
  AudioPipeline* pipeline = nullptr;
  {
    std::lock_guard lock(mutex_);
    dspGraphJson_ = next;
    pipeline = pipeline_.get();
  }
  if (pipeline && !pipeline->setDspGraph(next, &error)) {
    emitError(error.empty() ? "DSP graph compilation failed" : error, TAE_RESULT_INVALID_ARGUMENT, "dsp-graph");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  {
    std::lock_guard lock(mutex_);
    if (pipeline_) applyPipelineStatusLocked(pipeline_->status());
    updatePerfectLocked();
    publishStateLocked();
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::applyDspState(
    uint64_t revision,
    const std::string& stateJson) {
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  const auto payloadRevision = json_utils::fieldNumber(stateJson, "revision");
  const std::string processingJson = json_utils::fieldObject(stateJson, "processing");
  if (revision == 0 || !payloadRevision.has_value() || !std::isfinite(*payloadRevision) ||
      *payloadRevision != std::floor(*payloadRevision) ||
      *payloadRevision != static_cast<double>(revision) || processingJson.empty() ||
      json_utils::fieldObject(stateJson, "graph").empty()) {
    emitError("DSP state payload is invalid", TAE_RESULT_INVALID_ARGUMENT, "dsp-state");
    return TAE_RESULT_INVALID_ARGUMENT;
  }

  const DspConfig nextConfig = DspChain::parseConfigJson(processingJson);
  DspConfig previousConfig;
  std::string previousGraphJson;
  OutputConfig previousOutputConfig;
  {
    std::lock_guard lock(mutex_);
    previousConfig = dspConfig_;
    previousGraphJson = dspGraphJson_;
    previousOutputConfig = outputConfig_;
  }

  // Optional output policy travels with the graph so a valid fixed-rate/set
  // change cannot be rejected against the preceding graph or preceding set.
  const auto outputStart = json_utils::topLevelFieldValueStart(stateJson, "outputConfig");
  const std::string outputJson = json_utils::fieldObject(stateJson, "outputConfig");
  const OutputConfig nextOutputConfig = outputStart ? parseOutputConfigJson(outputJson) : previousOutputConfig;
  const bool outputConfigChanged = nextOutputConfig != previousOutputConfig;
  const std::string nextStage = json_utils::fieldObject(json_utils::fieldObject(stateJson, "graph"), "outputStage");
  const int fixedRate = static_cast<int>(std::clamp(
      json_utils::fieldNumber(nextStage, "targetSampleRate").value_or(0.0), 0.0, static_cast<double>(kMaxPcmSampleRate)));
  if ((outputStart && outputJson.empty()) || !pcmSampleRateConstraintsCompatible(nextOutputConfig) ||
      (nextOutputConfig.sampleRateFamilySync && fixedRate > 0) ||
      (nextOutputConfig.continuityFirst && (nextOutputConfig.routingMode != ChannelRoutingMode::Auto ||
       nextOutputConfig.pcmToDsdMode != PcmToDsdMode::Off)) ||
      (!nextOutputConfig.continuityFirst && fixedRate > 0 &&
       !selectPcmSampleRate(fixedRate, fixedRate, nextOutputConfig, true))) {
    emitError("PCM 采样率与设备能力或允许集合不兼容", TAE_RESULT_INVALID_ARGUMENT, "dsp-state");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  const bool ratePolicyChanged = previousOutputConfig.usbPcmPassthrough != nextOutputConfig.usbPcmPassthrough || previousOutputConfig.continuityFirst != nextOutputConfig.continuityFirst ||
      (nextOutputConfig.continuityFirst && previousOutputConfig.continuitySampleRate != nextOutputConfig.continuitySampleRate) ||
      previousOutputConfig.sampleRateFamilySync != nextOutputConfig.sampleRateFamilySync ||
      previousOutputConfig.allowedSampleRates != nextOutputConfig.allowedSampleRates ||
      ((nextOutputConfig.sampleRateFamilySync || !nextOutputConfig.allowedSampleRates.empty()) &&
       previousOutputConfig.deviceSampleRates != nextOutputConfig.deviceSampleRates);
  std::string error;
  if (outputConfigChanged && pipeline_ && !pipeline_->setOutputConfig(nextOutputConfig, &error)) {
    emitError(error.empty() ? "输出配置设置失败" : error, TAE_RESULT_INVALID_ARGUMENT, "dsp-state");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  if (!pipeline_ || !pipeline_->applyDspState(revision, stateJson, &error)) {
    if (outputConfigChanged && pipeline_) pipeline_->setOutputConfig(previousOutputConfig, nullptr);
    emitError(
        error.empty() ? "DSP state application failed" : error,
        TAE_RESULT_INVALID_ARGUMENT,
        "dsp-state");
    return TAE_RESULT_INVALID_ARGUMENT;
  }

  if (previousOutputConfig.usbPcmPassthrough != nextOutputConfig.usbPcmPassthrough) {
    bool active;
    {
      std::lock_guard lock(mutex_);
      active = info_.state != PlaybackState::Stopped && !pausedOutputReleased_;
      if (active) {
        info_.positionSeconds = pipeline_->status().positionSeconds;
        info_.state = PlaybackState::Paused;
      }
    }
    // Changing this safety-sensitive mode is explicit preparation, never an automatic unmute.
    if (active) releasePausedOutput();
  }

  auto outputStageChangedForPcmReroute = [](const std::string& prevState, const std::string& nextState) {
    auto extractStage = [](const std::string& json) {
      const std::string graph = json_utils::fieldObject(json, "graph");
      const std::string root = graph.empty() ? json : graph;
      return json_utils::fieldObject(root, "outputStage");
    };
    const std::string prevStage = extractStage(prevState);
    const std::string nextStage = extractStage(nextState);
    const int prevRate = static_cast<int>(std::clamp(
        json_utils::fieldNumber(prevStage, "targetSampleRate").value_or(0.0), 0.0, static_cast<double>(kMaxPcmSampleRate)));
    const int nextRate = static_cast<int>(std::clamp(
        json_utils::fieldNumber(nextStage, "targetSampleRate").value_or(0.0), 0.0, static_cast<double>(kMaxPcmSampleRate)));
    if (prevRate != nextRate) return true;
    const std::string prevQuality = json_utils::fieldString(prevStage, "resamplerQuality").value_or("native");
    const std::string nextQuality = json_utils::fieldString(nextStage, "resamplerQuality").value_or("native");
    if (prevQuality != nextQuality) return true;
    const std::string prevPhase = json_utils::fieldString(prevStage, "resamplerPhase").value_or("linear");
    const std::string nextPhase = json_utils::fieldString(nextStage, "resamplerPhase").value_or("linear");
    return prevPhase != nextPhase;
  };

  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    // The pipeline transaction has compiled and published the request. Only
    // now expose it as the engine's desired state; failed preparation or a
    // saturated RT retirement window leaves all three fields untouched.
    dspConfig_ = nextConfig;
    dspConfigJson_ = processingJson;
    dspGraphJson_ = stateJson;
    if (outputStart) outputConfig_ = nextOutputConfig;
    applyPipelineStatusLocked(pipeline_->status());
    if (pipeline_ && info_.state != PlaybackState::Stopped && !pausedOutputReleased_) {
      if (ratePolicyChanged) {
        rerouteReason = "PCM output policy changed";
        reroutePosition = info_.positionSeconds;
        rerouteState = info_.state;
      }
      if (info_.isDsd) {
        const bool wantsPcm = nextConfig.dsdOutputMode == DsdOutputMode::Pcm;
        const bool wantsNative =
            nextConfig.dsdOutputMode == DsdOutputMode::Auto || nextConfig.dsdOutputMode == DsdOutputMode::Native;
        const bool wantsDop =
            nextConfig.dsdOutputMode == DsdOutputMode::Auto || nextConfig.dsdOutputMode == DsdOutputMode::Dop ||
            nextConfig.dsdOutputMode == DsdOutputMode::Native;
        // A compatibility-route edit moves the stream to a different device, so it
        // must re-negotiate even when the requested DSD mode itself is unchanged.
        const bool routeChanged = !dsdRouteOverrideEquals(previousConfig.dsdRoute, nextConfig.dsdRoute);
        const bool modeChanged = previousConfig.dsdOutputMode != nextConfig.dsdOutputMode || routeChanged;
        const bool dopActive = pipeline_->isDopPathActive();
        const bool nativeActive = pipeline_->isNativeDsdPathActive();
        // See setDspConfig: entering a DSD transport while processing still
        // forces PCM only costs the listener a restart and ends up in PCM again.
        const bool processingForcesPcm = pipeline_->processingForcesDsdPcmFallback();
        if ((dopActive || nativeActive) && wantsPcm) {
          rerouteReason = "DSD output mode forced PCM";
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
        } else if (nativeActive && nextConfig.dsdOutputMode == DsdOutputMode::Dop) {
          rerouteReason = "Re-enter DoP output mode";
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
        } else if (routeChanged && !wantsPcm) {
          rerouteReason = "DSD compatibility route changed";
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
        } else if (modeChanged && wantsNative && !nativeActive && !processingForcesPcm) {
          rerouteReason = "Re-enter Native DSD output mode";
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
        } else if (modeChanged && wantsDop && !dopActive && !nativeActive && !processingForcesPcm) {
          rerouteReason = wantsNative ? "Re-enter Native DSD output mode" :
                                        "Re-enter DoP output mode";
          reroutePosition = info_.positionSeconds;
          rerouteState = info_.state;
        }
      }
      const int nextTargetRate = [&]() {
        const std::string graph = json_utils::fieldObject(stateJson, "graph");
        const std::string root = graph.empty() ? stateJson : graph;
        const std::string stage = json_utils::fieldObject(root, "outputStage");
        return static_cast<int>(std::clamp(
            json_utils::fieldNumber(stage, "targetSampleRate").value_or(0.0), 0.0, static_cast<double>(kMaxPcmSampleRate)));
      }();
      const int desiredPcmRate = selectPcmSampleRate(info_.sourceSampleRate,
          nextTargetRate > 0 ? nextTargetRate : info_.sourceSampleRate, outputConfig_, nextTargetRate > 0).value_or(0);
      const bool exclusiveRateMismatch =
          (info_.outputBackend == "asio" || info_.outputBackend == "wasapi-exclusive" ||
           info_.outputBackend == "coreaudio-exclusive" || info_.outputInfo.exclusive) &&
          !outputConfig_.continuityFirst &&
          desiredPcmRate > 0 && info_.outputSampleRate > 0 &&
          info_.outputSampleRate != desiredPcmRate;
      if (rerouteReason.empty() &&
          (!info_.isDsd || info_.dsdMode == "pcm") &&
          (outputStageChangedForPcmReroute(previousGraphJson, stateJson) || exclusiveRateMismatch)) {
        rerouteReason = "DSP output stage changed";
        reroutePosition = info_.positionSeconds;
        rerouteState = info_.state;
      }
      if (rerouteReason.empty() &&
          !shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
        publishStateLocked();
      }
    } else {
      const DspStatus configStatus = configuredDspStatusFromConfig(nextConfig);
      info_.replayGainActive = configStatus.replayGainActive;
      info_.loudnormActive = configStatus.loudnormActive;
      info_.eqActive = configStatus.eqActive;
      info_.crossfeedActive = configStatus.crossfeedActive;
      info_.crossfeedStrength = configStatus.crossfeedStrength;
      info_.crossfadeActive = configStatus.crossfadeActive;
      info_.crossfadeSeconds = configStatus.crossfadeSeconds;
      if (!nextConfig.enabled) info_.convolverActive = false;
      updatePerfectLocked();
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(
        reroutePosition,
        rerouteState,
        rerouteReason,
        "dsp-state");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setOutputConfig(const std::string& outputConfigJson) {
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  OutputConfig parsed = parseOutputConfigJson(outputConfigJson.empty() ? "{}" : outputConfigJson);
  const int fixedRate = [&] {
    std::lock_guard lock(mutex_);
    const auto graph = json_utils::fieldObject(dspGraphJson_, "graph");
    const auto stage = json_utils::fieldObject(graph.empty() ? dspGraphJson_ : graph, "outputStage");
    return static_cast<int>(std::clamp(json_utils::fieldNumber(stage, "targetSampleRate").value_or(0.0), 0.0, static_cast<double>(kMaxPcmSampleRate)));
  }();
  if (!pcmSampleRateConstraintsCompatible(parsed) || (parsed.sampleRateFamilySync && fixedRate > 0) ||
      (!parsed.continuityFirst && fixedRate > 0 && !selectPcmSampleRate(fixedRate, fixedRate, parsed, true))) {
    emitError("PCM 采样率与设备能力或允许集合不兼容", TAE_RESULT_INVALID_ARGUMENT, "output-config");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  if (parsed.continuityFirst &&
      (parsed.routingMode != ChannelRoutingMode::Auto || parsed.pcmToDsdMode != PcmToDsdMode::Off)) {
    emitError("连续优先需要自动声道路由且关闭 PCM 转 DSD", TAE_RESULT_INVALID_ARGUMENT, "output-config");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  std::string error;
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  bool routePending = false;
  {
    std::lock_guard lock(mutex_);
    if (pausedOutputReleased_) {
      if (pipeline_ && !pipeline_->setOutputConfig(parsed, &error)) {
        emitError(error.empty() ? "输出配置设置失败" : error, TAE_RESULT_INVALID_ARGUMENT, "output-config");
        return TAE_RESULT_INVALID_ARGUMENT;
      }
      outputConfig_ = parsed;
      outputRoutePending_ = false;
      info_.outputInfo.backend = info_.outputBackend;
      info_.outputInfo.channelRoutingMode = channelRoutingModeToString(parsed.routingMode);
      publishStateLocked();
      return TAE_RESULT_OK;
    }
    const bool outputTopologyChanged =
        outputConfig_.usbPcmPassthrough != parsed.usbPcmPassthrough ||
        outputConfig_.continuityFirst != parsed.continuityFirst ||
        outputConfig_.sampleRateFamilySync != parsed.sampleRateFamilySync ||
        outputConfig_.allowedSampleRates != parsed.allowedSampleRates ||
        ((parsed.sampleRateFamilySync || !parsed.allowedSampleRates.empty()) && outputConfig_.deviceSampleRates != parsed.deviceSampleRates) ||
        (parsed.continuityFirst && outputConfig_.continuitySampleRate != parsed.continuitySampleRate) ||
        outputConfig_.routingMode != parsed.routingMode ||
        outputConfig_.pcmToDsdMode != parsed.pcmToDsdMode;
    routePending = (outputRoutePending_ || outputTopologyChanged) &&
                   pipeline_ && info_.state != PlaybackState::Stopped;
  }
  if (routePending && outputConfig_.usbPcmPassthrough != parsed.usbPcmPassthrough) {
    {
      std::lock_guard lock(mutex_);
      info_.positionSeconds = pipeline_->status().positionSeconds;
      info_.state = PlaybackState::Paused;
    }
    releasePausedOutput();
    routePending = false;
  }
  if (routePending && pipeline_) pipeline_->stop();
  if (pipeline_ && !pipeline_->setOutputConfig(parsed, &error)) {
    emitError(error.empty() ? "输出配置设置失败" : error, TAE_RESULT_INVALID_ARGUMENT, "output-config");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  {
    std::lock_guard lock(mutex_);
    outputConfig_ = parsed;
    info_.outputInfo.channelRoutingMode = channelRoutingModeToString(outputConfig_.routingMode);
    if (routePending) {
      rerouteReason = "output route transaction";
      reroutePosition = info_.positionSeconds;
      rerouteState = info_.state;
      outputRoutePending_ = false;
    } else if (pipeline_ && info_.state != PlaybackState::Stopped && !pausedOutputReleased_) {
      applyPipelineStatusLocked(pipeline_->status());
      if (shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
        // Defer publish until the reroute completes.
      } else {
        publishStateLocked();
      }
    } else {
      outputRoutePending_ = false;
      updatePerfectLocked();
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "output-config");
  }
  bool release = false;
  {
    std::lock_guard lock(mutex_);
    release = info_.state == PlaybackState::Paused && shouldReleaseOutputLocked();
  }
  if (release) releasePausedOutput();
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::loadImpulseResponse(const std::string& path) {
  const ClockWake wake(*this);
  if (path.empty()) return TAE_RESULT_INVALID_ARGUMENT;
  std::string error;
  if (!pipeline_ || !pipeline_->loadImpulseResponse(path, &error)) {
    emitError(error.empty() ? "脉冲响应加载失败" : error, TAE_RESULT_INVALID_ARGUMENT, "dsp");
    return TAE_RESULT_INTERNAL_ERROR;
  }
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    applyPipelineStatusLocked(pipeline_->status());
    if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "dsp");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::unloadImpulseResponse() {
  const ClockWake wake(*this);
  if (!pipeline_) return TAE_RESULT_NOT_INITIALIZED;
  pipeline_->unloadImpulseResponse();
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    applyPipelineStatusLocked(pipeline_->status());
    if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "dsp");
  }
  return TAE_RESULT_OK;
}

std::string TwilightAudioEngine::getConvolverInfoJson() const {
  return convolverInfoToJson(pipeline_ ? pipeline_->convolverInfo() : ConvolverInfo{});
}

TAE_Result TwilightAudioEngine::setEqBands(const std::string& eqJson) {
  const ClockWake wake(*this);
  std::string error;
  if (!pipeline_ || !pipeline_->setEqBands(eqJson, &error)) {
    emitError(error.empty() ? "均衡器设置失败" : error, TAE_RESULT_INVALID_ARGUMENT, "dsp");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    applyPipelineStatusLocked(pipeline_->status());
    if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "dsp");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setEqPreset(const std::string& presetJson) {
  const ClockWake wake(*this);
  std::string error;
  if (!pipeline_ || !pipeline_->setEqPreset(presetJson, &error)) {
    emitError(error.empty() ? "均衡器预设应用失败" : error, TAE_RESULT_INVALID_ARGUMENT, "dsp");
    return TAE_RESULT_INVALID_ARGUMENT;
  }
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    applyPipelineStatusLocked(pipeline_->status());
    if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "dsp");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setCrossfeedStrength(double strength) {
  const ClockWake wake(*this);
  if (!std::isfinite(strength)) return TAE_RESULT_INVALID_ARGUMENT;
  if (!pipeline_) return TAE_RESULT_NOT_INITIALIZED;
  pipeline_->setCrossfeedStrength(strength);
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    applyPipelineStatusLocked(pipeline_->status());
    if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "dsp");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setReplayGainMode(
    const std::string& mode,
    double preampDb,
    double fallbackDb,
    bool clip) {
  const ClockWake wake(*this);
  if (!std::isfinite(preampDb) || !std::isfinite(fallbackDb)) return TAE_RESULT_INVALID_ARGUMENT;
  if (!pipeline_) return TAE_RESULT_NOT_INITIALIZED;
  pipeline_->setReplayGainMode(parseReplayGainModeId(mode), preampDb, fallbackDb, clip);
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    applyPipelineStatusLocked(pipeline_->status());
    if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "dsp");
  }
  return TAE_RESULT_OK;
}

TAE_Result TwilightAudioEngine::setNativeDspPluginChain(const std::string& chainJson) {
  std::lock_guard transportLock(transportMutex_);
  const ClockWake wake(*this);
  std::string nextChain;
  {
    std::lock_guard lock(mutex_);
    nativeDspPluginChainJson_ = chainJson.empty() ? "{\"plugins\":[]}" : chainJson;
    nextChain = nativeDspPluginChainJson_;
  }
  if (pipeline_) {
    pipeline_->setNativeDspPluginChain(nextChain);
  }
  std::string rerouteReason;
  double reroutePosition = 0.0;
  PlaybackState rerouteState = PlaybackState::Stopped;
  {
    std::lock_guard lock(mutex_);
    if (pipeline_) applyPipelineStatusLocked(pipeline_->status());
    if (!shouldReroutePipelineLocked(&rerouteReason, &reroutePosition, &rerouteState)) {
      publishStateLocked();
    }
  }
  if (!rerouteReason.empty()) {
    return restartCurrentPlaybackForReroute(reroutePosition, rerouteState, rerouteReason, "dsp");
  }
  return TAE_RESULT_OK;
}

std::string TwilightAudioEngine::getNativeDspPluginStatusJson() const {
  std::lock_guard lock(mutex_);
  if (pipeline_) return pipeline_->nativeDspPluginStatusJson();
  return "{\"plugins\":[]}";
}

std::string TwilightAudioEngine::getDspConfig() const {
  std::lock_guard lock(mutex_);
  return dspConfigJson_;
}

std::string TwilightAudioEngine::getDspGraphStatusJson() const {
  std::lock_guard lock(mutex_);
  return pipeline_ ? pipeline_->dspGraphStatusJson()
                   : "{\"revision\":0,\"activeSceneId\":null,\"totalLatencyFrames\":0,\"totalTailFrames\":0,\"nodes\":[]}";
}

std::string TwilightAudioEngine::getMetadataJson(const std::string& source) const {
  return readMetadataJson(source);
}

std::string TwilightAudioEngine::getQueueJson() const {
  std::lock_guard lock(mutex_);
  return queue_.queueJson();
}

std::string TwilightAudioEngine::getUpcomingTrackJson() const {
  std::lock_guard lock(mutex_);
  const auto upcoming = queue_.upcoming();
  if (upcoming && info_.hasUpcomingTrack && info_.preloadReady &&
      upcoming->id == info_.upcomingTrack.id && upcoming->source == info_.upcomingTrack.source &&
      upcoming->cueStartSeconds == info_.upcomingTrack.cueStartSeconds &&
      upcoming->cueEndSeconds == info_.upcomingTrack.cueEndSeconds)
    return QueueManager::itemToJson(info_.upcomingTrack);
  return queue_.upcomingJson();
}

std::string TwilightAudioEngine::enumerateDevicesJson() const {
  return enumeratePlatformDevicesJson();
}

std::string TwilightAudioEngine::enumerateBackendsJson() const {
  std::ostringstream json;
  json << "[";
  bool first = true;
  auto append = [&](const char* id, const char* label, bool supportsExclusive, bool optional = false) {
    if (!first) json << ",";
    first = false;
    json << "{\"id\":\"" << id << "\",\"label\":\"" << label << "\",\"supportsExclusive\":"
         << (supportsExclusive ? "true" : "false");
    if (optional) json << ",\"optional\":true";
    json << "}";
  };
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  append("wasapi", "共享输出", false);
  append("wasapi-exclusive", "独占输出", true);
#endif
#if defined(_WIN32) && defined(TAE_ENABLE_ASIO)
  append("asio", "专业声卡输出", true, true);
#endif
#if defined(__APPLE__) && defined(TAE_ENABLE_COREAUDIO)
  append("coreaudio", "苹果系统音频", false);
  append("coreaudio-exclusive", "独占输出 (Hog Mode)", true);
#endif
#if defined(__ANDROID__) && defined(TAE_ENABLE_OBOE)
  append("oboe", "Android Oboe 输出", false);
#endif
#if defined(__APPLE__) && defined(TAE_ENABLE_IOS_AUDIOUNIT)
  append("audiounit", "iOS AudioUnit 输出", false);
#endif
#if defined(__linux__) && !defined(__ANDROID__) && defined(TAE_ENABLE_ALSA)
  append("alsa", "Linux ALSA 输出", false);
#endif
  json << "]";
  return json.str();
}

std::string TwilightAudioEngine::engineCapabilitiesJson() const {
  const std::string backends = enumerateBackendsJson();
  const std::string backendCapabilities = backendCapabilitiesJson();
  bool nativeDsdCapable = false;
  bool dopCapable = false;
  {
    std::lock_guard lock(mutex_);
    nativeDsdCapable = info_.outputInfo.driverNativeDsdCapable;
    dopCapable = info_.outputInfo.driverDopCapable;
  }
  // The built-in DSD-preserving DST decoder (vendored dstdec) makes SACD ISO
  // DST-compressed tracks playable. Report the capability honestly: when the
  // provider is available, sacdIsoDst=true and DST tracks enter the same
  // Native DSD / DoP / PCM decision chain as uncompressed DSD.
  bool sacdDstAvailable = false;
  bool sacdDstProviderRegistered = false;
  std::string sacdDstReasonCode;
  std::string sacdDstReason;
  if (auto provider = createDefaultSacdDstDecoderProvider()) {
    sacdDstProviderRegistered = true;
    std::string reason;
    sacdDstAvailable = provider->available(&reason);
    if (!sacdDstAvailable) {
      sacdDstReasonCode = kSacdDstDsdProviderUnavailableReasonCode;
      sacdDstReason = reason.empty() ? kSacdDstDsdProviderUnavailableReason : reason;
    }
  } else {
    sacdDstReasonCode = kSacdDstDsdProviderUnavailableReasonCode;
    sacdDstReason = kSacdDstDsdProviderUnavailableReason;
  }
  std::ostringstream json;
  json << "{"
       << "\"version\":\"" << TAE_GetVersion() << "\","
       << "\"defaultBackend\":\"" << json_utils::escape(defaultBackendId()) << "\","
       << "\"pcmPassthrough\":true,"
       << "\"outputPerfectRequiresPcmPassthrough\":true,"
       << "\"htmlAudioFallbackDefault\":false,"
       << "\"dsdModes\":[\"pcm\",\"dop\",\"native\",\"unsupported\"],"
       << "\"sacdProgramModes\":[\"auto\",\"stereo\",\"multichannel\"],"
       << "\"devicePathKinds\":[\"default\",\"hw\",\"plughw\",\"hal\",\"asio\"],"
       << "\"dsd\":{\"native\":" << (nativeDsdCapable ? "true" : "false") << ",\"dop\":" << (dopCapable ? "true" : "false")
        << ",\"sacdIso\":true,\"sacdIsoDst\":" << (sacdDstAvailable ? "true" : "false")
        << ",\"sacdIsoDstMode\":\"" << (sacdDstAvailable ? "native" : "unavailable") << "\","
        << "\"sacdIsoDstReasonCode\":\"" << json_utils::escape(sacdDstReasonCode) << "\","
        << "\"sacdIsoDstReason\":\"" << json_utils::escape(sacdDstReason) << "\",\"mode\":\"pcm\"},"
       << "\"features\":{"
       << "\"ffmpeg\":"
#if defined(TAE_HAS_FFMPEG)
       << "true"
#else
       << "false"
#endif
       << ",\"wasapi\":"
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
       << "true"
#else
       << "false"
#endif
       << ",\"asio\":"
#if defined(_WIN32) && defined(TAE_ENABLE_ASIO)
       << "true"
#else
       << "false"
#endif
       << ",\"coreaudio\":"
#if defined(__APPLE__) && defined(TAE_ENABLE_COREAUDIO)
       << "true"
#else
       << "false"
#endif
       << ",\"alsa\":"
#if defined(__linux__) && defined(TAE_ENABLE_ALSA)
       << "true"
#else
       << "false"
#endif
       << ",\"nativeDsd\":" << (nativeDsdCapable ? "true" : "false") << ",\"dop\":" << (dopCapable ? "true" : "false")
        << ",\"sacdIso\":true,\"sacdIsoDst\":" << (sacdDstAvailable ? "true" : "false")
        << ",\"sacdIsoDstDsdProvider\":" << (sacdDstProviderRegistered ? "true" : "false") << ","
       << "\"audioPluginSystem\":true,\"nativeDsp\":true,\"ebur128\":"
#if defined(TAE_HAS_EBUR128)
       << "true"
#else
       << "false"
#endif
       << ",\"loudnessAnalysis\":"
#if defined(TAE_HAS_EBUR128) && defined(TAE_HAS_FFMPEG)
       << "true"
#else
       << "false"
#endif
       << "},\"backends\":" << backends
       << ",\"backendCapabilities\":" << backendCapabilities
       << ",\"plugins\":" << pluginCapabilitiesJson()
       << ",\"output\":{\"accessModes\":[\"shared\",\"exclusive\",\"hog\",\"direct\",\"plugin\"]}"
       << ",\"queueHotUpdate\":{\"version\":1,\"append\":true,\"updateSource\":true,"
          "\"upcomingIndex\":true}"
       << ",\"queueRebind\":{\"version\":1,\"conditional\":true}"
       << "}";
  return json.str();
}

std::string TwilightAudioEngine::getLastErrorJson() const {
  std::lock_guard lock(errorMutex_);
  const bool hasError = !lastError_.empty();
  std::ostringstream json;
  json << "{\"hasError\":" << (hasError ? "true" : "false") << ",\"code\":\""
       << resultToString(hasError ? lastErrorCode_ : TAE_RESULT_OK) << "\",\"message\":\""
       << json_utils::escape(lastError_) << "\",\"backend\":\"\",\"context\":\""
       << json_utils::escape(lastErrorContext_.empty() ? "native" : lastErrorContext_) << "\",\"recoverable\":"
       << (hasError && lastErrorCode_ != TAE_RESULT_INVALID_ARGUMENT ? "true" : "false") << "}";
  return json.str();
}

std::string TwilightAudioEngine::getPlaybackInfoJson() const {
  PlaybackInfo snapshot;
  {
    std::lock_guard lock(mutex_);
    snapshot = info_;
    snapshot.queueRevision = queue_.queueRevision();
    snapshot.upcomingQueueIndex = queue_.upcomingIndex().value_or(-1);
  }
  if (pipeline_) pipeline_->sampleDecodeHealth(snapshot.outputInfo.diagnostics);
  return playbackInfoToJson(snapshot);
}

size_t TwilightAudioEngine::getSpectrumData(float* buffer, size_t pointCount) const {
  if (!buffer || pointCount == 0) return 0;
  if (pipeline_) {
    const size_t written = pipeline_->getSpectrumData(buffer, pointCount);
    if (written > 0) return written;
  }
  std::lock_guard lock(mutex_);
  const double phase = info_.positionSeconds;
  for (size_t i = 0; i < pointCount; ++i) {
    const double x = static_cast<double>(i) / static_cast<double>(pointCount);
    buffer[i] = static_cast<float>((std::sin((x * 18.0 + phase) * 3.14159) + 1.0) * 0.25);
  }
  return pointCount;
}

void TwilightAudioEngine::setVisualizationDemand(bool enabled) {
  if (pipeline_) pipeline_->setVisualizationDemand(enabled);
}

std::string TwilightAudioEngine::getVisualizationDataJson(const std::string& optionsJson) const {
  const VisualizationQuery query = parseVisualizationQueryJson(optionsJson.empty() ? "{}" : optionsJson);
  if (pipeline_) {
    return pipeline_->getVisualizationDataJson(
        query.spectrumPoints,
        query.waveformPoints,
        query.spectrogramFrames,
        query.oscilloscopePoints,
        query.visualizerBarCount);
  }
  std::lock_guard lock(mutex_);
  return inactiveVisualizationJson(query, info_.actualSampleRate);
}

void TwilightAudioEngine::startClock() {
  clockThread_ = std::thread([this] { clockLoop(); });
}

void TwilightAudioEngine::stopClock() {
  {
    std::lock_guard lock(clockMutex_);
    running_ = false;
  }
  clockCv_.notify_all();
  if (clockThread_.joinable()) clockThread_.join();
}

void TwilightAudioEngine::wakeClock() const {
  {
    std::lock_guard lock(clockMutex_);
    // Record before the idle check: a command can race the transition into an
    // idle wait. Active waits ignore it and retain their 100 ms cadence.
    clockWakeRequested_ = true;
    if (!clockIdle_) return;
  }
  clockCv_.notify_all();
}

void TwilightAudioEngine::waitForClockTick(bool active) {
  // While playing the tick drives position, end-of-track, loop-range and
  // preload promotion, so it keeps the 100 ms cadence. Stopped or paused, it
  // only has to notice device/render failures and reap retired decode streams,
  // which a 1 s tick covers; transport and DSP commands wake it immediately.
  const auto interval = active ? std::chrono::milliseconds(100) : std::chrono::milliseconds(1000);
  std::unique_lock lock(clockMutex_);
  clockIdle_ = !active;
  clockCv_.wait_for(lock, interval, [this, active] { return (!active && clockWakeRequested_) || !running_; });
  clockWakeRequested_ = false;
}

void TwilightAudioEngine::diagnosticLoop() {
  DiagnosticJournal journal;
  EmptyOutputDetector detector;
  journal.write("engine.started", "{}");
  while (diagnosticRunning_.load(std::memory_order_relaxed)) {
    const auto start = std::chrono::steady_clock::now();
    OutputInfo::Diagnostics health;
    pipeline_->sampleDecodeHealth(health); // Only atomics and a try-lock; never transport/clock locks.
    const auto nowMs = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(start.time_since_epoch()).count());
    const auto heartbeatMs = clockHeartbeatMs_.load(std::memory_order_relaxed);
    std::ostringstream out;
    out << "{\"available\":" << (health.decodeHealthAvailable ? "true" : "false")
        << ",\"unavailableReason\":\"" << health.decodeUnavailableReason << "\""
        << ",\"renderState\":" << health.liveRenderState << ",\"callbackCount\":" << health.liveRenderCallbackCount
        << ",\"sourceConsumedFrames\":" << health.sourceConsumedFrames << ",\"outputProducedFrames\":" << health.outputProducedFrames
        << ",\"zeroFilledFrames\":" << health.zeroFilledFrames << ",\"emptyOutputCount\":" << health.emptyOutputCount
        << ",\"inactiveOutputCount\":" << health.inactiveOutputCount << ",\"eofOutputCount\":" << health.eofOutputCount
        << ",\"streamToken\":" << health.decodeStreamToken << ",\"preloadStreamToken\":" << health.preloadStreamToken
        << ",\"bufferedFrames\":" << health.decodeBufferedFrames << ",\"producedFrames\":" << health.decodeProducedFrames
        << ",\"decodeStage\":\"" << health.decodeStage << "\",\"progressAgeMs\":" << health.decodeLastProgressAgeMs
        << ",\"decodeRunning\":" << (health.decodeRunning ? "true" : "false")
        << ",\"eof\":" << (health.decodeEof ? "true" : "false") << ",\"stopRequested\":" << (health.decodeStopRequested ? "true" : "false")
        << ",\"clockHeartbeat\":" << clockHeartbeat_.load(std::memory_order_relaxed)
        << ",\"clockAgeMs\":" << (heartbeatMs && nowMs >= heartbeatMs ? nowMs - heartbeatMs : nowMs) << '}';
    journal.write("health.sample", out.str());
    if (detector.sample(health.decodeHealthAvailable, health.liveRenderState == static_cast<int>(PipelineState::Playing),
                        health.decodeEof, health.decodeStopRequested, health.decodeStreamToken,
                        health.liveRenderCallbackCount, health.sourceConsumedFrames)) {
      journal.write("incident.empty-output", "{\"beforeSeconds\":120,\"afterSeconds\":30,\"health\":" + out.str() + "}", DiagLevel::Warning);
    }
    journal.drain();
    // Short interruptible waits do not contend with the clock condition variable.
    while (diagnosticRunning_.load() && std::chrono::steady_clock::now() - start < std::chrono::seconds(1))
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  journal.drain(); journal.write("engine.stopped", "{}");
}

void TwilightAudioEngine::recordNaturalBoundaryLocked() {
  auto& boundary = info_.naturalBoundaries;
  const auto now = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count());
  ++boundary.trackSerial;
  boundary.trackTimeMs = now;
  if (queue_.currentCompletesQueue()) {
    ++boundary.queueSerial;
    boundary.queueTimeMs = now;
  }
}

void TwilightAudioEngine::clockLoop() {
  PipelineState lastPipelineState = PipelineState::Stopped;
  while (running_) {
    bool active = lastPipelineState == PipelineState::Playing;
    if (!active) {
      std::lock_guard lock(mutex_);
      active = info_.state == PlaybackState::Playing;
    }
    waitForClockTick(active);
    if (!running_) break;
    std::unique_lock transportLock(transportMutex_);
    clockHeartbeat_.fetch_add(1, std::memory_order_relaxed);
    clockHeartbeatMs_.store(static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count()), std::memory_order_relaxed);
    // Nobody may be listening for playback snapshots (the N-API addon polls
    // GetPlaybackInfo instead), so only serialize them when a consumer asked.
    const bool stateEvents = stateEventsEnabled_.load(std::memory_order_relaxed);
    std::string payload;
    bool emitTick = false;
    bool emitEnded = false;
    PipelineStatus pipelineStatus;
    const bool hasPipelineStatus = pipeline_ != nullptr;
    bool deviceInvalidated = false;
    bool renderError = false;
    bool decodeError = false;
    bool trackStarted = false;
    std::string deviceInvalidatedMessage;
    std::string renderErrorMessage;
    std::string decodeErrorMessage;
    if (hasPipelineStatus) {
      pipeline_->pollAutoMix();
      // A-B loop enforcement (seek is not RT-safe — runs on clock thread).
      std::string loopError;
      if (pipeline_->enforceLoopRange(&loopError)) {
        // Refresh status after an in-loop seek so UI sees the jump promptly.
        pipelineStatus = pipeline_->status();
      } else {
        pipelineStatus = pipeline_->status();
      }
    }
    if (hasPipelineStatus &&
        pipelineStatus.appliedConfigRevision > lastEmittedAppliedConfigRevision_) {
      lastEmittedAppliedConfigRevision_ = pipelineStatus.appliedConfigRevision;
      std::ostringstream configPayload;
      configPayload << "{\"requestedConfigRevision\":" << pipelineStatus.requestedConfigRevision
                    << ",\"appliedConfigRevision\":" << pipelineStatus.appliedConfigRevision << "}";
      // A consumer may wait for a transport command while handling this event.
      // Let that command complete before applying the clock's earlier snapshot.
      transportLock.unlock();
      emit("config-applied", configPayload.str());
      transportLock.lock();
      // A transport/config command can complete while the event is delivered.
      // Refresh metadata as well as state before publishing this tick. Read
      // lifecycle flags only after reacquiring the lock, so an old promotion
      // or device failure cannot affect a newly opened output/queue pair.
      pipelineStatus=pipeline_->status();
    }
    if(hasPipelineStatus) {
      emitEnded = pipeline_->consumeEnded();
      deviceInvalidated = pipeline_->consumeDeviceInvalidated(&deviceInvalidatedMessage);
      renderError = pipeline_->consumeRenderError(&renderErrorMessage);
      decodeError = pipeline_->consumeDecodeError(&decodeErrorMessage);
      trackStarted = pipeline_->consumeTrackStarted(nullptr);
      // Promotion can occur between the snapshot and the track-start flag.
      if(trackStarted)pipelineStatus=pipeline_->status();
      lastPipelineState=pipelineStatus.state;
    }
    if (outputConfig_.usbPcmPassthrough && (deviceInvalidated || renderError ||
        (hasPipelineStatus && pipelineStatus.outputInfo.usbPcmInvalid))) {
      suspendUsbPcm("USB 原样 PCM 偏好、路由或播放流已失效；请检查连接后重试，或关闭此模式恢复普通输出");
      continue;
    }
    if (deviceInvalidated) {
      std::string source;
      double position = 0.0;
      PlaybackState previousState = PlaybackState::Stopped;
      bool recover = false;
      {
        std::lock_guard lock(mutex_);
        previousState = info_.state;
        if (hasPipelineStatus) {
          info_.positionSeconds = pipelineStatus.positionSeconds;
          info_.durationSeconds = pipelineStatus.stream.durationSeconds;
          info_.source = pipelineStatus.stream.source.empty() ? info_.source : pipelineStatus.stream.source;
        }
        source = info_.source;
        position = info_.positionSeconds;
        recover = info_.outputDevice == "auto" && !source.empty() && previousState != PlaybackState::Stopped;
        if (!recover) {
          info_.state = PlaybackState::Stopped;
          if (stateEvents) {
            payload = playbackInfoToJson(info_);
            emitTick = true;
          }
        }
      }
      if (recover) {
#if defined(__ANDROID__)
        // A lost Android route can fall back to the loudspeaker. Reopen silently;
        // the user chooses when playback continues on the new route.
        const TAE_Result result = play(source, position, true);
        if (result != TAE_RESULT_OK) {
#else
        const TAE_Result result = play(source, position);
        if (result == TAE_RESULT_OK && previousState == PlaybackState::Paused) {
          pause();
        } else if (result != TAE_RESULT_OK) {
#endif
          emitError(
              deviceInvalidatedMessage.empty() ? "输出设备已失效，自动恢复失败" : deviceInvalidatedMessage,
              TAE_RESULT_BACKEND_UNAVAILABLE,
              "device-recovery");
        }
      } else {
        if (pipeline_) pipeline_->stop();
        emitError(
            deviceInvalidatedMessage.empty() ? "输出设备已失效" : deviceInvalidatedMessage,
            TAE_RESULT_BACKEND_UNAVAILABLE,
            "device");
        if (emitTick) emit("property-change", payload);
      }
      continue;
    }
    if (renderError || decodeError) {
      const std::string failureMessage = decodeError ? decodeErrorMessage : renderErrorMessage;
      {
        std::lock_guard lock(mutex_);
        if (hasPipelineStatus) applyPipelineStatusLocked(pipelineStatus);
        info_.state = PlaybackState::Stopped;
        info_.outputInfo.diagnostics.lastError = failureMessage;
        if (stateEvents) {
          payload = playbackInfoToJson(info_);
          emitTick = true;
        }
      }
      if (pipeline_) pipeline_->stop();
      emitError(
          failureMessage.empty() ? "音频读取或渲染失败" : failureMessage,
          decodeError ? TAE_RESULT_INTERNAL_ERROR : TAE_RESULT_BACKEND_UNAVAILABLE,
          decodeError ? "decode" : "render");
      emit("end-file", "{\"reason\":\"error\"}");
      if (emitTick) emit("property-change", payload);
      continue;
    }
    if (trackStarted) {
      std::optional<QueueItem> upcoming;
      {
        std::lock_guard lock(mutex_);
        // Only this clock consumes natural promotions. Explicit next() consumes
        // its own start flag under the same transport lock and never counts EOF.
        // Same-source/same-index repeat is still a new natural boundary.
        recordNaturalBoundaryLocked();
        // Explicit next/play consume or clear their own promotion flag under
        // transportMutex_. Every remaining flag advances once, even when two
        // logical occurrences have identical ids, sources and CUE ranges.
        queue_.advanceAfterEnd();
        applyClockPipelineStatusLocked(pipelineStatus);
        info_.queueIndex = queue_.currentIndex();
        info_.playMode = queue_.playModeId();
        upcoming = queue_.upcoming();
        info_.hasUpcomingTrack = upcoming.has_value();
        info_.upcomingTrack = upcoming.value_or(QueueItem{});
        if (stateEvents) {
          payload = playbackInfoToJson(info_);
          emitTick = true;
        }
      }
      std::string preloadError;
      if (pipeline_) pipeline_->preloadNext(upcoming, &preloadError);
      if (emitTick) emit("property-change", payload);
      emit("start-file", "{}");
      // A very short promoted item can also drain before this clock sample.
      // Its consumed EOF flag must be handled below, not silently discarded.
      if (!emitEnded) continue;
    }
    std::optional<QueueItem> autoNextItem;
    bool releaseAtEnd = false;
    {
      std::lock_guard lock(mutex_);
      if (hasPipelineStatus && info_.state != PlaybackState::Stopped) {
        applyClockPipelineStatusLocked(pipelineStatus);
      }
      if (emitEnded) {
        recordNaturalBoundaryLocked();
        autoNextItem = queue_.advanceAfterEnd();
        if (autoNextItem && !autoNextItem->source.empty()) {
          info_.queueIndex = queue_.currentIndex();
          info_.playMode = queue_.playModeId();
          info_.source = autoNextItem->source;
          info_.durationSeconds = autoNextItem->durationSeconds;
          info_.positionSeconds = 0.0;
          info_.codec = inferCodec(autoNextItem->source);
          info_.hasUpcomingTrack = queue_.upcoming().has_value();
          info_.upcomingTrack = queue_.upcoming().value_or(QueueItem{});
        } else {
          releaseAtEnd = shouldReleaseOutputLocked();
          info_.state = PlaybackState::Stopped;
          if (info_.durationSeconds > 0.0) info_.positionSeconds = info_.durationSeconds;
        }
      }
      if (!autoNextItem &&
          (info_.state == PlaybackState::Playing || info_.state == PlaybackState::Paused || emitEnded)) {
        if (stateEvents) {
          payload = playbackInfoToJson(info_);
          emitTick = true;
        }
      }
    }
    if (autoNextItem && !autoNextItem->source.empty()) {
      // Prefer preloaded promote (no device stop/reopen), same as next().
      std::string promoteError;
      const bool usedPreload = pipeline_ && pipeline_->skipToPreloaded(*autoNextItem, &promoteError);
      if (usedPreload) {
        if (pipeline_) pipeline_->consumeTrackStarted(nullptr);
        std::optional<QueueItem> upcomingAfterPromote;
        {
          std::lock_guard lock(mutex_);
          upcomingAfterPromote = queue_.upcoming();
          info_.hasUpcomingTrack = upcomingAfterPromote.has_value();
          info_.upcomingTrack = upcomingAfterPromote.value_or(QueueItem{});
          applyPipelineStatusLocked(pipeline_->status());
          publishStateLocked();
        }
        std::string preloadError;
        if (pipeline_) pipeline_->preloadNext(upcomingAfterPromote, &preloadError);
        emit("start-file", "{}");
      } else {
        const TAE_Result result = playQueueItem(*autoNextItem, 0.0);
        if (result == TAE_RESULT_OK) {
          emit("start-file", "{}");
        } else {
          emit("end-file", "{\"reason\":\"error\"}");
        }
      }
      continue;
    }
    if (releaseAtEnd) {
      if (pipeline_) pipeline_->stop();
      std::lock_guard lock(mutex_);
      markOutputReleasedLocked();
      if (stateEvents) payload = playbackInfoToJson(info_);
    }
    if (emitTick) emit("property-change", payload);
    if (emitEnded) emit("end-file", "{\"reason\":\"eof\"}");
  }
}

void TwilightAudioEngine::emit(const char* type, const std::string& payload) const {
  TAE_EventCallback callback = eventCallback_;
  void* userData = eventUserData_;
  if (callback) callback(type, payload.c_str(), userData);
}

void TwilightAudioEngine::emitError(const std::string& message, TAE_Result code, const std::string& context) const {
  {
    std::lock_guard lock(errorMutex_);
    lastError_ = message;
    lastErrorCode_ = code;
    lastErrorContext_ = context.empty() ? "native" : context;
  }
  emit("error", "{\"code\":\"" + std::string(resultToString(code)) + "\",\"message\":\"" + json_utils::escape(message) +
                    "\",\"context\":\"" + json_utils::escape(lastErrorContext_) + "\"}");
}

void TwilightAudioEngine::publishStateLocked() const {
  if (!stateEventsEnabled_.load(std::memory_order_relaxed)) return;
  PlaybackInfo snapshot = info_;
  snapshot.queueRevision = queue_.queueRevision();
  snapshot.upcomingQueueIndex = queue_.upcomingIndex().value_or(-1);
  emit("playback-info", playbackInfoToJson(snapshot));
}

void TwilightAudioEngine::applyClockPipelineStatusLocked(const PipelineStatus& status) {
  // The clock snapshot can predate a completed pause/resume/stop command.
  // Commands and explicit terminal events own transport state; ticks refresh
  // progress and metadata without undoing their committed state.
  const PlaybackState committedState = info_.state;
  applyPipelineStatusLocked(status);
  info_.state = committedState;
}

void TwilightAudioEngine::applyPipelineStatusLocked(const PipelineStatus& status) {
  if (pausedOutputReleased_) {
    info_.requestedConfigRevision = status.requestedConfigRevision;
    info_.appliedConfigRevision = status.appliedConfigRevision;
    return;
  }
  switch (status.state) {
    case PipelineState::Playing:
      info_.state = PlaybackState::Playing;
      break;
    case PipelineState::Paused:
      info_.state = PlaybackState::Paused;
      break;
    case PipelineState::Stopped:
    default:
      info_.state = PlaybackState::Stopped;
      break;
  }

  info_.positionSeconds = status.positionSeconds;
  info_.requestedConfigRevision = status.requestedConfigRevision;
  info_.appliedConfigRevision = status.appliedConfigRevision;
  info_.durationSeconds = status.stream.durationSeconds;
  info_.source = status.stream.source.empty() ? info_.source : status.stream.source;
  info_.codec = status.stream.codec.empty() ? info_.codec : status.stream.codec;
  info_.bitrate = static_cast<int>(std::max<int64_t>(0, status.stream.bitrate));
  info_.sourceSampleRate = status.stream.sourceFormat.sampleRate;
  info_.sourceChannels = status.stream.sourceFormat.channelCount;
  info_.sourceBitDepth = status.stream.sourceFormat.bitDepth;
  info_.decodedSampleRate = status.stream.decodedFormat.sampleRate;
  info_.decodedBitDepth = status.stream.decodedFormat.bitDepth;
  info_.decodedChannels = status.stream.decodedFormat.channelCount;
  info_.decodedSampleFormat = sampleFormatToString(status.stream.decodedFormat.sampleFormat);
  info_.queueIndex = queue_.currentIndex();
  info_.playMode = queue_.playModeId();
  // While an output route transaction is pending, info_.outputBackend holds the
  // backend setOutputBackend accepted but setOutputConfig has not committed yet;
  // the running pipeline's backend must not overwrite it, or the commit would
  // reopen the old backend.
  if (!outputRoutePending_) {
    info_.outputBackend = status.backendId.empty() ? info_.outputBackend : status.backendId;
  }
  (void)status.deviceName;
  info_.outputSampleRate = status.outputFormat.sampleRate;
  info_.outputBitDepth = status.outputFormat.bitDepth;
  info_.outputInfo = status.outputInfo;
  if (info_.outputInfo.backend.empty()) info_.outputInfo.backend = info_.outputBackend;
  if (info_.outputInfo.actualBackend.empty()) info_.outputInfo.actualBackend = info_.outputInfo.backend;
  if (info_.outputInfo.deviceName.empty()) info_.outputInfo.deviceName = status.deviceName;
  if (info_.outputInfo.actualDeviceName.empty()) info_.outputInfo.actualDeviceName = info_.outputInfo.deviceName;
  if (info_.outputInfo.actualDriverName.empty()) info_.outputInfo.actualDriverName = info_.outputInfo.driverName;
  if (info_.outputInfo.actualDriverVersion == 0) info_.outputInfo.actualDriverVersion = info_.outputInfo.driverVersion;
  if (info_.outputInfo.outputSampleRate <= 0) info_.outputInfo.outputSampleRate = status.outputFormat.sampleRate;
  if (info_.outputInfo.outputBitDepth <= 0) info_.outputInfo.outputBitDepth = status.outputFormat.bitDepth;
  info_.outputInfo.sourceExact = status.sourceExact;
  info_.outputInfo.outputPerfect = status.outputPerfect;
  info_.outputInfo.pcmPassthrough = status.outputInfo.pcmPassthrough;
  const std::string nativePlugins = json_utils::fieldArray(status.nativeDspJson, "plugins");
  info_.outputInfo.nativeDspJson = "{\"plugins\":" +
                                    (nativePlugins.empty() ? "[]" : nativePlugins) +
                                    ",\"graph\":" +
                                    (status.dspGraphJson.empty()
                                         ? "{\"revision\":0,\"activeSceneId\":null,\"totalLatencyFrames\":0,\"totalTailFrames\":0,\"nodes\":[]}"
                                         : status.dspGraphJson) + "}";
  info_.outputInfo.isDsd = status.stream.isDsd;
  info_.outputInfo.dsdMode = status.stream.isDsd ? dsdModeToString(status.stream.dsdMode) : dsdModeToString(DsdMode::Pcm);
  info_.outputInfo.dsdRate = status.stream.isDsd ? status.stream.dsdRate : 0;
  if (info_.outputInfo.perfectReason.empty()) info_.outputInfo.perfectReason = status.perfectReason;
  info_.channelCount = status.outputFormat.channelCount;
  info_.dspActive = status.dspActive;
  info_.replayGainActive = status.replayGainActive;
  info_.loudnormActive = status.loudnormActive;
  info_.eqActive = status.eqActive;
  info_.convolverActive = status.convolverActive;
  info_.crossfeedActive = status.crossfeedActive;
  info_.crossfadeActive = status.crossfadeActive;
  info_.fftActive = status.fftActive;
  info_.irResampled = status.irResampled;
  info_.replayGainDb = status.replayGainDb;
  info_.crossfeedStrength = status.crossfeedStrength;
  info_.crossfadeSeconds = status.crossfadeSeconds;
  info_.crossfadeMixActive = status.crossfadeMixActive;
  info_.crossfadeEffectiveSeconds = status.crossfadeEffectiveSeconds;
  info_.crossfadeCurve = status.crossfadeCurve;
  info_.crossfadeBlockedReason = status.crossfadeBlockedReason;
  info_.autoMixMode = status.autoMixMode;
  info_.autoMixState = status.autoMixState;
  info_.autoMixDurationSeconds = status.autoMixDurationSeconds; info_.autoMixStemEnhanced = status.autoMixStemEnhanced;
  info_.autoMixDecodeMs = status.autoMixDecodeMs; info_.autoMixPrepareMs = status.autoMixPrepareMs;
  info_.autoMixReason = status.autoMixReason;
  info_.autoMixStrategy = status.autoMixStrategy;
  info_.autoMixPlanId = status.autoMixPlanId;
  info_.autoMixOutputSeconds = status.autoMixOutputSeconds;
  info_.autoMixNextSourceSeconds = status.autoMixNextSourceSeconds;
  info_.convolverLatencyFrames = status.convolverLatencyFrames;
  info_.partitionSize = status.partitionSize;
  info_.channelMappingMode = status.channelMappingMode;
  info_.gaplessActive = status.gaplessActive;
  info_.preloadReady = status.preloadReady;
  info_.gaplessBlockedReason = status.gaplessBlockedReason;
  const auto upcoming = queue_.upcoming();
  info_.hasUpcomingTrack = upcoming.has_value();
  info_.upcomingTrack = upcoming.value_or(QueueItem{});
  if (upcoming && status.preloadedItem && status.preloadReady &&
      upcoming->id == status.preloadedItem->id && upcoming->source == status.preloadedItem->source &&
      upcoming->cueStartSeconds == status.preloadedItem->cueStartSeconds &&
      upcoming->cueEndSeconds == status.preloadedItem->cueEndSeconds) {
    info_.upcomingTrack.durationSeconds = status.preloadedItem->durationSeconds;
  } else {
    info_.preloadReady = false;
  }
  info_.perfectReason = status.perfectReason;
  info_.streamTitle = status.stream.streamTitle;
  info_.isDsd = status.stream.isDsd;
  info_.dsdMode = status.stream.isDsd ? dsdModeToString(status.stream.dsdMode) : dsdModeToString(DsdMode::Pcm);
  info_.dsdRate = status.stream.isDsd ? status.stream.dsdRate : 0;
  normalizeOutputInfoMirror(info_);
}

void TwilightAudioEngine::updatePerfectLocked() {
  if (info_.outputInfo.outputReleased) {
    markOutputReleasedLocked();
    return;
  }
  if (info_.outputInfo.backend.empty()) info_.outputInfo.backend = info_.outputBackend;
  if (info_.outputInfo.actualBackend.empty()) info_.outputInfo.actualBackend = info_.outputInfo.backend;
  info_.outputInfo.channelRoutingMode = channelRoutingModeToString(outputConfig_.routingMode);
  if (info_.outputInfo.outputSampleRate <= 0) info_.outputInfo.outputSampleRate = info_.outputSampleRate;
  if (info_.outputInfo.outputBitDepth <= 0) info_.outputInfo.outputBitDepth = info_.outputBitDepth;

  AudioFormat sourceFormat;
  sourceFormat.sampleRate = info_.sourceSampleRate;
  sourceFormat.channelCount = info_.sourceChannels;
  sourceFormat.bitDepth = info_.sourceBitDepth;
  sourceFormat.sampleFormat = sampleFormatFromText("", sourceFormat.bitDepth);

  AudioFormat decodedFormat;
  decodedFormat.sampleRate = info_.decodedSampleRate > 0 ? info_.decodedSampleRate : info_.outputSampleRate;
  decodedFormat.channelCount =
      info_.decodedChannels > 0 ? info_.decodedChannels : (info_.channelCount > 0 ? info_.channelCount : info_.outputInfo.actualChannels);
  decodedFormat.bitDepth = info_.decodedBitDepth > 0 ? info_.decodedBitDepth : info_.outputBitDepth;
  decodedFormat.sampleFormat = sampleFormatFromText(info_.decodedSampleFormat, decodedFormat.bitDepth);

  AudioFormat outputFormat;
  outputFormat.sampleRate = info_.outputInfo.outputSampleRate;
  outputFormat.channelCount = info_.outputInfo.actualChannels > 0 ? info_.outputInfo.actualChannels : info_.channelCount;
  outputFormat.bitDepth =
      info_.outputInfo.actualBitDepth > 0 ? info_.outputInfo.actualBitDepth : info_.outputInfo.outputBitDepth;
  outputFormat.sampleFormat = sampleFormatFromText(info_.outputInfo.actualOutputFormat, outputFormat.bitDepth);

  const bool backendResampled = info_.outputInfo.resampled;
  const std::string backendPerfectReason =
      (!info_.outputInfo.supportsOutputPerfect || backendResampled) ? info_.outputInfo.perfectReason : "";
  PerfectEvaluation evaluation;
  evaluation.sourceFormat = sourceFormat;
  evaluation.decodedFormat = decodedFormat;
  evaluation.outputFormat = outputFormat;
  evaluation.sourceLossless = codecLooksLossless(info_.codec);
  evaluation.sourceDsd = info_.isDsd || info_.codec == "dsd";
  if (evaluation.sourceDsd) {
    evaluation.dsdMode = parseDsdMode(info_.dsdMode);
    evaluation.dsdRate = info_.dsdRate;
  }
  evaluation.supportsOutputPerfect = info_.outputInfo.supportsOutputPerfect;
  evaluation.backendResampled = backendResampled;
  evaluation.backendPerfectReasonCode = info_.outputInfo.perfectReasonCode;
  evaluation.backendPerfectReason = backendPerfectReason;
  evaluation.volume = info_.volume;
  evaluation.playbackRate = info_.playbackRate;
  evaluation.replayGainActive = info_.replayGainActive;
  evaluation.loudnormActive = info_.loudnormActive;
  evaluation.eqActive = info_.eqActive;
  evaluation.convolverActive = info_.convolverActive;
  evaluation.crossfeedActive = info_.crossfeedActive;
  evaluation.crossfadeActive = info_.crossfadeActive || dspConfig_.crossfadeSeconds > 0.0001;
  evaluation.routingMode = outputConfig_.routingMode;
  evaluation.pcmPassthrough = pcmFormatsExactMatch(decodedFormat, outputFormat) && !backendResampled;
  const PerfectResult result = evaluatePerfect(evaluation);
  info_.dspActive = result.processingActive;
  info_.outputInfo.sourceExact = result.sourceExact;
  info_.outputInfo.resampled = result.resampled;
  info_.outputInfo.outputPerfect = result.outputPerfect;
  info_.outputInfo.pcmPassthrough = result.pcmPassthrough;
  info_.outputInfo.isDsd = evaluation.sourceDsd;
  info_.outputInfo.dsdMode = evaluation.sourceDsd ? dsdModeToString(evaluation.dsdMode) : dsdModeToString(DsdMode::Pcm);
  info_.outputInfo.dsdRate = evaluation.sourceDsd ? evaluation.dsdRate : 0;
  info_.outputInfo.perfectReason = result.perfectReason;
  info_.outputInfo.perfectReasonCode = result.perfectReasonCode;
  info_.perfectReasonCode = result.perfectReasonCode;
  info_.perfectReason = result.perfectReason;
  normalizeOutputInfoMirror(info_);
}

bool TwilightAudioEngine::shouldReroutePipelineLocked(
    std::string* reason,
    double* position,
    PlaybackState* state) const {
  if (!pipeline_ || info_.state == PlaybackState::Stopped || pausedOutputReleased_) return false;
  const DspConfig& config = dspConfig_;
  if (info_.isDsd) {
    const bool wantsPcm = config.dsdOutputMode == DsdOutputMode::Pcm;
    const bool wantsNative = config.dsdOutputMode == DsdOutputMode::Auto ||
                             config.dsdOutputMode == DsdOutputMode::Native;
    const bool wantsDop = config.dsdOutputMode == DsdOutputMode::Auto || config.dsdOutputMode == DsdOutputMode::Dop ||
                          config.dsdOutputMode == DsdOutputMode::Native;
    const bool dopActive = pipeline_->isDopPathActive();
    const bool nativeActive = pipeline_->isNativeDsdPathActive();
    // Re-entering a DSD transport reopens the device. That only makes sense when
    // the current processing state would actually let the open path choose DSD;
    // the open path re-applies this very check, so restarting while it still
    // holds lands back in PCM. A DSD track parked in PCM fallback by the 70%
    // default software volume used to restart on every single volume tick.
    const bool processingForcesPcm = pipeline_->processingForcesDsdPcmFallback();
    if ((dopActive || nativeActive) && wantsPcm) {
      if (reason) {
        *reason = "DSD output mode forced PCM";
      }
      if (position) *position = info_.positionSeconds;
      if (state) *state = info_.state;
      return true;
    }
    if (nativeActive && config.dsdOutputMode == DsdOutputMode::Dop) {
      if (reason) *reason = "Re-enter DoP output mode";
      if (position) *position = info_.positionSeconds;
      if (state) *state = info_.state;
      return true;
    }
    if (!nativeActive && wantsNative && info_.dsdMode == "pcm" && !processingForcesPcm) {
      if (reason) *reason = "Re-enter Native DSD output mode";
      if (position) *position = info_.positionSeconds;
      if (state) *state = info_.state;
      return true;
    }
    if (!dopActive && !nativeActive && info_.dsdMode == "pcm" && wantsDop && !processingForcesPcm) {
      if (reason) *reason = "Re-enter DoP output mode";
      if (position) *position = info_.positionSeconds;
      if (state) *state = info_.state;
      return true;
    }
  }
  std::string fallbackReason;
  if (!pipeline_->needsPcmFallback(&fallbackReason)) return false;
  if (reason) *reason = std::move(fallbackReason);
  if (position) *position = info_.positionSeconds;
  if (state) *state = info_.state;
  return true;
}

TAE_Result TwilightAudioEngine::restartCurrentPlaybackForReroute(
    double positionSeconds,
    PlaybackState previousState,
    const std::string& reason,
    const std::string& context) {
  (void)context;
  std::string source;
  {
    std::lock_guard lock(mutex_);
    if (pausedOutputReleased_) return TAE_RESULT_OK;
    source = info_.source;
    if (pipeline_) pipeline_->setRerouteInProgress(true, reason);
  }
  if (source.empty()) return TAE_RESULT_OK;
  if (outputConfig_.usbPcmPassthrough && pipeline_->needsPcmFallback(nullptr)) {
    suspendUsbPcm("处理设置改变，USB 原样 PCM 已暂停；关闭此模式后可应用处理");
    return TAE_RESULT_OK;
  }

  const TAE_Result result = play(source, std::max(0.0, positionSeconds), previousState == PlaybackState::Paused);
  {
    std::lock_guard lock(mutex_);
    if (pipeline_) pipeline_->setRerouteInProgress(false);
  }
  if (result != TAE_RESULT_OK) return result;
  return TAE_RESULT_OK;
}

QueueItem TwilightAudioEngine::currentItemLocked() const {
  return queue_.current().value_or(QueueItem{});
}

}  // namespace twilight::audio

using twilight::audio::TwilightAudioEngine;

namespace {

TwilightAudioEngine* fromHandle(TAE_EngineHandle handle) {
  return static_cast<TwilightAudioEngine*>(handle);
}

TAE_Result copyStringResult(const std::string& value, char* buffer, size_t bufferSize, size_t* requiredSize) {
  const size_t required = value.size() + 1;
  if (requiredSize) *requiredSize = required;
  if (!buffer || bufferSize == 0) return TAE_RESULT_OK;
  if (bufferSize < required) return TAE_RESULT_INVALID_ARGUMENT;
  std::memcpy(buffer, value.c_str(), required);
  return TAE_RESULT_OK;
}

struct AnalysisProbeResult {
  TAE_EngineHandle engine = nullptr;
  std::string source;
  std::string options;
  std::string value;
};

using AnalysisFunction = std::string (*)(const std::string&, const std::string&);

thread_local AnalysisProbeResult bpmProbeResult;
thread_local AnalysisProbeResult loudnessProbeResult;
thread_local AnalysisProbeResult autoMixProbeResult;
std::atomic<uint64_t> bpmAnalysisExecutionCount{0};
std::atomic<uint64_t> loudnessAnalysisExecutionCount{0};
std::atomic<uint64_t> autoMixAnalysisExecutionCount{0};

TAE_Result analyzeWithProbeResult(
    TAE_EngineHandle engine,
    const char* source,
    const char* optionsJson,
    char* buffer,
    size_t bufferSize,
    size_t* requiredSize,
    AnalysisProbeResult* probe,
    std::atomic<uint64_t>* executionCount,
    AnalysisFunction analyze) {
  if (!engine || !source || !probe || !executionCount || !analyze) return TAE_RESULT_INVALID_ARGUMENT;
  const std::string normalizedSource(source);
  const std::string normalizedOptions = optionsJson ? optionsJson : "{}";
  const bool sizeProbe = !buffer || bufferSize == 0;
  if (sizeProbe) {
    executionCount->fetch_add(1, std::memory_order_relaxed);
    probe->engine = engine;
    probe->source = normalizedSource;
    probe->options = normalizedOptions;
    probe->value = analyze(normalizedSource, normalizedOptions);
    return copyStringResult(probe->value, buffer, bufferSize, requiredSize);
  }

  if (probe->engine == engine && probe->source == normalizedSource && probe->options == normalizedOptions) {
    const TAE_Result result = copyStringResult(probe->value, buffer, bufferSize, requiredSize);
    if (result == TAE_RESULT_OK) *probe = AnalysisProbeResult{};
    return result;
  }

  executionCount->fetch_add(1, std::memory_order_relaxed);
  return copyStringResult(
      analyze(normalizedSource, normalizedOptions), buffer, bufferSize, requiredSize);
}

enum class JsonGetter {
  None,
  AutoMixSelection,
  Queue,
  QueueState,
  UpcomingTrack,
  DspConfig,
  DspGraphStatus,
  ConvolverInfo,
  DspPluginStatus,
  Metadata,
  Devices,
  Backends,
  Capabilities,
  LastError,
  PlaybackInfo,
  DiagnosticLog,
  Visualization,
};

struct JsonProbeResult {
  TAE_EngineHandle engine = nullptr;
  JsonGetter getter = JsonGetter::None;
  std::string key;
  uint64_t cursor = 0;
  std::string value;
};

thread_local JsonProbeResult jsonProbeResult;

// Hosts size-probe with a NULL buffer and then fill, and each call used to
// serialize the state again under the engine lock (GetMetadata even reopened
// the file and base64-encoded the cover twice). The probe keeps its snapshot
// for this thread so the matching fill copies it instead of rebuilding it.
template <typename Produce>
TAE_Result copyJsonWithProbeResult(
    TAE_EngineHandle engine,
    JsonGetter getter,
    const std::string& key,
    char* buffer,
    size_t bufferSize,
    size_t* requiredSize,
    uint64_t* cursorOut,
    Produce&& produce) {
  const bool sizeProbe = !buffer || bufferSize == 0;
  JsonProbeResult current;
  current.engine = engine;
  current.getter = getter;
  current.key = key;
  JsonProbeResult& probe = jsonProbeResult;
  if (!sizeProbe && probe.engine == engine && probe.getter == getter && probe.key == key) {
    current.value = std::move(probe.value);
    current.cursor = probe.cursor;
  } else {
    current.value = produce(&current.cursor);
  }
  probe = JsonProbeResult{};
  if (cursorOut) *cursorOut = current.cursor;
  const TAE_Result result = copyStringResult(current.value, buffer, bufferSize, requiredSize);
  if (sizeProbe || result != TAE_RESULT_OK) probe = std::move(current);
  return result;
}

}  // namespace

extern "C" {

TAE_Result TAE_CreateEngine(TAE_EngineHandle* out_engine) {
  if (!out_engine) return TAE_RESULT_INVALID_ARGUMENT;
  try {
    *out_engine = new TwilightAudioEngine();
    return TAE_RESULT_OK;
  } catch (...) {
    *out_engine = nullptr;
    return TAE_RESULT_INTERNAL_ERROR;
  }
}

void TAE_DestroyEngine(TAE_EngineHandle engine) {
  if (jsonProbeResult.engine == engine) jsonProbeResult = JsonProbeResult{};
  if (bpmProbeResult.engine == engine) bpmProbeResult = AnalysisProbeResult{};
  if (loudnessProbeResult.engine == engine) loudnessProbeResult = AnalysisProbeResult{};
  if (autoMixProbeResult.engine == engine) autoMixProbeResult = AnalysisProbeResult{};
  delete fromHandle(engine);
}

TAE_Result TAE_SetEventCallback(TAE_EngineHandle engine, TAE_EventCallback callback, void* user_data) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  fromHandle(engine)->setEventCallback(callback, user_data);
  return TAE_RESULT_OK;
}

TAE_Result TAE_SetStateEventsEnabled(TAE_EngineHandle engine, int enabled) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  fromHandle(engine)->setStateEventsEnabled(enabled != 0);
  return TAE_RESULT_OK;
}

TAE_Result TAE_SetUsbPcmPolicy(TAE_EngineHandle engine, const TAE_UsbPcmCallbacks* callbacks, void* user_data) {
  if (!engine || !callbacks || !callbacks->acquire || !callbacks->valid || !callbacks->release) return TAE_RESULT_INVALID_ARGUMENT;
  const auto cb = *callbacks;
  auto policy = std::make_shared<twilight::audio::UsbPcmPolicy>();
  policy->acquire = [cb, user_data](const std::string& device, const twilight::audio::AudioFormat& format, std::string* error) {
    char message[1024]{};
    int id = cb.acquire(device.c_str(), format.sampleRate, format.channelCount,
        twilight::audio::sampleFormatToString(format.sampleFormat).c_str(), message, sizeof(message), user_data);
    if (id <= 0 && error) *error = message[0] ? message : "USB 原样 PCM 偏好未被接受";
    return id;
  };
  policy->valid = [cb, user_data] { return cb.valid(user_data) != 0; };
  policy->release = [cb, user_data] { cb.release(user_data); };
  fromHandle(engine)->setUsbPcmPolicy(std::move(policy));
  return TAE_RESULT_OK;
}

TAE_Result TAE_SetInputProvider(TAE_EngineHandle engine, const TAE_InputCallbacks* callbacks, void* user_data) {
  if (!engine || !callbacks || !callbacks->open || !callbacks->size || !callbacks->read_at ||
      !callbacks->cancel || !callbacks->close) return TAE_RESULT_INVALID_ARGUMENT;
  struct CallbackInput final : twilight::audio::SeekableInput {
    TAE_InputCallbacks callbacks;
    void* stream;
    CallbackInput(TAE_InputCallbacks cb, void* s) : callbacks(cb), stream(s) {}
    ~CallbackInput() override { callbacks.close(stream); }
    int64_t size() override { return callbacks.size(stream); }
    int readAt(int64_t position, uint8_t* bytes, int count) override { return callbacks.read_at(stream, position, bytes, count); }
    void cancel() override { callbacks.cancel(stream); }
  };
  auto factory = std::make_shared<const twilight::audio::SeekableInputFactory>(
      [cb = *callbacks, user_data](const std::string& source) -> std::shared_ptr<twilight::audio::SeekableInput> {
        void* stream = cb.open(source.c_str(), user_data);
        return stream ? std::make_shared<CallbackInput>(cb, stream) : nullptr;
      });
  fromHandle(engine)->setInputFactory(std::move(factory));
  return TAE_RESULT_OK;
}

TAE_Result TAE_Play(TAE_EngineHandle engine, const char* source, double start_time_seconds) {
  if (!engine || !source) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->play(source, start_time_seconds);
}

TAE_Result TAE_Load(TAE_EngineHandle engine, const char* source, double start_time_seconds) {
  if (!engine || !source) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->play(source, start_time_seconds, true);
}

TAE_Result TAE_Pause(TAE_EngineHandle engine) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->pause();
}

TAE_Result TAE_SetPaused(TAE_EngineHandle engine, int paused) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setPaused(paused != 0);
}

TAE_Result TAE_Stop(TAE_EngineHandle engine) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->stop();
}

TAE_Result TAE_Seek(TAE_EngineHandle engine, double position_seconds) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->seek(position_seconds);
}

TAE_Result TAE_SetVolume(TAE_EngineHandle engine, double volume) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setVolume(volume);
}

TAE_Result TAE_SetPlaybackRate(TAE_EngineHandle engine, double rate) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setPlaybackRate(rate);
}
TAE_Result TAE_SetAutoMixMode(TAE_EngineHandle engine, const char* mode) {
  if (!engine || !mode) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->setAutoMixMode(mode);
}
TAE_Result TAE_SelectAutoMix(TAE_EngineHandle engine, const char* json,
    char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine || !json) return TAE_RESULT_INVALID_ARGUMENT;
  return copyJsonWithProbeResult(engine, JsonGetter::AutoMixSelection, json, buffer, buffer_size,
      required_size, nullptr, [&](uint64_t*) { return fromHandle(engine)->selectAutoMix(json); });
}
TAE_Result TAE_PrepareAutoMix(TAE_EngineHandle engine, const char* json) {
  if (!engine || !json) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->prepareAutoMix(json);
}
TAE_Result TAE_SubmitAutoMix(TAE_EngineHandle engine, uint64_t id) {
  if (!engine || !id) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->submitAutoMix(id);
}
TAE_Result TAE_CancelAutoMix(TAE_EngineHandle engine) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->cancelAutoMix();
}

TAE_Result TAE_SetLoopRange(TAE_EngineHandle engine, double start_seconds, double end_seconds) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setLoopRange(start_seconds, end_seconds);
}

TAE_Result TAE_SetOutputDevice(TAE_EngineHandle engine, const char* device_id) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setOutputDevice(device_id ? device_id : "auto");
}

TAE_Result TAE_SetOutputBackend(TAE_EngineHandle engine, const char* backend_id) {
  if (!engine || !backend_id) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->setOutputBackend(backend_id);
}

TAE_Result TAE_LoadQueue(TAE_EngineHandle engine, const char* queue_json, int start_index) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->loadQueue(queue_json ? queue_json : "[]", start_index);
}

TAE_Result TAE_RebindQueue(TAE_EngineHandle engine, const char* queue_json, int start_index,
                          const char* mode, const char* expected_item_json,
                          int expected_index, int* out_applied) {
  if (out_applied) *out_applied = 0;
  if (!engine || !queue_json || !mode || !expected_item_json || !out_applied)
    return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->rebindQueue(queue_json, start_index, mode, expected_item_json,
                                        expected_index, out_applied);
}

TAE_Result TAE_AppendQueueItems(
    TAE_EngineHandle engine,
    const char* items_json,
    int* out_first_index) {
  if (!engine || !items_json) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->appendQueueItems(items_json, out_first_index);
}

TAE_Result TAE_UpdateQueueItemSource(
    TAE_EngineHandle engine,
    int index,
    const char* source) {
  if (!engine || !source || index < 0) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->updateQueueItemSource(index, source);
}

TAE_Result TAE_GetQueueState(
    TAE_EngineHandle engine,
    char* buffer,
    size_t buffer_size,
    size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyJsonWithProbeResult(
      engine, JsonGetter::QueueState, {}, buffer, buffer_size, required_size, nullptr,
      [engine](uint64_t*) {
        return fromHandle(engine)->getQueueStateJson();
      });
}

TAE_Result TAE_SelectQueueIndex(TAE_EngineHandle engine, int index) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->selectQueueIndex(index);
}

TAE_Result TAE_Next(TAE_EngineHandle engine) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->next();
}

TAE_Result TAE_Previous(TAE_EngineHandle engine) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->previous();
}

TAE_Result TAE_SetPlayMode(TAE_EngineHandle engine, const char* mode) {
  if (!engine || !mode) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->setPlayMode(mode);
}

TAE_Result TAE_GetQueue(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyJsonWithProbeResult(
      engine, JsonGetter::Queue, {}, buffer, buffer_size, required_size, nullptr, [engine](uint64_t*) {
        return fromHandle(engine)->getQueueJson();
      });
}

TAE_Result TAE_GetUpcomingTrack(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyJsonWithProbeResult(
      engine, JsonGetter::UpcomingTrack, {}, buffer, buffer_size, required_size, nullptr, [engine](uint64_t*) {
        return fromHandle(engine)->getUpcomingTrackJson();
      });
}

TAE_Result TAE_SetDspConfig(TAE_EngineHandle engine, const char* dsp_config_json) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setDspConfig(dsp_config_json ? dsp_config_json : "{}");
}

TAE_Result TAE_SetDspGraph(TAE_EngineHandle engine, const char* dsp_graph_json) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setDspGraph(dsp_graph_json ? dsp_graph_json : "{\"graph\":{\"nodes\":[]}}");
}

TAE_Result TAE_ApplyDspState(
    TAE_EngineHandle engine,
    uint64_t revision,
    const char* dsp_state_json) {
  if (!engine || !dsp_state_json || revision == 0) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->applyDspState(revision, dsp_state_json);
}

TAE_Result TAE_SetOutputConfig(TAE_EngineHandle engine, const char* output_config_json) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setOutputConfig(output_config_json ? output_config_json : "{}");
}

TAE_Result TAE_GetDspConfig(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyJsonWithProbeResult(
      engine, JsonGetter::DspConfig, {}, buffer, buffer_size, required_size, nullptr, [engine](uint64_t*) {
        return fromHandle(engine)->getDspConfig();
      });
}

TAE_Result TAE_GetDspGraphStatus(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyJsonWithProbeResult(
      engine, JsonGetter::DspGraphStatus, {}, buffer, buffer_size, required_size, nullptr, [engine](uint64_t*) {
        return fromHandle(engine)->getDspGraphStatusJson();
      });
}

TAE_Result TAE_LoadImpulseResponse(TAE_EngineHandle engine, const char* path) {
  if (!engine || !path) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->loadImpulseResponse(path);
}

TAE_Result TAE_UnloadImpulseResponse(TAE_EngineHandle engine) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->unloadImpulseResponse();
}

TAE_Result TAE_GetConvolverInfo(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyJsonWithProbeResult(
      engine, JsonGetter::ConvolverInfo, {}, buffer, buffer_size, required_size, nullptr, [engine](uint64_t*) {
        return fromHandle(engine)->getConvolverInfoJson();
      });
}

TAE_Result TAE_SetEqBands(TAE_EngineHandle engine, const char* eq_json) {
  if (!engine || !eq_json) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->setEqBands(eq_json);
}

TAE_Result TAE_SetEqPreset(TAE_EngineHandle engine, const char* preset_json) {
  if (!engine || !preset_json) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->setEqPreset(preset_json);
}

TAE_Result TAE_SetCrossfeedStrength(TAE_EngineHandle engine, double strength) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setCrossfeedStrength(strength);
}

TAE_Result TAE_SetReplayGainMode(
    TAE_EngineHandle engine,
    const char* mode,
    double preamp_db,
    double fallback_db,
    int clip) {
  if (!engine || !mode) return TAE_RESULT_INVALID_ARGUMENT;
  return fromHandle(engine)->setReplayGainMode(mode, preamp_db, fallback_db, clip != 0);
}

TAE_Result TAE_SetDspPluginChain(TAE_EngineHandle engine, const char* chain_json) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return fromHandle(engine)->setNativeDspPluginChain(chain_json ? chain_json : "{\"plugins\":[]}");
}

TAE_Result TAE_GetDspPluginStatus(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyJsonWithProbeResult(
      engine, JsonGetter::DspPluginStatus, {}, buffer, buffer_size, required_size, nullptr, [engine](uint64_t*) {
        return fromHandle(engine)->getNativeDspPluginStatusJson();
      });
}

TAE_Result TAE_GetMetadata(
    TAE_EngineHandle engine,
    const char* source,
    char* buffer,
    size_t buffer_size,
    size_t* required_size) {
  if (!engine || !source) return TAE_RESULT_INVALID_ARGUMENT;
  return copyJsonWithProbeResult(
      engine, JsonGetter::Metadata, source, buffer, buffer_size, required_size, nullptr, [engine, source](uint64_t*) {
        return fromHandle(engine)->getMetadataJson(source);
      });
}

TAE_Result TAE_EnumerateDevices(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyJsonWithProbeResult(
      engine, JsonGetter::Devices, {}, buffer, buffer_size, required_size, nullptr, [engine](uint64_t*) {
        return fromHandle(engine)->enumerateDevicesJson();
      });
}

TAE_Result TAE_EnumerateBackends(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyJsonWithProbeResult(
      engine, JsonGetter::Backends, {}, buffer, buffer_size, required_size, nullptr, [engine](uint64_t*) {
        return fromHandle(engine)->enumerateBackendsJson();
      });
}

TAE_Result TAE_GetEngineCapabilities(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyJsonWithProbeResult(
      engine, JsonGetter::Capabilities, {}, buffer, buffer_size, required_size, nullptr, [engine](uint64_t*) {
        return fromHandle(engine)->engineCapabilitiesJson();
      });
}

TAE_Result TAE_GetLastError(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyJsonWithProbeResult(
      engine, JsonGetter::LastError, {}, buffer, buffer_size, required_size, nullptr, [engine](uint64_t*) {
        return fromHandle(engine)->getLastErrorJson();
      });
}

TAE_Result TAE_GetPlaybackInfo(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyJsonWithProbeResult(
      engine, JsonGetter::PlaybackInfo, {}, buffer, buffer_size, required_size, nullptr, [engine](uint64_t*) {
        return fromHandle(engine)->getPlaybackInfoJson();
      });
}

TAE_Result TAE_GetDiagnosticLog(
    TAE_EngineHandle engine,
    uint64_t since_sequence,
    size_t max_entries,
    char* buffer,
    size_t buffer_size,
    size_t* required_size,
    uint64_t* next_sequence) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return copyJsonWithProbeResult(
      engine,
      JsonGetter::DiagnosticLog,
      std::to_string(since_sequence) + ":" + std::to_string(max_entries),
      buffer,
      buffer_size,
      required_size,
      next_sequence,
      [since_sequence, max_entries](uint64_t* cursor) {
        return twilight::audio::DiagnosticLog::instance().toJson(since_sequence, max_entries, cursor);
      });
}

TAE_Result TAE_GetSpectrumData(TAE_EngineHandle engine, float* buffer, size_t point_count, size_t* written_count) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  const size_t written = fromHandle(engine)->getSpectrumData(buffer, point_count);
  if (written_count) *written_count = written;
  return TAE_RESULT_OK;
}

TAE_Result TAE_SetVisualizationDemand(TAE_EngineHandle engine, int enabled) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  fromHandle(engine)->setVisualizationDemand(enabled != 0);
  return TAE_RESULT_OK;
}

TAE_Result TAE_GetVisualizationData(
    TAE_EngineHandle engine,
    const char* options_json,
    char* buffer,
    size_t buffer_size,
    size_t* required_size) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  const std::string options = options_json ? options_json : "{}";
  return copyJsonWithProbeResult(
      engine,
      JsonGetter::Visualization,
      options,
      buffer,
      buffer_size,
      required_size,
      nullptr,
      [engine, &options](uint64_t*) { return fromHandle(engine)->getVisualizationDataJson(options); });
}

TAE_Result TAE_AnalyzeBpm(
    TAE_EngineHandle engine,
    const char* source,
    const char* options_json,
    char* buffer,
    size_t buffer_size,
    size_t* required_size) {
  return analyzeWithProbeResult(
      engine,
      source,
      options_json,
      buffer,
      buffer_size,
      required_size,
      &bpmProbeResult,
      &bpmAnalysisExecutionCount,
      twilight::audio::analyzeBpmJson);
}

TAE_Result TAE_AnalyzeLoudness(
    TAE_EngineHandle engine,
    const char* source,
    const char* options_json,
    char* buffer,
    size_t buffer_size,
    size_t* required_size) {
  return analyzeWithProbeResult(
      engine,
      source,
      options_json,
      buffer,
      buffer_size,
      required_size,
      &loudnessProbeResult,
      &loudnessAnalysisExecutionCount,
      twilight::audio::analyzeLoudnessJson);
}

TAE_Result TAE_AnalyzeAutoMix(TAE_EngineHandle engine, const char* source,
    const char* options_json, char* buffer, size_t buffer_size, size_t* required_size) {
  return analyzeWithProbeResult(engine, source, options_json, buffer, buffer_size,
      required_size, &autoMixProbeResult, &autoMixAnalysisExecutionCount,
      twilight::audio::analyzeAutoMixJson);
}

uint64_t TAE_GetAnalysisExecutionCount(const char* analysis_kind) {
  if (!analysis_kind) return 0;
  const std::string kind(analysis_kind);
  if (kind == "bpm") return bpmAnalysisExecutionCount.load(std::memory_order_relaxed);
  if (kind == "loudness") return loudnessAnalysisExecutionCount.load(std::memory_order_relaxed);
  if (kind == "automix") return autoMixAnalysisExecutionCount.load(std::memory_order_relaxed);
  return 0;
}

const char* TAE_GetVersion(void) {
  return "0.1.0";
}

void TAE_SetDiagnosticContext(const char* context_json) {
  twilight::audio::DiagnosticLog::setContext(context_json ? context_json : "{}");
}

}  // extern "C"
