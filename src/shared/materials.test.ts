import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  MATERIAL_DECLARATIONS,
  MATERIAL_ROLES,
  compileMaterialCss,
  materialContract,
  resolveMaterialMode
} from './materials.ts'
import {
  isIndependentMaterial,
  addedMaterialDeclarations,
  validateMaterialRoles
} from '../../scripts/material-audit.ts'

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
test('new effects or duplicate recipes fail the migration guard', () => {
  assert.doesNotThrow(() =>
    validateMaterialRoles(
      `<div data-te-material="panel" :data-te-material="horizontal ? 'panel' : undefined" />`
    )
  )
  assert.throws(
    () => validateMaterialRoles('<div data-te-material="typo" />'),
    /unknown material role/
  )
  assert.equal(isIndependentMaterial('backdrop-filter', 'blur(20px) saturate(120%)'), true)
  assert.equal(isIndependentMaterial('backdrop-filter', 'var(--te-material-filter)'), false)
  assert.equal(isIndependentMaterial('box-shadow', '0 4px 24px #00000024'), true)
  assert.equal(
    isIndependentMaterial('background', 'color-mix(in srgb, var(--te-card-bg) 80%, transparent)'),
    true
  )
  assert.equal(isIndependentMaterial('background-color', '#202226'), true)
  assert.equal(isIndependentMaterial('background', 'rebeccapurple'), true)
  assert.equal(isIndependentMaterial('background', 'var(--te-material-background)'), false)
  const old = {
    file: 'panel.vue',
    selector: '.panel',
    property: 'box-shadow',
    value: '0 1px 2px black',
    count: 1
  }
  assert.equal(addedMaterialDeclarations([{ ...old, count: 2 }], [old]).length, 1)
  assert.equal(addedMaterialDeclarations([{ ...old, file: 'new-panel.vue' }], [old]).length, 1)
  assert.equal(addedMaterialDeclarations([], [old]).length, 0)
})
