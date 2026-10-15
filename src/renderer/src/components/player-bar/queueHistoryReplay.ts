import { ref, watch, type Ref } from 'vue'
import type { Track } from '../../types/music'
import type { PlaybackOrderEntry, SavedQueueTrack } from '../../../../shared/queueWorkspace.ts'
import {
  resolveQueueSession,
  type QueueSessionRestoreSources
} from '../../stores/player/queueSessionRestore.ts'

interface QueueHistoryReplayOptions {
  queue: Ref<Track[]>
  history: Ref<PlaybackOrderEntry[]>
  currentEntryId: () => string | undefined
  isAvailable: () => boolean
  getSources: (tracks: SavedQueueTrack[]) => Promise<Omit<QueueSessionRestoreSources, 'isCurrent'>>
  playNextTrack: (track: Track) => void
  playTrack: (track: Track) => void
  onUnavailable: (message: string) => void
}

/** Resolve the saved audio identity before inserting a fresh queue occurrence. */
export function createQueueHistoryReplay(options: QueueHistoryReplayOptions) {
  const loading = ref(false)
  let generation = 0

  function cancel(): void {
    generation++
    loading.value = false
  }

  // Navigation away and back is still a new playback choice, even when its
  // final entry identity matches the one captured by an earlier request.
  const stop = watch([options.queue, options.currentEntryId], cancel, { flush: 'sync' })

  function dispose(): void {
    stop()
    cancel()
  }

  async function replay(entryId: string): Promise<void> {
    const entry = options.history.value.find((item) => item.id === entryId)
    if (!entry || !options.isAvailable()) return
    const request = ++generation
    const queue = options.queue.value
    const currentEntryId = options.currentEntryId()
    const isCurrent = (): boolean =>
      request === generation &&
      options.isAvailable() &&
      options.queue.value === queue &&
      options.currentEntryId() === currentEntryId
    loading.value = true
    try {
      const sources = await options.getSources([entry.track])
      if (!isCurrent()) return
      const restored = await resolveQueueSession(
        {
          id: entry.id,
          name: '历史重播',
          createdAt: entry.playedAt,
          updatedAt: entry.playedAt,
          playMode: entry.playMode === 'heart' ? 'sequential' : entry.playMode,
          entries: [entry.track],
          originalEntryIds: [entry.track.queueEntryId],
          currentEntryId: entry.track.queueEntryId,
          position: 0
        },
        { ...sources, isCurrent }
      )
      if (!isCurrent()) return
      const track = restored.queue[0]
      if (!track) {
        options.onUnavailable(restored.missing[0]?.reason ?? '这首歌曲暂时无法播放')
        return
      }
      const existing = new Set(queue.map((item) => item.queueEntryId))
      options.playNextTrack(track)
      const inserted = options.queue.value.find(
        (item) => item.queueEntryId && !existing.has(item.queueEntryId)
      )
      if (inserted) options.playTrack(inserted)
    } catch (error) {
      if (isCurrent())
        options.onUnavailable(error instanceof Error ? error.message : '历史曲目载入失败')
    } finally {
      if (request === generation) loading.value = false
    }
  }

  return { loading, replay, cancel, dispose }
}
