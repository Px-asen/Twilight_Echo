import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_LYRICS_APPEARANCE,
  DEFAULT_LYRICS_TEXT_STYLES,
  LYRICS_APPEARANCE_SCHEMA_VERSION,
  cloneLyricsAppearance,
  normalizeLyricsAppearance,
  patchLyricsTargetStyle,
  resolveCascadeSpeedFactor,
  syncLegacyLyricsAppearance
} from './lyricsAppearance.ts'

test('lyrics appearance migrates legacy lyric style settings into independent layers', () => {
  const normalized = normalizeLyricsAppearance(undefined, {
    lyricFontSize: 24,
    lyricAlign: 'left',
    lyricDimOpacity: 65
  })
  assert.equal(normalized.fontSize, 24)
  assert.equal(normalized.align, 'left')
  assert.equal(normalized.inactiveOpacity, 65)
  assert.equal(normalized.styles.normal.fontSize, 24)
  assert.equal(normalized.styles.active.fontSize, 24)
  assert.equal(normalized.styles.translation.fontSize, 24)
  // Romanization was rendered three px below the main text before it became a layer.
  assert.equal(normalized.styles.romanization.fontSize, 21)
  assert.equal(normalized.styles.normal.align, 'left')
  assert.equal(normalized.styles.active.align, 'left')
  assert.equal(normalized.styles.translation.align, 'left')
  assert.equal(normalized.styles.romanization.align, 'left')
})

test('lyrics appearance defaults to full lyrics mode without active lyric glow', () => {
  const defaults = normalizeLyricsAppearance(undefined)
  assert.equal(defaults.focusLineCount, 'all')
  assert.equal(defaults.styles.active.highlightEffect, 'none')
  assert.equal(normalizeLyricsAppearance({ focusLineCount: 3 }).focusLineCount, 3)
})

test('lyrics appearance migrates the previous default glow without overriding custom effects', () => {
  const migrated = normalizeLyricsAppearance({
    styles: {
      active: {
        highlightEffect: 'glow',
        highlightColor: '#fff8df',
        highlightIntensity: 32
      }
    }
  })
  const custom = normalizeLyricsAppearance({
    styles: {
      active: {
        highlightEffect: 'glow',
        highlightColor: '#abcdef',
        highlightIntensity: 60
      }
    }
  })
  const persistedToggle = normalizeLyricsAppearance({
    ...DEFAULT_LYRICS_APPEARANCE,
    schemaVersion: LYRICS_APPEARANCE_SCHEMA_VERSION,
    styles: {
      ...DEFAULT_LYRICS_APPEARANCE.styles,
      active: {
        ...DEFAULT_LYRICS_APPEARANCE.styles.active,
        highlightEffect: 'glow'
      }
    }
  })

  assert.equal(migrated.schemaVersion, LYRICS_APPEARANCE_SCHEMA_VERSION)
  assert.equal(migrated.styles.active.highlightEffect, 'none')
  assert.equal(custom.styles.active.highlightEffect, 'glow')
  assert.equal(persistedToggle.styles.active.highlightEffect, 'glow')
})

test('the retired default glow is not rewritten again when the schema moves past 2', () => {
  // Schema 2 already ran that one-time migration. A schema-2 profile that carries
  // the old glow values has therefore opted back in, and bumping to 3 must leave
  // it alone.
  const reselectedGlow = normalizeLyricsAppearance({
    schemaVersion: 2,
    styles: {
      active: {
        highlightEffect: 'glow',
        highlightColor: '#fff8df',
        highlightIntensity: 32
      }
    }
  })
  assert.equal(reselectedGlow.styles.active.highlightEffect, 'glow')
  assert.equal(reselectedGlow.schemaVersion, LYRICS_APPEARANCE_SCHEMA_VERSION)
})

