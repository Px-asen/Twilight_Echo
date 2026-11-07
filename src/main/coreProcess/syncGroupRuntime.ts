import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { SyncGroupEngine, type SyncGroupOutput } from '../../core/playback/syncGroupEngine.ts'
import { CorePlaybackSession, type CorePlaybackSessionOptions } from '../../core/playback/session.ts'
import type { LibraryDatabaseServiceClient } from '../library/libraryDatabaseServiceClient.ts'
import type { SyncGroupDescriptor } from '../../shared/coreSyncGroups.ts'
import { validSyncGroupId } from '../../shared/coreSyncGroups.ts'
import { validZoneId, MAX_CORE_ZONES } from '../../shared/coreZones.ts'
import type { SyncGroupRuntime } from '../../core/playback/zoneRegistry.ts'
import { VersionedDataStore } from '../persistence/versionedDataStore.ts'
import { createPlaybackSessionStoreBundle } from '../persistence/playbackSessionRepository.ts'
import { createCorePlaybackRepository } from '../persistence/corePlaybackRepository.ts'
import { CoreAutoMixService, type CoreAutoMixOptions } from '../../core/audio/autoMixService.ts'

interface GroupCatalog { version: 1; groups: SyncGroupDescriptor[] }
export function syncGroupCatalog(root: string) {
  const store = new VersionedDataStore<GroupCatalog>({ filePath: join(root, 'audio-sync-groups.json'),
    label: 'audio sync groups', maxBytes: 16384, isLegacy: (_v): _v is GroupCatalog => false,
    isData: (value): value is GroupCatalog => {
      const v = value as GroupCatalog
      if (!v || v.version !== 1 || !Array.isArray(v.groups) || v.groups.length > MAX_CORE_ZONES/2) return false
      const ids = new Set<string>(), members = new Set<string>()
      return v.groups.every(g => {
        if (!g || !validSyncGroupId(g.id) || ids.has(g.id) || typeof g.name !== 'string' || !g.name.trim() || g.name.length > 80 ||
            !Array.isArray(g.members) || g.members.length < 2 || g.members.length > MAX_CORE_ZONES ||
            (g.autoMixMode !== undefined && !['off','natural','dj'].includes(g.autoMixMode)) ||
            Object.keys(g).some(k => !['id', 'name', 'members', 'autoMixMode'].includes(k))) return false
        ids.add(g.id)
        return g.members.every(m => {
          if (!m || !validZoneId(m.zoneId) || members.has(m.zoneId) || !Number.isFinite(m.downstreamDelayMs) ||
              m.downstreamDelayMs < 0 || m.downstreamDelayMs > 250 ||
              Object.keys(m).some(k => !['zoneId', 'downstreamDelayMs'].includes(k))) return false
          members.add(m.zoneId); return true
        })
      })
    } })
  let revision = 0
  return {
    load: async () => { const doc = await store.load(); revision = doc?.revision ?? 0
      return doc?.data.groups.map(g => ({ ...g, autoMixMode: g.autoMixMode ?? 'off' as const })) ?? [] },
    save: async (groups: SyncGroupDescriptor[]) => { revision = (await store.save({ version: 1, groups }, revision)).revision }
  }
}

export async function createSyncGroupRuntime(options: {
  root: string; descriptor: SyncGroupDescriptor; outputs: SyncGroupOutput[]; database: LibraryDatabaseServiceClient
  playback: Pick<CorePlaybackSessionOptions, 'queues' | 'resolver' | 'authorize' | 'resources' | 'automaticPlaybackAllowed' | 'observePlayback' | 'playbackStarted' | 'playbackSeeked'>
  autoMix?: Omit<CoreAutoMixOptions, 'root' | 'engine'>
  closed?(): void
  changed(): void
}): Promise<SyncGroupRuntime> {
  const { descriptor, outputs, database, changed } = options
  if (!validSyncGroupId(descriptor.id)) throw new Error('Invalid sync group')
  const directory = join(options.root, 'groups', descriptor.id)
  await mkdir(directory, { recursive: true })
  const initial = (await outputs[0].read()).playback
  const engine = new SyncGroupEngine({ outputs, initial, now: () => Number(process.hrtime.bigint())/1e6,
    wallNow: Date.now, token: randomUUID, wait: async (ms, signal) => { await delay(ms, undefined, { signal }) },
    schedule: (action, ms) => { const timer = setTimeout(action, ms); return () => clearTimeout(timer) }, changed })
  const playback = new CorePlaybackSession({ ...options.playback, engine,
    repository: createCorePlaybackRepository(createPlaybackSessionStoreBundle(directory), database, `group:${descriptor.id}:persisted`, descriptor.id),
    legacyImportScope: descriptor.id,
    resumeMode: () => 'trackAndPosition', now: Date.now,
    schedule: (action, ms) => { const timer = setTimeout(action, ms); return () => clearTimeout(timer) },
    changed, fatal: error => { console.error('[core.sync-group]', descriptor.id, error); changed() } })
  const autoMix = options.autoMix ? new CoreAutoMixService({ ...options.autoMix, root: directory, engine }) : null
  let initialized = false
  try {
    await engine.start() // Acquire transition ownership without opening/arming a decoder.
    await playback.initialize() // Saved queue/position only; no decoder or arm on recovery.
    initialized = true
    autoMix?.activate()
    if (descriptor.autoMixMode && descriptor.autoMixMode !== 'off') {
      if (!engine.supportsAutoMix()) throw new Error('同步组 AutoMix 运行时不可用，保持暂停；请更新成员引擎')
      await engine.setAutoMixMode(descriptor.autoMixMode) // Restore policy, never decoder/arm or automatic Play.
    }
  } catch (error) {
    await autoMix?.shutdown().catch(() => {})
    if (initialized) await playback.shutdown().catch(() => {})
    await engine.close().catch(() => {}); throw error
  }
  return { playback, engine, sources: () => engine.getQueueSnapshot().map(item => item.source),
    close: async () => { await autoMix?.shutdown(); await playback.shutdown(); options.closed?.(); await engine.close() } }
}
