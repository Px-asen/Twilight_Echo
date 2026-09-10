import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  APP_FONT_FAMILIES,
  APP_FONT_FAMILY_STACKS,
  APP_FONT_SYSTEM,
  APP_FONT_VARIABLES,
  appFontCssVariables,
  normalizeAppFontFamily,
  resolveAppFontStack
} from './appFont.ts'

test('installed font names survive normalization and use the CJK fallback stack', () => {
  assert.equal(normalizeAppFontFamily('local:霞鹜文楷'), 'local:霞鹜文楷')
  assert.match(resolveAppFontStack('local:霞鹜文楷')!, /^"霞鹜文楷",/)
  assert.match(resolveAppFontStack('local:Arial')!, /MiSans/)
  assert.equal(normalizeAppFontFamily('local:x"; color: red'), 'system')
  assert.equal(normalizeAppFontFamily('local:   '), 'system')
})

test('the default global font contributes no override, so themed typography survives', () => {
  assert.equal(resolveAppFontStack(APP_FONT_SYSTEM), null)
  assert.deepEqual(appFontCssVariables(APP_FONT_SYSTEM), {})
  // A stored value from a future build, or a hand-edited settings file, must
  // degrade to the theme font instead of reaching CSS as a bare identifier.
  for (const value of [
    '',
    '   ',
    'Segoe UI',
    'sans-serif',
    'red; font-size: 99px',
    null,
    undefined,
    42,
    {}
  ]) {
    assert.equal(normalizeAppFontFamily(value), APP_FONT_SYSTEM)
    assert.equal(resolveAppFontStack(value), null)
  }
})

test('every picker value resolves to a stack that keeps CJK coverage', () => {
  for (const family of APP_FONT_FAMILIES) {
    if (family === APP_FONT_SYSTEM) continue
    const stack = resolveAppFontStack(family)
    assert.equal(typeof stack, 'string', `${family} must resolve to a stack`)
    assert.equal(stack, APP_FONT_FAMILY_STACKS[family])
    // Latin-only faces would otherwise fall through to SimSun for Chinese text.
    assert.match(stack as string, /'MiSans'/, `${family} must keep the packaged CJK subsets`)
    assert.match(stack as string, /'Microsoft YaHei'/, `${family} must keep a system CJK fallback`)
    assert.match(stack as string, /sans-serif$/, `${family} must end on a generic family`)
  }
})

test('the picked family leads its own stack', () => {
  assert.match(APP_FONT_FAMILY_STACKS.inter, /^'Inter',/)
  assert.match(APP_FONT_FAMILY_STACKS.lxgw, /^'LXGW WenKai',/)
  assert.match(APP_FONT_FAMILY_STACKS.sarasa, /^'Sarasa Gothic SC',/)
  assert.match(APP_FONT_FAMILY_STACKS.comic, /^'Comic Sans MS',/)
  // The Chinese aliases matter: Windows registers these families under their
  // localized names, so an English-only stack silently misses the install.
  assert.match(APP_FONT_FAMILY_STACKS.lxgw, /'霞鹜文楷'/)
  assert.match(APP_FONT_FAMILY_STACKS.sarasa, /'更纱黑体 SC'/)
})

test('an explicit choice overrides body, title, and rounded typography together', () => {
  // Overriding only --te-font-sans is the regression this covers: titles and
  // rounded chrome would stay on the theme font and the setting would look dead.
  assert.deepEqual(
    [...APP_FONT_VARIABLES],
    ['--te-font-sans', '--te-font-display', '--te-font-rounded']
  )

  const variables = appFontCssVariables('lxgw')
  assert.deepEqual(Object.keys(variables).sort(), [...APP_FONT_VARIABLES].sort())
  for (const name of APP_FONT_VARIABLES) {
    assert.equal(variables[name], APP_FONT_FAMILY_STACKS.lxgw)
  }
})

test('stacks stay safe to inline into a css declaration block', () => {
  for (const stack of Object.values(APP_FONT_FAMILY_STACKS)) {
    assert.doesNotMatch(stack, /[;{}]|\/\*|\\/)
    // Family names have to stay quoted, or a multi-word name breaks the value.
    for (const family of stack.split(',').map((part) => part.trim())) {
      if (/\s/.test(family)) assert.match(family, /^'[^']+'$/, `${family} must be quoted`)
    }
  }
})
