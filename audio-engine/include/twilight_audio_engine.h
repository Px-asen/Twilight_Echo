#pragma once

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#  if defined(TAE_BUILDING_LIBRARY)
#    define TAE_API __declspec(dllexport)
#  else
#    define TAE_API __declspec(dllimport)
#  endif
#else
#  define TAE_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef void* TAE_EngineHandle;

/** Post-DSP PCM pull. Control/network thread only; never call concurrently
 * with destruction. Frames are interleaved Float32, little endian on the wire. */
typedef struct TAE_BridgePcmInfo {
  uint64_t generation;
  uint32_t sample_rate;
  uint32_t channels;
  uint32_t frames;
  int playing;
} TAE_BridgePcmInfo;
/** v2 wire codes: 1=float32 LE, 2=DoP packed int24 LE, 3/4/5=DSD LSB/MSB/NER8.
 * DSD sample_rate is bits/s, frames are interleaved bytes per channel. */
typedef struct TAE_BridgeAudioInfo {
  TAE_BridgePcmInfo pcm;
  uint32_t wire_format;
  uint64_t channel_mask;
  uint32_t bytes;
} TAE_BridgeAudioInfo;
typedef void* TAE_BridgeReceiverHandle;

typedef enum TAE_Result {
  TAE_RESULT_OK = 0,
  TAE_RESULT_INVALID_ARGUMENT = 1,
  TAE_RESULT_NOT_INITIALIZED = 2,
  TAE_RESULT_BACKEND_UNAVAILABLE = 3,
  TAE_RESULT_INTERNAL_ERROR = 4
} TAE_Result;

typedef void (*TAE_EventCallback)(const char* event_type, const char* payload_json, void* user_data);

/*
 * JSON getters (buffer, buffer_size, required_size) follow a probe/fill
 * protocol: a call with a NULL buffer (or one too small) reports the required
 * size and keeps that serialized snapshot for the calling thread; the next
 * getter call on the same thread with the same arguments and a large enough
 * buffer receives exactly that snapshot instead of serializing again. Any
 * other getter call on that thread discards the kept snapshot.
 */
TAE_API TAE_Result TAE_CreateEngine(TAE_EngineHandle* out_engine);
TAE_API void TAE_DestroyEngine(TAE_EngineHandle engine);
TAE_API TAE_Result TAE_PullBridgePcm(TAE_EngineHandle engine, float* data, size_t frames, TAE_BridgePcmInfo* info);
/** Atomic PCM + private source-timeline observation. The JSON contains an
 * occurrence ID (legacy IDs can contain paths). Never send it to a peer.
 * Existing PCM callers keep the old ABI. */
TAE_API TAE_Result TAE_PullBridgePcmTimeline(TAE_EngineHandle engine, float* data, size_t frames,
    TAE_BridgePcmInfo* info, char* timeline, size_t timeline_capacity);
/** Private sync-group lease. owned=1 with empty IDs holds promotion; matching
 * current/next IDs authorize exactly one preloaded promotion. owned=0 restores
 * local gapless/crossfade policy without changing saved DSP preferences. */
TAE_API TAE_Result TAE_SetBridgeQueueControl(TAE_EngineHandle engine, int owned,
    const char* current_entry, const char* next_entry);
/** Apply queued controls before the first captured PCM frame. Group-only;
 * the audio service must hold network media until this source setup is done. */
TAE_API TAE_Result TAE_CommitBridgeSourceControls(TAE_EngineHandle engine);
/** Group-scoped effective mode. Releasing the queue lease restores the latest
 * local SetAutoMixMode preference without persisting the group's mode there. */
TAE_API TAE_Result TAE_SetBridgeAutoMixMode(TAE_EngineHandle engine, const char* mode);
TAE_API TAE_Result TAE_PullBridgeAudio(TAE_EngineHandle engine, void* data, size_t capacity, size_t frames, TAE_BridgeAudioInfo* info);
TAE_API TAE_Result TAE_OpenBridgeStreamReceiver(const char* backend, const char* device, int rate, int channels,
    int wire_format, uint64_t channel_mask, TAE_BridgeReceiverHandle* receiver, char* error, size_t error_size);
