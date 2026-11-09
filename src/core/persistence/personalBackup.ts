import { PortableBuffer } from '../../shared/portableBytes.ts'
import { randomUUID } from '../../shared/portableCrypto.ts'
import { join } from '../../shared/portablePath.ts'
import { coreFs } from '../ports/index.ts'
import { loadJsonFileWithBackup, writeJsonValueAtomic } from './jsonFile.ts'
import { parseJsonWithNestingLimit } from '../../shared/jsonSafety.ts'
import { personalRestoreFiles, personalRestoreNeedsReview } from './personalRestoreFiles.ts'
import type { LocalMusicLibraryDocument } from '../../shared/localLibrary.ts'
import type { Playlist } from '../../shared/playlists.ts'
import { isVersionedDataEnvelope } from '../../shared/versionedPersistence.ts'
import type { PersonalLibraryDatabase } from '../../shared/coreBackup.ts'
export type { PersonalLibraryDatabase } from '../../shared/coreBackup.ts'
import {
  remapMusicPersonalBackupPaths,
  validMusicPersonalBackupRevision,
  type MusicPersonalBackupDatabaseApi,
  type MusicPersonalBackupDocument,
  type MusicPersonalBackupRevision,
  type MusicPersonalBackupRestoreBundle
} from '../../shared/musicPersonalBackup.ts'
import {
  isRecord,
  PERSONAL_BACKUP_LIMIT,
  PERSONAL_DOMAINS,
  PERSONAL_V1_DOMAINS,
  validatePersonalBackup,
  validatePersonalDomain,
  mergePersonalDomain,
  remapPersonalPaths,
  previewPersonalBackup,
  personalBackupPathRoots,
  personalBackupJsonReplacer,
  personalBackupV2JsonReplacer,
  validPersonalExportOptions,
  type PersonalBackup,
  type PersonalData,
  type PersonalDomain,
  type PersonalBackupExportOptions,
  type PersonalBackupPreview,
  type PersonalRestoreOptions
} from '../../shared/personalBackup.ts'

const files: Partial<Record<PersonalDomain, string>> = {
  library: 'music-library.json',
  playlists: 'playlists.json',
  queue: 'queue-workspace.json',
  playback: 'playback-session.json',
  lyrics: 'lyrics-management.json',
  bookmarks: 'playback-bookmarks.json',
  radio: 'radio-stations.json',
  podcasts: 'podcast-subscriptions.json'
}
const limits: Partial<Record<PersonalDomain, number>> = {
  library: 100,
  playlists: 20,
  queue: 32,
  playback: 34,
  lyrics: 8,
  bookmarks: 4,
  radio: 4,
  podcasts: 16,
  statistics: 16,
  versions: 8,
  // Music uses the remaining envelope budget, not the old unknown-domain 16 MiB fallback.
  music: 180
}
const jsonOptions = {
  label: 'personal migration',
  maxBytes: PERSONAL_BACKUP_LIMIT * 3,
  validate: (v: unknown): v is Record<string, unknown> => isRecord(v)
}
const { pending: pendingName, journal: journalName, renderer: rendererName, review: reviewName } = personalRestoreFiles
const allowedRestoreFiles = new Set([
  ...Object.values(files),
  'playback-queue.json',
  rendererName,
  'settings.json'
])
type RestoreRequest = {
  backup: PersonalBackup
  options: PersonalRestoreOptions
  authorizedRoots?: string[]
  libraryBackend?: 'sqlite'
  restoreId?: string
  /** V2 preserves the user's inspected snapshot through restart; it never refreshes this fence. */
  musicExpectedRevision?: MusicPersonalBackupRevision
}
type LibraryReadOptions = { library: LocalMusicLibraryDocument | null; playlists?: Playlist[] }
const libraryBackupCapacity = limits.library! * 1024 * 1024 - 1024
const musicDatabase = (database: PersonalLibraryDatabase): (PersonalLibraryDatabase & MusicPersonalBackupDatabaseApi) | null =>
  typeof database.musicBackupRevision === 'function' && typeof database.musicBackupExport === 'function' &&
  typeof database.musicBackupPreview === 'function' && typeof database.musicBackupRestore === 'function'
    ? database as PersonalLibraryDatabase & MusicPersonalBackupDatabaseApi : null
const stale = () => Object.assign(new Error('音乐整理或来源已变化，请重新预览备份后恢复'), { code: 'STALE_REVISION' })
const sameRevision = (a: MusicPersonalBackupRevision, b: MusicPersonalBackupRevision) =>
  Object.keys(a).every((key) => a[key as keyof MusicPersonalBackupRevision] === b[key as keyof MusicPersonalBackupRevision])
/** V2 carries only the system view identity. Music owns every restorable favorite member. */
function portablePlaylists(playlists: unknown): unknown {
  return Array.isArray(playlists) ? playlists.map((playlist) => {
    if (!isRecord(playlist) || playlist.isDefault !== true) return playlist
    const { trackIds: _ids, trackSnapshots: _snapshots, imported: _imported,
      hiddenSources: _hidden, variantPreferences: _preferences, ...identity } = playlist
    return { ...identity, trackIds: [] }
  }) : playlists
}

