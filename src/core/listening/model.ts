import type { TrackData as Track } from '../../shared/track.ts'
import type {
  ListeningStats,
  ListeningTrackStat,
  ListeningTrackSourceId,
  ListeningArtistStat,
  ListeningTrackStatWithId
} from '../../shared/listeningStats.ts'
import { getLogicalTrackKey, normalizeLogicalTrackText } from '../../shared/logicalTrackIdentity.ts'
import {
  normalizeListeningTrackDays,
  compactListeningTrackDays,
  recordListeningTrackDay
} from '../../shared/listeningStatsHistory.ts'
import { cloneTrackForPlaybackSession } from '../playback/sessionTrack.ts'
import { listeningSourceIdentity } from '../../shared/listeningSourceIdentity.ts'
import { getTrackSource as getCatalogTrackSource } from '../../shared/trackSourceIdentity.ts'

export const LISTENING_TICK_SECONDS = 5
export const COMPLETION_RATIO = 0.9
export const SKIP_RATIO = 0.5
export const LISTENING_STATS_RETENTION_DAYS = 730
export const LISTENING_STATS_MAX_TRACKS = 10_000
export const LISTENING_STATS_FLUSH_DELAY_MS = 30_000
export const LISTENING_STATS_RETRY_DELAY_MS = 60_000

function setTrack(stats: ListeningStats, key: string, value: ListeningTrackStat): void {
  Object.defineProperty(stats.tracks, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  })
}

export function recordListeningSeconds(
  stats: ListeningStats,
  track: Track,
  seconds: number,
  timestamp: number,
  plays: number
): string {
  const today = dayKey(timestamp)
  const key = getListeningStatKey(track)
  stats.days[today] = (stats.days[today] ?? 0) + seconds
  const previous = Object.hasOwn(stats.tracks, key)
    ? stats.tracks[key]
    : createEmptyTrackStat(track)
  recordListeningTrackDay(previous, timestamp, { seconds, plays })
  setTrack(stats, key, {
    ...previous,
    seconds: previous.seconds + seconds,
    plays: previous.plays + plays,
    lastPlayed: timestamp,
    title: track.title || previous.title,
    artist: track.artist || previous.artist,
    ...pickCoverFields(track, previous),
    sourceIds: upsertSourceId(previous.sourceIds, track),
    track: cloneTrack(track)
  })
  return key
}

