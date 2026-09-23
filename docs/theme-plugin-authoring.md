# Twilight Echo Theme Plugin Authoring

Theme plugins are declarative packages. A pure theme plugin has no `main` entry, executes no script,
and contributes one or more themes through `plugin.json`. Plugin API v3 adds a host-owned shell grid
that can rearrange the application layout while keeping every API v1 and v2 theme valid.

## Contract Files

## Theme workshop editor metadata

Theme contributions may include `editor: { schemaVersion: 1, controls: [...] }`.
Each control declares `id`, `label`, `group`, `type`, one of `variable` / `token` / host `slot`, and `defaults`
for `pureWhite` and `dark`. Types are `color`, `number`, `select`, `boolean`,
`image`, and `text`; numeric controls may specify `min`, `max`, `step`, and `unit`.
Select controls declare `options`. An optional `selector` scopes the CSS variable
override to the element where the original stylesheet declares that variable.
Optional `targets: { local, streaming }` selectors expose independent local and
streaming overrides. Controls are linked by default. Unlinking copies the current
value; relinking uses the explicitly selected side for both modes.
Defaults describe the existing stylesheet; they are not applied until the user
changes a control. This preserves the original theme when creating a project.

The built-in theme workshop is disabled by default. It snapshots enabled theme
plugins into independent projects and exports `.teworkshop` editable documents
or declarative `.tep` packages. Source files are never rewritten. Local image
references are embedded in the snapshot; external URLs and stylesheet imports
currently require author-side consolidation before snapshotting.

The `.tep` writer uses the `plugin-theme` archive format, restricted to `plugin.json`,
`theme.css`, and `ATTRIBUTION.json`; legacy theme archive validation remains unchanged.
The workshop round-trip test writes and extracts a real archive, validates the exported
contribution, and reimports the editable document after its source becomes unavailable.
Set `TWILIGHT_WORKSHOP_SOURCE` to an external theme plugin directory when running
`pnpm run test:theme-workshop` to exercise that theme without copying it into this repository.

The settings Appearance section places **Theme Plugin Workshop** immediately below
**Theme Creative Studio**. Its sidebar shortcut is hidden. The button becomes available
when the bundled tool plugin is enabled; disabling still flushes the current draft.

Projects can contain an asset library (PNG/JPEG/WebP and WOFF2), per-tone surface layers,
non-destructive crop, four-edge fade, opacity, blur, gradient, mask, ordering and display
conditions. The host renders decorative layers behind content with pointer events disabled.
Library density uses the existing mode contract so virtualized rows keep their measured height.
Structured layout and modes are preserved through compilation and export. Applied versions
are saved separately and can be restored without changing the installed source theme.
Image references and license notices are captured with the project; asset source/attribution
fields are included in exported attribution metadata.

Whole-window trial restores managed theme attributes as well as CSS on exit. Escape and a
host-owned top-layer recovery button exit trial. The default iframe has no script permission
and receives no preload bridge; host-rendered preview components use fixture tracks and inert
controls. The settings preview is a controls sample rather than an interactive settings page.
Mode-only edits refresh preview attributes even when CSS is unchanged. Base-update previews
use the candidate's structured layout and modes; cancelling leaves the stored base intact.

Editor metadata does not grant script execution or arbitrary component access.

- `packages/plugin-api/src/index.ts`: authoritative TypeScript declarations.
- `packages/plugin-api/theme-contract.json`: machine-readable token, mode, and visibility catalog.
- `src/shared/theme.ts`: host registry and normalization behavior.
- `packages/create-twilight-plugin/templates/theme`: complete API v2 scaffold.

The JSON catalog is generated with `pnpm run generate:plugin-theme-contract`. `test:themes` fails if
the committed catalog no longer matches the host registry.

## Complete Manifest Example

