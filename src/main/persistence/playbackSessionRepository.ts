import { join } from 'path'
import type { PlaybackSession } from '../core/types.ts'
import { VersionedDataStore } from './versionedDataStore.ts'
import { isPlaybackQueueSnapshot, PlaybackSessionStorage } from './playbackSessionStorage.ts'
import { isPlaybackSession } from '../../shared/playbackSession.ts'

export const MAX_PLAYBACK_SESSION_BYTES = 2 * 1024 * 1024
export const MAX_PLAYBACK_QUEUE_BYTES = 32 * 1024 * 1024

export interface PlaybackSessionStoreBundle {
  sessionFile: string
  queueFile: string
  sessionStore: VersionedDataStore<PlaybackSession | null>
  queueStore: VersionedDataStore<unknown[]>
  storage: PlaybackSessionStorage
}

export function createPlaybackSessionStoreBundle(
  userDataPath: string,
  onRecovery?: (label: string, filePath: string, result: any) => void
): PlaybackSessionStoreBundle {
  const sessionFile = join(userDataPath, 'playback-session.json')
  const queueFile = join(userDataPath, 'playback-queue.json')
  const sessionStore = new VersionedDataStore<PlaybackSession | null>({
    filePath: sessionFile,
    label: 'playback session',
    maxBytes: MAX_PLAYBACK_SESSION_BYTES,
    isData: (value): value is PlaybackSession | null =>
      value === null || isPlaybackSessionFile(value),
    isLegacy: isPlaybackSessionFile,
    onRecovery: (result) => onRecovery?.('Playback session', sessionFile, result),
    onCorrupt: (error) =>
      console.warn(
        '[core.persistence] Corrupt playback state reset after backup failure:',
        error.filePath,
        error.primaryError
      )
  })
  const queueStore = new VersionedDataStore<unknown[]>({
    filePath: queueFile,
    label: 'playback queue',
    maxBytes: MAX_PLAYBACK_QUEUE_BYTES,
    isData: isPlaybackQueueSnapshot,
    isLegacy: isPlaybackQueueSnapshot,
    onRecovery: (result) => onRecovery?.('Playback queue', queueFile, result),
    onCorrupt: (error) =>
      console.warn(
        '[core.persistence] Corrupt playback state reset after backup failure:',
        error.filePath,
        error.primaryError
      )
  })
  return {
    sessionFile,
    queueFile,
    sessionStore,
    queueStore,
    storage: new PlaybackSessionStorage(sessionStore, queueStore)
  }
}

function isPlaybackSessionFile(value: unknown): value is PlaybackSession {
  return isPlaybackSession(value)
}
