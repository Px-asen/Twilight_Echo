import '../../adapters-node/index.ts'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configurationFixture } from './configuration.fixture.ts'
import { LibraryDatabase } from '../library/libraryDatabase.ts'
import { CoreStateDatabase } from '../library/coreStateDatabase.ts'
import { emptyCoreStateCounts } from '../../shared/coreState.ts'
import { importLegacyQueue } from '../../core/playback/legacyQueueImport.ts'
import { libraryQueueTrack } from '../../core/playback/libraryTrack.ts'
import { createPlaybackSessionStoreBundle } from '../persistence/playbackSessionRepository.ts'
import { createCorePlaybackRepository } from '../persistence/corePlaybackRepository.ts'
import { VersionedDataStore } from '../persistence/versionedDataStore.ts'
import {
  isQueueWorkspaceDocument,
  type QueueWorkspaceDocument
} from '../../shared/queueWorkspace.ts'
import { captureLibraryQueueSession } from '../../core/workspace/tracks.ts'
import { zoneCatalog } from '../coreProcess/zoneRuntime.ts'
import { syncGroupCatalog } from '../coreProcess/syncGroupRuntime.ts'
import type { ZoneDescriptor } from '../../shared/coreZones.ts'
import type { SyncGroupDescriptor } from '../../shared/coreSyncGroups.ts'
import type { PlaybackSessionData } from '../../shared/playbackSession.ts'
import type { TrackData } from '../../shared/track.ts'
import { queueReference } from './playbackMigration.ts'

/** A stopped modern desktop profile with six independent SQL sessions at revision 1. */
export async function desktopMigrationFixture(root: string) {
  const source = join(root, 'desktop'),
    music = join(root, '音乐')
  await mkdir(source, { recursive: true })
  await mkdir(music, { recursive: true })
  const configuration = await configurationFixture(join(root, 'configuration'))
  // The same valid WAV is enough: this fixture restores paused, never opens a device.
  for (const name of ['one.wav', 'two.wav'])
    await writeFile(join(music, name), configuration.impulse)
  const tracks = [
    {
      id: 'one',
      source: 'local',
      filePath: join(music, 'one.wav'),
      title: '一',
      artist: 'Artist',
      album: 'Album',
      duration: 90
    },
    {
      id: 'two',
      source: 'local',
      filePath: join(music, 'two.wav'),
      title: '二',
      artist: 'Artist',
      album: 'Album',
      duration: 90
    }
  ]
  const zones: ZoneDescriptor[] = [1, 2, 3].map((n) => ({
    id: `zone-${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`,
    name: ['书房', '客厅', '卧室'][n - 1]
  }))
  const groups: SyncGroupDescriptor[] = [
    {
      id: 'group-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: '楼下',
      members: [
        { zoneId: 'local', downstreamDelayMs: 12.5 },
        { zoneId: zones[0].id, downstreamDelayMs: 0 }
      ]
    },
    {
      id: 'group-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: '楼上',
      members: [
        { zoneId: zones[1].id, downstreamDelayMs: 250 },
        { zoneId: zones[2].id, downstreamDelayMs: 3.25 }
      ]
    }
  ]
  await zoneCatalog(source).save(zones)
  await syncGroupCatalog(source).save(groups)
  const db = new LibraryDatabase(join(source, 'music-library.sqlite'))
  const state = new CoreStateDatabase(join(source, 'core-state.sqlite'))
  const sessions: Array<{
    id: string
    directory: string
    data: PlaybackSessionData<TrackData>
    originalEntryIds: string[]
  }> = []
  try {
    db.replaceDocument({ version: 2, revision: 14, folders: [music], exclusions: [], tracks })
    const counts = emptyCoreStateCounts()
    counts['statistics-days'] = 1
    state.begin('desktop-fixture', { version: 1, counts })
    state.stage('desktop-fixture', 0, 'statistics-days', [{ key: '2026-11-03', value: 42 }])
    state.commit('desktop-fixture')
    for (const [index, id] of [
      'local',
      ...zones.map((z) => z.id),
      ...groups.map((g) => g.id)
    ].entries()) {
      const directory =
        id === 'local' ? source : join(source, id.startsWith('zone-') ? 'zones' : 'groups', id)
      await mkdir(directory, { recursive: true })
      const queue = [tracks[1], tracks[0], tracks[0]].map((track, i) =>
        libraryQueueTrack(track, `${id}:occurrence:${i}`)
      )
      const data: PlaybackSessionData<TrackData> = {
        version: 1,
        savedAt: '2026-11-03T00:00:00Z',
        mode: 'trackAndPosition',
        playMode: 'shuffle',
        track: queue[2],
        position: 10 + index,
        queue,
        queueIndex: 2
      }
      const originalEntryIds = [
        queue[1].queueEntryId!,
        queue[2].queueEntryId!,
        queue[0].queueEntryId!
      ]
      const imported = await importLegacyQueue({
        api: {
          importLegacyPlaybackQueue: async (c) => db.importLegacyPlaybackQueue(c),
          readQueue: async (...args) => db.readLibraryQueue(...args)
        },
        session: data,
        sessionRevision: 1,
        libraryRevision: db.getMetadata().revision,
        scope: id === 'local' ? undefined : id,
        originalEntryIds
      })
      const scope = id === 'local' ? undefined : id
      const repository = createCorePlaybackRepository(
        createPlaybackSessionStoreBundle(directory),
        {
          syncLibraryQueueReferences: async (...args) => db.syncLibraryQueueReferences(...args)
        },
        scope
          ? `${id.startsWith('group-') ? 'group' : 'zone'}:${id}:persisted`
          : 'core:persisted-playback',
        scope
      )
      const reference = {
        id: imported.queue.id,
        revision: imported.queue.revision,
        index: 2,
        entryId: queue[2].queueEntryId!
      }
      const { queue: _queue, queueIndex: _index, ...saved } = data
      const stored = await repository.save({ ...saved, libraryQueue: reference }, 0)
      if (stored.revision !== 1) throw new Error('Fixture revision changed')
      sessions.push({ id, directory, data, originalEntryIds })
      if (index < 4) {
        await cp(join(root, 'configuration', 'source-assets'), join(directory, 'dsp-assets'), {
          recursive: true
        })
        const settings = structuredClone(configuration.settings)
        settings.softwareVolume = 0.2 + index * 0.1
        settings.dspScenes[0].name = `${id} room`
        await writeFile(join(directory, 'settings.json'), JSON.stringify(settings))
      }
      if (id === 'local') {
        const workspace = new VersionedDataStore<QueueWorkspaceDocument>({
          filePath: join(source, 'queue-workspace.json'),
          label: 'queue workspace',
          maxBytes: 32 * 1024 * 1024,
          isData: isQueueWorkspaceDocument,
          isLegacy: isQueueWorkspaceDocument
        })
        await workspace.save(
          {
            version: 1,
            sessions: [
              captureLibraryQueueSession(
                { now: Date.now, newId: () => 'named-queue' },
                '晚上听',
                reference,
                17,
                'shuffle'
              )
            ],
            history: []
          },
          0
        )
        db.syncLibraryQueueReferences('workspace', [reference.id])
      }
    }
    await writeFile(join(source, 'remote-tls.json'), 'private TLS identity')
    await writeFile(join(source, 'plugin-secrets.json'), 'private provider credentials')
  } finally {
    state.close()
    db.close()
  }
  return { source, music, tracks, zones, groups, sessions, configuration }
}

