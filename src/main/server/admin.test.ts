import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServerAdmin, requestServerAdmin } from './admin.ts'
import type { NodeServerRuntime } from './runtime.ts'

test('a failed persistence checkpoint leaves management available for an explicit forced stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-server-admin-'))
  let stopped = false
  const attempts: boolean[] = []
  const runtime = {
    health: () => ({ phase: stopped ? 'stopped' : 'ready' }),
    stop: async (force: boolean, beforeUnlock: () => Promise<void>) => {
      attempts.push(force)
      if (!force) throw new Error('Persistence checkpoint failed')
      await beforeUnlock()
      stopped = true
    }
  } as unknown as NodeServerRuntime
  const admin = await createServerAdmin(runtime, root)
  try {
    await assert.rejects(requestServerAdmin(root, { kind: 'stop' }), /checkpoint failed/)
    assert.deepEqual(await requestServerAdmin(root, { kind: 'status' }), { phase: 'ready' })
    assert.deepEqual(await requestServerAdmin(root, { kind: 'stop', force: true }), {
      phase: 'stopped'
    })
    assert.deepEqual(attempts, [false, true])
    await assert.rejects(
      access(join(root, 'server-run.json')),
      (error) => (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
  } finally {
    if (!stopped) await admin.close()
    assert.equal(resolve(root, '..'), resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  }
})
