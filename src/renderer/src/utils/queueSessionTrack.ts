import type { Track } from '@renderer/types/music'
import { getTrackSource } from '@renderer/utils/playerTrackUtils.ts'
import {
  MAX_SESSION_QUEUE_ENTRIES,
  type NamedQueueSession,
  type SavedQueueTrack
} from '../../../shared/queueWorkspace.ts'
import type { PlayMode } from '@renderer/types/settings'

export function captureQueueSession(
  name: string,
  queue: readonly Track[],
  original: readonly Track[],
  current: Track | null,
  position: number,
  playMode: PlayMode,
  id: string = crypto.randomUUID()
): NamedQueueSession {
  if (!queue.length) throw new Error('队列为空，无法保存会话')
  if (queue.length > MAX_SESSION_QUEUE_ENTRIES) throw new Error('单个会话最多保存 20,000 首')
  const entries = queue.map(saveQueueTrack)
  const ids = new Set(entries.map((track) => track.queueEntryId))
  const originalEntryIds: string[] = []
  for (const track of original) {
    if (track.queueEntryId && ids.delete(track.queueEntryId))
      originalEntryIds.push(track.queueEntryId)
  }
  originalEntryIds.push(...ids)
  const currentEntryId =
    entries.find((track) => track.queueEntryId === current?.queueEntryId)?.queueEntryId ?? null
  const now = new Date().toISOString()
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    playMode: playMode === 'heart' ? 'sequential' : playMode,
    entries,
    originalEntryIds,
    currentEntryId,
    position: currentEntryId && Number.isFinite(position) ? Math.max(0, position) : 0
  }
}

export function saveQueueTrack(track: Track): SavedQueueTrack {
  const source = getTrackSource(track)
  return {
    id: track.id,
    queueEntryId: track.queueEntryId ?? `queue:${crypto.randomUUID()}`,
    source,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: Number.isFinite(track.duration) ? Math.max(0, track.duration) : 0,
    ...(source === 'local'
      ? {
          filePath: track.filePath,
          ...(track.subTrack ? { subTrack: track.subTrack } : {}),
          ...(track.cueRange ? { cueRange: { ...track.cueRange } } : {})
        }
      : {}),
    ...(track.ncmSongId ? { ncmSongId: track.ncmSongId } : {}),
    ...(source === 'network' && track.networkSource
      ? {
          network: {
            profileId: track.networkSource.profileId,
            entryId: track.networkSource.entry.id,
            path: track.networkSource.entry.path,
            name: track.networkSource.entry.name
          }
        }
      : {})
  }
}

export function restoreQueueTrackIdentity(track: SavedQueueTrack): Track {
  return {
    id: track.id,
    queueEntryId: track.queueEntryId,
    source: track.source,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    filePath: track.source === 'local' ? (track.filePath ?? '') : '',
    fileName: track.title,
    size: 0,
    cover: null,
    lyrics: null,
    streamUrl: null,
    subTrack: track.subTrack,
    cueRange: track.cueRange,
    ncmSongId: track.ncmSongId,
    ...(track.network
      ? {
          networkSource: {
            profileId: track.network.profileId,
            entry: {
              id: track.network.entryId,
              profileId: track.network.profileId,
              path: track.network.path,
              name: track.network.name,
              kind: 'audio' as const
            }
          }
        }
      : {})
  }
}