test('lyrics appearance rejects invalid values and normalizes per-layer customization', () => {
  const normalized = normalizeLyricsAppearance({
    fontFamily: 'unknown',
    fontSize: 200,
    fontWeight: 550,
    lineHeight: 4,
    align: 'right',
    inactiveOpacity: 0,
    focusLineCount: 4,
    colorMode: 'custom',
    textColor: '#A0B1C2',
    activeColor: 'red',
    karaokeColor: '#abcdef',
    karaokeEnabled: false,
    styles: {
      normal: { fontSize: 80, align: 'right', opacity: 3, backgroundStyle: 'solid' },
      active: { fontWeight: 880, highlightEffect: 'outline', highlightIntensity: 140 },
      translation: { fontFamily: 'custom', customFontFamily: '  Noto Sans CJK SC  ' }
    }
  })

  assert.equal(normalized.fontSize, 48)
  assert.equal(normalized.fontWeight, 600)
  assert.equal(normalized.lineHeight, 2.8)
  assert.equal(normalized.align, 'right')
  assert.equal(normalized.inactiveOpacity, 10)
  assert.equal(normalized.colorMode, 'custom')
  assert.equal(normalized.textColor, '#a0b1c2')
  assert.equal(normalized.activeColor, DEFAULT_LYRICS_APPEARANCE.activeColor)
  assert.equal(normalized.karaokeColor, '#abcdef')
  assert.equal(normalized.karaokeEnabled, false)
  assert.equal(normalized.styles.normal.fontSize, 48)
  assert.equal(normalized.styles.normal.align, 'right')
  assert.equal(normalized.styles.normal.opacity, 10)
  assert.equal(normalized.styles.normal.backgroundStyle, 'solid')
  assert.equal(normalized.styles.active.fontWeight, 900)
  assert.equal(normalized.styles.active.highlightEffect, 'outline')
  assert.equal(normalized.styles.active.highlightIntensity, 100)
  assert.equal(normalized.styles.translation.fontFamily, 'custom')
  assert.equal(normalized.styles.translation.customFontFamily, 'Noto Sans CJK SC')
})

test('each style layer keeps its own font size', () => {
  const normalized = normalizeLyricsAppearance({
    schemaVersion: LYRICS_APPEARANCE_SCHEMA_VERSION,
    fontSize: 20,
    styles: {
      normal: { fontSize: 26 },
      active: { fontSize: 30 },
      translation: { fontSize: 14 },
      romanization: { fontSize: 12 }
    }
  })

  assert.equal(normalized.styles.normal.fontSize, 26)
  assert.equal(normalized.styles.active.fontSize, 30)
  assert.equal(normalized.styles.translation.fontSize, 14)
  assert.equal(normalized.styles.romanization.fontSize, 12)
  assert.equal(normalized.fontSize, 20, 'the legacy master size is kept for the quick controls')
})

test('schema 2 profiles upgrade without any visible change', () => {
  const schema2 = {
    schemaVersion: 2,
    fontFamily: 'lxgw',
    fontSize: 22,
    fontWeight: 700,
    lineHeight: 2,
    align: 'left',
    // Persisted but never rendered before schema 3, so it must not start dimming now.
    inactiveOpacity: 40,
    focusLineCount: 'all',
    colorMode: 'theme',
    textColor: '#ffffff',
    activeColor: '#ffffff',
    karaokeColor: '#fff8df',
    karaokeEnabled: true,
    styles: {
      normal: { fontSize: 22, fontWeight: 700, lineHeight: 2 },
      active: { fontSize: 22, fontWeight: 700, lineHeight: 1.7 },
      translation: { fontSize: 22, opacity: 82 }
    }
  }
  const upgraded = normalizeLyricsAppearance(schema2)

  assert.equal(upgraded.inactiveOpacity, DEFAULT_LYRICS_APPEARANCE.inactiveOpacity)
  assert.equal(upgraded.coverGap, DEFAULT_LYRICS_APPEARANCE.coverGap)
  assert.equal(upgraded.lyricsMaxWidth, DEFAULT_LYRICS_APPEARANCE.lyricsMaxWidth)
  assert.equal(upgraded.anchorPosition, DEFAULT_LYRICS_APPEARANCE.anchorPosition)
  assert.equal(upgraded.scaleIntensity, 100)
  assert.equal(upgraded.blurIntensity, 100)
  assert.equal(upgraded.cascadeSpeed, 50)
  assert.equal(upgraded.hidePassedLines, false)
  assert.equal(upgraded.styles.normal.fontSize, 22)
  assert.equal(upgraded.styles.active.lineHeight, 1.7)
  assert.equal(upgraded.styles.normal.letterSpacing, 0)
  assert.equal(upgraded.styles.normal.fontStyle, 'normal')
  assert.equal(upgraded.styles.romanization.fontFamily, 'lxgw')
})

