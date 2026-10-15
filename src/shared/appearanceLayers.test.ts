import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultAppearanceLayers, normalizeAppearanceLayers } from './appearanceLayers.ts'
import {
  cloneAppearance,
  defaultCardAppearance,
  normalizeAppBackgroundSettings
} from './appAppearance.ts'
import { DEFAULT_LIQUID_GLASS } from './liquidGlass.ts'
import {
  normalizeThemeProfile,
  normalizeStructuredPluginTheme,
  themeProfilesHaveSameEditableState,
  TWILIGHT_DEFAULT_THEME_ID
} from './theme.ts'

test('part materials survive persistence and bound their independent tone parameters', () => {
  const layers = normalizeAppearanceLayers({
    scopes: {
      card: {
        dark: {
          material: { mode: 'liquidGlass', opacity: 68, blur: 17, saturation: 122, refraction: 4 }
        }
      },
      controls: {
        light: {
          material: {
            mode: 'frosted',
            opacity: 110,
            blur: -2,
            saturation: 999,
            refraction: Infinity
          }
        }
      },
      navigation: { dark: { material: { mode: 'unknown' } } }
    }
  })
  assert.deepEqual(layers.scopes.card.dark.material, {
    mode: 'liquidGlass',
    colorSource: 'auto',
    color: '#202226',
    opacity: 68,
    blur: 17,
    saturation: 122,
    refraction: 4
  })
  assert.deepEqual(layers.scopes.controls.light.material, {
    mode: 'frosted',
    colorSource: 'auto',
    color: '#ffffff',
    opacity: 100,
    blur: 0,
    saturation: 180,
    refraction: 2
  })
  assert.equal(layers.scopes.navigation.dark.material.mode, 'theme')
  assert.equal(layers.scopes.card.light.material.mode, 'theme')
  assert.deepEqual(normalizeAppearanceLayers(JSON.parse(JSON.stringify(layers))), layers)
  layers.scopes.card.dark.material.blur = 33
  assert.equal(layers.scopes.card.light.material.blur, 20)
  assert.equal(layers.scopes.navigation.dark.material.blur, 20)
})

test('old settings keep their appearance and both channels normalize independently', () => {
  const layers = normalizeAppearanceLayers({
    innerRadius: Infinity,
    scopes: {
      controls: {
        dark: {
          body: { enabled: true, opacity: -40, color: 'url(private)' },
          effect: {
            enabled: true,
            opacity: 150,
            spread: NaN,
            blur: 500,
            motion: 'breathe',
            placement: 'outside',
            color: '#12AB34'
          }
        }
      }
    }
  })
  assert.equal(layers.innerRadius, 8)
  assert.deepEqual(layers.scopes.controls.dark.body, {
    enabled: true,
    opacity: 0,
    color: '#202226'
  })
  assert.equal(layers.scopes.controls.dark.effect.opacity, 100)
  assert.equal(layers.scopes.controls.dark.effect.blur, 64)
  assert.equal(layers.scopes.controls.dark.effect.color, '#12ab34')
  assert.equal(layers.scopes.controls.dark.effect.image, '')
  assert.equal(layers.scopes.controls.dark.effect.imageScale, 100)
  assert.equal(layers.scopes.controls.dark.effect.imageX, 0)
  assert.equal(layers.scopes.controls.dark.effect.imageY, 0)
  assert.equal(layers.scopes.controls.light.body.enabled, false)
  assert.equal(layers.scopes['inner-panel'].dark.body.enabled, false)
  assert.deepEqual(normalizeAppearanceLayers(JSON.parse(JSON.stringify(layers))), layers)
})

