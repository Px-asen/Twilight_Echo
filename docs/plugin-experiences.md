# Plugin experiences: pages, panels and sidebar widgets (API v4)

This extension is additive. Existing API v1-v3 process and declarative-theme
plugins continue to use their original lifecycle. An experience requires type
`ui`, permission `ui:inject`, and `contributes.experiences`:

```json
{
  "apiVersion": 4,
  "type": ["ui"],
  "permissions": ["ui:inject", "library:read", "player:observe", "player:control", "settings"],
  "contributes": {
    "experiences": [{ "id": "archive", "name": "Archive", "entry": "dist/index.html", "bridgeVersion": 2 }]
  }
}
```

An experience entry may set `"launch": "panel"` to keep it out of sidebar
navigation. Panel experiences are opened by the plugin's `titleBarButton`
contribution and mounted by the host in a right-side flyout overlay instead of
the main content area.

Use `"launch": "sidebar"` to embed custom HTML below navigation and above the
import/edit tools. Optional `"sidebar": { "height": 128 }` sets the content
height (default 144 CSS px, integer 64–480, capped at 55vh). The host provides
a collapsible title and opens the widget in a flyout in icon-only navigation.
It is not a navigation page or a startup-interface choice. See the runnable
[sidebar widget guide and sample](./plugin-sidebar-widgets.md).

A declarative experience needs no `main` process. Entry files must exist inside
the installed package. Assets are served from the entry directory through
`plugin-ui://<plugin-id>/<version>/...`, only while that installed version is
enabled. The scheme has a restricted MIME allowlist and CSP; external scripts,
network requests, workers, nested frames and forms are denied. Local library
cover handles are permitted as images, not audio filesystem paths.

The host mounts a cross-origin iframe with `allow-scripts allow-same-origin`.
It does not provide Node, Electron or preload access. The host retains its own
window chrome and exit control. IPC rejects untrusted child frame URLs even
when their top-level document is trusted.

## Bridge versions 1 and 2

The child posts `{ type: 'twilight-experience-ready', bridgeVersion: 2 }` to its parent. The host
checks source window and origin, then transfers one MessagePort with
`{ type: 'twilight-experience-connect', bridgeVersion: 2 }`. The port is scoped
to that mounted experience and closed on disposal. A request is
`{ id: integer, method: string, args?: object }`; replies contain the same id
and either `value` or `error`. Events have `{ event, value }`.

Operations are explicitly allowlisted in `src/shared/pluginExperience.ts`:
library read/write; playback control/observation; private preferences; window
exit/fullscreen/environment. No arbitrary IPC method forwarding is available.
`app:settings` and `plugins:manage` are separate, opt-in high-impact permissions.
Ordinary requests are bounded to 256 KiB and 16 concurrent calls. Explicit
metadata/import/export operations have larger, method-specific envelopes in
`experienceRequestLimit`; arbitrary large requests remain denied. Private preferences
are bounded to 64 KiB and written atomically in the plugin data directory.

## Music metadata and recovery

`music.metadata.read / write` retain the 16 MiB, revision-fenced document contract.
In the production Core, the first eligible read migrates the original IDs and
payloads into the music library SQLite. After publication that database is the
only writable authority; the original JSON and versioned backups are recovery
snapshots. UI preferences remain separate.

`music.metadata.operate` retains task, preview, import and reconcile. It also
accepts these `operation` values with arguments in `body`:

- `inventory`: `{ offset, limit }` returns original payloads, source bindings and
  bound/unassigned/conflict dispositions. These are source assignments, not
  confirmed shared music identities.
- `history`: `{ offset, limit }` returns retained document revisions.
- `history.read`: `{ revision }` returns that historical document or `null`.
- `restore`: `{ revision, expectedRevision }` restores the retained document and
  source bindings as a new revision, preserving the previous state in history.
- `cancel`: `{ operation: 'introductions' | 'credits' | 'enrich' }` cancels the
  latest batch for that lookup, including an active request, without clearing
  completed metadata. Cancellation remains available during a library scan.

These operations require the experience's existing `library:write` permission;
inventory/history pages are capped at 200. Read history and compare it with the
current document before restoring; a revision conflict requires a fresh read.
Production introductions/credits/enrich now use the Core's single persistent
metadata worker. Published batches survive restarts; incomplete submissions are
abandoned without executing. Existing selection, force and status fields remain
available. Status also reports batchId, needsReview, blocked, retrying, cancelled
and nextAttemptAt. A partial result may count as updated while awaiting retry.
The existing network permission is still required for queries. Explicit source
prohibitions apply, but the new automatic-identification opt-in is not a new
prerequisite for these manual operations. Implementation and acceptance gaps are recorded in
[M2.4](D:/Project/Twilight_Echo/docs/unified-music-library-m2.4.md).

