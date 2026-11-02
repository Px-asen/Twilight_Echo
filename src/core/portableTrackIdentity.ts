import { qualifySafTrackId, safBookmarkTrackKey } from '../shared/safTrackIdentity.ts'

type Json = Record<string, unknown>
const object = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.filter(object) : []

/** The durable envelope's track-bearing fields, not arbitrary nested IDs. */
export function portableTrackRecords(envelope: Json): Json[] {
  const records = rows(envelope.tracks)
  if (object(envelope.session)) {
    if (object(envelope.session.track)) records.push(envelope.session.track)
    for (const record of rows(envelope.session.queue)) records.push(record)
  }
  for (const queue of rows(envelope.queues)) {
    for (const row of rows(queue.rows)) if (object(row.snapshot)) records.push(row.snapshot)
  }
  for (const playlist of rows(envelope.playlists)) {
    if (object(playlist.trackSnapshots)) for (const record of rows(Object.values(playlist.trackSnapshots))) records.push(record)
    if (object(playlist.imported)) for (const entry of rows(playlist.imported.entries)) {
      if (object(entry.manualBinding)) records.push(entry.manualBinding)
      if (object(entry.resolution) && object(entry.resolution.track)) records.push(entry.resolution.track)
    }
  }
  return records
}

function legacyBookmarkKey(record: Json): string {
  const file = String(record.filePath ?? record.id)
  return `local:${file}${record.subTrack ? `#${record.subTrack}` : object(record.cueRange) ? `#cue:${record.cueRange.startSeconds}` : ''}`
}

/** Migrate before the Core imports any state. A queue/playlist snapshot owns its
 * own source; ID-only references follow the persisted library record, never a
 * newly scanned candidate that happens to share the old document fingerprint. */
export function migrateSafTrackIds(envelope: Json): void {
  const library = new Set(rows(envelope.tracks))
  const libraryAliases = new Map<string, Set<string>>()
  const allAliases = new Map<string, Set<string>>()
  const bookmarkAliases = new Map<string, Map<string, { id: string; key: string }>>()
  const add = (aliases: Map<string, Set<string>>, old: string, next: string) => {
    const ids = aliases.get(old) ?? new Set<string>()
    ids.add(next)
    aliases.set(old, ids)
  }
  for (const record of portableTrackRecords(envelope)) {
    if (typeof record.id !== 'string') continue
    const old = record.id
    const source = typeof record.filePath === 'string' ? record.filePath : ''
    const next = qualifySafTrackId(old, source)
    add(allAliases, old, next)
    if (library.has(record)) add(libraryAliases, old, next)
    const key = safBookmarkTrackKey(next, source)
    if (key) {
      const aliases = bookmarkAliases.get(legacyBookmarkKey(record)) ?? new Map()
      aliases.set(old, { id: next, key })
      bookmarkAliases.set(legacyBookmarkKey(record), aliases)
    }
    record.id = next
  }
  // Bookmarks retain a source even after a folder/track leaves the library.
  // That evidence can also reconnect ID-only lyrics or playlist references.
  if (object(envelope.bookmarks)) for (const bookmark of rows(envelope.bookmarks.bookmarks)) {
    if (typeof bookmark.trackId !== 'string' || typeof bookmark.trackKey !== 'string' ||
        !bookmark.trackKey.startsWith('local:')) continue
    const source = bookmark.trackKey.slice(6)
    if (safBookmarkTrackKey(bookmark.trackId, source))
      add(allAliases, bookmark.trackId, qualifySafTrackId(bookmark.trackId, source))
  }
  const resolve = (id: string): string => {
    const ids = libraryAliases.get(id) ?? allAliases.get(id)
    return ids?.size === 1 ? [...ids][0] : id
  }
  for (const queue of rows(envelope.queues)) for (const row of rows(queue.rows)) {
    if (object(row.snapshot) && typeof row.snapshot.id === 'string') row.trackId = row.snapshot.id
    else if (typeof row.trackId === 'string') row.trackId = resolve(row.trackId)
  }
  for (const playlist of [...rows(envelope.playlists), ...rows(envelope.customPlaylists)]) {
    const ownAliases = new Map<string, string>()
    if (object(playlist.trackSnapshots)) {
      const snapshots: Json = {}
      for (const [id, record] of Object.entries(playlist.trackSnapshots)) {
        const next = object(record) && typeof record.id === 'string' ? record.id : resolve(id)
        ownAliases.set(id, next)
        snapshots[next] = record
      }
      playlist.trackSnapshots = snapshots
    }
    const own = (id: string) => ownAliases.get(id) ?? resolve(id)
    if (Array.isArray(playlist.trackIds)) playlist.trackIds = playlist.trackIds.map((id) => own(String(id)))
    if (object(playlist.variantPreferences)) playlist.variantPreferences = Object.fromEntries(
      Object.entries(playlist.variantPreferences).map(([id, variant]) => [own(id), own(String(variant))])
    )
  }
  if (object(envelope.lyricsManagement) && object(envelope.lyricsManagement.tracks)) {
    const before = envelope.lyricsManagement.tracks
    const after = { ...before }
    for (const [id, override] of Object.entries(before)) {
      const next = resolve(id)
      if (next === id) continue
      // A newer, already-qualified edit wins over a stale legacy copy.
      if (!(next in before)) after[next] = override
      delete after[id]
    }
    envelope.lyricsManagement.tracks = after
  }
  if (object(envelope.bookmarks)) for (const bookmark of rows(envelope.bookmarks.bookmarks)) {
    const oldKey = String(bookmark.trackKey ?? '')
    const oldId = typeof bookmark.trackId === 'string' ? bookmark.trackId : ''
    const aliases = bookmarkAliases.get(oldKey)
    const exact = oldId ? aliases?.get(oldId) : aliases?.size === 1 ? [...aliases.values()][0] : undefined
    if (exact) {
      bookmark.trackId = exact.id
      bookmark.trackKey = exact.key
    } else if (oldId && oldKey.startsWith('local:')) {
      // Deleted tracks can outlive the library. Their bookmark retains the source.
      const source = oldKey.slice(6)
      const key = safBookmarkTrackKey(oldId, source)
      if (key) {
        bookmark.trackId = qualifySafTrackId(oldId, source)
        bookmark.trackKey = key
      }
    }
  }
}
