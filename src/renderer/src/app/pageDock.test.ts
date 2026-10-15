import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import { createPageDockRegistry, type PageDockAction } from './pageDock.ts'

test('page Dock follows the foreground scope, live disabled state and owner disposal', () => {
  const scope = ref('local-home')
  const disabled = ref(false)
  let calls = 0
  const registry = createPageDockRegistry(scope)
  const firstAction = () => registry.actions.value[0]
  const stopHome = registry.register({
    scope: 'local-home',
    enabled: true,
    actions: () => [
      {
        id: 'play',
        label: '播放',
        icon: 'library.play',
        disabled: disabled.value,
        run: () => calls++
      }
    ]
  })
  const accountEnabled = ref(true)
  const stopAccount = registry.register({
    scope: 'account',
    enabled: accountEnabled,
    actions: [{ id: 'tasks', label: '任务', icon: 'navigation.notification', run: () => {} }]
  })
  assert.deepEqual(
    registry.actions.value.map((action) => action.id),
    ['play']
  )
  registry.actions.value[0].run()
  assert.equal(calls, 1)
  disabled.value = true
  assert.equal(firstAction().disabled, true)
  scope.value = 'account'
  assert.deepEqual(
    registry.actions.value.map((action) => action.id),
    ['tasks']
  )
  accountEnabled.value = false
  assert.deepEqual(registry.actions.value, [])
  accountEnabled.value = true
  stopAccount()
  assert.deepEqual(registry.actions.value, [])
  scope.value = 'local-home'
  assert.equal(firstAction().disabled, true)
  stopHome()
  assert.deepEqual(registry.actions.value, [])
})

test('retained pages and previews cannot replace current page commands', () => {
  const scope = ref('songs')
  const registry = createPageDockRegistry(scope)
  const command = (label: string): PageDockAction => ({
    id: 'play',
    label,
    icon: 'library.play',
    run: () => {}
  })
  registry.register({ scope: 'songs', actions: [command('全部歌曲')], enabled: true })
  registry.register({ scope: 'appearance', actions: [command('外观')], enabled: true })
  registry.register({ scope: 'songs', actions: [command('预览')], enabled: false })
  assert.deepEqual(
    registry.actions.value.map((action) => action.label),
    ['全部歌曲']
  )
  scope.value = 'appearance'
  assert.deepEqual(
    registry.actions.value.map((action) => action.label),
    ['外观']
  )
  scope.value = 'network'
  assert.deepEqual(registry.actions.value, [])
})
