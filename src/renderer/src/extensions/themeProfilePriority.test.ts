import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BUILT_IN_THEME_PRESETS,
  resolveThemeProfileTokens,
  themeTokensToCssVariables,
  type ThemeProfileV2
} from '../../../shared/theme.ts'
import { applyExplicitThemePreferences } from './themeProfilePriority.ts'

function profile(): ThemeProfileV2 {
  return {
    ...BUILT_IN_THEME_PRESETS[0],
    id: 'user:studio-test',
    overrides: { pureWhite: {}, dark: {} },
    modes: {}
  }
}

test('explicit studio colors survive settings and reset returns to settings per tone', () => {
  const draft = profile()
  draft.overrides.dark = { 'color.primary.500': '#c04060', 'surface.app': '#123456' }
  const themed = themeTokensToCssVariables(resolveThemeProfileTokens(draft, 'dark'))
  const settings = { '--te-primary-500': '#2563eb', '--te-app-bg': '#111111' }
  const actual = { ...settings }
  applyExplicitThemePreferences(draft, 'dark', themed, actual)
  assert.equal(actual['--te-primary-500'], '#c04060')
  assert.equal(actual['--te-app-bg'], '#123456')
  const light = { ...settings }
  applyExplicitThemePreferences(draft, 'pureWhite', themed, light)
  assert.deepEqual(light, settings)
  draft.overrides.dark = {}
  const reset = { ...settings }
  applyExplicitThemePreferences(draft, 'dark', themed, reset)
  assert.deepEqual(reset, settings)
})

test('built-in themes continue to respect global appearance settings', () => {
  const variables = { '--te-primary-500': '#112233' }
  applyExplicitThemePreferences(
    BUILT_IN_THEME_PRESETS[0],
    'dark',
    { '--te-primary-500': '#ff0000' },
    variables
  )
  assert.deepEqual(variables, { '--te-primary-500': '#112233' })
})

test('bound fonts, cover accent and gradient background survive settings overlays', () => {
  const draft = profile()
  draft.assetBindings = { sansFont: 'font' }
  draft.modes.appearance = { accentSource: 'cover', backgroundTreatment: 'gradient' }
  const themed = {
    '--te-primary-500': '#c08040',
    '--te-font-sans': 'StudioFont',
    '--te-app-bg-image': 'linear-gradient(#fff, #000)',
    '--te-player-bg-image': 'none'
  }
  const actual = {
    '--te-primary-500': '#2563eb',
    '--te-font-sans': 'SettingsFont',
    '--te-app-bg-image': 'url(settings)',
    '--te-player-bg-image': 'url(player)'
  }
  applyExplicitThemePreferences(draft, 'dark', themed, actual)
  assert.equal(actual['--te-primary-500'], themed['--te-primary-500'])
  assert.equal(actual['--te-font-sans'], 'StudioFont')
  assert.equal(actual['--te-app-bg-image'], themed['--te-app-bg-image'])
  assert.equal(actual['--te-player-bg-image'], 'url(player)')
})

test('library page changes connect to the list background without replacing unedited wallpaper', () => {
  const draft = profile()
  const themed = { '--te-library-bg': 'linear-gradient(#112233, #223344)' }
  const variables: Record<string, string> = {}
  applyExplicitThemePreferences(draft, 'dark', themed, variables)
  assert.equal(variables['--te-library-custom-bg'], undefined)
  draft.overrides.dark['library.page.surface'] = themed['--te-library-bg']
  applyExplicitThemePreferences(draft, 'dark', themed, variables)
  assert.equal(variables['--te-library-custom-bg'], themed['--te-library-bg'])
})
