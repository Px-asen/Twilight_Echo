import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveThemePlayerBarMode } from './themePlayerBar.ts'
import type { ThemeProfileV2 } from './theme.ts'

test('built-in themes use compact only for the aurora reference layout', () => {
  assert.equal(
    resolveThemePlayerBarMode({ kind: 'builtin', id: 'builtin:aurora-reference' }),
    'compact'
  )
  assert.equal(
    resolveThemePlayerBarMode({ kind: 'builtin', id: 'builtin:twilight-echo-default' }),
    'standard'
  )
  assert.equal(
    resolveThemePlayerBarMode({ kind: 'builtin', id: 'builtin:paper-light' }),
    'standard'
  )
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