export function recordListeningOutcome(
  stats: ListeningStats,
  track: Track,
  position: number,
  duration: number,
  timestamp: number
): string | null {
  const normalizedDuration = Number.isFinite(duration) && duration > 0 ? duration : track.duration
  if (!Number.isFinite(position) || !Number.isFinite(normalizedDuration) || normalizedDuration <= 0)
    return null
  const ratio = Math.max(0, position) / normalizedDuration
  const outcome = ratio >= COMPLETION_RATIO ? 'completion' : ratio < SKIP_RATIO ? 'skip' : null
  if (!outcome) return null
  const key = getListeningStatKey(track)
  const previous = Object.hasOwn(stats.tracks, key)
    ? stats.tracks[key]
    : createEmptyTrackStat(track)
  recordListeningTrackDay(previous, timestamp, {
    skips: outcome === 'skip' ? 1 : 0,
    completions: outcome === 'completion' ? 1 : 0
  })
  setTrack(stats, key, {
    ...previous,
    lastPlayed: Math.max(previous.lastPlayed, timestamp),
    skips: previous.skips + (outcome === 'skip' ? 1 : 0),
    completions: previous.completions + (outcome === 'completion' ? 1 : 0),
    title: track.title || previous.title,
    artist: track.artist || previous.artist,
    ...pickCoverFields(track, previous),
    sourceIds: upsertSourceId(previous.sourceIds, track),
    track: cloneTrack(track)
  })
  return key
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeNumberRecord(value: Record<string, unknown>): Record<string, number> {
  const entries: [string, number][] = []
  for (const [key, raw] of Object.entries(value)) {
    const numberValue = Number(raw)
    if (Number.isFinite(numberValue) && numberValue > 0) entries.push([key, numberValue])
  }
  return Object.fromEntries(entries)
}

export function normalizeTrackStats(
  value: Record<string, unknown>
): Record<string, ListeningTrackStat> {
  const entries: [string, ListeningTrackStat][] = []
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue
    const seconds = Number(raw.seconds)
    const plays = Number(raw.plays)
    const lastPlayed = Number(raw.lastPlayed)
    const skips = Number(raw.skips)
    const completions = Number(raw.completions)
    entries.push([
      id,
      {
        ...raw,
        seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
        plays: Number.isFinite(plays) && plays > 0 ? plays : 0,
        lastPlayed: Number.isFinite(lastPlayed) && lastPlayed > 0 ? lastPlayed : 0,
        skips: Number.isFinite(skips) && skips > 0 ? skips : 0,
        completions: Number.isFinite(completions) && completions > 0 ? completions : 0,
        daily: normalizeListeningTrackDays(raw.daily),
        undatedLastPlayed:
          Number.isFinite(Number(raw.undatedLastPlayed)) && Number(raw.undatedLastPlayed) > 0
            ? Number(raw.undatedLastPlayed)
            : 0,
        title: typeof raw.title === 'string' ? raw.title : 'Unknown Track',
        artist: typeof raw.artist === 'string' ? raw.artist : 'Unknown Artist',
        cover: typeof raw.cover === 'string' && raw.cover ? raw.cover : null,
        coverSource:
          typeof raw.coverSource === 'string' && raw.coverSource
            ? raw.coverSource
            : typeof raw.cover === 'string' && /^https?:\/\//i.test(raw.cover)
              ? raw.cover
              : null,
        sourceIds: Array.isArray(raw.sourceIds) ? normalizeSourceIds(raw.sourceIds) : undefined,
        track: isTrackSnapshot(raw.track) ? raw.track : undefined
      }
    ])
  }
  return Object.fromEntries(entries)
}

function normalizeSourceIds(value: unknown[]): ListeningTrackSourceId[] {
  return value
    .filter(isRecord)
    .map((raw) => ({
      source: typeof raw.source === 'string' && raw.source ? raw.source : 'local',
      trackId: typeof raw.trackId === 'string' ? raw.trackId : ''
    }))
    .filter((item) => item.trackId.length > 0)
}

function isTrackSnapshot(value: unknown): value is Track {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.artist === 'string' &&
    typeof value.album === 'string' &&
    typeof value.filePath === 'string' &&
    typeof value.fileName === 'string' &&
    typeof value.duration === 'number' &&
    typeof value.size === 'number'
  )
}

export function compactListeningStatsForPersistence(stats: ListeningStats, now: number): boolean {
  let changed = false
  const oldestDay = dayKey(now - LISTENING_STATS_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  for (const key of Object.keys(stats.days)) {
    if (key < oldestDay) {
      delete stats.days[key]
      changed = true
    }
  }

  const trackIds = Object.keys(stats.tracks)
  for (const id of trackIds) {
    if (compactListeningTrackDays(stats.tracks[id], oldestDay)) changed = true
  }
  if (trackIds.length <= LISTENING_STATS_MAX_TRACKS) return changed
  trackIds
    .sort((left, right) => {
      const byLastPlayed = stats.tracks[left].lastPlayed - stats.tracks[right].lastPlayed
      return byLastPlayed || left.localeCompare(right)
    })
    .slice(0, trackIds.length - LISTENING_STATS_MAX_TRACKS)
    .forEach((id) => {
      delete stats.tracks[id]
      changed = true
    })
  return changed
}

export function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

export function createEmptyTrackStat(track: Track): ListeningTrackStat {
  const coverFields = pickCoverFields(track)
  return {
    seconds: 0,
    plays: 0,
    lastPlayed: 0,
    skips: 0,
    completions: 0,
    daily: {},
    undatedLastPlayed: 0,
    title: track.title,
    artist: track.artist,
    cover: coverFields.cover,
    coverSource: coverFields.coverSource,
    sourceIds: []
  }
}

function durableCoverHandle(raw: string | null | undefined): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value || /^(?:blob:|twilight-media:)/i.test(value)) return ''
  return value
}

