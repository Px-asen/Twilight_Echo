import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import {
  defaultAppearanceLayers,
  normalizeAppearanceLayers
} from '../../shared/appearanceLayers.ts'
import { loadSettingsFile, writeSettingsFile } from './settingsFile.ts'
test('panel skins, UV frames and legacy color channels survive a real settings file round trip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-layer-settings-'))
  try {
    const file = join(directory, 'settings.json')
    const defaults = { appearanceLayers: defaultAppearanceLayers() }
    const normalize = (raw: Partial<typeof defaults>) => ({
      appearanceLayers: normalizeAppearanceLayers(raw.appearanceLayers)
    })
    writeSettingsFile(file, {})
    assert.deepEqual(loadSettingsFile(file, defaults, normalize).settings, defaults)
    const layers = defaultAppearanceLayers()
    layers.innerRadius = 24
    layers.scopes.controls.dark.effect.enabled = true
    layers.scopes.controls.dark.effect.motion = 'breathe'
    layers.scopes.controls.dark.effect.image = 'background://a01234567890abcdef012345.png'
    layers.scopes.controls.dark.effect.imageScale = 175
    layers.scopes.controls.dark.effect.imageX = -20
    layers.scopes.controls.dark.effect.imageY = 35
    layers.scopes.controls.dark.effect.opacity = 65
    layers.scopes.controls.dark.effect.placement = 'outside'
    layers.scopes['outer-panel'].light.body.enabled = true
    layers.scopes['outer-panel'].light.body.opacity = 0
    layers.scopes['player-bar'].dark.skin = {
      enabled: true,
      image: 'background://b01234567890abcdef012345.png',
      opacity: 76,
      scale: 135,
      x: -12,
      y: 18,
      placement: 'outside',
      fit: 'contain',
      frame: { top: 24, right: 8, bottom: 12, left: 8 }
    }
    layers.scopes['inner-panel'].light.skin = {
      ...layers.scopes['inner-panel'].light.skin,
      enabled: true,
      image: 'background://c01234567890abcdef012345.png',
      placement: 'inside',
      fit: 'cover'
    }
    writeSettingsFile(file, { appearanceLayers: layers })
    assert.deepEqual(loadSettingsFile(file, defaults, normalize).settings.appearanceLayers, layers)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-layer-settings-'))
    await rm(directory, { recursive: true, force: true })
  }
})
