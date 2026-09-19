import type { Ref } from 'vue'
import type { Track } from '@renderer/types/music'
import type { PlayMode } from '@renderer/types/settings'
import { shuffleArray } from '@renderer/utils/playerQueueUtils.ts'
import { createQueueCommandController } from '@renderer/stores/player/queueCommandController.ts'

export type PersonalizedStreamKey = 'fm' | 'radar'
export interface PersonalizedStreamSession {
  id: number
  key: PersonalizedStreamKey
}

export interface PlaybackQueueControllerOptions {
  currentTrack: Ref<Track | null>
  queue: Ref<Track[]>
  originalQueue: Ref<Track[]>
  queueIndex: Ref<number>
  playMode: Ref<PlayMode>
  isPlaying: Ref<boolean>
  personalizedStreamSession: Ref<PersonalizedStreamSession | null>
  personalizedStreamRemaining: Ref<number>
  personalizedStreamEntryIds: Set<string>
  personalizedStreamPlayedEntryIds: Set<string>
  rendererPlayModeBoundaryPending: Ref<boolean>
  persistPlaybackSessionAfterQueueMutation: () => void
  queueNativeQueueStateSync: () => Promise<void>
  setAudioEngineError: (error: string | null) => void
  clearAutomaticLyricsBaselines: () => void
  getPosition: () => number
  prepareSelection: (track: Track | null, position: number) => void
  onQueueNotice?: (label: string, revision: number) => void
  exitHeartModeForQueueEdit: () => void
}

