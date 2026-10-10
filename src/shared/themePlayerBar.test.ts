import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveThemePlayerBarMode, sharedPlayerBarStylesheet } from './themePlayerBar.ts'
import { BUILT_IN_THEME_PRESETS, type ThemeProfileV2 } from './theme.ts'

test('shared player bar presentation fixes the original controls and typography in both tones', () => {
  for (const tone of ['pureWhite', 'dark'] as const) {
    const css = sharedPlayerBarStylesheet(tone)
    assert.match(css, /^\.player-bar-shell \{/)
    assert.match(css, /--te-player-control-radius: 999px;/)
    assert.match(css, /--te-player-control-size: 32px;/)
    assert.match(css, /--te-player-play-size: 44px;/)
    assert.match(css, /--te-player-progress-thumb-size: 12px;/)
    assert.match(css, /--te-font-rounded:/)
    assert.match(css, /--te-card-bg:/)
    assert.doesNotMatch(css, /--te-menu-width:|--te-titlebar-height:|--te-lg-/)
  }
  assert.notEqual(sharedPlayerBarStylesheet('pureWhite'), sharedPlayerBarStylesheet('dark'))
})

test('explicit player colors follow the edited tone without inheriting preset geometry', () => {
  const profile: ThemeProfileV2 = {
    ...BUILT_IN_THEME_PRESETS[1],
    id: 'user:player-colors',
    overrides: {
      pureWhite: {
        'playback.progress.track': '#123456',
        'playback.progress.fill': 'linear-gradient(90deg, #ff0000, #00ff00)',
        'playback.control.surface': '#654321',
        'playback.control.hoverSurface': '#abcdef',
        'playback.control.text': '#ffffff',
        'playback.control.hoverText': '#112233',
        'playback.control.playSize': '64px',
        'playback.progress.height': '14px'
      },
      dark: { 'playback.progress.track': '#345678' }
    }
  }
  const light = sharedPlayerBarStylesheet('pureWhite', profile)
  assert.match(light, /--te-player-bar-progress-track: #123456;/)
  assert.match(light, /--te-player-bar-progress-fill: linear-gradient\(90deg, #ff0000, #00ff00\);/)
  assert.match(light, /--te-player-bar-play-surface: #654321;/)
  assert.match(light, /--te-player-bar-play-hover-surface: #abcdef;/)
  assert.match(light, /--te-player-bar-play-text: #ffffff;/)
  assert.match(light, /--te-player-bar-play-hover-text: #112233;/)
  assert.match(light, /--te-player-play-size: 44px;/)
  assert.match(light, /--te-player-progress-height: 6px;/)
  const dark = sharedPlayerBarStylesheet('dark', profile)
  assert.match(dark, /--te-player-bar-progress-track: #345678;/)
  assert.doesNotMatch(dark, /--te-player-bar-(?:progress-fill|play-surface|play-hover-surface):/)

  profile.overrides.pureWhite = {}
  assert.equal(
    sharedPlayerBarStylesheet('pureWhite', profile),
    sharedPlayerBarStylesheet('pureWhite')
  )
  for (const preset of BUILT_IN_THEME_PRESETS) {
    assert.equal(sharedPlayerBarStylesheet('dark', preset), sharedPlayerBarStylesheet('dark'))
  }
})

test('themes two through four default to compact and the others to standard', () => {
  for (const presetId of [
    'builtin:aurora-reference',
    'builtin:obsidian-glass',
    'builtin:paper-light'
  ] as const) {
    assert.equal(resolveThemePlayerBarMode({ kind: 'builtin', id: presetId }), 'compact')
    for (const profile of [
      { baseThemeId: presetId },
      { baseThemeId: 'builtin:twilight-echo-default', source: { kind: 'builtin-preset', presetId } }
    ]) {
      assert.equal(
        resolveThemePlayerBarMode({ kind: 'user', id: 'user:derived' }, profile as ThemeProfileV2),
        'compact'
      )
    }
  }
  for (const id of [
    'builtin:twilight-echo-default',
    'builtin:neon-gradient',
    'builtin:studio-split',
    'builtin:zen-minimal'
  ] as const) {
    assert.equal(resolveThemePlayerBarMode({ kind: 'builtin', id }), 'standard')
  }
  assert.equal(
    resolveThemePlayerBarMode({ kind: 'plugin', pluginId: 'example', themeId: 'theme' }),
    null
  )
})

test('derived user themes inherit their built-in preset player bar default', () => {
  const auroraProfile = {
    baseThemeId: 'builtin:aurora-reference',
    source: { kind: 'builtin-preset', presetId: 'builtin:aurora-reference' }
  } as ThemeProfileV2
  const standardProfile = { baseThemeId: 'builtin:twilight-echo-default' } as ThemeProfileV2

  assert.equal(
    resolveThemePlayerBarMode({ kind: 'user', id: 'user:aurora' }, auroraProfile),
    'compact'
  )
  assert.equal(
    resolveThemePlayerBarMode({ kind: 'user', id: 'user:standard' }, standardProfile),
    'standard'
  )
  assert.equal(resolveThemePlayerBarMode({ kind: 'user', id: 'user:missing' }), null)
})
