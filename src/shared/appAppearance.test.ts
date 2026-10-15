import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyAppearancePreset,
  backgroundCssVariables,
  backgroundEffect,
  cloneAppearance,
  defaultCardAppearance,
  defaultBackgroundEffect,
  effectiveBackgroundEffect,
  hasBackgroundImage,
  normalizeAppBackgroundSettings,
  normalizeBackgroundEffect,
  normalizeBackgroundImagePalette,
  resolveBackgroundPalette,
  resolveBackgroundAppearance,
  resolveBackgroundTextTone,
  resolveBackground
} from './appAppearance.ts'
import { DEFAULT_LIQUID_GLASS } from './liquidGlass.ts'
import { themeContrastRatio } from './theme.ts'

test('legacy effects migrate per tone, and an explicit new profile wins without double application', () => {
  const legacy = {
    enabled: true,
    light: { blur: 12, brightness: 80, dim: 15 },
    dark: { blur: 20, brightness: 65, dim: 40 }
  }
  const migrated = normalizeAppBackgroundSettings({}, legacy)
  assert.equal(backgroundEffect(migrated.global, 'dark').dim, 40)
  assert.equal(backgroundEffect(resolveBackground(migrated, 'local'), 'light').blur, 12)
  const explicit = normalizeAppBackgroundSettings(
    { global: { effects: { dark: { dim: 3 } } } },
    legacy
  )
  assert.equal(backgroundEffect(explicit.global, 'dark').dim, 3)
  assert.equal(backgroundEffect(explicit.global, 'light').blur, 0)
  assert.deepEqual(normalizeAppBackgroundSettings(migrated, legacy), migrated)
})
test('background effects reject non-finite values, clamp bounds and keep safe asset handles', () => {
  const value = normalizeBackgroundEffect({
    blur: 100,
    brightness: NaN,
    scale: Infinity,
    dim: -2,
    positionX: 200,
    textTone: 'script'
  })
  assert.deepEqual(value, {
    blur: 30,
    brightness: 100,
    scale: 1,
    dim: 0,
    positionX: 100,
    positionY: 50,
    textTone: 'theme'
  })
  assert.equal(
    normalizeAppBackgroundSettings({ global: { image: 'file:///private.png' } }).global.image,
    ''
  )
  assert.equal(
    normalizeAppBackgroundSettings({ global: { image: 'background://wallpaper.webp' } }).global
      .image,
    'background://wallpaper.webp'
  )
})
test('page inheritance includes effects and independent pages survive settings round trips', () => {
  const background = normalizeAppBackgroundSettings({
    global: { kind: 'image', image: 'background://one.png', effects: { dark: { scale: 2 } } },
    pages: {
      settings: {
        inherit: false,
        kind: 'image',
        image: 'background://two.png',
        effects: { dark: { blur: 16, textTone: 'light' } }
      }
    }
  })
  assert.equal(resolveBackground(background, 'local').image, 'background://one.png')
  assert.equal(backgroundEffect(resolveBackground(background, 'local'), 'dark').scale, 2)
  assert.equal(backgroundEffect(resolveBackground(background, 'settings'), 'dark').blur, 16)
  assert.deepEqual(
    normalizeAppBackgroundSettings(JSON.parse(JSON.stringify(background))),
    background
  )
})

