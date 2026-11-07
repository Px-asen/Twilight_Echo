import '../../adapters-node/index.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { LibraryDatabase } from '../library/libraryDatabase.ts'
import { CoreStateDatabase } from '../library/coreStateDatabase.ts'
import { CoreSettingsRepository } from '../../core/persistence/settingsRepository.ts'
import { createPersonalBackupRepository } from '../../core/persistence/personalBackup.ts'
import { exportAppSettingsForBackup } from '../../core/settings/backupFormat.ts'
import { DspAssetLibrary } from '../../core/audio/dspAssetLibrary.ts'
import {
  collectDspAssetIds,
  createDspProfile,
  exportDspProfileArchive
} from '../../core/audio/dspProfileArchive.ts'
import { CanonicalPathGrantSet } from '../security/pathGrants.ts'
import { zoneCatalog } from '../coreProcess/zoneRuntime.ts'
import { syncGroupCatalog } from '../coreProcess/syncGroupRuntime.ts'
import { emptyMusicVersions, type MusicVersionsDocument } from '../../shared/musicVersions.ts'
import type { CoreStateDomain, CoreStateRow } from '../../shared/coreState.ts'
import type { ZoneDescriptor } from '../../shared/coreZones.ts'
import type { SyncGroupDescriptor } from '../../shared/coreSyncGroups.ts'
import { isRecord, type PersonalRestoreOptions } from '../../shared/personalBackup.ts'
import { lockServerProfile } from './profile.ts'
import { newDestination, publish } from './maintenance.ts'
import { migratePersonalBackup, personalDatabase } from './migration.ts'
import { prepareMigratedConfiguration, SERVER_SETTINGS_FIELDS } from './configuration.ts'
import type { QueueWorkspaceDocument } from '../../shared/queueWorkspace.ts'
import type {
  LibraryPlaybackQueueReference,
  PlaybackSessionData
} from '../../shared/playbackSession.ts'
import type { LibraryTrackRecord } from '../../shared/libraryDatabase.ts'
import { saveQueueTrack } from '../../core/workspace/tracks.ts'
import { libraryQueueTrack } from '../../core/playback/libraryTrack.ts'
import { importLegacyQueue } from '../../core/playback/legacyQueueImport.ts'
import { createPlaybackSessionStoreBundle } from '../persistence/playbackSessionRepository.ts'
import { createCorePlaybackRepository } from '../persistence/corePlaybackRepository.ts'
import {
  exportPlaybackContext,
  readPlaybackContext,
  restorePlaybackContext,
  validateMigrationOrder,
  type PlaybackMigrationContext
} from './playbackMigration.ts'
import type { TrackData } from '../../shared/track.ts'

