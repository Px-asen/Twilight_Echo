import '../../adapters-node/index.ts'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { LibraryDatabase } from '../library/libraryDatabase.ts'
import { CoreStateDatabase } from '../library/coreStateDatabase.ts'
import { CanonicalPathGrantSet } from '../security/pathGrants.ts'
import {
  createPersonalBackupRepository,
  checkRestoreOptions
} from '../../core/persistence/personalBackup.ts'
import {
  PERSONAL_DOMAINS,
  remapPersonalPaths,
  type PersonalRestoreOptions
} from '../../shared/personalBackup.ts'
import type { PersonalLibraryDatabase } from '../../shared/coreBackup.ts'
import type { LocalMusicLibraryDocument } from '../../shared/localLibrary.ts'
import type { PlaybackSessionData } from '../../shared/playbackSession.ts'
import { emptyCoreStateCounts } from '../../shared/coreState.ts'
import { initializeServerProfile, lockServerProfile, readServerProfile } from './profile.ts'
import { prepareMigratedConfiguration } from './configuration.ts'

/** Reuse the existing personal restore transaction and CAS contract, not another import format. */
export function personalDatabase(database: LibraryDatabase): PersonalLibraryDatabase {
  return {
    exportDocument: async (options) => database.exportDocument(options),
    getMetadata: async () => database.getMetadata(),
    exportPlaybackQueue: async (...args) => database.exportPlaybackQueue(...args),
    previewPersonalLibrary: async (document) => database.previewPersonalLibrary(document),
    restoreDocument: (...args) => database.restoreDocument(...args),
    restorePersonalLibrary: (...args) => database.restorePersonalLibrary(...args),
    preferencesPlaylistsLoad: async () => database.preferencesPlaylistsLoad(),
    preferencesPlaylistsRestore: async (...args) => database.preferencesPlaylistsRestore(...args),
    musicBackupRevision: async () => database.musicBackupRevision(),
    musicBackupExport: async (limit) => database.musicBackupExport(limit),
    musicBackupPreview: async (...args) => database.musicBackupPreview(...args),
    musicBackupRestore: (bundle) => database.musicBackupRestore(bundle)
  }
}

export async function migratePersonalBackup(options: {
  file: string
  destination: string
  libraryRoots: string[]
  restoreOptions?: PersonalRestoreOptions
  apply?: boolean
  settingsFile?: string
  dspProfile?: string
  impulseFile?: string
  /** Host-owned bundle expansion; never parsed from an RPC or backup document. */
  additional?: (
    root: string,
    database: PersonalLibraryDatabase,
    apply: boolean,
    localDatabase: LibraryDatabase
  ) => Promise<unknown>
}) {
  if (!isAbsolute(options.file) || !isAbsolute(options.destination))
    throw new Error('备份文件和 Server 目标必须是绝对路径')
  const repository = createPersonalBackupRepository()
  const backup = repository.readBackupFile(options.file)
  const restore = options.restoreOptions ?? {
    conflict: 'use-backup',
    mappings: [],
    domains: PERSONAL_DOMAINS.filter((domain) => domain in backup.data)
  }
  checkRestoreOptions(restore)
  const grants = new CanonicalPathGrantSet()
  for (const root of options.libraryRoots) {
    if (!isAbsolute(root)) throw new Error('--library 必须是绝对路径')
    await grants.grantRoot(root)
  }
  const libraryRoots = await Promise.all(options.libraryRoots.map((root) => realpath(root)))
  const mapped =
    restore.domains.includes('library') && backup.data.library
      ? (remapPersonalPaths(backup.data.library, restore.mappings) as LocalMusicLibraryDocument)
      : null
  const mappedRoots: string[] = []
  for (const folder of mapped?.folders ?? []) {
    const canonical = await grants.resolveWithinRoots(folder, 'directory')
    if (!canonical) throw new Error(`迁移曲库目录不在明确授权的 --library 根目录内：${folder}`)
    mappedRoots.push(canonical)
  }
  const target = join(await realpath(dirname(options.destination)), basename(options.destination))
  // Apply reserves a new destination exclusively; preview writes only to a temporary profile.
  const root = options.apply ? target : await mkdtemp(join(tmpdir(), 'twilight-migration-preview-'))
  if (options.apply) await mkdir(root, { mode: 0o700 })
  let database: LibraryDatabase | undefined,
    state: CoreStateDatabase | undefined,
    completed = false,
    unlock: (() => Promise<void>) | undefined
  try {
    await initializeServerProfile(root, libraryRoots)
    unlock = await lockServerProfile(root)
    const profile = await readServerProfile(root)
    database = new LibraryDatabase(join(root, 'music-library.sqlite'))
    const api = personalDatabase(database)
    const preview = await repository.previewRestoreFromDatabase(root, backup, {}, api, restore)
    if (
      preview.music?.referenceConflicts.length ||
      preview.music?.dependencies.includes('music:identity-reference-conflict')
    )
      throw new Error('音乐整理存在引用冲突，请在桌面修正备份后再迁移')
    const playback = restore.domains.includes('playback')
      ? (backup.data.playback as PlaybackSessionData<{ id: string }> | null | undefined)
      : null
    const configuration = await prepareMigratedConfiguration(root, {
      settingsFile: options.settingsFile,
      dspProfile: options.dspProfile,
      impulseFile: options.impulseFile,
      resumeMode: playback?.mode ?? 'off',
      libraryRoots,
      mappings: restore.mappings
    })
    const report = {
      format: 'twilight-server-personal-migration',
      version: 1,
      applied: options.apply === true,
      sourceVersion: backup.version,
      profileId: profile.id,
      destination: target,
      libraryRoots,
      mappedRoots,
      options: restore,
      preview,
      configuration: configuration.report,
      additional: undefined as unknown
    }
    if (options.apply) {
      // Personal restore adds libraryFolders to settings.json. Seed the imported
      // resume mode first, so normal settings loading does not default it to off.
      await writeFile(join(root, 'settings.json'), JSON.stringify(configuration.settings), {
        flag: 'wx',
        mode: 0o600
      })
      state = new CoreStateDatabase(join(root, 'core-state.sqlite'))
      state.begin(profile.id, { version: 1, counts: emptyCoreStateCounts() })
      state.commit(profile.id)
      await repository.stagePersonalRestoreFromDatabase(
        root,
        backup,
        restore,
        mappedRoots,
        api,
        {},
        preview.music?.revision
      )
      await repository.applyPendingPersonalRestoreFromDatabase(root, api)
      state.restorePersonalData()
      report.additional = await options.additional?.(root, api, true, database)
      for (const sql of [database.sql, state.sql])
        if (sql.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
          throw new Error('迁移后的 SQLite 检查失败')
      // A migrated queue stays disconnected until a Bridge is explicitly authorized.
      await writeFile(
        join(root, 'bridge-output-selection.json'),
        JSON.stringify({ version: 1, selected: true }),
        { flag: 'wx', mode: 0o600 }
      )
      await writeFile(join(root, 'server-migration.json'), JSON.stringify(report, null, 2), {
        flag: 'wx',
        mode: 0o600
      })
    } else report.additional = await options.additional?.(root, api, false, database)
    completed = true
    return report
  } finally {
    state?.close()
    database?.close()
    await unlock?.()
    if (!options.apply || !completed) {
      const parent = options.apply ? dirname(target) : resolve(tmpdir())
      assert.equal(dirname(resolve(root)), parent, '迁移临时目录不在预期位置，未清理')
      await rm(root, { recursive: true, force: true })
    }
  }
}