export function pickCoverFields(
  track: Track,
  previous?: ListeningTrackStat
): { cover: string | null; coverSource: string | null } {
  const nextSource =
    (typeof track.coverSource === 'string' && track.coverSource.trim()) ||
    (typeof track.cover === 'string' && /^https?:\/\//i.test(track.cover.trim())
      ? track.cover.trim()
      : '') ||
    (typeof previous?.coverSource === 'string' && previous.coverSource.trim()) ||
    (typeof previous?.cover === 'string' && /^https?:\/\//i.test(previous.cover.trim())
      ? previous.cover.trim()
      : '') ||
    ''
  const nextCover = durableCoverHandle(track.cover) || durableCoverHandle(previous?.cover)
  return {
    cover: nextCover || null,
    coverSource: nextSource || null
  }
}

export function applyRecoveredListeningArtwork(
  stats: ListeningStats,
  track: Track,
  artwork: { cover: string | null; coverSource: string | null },
  statKey?: string
): string | null {
  const key = statKey ?? getListeningStatKey(track)
  if (!Object.hasOwn(stats.tracks, key)) return null
  const previous = stats.tracks[key]
  const enriched: Track = {
    ...track,
    cover: artwork.cover ?? track.cover ?? null,
    coverSource: artwork.coverSource ?? track.coverSource ?? null
  }
  const coverFields = pickCoverFields(enriched, previous)
  const nextSnapshot = previous.track
    ? cloneTrack({
        ...previous.track,
        cover: coverFields.cover ?? previous.track.cover ?? null,
        coverSource: coverFields.coverSource ?? previous.track.coverSource ?? null
      })
    : undefined
  const statUnchanged =
    coverFields.cover === previous.cover &&
    (coverFields.coverSource ?? null) === (previous.coverSource ?? null)
  const snapshotUnchanged =
    !nextSnapshot ||
    (nextSnapshot.cover === previous.track?.cover &&
      (nextSnapshot.coverSource ?? null) === (previous.track?.coverSource ?? null))
  if (statUnchanged && snapshotUnchanged) return null
  setTrack(stats, key, {
    ...previous,
    ...coverFields,
    ...(nextSnapshot ? { track: nextSnapshot } : {})
  })
  return key
}

export function upsertSourceId(
  sourceIds: ListeningTrackSourceId[] | undefined,
  track: Track
): ListeningTrackSourceId[] {
  const source = getTrackSource(track)
  const next = (sourceIds ?? []).filter((item) => item.trackId !== track.id)
  next.push({ source, trackId: track.id })
  return next
}

export function getListeningStatKey(track: Track): string {
  return getLogicalTrackKey(track)
}

export function buildLastPlayedByTrackId(
  stats: Pick<ListeningStats, 'tracks'>
): ReadonlyMap<string, number> {
  const result = new Map<string, number>()
  for (const stat of Object.values(stats.tracks)) {
    if (stat.track?.id) result.set(stat.track.id, stat.lastPlayed)
    for (const sourceId of stat.sourceIds ?? []) result.set(sourceId.trackId, stat.lastPlayed)
  }
  return result
}

/** Exact recorded sources only; no title lookup and no cross-provider raw-ID guess. */
export function buildLastPlayedBySource(stats: Pick<ListeningStats, 'tracks'>): ReadonlyMap<string, number> {
  const result = new Map<string, number>()
  const add = (provider: string, id: string, at: number) => {
    if (!provider || !id || !Number.isFinite(at) || at <= 0) return
    const key = listeningSourceIdentity(provider, id)
    result.set(key, Math.max(result.get(key) ?? 0, at))
  }
  for (const stat of Object.values(stats.tracks)) {
    if (stat.track?.id) add(getCatalogTrackSource(stat.track), stat.track.id, stat.lastPlayed)
    for (const source of stat.sourceIds ?? []) add(source.source, source.trackId, stat.lastPlayed)
  }
  return result
}