export function checkRestoreOptions(value: unknown): asserts value is PersonalRestoreOptions {
  if (
    !isRecord(value) ||
    !['keep-local', 'use-backup'].includes(String(value.conflict)) ||
    !Array.isArray(value.domains) ||
    !value.domains.length ||
    new Set(value.domains).size !== value.domains.length ||
    !value.domains.every((d) => PERSONAL_DOMAINS.includes(d)) ||
    !Array.isArray(value.mappings) ||
    value.mappings.length > 100 ||
    !value.mappings.every(
      (m) =>
        isRecord(m) &&
        typeof m.from === 'string' &&
        !!m.from.trim() &&
        typeof m.to === 'string' &&
        !!m.to.trim() &&
        m.from.length < 4096 &&
        m.to.length < 4096
    )
  )
    throw new Error('请选择有效的恢复项目和路径映射')
}
/** Core supplies SQLite; only the temporary main compatibility adapter supplies a legacy JSON reader. */
export function createPersonalBackupRepository(
  readLegacyLibrary?: (path: string) => LocalMusicLibraryDocument
) {
  function missingDatabase(): never {
    throw new Error('SQLite library is required for Core personal data')
  }
  function parsePersonalBackup(text: string): PersonalBackup {
    if (PortableBuffer.byteLength(text, 'utf8') > PERSONAL_BACKUP_LIMIT) throw new Error('备份超过 180 MiB')
    const value = parseJsonWithNestingLimit(text)
    if (!validatePersonalBackup(value)) throw new Error('备份格式、版本或数据内容无效')
    for (const domain of PERSONAL_DOMAINS)
      if (domain in value.data) assertDomainSize(domain, value.data[domain])
    return value
  }
  function assertDomainSize(domain: PersonalDomain, data: unknown) {
    // Leave room for the persistence envelope; restored files must fit their normal loader.
    if (PortableBuffer.byteLength(JSON.stringify(data)) > (limits[domain] || 16) * 1024 * 1024 - (domain === 'music' ? 0 : 1024))
      throw new Error(`${domain} 数据超过容量限制`)
    if (domain === 'playback' && isRecord(data)) {
      const { queue, ...session } = data
      if (
        PortableBuffer.byteLength(JSON.stringify(session)) > 2 * 1024 * 1024 - 1024 ||
        (queue !== undefined && PortableBuffer.byteLength(JSON.stringify(queue)) > 32 * 1024 * 1024 - 1024)
      )
        throw new Error('播放快照超过保存容量')
    }
  }
  function readRaw(root: string, file: string): unknown {
    const loaded = loadJsonFileWithBackup(join(root, file), {
      ...jsonOptions,
      validate: (v: unknown): v is unknown => v !== undefined
    })
    return loaded.status === 'missing' ? undefined : loaded.value
  }
  function unwrap(value: unknown): unknown {
    return isRecord(value) && value.version === 2 && 'data' in value ? value.data : value
  }
  function readPersonalData(root: string, options?: LibraryReadOptions, domains: readonly PersonalDomain[] = PERSONAL_V1_DOMAINS): PersonalData {
    if (!options && coreFs.existsSync(join(root, 'music-library.sqlite')))
      throw new Error('当前曲库使用 SQLite，请通过数据库导出；未读取旧 JSON')
    const result: PersonalData = {}
    for (const domain of domains) {
      const file = files[domain]
      if (!file) continue
      let value =
        domain === 'library'
          ? options
            ? (options.library ?? undefined)
            : coreFs.existsSync(join(root, file))
              ? readLegacyLibrary
                ? readLegacyLibrary(join(root, file))
                : missingDatabase()
              : undefined
          : domain === 'playlists' && options?.playlists !== undefined
            ? options.playlists
            : unwrap(readRaw(root, file))
      if (
        domain === 'playback' &&
        isRecord(value) &&
        !value.queue &&
        value.queueRevision !== undefined
      ) {
        const queue = readRaw(root, 'playback-queue.json')
        if (!isRecord(queue) || queue.revision !== value.queueRevision)
          throw new Error('播放队列正发生变化，请稍后重新导出')
        value = { ...value, queue: queue.data }
        delete (value as Record<string, unknown>).queueRevision
      }
      if (value !== undefined) {
        if (!validatePersonalDomain(domain, value))
          throw new Error(`${domain} 当前数据无效，未导出或覆盖`)
        result[domain] = value
      }
    }
    return result
  }
  function createPersonalBackup(
    root: string,
    rendererData: PersonalData,
    options?: LibraryReadOptions
  ): PersonalBackup {
    const data = readPersonalData(root, options)
    if (isRecord(data.playback) && data.playback.libraryQueue !== undefined)
      throw new Error('当前播放队列使用 SQLite，请通过数据库导出')
    return createPersonalBackupFromData(data, rendererData)
  }
  function createPersonalBackupFromData(
    data: PersonalData,
    rendererData: PersonalData,
    version: 1 | 2 = 1,
    domains: readonly PersonalDomain[] = PERSONAL_V1_DOMAINS
  ): PersonalBackup {
    data = Object.fromEntries(Object.entries(data).filter(([domain]) => domains.includes(domain as PersonalDomain)))
    for (const domain of ['statistics', 'versions'] as const)
      if (domains.includes(domain) && rendererData[domain] !== undefined) {
        if (!validatePersonalDomain(domain, rendererData[domain]))
          throw new Error(`${domain} 数据无效`)
        data[domain] = rendererData[domain]
      }
    // Account/config/plugin files are not part of the allowlist. Remove incidental credentials
    // from extensible track snapshots as well, without changing user-authored lyrics or feed URLs.
    const text = JSON.stringify(
      { format: 'twilight-personal-data', version, createdAt: new Date().toISOString(), data },
      version === 2 ? personalBackupV2JsonReplacer : personalBackupJsonReplacer
    )
    return parsePersonalBackup(text)
  }
  async function readDatabasePersonalData(root: string, database: PersonalLibraryDatabase, library: LocalMusicLibraryDocument | null, domains: readonly PersonalDomain[] = PERSONAL_V1_DOMAINS) {
    const playlists = domains.includes('playlists') ? await database.preferencesPlaylistsLoad?.() : null
    return readPersonalData(root, { library, ...(playlists ? { playlists: playlists.data } : {}) }, domains)
  }
  function stagePersonalRestore(
    root: string,
    backup: PersonalBackup,
    options: PersonalRestoreOptions,
    authorizedRoots: string[] = [],
    current?: PersonalData,
    libraryBackend?: 'sqlite',
    musicExpectedRevision?: MusicPersonalBackupRevision
  ): void {
    checkRestoreOptions(options)
    parsePersonalBackup(JSON.stringify(backup))
    if (backup.version === 2 && libraryBackend !== 'sqlite')
      throw new Error('v2 备份需要通过 SQLite 音乐整理恢复入口')
    // Validate merging now; startup repeats this against the latest saved data.
    buildRestoreData(backup, options, current ?? readPersonalData(root))
    writeJsonValueAtomic(
      join(root, pendingName),
      { backup, options, authorizedRoots, libraryBackend, musicExpectedRevision,
        ...(backup.version === 2 ? { restoreId: randomUUID() } : {}) },
      jsonOptions
    )
  }
  function buildRestoreData(
    backup: PersonalBackup,
    options: PersonalRestoreOptions,
    current: PersonalData
  ): PersonalData {
    const result: PersonalData = {}
    for (const domain of options.domains) {
      if (!(domain in backup.data)) continue
      // Music resolves stable identities before applying personal values inside its SQLite bundle.
      if (domain === 'music') continue
      const incoming = remapPersonalPaths(backup.data[domain], options.mappings)
      let merged = mergePersonalDomain(domain, current[domain], incoming, options.conflict)
      if (domain === 'playlists' && backup.version === 2) merged = portablePlaylists(merged)
      if (!validatePersonalDomain(domain, merged))
        throw new Error(`${domain} 合并后存在重复关系或超出容量，请减少恢复项目或调整冲突选项`)
      assertDomainSize(domain, merged)
      result[domain] = merged
    }
    return result
  }
  function previewRestore(
    root: string,
    backup: PersonalBackup,
    rendererData: PersonalData,
    options?: LibraryReadOptions
  ) {
    return previewPersonalBackup(backup, {
      ...readPersonalData(root, options),
      statistics: rendererData.statistics,
      versions: rendererData.versions
    })
  }
  function removeArtifact(root: string, name: string) {
    // Clear the fallback first: a crash must not resurrect an older request
    // after its primary completion log has already been removed.
    for (const suffix of ['.bak', '']) {
      const p = join(root, name + suffix)
      if (coreFs.existsSync(p)) coreFs.unlinkSync(p)
    }
  }
  // Called after the single-instance lock and before persistence owners are constructed.
  // A durable redo journal makes a crash between files recoverable and prevents partial startup.
  function preparePendingPersonalRestore(
    root: string,
    currentData?: PersonalData,
    libraryRevision?: number,
    playlistRevision?: number
  ): (Record<string, unknown> & { writes: Record<string, unknown> }) | null {
    let journal = readRaw(root, journalName)
    if (journal === undefined) {
      const request = readRaw(root, pendingName) as RestoreRequest | undefined
      if (!request) return null
      if (request.libraryBackend === 'sqlite' && !currentData)
        throw new Error('此恢复请求需要 SQLite 曲库，未写入旧 JSON')
      if (!validatePersonalBackup(request.backup)) throw new Error('待恢复备份无效')
      checkRestoreOptions(request.options)
      const bundleDomains = request.backup.version === 2 && request.options.domains.some((domain) =>
        ['music', 'library', 'playlists'].includes(domain) && domain in request.backup.data)
      if (bundleDomains && !validMusicPersonalBackupRevision(request.musicExpectedRevision))
        throw new Error('v2 恢复缺少预览修订，请重新预览')
      const current = currentData ?? readPersonalData(root)
      const sqliteLibrary = libraryRevision !== undefined
      const data = buildRestoreData(
        request.backup,
        sqliteLibrary
          ? {
              ...request.options,
              domains: request.options.domains.filter((domain) => domain !== 'library')
            }
          : request.options,
        current
      )
      if (sqliteLibrary && 'library' in request.backup.data) {
        data.library = remapPersonalPaths(request.backup.data.library, request.options.mappings)
        if (!validatePersonalDomain('library', data.library)) throw new Error('曲库恢复数据无效')
        assertDomainSize('library', data.library)
      }
      const restoreId = request.restoreId ?? randomUUID()
      if (typeof restoreId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(restoreId)) throw new Error('无效的恢复标记')
      const writes: Record<string, unknown> = {}
      const originals: Record<string, unknown> = {}
      if (bundleDomains) originals['music-library.sqlite'] = {
        databaseSnapshot: join(root, `music-library.sqlite.pre-restore-${restoreId}.sqlite`),
        revision: request.musicExpectedRevision
      }
      if (request.options.domains.includes('library') && request.authorizedRoots?.length) {
        const settings = readRaw(root, 'settings.json')
        originals['settings.json'] = settings ?? null
        const previous = isRecord(settings) ? settings : {}
        writes['settings.json'] = {
          ...previous,
          libraryFolders: [
            ...new Set([
              ...(Array.isArray(previous.libraryFolders) ? previous.libraryFolders : []),
              ...request.authorizedRoots
            ])
          ]
        }
      }
      for (const domain of PERSONAL_DOMAINS) {
        if (!(domain in data) || !files[domain]) continue
        if (request.backup.version === 2 && (domain === 'library' || domain === 'playlists')) continue
        const file = files[domain]!
        const previous =
          domain === 'playlists' && playlistRevision !== undefined
            ? { version: 2, revision: playlistRevision, data: current.playlists }
          : domain === 'library' && libraryRevision !== undefined
            ? { revision: libraryRevision }
            : readRaw(root, file)
        originals[file] =
          domain === 'library' && sqliteLibrary
            ? {
                databaseSnapshot: join(
                  root,
                  `music-library.sqlite.pre-restore-${restoreId}.sqlite`
                ),
                revision: libraryRevision
              }
            : (previous ?? null)
        const revision =
          isRecord(previous) && Number.isSafeInteger(previous.revision)
            ? Number(previous.revision) + 1
            : 1
        let value = data[domain]
        if (domain === 'playback' && isRecord(value)) {
          const session = { ...value }
          delete session.queueRevision
          // Embedded queue has a 2 MiB session limit; use the separate queue file.
          if (Array.isArray(session.queue)) {
            const previousQueue = readRaw(root, 'playback-queue.json')
            const queueRevision = isRecord(previousQueue)
              ? Number(previousQueue.revision || 0) + 1
              : 1
            originals['playback-queue.json'] = previousQueue ?? null
            writes['playback-queue.json'] = {
              version: 2,
              revision: queueRevision,
              savedAt: new Date().toISOString(),
              data: session.queue
            }
            delete session.queue
            session.queueRevision = queueRevision
          }
          value = session
        }
        writes[file] =
          domain === 'library' && isRecord(value)
            ? { ...value, revision }
            : { version: 2, revision, savedAt: new Date().toISOString(), data: value }
      }
      const rendererData = Object.fromEntries(
        ['statistics', 'versions']
          .filter(
            (d) => d in request.backup.data && request.options.domains.includes(d as PersonalDomain)
          )
          .map((d) => [
            d,
            remapPersonalPaths(request.backup.data[d as PersonalDomain], request.options.mappings)
          ])
      )
      writes[rendererName] = {
        id: restoreId,
        ...(playlistRevision !== undefined ? { playlistExpectedRevision: playlistRevision } : {}),
        conflict: request.options.conflict,
        data: rendererData
      }
      journal = {
        writes,
        originals,
        createdAt: new Date().toISOString(),
        id: restoreId,
        ...(bundleDomains ? {
          musicBundle: {
            restoreId,
            conflict: request.options.conflict,
            expectedRevision: request.musicExpectedRevision,
            ...(request.options.domains.includes('music') && request.backup.data.music !== undefined ? {
              music: remapMusicPersonalBackupPaths(request.backup.data.music as MusicPersonalBackupDocument, request.options.mappings)
            } : {}),
            ...(request.options.domains.includes('library') && request.backup.data.library !== undefined ? {
              library: remapPersonalPaths(request.backup.data.library, request.options.mappings)
            } : {}),
            ...(request.options.domains.includes('playlists') && request.backup.data.playlists !== undefined ? {
              playlists: remapPersonalPaths(request.backup.data.playlists, request.options.mappings)
            } : {})
          }
        } : {}),
        ...(libraryRevision !== undefined || request.libraryBackend === 'sqlite'
          ? {
              libraryBackend: 'sqlite',
              libraryExpectedRevision: libraryRevision,
              libraryOperation: 'merge',
              libraryConflict: request.options.conflict
            }
          : {})
      }
      writeJsonValueAtomic(join(root, journalName), journal, jsonOptions)
    }
    if (!isRecord(journal) || !isRecord(journal.writes)) throw new Error('恢复日志无效')
    return journal as Record<string, unknown> & { writes: Record<string, unknown> }
  }

  function writeRestoreFile(root: string, name: string, value: unknown): void {
    if (!allowedRestoreFiles.has(name)) throw new Error('恢复日志包含未知文件')
    writeJsonValueAtomic(join(root, name), value, {
      ...jsonOptions,
      validate: (v: unknown): v is unknown => v !== undefined
    })
  }

  function validateRestoreWrites(writes: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(writes)) {
      if (!allowedRestoreFiles.has(name) || value === undefined)
        throw new Error('恢复日志包含未知文件或无效数据')
      if (name === 'music-library.json' && !validatePersonalDomain('library', value))
        throw new Error('曲库恢复日志无效')
    }
  }

  function finishPersonalRestore(root: string, journal: Record<string, unknown>): void {
    writeJsonValueAtomic(
      join(root, 'personal-restore-previous.json'),
      { data: journal.originals, createdAt: journal.createdAt },
      jsonOptions
    )
    removeArtifact(root, pendingName)
    removeArtifact(root, journalName)
  }

  /** A rejected v2 CAS has not published the SQLite bundle or any files. Keep a directly
   * importable copy for review, then retire only the active retry request. */
  function deferStalePersonalRestore(root: string): string | null {
    const request = readRaw(root, pendingName) as RestoreRequest | undefined
    const journal = readRaw(root, journalName)
    if (!request || request.backup.version !== 2 || !validatePersonalBackup(request.backup) ||
      (journal !== undefined && (!isRecord(journal) || !isRecord(journal.musicBundle) || journal.id !== request.restoreId)))
      throw new Error('只有尚未发布的 v2 修订冲突可以转入待复核')
    const path = join(root, reviewName)
    writePersonalBackupFile(path, request.backup)
    removeArtifact(root, pendingName)
    removeArtifact(root, journalName)
    return path
  }
  function readPersonalRestoreReview(root: string): PersonalBackup | null {
    const loaded = loadJsonFileWithBackup(join(root, reviewName), {
      label: 'personal restore review', maxBytes: PERSONAL_BACKUP_LIMIT, validate: validatePersonalBackup
    })
    return loaded.status === 'missing' ? null : loaded.value
  }
  function acknowledgePersonalRestoreReview(root: string): void { removeArtifact(root, reviewName) }

  // Existing JSON callers retain their synchronous contract. A database journal
  // can never be replayed into the old JSON library by this compatibility entry.
  function applyPendingPersonalRestore(root: string, beforeWrite?: (name: string) => void): void {
    const journal = preparePendingPersonalRestore(root)
    if (!journal) return
    validateRestoreWrites(journal.writes)
    if (
      journal.libraryBackend === 'sqlite' ||
      ('music-library.json' in journal.writes && coreFs.existsSync(join(root, 'music-library.sqlite')))
    )
      throw new Error('此恢复日志需要 SQLite 曲库，未写入旧 JSON')
    for (const [name, value] of Object.entries(journal.writes)) {
      beforeWrite?.(name)
      writeRestoreFile(root, name, value)
    }
    finishPersonalRestore(root, journal)
  }

  async function createDatabaseBackup(
    root: string,
    rendererData: PersonalData,
    database: PersonalLibraryDatabase,
    options: PersonalBackupExportOptions,
    legacyVersion: boolean
  ): Promise<PersonalBackup> {
    if (!validPersonalExportOptions(options)) throw new Error('请选择有效的导出项目')
    const music = legacyVersion ? null : musicDatabase(database)
    const domains: readonly PersonalDomain[] = options.domains ?? (music ? PERSONAL_DOMAINS : PERSONAL_V1_DOMAINS)
    if (domains.includes('music') && !music) throw new Error('当前数据库不支持音乐整理备份')
    const before = await music?.musicBackupRevision()
    const library = domains.includes('library') ? await database.exportDocument({
      maxBytes: libraryBackupCapacity,
      redactPrivateData: true
    }) : null
    const data = await readDatabasePersonalData(root, database, library, domains)
    if (music && data.playlists !== undefined) data.playlists = portablePlaylists(data.playlists)
    if (isRecord(data.playback) && data.playback.libraryQueue !== undefined) {
      const { libraryQueue, ...session } = data.playback
      const { libraryRevision, ...exported } = await database.exportPlaybackQueue(
        libraryQueue as import('../../shared/playbackSession.ts').LibraryPlaybackQueueReference,
        32 * 1024 * 1024 - 1024
      )
      if (libraryRevision !== (library?.revision ?? before?.library ?? (await database.getMetadata()).revision))
        throw new Error('导出期间曲库发生变化，请稍后重新导出')
      if (isRecord(session.track) && exported.queue[exported.queueIndex]?.id !== session.track.id)
        throw new Error('播放会话与数据库队列不匹配，未导出')
      data.playback = { ...session, ...exported }
    }
    const version = music ? 2 : 1
    const base = createPersonalBackupFromData(data, rendererData, version, domains)
    if (music && domains.includes('music')) {
      // Reserve the enclosing key/comma before asking the bounded producer. No records are dropped.
      const remaining = PERSONAL_BACKUP_LIMIT - PortableBuffer.byteLength(JSON.stringify(base)) - 16
      if (remaining <= 0) throw new Error('备份超过 180 MiB，请减少导出项目')
      base.data.music = await music.musicBackupExport(remaining)
    }
    if (music && before && !sameRevision(before, await music.musicBackupRevision()))
      throw new Error('导出期间音乐整理或来源发生变化，请重新导出')
    return parsePersonalBackup(JSON.stringify(base, version === 2 ? personalBackupV2JsonReplacer : personalBackupJsonReplacer))
  }
  /** Explicit v1 compatibility for the retained main-process IPC, even with a capable database. */
  function createPersonalBackupV1FromDatabase(root: string, rendererData: PersonalData, database: PersonalLibraryDatabase): Promise<PersonalBackup> {
    return createDatabaseBackup(root, rendererData, database, {}, true)
  }
  function createPersonalBackupFromDatabase(root: string, rendererData: PersonalData, database: PersonalLibraryDatabase, options: PersonalBackupExportOptions = {}): Promise<PersonalBackup> {
    return createDatabaseBackup(root, rendererData, database, options, false)
  }

  async function previewRestoreFromDatabase(
    root: string,
    backup: PersonalBackup,
    rendererData: PersonalData,
    database: PersonalLibraryDatabase,
    options: PersonalRestoreOptions = { conflict: 'keep-local', mappings: [], domains: PERSONAL_DOMAINS.filter((domain) => domain in backup.data) }
  ): Promise<PersonalBackupPreview> {
    if (!options.domains.length && !Object.keys(backup.data).length) return previewPersonalBackup(backup, {})
    checkRestoreOptions(options)
    const music = backup.version === 2 ? musicDatabase(database) : null
    if (backup.version === 2 && !music) throw new Error('当前数据库不支持 v2 音乐整理恢复')
    const before = await music?.musicBackupRevision()
    const selected = Object.fromEntries(Object.entries(backup.data).filter(([domain]) => options.domains.includes(domain as PersonalDomain)))
    const mapped: PersonalBackup = { ...backup, data: remapPersonalPaths(selected, options.mappings) as PersonalData }
    if (backup.data.music && options.domains.includes('music'))
      mapped.data.music = remapMusicPersonalBackupPaths(backup.data.music as MusicPersonalBackupDocument, options.mappings)
    const current = await readDatabasePersonalData(root, database, null, options.domains)
    const preview = previewPersonalBackup(mapped, { ...current, statistics: rendererData.statistics, versions: rendererData.versions })
    if ('library' in mapped.data) {
      const row = await database.previewPersonalLibrary(
        mapped.data.library as LocalMusicLibraryDocument
      )
      const libraryRow = preview.rows.find((row) => row.domain === 'library')!
      Object.assign(libraryRow, {
        incoming: row.incoming,
        current: row.current,
        conflicts: row.conflicts
      })
    }
    if (backup.version === 2) {
      preview.music = await music!.musicBackupPreview(mapped.data.music as MusicPersonalBackupDocument | undefined, options.conflict)
      if (!before || !sameRevision(before, preview.music.revision) || !sameRevision(before, await music!.musicBackupRevision())) throw stale()
      const musicRow = preview.rows.find((row) => row.domain === 'music')
      if (musicRow) Object.assign(musicRow, { incoming: preview.music.incoming, current: preview.music.current, conflicts: preview.music.conflicts })
      preview.dependencies = [
        ...('music' in backup.data ? [{ domain: 'music' as const, requires: 'library' as const,
          selected: options.domains.includes('library') && 'library' in backup.data,
          reason: '只恢复音乐整理会保留离线锚点；仅在明确来源匹配后接回曲目' }] : []),
        ...('versions' in backup.data ? [{ domain: 'versions' as const, requires: 'library' as const,
          selected: options.domains.includes('library') && 'library' in backup.data,
          reason: '版本关系使用明确来源引用；未恢复的来源仍可能离线' }] : []),
        ...('music' in backup.data && 'versions' in backup.data ? [{ domain: 'music' as const, requires: 'versions' as const,
          selected: options.domains.includes('versions'), reason: '版本与首选音源仍由版本关系域恢复' }] : [])
      ]
    }
    // Keep original domain rows visible while options decide which rows are evaluated/applied.
    for (const domain of PERSONAL_DOMAINS.filter((domain) => domain in backup.data && !options.domains.includes(domain)))
      preview.rows.push({ domain, incoming: previewPersonalBackup({ ...backup, data: { [domain]: backup.data[domain] } }, {}).rows[0].incoming, current: 0, conflicts: 0 })
    preview.rows.sort((a, b) => PERSONAL_DOMAINS.indexOf(a.domain) - PERSONAL_DOMAINS.indexOf(b.domain))
    Object.assign(preview, personalBackupPathRoots(backup))
    return preview
  }

  async function stagePersonalRestoreFromDatabase(
    root: string,
    backup: PersonalBackup,
    options: PersonalRestoreOptions,
    authorizedRoots: string[],
    database: PersonalLibraryDatabase,
    personalData: PersonalData = {},
    expectedRevision?: MusicPersonalBackupRevision
  ): Promise<void> {
    checkRestoreOptions(options)
    parsePersonalBackup(JSON.stringify(backup))
    let revision: MusicPersonalBackupRevision | undefined
    if (backup.version === 2) {
      const music = musicDatabase(database)
      if (!music) throw new Error('当前数据库不支持 v2 音乐整理恢复')
      revision = await music.musicBackupRevision()
      if (expectedRevision && !sameRevision(revision, expectedRevision)) throw stale()
      revision = expectedRevision ?? revision
    }
    if (options.domains.includes('library') && 'library' in backup.data)
      await database.previewPersonalLibrary(
        remapPersonalPaths(backup.data.library, options.mappings) as LocalMusicLibraryDocument
      )
    const current = { ...await readDatabasePersonalData(root, database, null, options.domains), ...personalData }
    if (revision && !sameRevision(revision, await musicDatabase(database)!.musicBackupRevision())) throw stale()
    stagePersonalRestore(
      root,
      backup,
      options,
      authorizedRoots,
      current,
      'sqlite',
      revision
    )
  }

  /** Run before exposing other persistence owners. File redo and the database's
   * idempotent restore token survive a crash on either side of the worker ACK. */
  async function applyPendingPersonalRestoreFromDatabase(
    root: string,
    database: PersonalLibraryDatabase,
    beforeWrite?: (name: string) => void | Promise<void>
  ): Promise<void> {
    let journal = readRaw(root, journalName)
    if (journal === undefined) {
      const request = readRaw(root, pendingName) as RestoreRequest | undefined
      if (!request) return
      checkRestoreOptions(request.options)
      if (!validatePersonalBackup(request.backup)) throw new Error('待恢复备份无效')
      const libraryRevision =
        request.options.domains.includes('library') && 'library' in request.backup.data
          ? request.backup.version === 2 ? request.musicExpectedRevision?.library : (await database.getMetadata()).revision
          : undefined
      const playlists = await database.preferencesPlaylistsLoad?.()
      const legacyPlaylists = playlists ? null : readRaw(root, 'playlists.json')
      const playlistRevision = database.preferencesPlaylistsRestore
        ? playlists?.revision ?? (isRecord(legacyPlaylists) && Number.isSafeInteger(legacyPlaylists.revision) ? Number(legacyPlaylists.revision) : 0)
        : undefined
      journal = preparePendingPersonalRestore(
        root,
        readPersonalData(root, { library: null, ...(playlists ? { playlists: playlists.data } : {}) }, request.options.domains),
        libraryRevision,
        playlistRevision
      )
    }
    if (!isRecord(journal) || !isRecord(journal.writes)) throw new Error('恢复日志无效')
    validateRestoreWrites(journal.writes)
    if (journal.musicBundle !== undefined) {
      const music = musicDatabase(database), bundle = journal.musicBundle
      if (!music || !isRecord(bundle) || !validMusicPersonalBackupRevision(bundle.expectedRevision) ||
        typeof bundle.restoreId !== 'string' || bundle.restoreId !== journal.id ||
        !['keep-local', 'use-backup'].includes(String(bundle.conflict)) ||
        !validatePersonalBackup({ format: 'twilight-personal-data', version: 2,
          createdAt: journal.createdAt, data: Object.fromEntries(['music', 'library', 'playlists'].filter((key) => key in bundle).map((key) => [key, bundle[key]])) }))
        throw new Error('v2 音乐整理恢复日志无效')
      // The durable restoreId is checked by SQLite before CAS. A lost ACK is a replay,
      // not a second merge, and a rejected CAS precedes every cross-file publication.
      await beforeWrite?.('music-library.sqlite')
      await music.musicBackupRestore(bundle as unknown as MusicPersonalBackupRestoreBundle)
    }
    if ('playlists.json' in journal.writes && database.preferencesPlaylistsRestore && journal.playlistExpectedRevision === undefined) {
      const playlists = await database.preferencesPlaylistsLoad?.()
      const legacy = playlists ? null : readRaw(root, 'playlists.json')
      journal.playlistExpectedRevision = playlists?.revision ?? (isRecord(legacy) && Number.isSafeInteger(legacy.revision) ? Number(legacy.revision) : 0)
      journal.id ??= randomUUID()
      if (playlists) journal.originals = { ...(isRecord(journal.originals) ? journal.originals : {}), 'playlists.json': playlists }
      writeJsonValueAtomic(join(root, journalName), journal, jsonOptions)
    }
    if ('music-library.json' in journal.writes && journal.libraryBackend !== 'sqlite') {
      // Existing-format redo logs remain readable, but their library write is
      // redirected to the authority, never to the retained migration source.
      journal.libraryBackend = 'sqlite'
      journal.id = randomUUID()
      journal.libraryExpectedRevision = (await database.getMetadata()).revision
      journal.originals = {
        ...(isRecord(journal.originals) ? journal.originals : {}),
        'music-library.json': {
          databaseSnapshot: join(root, `music-library.sqlite.pre-restore-${journal.id}.sqlite`),
          revision: journal.libraryExpectedRevision
        }
      }
      writeJsonValueAtomic(join(root, journalName), journal, jsonOptions)
    }
    for (const [name, value] of Object.entries(journal.writes)) {
      await beforeWrite?.(name)
      if (name === 'music-library.json') {
        if (
          !validatePersonalDomain('library', value) ||
          typeof journal.id !== 'string' ||
          !Number.isSafeInteger(journal.libraryExpectedRevision)
        )
          throw new Error('SQLite 曲库恢复日志无效')
        if (journal.libraryOperation === 'merge') {
          if (!['keep-local', 'use-backup'].includes(String(journal.libraryConflict)))
            throw new Error('曲库恢复冲突策略无效')
          await database.restorePersonalLibrary(
            value as LocalMusicLibraryDocument,
            journal.libraryConflict as 'keep-local' | 'use-backup',
            journal.id,
            Number(journal.libraryExpectedRevision)
          )
        } else
          await database.restoreDocument(
            value as LocalMusicLibraryDocument,
            journal.id,
            Number(journal.libraryExpectedRevision)
          )
      } else if (name === 'playlists.json' && database.preferencesPlaylistsRestore) {
        if (!isVersionedDataEnvelope(value, (v): v is Playlist[] => Array.isArray(v) && validatePersonalDomain('playlists', v)) ||
          typeof journal.id !== 'string' || !Number.isSafeInteger(journal.playlistExpectedRevision)) throw new Error('SQLite 收藏恢复日志无效')
        // V1 backups allow playlists without a creation timestamp. The SQLite
        // owner requires one; use the durable envelope time so a replay agrees.
        const playlists = value.data.map(playlist => ({
          ...playlist,
          createdAt: typeof playlist.createdAt === 'string' ? playlist.createdAt : value.savedAt
        }))
        await database.preferencesPlaylistsRestore(playlists, journal.id, Number(journal.playlistExpectedRevision), Date.now())
      } else writeRestoreFile(root, name, value)
    }
    finishPersonalRestore(root, journal)
  }
  function readRendererRestore(root: string): unknown {
    return readRaw(root, rendererName) ?? null
  }
  function acknowledgeRendererRestore(root: string, id: string): void {
    const current = readRendererRestore(root)
    if (isRecord(current) && current.id === id) removeArtifact(root, rendererName)
  }
  function readBackupFile(path: string): PersonalBackup {
    if (coreFs.statSync(path).size > PERSONAL_BACKUP_LIMIT) throw new Error('备份超过 180 MiB')
    return parsePersonalBackup(coreFs.readFileSync(path, 'utf8'))
  }
  function writePersonalBackupFile(path: string, backup: PersonalBackup): void {
    writeJsonValueAtomic(path, backup, {
      label: 'personal backup',
      maxBytes: PERSONAL_BACKUP_LIMIT,
      validate: validatePersonalBackup
    })
  }

  return {
    parsePersonalBackup,
    readPersonalData,
    createPersonalBackup,
    stagePersonalRestore,
    buildRestoreData,
    previewRestore,
    applyPendingPersonalRestore,
    createPersonalBackupFromDatabase,
    createPersonalBackupV1FromDatabase,
    previewRestoreFromDatabase,
    stagePersonalRestoreFromDatabase,
    applyPendingPersonalRestoreFromDatabase,
    readRendererRestore,
    acknowledgeRendererRestore,
    deferStalePersonalRestore,
    personalRestoreNeedsReview: (root: string) => personalRestoreNeedsReview(root, coreFs.existsSync),
    readPersonalRestoreReview,
    acknowledgePersonalRestoreReview,
    readBackupFile,
    writePersonalBackupFile
  }
}
