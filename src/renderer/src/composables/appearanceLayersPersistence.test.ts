import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cloneAppearance,
  defaultCardAppearance,
  normalizeAppBackgroundSettings
} from '../../../shared/appAppearance.ts'
import { DEFAULT_LIQUID_GLASS } from '../../../shared/liquidGlass.ts'
import { normalizeThemeProfile, TWILIGHT_DEFAULT_THEME_ID } from '../../../shared/theme.ts'
import { persistAppearanceLayers } from './appearanceLayersPersistence.ts'
function createThemeProfileV2(id: string, name: string) {
  return normalizeThemeProfile({
    schemaVersion: 2,
    id,
    name,
    baseThemeId: TWILIGHT_DEFAULT_THEME_ID,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    overrides: {},
    modes: {}
  })!
}
function defaultDraft() {
  return cloneAppearance({
    appBackground: normalizeAppBackgroundSettings({}),
    cardAppearance: defaultCardAppearance(),
    liquidGlass: DEFAULT_LIQUID_GLASS,
    surfaceMaterial: 'standard'
  })
}

test('personal theme layers save to that profile without changing other themes or global layers', async () => {
  const settings = defaultDraft()
  const profile = createThemeProfileV2('skin', 'Personal skin')
  const draft = cloneAppearance(settings)
  draft.appearanceLayers!.scopes.controls.dark.effect.enabled = true
  const saved: unknown[] = [],
    patches: unknown[] = []
  await persistAppearanceLayers(draft, {
    settings,
    profile,
    saveProfile: async (value) => {
      saved.push(value)
    },
    updateSettings: async (value) => {
      patches.push(value)
    }
  })
  assert.equal(saved.length, 1)
  assert.equal(patches.length, 0)
  assert.equal(
    (saved[0] as typeof profile).appearanceLayers!.scopes.controls.dark.effect.enabled,
    true
  )
  assert.equal(settings.appearanceLayers!.scopes.controls.dark.effect.enabled, false)
  assert.equal(profile.appearanceLayers, undefined)
})
test('built-in settings save globally and retained personal layers do not trigger an extra write', async () => {
  const settings = defaultDraft()
  const draft = cloneAppearance(settings)
  draft.appearanceLayers!.innerRadius = 16
  let globalWrites = 0
  await persistAppearanceLayers(draft, {
    settings,
    profile: null,
    saveProfile: async () => assert.fail('unexpected profile'),
    updateSettings: async () => {
      globalWrites++
    }
  })
  const profile = {
    ...createThemeProfileV2('skin', 'Personal'),
    appearanceLayers: draft.appearanceLayers
  }
  await persistAppearanceLayers(draft, {
    settings,
    profile,
    saveProfile: async () => assert.fail('duplicate profile save'),
    updateSettings: async () => assert.fail('duplicate settings save')
  })
  assert.equal(globalWrites, 1)
})
test('layer save failure stops other writes and partial success is reported accurately', async () => {
  const settings = defaultDraft(),
    draft = cloneAppearance(settings),
    profile = createThemeProfileV2('skin', 'Personal')
  draft.appearanceLayers!.innerRadius = 24
  draft.surfaceMaterial = 'transparent'
  await assert.rejects(
    persistAppearanceLayers(draft, {
      settings,
      profile,
      saveProfile: async () => {
        throw Error('theme save failed')
      },
      updateSettings: async () => assert.fail('settings write after failure')
    }),
    /theme save failed/
  )
  await assert.rejects(
    persistAppearanceLayers(draft, {
      settings,
      profile,
      saveProfile: async () => undefined,
      updateSettings: async (patch) => {
        assert.equal(patch.appearanceLayers, undefined)
        throw Error('settings save failed')
      }
    }),
    /主题图层已保存.*settings save failed/
  )
})

test('tone-only and combined appearance changes persist in one settings update for every theme source', async () => {
  for (const profile of [null, createThemeProfileV2('skin', 'Personal')]) {
    const settings = defaultDraft()
    const patches: Array<{ theme?: string; appearanceLayers?: unknown }> = []
    await persistAppearanceLayers(cloneAppearance(settings), {
      settings,
      profile,
      theme: 'dark',
      saveProfile: async () => assert.fail('a tone change must not rewrite personal layers'),
      updateSettings: async (patch) => patches.push(patch)
    })
    assert.equal(patches.length, 1)
    assert.equal(patches[0].theme, 'dark')
    if (profile) assert.equal(patches[0].appearanceLayers, undefined)

    const draft = cloneAppearance(settings)
    draft.surfaceMaterial = 'transparent'
    await persistAppearanceLayers(draft, {
      settings,
      profile,
      theme: 'pureWhite',
      saveProfile: async () => assert.fail('unchanged personal layers must not be saved'),
      updateSettings: async (patch) => {
        assert.equal(patch.theme, 'pureWhite')
        assert.equal(patch.surfaceMaterial, 'transparent')
        patches.push(patch)
      }
    })
    assert.equal(patches.length, 2)
  }
})
