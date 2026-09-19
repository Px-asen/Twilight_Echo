import { ref, shallowRef, type Ref } from 'vue'
import type { Track } from '@renderer/types/music'
import type { PlayMode } from '@renderer/types/settings'
import { captureQueueSession } from '@renderer/utils/queueSessionTrack.ts'
import {
  resolveQueueSession,
  type QueueSessionRestoreSources,
  type QueueSessionRestoreResult
} from '@renderer/stores/player/queueSessionRestore.ts'
import type { createQueueWorkspaceStore } from '@renderer/stores/player/queueWorkspaceStore.ts'
import type { NamedQueueSession } from '../../../../shared/queueWorkspace.ts'

interface QueueSessionOptions {
  workspace: ReturnType<typeof createQueueWorkspaceStore>
  queue: Ref<Track[]>
  originalQueue: Ref<Track[]>
  currentTrack: Ref<Track | null>
  playMode: Ref<PlayMode>
  revision: Ref<number>
  getPosition: () => number
  getSources: (
    entries: NamedQueueSession['entries']
  ) => Promise<Omit<QueueSessionRestoreSources, 'isCurrent'>>
  prepare: (result: QueueSessionRestoreResult, mode: NamedQueueSession['playMode']) => void
  play: () => Promise<void>
}

export function createQueueSessionController(options: QueueSessionOptions) {
  const open = ref(false)
  const tab = ref<'sessions' | 'history'>('sessions')
  const restoring = ref(false)
  const lastRestore = shallowRef<QueueSessionRestoreResult | null>(null)
  let generation = 0

  function show(nextTab: 'sessions' | 'history' = 'sessions'): void {
    lastRestore.value = null
    tab.value = nextTab
    open.value = true
  }

  function cancelRestore(): void {
    generation++
    restoring.value = false
  }

  function save(name: string, id?: string): Promise<void> {
    const session = captureQueueSession(
      name,
      options.queue.value,
      options.originalQueue.value,
      options.currentTrack.value,
      options.getPosition(),
      options.playMode.value,
      id
    )
    return options.workspace.save(session, !!id)
  }

  async function restore(id: string, andPlay = false): Promise<void> {
    const session = options.workspace.sessions.value.find((item) => item.id === id)
    if (!session) throw new Error('此会话已删除，请刷新后重试')
    const request = ++generation
    const revision = options.revision.value
    const selection = options.currentTrack.value?.queueEntryId
    const isCurrent = (): boolean =>
      request === generation &&
      revision === options.revision.value &&
      selection === options.currentTrack.value?.queueEntryId &&
      options.workspace.sessions.value.find((item) => item.id === id)?.updatedAt ===
        session.updatedAt
    restoring.value = true
    lastRestore.value = null
    try {
      const sources = await options.getSources(session.entries)
      if (!isCurrent()) throw new Error('队列已变化，已取消恢复，请重新选择会话')
      const result = await resolveQueueSession(session, { ...sources, isCurrent })
      lastRestore.value = result
      if (!result.queue.length) throw new Error('会话中的资源均不可用，当前队列未改变')
      options.prepare(result, session.playMode)
      if (andPlay) await options.play()
    } finally {
      if (request === generation) restoring.value = false
    }
  }

  return { open, tab, restoring, lastRestore, show, cancelRestore, save, restore }
}
