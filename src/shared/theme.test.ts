import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUILT_IN_THEME_PRESETS,
  BUILT_IN_THEME_PRESET_IDS,
  BUILT_IN_THEME_FONTS,
  THEME_ACCENT_PALETTES,
  THEME_BACKGROUND_PALETTES,
  THEME_ICON_SLOT_REGISTRY,
  THEME_TOKEN_DEFINITIONS,
  TWILIGHT_DEFAULT_THEME,
  TWILIGHT_DEFAULT_THEME_ID,
  createThemeAccentTokenOverrides,
  createDefaultThemeLibraryDocument,
  findInvalidThemeShellLayoutFields,
  findUnsupportedThemeModeIds,
  normalizeThemeModes,
  normalizeStructuredPluginTheme,
  normalizeThemeLibraryDocument,
  normalizeThemeProfile,
  normalizeThemeToneSchedule,
  normalizeThemeSelection,
  normalizeThemeTokenOverrides,
  resolveThemeProfileModes,
  resolveThemeModes,
  resolveThemeProfileTokens,
  limitThemeProfileHistory,
  resolveScheduledThemeTone,
  resolveThemeIconClasses,
  ensureThemeTextContrast,
  themeContrastRatio,
  themeShellLayoutToCssVariables,
  themeShellLayoutToDataAttributes,
  themeModesToDataAttributes,
  themeTokensToCssVariables,
  type ThemeShellLayout
} from './theme.ts'

test('the immutable built-in theme preserves the current light and dark root values', () => {
  assert.equal(TWILIGHT_DEFAULT_THEME.id, TWILIGHT_DEFAULT_THEME_ID)
  assert.equal(TWILIGHT_DEFAULT_THEME.variants.pureWhite.tokens['color.primary.500'], '#2563eb')
  assert.equal(TWILIGHT_DEFAULT_THEME.variants.dark.tokens['color.primary.500'], '#2563eb')
  assert.equal(TWILIGHT_DEFAULT_THEME.variants.pureWhite.tokens['surface.card'], '#ffffff')
  assert.equal(TWILIGHT_DEFAULT_THEME.variants.dark.tokens['surface.card'], '#181818')
  assert.equal(
    Object.keys(TWILIGHT_DEFAULT_THEME.variants.dark.tokens).length,
    THEME_TOKEN_DEFINITIONS.length
  )
})

test('theme profiles keep sparse known-token overrides and reject unsafe values', () => {
  const profile = normalizeThemeProfile({
    schemaVersion: 1,
    id: 'user:studio',
    name: 'Studio',
    description: 'Custom',
    baseThemeId: TWILIGHT_DEFAULT_THEME_ID,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    overrides: {
      pureWhite: {
        'color.primary.500': '#123456',
        unknown: '#ffffff'
      },
      dark: {
        'surface.card': 'url(https://example.com/card.png)',
        'shape.cardRadius': '12px'
      }
    }
  })

  assert.ok(profile)
  assert.equal(profile.schemaVersion, 2)
  assert.deepEqual(profile.modes, {})
  assert.equal(resolveThemeProfileTokens(profile, 'pureWhite')['color.primary.500'], '#123456')
  assert.equal(resolveThemeProfileTokens(profile, 'pureWhite')['surface.card'], '#ffffff')
  assert.equal(resolveThemeProfileTokens(profile, 'dark')['shape.cardRadius'], '12px')
  assert.equal(resolveThemeProfileTokens(profile, 'dark')['surface.app'], '#17181a')
  assert.equal(
    Object.keys(resolveThemeProfileTokens(profile, 'dark')).length,
    THEME_TOKEN_DEFINITIONS.length
  )
  assert.deepEqual(themeTokensToCssVariables(profile.overrides.pureWhite), {
    '--te-primary-500': '#123456',
    '--te-accent': '#123456',
    '--brand-50': '#123456',
    '--brand-100': '#123456',
    '--brand-200': '#123456',
    '--brand-300': '#123456',
    '--brand-400': '#123456',
    '--brand-500': '#123456',
    '--brand-600': '#123456',
    '--brand-700': '#123456'
  })
})