TAE_API TAE_Result TAE_WriteBridgeAudio(TAE_BridgeReceiverHandle receiver, const void* data, size_t bytes);
/** Receiver bypasses decoder, user DSP and saved local routing. Explicit device
 * required; it never retries another backend or default speakers. */
TAE_API TAE_Result TAE_OpenBridgeReceiver(const char* backend, const char* device, int rate, int channels,
    TAE_BridgeReceiverHandle* receiver, char* error, size_t error_size);
TAE_API TAE_Result TAE_WriteBridgePcm(TAE_BridgeReceiverHandle receiver, const float* data, size_t frames);
TAE_API TAE_Result TAE_StartBridgeReceiver(TAE_BridgeReceiverHandle receiver);
/** Opt-in timed PCM. Prepare a fresh receiver (silent device preroll), write
 * media, then arm using this host's native monotonic milliseconds and the
 * streamGeneration from GetInfo. Close cancels and joins; no automatic replay. */
TAE_API TAE_Result TAE_PrepareBridgeTimedReceiver(TAE_BridgeReceiverHandle receiver);
/** Separate opt-in lane: band-limited clock-adaptive PCM. Positive ppm expands
 * output for a fast device. Corrections require the current stream generation;
 * already buffered output keeps its original source-media coordinates. */
TAE_API TAE_Result TAE_PrepareBridgeAdaptiveReceiver(TAE_BridgeReceiverHandle receiver);
TAE_API TAE_Result TAE_SetBridgeTimedCorrection(TAE_BridgeReceiverHandle receiver, double output_rate_ppm,
    uint64_t expected_generation);
TAE_API TAE_Result TAE_ArmBridgeTimedReceiver(TAE_BridgeReceiverHandle receiver, double start_at_ms,
    uint64_t expected_generation, uint64_t media_frame);
TAE_API TAE_Result TAE_EndBridgeTimedReceiver(TAE_BridgeReceiverHandle receiver);
TAE_API TAE_Result TAE_GetBridgeReceiverInfo(TAE_BridgeReceiverHandle receiver, char* buffer, size_t capacity, size_t* required);
TAE_API void TAE_CloseBridgeReceiver(TAE_BridgeReceiverHandle receiver);
TAE_API TAE_Result TAE_SetEventCallback(TAE_EngineHandle engine, TAE_EventCallback callback, void* user_data);
/**
 * Playback snapshot events ("property-change" clock ticks and "playback-info")
 * serialize the whole playback state. They are on by default; a host that
 * polls TAE_GetPlaybackInfo instead passes enabled = 0 so the engine skips
 * building them. "error", "config-applied", "start-file", "end-file" and
 * "queue-change" are delivered either way.
 */
TAE_API TAE_Result TAE_SetStateEventsEnabled(TAE_EngineHandle engine, int enabled);

/** Optional host input, installed before playback. open returns a fresh stream or
 * NULL to use ordinary native file/protocol IO. read_at returns bytes, 0 EOF or
 * a negative error. size/read_at/close run off the realtime thread; cancel may
 * race with reads and must promptly unblock them. Callbacks and user_data must
 * remain valid until engine destruction AND all open streams have closed. */
typedef struct TAE_InputCallbacks {
  void* (*open)(const char* source, void* user_data);
  int64_t (*size)(void* stream);
  int (*read_at)(void* stream, int64_t position, uint8_t* bytes, int count);
  void (*cancel)(void* stream);
  void (*close)(void* stream);
} TAE_InputCallbacks;
TAE_API TAE_Result TAE_SetInputProvider(TAE_EngineHandle engine, const TAE_InputCallbacks* callbacks, void* user_data);
/** V2 keeps the original ABI intact. local_path copies a complete local backing
 * file path into buffer (NUL terminated), or returns 0 when identity is unknown.
 * It is optional; its path must stay valid until close(stream).
 * local_fd optionally returns a borrowed POSIX descriptor for the complete
 * regular backing file, or -1. It must remain open through cancel until close.
 * No permission to reopen that file by path is required. */