export async function addOnlineMigrationFixture(
  f: Awaited<ReturnType<typeof desktopMigrationFixture>>,
  kind: 'heart' | 'detached' | 'personalized' | 'liked'
) {
  const db = new LibraryDatabase(join(f.source, 'music-library.sqlite'))
  try {
    const baseSaved = await createPlaybackSessionStoreBundle(f.source).storage.load()
    const originalBase = baseSaved!.data!.libraryQueue!
    const base = db.editLibraryQueue(originalBase.id, originalBase.revision, {
      kind: 'mode',
      mode: 'repeat'
    }).queue
    const queue = [7, 8, 8].map((id, index) =>
      libraryQueueTrack(
        {
          id: `ncm:${id}`,
          source: 'ncm',
          filePath: '',
          title: `Online ${id}`,
          artist: 'Artist',
          album: 'Online',
          duration: 90,
          streamUrl: 'https://expired.example/private',
          accessToken: 'private-token',
          ncmSongId: id
        },
        `online:occurrence:${index}`
      )
    )
    const data: PlaybackSessionData<TrackData> = {
      version: 1,
      savedAt: '2026-11-03T00:00:00Z',
      mode: 'trackAndPosition',
      playMode: kind === 'heart' ? 'heart' : 'sequential',
      track: queue[2],
      position: 10,
      queue,
      queueIndex: 2
    }
    const originalEntryIds = queue.map((track) => track.queueEntryId!)
    const imported = await importLegacyQueue({
      api: {
        importLegacyPlaybackQueue: async (c) => db.importLegacyPlaybackQueue(c),
        readQueue: async (...args) => db.readLibraryQueue(...args)
      },
      session: data,
      sessionRevision: 99,
      libraryRevision: db.getMetadata().revision,
      originalEntryIds
    })
    const { queue: _queue, queueIndex: _index, ...saved } = data
    const persisted: PlaybackSessionData<TrackData> = {
      ...saved,
      libraryQueue: queueReference(imported.queue)
    }
    if (kind === 'personalized')
      persisted.personalizedStream = {
        queueId: imported.queue.id,
        providerId: 'ncm-provider',
        key: 'fm'
      }
    else
      persisted.heart = {
        queueId: imported.queue.id,
        likedPlaylistId: 123,
        ...(kind === 'heart' ? { baseQueue: queueReference(base) } : {})
      }
    if (kind === 'detached') {
      persisted.detachedHeartTrack = true
      persisted.track = libraryQueueTrack(
        {
          id: 'ncm:99',
          source: 'ncm',
          filePath: '',
          title: 'Detached recommendation',
          artist: 'Artist',
          album: '',
          duration: 90,
          ncmSongId: 99,
          streamUrl: 'https://expired.example/private'
        },
        'detached:occurrence'
      )
    }
    const repository = createCorePlaybackRepository(createPlaybackSessionStoreBundle(f.source), {
      syncLibraryQueueReferences: async (...args) => db.syncLibraryQueueReferences(...args)
    })
    await repository.save(persisted, baseSaved!.revision)
    const baseExport = db.exportPlaybackQueue(queueReference(base), 32 * 1024 * 1024, true)
    f.sessions[0] = {
      ...f.sessions[0],
      data: { ...data, track: persisted.track },
      originalEntryIds
    }
    return { persisted, base: baseExport }
  } finally {
    db.close()
  }
}
