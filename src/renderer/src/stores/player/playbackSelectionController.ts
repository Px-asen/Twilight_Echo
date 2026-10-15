import type { Ref } from 'vue'
import type { Track, QueuePlaybackOrigin } from '@renderer/types/music'
import type { PlayMode } from '@renderer/types/settings'
import { shuffleArray } from '@renderer/utils/playerQueueUtils.ts'
import {
  createPlaybackQueueSnapshotCache,
  toPlaybackQueueSnapshots
} from '@renderer/utils/playbackQueueVirtualization.ts'
import { withQueuePlaybackOrigin } from '@renderer/utils/queuePlaybackOrigin.ts'

export interface PlaybackSelectionContext {
  heartModePlaylistId?: number | null
  queuePlaybackOrigin?: QueuePlaybackOrigin | null
}

interface PlaybackSelectionOptions {
  queue: Ref<Track[]>
  queueIndex: Ref<number>
  playMode: Ref<PlayMode>
  setHeartModeContext: (playlistId: number | null) => void
  exitHeartModeForManualQueueReplacement: () => void
  isPersonalizedStreamTrack: (track: Track) => boolean
  endPersonalizedStream: () => void
  activateCurrentTrack: (track: Track, options: { resetUi: boolean; position: number }) => void
  loadAndPlay: (track: Track, position?: number) => Promise<void>
  replaceQueue: (queue: Track[], index: number, original: Track[]) => void
}

export function createPlaybackSelectionController(options: PlaybackSelectionOptions) {
  const queueSnapshots = createPlaybackQueueSnapshotCache()
  function playTrackFromPosition(
    track: Track,
    positionSeconds: number,
    trackList?: Track[],
    context?: PlaybackSelectionContext
  ): void {
    if (trackList) {
      options.setHeartModeContext(context?.heartModePlaylistId ?? null)
      options.exitHeartModeForManualQueueReplacement()
    }
    if (trackList || !options.isPersonalizedStreamTrack(track)) options.endPersonalizedStream()
    if (trackList) {
      const baseSnapshots = queueSnapshots(trackList)
      const snapshots =
        context && 'queuePlaybackOrigin' in context
          ? baseSnapshots.map((item) => withQueuePlaybackOrigin(item, context.queuePlaybackOrigin))
          : baseSnapshots
      const selectedIndex = track.queueEntryId
        ? snapshots.findIndex((item) => item.queueEntryId === track.queueEntryId)
        : trackList.indexOf(track)
      const selected =
        snapshots[
          selectedIndex >= 0 ? selectedIndex : snapshots.findIndex((item) => item.id === track.id)
        ]
      if (!selected) return
      const queue = options.playMode.value === 'shuffle' ? shuffleArray(snapshots) : [...snapshots]
      options.replaceQueue(
        queue,
        queue.findIndex((item) => item.queueEntryId === selected.queueEntryId),
        snapshots
      )
      track = {
        ...track,
        queueEntryId: selected.queueEntryId,
        queuePlaybackOrigin: selected.queuePlaybackOrigin
      }
    } else {
      const index = options.queue.value.findIndex((item) =>
        track.queueEntryId ? item.queueEntryId === track.queueEntryId : item.id === track.id
      )
      if (index >= 0) {
        options.queueIndex.value = index
        track = {
          ...track,
          queueEntryId: options.queue.value[index].queueEntryId,
          queuePlaybackOrigin: options.queue.value[index].queuePlaybackOrigin
        }
      } else {
        const snapshots = toPlaybackQueueSnapshots([track])
        options.replaceQueue(snapshots, 0, [...snapshots])
        track = { ...track, queueEntryId: snapshots[0].queueEntryId }
      }
    }
    if (options.queueIndex.value === -1) options.queueIndex.value = 0
    const start = Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0
    options.activateCurrentTrack(track, { resetUi: true, position: start })
    void options.loadAndPlay(track, start)
  }

  function playTrack(track: Track, trackList?: Track[], context?: PlaybackSelectionContext): void {
    playTrackFromPosition(track, 0, trackList, context)
  }

  return { playTrack, playTrackFromPosition }
}