export function createPlaybackQueueController(options: PlaybackQueueControllerOptions) {
  let personalizedStreamSessionSequence = 0
  const commands = createQueueCommandController({
    ...options,
    onNotice: options.onQueueNotice,
    beforeUndo: endPersonalizedStream,
    onMutation: () => {
      options.persistPlaybackSessionAfterQueueMutation()
      void options.queueNativeQueueStateSync().catch((error) => {
        options.setAudioEngineError(error instanceof Error ? error.message : String(error))
      })
    }
  })

  function getPersonalizedStreamEntryId(track: Track | null): string | null {
    if (!track) return null
    if (track.queueEntryId) return track.queueEntryId
    const queued = options.queue.value[options.queueIndex.value]
    if (queued?.id === track.id && queued.queueEntryId) return queued.queueEntryId
    return options.queue.value.find((candidate) => candidate.id === track.id)?.queueEntryId ?? null
  }

  function refreshPersonalizedStreamRemaining(): void {
    if (!options.personalizedStreamSession.value) {
      options.personalizedStreamRemaining.value = 0
      return
    }
    let remaining = 0
    for (const entryId of options.personalizedStreamEntryIds) {
      if (!options.personalizedStreamPlayedEntryIds.has(entryId)) remaining += 1
    }
    options.personalizedStreamRemaining.value = remaining
  }

  function markCurrentPersonalizedStreamTrackPlayed(): void {
    if (!options.personalizedStreamSession.value) return
    const entryId = getPersonalizedStreamEntryId(options.currentTrack.value)
    if (!entryId || !options.personalizedStreamEntryIds.has(entryId)) return
    options.personalizedStreamPlayedEntryIds.add(entryId)
    refreshPersonalizedStreamRemaining()
  }

  function endPersonalizedStream(): void {
    options.personalizedStreamSession.value = null
    options.personalizedStreamEntryIds.clear()
    options.personalizedStreamPlayedEntryIds.clear()
    options.personalizedStreamRemaining.value = 0
  }

  function isPersonalizedStreamTrack(track: Track): boolean {
    if (!options.personalizedStreamSession.value) return false
    if (track.queueEntryId) return options.personalizedStreamEntryIds.has(track.queueEntryId)
    return options.queue.value.some(
      (candidate) =>
        candidate.id === track.id &&
        !!candidate.queueEntryId &&
        options.personalizedStreamEntryIds.has(candidate.queueEntryId)
    )
  }

  function startPersonalizedStream(key: PersonalizedStreamKey): PersonalizedStreamSession {
    options.personalizedStreamEntryIds.clear()
    options.personalizedStreamPlayedEntryIds.clear()
    for (const track of options.queue.value) {
      if (track.queueEntryId) options.personalizedStreamEntryIds.add(track.queueEntryId)
    }
    const session = { id: ++personalizedStreamSessionSequence, key }
    options.personalizedStreamSession.value = session
    markCurrentPersonalizedStreamTrackPlayed()
    refreshPersonalizedStreamRemaining()
    return session
  }

  function isPersonalizedStreamSessionCurrent(session: PersonalizedStreamSession): boolean {
    const active = options.personalizedStreamSession.value
    return active?.id === session.id && active.key === session.key
  }

  function applyPendingRendererPlayModeAtBoundary(): void {
    if (!options.rendererPlayModeBoundaryPending.value) return
    options.rendererPlayModeBoundaryPending.value = false
    if (options.playMode.value === 'heart') return
    const current = options.currentTrack.value
    if (!current || options.originalQueue.value.length === 0) return

    if (options.playMode.value === 'shuffle') {
      const queueEntryIndex = current.queueEntryId
        ? options.originalQueue.value.findIndex(
            (track) => track.queueEntryId === current.queueEntryId
          )
        : -1
      const currentOriginalIndex =
        queueEntryIndex >= 0
          ? queueEntryIndex
          : options.originalQueue.value.findIndex((track) => track.id === current.id)
      const remaining = options.originalQueue.value.filter(
        (_, index) => index !== currentOriginalIndex
      )
      options.queue.value = [current, ...shuffleArray(remaining)]
      options.queueIndex.value = 0
      return
    }

    options.queue.value = [...options.originalQueue.value]
    options.queueIndex.value = options.queue.value.findIndex((track) =>
      current.queueEntryId ? track.queueEntryId === current.queueEntryId : track.id === current.id
    )
    if (options.queueIndex.value === -1) options.queueIndex.value = 0
  }

  function enqueueTrack(track: Track): void {
    options.exitHeartModeForQueueEdit()
    endPersonalizedStream()
    commands.add([track], options.queue.value.length, options.originalQueue.value.length)
  }

  function appendQueueTracks(tracks: readonly Track[]): void {
    if (tracks.length === 0) return
    options.exitHeartModeForQueueEdit()
    endPersonalizedStream()
    commands.add(tracks, options.queue.value.length, options.originalQueue.value.length, {
      shuffle: options.playMode.value === 'shuffle'
    })
  }

  function appendPersonalizedStreamTracks(
    session: PersonalizedStreamSession,
    tracks: readonly Track[]
  ): boolean {
    if (tracks.length === 0 || !isPersonalizedStreamSessionCurrent(session)) return false
    const additions = commands.add(
      tracks,
      options.queue.value.length,
      options.originalQueue.value.length,
      {
        shuffle: options.playMode.value === 'shuffle',
        undoable: false
      }
    )
    for (const track of additions) {
      if (track.queueEntryId) options.personalizedStreamEntryIds.add(track.queueEntryId)
    }
    refreshPersonalizedStreamRemaining()
    return true
  }

  function playNextTrack(track: Track): void {
    options.exitHeartModeForQueueEdit()
    endPersonalizedStream()
    const insertAt = options.queueIndex.value >= 0 ? options.queueIndex.value + 1 : 0
    const originalIndex = options.originalQueue.value.findIndex(
      (item) => item.queueEntryId === options.currentTrack.value?.queueEntryId
    )
    commands.add([track], insertAt, originalIndex + 1)
  }

  function removeQueueItem(index: number): void {
    options.exitHeartModeForQueueEdit()
    endPersonalizedStream()
    commands.remove(index)
  }

  function clearQueue(): void {
    if (!options.queue.value.length && !options.currentTrack.value) return
    options.exitHeartModeForQueueEdit()
    endPersonalizedStream()
    commands.replace([], -1)
    options.clearAutomaticLyricsBaselines()
  }

  function reorderQueue(fromIndex: number, toIndex: number): void {
    options.exitHeartModeForQueueEdit()
    endPersonalizedStream()
    commands.move(fromIndex, toIndex)
  }

  function saveQueueAsPlaylist(
    name: string,
    createPlaylistWithTracks: (name: string, tracks: Track[]) => string
  ): string {
    return createPlaylistWithTracks(name, [...options.queue.value])
  }

  return {
    markCurrentPersonalizedStreamTrackPlayed,
    endPersonalizedStream,
    isPersonalizedStreamTrack,
    startPersonalizedStream,
    isPersonalizedStreamSessionCurrent,
    applyPendingRendererPlayModeAtBoundary,
    commands,
    enqueueTrack,
    appendQueueTracks,
    appendPersonalizedStreamTracks,
    playNextTrack,
    removeQueueItem,
    clearQueue,
    reorderQueue,
    saveQueueAsPlaylist
  }
}