test('solid colors ignore dormant image tuning without changing the saved profile', () => {
  const settings = normalizeAppBackgroundSettings({
    global: {
      kind: 'color',
      customized: true,
      light: '#f4f4f7',
      effects: {
        light: {
          blur: 5,
          brightness: 80,
          dim: 16,
          scale: 2,
          positionX: 20,
          positionY: 30,
          textTone: 'dark'
        },
        dark: {
          blur: 9,
          brightness: 60,
          dim: 40,
          scale: 3,
          positionX: 80,
          positionY: 70,
          textTone: 'light'
        }
      }
    }
  })
  const saved = JSON.stringify(settings)
  for (const tone of ['light', 'dark'] as const) {
    const configured = backgroundEffect(settings.global, tone)
    const effective = effectiveBackgroundEffect(settings.global, tone)
    assert.deepEqual(effective, { ...defaultBackgroundEffect(), textTone: configured.textTone })
    const css = backgroundCssVariables(settings.global, tone)
    assert.equal(css['--appearance-color'], settings.global[tone])
    assert.equal(css['--appearance-image'], 'none')
    assert.equal(css['--appearance-blur'], '0px')
    assert.equal(css['--appearance-brightness'], '100%')
    assert.equal(css['--appearance-dim'], '0')
    assert.equal(css['--appearance-scale'], '1')
    assert.equal(css['--appearance-position'], '50% 50%')
    for (const page of ['app', 'local', 'settings', 'streaming', 'player'] as const) {
      const resolved = resolveBackgroundAppearance(settings, page, tone)
      assert.equal(resolved.background, settings.global)
      assert.equal(resolved.customBackground, true)
      assert.equal(resolved.colorOverride, true)
      assert.equal(resolved.imageOverride, true)
      assert.equal(resolved.hasImage, false)
      assert.deepEqual(resolved.effect, effective)
    }
  }
  assert.equal(JSON.stringify(settings), saved)
  settings.global.kind = 'image'
  settings.global.image = 'background://restored.png'
  assert.deepEqual(
    effectiveBackgroundEffect(settings.global, 'light'),
    backgroundEffect(settings.global, 'light')
  )
  assert.equal(backgroundCssVariables(settings.global, 'light')['--appearance-dim'], '0.16')
  settings.global.kind = 'color'
  assert.equal(backgroundCssVariables(settings.global, 'light')['--appearance-dim'], '0')
  assert.equal(backgroundEffect(settings.global, 'light').dim, 16)
})

test('default backgrounds and empty image slots leave theme colors and pictures in charge', () => {
  for (const global of [
    undefined,
    { kind: 'color', customized: false },
    {
      kind: 'image',
      image: '',
      customized: true,
      effects: { light: { dim: 60, blur: 30, textTone: 'light' } }
    },
    { kind: 'image', image: 'file:///private.png', customized: true }
  ]) {
    const settings = normalizeAppBackgroundSettings({ global })
    for (const tone of ['light', 'dark'] as const) {
      for (const page of ['app', 'local', 'settings', 'streaming', 'player'] as const) {
        const resolved = resolveBackgroundAppearance(settings, page, tone)
        assert.equal(resolved.customBackground, false)
        assert.equal(resolved.colorOverride, false)
        assert.equal(resolved.imageOverride, false)
        assert.equal(resolved.hasImage, false)
        assert.deepEqual(resolved.effect, defaultBackgroundEffect())
      }
    }
    assert.equal(backgroundCssVariables(settings.global, 'light')['--appearance-dim'], '0')
  }
  const sameColor = normalizeAppBackgroundSettings({ global: { kind: 'color', customized: true } })
  assert.equal(resolveBackgroundAppearance(sameColor, 'app', 'light').customBackground, true)
})

test('independent pages own explicit colors or images while empty slots return only that page to its theme', () => {
  const settings = normalizeAppBackgroundSettings({
    global: { kind: 'image', image: 'background://global.png', effects: { light: { dim: 16 } } },
    pages: {
      local: { inherit: false, kind: 'color', customized: false },
      settings: { inherit: false, kind: 'image', image: '', customized: true },
      streaming: {
        inherit: false,
        kind: 'image',
        image: 'background://page.png',
        effects: { light: { dim: 5 } }
      }
    }
  })
  const local = resolveBackgroundAppearance(settings, 'local', 'light')
  assert.equal(local.customBackground, true)
  assert.equal(local.hasImage, false)
  assert.equal(local.background.light, '#ffffff')
  assert.equal(local.effect.dim, 0)
  assert.equal(resolveBackgroundAppearance(settings, 'settings', 'light').customBackground, false)
  const streaming = resolveBackgroundAppearance(settings, 'streaming', 'light')
  assert.equal(streaming.hasImage, true)
  assert.equal(streaming.background.image, 'background://page.png')
  assert.equal(streaming.effect.dim, 5)
  assert.equal(resolveBackgroundAppearance(settings, 'player', 'light').effect.dim, 16)
  settings.pages.settings.inherit = true
  assert.equal(
    resolveBackgroundAppearance(settings, 'settings', 'light').background,
    settings.global
  )
  assert.equal(resolveBackgroundAppearance(settings, 'settings', 'light').effect.dim, 16)
})