## Talking to the plugin's own background code (`plugin.request`)

The experience sandbox has no network access. A plugin that also ships a
`main` entry (utility process) can expose background logic to its iframe:

- The iframe calls the bridge method `plugin.request` with a JSON request
  (requires the plugin's `network` permission; payload ≤ 256 KiB).
- The host relays it over the plugin service port into the plugin process,
  where handlers registered via `context.twilight.experience.onRequest(handler)`
  answer it (long timeouts: agent loops may legitimately stream for minutes).
- The plugin pushes live events back with
  `context.twilight.experience.emit(event, value)`; they travel to the mounted
  iframe as bridge events `{ event: 'plugin', value: { event, value } }` and
  are dropped while the iframe is unmounted, so background state should stay
  authoritative in the plugin process and be re-synced via `plugin.request`.

API keys, proxy-aware fetch and screenshot/cover bytes all belong in the
plugin process behind this relay; they never need to enter the renderer.


The host owns the playback engine and queue. Opening, closing or replacing a
view must not implicitly stop playback. The sample Rhine experience fetches
album summaries in pages and loads track details on demand.

## Current status

Rhine 0.2.1 is a local preview based on Rhine-Music-Demo V0.5.0 (a889801f).
Its bridge v2 workspace renders its own library, queue, playlists, audio/EQ,
DSP presets/nodes, providers/cloud, downloads, plugins and settings pages.
Radio, podcasts, network sources, listening statistics, diagnostics and basic
theme-workshop controls use the explicit adapters in `experienceServices.ts`.
The workshop must be enabled through its normal plugin lifecycle. Image/layer
editing and the full advanced device/native-plugin workflows are not all
reimplemented in this workspace. `ExperienceConsole.vue` remains the bridge v1
compatibility panel; it is not the Rhine v2 workspace.

Credentials and network playback plans remain in host services. Playback
operations also require `player:control`; editing/application permissions are
checked separately. The bridge exposes named capabilities and Rhine checks
the required methods before booting. Older binaries with the same application
version string are not necessarily compatible: API v4, bridge v2 and the new
service methods are required.

The original scene, camera, lighting and animation algorithms are retained.
Tray, mini-player and desktop-lyrics windows have Rhine skins while preserving
their restricted preload APIs. Opening a satellite uses the current tone;
live tone changes to already-open satellites remain future work.

Tests: `src/shared/pluginExperience.test.ts`,
`src/renderer/src/app/experienceNavigation.test.ts`, plugin CLI packing tests,
and `scripts/rhine-music-smoke.mjs`, `scripts/rhine-services-checks.mjs` and
`scripts/rhine-startup-settings-smoke.mjs`. They use isolated profiles, temporary
silent WAV fixtures and mocked native file/confirmation dialogs; they never
install into the user's regular profile. The startup test records the relaunch
IPC instead of restarting the test runner. Set `RHINE_TEST_PACKAGE` to a local
unpacked package to run its actual main/preload/renderer and resources in the
isolated Electron harness. External login/download services, physical audio
devices and real NAS streaming need separate validation.

`scripts/rhine-music-visual-evidence.mjs` captures matching demo data against the
pinned upstream at five viewport sizes in day/night modes. It is inspection
evidence, not synchronized animation-clock or pixel-identical acceptance.

## Selecting the Startup Interface

Settings > Appearance > 完整界面 lists enabled API v4 page experiences (`launch`
omitted or `"page"`), including Rhine Lab; panels and sidebar widgets stay out of
this selector. It is separate from the CSS plugin-theme selector. The `startupExperience`
setting stores only `pluginId` and `experienceId`; packaged URLs and versions are resolved
from the enabled registry on each launch.

Changing this setting saves the choice and asks whether to restart now. Cancel keeps
the current interface running and the existing restart banner remains available.
Selecting the default interface also takes effect after restart. Ordinary CSS themes
continue to apply live to the host interface.

Startup waits for the registry and ignores stale experience pages in navigation memory.
Explicit navigation during startup and onboarding take priority. Missing or disabled
experiences fall back to the default interface without deleting the saved preference.
The host return button is a temporary exit; use the selector to change future launches.

