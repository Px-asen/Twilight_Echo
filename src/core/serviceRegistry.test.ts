import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreServiceRegistry } from './serviceRegistry.ts'

test('optional owner is created once for concurrent requests and remains absent while only availability is read', async () => {
  let builds = 0
  const owners: { export?: { value: number } } = {}
  const registry = new CoreServiceRegistry<{ export: { value: number } }>(owners, {
    export: async () => {
      builds++
      return { value: 7 }
    }
  })
  assert.equal(registry.has('export'), true)
  assert.deepEqual(owners, {})
  const [a, b] = await Promise.all([registry.get('export'), registry.get('export')])
  assert.equal(builds, 1)
  assert.equal(a, b)
  assert.equal(owners.export, a)
  await registry.close()
  await assert.rejects(registry.get('export'), /shutting down/)
})

test('cancelled waiter cannot cancel another caller or invoke a newly loaded service', async () => {
  let release!: () => void
  const owners: { work?: object } = {}
  const registry = new CoreServiceRegistry<{ work: object }>(owners, {
    work: async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return {}
    }
  })
  const cancellation = new AbortController()
  const cancelled = registry.get('work', cancellation.signal)
  const live = registry.get('work')
  await Promise.resolve()
  cancellation.abort()
  release()
  await assert.rejects(cancelled, { name: 'AbortError' })
  assert.equal(await live, owners.work)
})

test('shutdown joins loading constructors so their owner can be drained, and failed loads remain retryable', async () => {
  let builds = 0,
    release!: () => void
  const owners: { job?: object } = {}
  const registry = new CoreServiceRegistry<{ job: object }>(owners, {
    job: async () => {
      if (++builds === 1) throw new Error('load failed')
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return {}
    }
  })
  await assert.rejects(registry.get('job'), /load failed/)
  const pending = registry.get('job')
  await Promise.resolve()
  let closed = false
  const close = registry.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  assert.equal(closed, false)
  release()
  await assert.rejects(pending, /shutting down/)
  await close
  assert.ok(owners.job)
  assert.equal(builds, 2)
})