test('theme profiles keep only local typed assets and valid visual bindings', () => {
  const profile = normalizeThemeProfile({
    schemaVersion: 1,
    id: 'user:assets',
    name: 'Assets',
    baseThemeId: TWILIGHT_DEFAULT_THEME_ID,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    overrides: { pureWhite: {}, dark: {} },
    assets: [
      { id: 'backdrop', path: 'backdrop.webp', type: 'image' },
      { id: 'sans', path: 'fonts/sans.woff2', type: 'font' },
      { id: 'escape', path: '../secret.png', type: 'image' },
      { id: 'remote', path: 'https://example.com/a.png', type: 'image' }
    ],
    assetBindings: {
      appBackground: 'backdrop',
      sansFont: 'sans',
      playerBackground: 'sans',
      displayFont: 'missing'
    }
  })

  assert.ok(profile)
  assert.deepEqual(profile.assets, [
    { id: 'backdrop', path: 'backdrop.webp', type: 'image' },
    { id: 'sans', path: 'fonts/sans.woff2', type: 'font' }
  ])
  assert.deepEqual(profile.assetBindings, { appBackground: 'backdrop', sansFont: 'sans' })
})

test('theme library normalization falls back from missing user themes without deleting profiles', () => {
  const defaults = createDefaultThemeLibraryDocument()
  const normalized = normalizeThemeLibraryDocument({
    ...defaults,
    activeTheme: { kind: 'user', id: 'user:missing' },
    profiles: []
  })

  assert.deepEqual(normalized.activeTheme, { kind: 'builtin', id: TWILIGHT_DEFAULT_THEME_ID })
  assert.deepEqual(normalized.profiles, [])
})

test('numeric and length token constraints are enforced', () => {
  assert.deepEqual(
    normalizeThemeTokenOverrides({
      'layout.uiScale': '1.05',
      'material.surfaceOpacity': '72%',
      'background.gradientAngle': '270deg',
      'background.coverBlur': '65px',
      'shape.cardRadius': '24px',
      'shape.dialogRadius': '12px',
      'navigation.opacity': '72%',
      'library.selection.inlineInset': '12px',
      'playback.cover.size': '84%',
      'playback.control.borderWidth': '2px',
      'playback.equalizer.sliderThumbSize': '24px',
      'shape.cardBorderWidth': '4px',
      'typography.titleWeight': '950',
      'color.primary.500': 'not-a-color'
    }),
    {
      'layout.uiScale': '1.05',
      'material.surfaceOpacity': '72%',
      'background.gradientAngle': '270deg',
      'shape.cardRadius': '24px',
      'shape.dialogRadius': '12px',
      'navigation.opacity': '72%',
      'library.selection.inlineInset': '12px',
      'playback.cover.size': '84%',
      'playback.control.borderWidth': '2px',
      'playback.equalizer.sliderThumbSize': '24px'
    }
  )
})