```json
{
  "id": "com.example.nocturne",
  "name": "Nocturne",
  "version": "1.0.0",
  "description": "A declarative desktop theme",
  "author": "Example Author",
  "license": "Apache-2.0",
  "type": ["theme"],
  "engines": { "twilightEcho": ">=0.20.0" },
  "apiVersion": 3,
  "permissions": [],
  "contributes": {
    "themes": [
      {
        "id": "nocturne",
        "name": "Nocturne",
        "description": "Compact glass presentation",
        "structured": {
          "schemaVersion": 3,
          "variants": {
            "pureWhite": {
              "tokens": {
                "color.primary.500": "#2563eb",
                "surface.app": "#f8fafc"
              }
            },
            "dark": {
              "tokens": {
                "color.primary.500": "#60a5fa",
                "surface.app": "#07090a"
              }
            }
          },
          "modes": {
            "appearance": { "backgroundTreatment": "solid", "contrastGuard": "enforce" },
            "navigation": { "style": "rail", "iconScale": "md" },
            "library": { "density": "compact", "selection": "stroke" },
            "player": { "layout": "split", "controls": "pro", "progress": "spectrum" },
            "icons": { "family": "rounded" },
            "visibility": { "playerDuration": false, "playerWaveform": true }
          },
          "windowDefaults": {
            "miniPlayer": { "surfaceColor": "#07090a", "cornerRadius": 18 },
            "desktopLyrics": { "highlightColor": "#5eead4", "shadowBlur": 12 }
          },
          "layout": {
            "desktop": {
              "columns": ["standard", "fill"],
              "rows": ["auto", "fill", "auto"],
              "areas": [
                ["titleBar", "titleBar"],
                ["navigation", "content"],
                ["navigation", "playerBar"]
              ]
            },
            "compact": {
              "columns": ["fill"],
              "rows": ["auto", "fill", "auto"],
              "areas": [["titleBar"], ["content"], ["playerBar"]]
            },
            "navigation": "persistent"
          }
        },
        "stylesheet": "theme.css"
      }
    ]
  }
}
```

`stylesheet` is optional and remains the advanced compatibility path. It must stay inside the
plugin package and cannot load remote code or assets. Prefer structured tokens and modes because
internal host selectors are not a compatibility contract.

## Resolution Order

The selected plugin theme resolves in this order:

1. Twilight Default tokens and mode defaults.
2. Legacy `variables` values.
3. Registered structured token overrides for the active light/dark tone.
4. Host-derived values required by structured v2 modes.
5. The optional packaged stylesheet.

Only registered token IDs become CSS variables. Only registered modes and validated shell layouts
become `data-te-*` attributes and host-generated CSS Grid values. Unknown mode IDs, unsupported
values, or invalid layouts are ignored, written once to the owning plugin log, and shown as
compatibility notes in Theme Studio.

## Mode Reference

| Domain     | IDs and accepted values                                                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Appearance | `accentSource`: `fixed`, `cover`; `backgroundTreatment`: `solid`, `gradient`, `cover-blur`, `image`; `toneScheduling`: `manual`, `system`, `timed`; `contrastGuard`: `off`, `warn`, `enforce` |
| Navigation | `style`: `expanded`, `compact`, `rail`; `iconScale`: `sm`, `md`, `lg`; `logo`: `show`, `hide`                                                                                                 |
| Library    | `density`: `comfortable`, `compact`; `selection`: `fill`, `stroke`; `titleOverlay`: `off`, `on`                                                                                               |
| Player     | `layout`: `standard`, `full-cover`, `lyrics-focus`, `split`, `minimal`; `controls`: `standard`, `pro`; `titleAlign`: `left`, `center`; `progress`: `line`, `ring`, `solid`, `spectrum`        |
| Artwork    | `transition`: `fade`, `slide`, `none`; `shadow`: `on`, `off`                                                                                                                                  |
| Equalizer  | `panel`: `neutral`, `tinted`, `glass`; `slider`: `ring`, `solid`; `knob`: `line`, `dot`; `spectrum`: `bars`, `line`, `area`; `button`: `soft`, `outline`, `solid`                             |
| Icons      | `family`: `outline`, `rounded`, `filled`                                                                                                                                                      |
| Typography | `titleCase`: `preserve`, `uppercase`; `lyricAccent`: `off`, `accent`; `titleColor`: `off`, `track`, `artist-album`                                                                            |