test('legacy none and theme modes retain dormant settings and cannot become independent color overrides', () => {
  for (const kind of ['none', 'theme']) {
    const raw = {
      kind,
      customized: true,
      light: '#123456',
      dark: '#abcdef',
      image: 'background://saved.png',
      imagePalette: { image: 'background://saved.png', average: '#778899', accent: '#334455' },
      effects: { light: { dim: 45, blur: 20, textTone: 'light' } }
    }
    const settings = normalizeAppBackgroundSettings({
      global: raw,
      pages: { settings: { ...raw, inherit: false } }
    })
    assert.equal(settings.global.kind, 'theme')
    assert.equal(settings.global.customized, false)
    assert.equal(settings.global.light, raw.light)
    assert.equal(settings.global.image, raw.image)
    assert.equal(settings.global.imagePalette?.accent, raw.imagePalette.accent)
    assert.equal(backgroundEffect(settings.global, 'light').dim, 45)
    assert.equal(hasBackgroundImage(settings.global), false)
    assert.equal(resolveBackgroundAppearance(settings, 'settings', 'light').customBackground, false)
    assert.equal(resolveBackgroundPalette(settings.global, 'light'), null)
    assert.deepEqual(normalizeAppBackgroundSettings(JSON.parse(JSON.stringify(settings))), settings)
  }
})
test('transparent material preserves saved tuning and switching back restores the profile', () => {
  const original = cloneAppearance({
    appBackground: normalizeAppBackgroundSettings({}),
    cardAppearance: defaultCardAppearance(),
    liquidGlass: DEFAULT_LIQUID_GLASS,
    surfaceMaterial: 'standard'
  })
  const frosted = applyAppearancePreset(original, 'frosted')
  assert.equal(frosted.cardAppearance.dark.backgroundOpacity, 60)
  frosted.cardAppearance.dark.blurRadius = 9
  frosted.liquidGlass.dark.tintOpacity = 17
  const transparent = applyAppearancePreset(frosted, 'transparent')
  assert.equal(transparent.surfaceMaterial, 'transparent')
  assert.deepEqual(transparent.cardAppearance, frosted.cardAppearance)
  const restored = applyAppearancePreset(transparent, 'frosted')
  assert.equal(restored.cardAppearance.dark.blurRadius, 9)
  assert.equal(restored.liquidGlass.dark.tintOpacity, 17)
  assert.equal(original.cardAppearance.dark.backgroundOpacity, 100)
})

function sampledBackground(average: string, accent = average, opacity = 1) {
  return normalizeAppBackgroundSettings({
    global: {
      kind: 'image',
      image: 'background://sample.png',
      imagePalette: { image: 'background://sample.png', average, accent, opacity }
    }
  }).global
}

test('image palette normalization binds safe colors to their exact local image and survives inheritance', () => {
  const raw = { image: 'background://sample.png', average: '#FFFFFF', accent: '#CC2244' }
  assert.deepEqual(normalizeBackgroundImagePalette(raw, raw.image), {
    ...raw,
    average: '#ffffff',
    accent: '#cc2244',
    opacity: 1
  })
  assert.equal(normalizeBackgroundImagePalette(raw, 'background://other.png'), undefined)
  assert.equal(
    normalizeBackgroundImagePalette({ ...raw, accent: 'red;display:none' }, raw.image),
    undefined
  )
  assert.equal(
    normalizeBackgroundImagePalette(
      { ...raw, image: 'https://example.test/one.png' },
      'https://example.test/one.png'
    ),
    undefined
  )
  const settings = normalizeAppBackgroundSettings({
    global: sampledBackground('#eeeeee', '#cc2244')
  })
  assert.deepEqual(
    resolveBackground(settings, 'streaming').imagePalette,
    settings.global.imagePalette
  )
  assert.deepEqual(normalizeAppBackgroundSettings(JSON.parse(JSON.stringify(settings))), settings)
  const clone = cloneAppearance({
    appBackground: settings,
    cardAppearance: defaultCardAppearance(),
    liquidGlass: DEFAULT_LIQUID_GLASS,
    surfaceMaterial: 'standard'
  })
  clone.appBackground.global.imagePalette!.accent = '#112233'
  assert.equal(settings.global.imagePalette!.accent, '#cc2244')
})

