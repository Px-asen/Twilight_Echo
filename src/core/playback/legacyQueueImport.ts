import type { CoreQueueImportApi } from '../../shared/coreQueueImport.ts'
import { LIBRARY_PAGE_SIZE, type LibraryQueueSnapshot } from '../../shared/libraryDatabase.ts'
import type { PlaybackSessionData } from '../../shared/playbackSession.ts'
import type { TrackData } from '../../shared/track.ts'
import { getTrackSource } from '../../shared/trackSourceIdentity.ts'
import { normalizeCueRange } from '../../shared/cue.ts'
import { toPlaybackQueueSnapshots } from './queueSnapshots.ts'
import { cloneTrackForPlaybackSession } from './sessionTrack.ts'
import type { LibraryQueueApi } from './libraryQueueSource.ts'

/** Import a durable array. Old backups use displayed order as original order;
 * modern migration bundles may supply the separately persisted original order. */
export async function importLegacyQueue(options: {
  api: CoreQueueImportApi & Pick<LibraryQueueApi, 'readQueue'>
  session: PlaybackSessionData<TrackData>
  sessionRevision: number
  libraryRevision: number
  scope?: string
  /** Optional modern migration metadata; old array-only backups keep their original behavior. */
  originalEntryIds?: string[]
}): Promise<{ queue: LibraryQueueSnapshot; position: number }> {
  const { session, api } = options
  const tracks = toPlaybackQueueSnapshots(
    (session.queue?.length ? session.queue : [session.track]).map(cloneTrackForPlaybackSession)
  )
  const original = options.originalEntryIds
  const originalPositions = original ? new Map(original.map((id, index) => [id, index])) : null
  if (
    original &&
    (original.length !== tracks.length ||
      originalPositions!.size !== tracks.length ||
      tracks.some((track) => !originalPositions!.has(track.queueEntryId!)))
  )
    throw new Error('迁移队列的原始顺序与 occurrence 不一致')
  let selected = session.track.queueEntryId
    ? tracks.findIndex(
        (t) => t.queueEntryId === session.track.queueEntryId && t.id === session.track.id
      )
    : -1
  if (
    selected < 0 &&
    Number.isInteger(session.queueIndex) &&
    session.queueIndex! >= 0 &&
    tracks[session.queueIndex!]?.id === session.track.id
  )
    selected = session.queueIndex!
  if (selected < 0) selected = tracks.findIndex((t) => t.id === session.track.id)
  const sameSelection =
    selected >= 0 &&
    (!session.track.queueEntryId || tracks[selected].queueEntryId === session.track.queueEntryId)
  if (selected < 0) selected = 0
  const id = `core-session-${options.scope ? `${options.scope}-` : ''}${options.sessionRevision}`
  const start = {
    kind: 'begin' as const,
    id,
    contentRevision: options.libraryRevision,
    order: session.playMode === 'shuffle' ? ('shuffle' as const) : ('original' as const)
  }
  let opened = await api.importLegacyPlaybackQueue(start)
  // Retire only incomplete import rows, with a bounded DB turn per page. Do
  // not replay any append/commit whose result became unknown in this attempt.
  while (opened.kind === 'retiring') opened = await api.importLegacyPlaybackQueue(start)
  let queue: LibraryQueueSnapshot
  if (opened.kind === 'ready') queue = opened.queue
  else {
    if (opened.kind !== 'building' || opened.total !== 0 || opened.sequence !== 0)
      throw new Error('Invalid Core queue import start')
    let sequence = 0
    for (let offset = 0; offset < tracks.length; offset += LIBRARY_PAGE_SIZE) {
      const items = tracks.slice(offset, offset + LIBRARY_PAGE_SIZE).map((track) => ({
        id: track.id,
        occurrenceId: track.queueEntryId!,
        ...(originalPositions
          ? { originalPosition: originalPositions.get(track.queueEntryId!)! }
          : {}),
        ...(getTrackSource(track) === 'local'
          ? { localSnapshot: { ...track } }
          : { snapshot: { ...track } })
      }))
      const result = await api.importLegacyPlaybackQueue({
        kind: 'append',
        id,
        sequence: ++sequence,
        items
      })
      if (
        result.kind !== 'building' ||
        result.sequence !== sequence ||
        result.total !== offset + items.length
      )
        throw new Error('Invalid Core queue import batch acknowledgement')
    }
    const result = await api.importLegacyPlaybackQueue({
      kind: 'commit',
      id,
      sequence: ++sequence,
      selectedIndex: selected
    })
    if (result.kind !== 'ready') throw new Error('Core queue import did not publish')
    queue = result.queue
  }
  // A lost publication reply is recovered by reading, never by inserting the
  // same globally unique occurrences into another queue or generating new IDs.
  if (
    queue.id !== id ||
    queue.total !== tracks.length ||
    queue.index !== selected ||
    queue.selectedEntryId !== tracks[selected].queueEntryId ||
    queue.order !== start.order
  )
    throw new Error('Published Core import does not match the legacy session')
  for (let offset = 0; offset < tracks.length; offset += LIBRARY_PAGE_SIZE) {
    const page = await api.readQueue(id, offset, LIBRARY_PAGE_SIZE, {
      expectedRevision: queue.revision
    })
    if (
      page.offset !== offset ||
      page.items.length !== Math.min(LIBRARY_PAGE_SIZE, tracks.length - offset)
    )
      throw new Error('Incomplete Core queue import readback')
    for (let i = 0; i < page.items.length; i++) {
      const row = page.items[i],
        track = tracks[offset + i]
      if (
        row.queueEntryId !== track.queueEntryId ||
        row.track?.id !== track.id ||
        row.track.filePath !== track.filePath ||
        row.track.subTrack !== track.subTrack ||
        JSON.stringify(normalizeCueRange(row.track.cueRange)) !==
          JSON.stringify(normalizeCueRange(track.cueRange))
      )
        throw new Error('Core queue import changed a legacy occurrence or source segment')
    }
  }
  const duration = tracks[selected].duration
  const position =
    sameSelection && session.mode === 'trackAndPosition'
      ? Math.max(
          0,
          Number.isFinite(duration) && duration > 0
            ? Math.min(session.position, duration)
            : session.position
        )
      : 0
  return { queue, position }
}
