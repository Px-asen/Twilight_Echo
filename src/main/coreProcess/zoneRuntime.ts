import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ZoneDescriptor } from '../../shared/coreZones.ts'
import { MAX_CORE_ZONES, validZoneId } from '../../shared/coreZones.ts'
import type { LibraryDatabaseServiceClient } from '../library/libraryDatabaseServiceClient.ts'
import type { CorePlaybackSessionOptions } from '../../core/playback/session.ts'
import { CorePlaybackSession } from '../../core/playback/session.ts'
import { CoreDspService, type CoreDspPlatform } from '../../core/audio/dspService.ts'
import { CoreAudioOutputService } from '../../core/audio/outputService.ts'
import { CoreSettingsRepository } from '../../core/persistence/settingsRepository.ts'
import { DspAssetLibrary } from '../../core/audio/dspAssetLibrary.ts'
import { Vst3CatalogService } from '../../core/audio/vst3Catalog.ts'
import { coreAudioConfiguration, createCoreAudioPersistence } from '../../core/audio/settings.ts'
import { VersionedDataStore } from '../persistence/versionedDataStore.ts'
import { createPlaybackSessionStoreBundle } from '../persistence/playbackSessionRepository.ts'
import { createCorePlaybackRepository } from '../persistence/corePlaybackRepository.ts'
import { AudioEngineManager } from '../audioEngineManager.ts'
import { AudioEngineServiceBinding } from '../audioEngineServiceClient.ts'
import type { CoreServiceLauncher, CoreServiceLease } from './serviceLauncher.ts'
import type { ZoneRuntime } from '../../core/playback/zoneRegistry.ts'
import type { BridgeRuntimeState } from '../../shared/audioBridge.ts'
import { zoneGroupOutput } from './zoneGroupOutput.ts'

interface ZoneCatalog { version: 1; zones: ZoneDescriptor[] }
export function playbackQueueApi(database: LibraryDatabaseServiceClient): CorePlaybackSessionOptions['queues'] {
  return {
    libraryRevision: async () => (await database.getMetadata()).revision,
    importLegacyPlaybackQueue: command => database.importLegacyPlaybackQueue(command),
    restoreNamedPlaybackQueue: command => database.restoreNamedPlaybackQueue(command),
    restoreHeartBaseQueue: (...args) => database.restoreHeartBaseQueue(...args),
    clonePlaybackQueue: reference => database.clonePlaybackQueue(reference),
    extendQueue: (...args) => database.extendPlaybackQueue(...args),
    replaceSource: command => database.replacePlaybackQueueSource(command),
    buildQueue: (...args) => database.buildLibraryQueue(...args),
    createQueue: (...args) => database.createLibraryQueue(...args),
    getQueue: (...args) => database.getLibraryQueue(...args),
    readQueue: (...args) => database.readLibraryQueue(...args),
    editQueue: (id, revision, edit) => edit.kind === 'insert'
      ? database.insertCorePlaybackQueue(id, revision, edit) : database.editLibraryQueue(id, revision, edit),
    deleteQueue: (...args) => database.deleteLibraryQueue(...args),
    syncQueueReferences: (...args) => database.syncLibraryQueueReferences(...args),
    readNeighbor: (...args) => database.readLibraryQueueNeighbor(...args)
  }
}
export function zoneCatalog(root: string) {
  const store = new VersionedDataStore<ZoneCatalog>({
    filePath: join(root, 'audio-zones.json'), label: 'audio zones', maxBytes: 16_384,
    isLegacy: (_v): _v is ZoneCatalog => false,
    isData: (v): v is ZoneCatalog => {
      if (!v || typeof v !== 'object' || !('version' in v) || v.version !== 1 || !('zones' in v) || !Array.isArray(v.zones)) return false
      const ids = new Set<string>()
      return v.zones.length < MAX_CORE_ZONES && v.zones.every(z => {
        if (!z || typeof z !== 'object' || !validZoneId(z.id) || z.id === 'local' || ids.has(z.id) ||
            typeof z.name !== 'string' || !z.name.trim() || z.name.length > 80 || z.name.includes('\0') ||
            Object.keys(z).some(k => !['id', 'name'].includes(k))) return false
        ids.add(z.id); return true
      })
    }
  })
  let revision = 0
  return {
    load: async () => { const document = await store.load(); revision = document?.revision ?? 0; return document?.data.zones ?? [] },
    save: async (zones: ZoneDescriptor[]) => { revision = (await store.save({ version: 1, zones }, revision)).revision }
  }
}

/** Fixed launcher entry, separate native process and state directory per zone.
 * Extra zones are Bridge-only; initialization quarantines before any routing. */
