import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SETTINGS_SEARCH_INDEX,
  LEGACY_SETTINGS_TARGETS,
  normalizeSettingsSection,
  resolveSettingsSearchEntry,
  sections,
  settingsSectionGroups
} from './types.ts'
import { useAppNavigation } from '../../app/useAppNavigation.ts'
import { normalizeNavigationSession } from '../../app/navigationSession.ts'

test('settings have twelve canonical categories and each search destination has a stable identity', () => {
  assert.deepEqual(
    sections.map((section) => section.key),
    [
      'overview',
      'general',
      'appearance',
      'interface',
      'lyrics',
      'playback',
      'library',
      'storage',
      'connections',
      'hotkeys',
      'system',
      'updates'
    ]
  )
  assert.ok(
    sections.every(
      (section) =>
        settingsSectionGroups.some((group) => group.key === section.group) && Boolean(section.tone)
    )
  )
  const ids = SETTINGS_SEARCH_INDEX.map((entry) => entry.id)
  assert.ok(ids.every(Boolean))
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(
    SETTINGS_SEARCH_INDEX.every((entry) =>
      sections.some((section) => section.key === entry.section)
    )
  )
  assert.equal(SETTINGS_SEARCH_INDEX.filter((entry) => entry.title.includes('防破音')).length, 1)
  assert.equal(normalizeSettingsSection('__proto__'), 'overview')
})

test('legacy entry points open their new category and preserve the intended internal anchor', () => {
  const navigation = useAppNavigation()
  for (const [legacy, target] of Object.entries(LEGACY_SETTINGS_TARGETS)) {
    navigation.openSettingsPage(legacy as keyof typeof LEGACY_SETTINGS_TARGETS)
    assert.equal(navigation.settingsInitialSection.value, target.section)
    assert.equal(navigation.settingsNavigationTarget.value.anchor, target.anchor)
    const saved = normalizeNavigationSession({
      ...navigation.session.value,
      settingsSection: legacy
    })!
    assert.equal(saved.settingsSection, target.section)
  }
  assert.equal(
    resolveSettingsSearchEntry({ section: 'general', title: '扫描文件夹', terms: '' }).section,
    'library'
  )
  assert.equal(
    resolveSettingsSearchEntry({ section: 'dsp', title: '防破音保护 (Clip Guard)', terms: '' }).id,
    'clip-guard'
  )
})

test('opening settings without a destination returns to the last browsed category', () => {
  const navigation = useAppNavigation()
  navigation.openSettingsPage('general')
  navigation.rememberSettingsSection('cache')
  navigation.closeSettingsPage()
  navigation.openSettingsPage()
  assert.equal(navigation.settingsInitialSection.value, 'storage')
  assert.equal(navigation.settingsNavigationTarget.value.anchor, undefined)
  navigation.openSettingsPage('dsp')
  assert.equal(navigation.settingsInitialSection.value, 'playback')
  assert.equal(navigation.settingsNavigationTarget.value.anchor, 'dsp')
})

test('appearance searches stay in original settings and the new workspace returns to them', () => {
  const navigation = useAppNavigation()
  const entry = SETTINGS_SEARCH_INDEX.find((item) => item.id === 'global-font')!
  navigation.openSettingsPage('appearance', { entry })
  assert.equal(navigation.showSettingsPage.value, true)
  assert.equal(navigation.showAppearancePage.value, false)
  assert.equal(navigation.settingsNavigationTarget.value.entry, entry)
  const target = navigation.settingsNavigationTarget.value
  navigation.openAppearancePage()
  assert.equal(navigation.showAppearancePage.value, true)
  navigation.closeAppearancePage()
  assert.equal(navigation.showSettingsPage.value, true)
  assert.equal(navigation.settingsInitialSection.value, 'appearance')
  assert.equal(navigation.settingsNavigationTarget.value, target)
  navigation.closeSettingsPage()
  navigation.openSettingsPage()
  assert.equal(navigation.showSettingsPage.value, true)
  assert.equal(navigation.settingsInitialSection.value, 'appearance')
})