typedef struct TAE_InputCallbacksV2 {
  TAE_InputCallbacks input;
  int (*local_path)(void* stream, char* buffer, size_t capacity);
  int (*local_fd)(void* stream);
} TAE_InputCallbacksV2;
TAE_API TAE_Result TAE_SetInputProviderV2(TAE_EngineHandle engine, const TAE_InputCallbacksV2* callbacks, void* user_data);

/** Android host policy, installed once before playback. Callbacks run on non-RT threads;
 * user_data must outlive the engine. acquire returns the exact positive Android device ID.
 * Errors go to the supplied UTF-8 buffer. No callback may re-enter this engine.
 * release returns nonzero only after this session's preference is gone. Zero retains
 * ownership and blocks subsequent ordinary/raw output until explicit cleanup succeeds. */
typedef struct TAE_UsbPcmCallbacks {
  int (*acquire)(const char* device, int rate, int channels, const char* format, char* error, size_t error_size, void* user_data);
  int (*valid)(void* user_data);
  int (*release)(void* user_data);
} TAE_UsbPcmCallbacks;
TAE_API TAE_Result TAE_SetUsbPcmPolicy(TAE_EngineHandle engine, const TAE_UsbPcmCallbacks* callbacks, void* user_data);

/** Android direct USB Host, installed before playback. acquire returns a JSON
 * lease containing a borrowed authorized fd, name and wire profiles. configure
 * runs after native interface claims; restore runs before native releases them;
 * release closes the host connection last. configure/restore return empty text
 * on success or a UTF-8 error. Returned strings live until the next callback on
 * this host. Calls are serialized on control threads and must not re-enter the
 * engine. user_data outlives engine destruction. The USB render thread calls none
 * of these functions. Existing preferred-mixer callbacks are independent.
 * acquire format is a sample-format ID, prefixed with "dop-" for an explicit
 * DoP carrier request. Native DSD uses dsd-int8-* and rate is its DSD bit-clock;
 * each DSD wire profile records clockDivisor=32. PCM profiles may omit it (1). */
typedef struct TAE_UsbDirectCallbacks {
  const char* (*acquire)(const char* device, int rate, int channels, const char* format, int bits, void* user_data);
  const char* (*configure)(int profile, int rate, void* user_data);
  const char* (*restore)(void* user_data);
  void (*release)(void* user_data);
} TAE_UsbDirectCallbacks;
TAE_API TAE_Result TAE_SetUsbDirectHost(TAE_EngineHandle engine, const TAE_UsbDirectCallbacks* callbacks, void* user_data);

TAE_API TAE_Result TAE_Play(TAE_EngineHandle engine, const char* source, double start_time_seconds);
/** Prepare a source and its output in paused state, without briefly starting playback. */
TAE_API TAE_Result TAE_Load(TAE_EngineHandle engine, const char* source, double start_time_seconds);
TAE_API TAE_Result TAE_Pause(TAE_EngineHandle engine);
/** Idempotent pause/resume for platform focus and transport controls. TAE_Pause remains a toggle. */
TAE_API TAE_Result TAE_SetPaused(TAE_EngineHandle engine, int paused);
TAE_API TAE_Result TAE_Stop(TAE_EngineHandle engine);
TAE_API TAE_Result TAE_Seek(TAE_EngineHandle engine, double position_seconds);
TAE_API TAE_Result TAE_SetVolume(TAE_EngineHandle engine, double volume);
TAE_API TAE_Result TAE_SetPlaybackRate(TAE_EngineHandle engine, double rate);
/**
 * Sample-timed A-B loop on the active track.
 * Pass end_seconds <= start_seconds (or either negative) to clear the range.
 * Enforcement runs on the engine control/clock path (seek is not RT-safe).
 */
TAE_API TAE_Result TAE_SetLoopRange(TAE_EngineHandle engine, double start_seconds, double end_seconds);
TAE_API TAE_Result TAE_SetOutputDevice(TAE_EngineHandle engine, const char* device_id);
TAE_API TAE_Result TAE_SetOutputBackend(TAE_EngineHandle engine, const char* backend_id);