interface ConfigurationFiles {
  settings: string
  dsp: string
  impulse?: string
  order?: string
  context?: string
}
interface BundleZone extends ZoneDescriptor, ConfigurationFiles {
  personal: string
}
interface BundleGroup extends SyncGroupDescriptor {
  personal: string
  order?: string
  context?: string
}
interface DesktopMigrationBundle {
  format: 'twilight-server-migration'
  version: 1
  createdAt: string
  personal: string
  primary: ConfigurationFiles
  zones: BundleZone[]
  groups: BundleGroup[]
}
const stores = [
  'settings.json',
  'playback-session.json',
  'playback-queue.json',
  'playlists.json',
  'queue-workspace.json',
  'lyrics-management.json',
  'playback-bookmarks.json',
  'radio-stations.json',
  'podcast-subscriptions.json'
]

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
async function copyEntry(source: string, destination: string): Promise<void> {
  const info = await lstat(source)
  if (info.isSymbolicLink()) throw new Error('迁移来源含链接；请先整理为实际配置或托管资产')
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 })
    for (const name of await readdir(source))
      await copyEntry(join(source, name), join(destination, name))
  } else if (info.isFile()) await copyFile(source, destination)
  else throw new Error('迁移来源含不支持的文件类型')
}
async function copyOptional(source: string, destination: string, name: string): Promise<void> {
  if (await exists(join(source, name))) await copyEntry(join(source, name), join(destination, name))
}
async function copySession(source: string, destination: string): Promise<void> {
  const directory = await lstat(source)
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error('迁移来源会话目录缺失或不是实际目录')
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const name of stores)
    for (const suffix of ['', '.bak']) await copyOptional(source, destination, name + suffix)
  await copyOptional(source, destination, 'dsp-assets')
}
function readRows(state: CoreStateDatabase, domain: CoreStateDomain) {
  const rows: CoreStateRow[] = []
  let after: string | undefined
  do {
    const page = state.read(domain, after)
    rows.push(...page.rows)
    after = page.next ?? undefined
  } while (after !== undefined)
  return rows
}
function personalState(state: CoreStateDatabase) {
  if (!state.status().complete) throw new Error('请先在桌面完成 Core 数据迁移，再导出整包')
  const versions = emptyMusicVersions()
  for (const row of readRows(state, 'versions')) {
    const [scope, kind] = row.key.split(':')
    if ((scope !== 'tracks' && scope !== 'albums') || (kind !== 'versions' && kind !== 'families'))
      throw new Error('版本关系记录无效')
    if (kind === 'versions')
      versions[scope].versions.push(
        row.value as MusicVersionsDocument['tracks']['versions'][number]
      )
    else
      versions[scope].families.push(
        row.value as MusicVersionsDocument['tracks']['families'][number]
      )
  }
  return {
    versions,
    statistics: {
      tracks: Object.fromEntries(
        readRows(state, 'statistics-tracks').map((row) => [row.key, row.value])
      ),
      days: Object.fromEntries(
        readRows(state, 'statistics-days').map((row) => [row.key, row.value])
      )
    }
  }
}