test('uploaded image handles and bounded image geometry survive normalization', () => {
  const image = 'background://a01234567890abcdef012345.png'
  const layers = normalizeAppearanceLayers({
    scopes: {
      controls: {
        light: {
          effect: {
            enabled: true,
            image,
            imageScale: 200,
            imageX: -25,
            imageY: 40,
            opacity: 72,
            placement: 'outside'
          }
        },
        dark: { effect: { image, imageScale: 5000, imageX: -300, imageY: 300 } }
      }
    }
  })
  const effect = layers.scopes.controls.light.effect
  assert.equal(effect.image, image)
  assert.equal(effect.imageScale, 200)
  assert.equal(effect.imageX, -25)
  assert.equal(effect.imageY, 40)
  assert.equal(effect.opacity, 72)
  assert.equal(effect.placement, 'outside')
  assert.equal(layers.scopes.controls.dark.effect.imageScale, 300)
  assert.equal(layers.scopes.controls.dark.effect.imageX, -100)
  assert.equal(layers.scopes.controls.dark.effect.imageY, 100)
  assert.deepEqual(normalizeAppearanceLayers(JSON.parse(JSON.stringify(layers))), layers)

  for (const invalid of [
    'https://example.com/image.png',
    'file:///private/image.png',
    'background://../private.png',
    'background://valid.png?query=1',
    'javascript:alert(1)',
    'data:image/png;base64,AA=='
  ]) {
    const normalized = normalizeAppearanceLayers({
      scopes: {
        controls: {
          light: { effect: { image: invalid, imageScale: NaN, imageX: Infinity, imageY: null } }
        }
      }
    }).scopes.controls.light.effect
    assert.equal(normalized.image, '', invalid)
    assert.equal(normalized.imageScale, 100)
    assert.equal(normalized.imageX, 0)
    assert.equal(normalized.imageY, 0)
  }
})

test('component skins normalize safe assets, UV frames and independent fit geometry', () => {
  const defaults = defaultAppearanceLayers()
  assert.deepEqual(defaults.scopes['player-bar'].dark.skin, {
    enabled: false,
    image: '',
    opacity: 100,
    scale: 100,
    x: 0,
    y: 0,
    placement: 'outside',
    fit: 'fill',
    frame: { top: 0, right: 0, bottom: 0, left: 0 }
  })
  const layers = normalizeAppearanceLayers({
    scopes: {
      'player-bar': {
        dark: {
          skin: {
            enabled: true,
            image: 'background://skin-with-alpha.png',
            opacity: 140,
            scale: 400,
            x: -400,
            y: 200,
            placement: 'inside',
            fit: 'cover',
            frame: { top: 50, right: -2, bottom: Infinity, left: 12.5 }
          }
        }
      }
    }
  })
  assert.deepEqual(layers.scopes['player-bar'].dark.skin, {
    enabled: true,
    image: 'background://skin-with-alpha.png',
    opacity: 100,
    scale: 300,
    x: -100,
    y: 100,
    placement: 'inside',
    fit: 'cover',
    frame: { top: 45, right: 0, bottom: 0, left: 12.5 }
  })
  assert.deepEqual(normalizeAppearanceLayers(JSON.parse(JSON.stringify(layers))), layers)
  layers.scopes['player-bar'].dark.skin.frame.left = 20
  assert.equal(layers.scopes['player-bar'].light.skin.frame.left, 0)
  assert.equal(layers.scopes.card.dark.skin.frame.left, 0)
})

test('skin assets reject remote, executable and private paths without accepting invalid geometry', () => {
  for (const image of [
    'https://example.com/image.png',
    'file:///private/image.png',
    'background://../private.png',
    'background://valid.png?query=1',
    'background://valid.png#fragment',
    'javascript:alert(1)',
    'data:image/png;base64,AA=='
  ]) {
    const skin = normalizeAppearanceLayers({
      scopes: {
        'player-bar': {
          light: {
            skin: {
              image,
              scale: NaN,
              opacity: Infinity,
              x: null,
              y: '20',
              fit: 'stretch',
              frame: { top: '20' }
            }
          }
        }
      }
    }).scopes['player-bar'].light.skin
    assert.equal(skin.image, '', image)
    assert.equal(skin.scale, 100)
    assert.equal(skin.opacity, 100)
    assert.equal(skin.x, 0)
    assert.equal(skin.y, 0)
    assert.equal(skin.fit, 'fill')
    assert.equal(skin.frame.top, 0)
  }
})

