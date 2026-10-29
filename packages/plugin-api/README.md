# @twilight-echo/plugin-api

TypeScript typings for Twilight Echo plugin API v1–v4.

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
JSON-serializable data for host rendering. These command contributions do not
execute HTML; the legacy `renderMode` field is retained only for
API v1 source compatibility and is ignored by the host.

API v4 `PluginExperience` entries load packaged HTML in an isolated iframe.
Set `launch: 'sidebar'` to embed a custom widget below navigation, or use
`'page'` (default) / `'panel'` for the existing full-window and flyout views.
Optional `sidebar.height` is an integer from 64–480 CSS px, default 144, capped
at 55vh when embedded. Embedded views receive `PluginExperienceAppearance`
through the bridge's `appearance` event on connect and host appearance changes.
See `docs/plugin-sidebar-widgets.md` and `sdk/examples/sidebar-widget` in the
Twilight Echo repository for the complete runnable example and lifecycle contract.

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

Providers may implement optional `fetchArtistMetadata` and `fetchAlbumMetadata`
handlers returning `PlatformMetadataResult`. Keep native IDs, source language
(`und` when unknown), attribution and field permissions. The host caps declared
permissions by its reviewed deployment policy. These methods do not replace
the string-only `fetchArtistIntro` or the playback list `fetchAlbumTracks`.

Optional `searchRecordingIdentities(query, limit, offset, context?)` returns
`PlatformRecordingPage` for identity verification, independently of display/playback
`searchSongs`. Return full titles, all ordered artist names and their native IDs
(`null` for an unknown artist ID), original-precision seconds, the native album ID
and title, and the independently reported search total (`null` when unknown).
Do not include playback URLs, images or account data. Declare the handler explicitly
under the `search` capability; older providers need not implement it. Core reads
at most four ten-item pages and never treats a truncated or changing index as a
unique identity match.
Artists in these results may include official `aliases` belonging to their native
ID; omit aliases when the ID is unknown. Optional
`fetchArtistIdentity(artistId, context?)` returns `PlatformArtistIdentity` with the
same native ID, its name and official aliases. Declare this handler under the
`library` capability. Core uses it to check translated credits, shares cached
lookups, and rejects an ID mismatch. Neither method changes older providers.

An optional `artwork` array (up to three items) carries an HTTPS `resource`, source
page `url`, revision, attribution, license information and optional usage restrictions.
Images require an independent host approval; text rights do not authorize image use.
Image-only responses use `status: 'ok'` with empty `texts`. Core keeps resource URLs
private and supplies presentation clients with media handles. Older text-only responses
remain valid.