TAE_API TAE_Result TAE_LoadQueue(TAE_EngineHandle engine, const char* queue_json, int start_index);
/** Conditional queue-only replacement. OK + applied=0 leaves the old queue intact. */
TAE_API TAE_Result TAE_RebindQueue(TAE_EngineHandle engine, const char* queue_json, int start_index,
                                  const char* mode, const char* expected_item_json,
                                  int expected_index, int* out_applied);
/**
 * Appends resolved entries (JSON array) to the native queue without reloading.
 * out_first_index receives the absolute native index of the first appended item
 * and may be NULL. Existing indices never move.
 */
TAE_API TAE_Result TAE_AppendQueueItems(
    TAE_EngineHandle engine,
    const char* items_json,
    int* out_first_index);
/** Refreshes the source of a non-current queued item (expiring provider URL). */
TAE_API TAE_Result TAE_UpdateQueueItemSource(
    TAE_EngineHandle engine,
    int index,
    const char* source);
/** Queue revision/size/cursor/upcoming index/play-mode snapshot. */
TAE_API TAE_Result TAE_GetQueueState(
    TAE_EngineHandle engine,
    char* buffer,
    size_t buffer_size,
    size_t* required_size);
TAE_API TAE_Result TAE_SelectQueueIndex(TAE_EngineHandle engine, int index);
TAE_API TAE_Result TAE_Next(TAE_EngineHandle engine);
TAE_API TAE_Result TAE_Previous(TAE_EngineHandle engine);
TAE_API TAE_Result TAE_SetPlayMode(TAE_EngineHandle engine, const char* mode);
/* Native-held plans. Preparation returns immediately; poll PlaybackInfo for
 * preparing/ready/degraded and plan id, then submit that exact id. */
TAE_API TAE_Result TAE_SetAutoMixMode(TAE_EngineHandle, const char* mode);
TAE_API TAE_Result TAE_SelectAutoMix(TAE_EngineHandle engine, const char* request_json, char* buffer, size_t buffer_size, size_t* required_size);
/** Private group follower: bind the owner's sharedPlan to this member's local
 * sources/occurrences, frame domain and generation. Does not select a plan. */