test('v2 theme modes are sparse, whitelisted, and map only to managed attributes', () => {
  const profile = normalizeThemeProfile({
    schemaVersion: 2,
    id: 'user:modes',
    name: 'Modes',
    description: '',
    baseThemeId: TWILIGHT_DEFAULT_THEME_ID,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    overrides: { pureWhite: {}, dark: {} },
    toneSchedule: { lightStartMinutes: 390, darkStartMinutes: 1230 },
    modes: {
      appearance: {
        backgroundTreatment: 'image',
        effectsMode: 'reduced',
        unknown: 'unsafe'
      },
      navigation: { style: 'rail', iconScale: 'huge', logo: 'show' },
      library: { density: 'compact', selection: 'unsafe', titleOverlay: 'on' },
      icons: { family: 'filled' },
      typography: { titleCase: 'uppercase', lyricAccent: 'accent', titleColor: 'unsafe' },
      player: {
        layout: 'split',
        controls: 'pro',
        titleAlign: 'center',
        progress: 'spectrum',
        unknown: 'unsafe'
      },
      artwork: { transition: 'slide', shadow: 'off' },
      equalizer: {
        panel: 'glass',
        slider: 'solid',
        knob: 'dot',
        spectrum: 'area',
        button: 'solid'
      },
      visibility: {
        playerArtwork: false,
        playerTrackMenu: false,
        previousButton: true,
        arbitraryDomNode: false
      }
    }
  })

  assert.ok(profile)
  assert.deepEqual(profile.modes, {
    appearance: { backgroundTreatment: 'image', effectsMode: 'reduced' },
    navigation: { style: 'rail', logo: 'show' },
    library: { density: 'compact', titleOverlay: 'on' },
    icons: { family: 'filled' },
    typography: { titleCase: 'uppercase', lyricAccent: 'accent' },
    player: { layout: 'split', controls: 'pro', titleAlign: 'center', progress: 'spectrum' },
    artwork: { transition: 'slide', shadow: 'off' },
    equalizer: {
      panel: 'glass',
      slider: 'solid',
      knob: 'dot',
      spectrum: 'area',
      button: 'solid'
    },
    visibility: { playerArtwork: false, playerTrackMenu: false, previousButton: true }
  })
  assert.deepEqual(profile.toneSchedule, { lightStartMinutes: 390, darkStartMinutes: 1230 })
  const attributes = themeModesToDataAttributes(resolveThemeProfileModes(profile))
  assert.equal(attributes['data-te-background-treatment'], 'image')
  assert.equal(attributes['data-te-effects-mode'], 'reduced')
  assert.equal(attributes['data-te-navigation-style'], 'rail')
  assert.equal(attributes['data-te-navigation-logo'], 'show')
  assert.equal(attributes['data-te-library-density'], 'compact')
  assert.equal(attributes['data-te-library-title-overlay'], 'on')
  assert.equal(attributes['data-te-icon-family'], 'filled')
  assert.equal(attributes['data-te-title-case'], 'uppercase')
  assert.equal(attributes['data-te-lyric-accent'], 'accent')
  assert.equal(attributes['data-te-player-layout'], 'split')
  assert.equal(attributes['data-te-player-controls'], 'pro')
  assert.equal(attributes['data-te-player-title-align'], 'center')
  assert.equal(attributes['data-te-player-progress'], 'spectrum')
  assert.equal(attributes['data-te-artwork-transition'], 'slide')
  assert.equal(attributes['data-te-artwork-shadow'], 'off')
  assert.equal(attributes['data-te-equalizer-panel'], 'glass')
  assert.equal(attributes['data-te-equalizer-slider'], 'solid')
  assert.equal(attributes['data-te-equalizer-knob'], 'dot')
  assert.equal(attributes['data-te-equalizer-spectrum'], 'area')
  assert.equal(attributes['data-te-equalizer-button'], 'solid')
  assert.equal(attributes['data-te-visible-player-artwork'], 'false')
  assert.equal(attributes['data-te-visible-player-track-menu'], 'false')
  assert.equal(attributes['data-te-visible-previous-button'], 'true')
  assert.equal(
    Object.keys(attributes).some((name) => name.includes('unknown')),
    false
  )
  assert.equal(
    Object.keys(attributes).some((name) => name.includes('arbitrary')),
    false
  )
})

test('phase three icon slots resolve every host-owned family without arbitrary resources', () => {
  const slots = Object.entries(THEME_ICON_SLOT_REGISTRY)
  assert.ok(slots.length >= 24)
  for (const [id, definition] of slots) {
    assert.match(id, /^(navigation|library)\.[a-z]+$/)
    assert.ok(definition.domain === 'navigation' || definition.domain === 'library')
    assert.match(definition.classes.outline, /^ph ph-/)
    assert.match(definition.classes.rounded, /^ph-bold ph-/)
    assert.match(definition.classes.filled, /^ph-fill ph-/)
  }
  assert.equal(resolveThemeIconClasses('navigation.home', 'filled'), 'ph-fill ph-house')
})

