import assert from 'node:assert/strict'
import test from 'node:test'
import { createLibraryLoudnessHandlers } from './libraryLoudnessIpc.ts'
import { LibraryLoudnessManager } from './libraryLoudnessManager.ts'

test('library loudness handlers reject untrusted senders, remote paths and malformed batches before work', async () => {
  let analyzed = 0
  const manager = new LibraryLoudnessManager({
    cache: { get: () => null, set: () => {}, clear: () => {} },
    authorizePath: async () => {
      throw new Error('unauthorized')
    },
    analyze: async () => {
      analyzed++
      throw new Error('unused')
    },
    cancelWork: () => {}
  })
  const handlers = createLibraryLoudnessHandlers(manager, (event) => {
    if (event !== 'trusted') throw new Error('untrusted')
  })
  for (const action of [
    () => handlers.snapshot('foreign'),
    () => handlers.start('foreign', []),
    () => handlers.cancel('foreign', 'job'),
    () => handlers.results('foreign', []),
    () => handlers.clear('foreign', ['one'])
  ])
    await assert.rejects(action, /untrusted/)
  const group = {
    id: 'track:one',
    title: 'One',
    mode: 'track',
    tracks: [{ id: 'one', filePath: 'https://evil.test/a.wav' }]
  }
  await assert.rejects(handlers.start('trusted', [group]), /safe local path/)
  await assert.rejects(handlers.start('trusted', []), /请选择/)
  await assert.rejects(handlers.cancel('trusted', ''), /required/)
  await assert.rejects(handlers.clear('trusted', new Array(10001).fill('one')), /范围无效/)
  assert.equal(manager.snapshot().status.state, 'idle')
  const local = { ...group, tracks: [{ id: 'one', filePath: 'D:/library/a.wav' }] }
  const result = await handlers.results('trusted', [local])
  assert.equal(result[0].status, 'unavailable')
  assert.match(result[0].reason!, /unauthorized/)
  assert.equal(analyzed, 0)
})