Visibility accepts only the cataloged boolean slots: `playerAlbumArtist`, `playerArtwork`,
`playerTrackMenu`, `playerMiscIcons`, `playerDuration`, `playerWaveform`, `playerTrackInfo`,
`equalizerGrid`, `equalizerFrequencyGuides`, `equalizerSpectrum`, `previousButton`, `nextButton`, and
`miniPlayerArtwork`.

## Shell Layout (API v3)

`structured.layout` is the supported way for a theme to reconstruct the main-window layout. It
places host-rendered `titleBar`, `navigation`, `content`, and `playerBar` regions in a CSS Grid;
the `titleBar` and `content` regions are required. A region may be omitted by using `.` in every
grid cell, which hides that host region without creating an implicit grid area. Grid areas for each
region must be rectangular.

The only allowed track names are `auto`, `content`, `narrow`, `standard`, `wide`, `fill`, and
`double`. These map to host-owned CSS values, so manifests cannot inject arbitrary CSS. `desktop`
is required; `compact` replaces it below 760px. `navigation` is `toggle` (default), `persistent`,
or `hidden`.

The grid repositions existing host components only. It does not change their data contract, mount
untrusted Vue components, or permit HTML, script, Electron, Node, playback, DSP, or arbitrary DOM
access. Theme stylesheets remain a visual compatibility layer, not the supported layout API.

## Component Preview

Theme Studio previews plugin themes on the real dashboard, player, equalizer, navigation, title bar,
and PlayerBar components. Preview does not execute plugin code or duplicate playback state. Use the
light/dark selector and the three preview surfaces to review tokens and modes before applying.

## Compatibility Matrix

| Manifest API   | Structured schema | Result                                                       |
| -------------- | ----------------- | ------------------------------------------------------------ |
| 1              | omitted or 1      | Supported without behavior changes                           |
| 2              | omitted or 1      | Supported compatibility path                                 |
| 2              | 2                 | Current token + mode + window contract                       |
| 3              | 3                 | Current token, mode, window, and host shell-layout contract  |
| 1              | 2                 | Rejected because modes are not added retroactively to API v1 |
| 1 or 2         | 3                 | Rejected because shell layouts require API v3                |
| greater than 2 | any               | Rejected by the current host and tooling                     |

Disabling or uninstalling the selected plugin always reconciles the active theme back to Twilight
Default. Invalid tokens, unknown modes, invalid shell layouts, and unavailable window fields are
discarded independently; they do not grant arbitrary DOM, Electron, Node, playback, DSP, or queue
access.

## V1 to V2 Migration

1. Change `plugin.json` `apiVersion` from `1` to `2` for modes, or to `3` for shell layouts.
2. Change `structured.schemaVersion` from `1` to `2` for modes, or to `3` for shell layouts.
3. Keep existing `variables`, `variants`, `windowDefaults`, and `stylesheet` fields unchanged.
4. Add only modes, slots, and tracks listed in `theme-contract.json`.
5. Move stable colors, lengths, fonts, and material values from raw CSS into semantic tokens.
6. Keep CSS only for presentation that has no public token or mode, and do not depend on internal
   selectors remaining stable.
7. Run `create-twilight-plugin pack` and review Theme Studio compatibility notes on the target host.

## Deprecation Record

| Surface                                      | Status                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `variables`                                  | Supported API v1 compatibility input; structured tokens are preferred    |
| Packaged `stylesheet`                        | Supported advanced path; internal selector compatibility is not promised |
| `structured` schemaVersion 1                 | Supported for API v1 and v2                                              |
| `structured` schemaVersion 2                 | Current API v2 theme contract                                            |
| `structured` schemaVersion 3                 | Current API v3 theme contract; adds host-owned shell layout              |
| `twilight.themes.register()`                 | Deprecated source signature; runtime registration rejects                |
| Renderer scripts, remote code, arbitrary DOM | Never supported; API v3 shell layout is declarative host composition     |
