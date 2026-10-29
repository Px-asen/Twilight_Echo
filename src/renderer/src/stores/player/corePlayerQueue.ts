import { computed } from 'vue'
import type { CorePlayerClient } from './corePlayerTypes.ts'
import { createCorePlayerResource } from './corePlayerResource.ts'
import type { TrackData } from '../../../../shared/track.ts'
import type { CoreTrackView } from '../../../../shared/coreViews.ts'
import type { CoreQueueReference } from '../../../../shared/coreProtocol.ts'
import {
  isAuthorizedProviderQueueCover,
  type CoreQueueSubmitReply,
  type CoreQueueTrackInput
} from '../../../../shared/coreQueueSubmission.ts'
import {
  LIBRARY_PAGE_SIZE,
  type LibraryQueueSnapshot,
  type LibraryQueueEdit,
  type LibraryQuery
} from '../../../../shared/libraryDatabase.ts'
import type { LibraryQueuePageOptions } from '../../../../core/playback/libraryPlaybackController.ts'

type QueueTrack = CoreTrackView | TrackData
type ExpectedQueue = Pick<LibraryQueueSnapshot, 'id' | 'revision'>
export type CoreQueueInputPageProducer = (
  append: (items: CoreQueueTrackInput[]) => Promise<void>
) => Promise<unknown>
type RendererQueueEdit =
  | Exclude<LibraryQueueEdit, { kind: 'insert' }>
  | {
      kind: 'insert'
      items?: CoreQueueTrackInput[]
      trackIds?: string[]
      afterEntryId?: string
      beforeEntryId?: string
    }

/** Identity-only submission. Never copy transient URLs or grant source access from display data. */
export function coreQueueTrackInput(
  track: QueueTrack,
  networkRevision: number | null,
  queue?: ExpectedQueue
): CoreQueueTrackInput {
  if (track.queueEntryId && queue)
    return {
      kind: 'occurrence',
      queueId: queue.id,
      revision: queue.revision,
      occurrenceId: track.queueEntryId
    }
  if ('networkSource' in track && track.networkSource) {
    if (networkRevision === null) throw new Error('网络音源尚未就绪')
    return {
      kind: 'network',
      revision: networkRevision,
      profileId: track.networkSource.profileId,
      entryId: track.networkSource.entry.id
    }
  }
  const source = track.source ?? 'local'
  if (source === 'radio') return { kind: 'stream', source: 'radio', id: track.id }
  if (source === 'podcast') return { kind: 'stream', source: 'podcast', id: track.id }
  if (source !== 'local') {
    const rawCover =
      ('cover' in track && typeof track.cover === 'string' && track.cover
        ? track.cover
        : 'coverSmall' in track &&
            typeof (track as { coverSmall?: unknown }).coverSmall === 'string'
          ? (track as { coverSmall: string }).coverSmall
          : null)?.trim() ?? null
    const cover = isAuthorizedProviderQueueCover(rawCover) ? rawCover : undefined
    return {
      kind: 'provider',
      track: {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
        source,
        ...(track.ncmSongId === undefined ? {} : { ncmSongId: track.ncmSongId }),
        ...(cover === undefined ? {} : { cover })
      }
    }
  }
  return {
    kind: 'local',
    id: track.id,
    ...('filePath' in track && track.filePath
      ? {
          fallback: {
            filePath: track.filePath,
            title: track.title,
            artist: track.artist,
            album: track.album,
            duration: track.duration,
            ...(track.subTrack ? { subTrack: track.subTrack } : {}),
            ...(track.cueRange ? { cueRange: track.cueRange } : {})
          }
        }
      : {})
  }
}