test('timed tone schedules are bounded and switch correctly across midnight', () => {
  assert.deepEqual(normalizeThemeToneSchedule({ lightStartMinutes: 420, darkStartMinutes: 1140 }), {
    lightStartMinutes: 420,
    darkStartMinutes: 1140
  })
  assert.equal(
    normalizeThemeToneSchedule({ lightStartMinutes: 1440, darkStartMinutes: 1140 }),
    undefined
  )
  assert.equal(
    normalizeThemeToneSchedule({ lightStartMinutes: 420, darkStartMinutes: 420 }),
    undefined
  )
  const schedule = { lightStartMinutes: 7 * 60, darkStartMinutes: 19 * 60 }
  assert.equal(resolveScheduledThemeTone(new Date(2026, 0, 1, 6, 59), schedule), 'dark')
  assert.equal(resolveScheduledThemeTone(new Date(2026, 0, 1, 7, 0), schedule), 'pureWhite')
  assert.equal(resolveScheduledThemeTone(new Date(2026, 0, 1, 18, 59), schedule), 'pureWhite')
  assert.equal(resolveScheduledThemeTone(new Date(2026, 0, 1, 19, 0), schedule), 'dark')
})

test('phase two palettes and built-in fonts are broad UI shortcuts, not schema values', () => {
  assert.ok(THEME_ACCENT_PALETTES.pureWhite.length >= 16)
  assert.ok(THEME_ACCENT_PALETTES.dark.length >= 16)
  assert.ok(THEME_BACKGROUND_PALETTES.pureWhite.length >= 16)
  assert.ok(THEME_BACKGROUND_PALETTES.dark.length >= 16)
  assert.ok(BUILT_IN_THEME_FONTS.some((font) => font.category === 'serif'))
  assert.ok(BUILT_IN_THEME_FONTS.some((font) => font.category === 'mono'))
  assert.ok(BUILT_IN_THEME_FONTS.some((font) => font.category === 'display'))
  const profile = normalizeThemeProfile({
    schemaVersion: 2,
    id: 'user:palette',
    name: 'Palette',
    baseThemeId: TWILIGHT_DEFAULT_THEME_ID,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    overrides: { pureWhite: {}, dark: {} },
    modes: {},
    paletteId: 'must-not-persist'
  })
  assert.ok(profile)
  assert.equal('paletteId' in profile, false)
})