/** Offline operator entry: source files are read only; schema migration and export run on a private clone. */
export async function exportDesktopMigration(options: {
  source: string
  destination: string
  stopped: boolean
  assetRoots?: string[]
}) {
  if (!options.stopped)
    throw new Error('请先正常退出桌面／Server，再明确指定 --stopped；此操作不停止其他进程')
  if (!isAbsolute(options.source)) throw new Error('--from 必须是绝对数据目录')
  const source = await realpath(options.source),
    target = await newDestination(source, options.destination)
  const unlock = (await exists(join(source, 'server.json')))
    ? await lockServerProfile(source)
    : undefined
  const temporary = await mkdtemp(join(tmpdir(), 'twilight-desktop-export-'))
  let database: LibraryDatabase | undefined, state: CoreStateDatabase | undefined
  try {
    await copySession(source, temporary)
    for (const name of ['music-library.sqlite', 'core-state.sqlite'])
      for (const suffix of ['', '-wal', '-shm'])
        await copyOptional(source, temporary, name + suffix)
    for (const name of ['audio-zones.json', 'audio-sync-groups.json'])
      for (const suffix of ['', '.bak']) await copyOptional(source, temporary, name + suffix)
    if (
      !(await exists(join(temporary, 'music-library.sqlite'))) ||
      !(await exists(join(temporary, 'core-state.sqlite')))
    )
      throw new Error('整包导出需要已迁入 Core 的 SQLite 桌面数据；旧版请先使用个人数据 JSON 导出')
    database = new LibraryDatabase(join(temporary, 'music-library.sqlite'))
    state = new CoreStateDatabase(join(temporary, 'core-state.sqlite'))
    const zones = await zoneCatalog(temporary).load(),
      groups = await syncGroupCatalog(temporary).load()
    for (const zone of zones)
      await copySession(join(source, 'zones', zone.id), join(temporary, 'zones', zone.id))
    for (const group of groups)
      await copySession(join(source, 'groups', group.id), join(temporary, 'groups', group.id))
    const grants = new CanonicalPathGrantSet()
    if (await exists(join(source, 'dsp-assets'))) await grants.grantRoot(join(source, 'dsp-assets'))
    for (const zone of zones)
      if (await exists(join(source, 'zones', zone.id, 'dsp-assets')))
        await grants.grantRoot(join(source, 'zones', zone.id, 'dsp-assets'))
    for (const root of options.assetRoots ?? []) {
      if (!isAbsolute(root)) throw new Error('--asset-root 必须是绝对路径')
      await grants.grantRoot(root)
    }
    const api = personalDatabase(database),
      repository = createPersonalBackupRepository()
    let manifest: DesktopMigrationBundle
    await publish(target, async (staged) => {
      const contexts = new Map<string, string>()
      for (const relative of [
        'local',
        ...zones.map((zone) => `zones/${zone.id}`),
        ...groups.map((group) => `groups/${group.id}`)
      ]) {
        const output = join(staged, relative)
        await mkdir(output, { recursive: true, mode: 0o700 })
        if (
          await exportPlaybackContext(
            relative === 'local' ? temporary : join(temporary, relative),
            join(output, 'context.json'),
            database!
          )
        )
          contexts.set(relative, `${relative}/context.json`)
      }
      const personal = await repository.createPersonalBackupFromDatabase(
        temporary,
        personalState(state!),
        api
      )
      if (personal.data.queue) {
        const workspace = personal.data.queue as QueueWorkspaceDocument
        for (const session of workspace.sessions)
          if (session.libraryQueue) {
            const current = database!.getLibraryQueue(session.libraryQueue.id)
            const exported = database!.exportPlaybackQueue(
              {
                id: current.id,
                revision: current.revision,
                index: current.index,
                entryId: current.selectedEntryId!
              },
              32 * 1024 * 1024,
              true
            )
            session.entries = exported.queue.map((track) =>
              saveQueueTrack(
                libraryQueueTrack(track as LibraryTrackRecord, String(track.queueEntryId)),
                randomUUID
              )
            )
            session.originalEntryIds = exported.originalQueueEntryIds!
            session.currentEntryId = current.selectedEntryId
            delete session.libraryQueue
          }
      }
      repository.writePersonalBackupFile(join(staged, 'personal.json'), personal)
      const order = async (directory: string, relative: string): Promise<string | undefined> => {
        const data = repository.readPersonalData(directory, { library: null }, [
          'playback'
        ]).playback
        if (!isRecord(data) || !data.libraryQueue) return undefined
        const exported = database!.exportPlaybackQueue(
          data.libraryQueue as LibraryPlaybackQueueReference,
          32 * 1024 * 1024,
          true
        )
        const path = `${relative}/order.json`
        await writeFile(join(staged, path), JSON.stringify(exported.originalQueueEntryIds), {
          mode: 0o600
        })
        return path
      }
      const configuration = async (
        directory: string,
        relative: string
      ): Promise<ConfigurationFiles> => {
        const output = join(staged, relative)
        await mkdir(output, { recursive: true, mode: 0o700 })
        const settingsRepository = new CoreSettingsRepository({
          filePath: join(directory, 'settings.json'),
          environment: {
            platform: process.platform,
            defaultCachePath: join(directory, 'music-cache'),
            resolvePath: resolve
          },
          changed() { /* The offline export does not publish settings updates. */ }
        })
        if (settingsRepository.issue?.kind === 'corrupt')
          throw new Error('会话设置及其备份损坏；请先在桌面修复后再迁移')
        const settings = settingsRepository.read()
        const assets = new DspAssetLibrary(join(directory, 'dsp-assets'), {
          now: Date.now,
          newId: randomUUID
        })
        const capture = async (path: string) => {
          const canonical = await grants.resolveWithinRoots(path, 'file')
          if (!canonical)
            throw new Error('外部脉冲响应尚未授权；请通过 --asset-root 明确指定其目录')
          return assets.importFile({ kind: 'impulseResponse', sourcePath: canonical })
        }
        let impulse: string | undefined
        if (settings.audioProcessing.convolverIrPath) {
          const asset = await capture(settings.audioProcessing.convolverIrPath)
          impulse = `${relative}/legacy${asset.fileName.slice(asset.fileName.lastIndexOf('.'))}`
          await copyFile(await assets.getPath(asset.id), join(staged, impulse))
        }
        for (const scene of settings.dspScenes)
          for (const node of scene.graph.nodes) {
            const path = node.params.impulseResponsePath
            if (!node.params.impulseResponseAssetId && typeof path === 'string' && path) {
              const asset = await capture(path)
              node.params.impulseResponseAssetId = asset.id
              delete node.params.impulseResponsePath
            }
          }
        const ids = collectDspAssetIds(settings.dspScenes)
        for (const id of ids) {
          if (!(await assets.get(id))) throw new Error('DSP 场景引用的托管资产缺失')
          await assets.getPath(id)
        }
        await writeFile(
          join(output, 'settings.json'),
          exportAppSettingsForBackup(
            Object.fromEntries(SERVER_SETTINGS_FIELDS.map((field) => [field, settings[field]]))
          ),
          {
            mode: 0o600
          }
        )
        await exportDspProfileArchive(
          {
            outputPath: join(output, 'profile.tedsp'),
            profile: createDspProfile({
              name: relative,
              scenes: settings.dspScenes,
              pinnedSceneId: settings.dspPinnedSceneId,
              assetIds: ids
            })
          },
          assets
        )
        return {
          settings: `${relative}/settings.json`,
          dsp: `${relative}/profile.tedsp`,
          order: await order(directory, relative),
          context: contexts.get(relative),
          ...(impulse ? { impulse } : {})
        }
      }
      const primary = await configuration(temporary, 'local'),
        exportedZones: BundleZone[] = [],
        exportedGroups: BundleGroup[] = []
      for (const zone of zones) {
        const relative = `zones/${zone.id}`,
          directory = join(temporary, relative)
        const config = await configuration(directory, relative),
          personal = `${relative}/personal.json`
        repository.writePersonalBackupFile(
          join(staged, personal),
          await repository.createPersonalBackupFromDatabase(directory, {}, api, {
            domains: ['playback']
          })
        )
        exportedZones.push({ ...zone, ...config, personal })
      }
      for (const group of groups) {
        const relative = `groups/${group.id}`,
          directory = join(temporary, relative),
          personal = `${relative}/personal.json`
        await mkdir(join(staged, relative), { recursive: true, mode: 0o700 })
        repository.writePersonalBackupFile(
          join(staged, personal),
          await repository.createPersonalBackupFromDatabase(directory, {}, api, {
            domains: ['playback']
          })
        )
        exportedGroups.push({
          ...group,
          personal,
          order: await order(directory, relative),
          context: contexts.get(relative)
        })
      }
      manifest = {
        format: 'twilight-server-migration',
        version: 1,
        createdAt: new Date().toISOString(),
        personal: 'personal.json',
        primary,
        zones: exportedZones,
        groups: exportedGroups
      }
      await writeFile(join(staged, 'migration.json'), JSON.stringify(manifest, null, 2), {
        mode: 0o600
      })
    })
    return manifest!
  } finally {
    state?.close()
    database?.close()
    await unlock?.()
    assert.equal(resolve(temporary, '..'), resolve(tmpdir()), '导出临时目录位置不符，未清理')
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function migrateDesktopBundle(
  options: Omit<Parameters<typeof migratePersonalBackup>[0], 'additional'>
) {
  const root = await realpath(options.file),
    grants = new CanonicalPathGrantSet()
  await grants.grantRoot(root)
  const file = async (path: string) => {
    if (typeof path !== 'string') throw new Error('迁移包文件引用无效')
    const canonical = await grants.resolveWithinRoots(resolve(root, path), 'file')
    if (!canonical) throw new Error('迁移包引用越过包目录')
    return canonical
  }
  const manifest = JSON.parse(
    await readFile(await file('migration.json'), 'utf8')
  ) as DesktopMigrationBundle
  if (
    manifest.format !== 'twilight-server-migration' ||
    manifest.version !== 1 ||
    !manifest.primary ||
    !Array.isArray(manifest.zones) ||
    !Array.isArray(manifest.groups)
  )
    throw new Error('整包迁移清单格式无效')
  const resources = async (config: ConfigurationFiles) => ({
    settingsFile: await file(config.settings),
    dspProfile: await file(config.dsp),
    impulseFile: config.impulse ? await file(config.impulse) : undefined
  })
  const primary = await resources(manifest.primary),
    mappings = options.restoreOptions?.mappings ?? []
  const includePlayback = options.restoreOptions?.domains.includes('playback') ?? true
  const repository = createPersonalBackupRepository()
  const readOrder = async (path: string | undefined, personal: string) => {
    if (!path || !includePlayback) return undefined
    const parsed: unknown = JSON.parse(await readFile(await file(path), 'utf8'))
    const backup = repository.readBackupFile(await file(personal))
    const session = backup.data.playback as
      | PlaybackSessionData<{ queueEntryId?: string }>
      | null
      | undefined
    validateMigrationOrder(session, parsed)
    return parsed
  }
  const primaryOrder = await readOrder(manifest.primary.order, manifest.personal)
  const zoneOrders = new Map(
    await Promise.all(
      manifest.zones.map(
        async (zone) => [zone.id, await readOrder(zone.order, zone.personal)] as const
      )
    )
  )
  const groupOrders = new Map(
    await Promise.all(
      manifest.groups.map(
        async (group) => [group.id, await readOrder(group.order, group.personal)] as const
      )
    )
  )
  const readContext = async (path: string | undefined, personal: string) => {
    if (!path || !includePlayback) return undefined
    const backup = repository.readBackupFile(await file(personal))
    return readPlaybackContext(
      await file(path),
      backup.data.playback as PlaybackSessionData<TrackData> | null | undefined,
      mappings
    )
  }
  const primaryContext = await readContext(manifest.primary.context, manifest.personal)
  const zoneContexts = new Map(
    await Promise.all(
      manifest.zones.map(
        async (zone) => [zone.id, await readContext(zone.context, zone.personal)] as const
      )
    )
  )
  const groupContexts = new Map(
    await Promise.all(
      manifest.groups.map(
        async (group) => [group.id, await readContext(group.context, group.personal)] as const
      )
    )
  )
  return migratePersonalBackup({
    ...options,
    file: await file(manifest.personal),
    settingsFile: options.settingsFile ?? primary.settingsFile,
    dspProfile: options.dspProfile ?? primary.dspProfile,
    impulseFile: options.impulseFile ?? primary.impulseFile,
    additional: async (destination, database, apply, localDatabase) => {
      // Existing catalog writers validate IDs, counts, members and delay units before any runtime starts.
      const descriptors = manifest.zones.map(({ id, name }) => ({ id, name }))
      const groups = manifest.groups.map(({ id, name, members, autoMixMode = 'off' }) => ({ id, name, members, autoMixMode }))
      await zoneCatalog(destination).save(descriptors)
      await syncGroupCatalog(destination).save(groups)
      const ids = new Set(['local', ...descriptors.map((zone) => zone.id)])
      if (groups.some((group) => group.members.some((member) => !ids.has(member.zoneId))))
        throw new Error('同步组包含不存在的 Zone')
      const importSession = async (
        directory: string,
        scope: string | undefined,
        originalEntryIds: string[] | undefined,
        context: PlaybackMigrationContext | undefined
      ) => {
        const owner = scope
          ? `${scope.startsWith('group-') ? 'group' : 'zone'}:${scope}:persisted`
          : 'core:persisted-playback'
        const repository = createCorePlaybackRepository(
          createPlaybackSessionStoreBundle(directory),
          {
            syncLibraryQueueReferences: async (...args) =>
              localDatabase.syncLibraryQueueReferences(...args)
          },
          owner,
          scope
        )
        const saved = await repository.load()
        if (!saved?.data) return
        const imported = await importLegacyQueue({
          api: {
            importLegacyPlaybackQueue: async (command) =>
              localDatabase.importLegacyPlaybackQueue(command),
            readQueue: async (...args) => localDatabase.readLibraryQueue(...args)
          },
          session: saved.data,
          sessionRevision: saved.revision,
          libraryRevision: localDatabase.getMetadata().revision,
          scope,
          originalEntryIds
        })
        const queue = imported.queue,
          row = localDatabase.readLibraryQueue(queue.id, queue.index, 1, {
            expectedRevision: queue.revision
          }).items[0]
        if (!row?.track) throw new Error('迁移队列选中的 occurrence 缺少快照')
        const {
          queue: _queue,
          queueRevision: _queueRevision,
          queueIndex: _index,
          ...session
        } = saved.data
        await repository.save(
          await restorePlaybackContext(
            context,
            {
              ...session,
              track: libraryQueueTrack(row.track, row.queueEntryId),
              position: imported.position,
              libraryQueue: {
                id: queue.id,
                revision: queue.revision,
                index: queue.index,
                entryId: queue.selectedEntryId!
              }
            },
            localDatabase,
            scope,
            saved.revision
          ),
          saved.revision
        )
      }
      if (apply && includePlayback)
        await importSession(destination, undefined, primaryOrder, primaryContext)
      const session = async (directory: string, personal: string) => {
        const backup = repository.readBackupFile(await file(personal))
        if (Object.keys(backup.data).some((domain) => domain !== 'playback'))
          throw new Error('逐 Zone 迁移文件只能包含当前播放会话')
        const restore: PersonalRestoreOptions = {
          conflict: 'use-backup',
          mappings,
          domains: ['playback']
        }
        const preview = await repository.previewRestoreFromDatabase(
          directory,
          backup,
          {},
          database,
          restore
        )
        if (apply && includePlayback) {
          await repository.stagePersonalRestoreFromDatabase(
            directory,
            backup,
            restore,
            [],
            database
          )
          await repository.applyPendingPersonalRestoreFromDatabase(directory, database)
          const renderer = repository.readRendererRestore(directory)
          if (isRecord(renderer) && typeof renderer.id === 'string')
            repository.acknowledgeRendererRestore(directory, renderer.id)
        }
        return { selected: includePlayback, preview }
      }
      const zones: Array<
        ZoneDescriptor & {
          configuration: Awaited<ReturnType<typeof prepareMigratedConfiguration>>['report']
          playback: Awaited<ReturnType<typeof session>>
        }
      > = []
      for (const zone of manifest.zones) {
        const directory = join(destination, 'zones', zone.id)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const config = await prepareMigratedConfiguration(directory, {
          ...(await resources(zone)),
          resumeMode: 'trackAndPosition',
          libraryRoots: options.libraryRoots,
          mappings
        })
        const playback = await session(directory, zone.personal)
        if (apply)
          await writeFile(join(directory, 'settings.json'), JSON.stringify(config.settings), {
            mode: 0o600
          })
        if (apply && includePlayback)
          await importSession(
            directory,
            zone.id,
            zoneOrders.get(zone.id),
            zoneContexts.get(zone.id)
          )
        zones.push({ id: zone.id, name: zone.name, configuration: config.report, playback })
      }
      const restoredGroups: Array<
        SyncGroupDescriptor & { playback: Awaited<ReturnType<typeof session>> }
      > = []
      for (const group of manifest.groups) {
        const directory = join(destination, 'groups', group.id)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const playback = await session(directory, group.personal)
        if (apply && includePlayback)
          await importSession(
            directory,
            group.id,
            groupOrders.get(group.id),
            groupContexts.get(group.id)
          )
        restoredGroups.push({
          id: group.id,
          name: group.name,
          members: group.members,
          autoMixMode: group.autoMixMode ?? 'off',
          playback
        })
      }
      const contextSummary = (context: PlaybackMigrationContext | undefined) =>
        context
          ? {
              heart: !!context.heart,
              heartBaseEntries: context.heart?.base?.session.queue?.length ?? 0,
              personalized: context.personalized,
              detached: !!context.detached
            }
          : undefined
      return {
        zones,
        groups: restoredGroups,
        playbackContexts: {
          primary: contextSummary(primaryContext),
          zones: Object.fromEntries(
            [...zoneContexts]
              .filter(([, context]) => context)
              .map(([id, context]) => [id, contextSummary(context)])
          ),
          groups: Object.fromEntries(
            [...groupContexts]
              .filter(([, context]) => context)
              .map(([id, context]) => [id, contextSummary(context)])
          )
        }
      }
    }
  })
}