TAE_API TAE_Result TAE_BindBridgeAutoMixSelection(TAE_EngineHandle engine, const char* request_json,
    char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_PrepareAutoMix(TAE_EngineHandle, const char* request_json);
TAE_API TAE_Result TAE_SubmitAutoMix(TAE_EngineHandle, uint64_t plan_id);
TAE_API TAE_Result TAE_CancelAutoMix(TAE_EngineHandle);
TAE_API TAE_Result TAE_GetQueue(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_GetUpcomingTrack(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);

TAE_API TAE_Result TAE_SetDspConfig(TAE_EngineHandle engine, const char* dsp_config_json);
TAE_API TAE_Result TAE_SetDspGraph(TAE_EngineHandle engine, const char* dsp_graph_json);
/** DSP state may include an optional outputConfig object (same fields as
 * TAE_SetOutputConfig). Send it with graph.outputStage when changing a fixed
 * rate and its allowed set together; legacy processing/graph payloads remain valid. */
TAE_API TAE_Result TAE_ApplyDspState(
    TAE_EngineHandle engine,
    uint64_t revision,
    const char* dsp_state_json);
TAE_API TAE_Result TAE_SetOutputConfig(TAE_EngineHandle engine, const char* output_config_json);
TAE_API TAE_Result TAE_GetDspConfig(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_GetDspGraphStatus(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_LoadImpulseResponse(TAE_EngineHandle engine, const char* path);
TAE_API TAE_Result TAE_UnloadImpulseResponse(TAE_EngineHandle engine);
TAE_API TAE_Result TAE_GetConvolverInfo(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_SetEqBands(TAE_EngineHandle engine, const char* eq_json);
TAE_API TAE_Result TAE_SetEqPreset(TAE_EngineHandle engine, const char* preset_json);
TAE_API TAE_Result TAE_SetCrossfeedStrength(TAE_EngineHandle engine, double strength);
TAE_API TAE_Result TAE_SetReplayGainMode(
    TAE_EngineHandle engine,
    const char* mode,
    double preamp_db,
    double fallback_db,
    int clip);
TAE_API TAE_Result TAE_SetDspPluginChain(TAE_EngineHandle engine, const char* chain_json);
TAE_API TAE_Result TAE_GetDspPluginStatus(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_GetMetadata(
    TAE_EngineHandle engine,
    const char* source,
    char* buffer,
    size_t buffer_size,
    size_t* required_size);
TAE_API TAE_Result TAE_EnumerateDevices(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_EnumerateBackends(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_GetEngineCapabilities(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_GetLastError(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
/**
 * Engine diagnostic event log (bounded process-wide ring). Returns a JSON
 * array of events with sequence > since_sequence, oldest first, capped at
 * max_entries (0 uses the engine default). next_sequence receives the cursor
 * to pass on the next call so repeated polls only ever see new events.
 */
TAE_API TAE_Result TAE_GetDiagnosticLog(
    TAE_EngineHandle engine,
    uint64_t since_sequence,
    size_t max_entries,
    char* buffer,
    size_t buffer_size,
    size_t* required_size,
    uint64_t* next_sequence);

TAE_API TAE_Result TAE_GetPlaybackInfo(TAE_EngineHandle engine, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_GetSpectrumData(TAE_EngineHandle engine, float* buffer, size_t point_count, size_t* written_count);
/** Runtime observation demand, independent from the persisted FFT preference. */
TAE_API TAE_Result TAE_SetVisualizationDemand(TAE_EngineHandle engine, int enabled);
TAE_API TAE_Result TAE_GetVisualizationData(
    TAE_EngineHandle engine,
    const char* options_json,
    char* buffer,
    size_t buffer_size,
    size_t* required_size);
TAE_API TAE_Result TAE_AnalyzeBpm(
    TAE_EngineHandle engine,
    const char* source,
    const char* options_json,
    char* buffer,
    size_t buffer_size,
    size_t* required_size);
TAE_API TAE_Result TAE_AnalyzeLoudness(
    TAE_EngineHandle engine,
    const char* source,
    const char* options_json,
    char* buffer,
    size_t buffer_size,
    size_t* required_size);
/** Background-only, independent of engine/output state. Writes a zero-based PCM WAV using
 * exact source-frame bounds, optional synthetic silence, and the decoder's rate/channels.
 * The caller owns a new output path and removes incomplete output on failure/cancellation. */
TAE_API TAE_Result TAE_RenderPcmSegment(const char* source, const char* output_path,
    double start_seconds, double end_seconds, double virtual_pregap_seconds,
    char* error_buffer, size_t error_capacity);
/* Worker-only bounded public-model analysis. options binds actual source identity
 * and source range; no model inference is performed by the render callback. */
TAE_API TAE_Result TAE_AnalyzeAutoMix(
    TAE_EngineHandle engine,
    const char* source,
    const char* options_json,
    char* buffer,
    size_t buffer_size,
    size_t* required_size);
/** One worker owns this token; cancel may race with that worker. Destroy only
 * after its native calls returned. timeout_ms=0 has no deadline. */
typedef void* TAE_AutoMixCancel;
TAE_API TAE_AutoMixCancel TAE_CreateAutoMixCancel(unsigned timeout_ms);
TAE_API void TAE_CancelAutoMixAnalysis(TAE_AutoMixCancel token);
TAE_API void TAE_DestroyAutoMixCancel(TAE_AutoMixCancel token);
TAE_API TAE_Result TAE_AnalyzeAutoMixCancellable(TAE_EngineHandle engine, const char* source,
    const char* options_json, TAE_AutoMixCancel token, char* buffer, size_t buffer_size, size_t* required_size);
TAE_API TAE_Result TAE_IdentifyAutoMixSource(TAE_EngineHandle engine, const char* source,
    TAE_AutoMixCancel token, char* buffer, size_t buffer_size, size_t* required_size);
/* Diagnostic counter: number of actual analyzer executions, excluding cached size-probe reads. */
TAE_API uint64_t TAE_GetAnalysisExecutionCount(const char* analysis_kind);
TAE_API const char* TAE_GetVersion(void);
/* Optional diagnostic context for the current native control thread. */
TAE_API void TAE_SetDiagnosticContext(const char* context_json);

#ifdef __cplusplus
}
#endif
