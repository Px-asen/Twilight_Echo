import type { CoreSessionRepository } from '../../core/playback/session.ts'
import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { PlaybackSessionStoreBundle } from './playbackSessionRepository.ts'
import { libraryTrack } from '../../core/playback/libraryTrack.ts'
import type { TrackData } from '../../shared/track.ts'
import { legacyQueueImportOwner } from '../../shared/coreQueueImport.ts'

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
  async function references(): Promise<void> {
    const [current, backup] = await Promise.all([
      bundle.sessionStore.load(),
      bundle.sessionStore.loadBackup()
    ])
    const ids = [
      current?.data?.libraryQueue?.id,
      backup?.data?.libraryQueue?.id,
      current?.data?.heart?.baseQueue?.id,
      backup?.data?.heart?.baseQueue?.id
    ].filter((id): id is string => !!id)
    await queues.syncLibraryQueueReferences(owner, [...new Set(ids)])
    if ((owner === 'core:persisted-playback' || legacyImportScope) && current?.data?.libraryQueue)
      await queues.syncLibraryQueueReferences(
        legacyQueueImportOwner(`core-session-${legacyImportScope ? `${legacyImportScope}-` : ''}0`),
        []
      )
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
      const result = await bundle.storage.save(data, revision)
      await references()
      return result
    },
    async clear(revision) {
      const result = await bundle.storage.clear(revision)
      await references()
      return result
    }
  }
}
