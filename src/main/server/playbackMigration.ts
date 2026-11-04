import { readFile, writeFile } from 'node:fs/promises'
import type { LibraryDatabase } from '../library/libraryDatabase.ts'
import { createPlaybackSessionStoreBundle } from '../persistence/playbackSessionRepository.ts'
import {
  isPlaybackSession,
  type PlaybackSessionData,
  type LibraryPlaybackQueueReference
} from '../../shared/playbackSession.ts'
import {
  libraryQueueResumeMode,
  type LibraryQueueSnapshot,
  type LibraryTrackRecord
} from '../../shared/libraryDatabase.ts'
import {
  isCorePersonalizedContext,
  type CorePersonalizedContext
} from '../../shared/corePersonalized.ts'
import {
  personalBackupJsonReplacer,
  isRecord,
  remapPersonalPaths,
  type PathMapping
} from '../../shared/personalBackup.ts'
import { libraryQueueTrack } from '../../core/playback/libraryTrack.ts'
import { importLegacyQueue } from '../../core/playback/legacyQueueImport.ts'
import type { TrackData } from '../../shared/track.ts'

type Session = PlaybackSessionData<TrackData>
export interface PlaybackMigrationContext {
  version: 1
  heart?: { likedPlaylistId: number; base?: { session: Session; originalEntryIds: string[] } }
  personalized?: Pick<CorePersonalizedContext, 'providerId' | 'key'>
  detached?: { track: TrackData; position: number }
}

export function queueReference(queue: LibraryQueueSnapshot): LibraryPlaybackQueueReference {
  return {
    id: queue.id,
    revision: queue.revision,
    index: queue.index,
    entryId: queue.selectedEntryId!
  }
}

export function validateMigrationOrder(
  session: PlaybackSessionData<{ queueEntryId?: string }> | null | undefined,
  value: unknown
): asserts value is string[] {
  const tracks = session?.queue?.length ? session.queue : session ? [session.track] : []
  if (
    !Array.isArray(value) ||
    !value.every((id) => typeof id === 'string') ||
    value.length !== tracks.length ||
    new Set(value).size !== tracks.length
  )
    throw new Error('原始队列顺序文件无效')
  const ids = new Set(value)
  if (tracks.some((track) => !track.queueEntryId || !ids.has(track.queueEntryId)))
    throw new Error('迁移队列的原始顺序与 occurrence 不一致')
}

/** Convert only the private clone. Portable personal JSON keeps its established
 * no-SQL-reference contract; online continuation metadata travels separately. */
export async function exportPlaybackContext(
  directory: string,
  output: string,
  database: LibraryDatabase
): Promise<boolean> {
  const storage = createPlaybackSessionStoreBundle(directory).storage
  const saved = await storage.load(),
    session = saved?.data
  if (!session?.heart && !session?.personalizedStream) return false
  const context: PlaybackMigrationContext = { version: 1 }
  if (session.heart) {
    context.heart = { likedPlaylistId: session.heart.likedPlaylistId }
    if (session.heart.baseQueue) {
      const base = database.getLibraryQueue(session.heart.baseQueue.id)
      const exported = database.exportPlaybackQueue(queueReference(base), 32 * 1024 * 1024, true)
      const queue = exported.queue.map((track) =>
        libraryQueueTrack(track as LibraryTrackRecord, String(track.queueEntryId))
      )
      context.heart.base = {
        session: {
          version: 1,
          savedAt: session.savedAt,
          mode: 'trackAndPosition',
          playMode: libraryQueueResumeMode(base, 'sequential'),
          track: queue[exported.queueIndex],
          queue,
          queueIndex: exported.queueIndex,
          position: 0
        },
        originalEntryIds: exported.originalQueueEntryIds!
      }
    }
  }
  if (session.personalizedStream) {
    const { providerId, key } = session.personalizedStream
    context.personalized = { providerId, key }
  }
  const {
    heart: _heart,
    personalizedStream: _stream,
    detachedHeartTrack: _detached,
    ...portable
  } = session
  if (session.detachedHeartTrack) {
    context.detached = { track: session.track as TrackData, position: session.position }
    const reference = session.libraryQueue!,
      row = database.readLibraryQueue(reference.id, reference.index, 1, {
        expectedRevision: reference.revision
      }).items[0]
    if (!row?.track) throw new Error('心动会话原队列选中项缺少快照')
    portable.track = libraryQueueTrack(row.track, row.queueEntryId)
    portable.position = 0
  }
  await storage.save(portable, saved!.revision)
  await writeFile(output, JSON.stringify(context, personalBackupJsonReplacer), { mode: 0o600 })
  return true
}