function getTrackSource(track: Pick<Track, 'id' | 'source'>): string {
  if (track.source) return track.source
  const separatorIndex = track.id.indexOf(':')
  return separatorIndex > 0 ? track.id.slice(0, separatorIndex) : 'local'
}

export function normalizeStatText(value: string | undefined): string {
  return normalizeLogicalTrackText(value)
}

export function cloneTrack(track: Track): Track {
  return {
    ...cloneTrackForPlaybackSession(track),
    mediaPart: track.mediaPart ? { ...track.mediaPart } : undefined
  }
}

function normalizeResultLimit(limit: number): number {
  if (!Number.isFinite(limit)) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.floor(limit))
}

export function collectTopItems<T>(
  items: Iterable<T>,
  limit: number,
  include: (item: T) => boolean,
  compare: (left: T, right: T) => number
): T[] {
  const max = normalizeResultLimit(limit)
  if (max <= 0) return []

  const selected: T[] = []
  for (const item of items) {
    if (!include(item)) continue
    let insertAt = -1
    for (let index = 0; index < selected.length; index++) {
      if (compare(item, selected[index]) < 0) {
        insertAt = index
        break
      }
    }
    if (insertAt === -1) {
      if (selected.length < max) selected.push(item)
      continue
    }
    selected.splice(insertAt, 0, item)
    if (selected.length > max) selected.pop()
  }
  return selected
}

export function compareRecentTracks(
  left: ListeningTrackStatWithId,
  right: ListeningTrackStatWithId
): number {
  return right.lastPlayed - left.lastPlayed
}

export function compareTopTracks(
  left: ListeningTrackStatWithId,
  right: ListeningTrackStatWithId
): number {
  if (right.plays !== left.plays) return right.plays - left.plays
  if (right.seconds !== left.seconds) return right.seconds - left.seconds
  return right.lastPlayed - left.lastPlayed
}

export function compareMostListenedTracks(
  left: ListeningTrackStatWithId,
  right: ListeningTrackStatWithId
): number {
  if (right.seconds !== left.seconds) return right.seconds - left.seconds
  if (right.plays !== left.plays) return right.plays - left.plays
  return right.lastPlayed - left.lastPlayed
}

export function compareTopArtists(left: ListeningArtistStat, right: ListeningArtistStat): number {
  if (right.plays !== left.plays) return right.plays - left.plays
  if (right.seconds !== left.seconds) return right.seconds - left.seconds
  return right.lastPlayed - left.lastPlayed
}

export function selectTopArtists(stats: ListeningStats, limit = 50): ListeningArtistStat[] {
  const artists = new Map<string, ListeningArtistStat>()
  for (const stat of Object.values(stats.tracks)) {
    const artistId = normalizeStatText(stat.artist)
    if (!artistId) continue
    const previous = artists.get(artistId)
    const sourceIds = stat.sourceIds?.map((source) => source.trackId) ?? []
    if (!previous) {
      artists.set(artistId, {
        id: artistId,
        name: stat.artist,
        seconds: stat.seconds,
        plays: stat.plays,
        skips: stat.skips,
        completions: stat.completions,
        trackCount: 1,
        lastPlayed: stat.lastPlayed,
        cover: stat.cover,
        coverSource: stat.coverSource ?? null,
        sourceIds: [...sourceIds]
      })
      continue
    }
    previous.seconds += stat.seconds
    previous.plays += stat.plays
    previous.skips += stat.skips
    previous.completions += stat.completions
    previous.trackCount += 1
    if (stat.lastPlayed >= previous.lastPlayed) {
      previous.name = stat.artist
      previous.lastPlayed = stat.lastPlayed
      previous.cover = stat.cover || previous.cover
      previous.coverSource = stat.coverSource || previous.coverSource
    }
    for (const sourceId of sourceIds) {
      if (!previous.sourceIds.includes(sourceId)) previous.sourceIds.push(sourceId)
    }
  }

  return collectTopItems(artists.values(), limit, () => true, compareTopArtists)
}
