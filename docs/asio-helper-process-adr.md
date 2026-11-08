# ASIO helper process isolation

- **Scope**: Windows x64 audio engine with x64 and x86 ASIO helpers (64-bit Windows only)
- **Protocol revision**: 6

## Context

Before helper isolation, the audio engine ran outside Electron's main process and ASIO control
calls ran on a dedicated COM thread, but the third-party driver DLL remained in the audio service.
A driver access violation, infinite control call or corrupted callback could terminate or wedge
the whole audio service.

The output backend uses an additional process boundary. The audio service keeps Twilight Echo's decoder, queue, DSP,
format selection, and diagnostics. A native helper process alone loads the ASIO driver and owns its
COM objects, driver buffers, callback router, and control thread. The helper contains no renderer,
preload, Electron main-process, queue, decoder, or DSP logic.

## Decision

### Process boundary

`AsioBackend` is the engine-facing output backend. Its default `IAsioHost` uses an isolated
host proxy. It selects `twilight-asio-helper.exe` (x64) or `twilight-asio-helper-x86.exe` (x86)
beside the audio-engine binaries, using the resolved device architecture for both probe and open.
The helper owns `RealAsioHost` and accepts only its native registry view; tests can inject helper paths
and a synthetic catalog. Only one helper session is active. Switching architecture stops and closes
the previous session, restores its format, drains the render worker and disposes its process first.

Enumeration is registry-only in the parent: it reads `KEY_WOW64_64KEY` and `KEY_WOW64_32KEY`,
including `InprocServer32` in the matching view, without activating a driver. Probing, open, buffer
creation, start, stop, close and restoration cross the boundary. No driver method runs in the parent.

x64 IDs retain `asio:{CLSID}`; x86 IDs use `asio:x86:{CLSID}`. Both remain visible when installed,
with architecture labels and separate capability-cache keys. Automatic and legacy-name resolution
prefer x64; an x86 legacy name must match uniquely. A missing explicit ID never selects another
architecture. `TAE_ASIO_HELPER_PATH` retains its x64 meaning; `TAE_ASIO_HELPER_X86_PATH` overrides x86.

### Versioned control protocol

The parent creates a named shared-memory mapping plus request and response events before launch.
Both sides validate a magic value, protocol version, structure size, limits, and monotonically
increasing request sequence. The handshake also checks the helper's architecture. Commands are:

1. `EnumerateDevices`
2. `GetDiagnostics`
3. `ProbeDevice`
4. `Open`
5. `CreateBuffers`
6. `Start`
7. `Stop`
8. `Close`
9. `Shutdown`

Only one control request may be outstanding. The parent publishes a complete fixed-layout request,
signals the request event, then waits for the matching response sequence or helper process exit.
Unknown commands, malformed counts, oversize strings, or a version mismatch fail closed with
`asio_helper_protocol_error`.

Revision 7 adds the `bufferSizeInPcmFrames` request flag, using the former four-byte padding
before the response. The shared mapping size and all other record offsets remain unchanged.
Native DSD driver counts may exceed 32768; storage is bounded by the existing 262144-byte
channel stride. Packed bit-sample buffers start at count/8, and a confirmed byte-frame buffer
that exceeds the channel allocation fails instead of being truncated. Direct host requests
retain raw driver-count semantics unless the new flag is set.

Revision 6 added driver/helper architecture and the 32-bit resolvable-driver count. Every shared
record has a checked `sizeof`, `alignof` and complete `offsetof` manifest in
`audio-engine/output/asio/helper/asio-helper-layout.json`. Packing is 8 bytes, render records retain
64-byte alignment, and explicit padding removes the MSVC/MinGW member-alignment difference.
The mapping is 33,718,208 bytes. Shared records contain fixed-width integers and arrays, never
pointers, `size_t` or STL objects. All publication counters are aligned 32-bit Interlocked values.
64-bit capability versions travel under request/response ownership; callback timestamps are read
only after queue publication and before slot release. They need no cross-process 64-bit atomic load.
Engine and helpers must ship together; an old protocol is rejected, not translated.

### Deadlines

Control waits are bounded and cancellation is destructive because a timed-out driver call cannot be
made trustworthy in place:

| Operation                                 |                     Deadline |
| ----------------------------------------- | ---------------------------: |
| launch/handshake                          |                          5 s |
| enumerate/probe/open/create buffers/start |                         12 s |
| stop/close/shutdown                       |                          3 s |
| callback heartbeat after start            | max(2 s, 8 callback periods) |

On any deadline breach the parent terminates the helper, closes its process/event/mapping handles,
marks the host unusable, and reports `asio_helper_control_timeout` or
`asio_helper_callback_stalled`. It does not retry or recreate the stream automatically.

### Shared render buffer ownership

The mapping contains two preallocated PCM output buffer sets, a bounded DSD render queue and a
bounded callback notification ring.
The audio service owns writes to a buffer set. The helper callback owns reads after the parent
publishes that set's committed generation. Ownership returns to the parent after the helper copies
the committed bytes to the driver's corresponding buffer and publishes the callback index.

The helper callback performs only bounded memory copies, fixed-size silence fill, interlocked loads
and stores, and `outputReady`. It does not allocate, lock, wait on an event, issue a control request,
touch disk or network, or call Electron IPC. If the next generation is not ready, it writes silence
and increments the shared underrun counter instead of reading a buffer being modified.

