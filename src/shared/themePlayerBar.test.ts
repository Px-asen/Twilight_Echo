import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveThemePlayerBarMode, sharedPlayerBarStylesheet } from './themePlayerBar.ts'
import type { ThemeProfileV2 } from './theme.ts'

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
