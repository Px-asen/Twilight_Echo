import assert from 'node:assert/strict'
import test from 'node:test'
import { customThemeSnapshot } from './customThemeSnapshot.ts'
import { cloneAppearance } from '../../shared/appAppearance.ts'
import {
  normalizeThemeProfile,
  normalizeStructuredPluginTheme,
  getBuiltInThemePreset,
  TWILIGHT_DEFAULT_THEME_ID
} from '../../shared/theme.ts'
import {
  compileWorkshopTheme,
  copyWorkshopDraft,
  isWorkshopProject,
  type CustomThemeInput
} from '../../shared/themeWorkshop.ts'

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSocAAAAASUVORK5CYII='
test('standalone v3 appearance and icons normalize without unrelated tokens, while v1/v2 stay unchanged', () => {
  const appearance = normalizeStructuredPluginTheme({
    schemaVersion: 3,
    variants: {},
    appearance: { playerBar: { mode: 'compact' } }
  })
  assert.equal(appearance?.schemaVersion === 3 && appearance.appearance?.playerBar?.mode, 'compact')
  const icons = normalizeStructuredPluginTheme({
    schemaVersion: 3,
    variants: {},
    iconAssets: {
      'navigation.home': png,
      'unknown.slot': png,
      'playback.play': 'https://bad.invalid/icon.png'
    }
  })
  assert.deepEqual(icons?.schemaVersion === 3 && icons.iconAssets, { 'navigation.home': png })
  for (const schemaVersion of [1, 2]) {
    const legacy = normalizeStructuredPluginTheme({
      schemaVersion,
      variants: {},
      appearance: { playerBar: { mode: 'compact' } },
      iconAssets: { 'navigation.home': png }
    })
    assert.equal(legacy, undefined)
  }
})
test('unsaved theme snapshots carry both tones, skins, fonts, icons, window defaults and schedules', async () => {
  const profile = normalizeThemeProfile({
    schemaVersion: 2,
    id: 'user:unsaved',
    name: '尚未应用',
    overrides: {
      pureWhite: { 'color.primary.500': '#123456' },
      dark: { 'color.primary.500': '#abcdef' }
    },
    modes: { navigation: { style: 'rail' } },
    toneSchedule: { lightStartMinutes: 480, darkStartMinutes: 1200 },
    windowDefaults: { miniPlayer: { opacity: 0.8 } },
    assets: [
      { id: 'image', type: 'image', path: 'image.png' },
      { id: 'font', type: 'font', path: 'font.woff2' }
    ],
    assetBindings: { appBackground: 'image', sansFont: 'font' },
    iconBindings: { 'navigation.home': 'image' }
  })!
  const appearance = cloneAppearance({} as never)
  appearance.surfaceMaterial = 'liquidGlass'
  appearance.appBackground.global.kind = 'image'
  appearance.appBackground.global.image = 'background://wallpaper.png'
  appearance.appearanceLayers!.scopes['player-bar'].dark.skin = {
    ...appearance.appearanceLayers!.scopes['player-bar'].dark.skin,
    enabled: true,
    image: 'background://alpha.png',
    opacity: 61,
    x: 15,
    frame: { top: 15, right: 10, bottom: 12, left: 10 }
  }
  const before = JSON.stringify({ profile, appearance })
  const project = await customThemeSnapshot(
    '00000000-0000-0000-0000-000000000001',
    { selection: { kind: 'builtin', id: TWILIGHT_DEFAULT_THEME_ID }, profile, appearance },
    profile,
    undefined,
    async (source) => (source.endsWith('font.woff2') ? 'data:font/woff2;base64,d09GMg==' : png)
  )
  assert.ok(isWorkshopProject(project))
  const compiled = compileWorkshopTheme(project)
  const structured = normalizeStructuredPluginTheme(compiled.structured)!
  assert.equal(structured.schemaVersion, 3)
  if (structured.schemaVersion !== 3) throw Error('missing structured theme')
  assert.equal(structured.variants.pureWhite!.tokens!['color.primary.500'], '#123456')
  assert.equal(structured.variants.dark!.tokens!['color.primary.500'], '#abcdef')
  assert.equal(structured.appearance!.surfaceMaterial, 'liquidGlass')
  assert.equal(structured.appearance!.appBackground.global.image, png)
  assert.equal(structured.appearanceLayers!.scopes['player-bar'].dark.skin.image, png)
  assert.equal(structured.appearanceLayers!.scopes['player-bar'].dark.skin.frame.top, 15)
  assert.equal(structured.iconAssets!['navigation.home'], png)
  assert.equal(structured.toneSchedule!.darkStartMinutes, 1200)
  assert.equal(structured.modes!.navigation!.style, 'rail')
  assert.match(compiled.css, /@font-face/)
  assert.match(compiled.css, /data:font\/woff2/)
  assert.doesNotMatch(JSON.stringify(project), /background:\/\/|theme-asset:\/\//)
  assert.equal(JSON.stringify({ profile, appearance }), before)
  const copy = copyWorkshopDraft(project)
  if (copy.base.structured?.schemaVersion === 3)
    copy.base.structured.appearanceLayers!.innerRadius = 33
  assert.notEqual((project.base.structured as typeof structured).appearanceLayers!.innerRadius, 33)
})

test('missing local assets stop export rather than dropping a skin', async () => {
  const appearance = cloneAppearance({} as never)
  appearance.appearanceLayers!.scopes.card.light.skin.image = 'background://missing.png'
  await assert.rejects(
    customThemeSnapshot(
      '00000000-0000-0000-0000-000000000001',
      { selection: { kind: 'builtin', id: TWILIGHT_DEFAULT_THEME_ID }, appearance },
      undefined,
      undefined,
      async () => {
        throw Error('图片已丢失')
      }
    ),
    /图片已丢失/
  )
})

test('exports capture global accent and typography while explicit profile edits retain priority', async () => {
  const input: CustomThemeInput = {
    selection: { kind: 'builtin' as const, id: TWILIGHT_DEFAULT_THEME_ID },
    appearance: cloneAppearance({} as never),
    preferences: {
      fontFamily: 'comic' as const,
      fontRendering: 'crisp' as const,
      lightAccentColor: 'rose',
      darkAccentColor: 'emerald'
    }
  }
  const builtin = await customThemeSnapshot(
    '00000000-0000-0000-0000-000000000001',
    input,
    getBuiltInThemePreset(TWILIGHT_DEFAULT_THEME_ID)!,
    undefined,
    async () => png
  )
  assert.equal(builtin.base.structured!.variants.pureWhite!.tokens!['color.primary.500'], '#e11d48')
  assert.equal(builtin.base.structured!.variants.dark!.tokens!['color.primary.500'], '#10b981')
  assert.match(builtin.base.structured!.variants.dark!.tokens!['typography.sans'], /Comic Sans/)
  assert.match(builtin.base.css, /--te-font-stroke:0\.2px!important/)
  const profile = normalizeThemeProfile({
    schemaVersion: 2,
    id: 'user:priority',
    name: 'Explicit preferences',
    overrides: { dark: { 'color.primary.500': '#123456', 'typography.sans': 'Explicit Sans' } },
    modes: {}
  })!
  const explicit = await customThemeSnapshot(
    '00000000-0000-0000-0000-000000000002',
    input,
    profile,
    undefined,
    async () => png
  )
  assert.equal(explicit.base.structured!.variants.dark!.tokens!['color.primary.500'], '#123456')
  assert.equal(explicit.base.structured!.variants.dark!.tokens!['typography.sans'], 'Explicit Sans')
  assert.equal(
    explicit.base.structured!.variants.pureWhite!.tokens!['color.primary.500'],
    '#e11d48'
  )
})