test('a deliberately dimmed profile keeps its value across the upgrade', () => {
  const upgraded = normalizeLyricsAppearance({ schemaVersion: 2, inactiveOpacity: 55 })
  assert.equal(upgraded.inactiveOpacity, 55)
})

test('schema 3 default translations migrate to the compact auxiliary size', () => {
  const legacyDefaultTranslation = {
    ...DEFAULT_LYRICS_TEXT_STYLES.translation,
    fontSize: 18,
    lineHeight: 1.45
  }
  const upgraded = normalizeLyricsAppearance({
    schemaVersion: 3,
    inactiveOpacity: 40,
    styles: { translation: legacyDefaultTranslation }
  })
  const customized = normalizeLyricsAppearance({
    schemaVersion: 3,
    styles: { translation: { ...legacyDefaultTranslation, fontWeight: 700 } }
  })

  assert.equal(upgraded.styles.translation.fontSize, 14)
  assert.equal(upgraded.styles.translation.lineHeight, 1.3)
  assert.equal(upgraded.styles.romanization.fontSize, 13)
  assert.equal(upgraded.styles.romanization.lineHeight, 1.25)
  assert.equal(upgraded.inactiveOpacity, 40, 'schema 3 opacity was already a live user setting')
  assert.equal(customized.styles.translation.fontSize, 18)
})

test('schema 5 profiles with the legacy 35% anchor upgrade to the centered 50% default', () => {
  const upgraded = normalizeLyricsAppearance({
    schemaVersion: 5,
    anchorPosition: 0.35
  })
  assert.equal(upgraded.anchorPosition, 0.5)
  assert.equal(upgraded.schemaVersion, LYRICS_APPEARANCE_SCHEMA_VERSION)
})

test('layout, motion and typography knobs are clamped to their published ranges', () => {
  const normalized = normalizeLyricsAppearance({
    coverGap: 999,
    lyricsMaxWidth: 10,
    lyricsOffsetX: -500,
    coverSize: 400,
    coverRadius: -20,
    anchorPosition: 3,
    translationSpacing: 99,
    hidePassedLines: 'yes',
    scaleIntensity: -5,
    blurIntensity: 250,
    cascadeSpeed: 'fast',
    styles: {
      normal: { letterSpacing: 5, fontStyle: 'italic' },
      active: { letterSpacing: -9, fontStyle: 'oblique' }
    }
  })

  assert.equal(normalized.coverGap, 160)
  assert.equal(normalized.lyricsMaxWidth, 420)
  assert.equal(normalized.lyricsOffsetX, -400)
  assert.equal(normalized.coverSize, 110)
  assert.equal(normalized.coverRadius, 0)
  assert.equal(normalized.anchorPosition, 0.85)
  assert.equal(normalized.translationSpacing, 24)
  assert.equal(normalized.hidePassedLines, false, 'only a real boolean enables the mode')
  assert.equal(normalized.scaleIntensity, 0)
  assert.equal(normalized.blurIntensity, 100)
  assert.equal(normalized.cascadeSpeed, 50)
  assert.equal(normalized.styles.normal.letterSpacing, 0.4)
  assert.equal(normalized.styles.normal.fontStyle, 'italic')
  assert.equal(normalized.styles.active.letterSpacing, -0.05)
  assert.equal(normalized.styles.active.fontStyle, 'normal')
})

test('cascade speed maps its midpoint onto the built-in rhythm', () => {
  assert.equal(resolveCascadeSpeedFactor(50), 1)
  assert.ok(resolveCascadeSpeedFactor(100) < 1, 'a higher speed shortens the delay')
  assert.ok(resolveCascadeSpeedFactor(0) > 1, 'a lower speed lengthens the delay')
  assert.equal(resolveCascadeSpeedFactor(Number.NaN), 1)
})