export function createCorePlayerQueue(core: CorePlayerClient, failed: (error: unknown) => void) {
  const reference = computed(() => core.state.value?.queue ?? null)
  const pageKey = () => {
    const state = core.state.value,
      queue = state?.queue
    return state?.phase === 'ready' && queue
      ? `${state.epoch}:${queue.id}:${queue.revision}:${queue.index}`
      : ''
  }
  const page = createCorePlayerResource(
    pageKey,
    () => {
      const queue = reference.value!
      return core.query('queue.page', {
        id: queue.id,
        revision: queue.revision,
        offset: Math.floor(Math.max(0, queue.index) / LIBRARY_PAGE_SIZE) * LIBRARY_PAGE_SIZE,
        limit: LIBRARY_PAGE_SIZE
      })
    },
    failed
  )
  const snapshot = computed<LibraryQueueSnapshot | null>(() => {
    const queue = reference.value
    if (!queue) return null
    const mode = core.state.value?.playback?.playMode ?? 'sequential'
    return Object.freeze({
      ...queue,
      selectedEntryId: queue.occurrenceId,
      order: mode === 'shuffle' ? 'shuffle' : 'original',
      playMode: mode === 'heart' ? 'sequential' : mode
    })
  })
  function current(expected?: ExpectedQueue) {
    const queue = reference.value
    if (!queue || (expected && (queue.id !== expected.id || queue.revision !== expected.revision)))
      throw new Error('播放队列已变化，请刷新后重试')
    return queue
  }
  async function readPage(pageNumber: number) {
    const queue = current()
    return core.query('queue.page', {
      id: queue.id,
      revision: queue.revision,
      offset: pageNumber * LIBRARY_PAGE_SIZE,
      limit: LIBRARY_PAGE_SIZE
    })
  }
  async function select(entryId: string, expected: ExpectedQueue): Promise<void> {
    const queue = current(expected)
    const row = await core.query('queue.locate', {
      id: queue.id,
      revision: queue.revision,
      occurrenceId: entryId
    })
    current(expected)
    if (row.position === null) throw new Error('该队列项已不可用，请刷新后重试')
    await core.command('queue.select', {
      id: queue.id,
      revision: queue.revision,
      index: row.position,
      occurrenceId: entryId
    })
  }
  async function insert(tracks: readonly QueueTrack[], next = false): Promise<void> {
    if (!tracks.length) return
    if (!reference.value) {
      await submit(tracks, 0, undefined, false)
      return
    }
    let queue = current()
    for (let offset = 0; offset < tracks.length; offset += 200) {
      const afterEntryId = next ? queue.occurrenceId : undefined
      queue = (await core.command('queue.insert', {
        id: queue.id,
        revision: queue.revision,
        items: tracks
          .slice(offset, offset + 200)
          .map((track) =>
            coreQueueTrackInput(track, core.state.value?.network?.revision ?? null, queue)
          ),
        ...(afterEntryId ? { afterEntryId } : {})
      })) as CoreQueueReference
    }
  }
  async function entryAt(index: number, expected: ExpectedQueue) {
    current(expected)
    const result = await core.query('queue.page', {
      ...expected,
      offset: index,
      limit: 1
    })
    current(expected)
    const entry = result.items[0]
    if (!entry || entry.position !== index) throw new Error('该队列项已不可用，请刷新后重试')
    return entry
  }
  async function submitInputs(
    produce: (append: (items: CoreQueueTrackInput[]) => Promise<void>) => Promise<unknown>,
    selectedIndex: number,
    position?: number,
    play = true,
    check: () => void = () => {}
  ) {
    check()
    const started = (await core.command('queue.submit', {
      kind: 'begin',
      selectedIndex,
      play,
      ...(position === undefined ? {} : { position })
    })) as CoreQueueSubmitReply
    let sequence = started.sequence,
      committing = false
    try {
      await produce(async (items) => {
        check()
        await core.command('queue.submit', {
          kind: 'append',
          id: started.id,
          sequence: ++sequence,
          items
        })
      })
      check()
      committing = true
      await core.command('queue.submit', { kind: 'commit', id: started.id, sequence: ++sequence })
    } catch (error) {
      // A commit with a lost reply may already own playback. Never abort or replay it.
      if (!committing)
        await core.command('queue.submit', { kind: 'abort', id: started.id }).catch(() => {})
      throw error
    }
  }
  async function submit(
    tracks: readonly QueueTrack[],
    selectedIndex: number,
    position?: number,
    play = true
  ) {
    await submitInputs(
      async (append) => {
        for (let offset = 0; offset < tracks.length; offset += 200)
          await append(
            tracks
              .slice(offset, offset + 200)
              .map((track) =>
                coreQueueTrackInput(track, core.state.value?.network?.revision ?? null)
              )
          )
      },
      selectedIndex,
      position,
      play
    )
  }
  async function appendLibraryQueuePages(
    produce: CoreQueueInputPageProducer,
    rethrow = true,
    options: LibraryQueuePageOptions = {}
  ): Promise<void> {
    const check = () => {
      options.signal?.throwIfAborted()
      options.guard?.()
    }
    const produceInputs = (append: (items: CoreQueueTrackInput[]) => Promise<void>) =>
      produce(async (items) => {
        for (let offset = 0; offset < items.length; offset += 200) {
          check()
          await append(items.slice(offset, offset + 200))
        }
      })
    try {
      check()
      if (!reference.value) {
        await submitInputs(produceInputs, 0, undefined, false, check)
        return
      }
      let queue = current()
      await produceInputs(async (items) => {
        check()
        queue = (await core.command('queue.insert', {
          id: queue.id,
          revision: queue.revision,
          items
        })) as CoreQueueReference
      })
    } catch (error) {
      failed(error)
      if (rethrow) throw error
    }
  }
  async function playTrackFromPosition(
    track: QueueTrack,
    position: number,
    tracks?: readonly QueueTrack[],
    context?: { heartModePlaylistId?: number | null }
  ) {
    if (context?.heartModePlaylistId) {
      await core.command('liked.play', { selectedId: track.id, play: true })
      return
    }
    if (!tracks && track.queueEntryId && reference.value) {
      await select(track.queueEntryId, reference.value)
      if (position !== 0) await core.command('playback.seek', { position })
      return
    }
    const input = tracks ?? [track]
    const occurrenceIndex = track.queueEntryId
      ? input.findIndex((item) => item.queueEntryId === track.queueEntryId)
      : input.indexOf(track)
    const selectedIndex =
      occurrenceIndex >= 0 ? occurrenceIndex : input.findIndex((item) => item.id === track.id)
    if (selectedIndex < 0) throw new Error('所选曲目不在队列中')
    await submit(input, selectedIndex, position)
  }
  const undoQueue = async (revision?: number) => {
    const queue = current()
    if (!queue.canUndo || (revision !== undefined && queue.revision !== revision)) return false
    await core.command('queue.undo', { id: queue.id, revision: queue.revision })
    return true
  }
  const editLibraryQueue = async (edit: RendererQueueEdit, expected: ExpectedQueue) => {
    current(expected)
    if (edit.kind === 'select') return select(edit.entryId, expected)
    if (edit.kind === 'undo') {
      await undoQueue(expected.revision)
      return
    }
    if (edit.kind === 'mode') {
      await core.command('playback.mode', { mode: edit.mode })
      return
    }
    if (edit.kind === 'step') {
      await core.command(edit.direction > 0 ? 'playback.next' : 'playback.previous', {})
      return
    }
    if (edit.kind === 'insert') {
      const items = edit.items ?? edit.trackIds?.map((id) => ({ kind: 'local' as const, id })) ?? []
      await core.command('queue.insert', {
        ...expected,
        items,
        ...(edit.afterEntryId ? { afterEntryId: edit.afterEntryId } : {}),
        ...(edit.beforeEntryId ? { beforeEntryId: edit.beforeEntryId } : {})
      })
      return
    }
    await core.command('queue.edit', { ...expected, edit })
  }
  return {
    // SQLite owns the complete queue. Legacy array consumers must not mistake
    // the current bounded page for a complete source.
    queue: computed<readonly TrackData[]>(() => Object.freeze([])),
    queueCount: computed(() => reference.value?.total ?? 0),
    queueWindow: computed(() =>
      Object.freeze(
        page.value.value?.items.flatMap((item) =>
          item.track ? [Object.freeze({ ...item.track, queueEntryId: item.queueEntryId })] : []
        ) ?? []
      )
    ),
    queueIndex: computed(() => reference.value?.index ?? -1),
    libraryQueue: computed(() =>
      page.value.value && snapshot.value
        ? {
            queue: snapshot.value,
            libraryRevision: page.value.value.libraryRevision,
            items: page.value.value.items
          }
        : null
    ),
    libraryQueueSnapshot: snapshot,
    libraryQueueReference: computed(() =>
      reference.value
        ? {
            id: reference.value.id,
            revision: reference.value.revision,
            entryId: reference.value.occurrenceId,
            index: reference.value.index
          }
        : null
    ),
    libraryQueueContentRevision: computed(() => page.value.value?.libraryRevision ?? 0),
    libraryQueueActive: computed(() => !!reference.value),
    libraryQueueBusy: page.loading,
    canUndoQueue: computed(() => reference.value?.canUndo ?? false),
    queueUndoLabel: computed(() => reference.value?.undoLabel ?? ''),
    undoQueue,
    editLibraryQueue,
    readLibraryQueuePage: readPage,
    refreshLibraryQueue: async () => {
      await core.command('queue.refresh', {})
      await page.refresh()
    },
    playLibraryQueueEntry: select,
    duplicateLibraryQueueEntry: async (entryId: string, next: boolean, expected: ExpectedQueue) => {
      const queue = current(expected)
      await core.command('queue.insert', {
        ...expected,
        items: [
          { kind: 'occurrence', queueId: queue.id, revision: queue.revision, occurrenceId: entryId }
        ],
        ...(next && queue.occurrenceId ? { afterEntryId: queue.occurrenceId } : {})
      })
    },
    playTrack: (
      track: QueueTrack,
      tracks?: readonly QueueTrack[],
      context?: { heartModePlaylistId?: number | null }
    ) => playTrackFromPosition(track, 0, tracks, context),
    playTrackFromPosition,
    playLibraryQuery: async (
      query: LibraryQuery,
      selectedId?: string,
      options: {
        positionSeconds?: number
        randomStart?: boolean
        playMode?: Exclude<import('../../../../shared/audioEngineTypes.ts').PlayMode, 'heart'>
        onQueryFailure?: (error: unknown) => void
      } = {}
    ) => {
      try {
        await core.command('queue.fromQuery', {
          query,
          ...(selectedId ? { selectedId } : {}),
          play: true,
          ...(options.positionSeconds === undefined ? {} : { position: options.positionSeconds }),
          ...(options.randomStart === undefined ? {} : { randomStart: options.randomStart }),
          ...(options.playMode === undefined ? {} : { playMode: options.playMode })
        })
      } catch (error) {
        options.onQueryFailure?.(error)
        throw error
      }
    },
    enqueueTrack: (track: QueueTrack) => insert([track]),
    playNextTrack: (track: QueueTrack) => insert([track], true),
    appendQueueTracks: (tracks: readonly QueueTrack[]) => insert(tracks),
    replaceQueue: (tracks: readonly QueueTrack[]) => submit(tracks, 0, undefined, false),
    appendQueueTracksAsync: (tracks: readonly QueueTrack[]) => insert(tracks),
    appendLibraryQueuePages,
    removeQueueItem: async (index: number) => {
      const queue = current()
      const entry = await entryAt(index, queue)
      await editLibraryQueue({ kind: 'remove', entryIds: [entry.queueEntryId] }, queue)
    },
    reorderQueue: async (from: number, to: number) => {
      const queue = current()
      const source = await entryAt(from, queue)
      const beforeIndex = from < to ? to + 1 : to
      const before = beforeIndex < queue.total ? await entryAt(beforeIndex, queue) : null
      await editLibraryQueue(
        {
          kind: 'move',
          entryId: source.queueEntryId,
          beforeEntryId: before?.queueEntryId ?? null
        },
        queue
      )
    },
    saveQueueAsPlaylist: async (
      name: string,
      _create?: unknown,
      _createPages?: unknown,
      signal?: AbortSignal
    ) => {
      signal?.throwIfAborted()
      const queue = current()
      const result = (await core.command('playlists.saveQueue', {
        name,
        revision: core.state.value!.playlistsRevision!,
        queue: { id: queue.id, revision: queue.revision }
      })) as { id: string; revision: number }
      return result.id
    },
    clearQueue: () =>
      reference.value ? editLibraryQueue({ kind: 'clear' }, current()) : Promise.resolve()
  }
}
