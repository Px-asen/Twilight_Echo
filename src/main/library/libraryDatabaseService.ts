import { existsSync, renameSync } from 'node:fs'
import { createServicePort } from '../services/servicePort.ts'
import { CoreStateDatabase, CoreStateDurabilityError } from './coreStateDatabase.ts'
import {
  LibraryDatabase,
  LibraryDatabaseDurabilityError,
  openLibraryDatabase,
  type LibraryQueuePreparation,
  type LibrarySelectionPreparation
} from './libraryDatabase.ts'
import {
  DATABASE_METHODS,
  type LibraryDatabaseWorkerRequest,
  type LibraryDatabaseWorkerMessage
} from './libraryDatabaseProtocol.ts'
import { initializeUtilityDiagnostics } from '../diagnostics/utility.ts'
import type { LibraryQuery } from '../../shared/libraryDatabase.ts'
import type { LibrarySelectionRequest } from '../../shared/librarySelection.ts'
import { validateLibrarySelection } from './libraryDatabaseSelections.ts'

const servicePort = createServicePort<LibraryDatabaseWorkerRequest, LibraryDatabaseWorkerMessage>()
initializeUtilityDiagnostics('twilight-library-database')
let database: LibraryDatabase | null = null
let coreState: CoreStateDatabase | null = null
let coreStateFilePath: string | undefined
let opened = false
let closing = false
let serial = Promise.resolve()
let maintenanceScheduled = false
let maintenanceTimer: NodeJS.Timeout | undefined
let publishedRevision: number | null = null
let publishedGenresRevision: number | null = null
let publishedClassificationMetadataRevision: number | null = null
let publishedRatingsRevision: number | null = null
let publishedPreferencesRevision: number | null = null
let publishedTagsToken: string | null = null
let publishedExplorationState: string | null = null
let publishedFocusState: string | null = null
type Work = {
  request: LibraryDatabaseWorkerRequest
  playlistToken?: symbol
  queue?: LibraryQueuePreparation
  selection?: LibrarySelectionPreparation
}

function openResilientCoreStateDatabase(filePath: string): CoreStateDatabase {
  let db: CoreStateDatabase | null = null
  try {
    db = new CoreStateDatabase(filePath)
    const check = db.sql.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined
    if (check?.quick_check !== 'ok') throw new Error('Core state quick_check failed')
    return db
  } catch (error) {
    try {
      db?.close()
    } catch {
      // Ignore close failure on unreadable/corrupt Core state connection.
    }
    if (filePath !== ':memory:') {
      const corruptBase = `${filePath}.corrupt-${Date.now()}`
      for (const suffix of ['', '-wal', '-shm']) {
        const candidate = `${filePath}${suffix}`
        if (existsSync(candidate)) {
          try {
            renameSync(candidate, `${corruptBase}${suffix}`)
          } catch {
            // Best-effort quarantine of corrupt core-state artifacts.
          }
        }
      }
    }
    console.warn(
      '[core-state] Quarantined corrupt core-state.sqlite and initialized a fresh state database:',
      error
    )
    return new CoreStateDatabase(filePath)
  }
}

