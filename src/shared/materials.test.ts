import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  CARD_SURFACE_SELECTOR,
  DENSE_CARD_SURFACE_SELECTOR,
  DENSE_CARD_SURFACE_SELECTORS
} from './cardSurfaces.ts'
import {
  MATERIAL_DECLARATIONS,
  MATERIAL_FOUNDATION,
  MATERIAL_ROLES,
  compileMaterialCss,
  materialContract,
  resolveMaterialMode
} from './materials.ts'

test('default navigation samples the background without a dark overlay', () => {
  assert.equal(MATERIAL_FOUNDATION['--te-window-foundation-tint'], 'transparent')
  assert.equal(
    MATERIAL_FOUNDATION['--te-chrome-navigation-surface'],
    'var(--te-window-foundation-tint)'
  )
})

test('optics belong to chrome; reading surfaces and flat transport cannot acquire them', () => {
  for (const role of MATERIAL_ROLES) {
    assert.equal(
      resolveMaterialMode(role, { mode: 'liquidGlass' }),
      MATERIAL_DECLARATIONS[role].optical ? 'liquidGlass' : 'standard'
    )
    for (const flag of [
      'blurDisabled',
      'reducedEffects',
      'reducedTransparency',
      'increasedContrast',
      'forcedColors'
    ] as const) {
      assert.equal(resolveMaterialMode(role, { mode: 'liquidGlass', [flag]: true }), 'standard')
      assert.equal(resolveMaterialMode(role, { mode: 'transparent', [flag]: true }), 'standard')
    }
  }
  for (const role of ['dialog', 'popover', 'panel', 'control'] as const)
    assert.equal(resolveMaterialMode(role, { mode: 'transparent' }), 'standard')
  assert.equal(
    resolveMaterialMode('transport', { mode: 'liquidGlass', flatTransport: true }),
    'standard'
  )
  assert.equal(resolveMaterialMode('titlebar', { immersive: true }), 'transparent')
})
test('CSS and plugin manifests are generated from the same contract', async () => {
  assert.equal(
    await readFile(new URL('../renderer/src/assets/materials.css', import.meta.url), 'utf8'),
    compileMaterialCss()
  )
  assert.deepEqual(
    JSON.parse(
      await readFile(
        new URL('../../packages/plugin-api/material-contract.json', import.meta.url),
        'utf8'
      )
    ),
    materialContract()
  )
})

test('dense card surface selectors stay single-class (0,1,0) and keep hero/panel surfaces frosted', () => {
  assert.ok(DENSE_CARD_SURFACE_SELECTORS.length > 0)
  assert.equal(DENSE_CARD_SURFACE_SELECTOR, DENSE_CARD_SURFACE_SELECTORS.join(',\n'))

  const cardSurfaceSet = new Set(CARD_SURFACE_SELECTOR.split(','))
  const nonCardSurfaceDenseSelectors = new Set([
    '.playlist-grid-card',
    '.playlist-list-item',
    '.market-card'
  ])

  for (const selector of DENSE_CARD_SURFACE_SELECTORS) {
    assert.match(selector, /^\.[a-z0-9-]+$/i, `expected single class (0,1,0) selector: ${selector}`)
    if (!nonCardSurfaceDenseSelectors.has(selector)) {
      assert.ok(
        cardSurfaceSet.has(selector),
        `expected dense selector ${selector} to belong to CARD_SURFACE_SELECTOR`
      )
    }
  }

  for (const frostedSelector of [
    '.online-hero',
    '.feature-card',
    '.favorites-card',
    '.detail-playlist-header',
    '.streaming-placeholder',
    '.empty-recommend',
    '.track-table-wrapper',
    '.profile-panel',
    '.liked-panel',
    '.profile-card',
    '.account-card'
  ]) {
    assert.equal(
      (DENSE_CARD_SURFACE_SELECTORS as readonly string[]).includes(frostedSelector),
      false,
      `hero/panel surface ${frostedSelector} must remain frosted`
    )
  }
})

test('compiled material CSS clears backdrop-filter on dense image cards after imageCards', () => {
  const css = compileMaterialCss()
  const appearanceStart = css.indexOf('@layer te-appearance {')
  assert.notEqual(appearanceStart, -1)

  const imageCardsIndex = css.indexOf(
    'backdrop-filter:var(--te-image-card-filter)!important',
    appearanceStart
  )
  assert.notEqual(imageCardsIndex, -1)

  const denseSelectorToken = `:is(${DENSE_CARD_SURFACE_SELECTOR}):is(html *)`
  const denseRuleStart = css.indexOf(denseSelectorToken, appearanceStart)
  assert.notEqual(denseRuleStart, -1)
  assert.ok(denseRuleStart > imageCardsIndex, 'denseImageCards must follow imageCards')

  const denseRuleEnd = css.indexOf('}', denseRuleStart)
  assert.notEqual(denseRuleEnd, -1)
  const denseRule = css.slice(denseRuleStart, denseRuleEnd + 1)

  assert.match(
    denseRule,
    /background-color:color-mix\(in srgb,var\(--te-image-control-surface\) 82%,transparent\)!important/
  )
  assert.match(denseRule, /border-color:color-mix\(in srgb,var\(--te-image-control-border\) 88%,/)
  assert.match(denseRule, /backdrop-filter:none!important/)
  assert.match(denseRule, /-webkit-backdrop-filter:none!important/)
  assert.doesNotMatch(denseRule, /box-shadow/)

  const transparentRuleIndex = css.indexOf(
    `html[data-te-surface-material='transparent'] :is(${CARD_SURFACE_SELECTOR})`,
    appearanceStart
  )
  assert.ok(
    transparentRuleIndex > denseRuleEnd,
    'transparent override must follow denseImageCards'
  )
})
