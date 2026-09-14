import type { PlayMode } from './audioEngineTypes.ts'
import { trackCueRangePropertyIsValid, type CueRange } from './cue.ts'

export const MAX_QUEUE_SESSIONS = 20
export const MAX_SESSION_QUEUE_ENTRIES = 20_000
export const MAX_SAVED_QUEUE_ENTRIES = 40_000
export const MAX_PLAYBACK_ORDER_ENTRIES = 200

export interface SavedQueueTrack {
  id: string
  queueEntryId: string
  source: string
  title: string
  artist: string
  album: string
  duration: number
  filePath?: string
  subTrack?: string
  cueRange?: CueRange
  ncmSongId?: number
  network?: { profileId: string; entryId: string; path: string; name: string }
}

export interface NamedQueueSession {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  playMode: Exclude<PlayMode, 'heart'>
  entries: SavedQueueTrack[]
  originalEntryIds: string[]
  currentEntryId: string | null
  position: number
}

export interface PlaybackOrderEntry {
  id: string
  playedAt: string
  track: SavedQueueTrack
  playMode: PlayMode
}

export interface QueueWorkspaceDocument {
  version: 1
  sessions: NamedQueueSession[]
  history: PlaybackOrderEntry[]
}

const modes = new Set<unknown>(['sequential', 'listLoop', 'repeat', 'shuffle', 'heart'])
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 8192): value is string =>
  typeof value === 'string' && value.length <= max && !value.includes('\0')
const identity = (value: unknown): value is string => text(value) && value.trim().length > 0
const timestamp = (value: unknown): boolean => text(value, 40) && Number.isFinite(Date.parse(value))
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

export function isSavedQueueTrack(value: unknown): value is SavedQueueTrack {
  if (!object(value)) return false
  if (!identity(value.id) || !identity(value.queueEntryId) || !identity(value.source)) return false
  if (!text(value.title) || !text(value.artist) || !text(value.album) || !positive(value.duration))
    return false
  if (value.streamUrl !== undefined || value.cover !== undefined) return false
  if (
    value.filePath !== undefined &&
    (value.source !== 'local' ||
      !identity(value.filePath) ||
      (/^[a-z][a-z\d+.-]*:/i.test(value.filePath) && !/^[a-z]:[\\/]/i.test(value.filePath)))
  )
    return false
  if (value.subTrack !== undefined && (value.source !== 'local' || !text(value.subTrack)))
    return false
  if (
    value.ncmSongId !== undefined &&
    (!Number.isSafeInteger(value.ncmSongId) || Number(value.ncmSongId) <= 0)
  )
    return false
  if (!trackCueRangePropertyIsValid(value)) return false
  if (value.network !== undefined) {
    const network = value.network
    if (
      value.source !== 'network' ||
      !object(network) ||
      !identity(network.profileId) ||
      !identity(network.entryId) ||
      !identity(network.path) ||
      !text(network.name)
    )
      return false
  }
  return true
}

export function isNamedQueueSession(value: unknown): value is NamedQueueSession {
  if (!object(value) || !identity(value.id) || !text(value.name, 120) || !value.name.trim())
    return false
  if (!timestamp(value.createdAt) || !timestamp(value.updatedAt) || !positive(value.position))
    return false
  if (!modes.has(value.playMode) || value.playMode === 'heart') return false
  if (
    !Array.isArray(value.entries) ||
    !value.entries.length ||
    value.entries.length > MAX_SESSION_QUEUE_ENTRIES ||
    !value.entries.every(isSavedQueueTrack)
  )
    return false
  const ids = new Set(value.entries.map((entry) => entry.queueEntryId))
  if (
    ids.size !== value.entries.length ||
    (value.currentEntryId !== null && !ids.has(value.currentEntryId as string))
  )
    return false
  return (
    Array.isArray(value.originalEntryIds) &&
    value.originalEntryIds.length === ids.size &&
    new Set(value.originalEntryIds).size === ids.size &&
    value.originalEntryIds.every((id) => ids.has(id))
  )
}

export function isQueueWorkspaceDocument(value: unknown): value is QueueWorkspaceDocument {
  if (
    !object(value) ||
    value.version !== 1 ||
    !Array.isArray(value.sessions) ||
    !Array.isArray(value.history)
  )
    return false
  if (value.sessions.length > MAX_QUEUE_SESSIONS || !value.sessions.every(isNamedQueueSession))
    return false
  if (new Set(value.sessions.map((session) => session.id)).size !== value.sessions.length)
    return false
  if (
    value.sessions.reduce((sum, session) => sum + session.entries.length, 0) >
    MAX_SAVED_QUEUE_ENTRIES
  )
    return false
  if (value.history.length > MAX_PLAYBACK_ORDER_ENTRIES) return false
  return value.history.every(
    (entry) =>
      object(entry) &&
      identity(entry.id) &&
      timestamp(entry.playedAt) &&
      modes.has(entry.playMode) &&
      isSavedQueueTrack(entry.track)
  )
}
