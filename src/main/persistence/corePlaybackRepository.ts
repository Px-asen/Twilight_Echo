import type { CoreSessionRepository } from '../../core/playback/session.ts'
import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { PlaybackSessionStoreBundle } from './playbackSessionRepository.ts'
import { libraryTrack } from '../../core/playback/libraryTrack.ts'
import type { TrackData } from '../../shared/track.ts'
import { legacyQueueImportOwner } from '../../shared/coreQueueImport.ts'
import type { PlaybackSession } from '../core/types.ts'
import { PersistentDataRevisionConflictError } from '../../shared/versionedPersistence.ts'
import { isPlaybackSession } from '../../shared/playbackSession.ts'

function savedTrack(value: unknown): TrackData {
  if (
    !value ||
    typeof value !== 'object' ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    ('filePath' in value && value.filePath !== undefined && typeof value.filePath !== 'string')
  )
    throw new Error('Saved playback track has no source identity')
  const record = value as import('../../shared/libraryDatabase.ts').LibraryTrackRecord
  return {
    ...libraryTrack(record),
    queueEntryId: typeof record.queueEntryId === 'string' ? record.queueEntryId : undefined
  }
}

/** Keep both versioned recovery files' SQL queues alive. A current session
 * must not outlive its queue, nor may GC invalidate its last good backup. */
export function createCorePlaybackRepository(
  bundle: PlaybackSessionStoreBundle,
  queues: Pick<LibraryDatabaseApi, 'syncLibraryQueueReferences'>,
  owner = 'core:persisted-playback',
  legacyImportScope?: string
): CoreSessionRepository {
  async function references(
    options: {
      next?: PlaybackSession | null
      expectedRevision?: number
      protectedIds?: readonly string[]
    } = {}
  ): Promise<string[]> {
    const { next, expectedRevision, protectedIds } = options
    const [current, backup] = await Promise.all([
      bundle.sessionStore.load(),
      bundle.sessionStore.loadBackup()
    ])
    if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision)
      throw new PersistentDataRevisionConflictError(current, expectedRevision)
    const ids = [
      ...new Set(
        [
          current?.data?.libraryQueue?.id,
          backup?.data?.libraryQueue?.id,
          current?.data?.heart?.baseQueue?.id,
          backup?.data?.heart?.baseQueue?.id,
          next?.libraryQueue?.id,
          next?.heart?.baseQueue?.id
        ].filter((id): id is string => !!id)
      )
    ].sort()
    if (
      !protectedIds ||
      ids.length !== protectedIds.length ||
      ids.some((id, i) => id !== protectedIds[i])
    )
      await queues.syncLibraryQueueReferences(owner, ids)
    if (
      next === undefined &&
      (owner === 'core:persisted-playback' || legacyImportScope) &&
      current?.data?.libraryQueue
    )
      await queues.syncLibraryQueueReferences(
        legacyQueueImportOwner(`core-session-${legacyImportScope ? `${legacyImportScope}-` : ''}0`),
        []
      )
    return ids
  }
  async function retireReferences(protectedIds: readonly string[]): Promise<void> {
    try {
      await references({ protectedIds })
    } catch (error) {
      // All current/backup/new queues were pinned before publication. A failed
      // cleanup may retain an older queue, but cannot revoke a committed receipt.
      // The next save/load reconciles these references again.
      console.warn('[core.persistence] Deferred playback queue reference cleanup:', error)
    }
  }
  return {
    async load() {
      const result = await bundle.storage.load()
      await references()
      return result
        ? {
            revision: result.revision,
            data: result.data
              ? {
                  ...result.data,
                  track: savedTrack(result.data.track),
                  queue: result.data.queue?.map(savedTrack)
                }
              : null
          }
        : null
    },
    async save(data, revision) {
      if (!isPlaybackSession(data)) throw new Error('Invalid playback session')
      const protectedIds = await references({ next: data, expectedRevision: revision })
      const result = await bundle.storage.save(data, revision)
      await retireReferences(protectedIds)
      return result
    },
    async clear(revision) {
      const protectedIds = await references({ next: null, expectedRevision: revision })
      const result = await bundle.storage.clear(revision)
      await retireReferences(protectedIds)
      return result
    }
  }
}