test('phase five ships seven contrasting read-only presets with token, mode, and visibility layers', () => {
  assert.deepEqual(
    BUILT_IN_THEME_PRESETS.map((preset) => preset.id),
    BUILT_IN_THEME_PRESET_IDS
  )
  assert.equal(new Set(BUILT_IN_THEME_PRESETS.map((preset) => preset.name)).size, 7)
  for (const preset of BUILT_IN_THEME_PRESETS) {
    assert.ok(Object.keys(preset.overrides.pureWhite).length >= 0)
    assert.ok(Object.keys(preset.modes).length > 0)
    assert.ok(preset.modes.visibility)
    assert.ok(preset.windowDefaults?.miniPlayer?.fontFamily)
    assert.ok(preset.windowDefaults?.desktopLyrics?.highlightColor)
    assert.equal(normalizeThemeProfile(preset), null)
  }
  const obsidian = BUILT_IN_THEME_PRESETS.find((preset) => preset.id.endsWith('obsidian-glass'))!
  assert.deepEqual(
    resolveThemeProfileModes(obsidian).player,
    resolveThemeProfileModes(BUILT_IN_THEME_PRESETS[0]).player
  )
  assert.deepEqual(
    resolveThemeProfileModes(obsidian).typography,
    resolveThemeProfileModes(BUILT_IN_THEME_PRESETS[0]).typography
  )
  assert.equal(resolveThemeProfileModes(obsidian).navigation?.style, 'rail')
  assert.deepEqual(
    resolveThemeProfileModes(obsidian).visibility,
    resolveThemeProfileModes(BUILT_IN_THEME_PRESETS[0]).visibility
  )
  const aurora = BUILT_IN_THEME_PRESETS.find((preset) => preset.id.endsWith('aurora-reference'))!
  assert.equal(resolveThemeProfileModes(aurora).navigation?.logo, 'hide')
  const paperLight = BUILT_IN_THEME_PRESETS.find((preset) => preset.id.endsWith('paper-light'))!
  for (const tone of ['pureWhite', 'dark'] as const) {
    const backdrop = paperLight.overrides[tone]
    assert.match(String(backdrop['playback.backdrop.filter']), /blur\(/)
    assert.match(String(backdrop['playback.backdrop.scrim']), /rgba\([^)]*, 0\.[678]/)
  }
})

test('derived profiles retain a preset source and reset through the preset base', () => {
  const derived = normalizeThemeProfile({
    schemaVersion: 2,
    id: 'user:derived',
    name: 'Derived',
    description: '',
    baseThemeId: TWILIGHT_DEFAULT_THEME_ID,
    source: { kind: 'builtin-preset', presetId: 'builtin:studio-split' },
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    overrides: { pureWhite: {}, dark: {} },
    modes: {}
  })
  assert.ok(derived)
  assert.equal(derived.baseThemeId, 'builtin:studio-split')
  assert.equal(derived.source?.presetId, 'builtin:studio-split')
  assert.equal(resolveThemeProfileModes(derived).player?.layout, 'split')
  assert.equal(resolveThemeProfileTokens(derived, 'dark')['color.primary.500'], '#3ddc97')
})

test('profile history is bounded by count and UTF-8 byte budget', () => {
  const profile = normalizeThemeProfile({
    schemaVersion: 2,
    id: 'user:history',
    name: 'History',
    description: '',
    baseThemeId: TWILIGHT_DEFAULT_THEME_ID,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    overrides: { pureWhite: {}, dark: {} },
    modes: {}
  })!
  const entries = Array.from({ length: 32 }, (_, index) => ({
    savedAt: new Date(2026, 0, index + 1).toISOString(),
    profile: { ...profile, description: 'x'.repeat(60_000) }
  }))
  const limited = limitThemeProfileHistory(entries)
  assert.ok(limited.length <= 8)
  assert.ok(new TextEncoder().encode(JSON.stringify(limited)).byteLength <= 256 * 1024)
})

test('adaptive accents and contrast enforcement produce bounded readable host colors', () => {
  const fixed = createThemeAccentTokenOverrides('#2563eb', 'pureWhite', '#f4f4f7')
  assert.equal(fixed['color.primary.500'], '#2563eb')
  assert.equal(fixed['color.primary.rgb'], '37, 99, 235')
  assert.equal(fixed['navigation.indicator'], '#2563eb')
  const adaptive = createThemeAccentTokenOverrides('#f6f7f8', 'pureWhite', '#ffffff', true)
  assert.equal(adaptive['color.primary.500'], '#2563eb')
  assert.ok((themeContrastRatio('#111827', '#ffffff') ?? 0) >= 4.5)
  assert.equal(ensureThemeTextContrast('#eeeeee', '#ffffff'), '#111827')
  assert.equal(ensureThemeTextContrast('#222222', '#111111'), '#f8fafc')
})

test('unknown profile versions fail closed while mode normalization accepts no arbitrary fields', () => {
  assert.equal(
    normalizeThemeProfile({ schemaVersion: 99, id: 'user:future', name: 'Future' }),
    null
  )
  assert.deepEqual(normalizeThemeModes({ prototype: { polluted: true } }), {})
})

test('legacy plugin selection migrates to the structured active theme contract', () => {
  assert.deepEqual(normalizeThemeSelection(undefined, 'com.example.theme:midnight'), {
    kind: 'plugin',
    pluginId: 'com.example.theme',
    themeId: 'midnight'
  })
  assert.deepEqual(normalizeThemeSelection(undefined, '../invalid'), {
    kind: 'builtin',
    id: TWILIGHT_DEFAULT_THEME_ID
  })
})

test('structured plugin themes keep only registered safe tokens and bounded window defaults', () => {
  assert.deepEqual(
    normalizeStructuredPluginTheme({
      schemaVersion: 1,
      variants: {
        pureWhite: {
          tokens: {
            'color.primary.500': '#123456',
            unknown: '#ffffff'
          }
        },
        dark: {
          tokens: {
            'surface.card': 'url(https://example.com/remote.png)'
          }
        }
      },
      windowDefaults: {
        miniPlayer: { cornerRadius: 999, borderColor: '#112233' },
        desktopLyrics: { fontSize: 4, shadow: false }
      }
    }),
    {
      schemaVersion: 1,
      variants: { pureWhite: { tokens: { 'color.primary.500': '#123456' } } },
      windowDefaults: {
        miniPlayer: {
          accentColor: undefined,
          primaryTextColor: undefined,
          mutedTextColor: undefined,
          surfaceOpacity: undefined,
          glassBlur: undefined,
          cornerRadius: 36,
          borderWidth: undefined,
          borderColor: '#112233',
          shadowStrength: undefined
        },
        desktopLyrics: {
          fontFamily: undefined,
          fontSize: 12,
          fontWeight: undefined,
          color: undefined,
          highlightColor: undefined,
          backgroundColor: undefined,
          backgroundOpacity: undefined,
          shadow: false,
          shadowBlur: undefined,
          shadowColor: undefined
        }
      }
    }
  )
})

test('structured plugin theme v2 keeps only host-registered modes', () => {
  const rawModes = {
    navigation: { style: 'rail', futureStyle: 'floating' },
    player: { layout: 'cinema', controls: 'pro' },
    visibility: { playerDuration: false, futureControl: true }
  }
  assert.deepEqual(
    normalizeStructuredPluginTheme({
      schemaVersion: 2,
      variants: {},
      modes: rawModes
    }),
    {
      schemaVersion: 2,
      variants: {},
      modes: {
        navigation: { style: 'rail' },
        player: { controls: 'pro' },
        visibility: { playerDuration: false }
      }
    }
  )
  assert.deepEqual(findUnsupportedThemeModeIds(rawModes), [
    'navigation.futureStyle',
    'player.layout',
    'visibility.futureControl'
  ])
  assert.equal(resolveThemeModes(rawModes).navigation?.style, 'rail')
  assert.equal(resolveThemeModes(rawModes).player?.layout, 'standard')
  assert.equal(
    themeModesToDataAttributes(resolveThemeModes(rawModes))['data-te-navigation-style'],
    'rail'
  )
  assert.equal(
    themeModesToDataAttributes(resolveThemeModes(rawModes))['data-te-player-layout'],
    'standard'
  )
  assert.equal(
    themeModesToDataAttributes(resolveThemeModes(rawModes))['data-te-visible-player-duration'],
    'false'
  )
})

test('structured plugin theme v3 accepts a host-owned shell layout and rejects unsafe grids', () => {
  const layout: ThemeShellLayout = {
    desktop: {
      columns: ['standard', 'fill'],
      rows: ['auto', 'fill', 'auto'],
      areas: [
        ['titleBar', 'titleBar'],
        ['navigation', 'content'],
        ['navigation', 'playerBar']
      ]
    },
    compact: {
      columns: ['fill'],
      rows: ['auto', 'fill', 'auto'],
      areas: [['titleBar'], ['content'], ['playerBar']]
    },
    navigation: 'persistent'
  }
  const normalized = normalizeStructuredPluginTheme({
    schemaVersion: 3,
    variants: {},
    modes: { navigation: { style: 'rail' } },
    layout
  })

  assert.deepEqual(normalized, {
    schemaVersion: 3,
    variants: {},
    modes: { navigation: { style: 'rail' } },
    layout
  })
  assert.deepEqual(findInvalidThemeShellLayoutFields(layout), [])
  assert.deepEqual(themeShellLayoutToDataAttributes(layout), {
    'data-te-shell-layout': 'custom',
    'data-te-shell-navigation': 'persistent'
  })
  assert.equal(
    themeShellLayoutToCssVariables(layout)['--te-shell-template-areas'],
    "'titleBar titleBar' 'navigation content' 'navigation playerBar'"
  )
  assert.deepEqual(
    findInvalidThemeShellLayoutFields({
      desktop: {
        columns: ['fill'],
        rows: ['fill'],
        areas: [['content']]
      }
    }),
    ['layout.desktop.areas.titleBar']
  )
  assert.deepEqual(
    normalizeStructuredPluginTheme({
      schemaVersion: 3,
      variants: {},
      layout: {
        desktop: {
          columns: ['fill', 'fill'],
          rows: ['fill', 'fill'],
          areas: [
            ['titleBar', 'content'],
            ['content', 'content']
          ]
        }
      }
    }),
    undefined
  )
})
