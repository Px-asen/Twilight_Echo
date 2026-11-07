#include "../../include/twilight_audio_engine.h"
#include "../../core/TwilightAudioEngine.h"
#include "../OutputBackendFactory.h"
#include "BridgeReceiver.h"
#include <cstring>

using namespace twilight::audio;
extern "C" {
TAE_Result TAE_PullBridgePcm(TAE_EngineHandle engine, float* data, size_t frames, TAE_BridgePcmInfo* info) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return static_cast<TwilightAudioEngine*>(engine)->pullBridgePcm(data, frames, info);
}
TAE_Result TAE_PullBridgePcmTimeline(TAE_EngineHandle engine, float* data, size_t frames,
    TAE_BridgePcmInfo* info, char* timeline, size_t capacity) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return static_cast<TwilightAudioEngine*>(engine)->pullBridgePcmTimeline(data, frames, info, timeline, capacity);
}
TAE_Result TAE_PullBridgeAudio(TAE_EngineHandle engine, void* data, size_t capacity, size_t frames, TAE_BridgeAudioInfo* info) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return static_cast<TwilightAudioEngine*>(engine)->pullBridgeAudio(data, capacity, frames, info);
}
TAE_Result TAE_SetBridgeQueueControl(TAE_EngineHandle engine, int owned, const char* current, const char* next) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return static_cast<TwilightAudioEngine*>(engine)->setBridgeQueueControl(owned != 0, current ? current : "", next ? next : "");
}
TAE_Result TAE_CommitBridgeSourceControls(TAE_EngineHandle engine) {
  if (!engine) return TAE_RESULT_NOT_INITIALIZED;
  return static_cast<TwilightAudioEngine*>(engine)->commitBridgeSourceControls();
}
TAE_Result TAE_SetBridgeAutoMixMode(TAE_EngineHandle engine, const char* mode) {
  if (!engine || !mode) return TAE_RESULT_INVALID_ARGUMENT;
  return static_cast<TwilightAudioEngine*>(engine)->setBridgeAutoMixMode(mode);
}
TAE_Result TAE_OpenBridgeStreamReceiver(const char* backend, const char* device, int rate, int channels,
    int wire, uint64_t mask, TAE_BridgeReceiverHandle* handle, char* error, size_t errorSize) {
  if (!handle || !backend || !device || std::string(backend).rfind("bridge-", 0) == 0) return TAE_RESULT_INVALID_ARGUMENT;
  *handle = nullptr;
  auto receiver = std::make_unique<BridgeReceiver>();
  std::string message;
  if (!receiver->open(createOutputBackend(backend, &message), device, rate, channels, &message,
      static_cast<BridgeWireFormat>(wire), mask, true)) {
    if (error && errorSize) { const auto n = std::min(message.size(), errorSize-1); std::memcpy(error, message.data(), n); error[n] = 0; }
    return TAE_RESULT_BACKEND_UNAVAILABLE;
  }
  *handle = receiver.release(); return TAE_RESULT_OK;
}
TAE_Result TAE_WriteBridgeAudio(TAE_BridgeReceiverHandle receiver, const void* data, size_t bytes) {
  if (!receiver) return TAE_RESULT_NOT_INITIALIZED;
  return static_cast<BridgeReceiver*>(receiver)->writeAudio(static_cast<const uint8_t*>(data), bytes, nullptr) ? TAE_RESULT_OK : TAE_RESULT_INVALID_ARGUMENT;
}
TAE_Result TAE_OpenBridgeReceiver(const char* backend, const char* device, int rate, int channels,
    TAE_BridgeReceiverHandle* handle, char* error, size_t errorSize) {
  if (!handle || !backend || !device || std::string(backend).rfind("bridge-", 0) == 0) return TAE_RESULT_INVALID_ARGUMENT;
  *handle = nullptr;
  auto receiver = std::make_unique<BridgeReceiver>();
  std::string message;
  if (!receiver->open(createOutputBackend(backend, &message), device, rate, channels, &message)) {
    if (error && errorSize) { const size_t n = std::min(message.size(), errorSize - 1);
      std::memcpy(error, message.data(), n); error[n] = 0; }
    return TAE_RESULT_BACKEND_UNAVAILABLE;
  }
  *handle = receiver.release();
  return TAE_RESULT_OK;
}
TAE_Result TAE_WriteBridgePcm(TAE_BridgeReceiverHandle receiver, const float* data, size_t frames) {
  if (!receiver) return TAE_RESULT_NOT_INITIALIZED;
  if (!static_cast<BridgeReceiver*>(receiver)->acceptsLegacyPcm()) return TAE_RESULT_INVALID_ARGUMENT;
  return static_cast<BridgeReceiver*>(receiver)->write(data, frames, nullptr) ? TAE_RESULT_OK : TAE_RESULT_INVALID_ARGUMENT;
}
TAE_Result TAE_StartBridgeReceiver(TAE_BridgeReceiverHandle receiver) {
  if (!receiver) return TAE_RESULT_NOT_INITIALIZED;
  return static_cast<BridgeReceiver*>(receiver)->start(nullptr) ? TAE_RESULT_OK : TAE_RESULT_BACKEND_UNAVAILABLE;
}
TAE_Result TAE_PrepareBridgeTimedReceiver(TAE_BridgeReceiverHandle receiver) {
  if (!receiver) return TAE_RESULT_NOT_INITIALIZED;
  return static_cast<BridgeReceiver*>(receiver)->prepareTimed(nullptr) ? TAE_RESULT_OK : TAE_RESULT_BACKEND_UNAVAILABLE;
}
TAE_Result TAE_PrepareBridgeAdaptiveReceiver(TAE_BridgeReceiverHandle receiver) {
  if (!receiver) return TAE_RESULT_NOT_INITIALIZED;
  return static_cast<BridgeReceiver*>(receiver)->prepareAdaptiveTimed(nullptr) ? TAE_RESULT_OK : TAE_RESULT_BACKEND_UNAVAILABLE;
}
TAE_Result TAE_SetBridgeTimedCorrection(TAE_BridgeReceiverHandle receiver, double ppm, uint64_t generation) {
  if (!receiver) return TAE_RESULT_NOT_INITIALIZED;
  return static_cast<BridgeReceiver*>(receiver)->setTimedCorrection(ppm, generation, nullptr) ? TAE_RESULT_OK : TAE_RESULT_INVALID_ARGUMENT;
}
TAE_Result TAE_ArmBridgeTimedReceiver(TAE_BridgeReceiverHandle receiver, double time, uint64_t generation, uint64_t frame) {
  if (!receiver) return TAE_RESULT_NOT_INITIALIZED;
  return static_cast<BridgeReceiver*>(receiver)->armTimed(time, generation, frame, nullptr) ? TAE_RESULT_OK : TAE_RESULT_INVALID_ARGUMENT;
}
TAE_Result TAE_EndBridgeTimedReceiver(TAE_BridgeReceiverHandle receiver) {
  if (!receiver) return TAE_RESULT_NOT_INITIALIZED;
  return static_cast<BridgeReceiver*>(receiver)->endTimed(nullptr) ? TAE_RESULT_OK : TAE_RESULT_INVALID_ARGUMENT;
}
TAE_Result TAE_GetBridgeReceiverInfo(TAE_BridgeReceiverHandle receiver, char* buffer, size_t capacity, size_t* required) {
  if (!receiver || !required) return TAE_RESULT_INVALID_ARGUMENT;
  const auto json = static_cast<BridgeReceiver*>(receiver)->status();
  *required = json.size() + 1;
  if (buffer && capacity >= *required) std::memcpy(buffer, json.c_str(), *required);
  return TAE_RESULT_OK;
}
void TAE_CloseBridgeReceiver(TAE_BridgeReceiverHandle receiver) { delete static_cast<BridgeReceiver*>(receiver); }
}