/** Validate metadata against the selected portable session before preview/apply. */
export async function readPlaybackContext(
  file: string,
  session: Session | null | undefined,
  mappings: PathMapping[]
): Promise<PlaybackMigrationContext> {
  const value: unknown = remapPersonalPaths(JSON.parse(await readFile(file, 'utf8')), mappings)
  if (!isRecord(value) || value.version !== 1 || !session) throw new Error('在线播放迁移上下文无效')
  const context = value as unknown as PlaybackMigrationContext
  if (
    context.personalized &&
    !isCorePersonalizedContext({ ...context.personalized, queueId: 'migration-current' })
  )
    throw new Error('个性化电台迁移上下文无效')
  const base = context.heart?.base
  if (base) {
    if (
      !isPlaybackSession(base.session) ||
      base.session.libraryQueue ||
      base.session.heart ||
      base.session.personalizedStream ||
      base.session.detachedHeartTrack ||
      !['sequential', 'listLoop', 'repeat', 'shuffle'].includes(String(base.session.playMode))
    )
      throw new Error('心动原队列迁移上下文无效')
    validateMigrationOrder(base.session, base.originalEntryIds)
  }
  const { queue: _queue, queueIndex: _index, ...state } = session
  const track = context.detached ? context.detached.track : session.track
  const trial: Session = {
    ...state,
    track,
    position: context.detached ? context.detached.position : session.position,
    libraryQueue: {
      id: 'migration-current',
      revision: 0,
      index: 0,
      entryId: session.track.queueEntryId!
    },
    ...(context.personalized
      ? { personalizedStream: { ...context.personalized, queueId: 'migration-current' } }
      : {}),
    ...(context.heart
      ? {
          heart: {
            queueId: 'migration-current',
            likedPlaylistId: context.heart.likedPlaylistId,
            ...(base
              ? {
                  baseQueue: {
                    id: 'migration-base',
                    revision: 0,
                    index: 0,
                    entryId: base.session.track.queueEntryId!
                  }
                }
              : {})
          }
        }
      : {}),
    ...(context.detached ? { detachedHeartTrack: true as const } : {})
  }
  if (!isPlaybackSession(trial)) throw new Error('在线播放迁移上下文与会话不一致')
  return context
}

export async function restorePlaybackContext(
  context: PlaybackMigrationContext | undefined,
  session: Session,
  database: LibraryDatabase,
  scope: string | undefined,
  sessionRevision: number
): Promise<Session> {
  if (!context) return session
  const result = { ...session }
  if (context.heart) {
    result.heart = {
      queueId: session.libraryQueue!.id,
      likedPlaylistId: context.heart.likedPlaylistId
    }
    if (context.heart.base) {
      const base = context.heart.base
      const imported = await importLegacyQueue({
        api: {
          importLegacyPlaybackQueue: async (command) => database.importLegacyPlaybackQueue(command),
          readQueue: async (...args) => database.readLibraryQueue(...args)
        },
        session: base.session,
        sessionRevision: sessionRevision + 1,
        libraryRevision: database.getMetadata().revision,
        scope,
        originalEntryIds: base.originalEntryIds
      })
      const updated = database.editLibraryQueue(imported.queue.id, imported.queue.revision, {
        kind: 'mode',
        mode: base.session.playMode as 'sequential' | 'listLoop' | 'repeat' | 'shuffle'
      })
      result.heart.baseQueue = queueReference(updated.queue)
    }
  }
  if (context.personalized)
    result.personalizedStream = { ...context.personalized, queueId: session.libraryQueue!.id }
  if (context.detached) {
    result.detachedHeartTrack = true
    result.track = context.detached.track
    result.position = context.detached.position
  }
  return result
}