export async function createZoneRuntime(options: {
  root: string; zone: ZoneDescriptor; database: LibraryDatabaseServiceClient; launcher: CoreServiceLauncher
  platform: CoreDspPlatform
  playback: Pick<CorePlaybackSessionOptions, 'queues' | 'resolver' | 'authorize' | 'resources' | 'automaticPlaybackAllowed' | 'observePlayback' | 'playbackStarted' | 'playbackSeeked'>
  closed?(): void
  changed(): void
}): Promise<ZoneRuntime> {
  const { root, zone, database, launcher, platform, playback: dependencies, changed } = options
  if (!validZoneId(zone.id) || zone.id === 'local') throw new Error('Invalid additional Zone')
  const directory = join(root, 'zones', zone.id)
  await mkdir(directory, { recursive: true })
  const settings = new CoreSettingsRepository({ filePath: join(directory, 'settings.json'),
    environment: { platform: process.platform, defaultCachePath: join(root, 'music-cache'), resolvePath: resolve },
    initial: { audioEqAutoPreamp: { enabled: false, manualDb: null } }, changed })
  const persist = createCoreAudioPersistence(settings)
  // Platform discovery can fail before a native lease exists.
  const environment = await platform.call('dsp.environment', {})
  let lease: CoreServiceLease | null = null
  let fatalAudio = false
  const assets = new DspAssetLibrary(join(directory, 'dsp-assets'), { now: Date.now, newId: randomUUID })
  const catalog = new Vst3CatalogService(join(directory, 'dsp-vst3'), { scan: p => audio.scanVst3Module(p) }, environment.searchPaths,
    { platform: environment.platform, helpers: environment.helpers, now: Date.now })
  const audio: AudioEngineManager = new AudioEngineManager(coreAudioConfiguration(settings.read()), {
    platform: process.platform, initialBridgeSelected: true,
    dspAssetPathResolver: id => assets.getKnownPath(id),
    vst3StateAssetResolver: id => assets.resolveVst3State(id),
    vst3ModuleResolver: (id, classId) => catalog.resolveAvailableModule(id, classId),
    persistDeviceProfiles: persist.profile, persistAudioOutput: persist.output,
    audioServiceFactory: () => new AudioEngineServiceBinding({ serviceEntry: 'zone-audio', launch: () => {
      lease = launcher.launch('zone-audio'); return lease
    } })
  })
  const report = (error: unknown) => console.error('[core.zone]', zone.id, error)
  audio.on('error', report)
  const output = new CoreAudioOutputService({ engine: audio, settings, changed })
  const dsp = new CoreDspService({ engine: audio, configuration: output, settings,
    preferences: database, assets, catalog, platform, temporaryDirectory: environment.temporaryDirectory,
    uploadDirectory: join(directory, 'dsp-upload-staging'),
    hostSearchPaths: environment.fixedSearchPaths ? environment.searchPaths : undefined,
    now: Date.now, newId: randomUUID, failed: report })
  audio.on('playback-info', info => dsp.observePlayback(info))
  audio.on('audio-service-crash', reason => { void dsp.quarantineActive(reason).catch(report); changed() })
  const playback = new CorePlaybackSession({ ...dependencies, engine: audio,
    repository: createCorePlaybackRepository(createPlaybackSessionStoreBundle(directory), database, `zone:${zone.id}:persisted`, zone.id),
    legacyImportScope: zone.id,
    resumeMode: () => 'trackAndPosition', now: Date.now,
    schedule: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer) },
    changed, fatal: error => { fatalAudio = true; report(error); audio.destroy(); changed() } })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { await dsp.shutdown() }
    finally {
      try {
        if (fatalAudio) await lease?.terminate()
        await playback.shutdown({ audioTerminated: fatalAudio })
        options.closed?.()
      }
      finally {
        try { if (!fatalAudio) await audio.callBridge('BridgeShutdown') }
        finally { audio.destroy(); await lease?.terminate() }
      }
    }
  }
  try {
    await dsp.initialize(); await playback.initialize(); await dsp.activate()
    return { playback, dsp, failed: () => fatalAudio, groupOutput: zoneGroupOutput(zone.id, audio),
      output: async () => await audio.callBridge('BridgeStatus') as BridgeRuntimeState,
      connect: async (peer, coordinated) => {
        if (!coordinated) await playback.stop()
        await audio.callBridge('BridgeConnect', [peer])
        if (coordinated) await audio.callBridge('BridgeCancelTimed')
      },
      sources: () => audio.getQueueSnapshot().map(item => item.source), close }
  } catch (error) { await close().catch(report); throw error }
}