PCM silence is zero. Native DSD silence uses the channel format's idle byte. The parent commits the
number of packed source frames it rendered. Revision 4 also carries eight-byte PCM containers,
post-create rate/latency/startup facts, an output-channel start, and monotonic driver callback
timestamps. The helper publishes the approved render capacity; every copy must match the committed
frame count and stay inside that capacity and the shared stride. Short commits fill the remaining
tail with idle. Revision 5 added the pre-rendered DSD SPSC queue to decouple short driver periods
from parent event wakeups; revision 6 preserves its ownership and byte handling on x86.

DSD unit classification runs at the actual driver callback before copying. It starts at
bufferSize/8 packed frames; consecutive unambiguous cadence evidence can widen packed LSB1/MSB1 to
bufferSize. Gaps, nonmonotonic timestamps, and ambiguous intervals break an unconfirmed streak.
Parent worker timing cannot widen capacity. Cadence is a heuristic, not an allocation-size API.
NER8 keeps bufferSize/8 packed source frames and expands each source byte into eight 0/1 wire bytes;
its idle uses the same expansion, so the write stays within bufferSize wire bytes. This path remains
experimental until hardware confirms the driver's NER8 representation and allocation semantics.

### Exit and failure state machine

| Trigger                       | Helper action                                                                | Parent action                                          | Playback result     | Stable reason                       |
| ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------- | ----------------------------------- |
| normal `Stop`/`Close`         | stop; on close, dispose buffers, restore retained format/rate, release COM objects | drain worker on close; retain helper/mapping until shutdown or architecture switch | stopped | none |
| normal `Shutdown`             | perform `Close`, publish stopped, exit 0                                     | wait boundedly, close all handles                      | stopped             | none                                |
| control timeout/hang          | may remain stuck                                                             | terminate helper and close shared resources            | immediate safe stop | `asio_helper_control_timeout`       |
| unexpected exit/crash         | OS closes driver/process handles                                             | observe process exit and close shared resources        | immediate safe stop | `asio_helper_process_exited`        |
| externally killed             | no cleanup code is assumed                                                   | observe process exit and close shared resources        | immediate safe stop | `asio_helper_process_exited`        |
| callback heartbeat stops      | no callback progress                                                         | terminate helper and close shared resources            | immediate safe stop | `asio_helper_callback_stalled`      |
| driver/device rejects open    | close attempted session; restore any attempted DSD switch                    | return failure without starting                        | remains stopped     | `asio_helper_device_rejected`       |
| retained format/rate restore fails | close remaining driver objects and retain failure across repeated close calls | keep ASIO unavailable for this session            | remains stopped     | `asio_helper_format_restore_failed` |
| malformed protocol            | stop accepting commands and exit                                             | terminate if needed and close mapping                  | remains stopped     | `asio_helper_protocol_error`        |

Helper process failure is surfaced as an output render failure rather than a device-invalidated
event. This is deliberate: device-invalidated events may use the engine's existing automatic default
device recovery, while AP-101 requires no automatic resume after helper failure. Queue and position
remain available to the application, but playback stays stopped until the user explicitly retries
ASIO or selects WASAPI Shared/Exclusive.

### Diagnostics and fallback

The stable reason is written to `OutputInfo.perfectReasonCode`, with the detailed driver or Windows
message in `capabilityReason` and diagnostics `lastError`. The existing output settings remain the
only fallback control surface; the helper never changes backend or device selection itself.
`processArchitecture` describes the engine, `asioHelperArchitecture` the active helper.
`asioLoadableDriverCount32/64` count registry-resolvable entries, not proven playable hardware.
Do not infer an x86-only count by subtracting registry totals: compare canonical CLSIDs across views.
A missing x86 executable fails only the selected x86 route; x64 remains explicitly selectable.

### Packaging and legal boundary

Windows release staging requires both helpers beside `twilight-audio-engine.dll` and
`twilight_audio_node.node`. The x64 helper retains its toolchain's import closure. The x86 helper
is built separately with MSVC Win32 Release and static CRT `/MT`, and may import only Windows system
DLLs, avoiding differently sized runtime DLLs with the same name. Release verification checks both
PE architectures, helper self-tests and the engine's `features.asioHelperProtocolVersion`.
Missing, stale or mixed-version components fail packaging. Existing x64-only development staging
remains supported; it does not advertise a complete dual-helper release.

The helper compiles only the repository's independent ABI contract and Windows system interfaces.
No ASIO SDK header, source, archive, binary, path, or build option is introduced. The existing
`verify:asio-sdk-free` and cross-ABI gates remain required.

## Consequences

- A defective ASIO driver can terminate or wedge only the helper; Electron main and the audio
  service remain alive.
- Render delivery gains one shared-buffer ownership handoff but no blocking IPC in the driver
  callback.
- A helper failure is intentionally audible as a stop, never as an automatic resume on an
  unverified route.
- ASIO releases now require two architecture-specific helper executables.
- Real-device ASIO behavior remains opt-in evidence; fake lifecycle tests prove isolation mechanics,
  not hardware compatibility.

Build and target-device acceptance steps: [ASIO x86 bridge](asio-x86-bridge.md).