test('cloning covers every style layer', () => {
  const source = cloneLyricsAppearance(DEFAULT_LYRICS_APPEARANCE)
  source.styles.romanization.fontSize = 16
  assert.equal(DEFAULT_LYRICS_APPEARANCE.styles.romanization.fontSize, 13)
})

test('legacy quick controls stay compatible with the independent style layers', () => {
  const synced = syncLegacyLyricsAppearance(cloneLyricsAppearance(DEFAULT_LYRICS_APPEARANCE), {
    fontSize: 22,
    fontFamily: 'lxgw',
    align: 'right',
    textColor: '#abcdef',
    activeColor: '#fedcba'
  })

  assert.equal(synced.styles.normal.fontSize, 22)
  assert.equal(synced.styles.active.fontSize, 22)
  assert.equal(synced.styles.translation.fontSize, 22)
  assert.equal(synced.styles.romanization.fontSize, 22)
  assert.equal(synced.styles.normal.fontFamily, 'lxgw')
  assert.equal(synced.styles.romanization.fontFamily, 'lxgw')
  assert.equal(synced.styles.active.align, 'right')
  assert.equal(synced.styles.translation.color, '#abcdef')
  assert.equal(synced.styles.romanization.color, '#abcdef')
  assert.equal(synced.styles.active.color, '#fedcba')
})

test('normal layer font edits cascade to coupled layers while preserving per-layer font overrides', () => {
  const fromSettings = syncLegacyLyricsAppearance(
    cloneLyricsAppearance(DEFAULT_LYRICS_APPEARANCE),
    { fontFamily: 'inter' }
  )
  const switchedInCustomizer = patchLyricsTargetStyle(fromSettings, 'normal', {
    fontFamily: 'lxgw'
  })

  assert.equal(switchedInCustomizer.fontFamily, 'lxgw')
  assert.equal(switchedInCustomizer.styles.normal.fontFamily, 'lxgw')
  assert.equal(switchedInCustomizer.styles.active.fontFamily, 'lxgw')
  assert.equal(switchedInCustomizer.styles.harmony.fontFamily, 'lxgw')
  assert.equal(switchedInCustomizer.styles.translation.fontFamily, 'lxgw')
  assert.equal(switchedInCustomizer.styles.romanization.fontFamily, 'lxgw')

  const withCustomTranslation = patchLyricsTargetStyle(switchedInCustomizer, 'translation', {
    fontFamily: 'sarasa'
  })
  assert.equal(withCustomTranslation.styles.translation.fontFamily, 'sarasa')
  assert.equal(withCustomTranslation.styles.normal.fontFamily, 'lxgw')
  assert.equal(withCustomTranslation.styles.active.fontFamily, 'lxgw')

  const normalToCustomLocal = patchLyricsTargetStyle(
    patchLyricsTargetStyle(withCustomTranslation, 'normal', { fontFamily: 'custom' }),
    'normal',
    { customFontFamily: 'Microsoft YaHei UI' }
  )
  assert.equal(normalToCustomLocal.fontFamily, 'custom')
  assert.equal(normalToCustomLocal.styles.normal.fontFamily, 'custom')
  assert.equal(normalToCustomLocal.styles.normal.customFontFamily, 'Microsoft YaHei UI')
  assert.equal(normalToCustomLocal.styles.active.fontFamily, 'custom')
  assert.equal(normalToCustomLocal.styles.active.customFontFamily, 'Microsoft YaHei UI')
  assert.equal(
    normalToCustomLocal.styles.translation.fontFamily,
    'sarasa',
    'a deliberately customized layer keeps its own font when normal changes'
  )

  const unified = syncLegacyLyricsAppearance(normalToCustomLocal, {
    fontFamily: normalToCustomLocal.styles.normal.fontFamily,
    customFontFamily: normalToCustomLocal.styles.normal.customFontFamily
  })
  assert.equal(unified.styles.translation.fontFamily, 'custom')
  assert.equal(unified.styles.translation.customFontFamily, 'Microsoft YaHei UI')
})
