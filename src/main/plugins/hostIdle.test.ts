import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_PLUGIN_HOST_IDLE_TIMEOUT_MS, PluginHostIdleTracker } from './hostIdle.ts'

test('plugin host idle tracker hibernates a plugin only after an uninterrupted idle window', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const idle: string[] = []
  const tracker = new PluginHostIdleTracker({
    idleTimeoutMs: 1000,
    canHibernate: () => true,
    onIdle: (id) => idle.push(id)
  })

  tracker.touch('com.example.a')
  t.mock.timers.tick(900)
  tracker.touch('com.example.a')
  t.mock.timers.tick(900)
  assert.deepEqual(idle, [], 'activity inside the window restarts the countdown')
  t.mock.timers.tick(100)
  assert.deepEqual(idle, ['com.example.a'])
  assert.equal(tracker.isTracking('com.example.a'), false, 'a hibernated plugin is no longer armed')
  tracker.destroy()
})

test('plugin host idle tracker re-arms busy plugins instead of hibernating them', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const idle: string[] = []
  let busy = true
  const tracker = new PluginHostIdleTracker({
    idleTimeoutMs: 1000,
    canHibernate: () => !busy,
    onIdle: (id) => idle.push(id)
  })

  tracker.touch('com.example.busy')
  t.mock.timers.tick(1000)
  assert.deepEqual(idle, [], 'a plugin with pending work stays resident')
  assert.equal(tracker.isTracking('com.example.busy'), true, 'the busy plugin is re-armed')
  busy = false
  t.mock.timers.tick(1000)
  assert.deepEqual(idle, ['com.example.busy'])
  tracker.destroy()
})

test('plugin host idle tracker clear and destroy cancel pending countdowns', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const idle: string[] = []
  const tracker = new PluginHostIdleTracker({
    idleTimeoutMs: 1000,
    canHibernate: () => true,
    onIdle: (id) => idle.push(id)
  })

  tracker.touch('com.example.stopped')
  tracker.touch('com.example.destroyed')
  tracker.clear('com.example.stopped')
  assert.equal(tracker.isTracking('com.example.stopped'), false)
  tracker.destroy()
  t.mock.timers.tick(5000)
  assert.deepEqual(idle, [], 'neither cleared nor destroyed timers fire')
  tracker.touch('com.example.late')
  assert.equal(tracker.isTracking('com.example.late'), false, 'a destroyed tracker ignores touches')
})

test('plugin host idle default keeps hosts warm for a few minutes of normal browsing', () => {
  assert.equal(DEFAULT_PLUGIN_HOST_IDLE_TIMEOUT_MS, 5 * 60 * 1000)
})