test('legacy component images migrate once while controls and explicit skin choices remain intact', () => {
  const effect = {
    enabled: true,
    image: 'background://legacy-panel.png',
    imageScale: 150,
    imageX: -12,
    imageY: 30,
    opacity: 64,
    placement: 'inside'
  }
  const layers = normalizeAppearanceLayers({
    scopes: {
      'player-bar': { dark: { effect }, light: { effect, skin: { enabled: false } } },
      controls: { dark: { effect } },
      card: { dark: { effect: { enabled: true, color: '#123456' } } }
    }
  })
  assert.deepEqual(layers.scopes['player-bar'].dark.skin, {
    enabled: true,
    image: effect.image,
    scale: 150,
    x: -12,
    y: 30,
    opacity: 64,
    placement: 'inside',
    fit: 'contain',
    frame: { top: 0, right: 0, bottom: 0, left: 0 }
  })
  assert.equal(layers.scopes['player-bar'].dark.effect.enabled, false)
  assert.equal(layers.scopes['player-bar'].light.skin.enabled, false)
  assert.equal(layers.scopes['player-bar'].light.skin.image, '')
  assert.equal(layers.scopes.controls.dark.skin.enabled, false)
  assert.equal(layers.scopes.controls.dark.effect.image, effect.image)
  assert.equal(layers.scopes.card.dark.effect.enabled, true)
  assert.equal(layers.scopes.card.dark.effect.color, '#123456')
  assert.deepEqual(normalizeAppearanceLayers(JSON.parse(JSON.stringify(layers))), layers)
})

test('structured theme plugins can carry independent channels without losing alpha or old contracts', () => {
  const appearanceLayers = defaultAppearanceLayers()
  appearanceLayers.scopes.controls.dark.effect.enabled = true
  appearanceLayers.scopes.controls.dark.effect.image = 'background://theme-image.png'
  appearanceLayers.scopes.controls.dark.effect.imageScale = 180
  appearanceLayers.scopes.controls.dark.body.opacity = 0
  const theme = normalizeStructuredPluginTheme({ schemaVersion: 3, appearanceLayers })
  assert.equal(theme?.schemaVersion, 3)
  assert.deepEqual(theme?.schemaVersion === 3 && theme.appearanceLayers, appearanceLayers)
  assert.equal(normalizeStructuredPluginTheme({ schemaVersion: 1, appearanceLayers }), undefined)
  assert.equal(
    normalizeStructuredPluginTheme({ schemaVersion: 3, appearanceLayers: 'invalid' }),
    undefined
  )
})
test('layer drafts, personal themes and theme version comparisons preserve independent channels', () => {
  const settings = {
    appBackground: normalizeAppBackgroundSettings({}),
    cardAppearance: defaultCardAppearance(),
    liquidGlass: DEFAULT_LIQUID_GLASS,
    surfaceMaterial: 'standard' as const,
    appearanceLayers: defaultAppearanceLayers()
  }
  const draft = cloneAppearance(settings)
  draft.appearanceLayers!.scopes.controls.dark.effect.enabled = true
  draft.appearanceLayers!.scopes.controls.dark.effect.motion = 'drift'
  draft.appearanceLayers!.scopes.controls.dark.effect.image = 'background://personal-image.png'
  draft.appearanceLayers!.scopes.controls.dark.effect.imageX = 20
  draft.appearanceLayers!.scopes['inner-panel'].light.body.opacity = 20
  Object.assign(draft.appearanceLayers!.scopes['player-bar'].dark.skin, {
    enabled: true,
    image: 'background://personal-skin.png',
    scale: 135,
    x: -12,
    y: 18,
    opacity: 76,
    fit: 'contain',
    frame: { top: 24, right: 8, bottom: 12, left: 8 }
  })
  assert.equal(settings.appearanceLayers.scopes.controls.dark.effect.enabled, false)
  const profile = normalizeThemeProfile({
    schemaVersion: 2,
    id: 'my-layers',
    name: 'Layers',
    baseThemeId: TWILIGHT_DEFAULT_THEME_ID,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    overrides: {},
    modes: {},
    appearanceLayers: draft.appearanceLayers
  })!
  const saved = normalizeThemeProfile(JSON.parse(JSON.stringify(profile)))!
  assert.deepEqual(saved.appearanceLayers, draft.appearanceLayers)
  assert.ok(themeProfilesHaveSameEditableState(profile, saved))
  saved.appearanceLayers!.scopes['player-bar'].dark.skin.frame.top = 25
  assert.ok(!themeProfilesHaveSameEditableState(profile, saved))
  saved.appearanceLayers!.scopes['player-bar'].dark.skin.frame.top = 24
  saved.appearanceLayers!.scopes.controls.dark.effect.imageX = 21
  assert.ok(!themeProfilesHaveSameEditableState(profile, saved))
})