async function dispatch(work: Work): Promise<void> {
  const { request } = work
  if (request.kind === 'open') {
    try {
      if (opened || closing) throw new Error('Database service was already opened')
      if (request.libraryFilePath)
        database = await openLibraryDatabase(request.libraryFilePath, request.coverCacheDir)
      if (request.coreStateFilePath) {
        coreState = openResilientCoreStateDatabase(request.coreStateFilePath)
        coreStateFilePath = request.coreStateFilePath
      }
      // Explicitly cancelled or paused jobs stay that way. A running job belongs
      // to the previous process and can only resume from its committed checkpoint.
      database?.sql.exec(
        "UPDATE scan_jobs SET state='interrupted' WHERE state='running'; UPDATE scan_items SET state='pending' WHERE state='working'; UPDATE scan_directories SET state='pending' WHERE state='working';"
      )
      opened = true
      servicePort.postMessage({ kind: 'opened' })
    } catch (error) {
      servicePort.postMessage({ kind: 'open-error', error: String(error) })
    }
    return
  }
  try {
    if (request.kind === 'close') {
      closing = true
      clearTimeout(maintenanceTimer)
      database?.close()
      database = null
      coreState?.close()
      coreState = null
      servicePort.postMessage({
        kind: 'response',
        requestId: request.requestId,
        ok: true,
        value: undefined
      })
      return
    }
    if (!DATABASE_METHODS.has(request.method) || !Array.isArray(request.args))
      throw new Error('Unknown database method')
    if (!opened || closing) throw new Error('Database service is not open')
    if (request.method === 'coreStateOpen') {
      const filePath = request.args[0]
      if (typeof filePath !== 'string' || !filePath) throw new Error('Invalid Core state path')
      if (coreState && coreStateFilePath !== filePath)
        throw new Error('Core state connection is already open at a different path')
      if (!coreState) {
        coreState = openResilientCoreStateDatabase(filePath)
        coreStateFilePath = filePath
      }
      servicePort.postMessage({
        kind: 'response',
        requestId: request.requestId,
        ok: true,
        value: undefined
      })
      return
    }
    if (
      request.method.startsWith('coreState') ||
      request.method === 'coreVersionsReplace' ||
      request.method === 'coreInboxWrite' ||
      request.method === 'corePersonalRestore' ||
      request.method.startsWith('coreMigration') ||
      request.method.startsWith('coreStatistics')
    ) {
      if (!coreState) throw new Error('Core state connection is not open')
      const methods = {
        coreInboxWrite: (
          rows: import('../../shared/coreState.ts').CoreStateRow[],
          revision: number,
          deletes: string[],
          libraryRevision: number
        ) => {
          if (!database || database.getMetadata().revision !== libraryRevision)
            throw new Error('曲库已变化，请刷新整理收件箱')
          return coreState!.write('inbox', rows, revision, deletes)
        },
        corePersonalRestore: coreState.restorePersonalData.bind(coreState),
        coreStateStatus: coreState.status.bind(coreState),
        coreStateRead: coreState.read.bind(coreState),
        coreStateWrite: coreState.write.bind(coreState),
        coreVersionsReplace: coreState.replaceVersions.bind(coreState),
        coreStatisticsStatus: coreState.statisticsStatus.bind(coreState),
        coreStatisticsBegin: coreState.statisticsBegin.bind(coreState),
        coreStatisticsStage: coreState.statisticsStage.bind(coreState),
        coreStatisticsCommit: coreState.statisticsCommit.bind(coreState),
        coreStatisticsAbort: coreState.statisticsAbort.bind(coreState),
        coreMigrationBegin: coreState.begin.bind(coreState),
        coreMigrationStage: coreState.stage.bind(coreState),
        coreMigrationCommit: coreState.commit.bind(coreState),
        coreMigrationAbort: coreState.abort.bind(coreState)
      }
      const method = methods[request.method as keyof typeof methods]
      if (!method) throw new Error('Unknown Core state operation')
      const value = (method as (...args: unknown[]) => unknown)(...request.args)
      servicePort.postMessage({ kind: 'response', requestId: request.requestId, ok: true, value })
      return
    }
    if (!database) throw new Error('Music library database is not open (JSON library mode)')
    if (request.method === 'createTrackSelection') {
      const selection = request.args[0] as LibrarySelectionRequest
      validateLibrarySelection(selection)
      if (!work.selection) {
        const prepared = database.preparePlaylistQuery(selection.query, work.playlistToken)
        if (!prepared.ready) {
          work.playlistToken = prepared.token
          setImmediate(() => enqueue(work))
          return
        }
        work.selection = database.beginTrackSelectionBuild(selection, work.playlistToken)
      }
      const result = database.advanceTrackSelectionBuild(work.selection)
      if (!result.ready) {
        setImmediate(() => enqueue(work))
        return
      }
      servicePort.postMessage({
        kind: 'response',
        requestId: request.requestId,
        ok: true,
        value: result.snapshot
      })
      work.selection = undefined
      return
    }
    if (
      request.method === 'queryTracks' ||
      request.method === 'createLibraryQueue' ||
      (request.method === 'queryCollections' && request.args[0] === 'playlists')
    ) {
      const queryIndex = request.method === 'queryCollections' ? 1 : 0
      const query = (
        request.args[queryIndex] === undefined && request.method !== 'createLibraryQueue'
          ? {}
          : request.args[queryIndex]
      ) as LibraryQuery
      if (!work.queue) {
        const prepared = database.preparePlaylistQuery(query, work.playlistToken)
        if (!prepared.ready) {
          work.playlistToken = prepared.token
          request.args[queryIndex] = {
            ...query,
            contentRevision: prepared.revision,
            ...(query.sort === 'lastPlayed' ? { historyRevision: prepared.historyRevision } : {})
          }
          // Rejoin the serial owner's tail, rather than awaiting inside it. This
          // lets messages received in the meantime read/play/commit scan batches.
          setImmediate(() => enqueue(work))
          return
        }
      }
      if (request.method === 'createLibraryQueue') {
        work.queue ??= database.beginLibraryQueueBuild(
          query,
          request.args[1] as string | undefined,
          work.playlistToken
        )
        const result = database.advanceLibraryQueueBuild(work.queue)
        if (!result.ready) {
          // Once construction starts, its own revision fence and view token
          // stay fixed. A newer scan or dropped view abandons the hidden rows.
          setImmediate(() => enqueue(work))
          return
        }
        servicePort.postMessage({
          kind: 'response',
          requestId: request.requestId,
          ok: true,
          value: result.queue
        })
        work.queue = undefined
        return
      }
    }
    const method = database[request.method] as (...args: unknown[]) => unknown
    const value = await method.apply(database, request.args)
    servicePort.postMessage({ kind: 'response', requestId: request.requestId, ok: true, value })
  } catch (error) {
    if (
      error instanceof LibraryDatabaseDurabilityError ||
      error instanceof CoreStateDurabilityError
    ) {
      console.error('[library-db] Unsafe database connection closed:', error)
      // The client rejects every pending operation and reopens/recovers only
      // on a later request; no uncertain mutation is silently replayed.
      process.exit(1)
    }
    if (work.queue && database && !closing) {
      try {
        database.abandonLibraryQueueBuild(work.queue)
      } catch (cleanupError) {
        // Retain a cleanup intent and its capacity slot, even if marking the
        // state fails. Retry maintenance on later activity, not a busy loop.
        console.error('[library-db] Queue abandonment failed:', cleanupError)
      }
      work.queue = undefined
    }
    if (work.selection && database && !closing) {
      database.abandonTrackSelectionBuild(work.selection)
      work.selection = undefined
    }
    servicePort.postMessage({
      kind: 'response',
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...((error as { code?: string })?.code
        ? { errorCode: (error as { code: string }).code }
        : {})
    })
  }
}

