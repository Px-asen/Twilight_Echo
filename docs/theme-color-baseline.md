# 2.0 theme color baseline

`src/renderer/src/components/theme-color-allowlist.json` records the existing
literal-color counts for the 2.0 interface. `themeColorAudit.test.ts` still rejects
any file that exceeds its recorded count and any new stylesheet with literals.
It also rejects gradient or shadow tokens used as individual colors.

The 2.0 refresh includes the Core library panels, external playlists, audio
workspace, appearance editor and experience windows. Some styles moved out of
large Vue files into shared CSS, including the DSP workspace and queue drawer.
Their old parent-file allowances are reduced to the current counts. Existing
palette declarations, translucent material/shadow colors, and token fallbacks
are retained so this CI repair does not recolor the application.

This is a versioned inventory of existing literals, not a claim that every
component is fully tokenized. Future changes should use the shared theme tokens;
changing this baseline requires explaining the affected palette or stylesheet
move in the PR. Do not automatically regenerate it during tests or builds.