test('automatic image text uses the composited brightness and dimming while manual text choices win', () => {
  const white = sampledBackground('#ffffff')
  const black = sampledBackground('#000000')
  assert.equal(resolveBackgroundTextTone(white, 'dark'), 'dark')
  assert.equal(resolveBackgroundTextTone(black, 'light'), 'light')
  const shaded = sampledBackground('#ffffff')
  shaded.effects!.light.dim = 80
  assert.equal(resolveBackgroundTextTone(shaded, 'light'), 'light')
  assert.equal(resolveBackgroundPalette(shaded, 'light')!.background, '#333333')
  shaded.effects!.light.dim = 0
  shaded.effects!.light.brightness = 50
  assert.equal(resolveBackgroundPalette(shaded, 'light')!.background, '#808080')
  assert.equal(resolveBackgroundTextTone(shaded, 'light'), 'dark')
  white.effects!.light.textTone = 'light'
  assert.equal(resolveBackgroundTextTone(white, 'light'), 'light')
  assert.equal(backgroundCssVariables(white, 'light')['--appearance-text'], '#f4f7fb')
  delete white.imagePalette
  white.effects!.light.textTone = 'theme'
  assert.equal(resolveBackgroundTextTone(white, 'light'), 'theme')
  assert.equal(resolveBackgroundPalette(white, 'light'), null)
})

test('transparent raster samples composite over the selected solid base', () => {
  const transparent = sampledBackground('#000000', '#000000', 0)
  transparent.light = '#ffffff'
  transparent.dark = '#000000'
  assert.equal(resolveBackgroundPalette(transparent, 'light')!.background, '#ffffff')
  assert.equal(resolveBackgroundPalette(transparent, 'dark')!.background, '#000000')
  assert.equal(resolveBackgroundTextTone(transparent, 'light'), 'dark')
  assert.equal(resolveBackgroundTextTone(transparent, 'dark'), 'light')
  transparent.image = 'background://replacement.png'
  assert.equal(resolveBackgroundPalette(transparent, 'dark'), null)
})

test('derived control colors retain readable foregrounds across images, tones and interaction states', () => {
  for (const average of [
    '#000000',
    '#ffffff',
    '#777777',
    '#ff0000',
    '#00ff00',
    '#0000ff',
    '#fcdd88'
  ]) {
    const background = sampledBackground(average)
    for (const tone of ['light', 'dark'] as const) {
      const palette = resolveBackgroundPalette(background, tone)!
      const channels = palette.controlBackground
        .slice(1)
        .match(/../g)!
        .map((value) => parseInt(value, 16))
      assert.ok(
        tone === 'light' ? Math.min(...channels) > 220 : Math.max(...channels) < 50,
        `painted surfaces must retain ${tone} mode over ${average}: ${palette.controlBackground}`
      )
      assert.ok((themeContrastRatio(palette.text, palette.background) ?? 0) >= 4.5, average)
      assert.ok((themeContrastRatio(palette.muted, palette.background) ?? 0) >= 4.5, average)
      for (const surface of [
        palette.controlBackground,
        palette.controlHover,
        palette.controlActive
      ])
        assert.ok((themeContrastRatio(palette.controlForeground, surface) ?? 0) >= 4.5, average)
      assert.ok((themeContrastRatio(palette.onAccent, palette.accent) ?? 0) >= 4.5, average)
      for (const fade of [0.66, 0.68, 0.7, 0.8, 1]) {
        for (const extreme of [0, 255]) {
          const readingBackground =
            '#' +
            channels
              .map((channel) =>
                Math.round(channel * fade + extreme * (1 - fade))
                  .toString(16)
                  .padStart(2, '0')
              )
              .join('')
          for (const ink of [palette.readingText, palette.readingMuted])
            assert.ok(
              (themeContrastRatio(ink, readingBackground) ?? 0) >= 4.5,
              JSON.stringify({ tone, average, fade, ink, readingBackground })
            )
        }
      }
      const variables = backgroundCssVariables(background, tone)
      assert.equal(variables['--appearance-control-surface'], palette.controlBackground)
      assert.equal(variables['--appearance-control-text'], palette.controlForeground)
    }
  }
  const red = resolveBackgroundPalette(sampledBackground('#eeeeee', '#f02030'), 'light')!
  const blue = resolveBackgroundPalette(sampledBackground('#eeeeee', '#2040f0'), 'light')!
  assert.notEqual(red.controlBackground, blue.controlBackground)
})
