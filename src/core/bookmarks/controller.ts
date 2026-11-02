import type { Cell } from '../playlists/ports.ts'
import type { VersionedDataEnvelope } from '../../shared/versionedPersistence.ts'
import {
  MAX_BOOKMARKS,
  MAX_BOOKMARKS_PER_TRACK,
  MAX_BOOKMARK_LABEL_LENGTH,
  bookmarksForTrack,
  clampBookmarkPosition,
  clonePlaybackBookmarksDocument,
  type PlaybackBookmark,
  type PlaybackBookmarksDocument
} from '../../shared/playbackBookmarks.ts'
import { isPersistentDataRevisionConflict } from '../../shared/versionedPersistence.ts'
import type { TrackData as Track } from '../../shared/track.ts'
import { safBookmarkTrackKey } from '../../shared/safTrackIdentity.ts'

export type BookmarkTrack = Pick<
  Track,
  | 'id'
  | 'filePath'
  | 'source'
  | 'subTrack'
  | 'cueRange'
  | 'queueEntryId'
  | 'duration'
  | 'title'
  | 'artist'
>

export interface PlaybackBookmarksOptions {
  document: Cell<PlaybackBookmarksDocument>
  repository: {
    load(): Promise<VersionedDataEnvelope<PlaybackBookmarksDocument> | null>
    save(
      document: PlaybackBookmarksDocument,
      revision: number
    ): Promise<VersionedDataEnvelope<PlaybackBookmarksDocument>>
  }
  now(): number
  newId(): string
  changed(): void
}

export function createPlaybackBookmarks(runtime: PlaybackBookmarksOptions) {
  const { document } = runtime
  let revision = 0
  let loading: Promise<void> | null = null

  function trackKeyFor(
    track: Pick<Track, 'id' | 'filePath' | 'source' | 'subTrack' | 'cueRange'>
  ): string {
    const source = track.source ?? 'local'
    if (source !== 'local' || !track.filePath) return `${source}:${track.id}`
    const documentKey = safBookmarkTrackKey(track.id, track.filePath)
    if (documentKey) return documentKey
    const base = `local:${track.filePath}`
    if (track.subTrack) return `${base}#${track.subTrack}`
    if (track.cueRange) return `${base}#cue:${track.cueRange.startSeconds}`
    return base
  }

  async function ensureLoaded(): Promise<void> {
    if (loading) return loading
    loading = (async () => {
      const result = await runtime.repository.load()
      if (result?.data) {
        document.value = clonePlaybackBookmarksDocument(result.data)
        revision = result.revision
      }
    })().finally(() => {
      loading = null
    })
    return loading
  }

  async function persist(next: PlaybackBookmarksDocument): Promise<void> {
    try {
      const saved = await runtime.repository.save(next, revision)
      document.value = clonePlaybackBookmarksDocument(saved.data)
      revision = saved.revision
      runtime.changed()
    } catch (error) {
      if (!isPersistentDataRevisionConflict(error)) throw error
      const current = error.current
      if (!current) throw error
      document.value = clonePlaybackBookmarksDocument(current.data as PlaybackBookmarksDocument)
      revision = current.revision
      runtime.changed()
      throw error
    }
  }

  function nextDocument(): PlaybackBookmarksDocument {
    return clonePlaybackBookmarksDocument(document.value)
  }

  function makeId(): string {
    return runtime.newId()
  }

  async function addBookmark(
    track: BookmarkTrack,
    positionSeconds: number,
    options: { label?: string; kind?: PlaybackBookmark['kind'] } = {}
  ): Promise<PlaybackBookmark | null> {
    if (!track?.id) return null
    await ensureLoaded()
    const next = nextDocument()
    const trackKey = trackKeyFor(track)
    const now = new Date(runtime.now()).toISOString()
    const kind = options.kind ?? 'manual'
    const label = (options.label ?? '').trim().slice(0, MAX_BOOKMARK_LABEL_LENGTH)

    if (kind === 'resume') {
      next.bookmarks = next.bookmarks.filter(
        (bookmark) => !(bookmark.trackKey === trackKey && bookmark.kind === 'resume')
      )
    }

    const forTrack = next.bookmarks.filter((bookmark) => bookmark.trackKey === trackKey)
    if (forTrack.length >= MAX_BOOKMARKS_PER_TRACK) {
      const oldest = forTrack
        .filter((bookmark) => bookmark.kind !== 'resume')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
      if (oldest) {
        next.bookmarks = next.bookmarks.filter((bookmark) => bookmark.id !== oldest.id)
      }
    }

    const bookmark: PlaybackBookmark = {
      id: makeId(),
      trackKey,
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      positionSeconds: clampBookmarkPosition(positionSeconds),
      label: label || (kind === 'resume' ? 'Resume' : formatBookmarkLabel(positionSeconds)),
      createdAt: now,
      updatedAt: now,
      kind
    }
    next.bookmarks = [bookmark, ...next.bookmarks].slice(0, MAX_BOOKMARKS)
    await persist(next)
    return bookmark
  }

  function formatBookmarkLabel(positionSeconds: number): string {
    const total = Math.max(0, Math.floor(positionSeconds))
    const mins = Math.floor(total / 60)
    const secs = total % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  async function removeBookmark(id: string): Promise<void> {
    if (!id) return
    await ensureLoaded()
    const next = nextDocument()
    next.bookmarks = next.bookmarks.filter((bookmark) => bookmark.id !== id)
    await persist(next)
  }

  async function renameBookmark(id: string, label: string): Promise<void> {
    if (!id) return
    await ensureLoaded()
    const next = nextDocument()
    const target = next.bookmarks.find((bookmark) => bookmark.id === id)
    if (!target) return
    const trimmed = label.trim().slice(0, MAX_BOOKMARK_LABEL_LENGTH)
    if (!trimmed || trimmed === target.label) return
    target.label = trimmed
    target.updatedAt = new Date(runtime.now()).toISOString()
    await persist(next)
  }

  async function setLongTrackResumeSeconds(seconds: number): Promise<void> {
    await ensureLoaded()
    const next = nextDocument()
    next.longTrackResumeSeconds = Math.max(60, Math.min(24 * 60 * 60, Math.round(seconds)))
    await persist(next)
  }

  function bookmarksFor(track: BookmarkTrack | null | undefined): PlaybackBookmark[] {
    if (!track) return []
    return bookmarksForTrack(document.value, trackKeyFor(track))
  }

  function resumeBookmarkFor(track: BookmarkTrack | null | undefined): PlaybackBookmark | null {
    if (!track) return null
    return bookmarksFor(track).find((bookmark) => bookmark.kind === 'resume') ?? null
  }

  function shouldOfferLongTrackResume(track: BookmarkTrack | null | undefined): boolean {
    if (!track) return false
    const threshold = document.value.longTrackResumeSeconds
    return typeof track.duration === 'number' && track.duration >= threshold
  }

  return {
    document,
    getRevision: () => revision,
    ensureLoaded,
    trackKeyFor,
    bookmarksFor,
    resumeBookmarkFor,
    shouldOfferLongTrackResume,
    addBookmark,
    removeBookmark,
    renameBookmark,
    setLongTrackResumeSeconds
  }
}
