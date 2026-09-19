import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, shallowRef } from 'vue'
import type { Track } from '@renderer/types/music'
import type { PlayMode } from '@renderer/types/settings'
import { captureQueueSession } from '@renderer/utils/queueSessionTrack.ts'
import { createQueueSessionController } from './queueSessionController.ts'
import { createQueueWorkspaceStore } from './queueWorkspaceStore.ts'
import type { QueueSessionRestoreSources } from './queueSessionRestore.ts'

const track = (id: string): Track => ({
  id,
  queueEntryId: id,
  source: 'local',
  title: id,
  artist: '',
  album: '',
  filePath: `C:\\music\\${id}.flac`,
  fileName: id,
  duration: 100,
  size: 1,
  cover: null,
  lyrics: null
})

function fixture() {
  const queue = shallowRef([track('old')])
  const originalQueue = shallowRef([...queue.value])
  const currentTrack = shallowRef<Track | null>(queue.value[0])
  const revision = ref(0)
  const workspace = createQueueWorkspaceStore(() => ({
    loadQueueWorkspace: async () => null,
    saveQueueWorkspace: async () => {
      throw new Error('unused')
    }
  }))
  const next = [track('new')]
  workspace.sessions.value = [
    captureQueueSession('saved', next, next, next[0], 20, 'sequential', 'saved')
  ]
  let plays = 0
  let prepares = 0
  const sources: Omit<QueueSessionRestoreSources, 'isCurrent'> = {
    localTracks: new Map(next.map((item) => [item.id, item])),
    savedStreams: new Map(),
    availableProviders: new Set(),
    networkProfiles: new Set(),
    authorizeFiles: async () => [true]
  }
  const controller = createQueueSessionController({
    workspace,
    queue,
    originalQueue,
    currentTrack,
    revision,
    playMode: ref<PlayMode>('sequential'),
    getPosition: () => 10,
    getSources: async () => sources,
    prepare: (result) => {
      queue.value = result.queue
      originalQueue.value = result.original
      currentTrack.value = result.queue[result.index]
      revision.value++
      prepares++
    },
    play: async () => {
      plays++
    }
  })
  return {
    controller,
    workspace,
    sources,
    queue,
    currentTrack,
    revision,
    plays: () => plays,
    prepares: () => prepares
  }
}

test('restore is paused by default and explicit restore-and-play uses the new selection', async (t) => {
  const state = fixture()
  t.after(state.workspace.dispose)
  await state.controller.restore('saved')
  assert.equal(state.plays(), 0)
  assert.equal(state.currentTrack.value?.id, 'new')
  await state.controller.restore('saved', true)
  assert.equal(state.plays(), 1)
  assert.equal(state.controller.lastRestore.value?.position, 20)
})

test('missing resources leave the live queue untouched and report the missing entries', async (t) => {
  const state = fixture()
  t.after(state.workspace.dispose)
  state.sources.authorizeFiles = async () => [false]
  await assert.rejects(state.controller.restore('saved', true), /均不可用/)
  assert.equal(state.currentTrack.value?.id, 'old')
  assert.equal(state.prepares(), 0)
  assert.equal(state.plays(), 0)
  assert.equal(state.controller.lastRestore.value?.missing.length, 1)
})

test('restores cannot overwrite a newer queue, playback selection or cancelled dialog', async (t) => {
  for (const cancel of ['revision', 'selection', 'dialog']) {
    const state = fixture()
    t.after(state.workspace.dispose)
    let release: (flags: boolean[]) => void = () => {}
    state.sources.authorizeFiles = () =>
      new Promise((resolve) => {
        release = resolve
      })
    const restoring = state.controller.restore('saved', true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (cancel === 'revision') state.revision.value++
    if (cancel === 'selection') state.currentTrack.value = track('other')
    if (cancel === 'dialog') state.controller.cancelRestore()
    release([true])
    await assert.rejects(restoring, /已取消恢复/)
    assert.equal(state.prepares(), 0)
    assert.equal(state.plays(), 0)
  }
})
