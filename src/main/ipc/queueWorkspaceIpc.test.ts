import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createQueueWorkspaceHandlers, MAX_QUEUE_WORKSPACE_BYTES } from './queueWorkspaceIpc.ts'
import { VersionedDataStore } from '../persistence/versionedDataStore.ts'
import {
  isQueueWorkspaceDocument,
  type QueueWorkspaceDocument
} from '../../shared/queueWorkspace.ts'

test('queue workspace handlers enforce sender, schema and revisions before atomic persistence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-queue-workspace-'))
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())))
    await rm(directory, { recursive: true, force: true })
  })
  const store = new VersionedDataStore<QueueWorkspaceDocument>({
    filePath: join(directory, 'workspace.json'),
    label: 'queue workspace',
    maxBytes: MAX_QUEUE_WORKSPACE_BYTES,
    isData: isQueueWorkspaceDocument,
    isLegacy: isQueueWorkspaceDocument
  })
  const handlers = createQueueWorkspaceHandlers(store, (sender) => {
    if (sender !== 'trusted') throw new Error('untrusted')
  })
  const document: QueueWorkspaceDocument = { version: 1, sessions: [], history: [] }
  await assert.rejects(handlers.load('foreign'), /untrusted/)
  await assert.rejects(handlers.save('foreign', document, 0), /untrusted/)
  await assert.rejects(handlers.save('trusted', { ...document, version: 99 }, 0), /格式/)
  assert.equal(await handlers.load('trusted'), null)
  const receipt = await handlers.save('trusted', document, 0)
  assert.ok('revision' in receipt && receipt.revision === 1)
  const conflict = await handlers.save('trusted', document, 0)
  assert.ok('code' in conflict && conflict.code === 'ERR_PERSISTENCE_REVISION_CONFLICT')
  assert.equal((await handlers.load('trusted'))?.revision, 1)
  await assert.rejects(handlers.save('trusted', document, -1), /revision/)
})
