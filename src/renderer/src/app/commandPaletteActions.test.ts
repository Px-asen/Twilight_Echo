import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createCommandPaletteActions,
  filterCommandPaletteActions
} from './commandPaletteActions.ts'
import { useAppNavigation } from './useAppNavigation.ts'

test('building and filtering commands is inert and unavailable actions explain why', () => {
  const navigation = useAppNavigation()
  let calls = 0
  const actions = createCommandPaletteActions({
    navigation,
    currentTrack: null,
    playing: false,
    loading: false,
    lyricsVisible: true,
    togglePlay: async () => {
      calls += 1
    },
    showLyrics: async () => {
      calls += 1
    }
  })
  assert.equal(calls, 0)
  assert.equal(navigation.showSettingsPage.value, false)
  assert.match(actions.find((action) => action.id === 'now-playing')!.disabledReason!, /没有歌曲/)
  assert.match(actions.find((action) => action.id === 'lyrics')!.disabledReason!, /已显示/)
  assert.ok(filterCommandPaletteActions(actions, '').every((action) => action.group === '操作'))
  assert.ok(filterCommandPaletteActions(actions, '>eq').some((action) => action.id === 'equalizer'))
  assert.ok(filterCommandPaletteActions(actions, '扫描').some((action) => action.group === '设置'))
  actions.find((action) => action.id === 'device-profiles')!.run()
  assert.equal(navigation.settingsInitialSection.value, 'playback')
  assert.equal(navigation.settingsNavigationTarget.value.anchor, 'device-profiles')
  filterCommandPaletteActions(actions, '扫描')[0].run()
  assert.ok(navigation.settingsNavigationTarget.value.entry)
  assert.equal(navigation.settingsNavigationTarget.value.anchor, undefined)
})
