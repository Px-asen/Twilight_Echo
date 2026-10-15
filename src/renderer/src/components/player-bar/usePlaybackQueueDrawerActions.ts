import { ref, type Ref } from 'vue'
import type { Track } from '../../types/music'

export interface PlaybackQueueDrawerCommands {
  enqueueTrack: (track: Track) => void
  playNextTrack: (track: Track) => void
  removeQueueItem: (index: number) => void
  clearQueue: () => void
  reorderQueue: (fromIndex: number, toIndex: number) => void
  saveQueueAsPlaylist: (
    name: string,
    createPlaylistWithTracks: (name: string, tracks: Track[]) => string
  ) => string
}

interface PlaybackQueueDrawerActionOptions {
  queue: Ref<Track[]>
  commands: PlaybackQueueDrawerCommands
  createPlaylistWithTracks: (name: string, tracks: Track[]) => string
}

function normalizePlaylistName(value: string): string {
  return value.trim().slice(0, 120)
}

/**
 * Resolves every command from the queue entry identity at the instant it is
 * invoked. Virtual rows are recycled while scrolling, therefore their DOM
 * position and a captured display index are never a command input here.
 */
export function usePlaybackQueueDrawerActions({
  queue,
  commands,
  createPlaylistWithTracks
}: PlaybackQueueDrawerActionOptions) {
  const draggedEntryId = ref<string | null>(null)

  function getEntryIndex(queueEntryId: string): number {
    return queue.value.findIndex((track) => track.queueEntryId === queueEntryId)
  }

  function getEntry(queueEntryId: string): Track | null {
    const index = getEntryIndex(queueEntryId)
    return index === -1 ? null : (queue.value[index] ?? null)
  }

  function playNext(queueEntryId: string): void {
    const track = getEntry(queueEntryId)
    if (track) commands.playNextTrack(track)
  }

  function addToTail(queueEntryId: string): void {
    const track = getEntry(queueEntryId)
    if (track) commands.enqueueTrack(track)
  }

  function remove(queueEntryId: string): void {
    const index = getEntryIndex(queueEntryId)
    if (index !== -1) commands.removeQueueItem(index)
  }

  function move(queueEntryId: string, direction: -1 | 1): void {
    const index = getEntryIndex(queueEntryId)
    const target = index + direction
    if (index !== -1 && target >= 0 && target < queue.value.length)
      commands.reorderQueue(index, target)
  }

  function clear(): void {
    if (queue.value.length > 0) commands.clearQueue()
  }

  function saveAsPlaylist(name: string): string | null {
    const normalized = normalizePlaylistName(name)
    if (!normalized || queue.value.length === 0) return null
    return commands.saveQueueAsPlaylist(normalized, createPlaylistWithTracks)
  }

  function onDragStart(event: DragEvent, queueEntryId: string): void {
    if (getEntryIndex(queueEntryId) === -1) return
    draggedEntryId.value = queueEntryId
    event.dataTransfer?.setData('text/plain', queueEntryId)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  function onDragOver(event: DragEvent, targetEntryId: string): void {
    if (!draggedEntryId.value || draggedEntryId.value === targetEntryId) return
    if (getEntryIndex(targetEntryId) === -1) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  }

  function onDrop(event: DragEvent, targetEntryId: string): void {
    event.preventDefault()
    const sourceEntryId = draggedEntryId.value ?? event.dataTransfer?.getData('text/plain')
    draggedEntryId.value = null
    if (!sourceEntryId || sourceEntryId === targetEntryId) return

    // Resolve both positions after drop: scrolling or a native/session update
    // may have changed the virtual window since dragstart.
    const fromIndex = getEntryIndex(sourceEntryId)
    const toIndex = getEntryIndex(targetEntryId)
    if (fromIndex !== -1 && toIndex !== -1) commands.reorderQueue(fromIndex, toIndex)
  }

  function onDragEnd(): void {
    draggedEntryId.value = null
  }

  return {
    draggedEntryId,
    getEntryIndex,
    playNext,
    addToTail,
    remove,
    move,
    clear,
    saveAsPlaylist,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd
  }
}
