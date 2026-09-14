import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '@renderer/types/music'
import { captureQueueSession } from '@renderer/utils/queueSessionTrack.ts'
import { createQueueWorkspaceStore, type QueueWorkspaceApi } from './queueWorkspaceStore.ts'
import {
  PersistentDataRevisionConflictError,
  type VersionedDataEnvelope
} from '../../../../shared/versionedPersistence.ts'
import type { QueueWorkspaceDocument } from '../../../../shared/queueWorkspace.ts'

const track = {
  id: 'song',
  queueEntryId: 'q1',
  title: 'Song',
  artist: '',
  album: '',
  filePath: 'C:\\music\\song.flac',
  fileName: 'song',
  source: 'local',
  duration: 100,
  size: 1,
  cover: null,
  lyrics: null
} as Track
const session = (id: string, name = id) =>
  captureQueueSession(name, [track], [track], track, 20, 'sequential', id)

function fixture() {
  let disk: VersionedDataEnvelope<QueueWorkspaceDocument> | null = null
  let loads = 0
  const revisions: number[] = []
  const api: QueueWorkspaceApi = {
    loadQueueWorkspace: async () => {
      loads++
      return disk && structuredClone(disk)
    },
    saveQueueWorkspace: async (document, revision) => {
      revisions.push(revision)
      if (revision !== (disk?.revision ?? 0))
        throw new PersistentDataRevisionConflictError(disk, revision)
      disk = {
        version: 2,
        revision: revision + 1,
        savedAt: new Date().toISOString(),
        data: structuredClone(document)
      }
      return structuredClone(disk)
    }
  }
  const store = createQueueWorkspaceStore(() => api)
  return { store, api, revisions, disk: () => disk, loads: () => loads }
}

test('named session writes serialize and support explicit overwrite, rename, delete and restart', async (t) => {
  const { store, api, revisions, loads } = fixture()
  t.after(store.dispose)
  await Promise.all([store.save(session('work')), store.save(session('sleep'))])
  assert.deepEqual(revisions, [0, 1])
  assert.equal(loads(), 1)
  await store.rename('work', '工作')
  await store.save({ ...session('work', '工作'), position: 40 }, true)
  await assert.rejects(store.save(session('duplicate', '工作')), /同名/)
  await store.remove('sleep')
  const restarted = createQueueWorkspaceStore(() => api)
  t.after(restarted.dispose)
  await restarted.ensureLoaded()
  assert.equal(restarted.sessions.value.length, 1)
  assert.equal(restarted.sessions.value[0].name, '工作')
  assert.equal(restarted.sessions.value[0].position, 40)
  await assert.rejects(restarted.save(session('gone'), true), /已删除/)
})

test('concurrent windows adopt the authoritative revision and never overwrite later session edits', async (t) => {
  const { store, api } = fixture()
  const other = createQueueWorkspaceStore(() => api)
  t.after(store.dispose)
  t.after(other.dispose)
  await store.save(session('work'))
  await other.ensureLoaded()
  await store.rename('work', '新的名称')
  await assert.rejects(other.remove('work'), /其他窗口更新/)
  assert.equal(other.sessions.value[0].name, '新的名称')
  await other.rename('work', '已重新确认')
  await store.reload()
  assert.equal(store.sessions.value[0].name, '已重新确认')
})

test('actual playback history stays ordered, bounded and survives writes and restart without losing rapid arrivals', async (t) => {
  const { store, api } = fixture()
  t.after(store.dispose)
  const historyModes = ['sequential', 'listLoop', 'repeat', 'shuffle', 'heart'] as const
  for (let index = 0; index < 210; index++)
    store.record({ ...track, queueEntryId: `q${index}` }, historyModes[index % 5])
  assert.equal(store.history.value.length, 200)
  await store.flush()
  assert.equal(store.history.value[0].track.queueEntryId, 'q10')
  const restarted = createQueueWorkspaceStore(() => api)
  t.after(restarted.dispose)
  restarted.record({ ...track, queueEntryId: 'q210' }, 'heart')
  await restarted.flush()
  assert.equal(restarted.history.value.length, 200)
  assert.equal(restarted.history.value.at(-1)?.track.queueEntryId, 'q210')
  assert.equal(restarted.history.value.at(-1)?.playMode, 'heart')
})

test('load and save errors preserve existing state and allow a deliberate retry', async (t) => {
  const { store, api } = fixture()
  t.after(store.dispose)
  const load = api.loadQueueWorkspace
  api.loadQueueWorkspace = async () => {
    throw new Error('disk read failed')
  }
  await assert.rejects(store.ensureLoaded(), /disk read failed/)
  assert.equal(store.sessions.value.length, 0)
  api.loadQueueWorkspace = load
  await store.save(session('work'))
  const save = api.saveQueueWorkspace
  api.saveQueueWorkspace = async () => {
    throw new Error('disk full')
  }
  await assert.rejects(store.remove('work'), /disk full/)
  assert.equal(store.sessions.value.length, 1)
  api.saveQueueWorkspace = save
  await store.remove('work')
  assert.equal(store.sessions.value.length, 0)
})
