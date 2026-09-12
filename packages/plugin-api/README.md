# @twilight-echo/plugin-api

TypeScript typings for Twilight Echo plugin API v1 and v2.

```ts
import type { TwilightPluginContext } from '@twilight-echo/plugin-api'

export async function activate(context: TwilightPluginContext): Promise<void> {
  context.logger.info(`Hello from API v${context.apiVersion}`)
}
```

This package is types-first. Runtime capabilities are injected by Twilight Echo
through `activate(context)`.

The v1 UI typings include the controlled extension points currently exposed by
the host: `playerBarButton`, `settingsPanel`, `sidebarPage`,
`localSidebarItem`, and `streamingHome`. Commands may return text or
JSON-serializable data for host rendering. Arbitrary plugin-provided HTML is not
a supported extension path; the legacy `renderMode` field is retained only for
API v1 source compatibility and is ignored by the host.

Themes are declared in `plugin.json` under `contributes.themes`. The legacy
`twilight.themes.register()` signature is retained for API v1 source
compatibility but rejects at runtime.

Theme contributions may add a `structured` schemaVersion 1 document with `pureWhite`
and `dark` token overrides. Existing `variables` and `stylesheet` fields remain supported;
stylesheets are the advanced compatibility path and may depend on host selectors.

Plugin API v2 adds `structured` schemaVersion 2 with host-registered `modes`. Plugin API v3 adds
`structured` schemaVersion 3 with a host-owned shell grid that can rearrange the title bar,
navigation, content, and player bar without executing plugin code. API v1 and v2 themes remain
supported without behavior changes. The machine-readable token, mode, visibility, and layout
registry ships as `theme-contract.json`; the complete authoring guide is
`docs/theme-plugin-authoring.md` in the Twilight Echo repository.

Provider registrations may expose optional `health` metadata through
`TwilightMediaProviderHealth`. The host also records aggregate and per-method
health, including `methodStats.getPlaybackUrl`, so streaming UI can distinguish
login, API, playback URL, network, disabled-provider, and plugin failure states.

The Qishui provider may use the optional host-owned `twilight.qishuiAuth` bridge
for its QR login flow. It exposes only QR DTOs, the upstream poll response, and
the resulting session cookie; it does not expose Electron, arbitrary URLs, or
JavaScript execution to plugins.

Provider `Track` objects may include optional `bpm?: number` metadata in beats
per minute. Omit it when the source does not provide a trustworthy tempo value.
