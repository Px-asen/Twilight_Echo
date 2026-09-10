# Theme layout sheets

Each built-in preset owns one stylesheet here that restructures the four core surfaces
(app shell, local dashboard, streaming home, playing page) so the preset reads
as a distinct application rather than a recolor of the default.

Player bars and their attached panels use the shared standard / mini / compact component styles.
Preset sheets must not override them. Their tokens come from the default theme for the current tone;
preset player modes, typography treatments, and visibility flags apply to the playing page only. Presets 2, 3, and 4 default to compact.

## Contract

Presets 3 (`obsidian-glass`) and 4 (`paper-light`) use a title bar without a bottom divider,
including the liquid glass background's inset shadow.

- Every rule **must** be scoped under `html[data-te-preset-layout='<key>']`. The attribute is
  written by `applyActiveTheme` in `src/renderer/src/stores/useThemeStore.ts` and resolves
  through `profile.source.presetId`, so user profiles derived from a preset keep its layout.
- `<key>` is the preset id with the `builtin:` prefix stripped
  (`builtin:neon-gradient` → `neon-gradient`).
- **No hard-coded color literals.** `themeColorAudit.test.ts` walks every `.css` under
  `src/renderer/src` and these files are budgeted at 0. Use `--te-*` tokens, or `color-mix()`
  / `oklch()` over tokens, so the sheets follow tone switching and accent-from-cover.
- These are global sheets, not scoped SFC styles, so `:global(...)` must not appear and the
  `scopedGlobalSelectors` restriction does not apply.
- Do not fight the runtime `!important` on `:root` token values — override structure
  (grid, flow, order, size, position), not token values.
