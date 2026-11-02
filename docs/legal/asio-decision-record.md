# ASIO Compatibility Decision Record

Status: personal open-source policy; runtime enabled, hardware evidence remains opt-in

Twilight Echo uses an independent Windows x64 engine with x64 and x86 ASIO helpers. The project does not
bundle, include, or compile an ASIO SDK. Installed ASIO drivers are enumerated by default; users can
set `TWILIGHT_DISABLE_ASIO=1` to disable enumeration and activation for troubleshooting or rollback.

For the current personal open-source project, written legal advice and a formal clean-room
sign-off are not release prerequisites. Retain the lightweight provenance record, SDK-free scan
result, ABI manifests, and hardware evidence instead. Do not claim official approval or support,
and do not distribute an ASIO logo.

Obtain a formal legal and license review before a commercial, closed-source, funded, company-run,
hardware-partner, or channel-distributed release. That review must cover the interface,
copyright, patent, license, trademark, and product-facing terminology applicable at that time.

The fallback when this gate is incomplete is WASAPI Shared or WASAPI Exclusive. The project must
not restore an SDK-based build as a temporary workaround.
