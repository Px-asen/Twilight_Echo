# ASIO Interoperability Specification

Status: experimental contract frozen for hardware validation; not approved for release enablement

Scope: internal Windows x64 engine with independent x64 and MSVC x86 driver boundaries.

Contract revision: `4`.

The driver contract revision is separate from shared-memory protocol revision `6`.
The x64 golden contract is retained. The x86 extension (2026-11-02) has its own manifest,
`audio-engine/output/asio/abi/asio-abi-manifest-x86.json`, and these independent requirements:

- Windows IUnknown methods use COM `__stdcall`; subsequent ASIO C++ virtual slots use MSVC
  `__thiscall`. All four C callback functions use `__cdecl`.
- Pointer-bearing buffer descriptors and callback tables are 16 bytes each on x86 (24/32 on x64).
- With 4-byte driver-record packing, sample/time counters consist of high then low 32-bit words.
  Time-info contains speed, system time, sample position, sample rate, flags and reserved bytes
  at offsets 0, 8, 16, 24, 32 and 36; time-info/time-code/time sizes are 48/84/148 bytes.
- The 512-byte I/O-format selector block and virtual slot order are unchanged. Driver bitness
  does not change PCM bit depth or Native DSD packing/negotiation/restoration.

The test DLL uses `tests/asio-abi-fixture/X86DriverContract.h`, separately declared without including
the host ABI. `pnpm run test:asio-x86-bridge` checks the x86 golden layout, all virtual slots and
callbacks (including counters beyond 32 bits), then x64-to-x86 shared-memory transport and failures.

Revision 1 defines a two-buffer output path, a single active session, little-endian PCM formats
(Int16, packed Int24, Int24-in-Int32, Int32, and Float32), callback routing, and the
control-thread lifecycle. Each channel supplies `logicalFormat`, `containerBits`, `validBits`,
endianness, alignment, and DSD-packing metadata. Unsupported formats fail with
`unsupported_asio_sample_type`.

Revision 2 adds the Native DSD I/O-format extension for an explicit raw DSD open only. It does not
change the existing virtual method order. The extension calls the existing `future()` virtual slot
with the following Windows x64 data contract:

| Field or selector              | Value                                                            |
| ------------------------------ | ---------------------------------------------------------------- |
| request block size / alignment | 512 bytes / 4 bytes                                              |
| `formatType`                   | signed 32-bit integer at offset 0                                |
| reserved bytes                 | 508 bytes at offset 4; caller zeroes all bytes before every call |
| PCM format type                | `0`                                                              |
| DSD format type                | `1`                                                              |
| set I/O format selector        | `0x23111961`                                                     |
| get I/O format selector        | `0x23111983`                                                     |
| can-do I/O format selector     | `0x23112004`                                                     |
| success                        | error value `0` or `0x3f4847a0`                                  |

The request block is represented internally as `AsioIoFormat`. Its `sizeof`, alignment, and field
offsets are part of `audio-engine/output/asio/abi/asio-abi-manifest.json` and are asserted by both
Windows toolchains. No SDK header or source is stored, included, or compiled by this project.

All ASIO control calls accept both success values. A driver that returns the alternate positive
success value must not be treated as having rejected a format or rate.

For a Native DSD request, the control thread must use this sequence before buffers are created:

1. Read and retain the current sample rate and I/O format when available. For a PCM-unit buffer
   preference, retain the PCM buffer range before changing modes. A retained format may
   be PCM or DSD. If the getter is unsupported, restoration uses PCM as the format baseline.
2. Prefer can-do/set DSD, then select the semantic DSD rate and check the active I/O format.
   Restore the baseline between failed orders. Rate-first and rate-only negotiation are bounded
   compatibility fallbacks. An implemented I/O-format getter must confirm DSD; an unsupported
   getter requires final DSD channel-type evidence after buffer creation.
3. Validate sample-rate readback, requiring consecutive target observations. Avoid a redundant
   set when the rate is already correct. A bounded supported-rate pivot may recover a stalled
   switch, but success always requires returning to the requested rate.
4. Re-read the buffer-size range after the switch. If all range counts and the granularity scale
   consistently, convert a PCM-unit preference by that observed ratio. Select legal
   requested/preferred/nearby sizes within the helper's DSD-count and wire-byte limits.
   An unavailable or invalid range fails the open. The actual driver count remains distinct
   from the preference and from the packed render capacity.
5. Treat pre-create channel information as advisory. Create buffers using bounded candidates,
   disposing each failed or partial allocation before another attempt. After successful creation,
   query every output channel and verify the sample rate again. Native DSD output channels must
   report a uniform supported raw DSD type; the engine adapts the source packing to that type.
6. Initialize idle buffers before start. Runtime proof still requires a successful typed raw DSD
   callback, so an open alone is not `nativeDsdRuntimeState=proven`.

Revision 3 adds the post-DSD buffer-range refresh. Revision 4 extends the independent channel
descriptor contract to big-endian and reduced-valid-bit PCM, Float64 wire containers, an optional
output-channel start, and the helper protocol's bounded eight-byte wire stride. The ABI virtual
method order and Native DSD selector block remain unchanged.

The helper records actual driver callback timestamps and owns DSD buffer-unit evidence. It starts
with `bufferSize/8` packed source frames and only widens LSB1/MSB1 after consecutive unambiguous
cadence observations at the driver callback. NER8 remains at the conservative packed capacity and
expands each source byte to eight 0/1 wire bytes; this is an interoperability behavior that requires
hardware validation because drivers vary in their NER8 allocation semantics.

When can-do reported DSD support but both set attempts were refused, the negotiation failure text
must note that another audio client likely holds the device: that refusal shape is
field-verified as a multi-client format lock (the same driver accepts every switch the moment
the other client closes), not as missing DSD capability.

No Native DSD probe runs during device enumeration or while the driver is already playing. The
whole request runs on the bounded ASIO control command; a timeout marks the session unhealthy and
the audio service recovery path owns process isolation. Failed negotiation, final format mismatch,
rate mismatch, or channel mismatch rejects the Native DSD candidate and lets the normal
Native DSD -> DoP -> PCM selection path report its fallback honestly.

After any successful or attempted DSD format switch, close first stops and disposes buffers, then
restores the retained I/O format, restores and verifies the retained sample rate, clears callback state,
and releases the COM interface. The restoration attempt is required even when the DSD set call
returns an error, because a driver may have partially changed state before reporting failure.
If restoration fails, retain the error across repeated close calls and reject reuse of that session.

The fake driver must cover successful can/get/set, unsupported format, exact DSD channel type,
transport-rate verification, and PCM restoration. `pnpm run test:asio-cross-abi` validates that
MSVC's fake DLL and the MinGW host agree on the revision-2 layout and can complete that round trip.
This is implementation evidence, not a substitute for real-device proof or a release decision.