function scheduleMaintenance(): void {
  clearTimeout(maintenanceTimer)
  maintenanceTimer = undefined
  if (maintenanceScheduled || closing || !database) return
  if (!database.needsQueryMaintenance) {
    const expiry = database.nextQueueBuildExpiry
    if (expiry !== undefined) {
      // Expiry rejoins the serial SQL owner; no timer mutates the connection or
      // polls a healthy build. A new successful page moves this one deadline.
      maintenanceTimer = setTimeout(scheduleMaintenance, Math.max(1, expiry - Date.now()))
      maintenanceTimer.unref()
    }
    return
  }
  maintenanceScheduled = true
  setImmediate(() => {
    serial = serial
      .then(() => {
        maintenanceScheduled = false
        if (closing || !database) return
        database.maintainQueryState()
        scheduleMaintenance()
      })
      .catch((error) => {
        maintenanceScheduled = false
        if (error instanceof LibraryDatabaseDurabilityError) process.exit(1)
        // Keep the retiring slot reserved on failure; don't spin on a disk fault.
        console.error('[library-db] Background cleanup failed:', error)
      })
  })
}
function enqueue(work: Work): void {
  // Import, backup and writes share one owner. No async operation can interleave
  // another transaction while it is awaiting disk I/O. Cooperative preparation
  // returns with its transaction closed before rejoining this queue.
  serial = serial
    .then(() => dispatch(work))
    .then(() => {
      if (!database || closing) return
      const revision = database.getContentRevision()
      if (revision !== publishedRevision) {
        publishedRevision = revision
        servicePort.postMessage({ kind: 'library-changed', revision })
      }
      const genresRevision = database.getGenresRevision()
      const ratingsRevision = database.getRatingsRevision()
      if (ratingsRevision !== publishedRatingsRevision) {
        publishedRatingsRevision = ratingsRevision
        servicePort.postMessage({ kind: 'ratings-changed', revision: ratingsRevision })
      }
      const preferencesRevision = database.getPreferencesRevision()
      if (preferencesRevision !== publishedPreferencesRevision) {
        publishedPreferencesRevision = preferencesRevision
        servicePort.postMessage({ kind: 'preferences-changed', revision: preferencesRevision })
      }
      const explorationState = database.explorationState()
      const serializedExplorationState = JSON.stringify(explorationState)
      if (serializedExplorationState !== publishedExplorationState) {
        publishedExplorationState = serializedExplorationState
        servicePort.postMessage({ kind: 'exploration-changed', state: explorationState })
      }
      const focusState = database.focusState()
      const serializedFocusState = JSON.stringify(focusState)
      if (serializedFocusState !== publishedFocusState) {
        publishedFocusState = serializedFocusState
        servicePort.postMessage({ kind: 'focus-changed', state: focusState })
      }
      const tagsToken = database.tagsState()
      const serializedTagsToken = JSON.stringify(tagsToken)
      if (serializedTagsToken !== publishedTagsToken) {
        publishedTagsToken = serializedTagsToken
        servicePort.postMessage({ kind: 'tags-changed', token: tagsToken })
      }
      if (genresRevision !== publishedGenresRevision) {
        publishedGenresRevision = genresRevision
        servicePort.postMessage({ kind: 'genres-changed', revision: genresRevision })
      }
      const metadataRevision = database.getClassificationMetadataRevision()
      if (metadataRevision !== publishedClassificationMetadataRevision) {
        publishedClassificationMetadataRevision = metadataRevision
        servicePort.postMessage({ kind: 'classification-metadata-changed', revision: metadataRevision })
      }
      if (work.request.kind === 'call' && ['legacyMusicPublish', 'legacyMusicEdit', 'legacyMusicRestore'].includes(work.request.method))
        servicePort.postMessage({ kind: 'genres-invalidated' })
    })
    .then(scheduleMaintenance)
    .catch((error) => {
      console.error('[library-db] Request transport failed:', error)
      process.exitCode = 1
    })
}
servicePort.on('message', (request) => enqueue({ request }))
servicePort.postMessage({ kind: 'ready' })
