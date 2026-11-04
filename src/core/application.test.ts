import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef } from 'vue'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreApplication, type CoreApplicationDependencies } from './application.ts'
import { CoreRemoteService } from './remote/service.ts'
import { CoreNcmListeningSync } from './listening/ncmSync.ts'
import { createDefaultSettings } from './settings/normalization.ts'
import { CoreStateDatabase } from '../main/library/coreStateDatabase.ts'
import { emptyCoreStateCounts, type CoreStateApi } from '../shared/coreState.ts'
import type {
  CoreClientIdentity,
  CoreClientMessage,
  CoreRequestEnvelope,
  CoreResponse,
  CoreSnapshot
} from '../shared/coreProtocol.ts'
import { coreOperation } from '../shared/coreProtocol.ts'
import { CoreDownloadsService } from './downloads/service.ts'
import { CoreMusicCacheService } from './cache/service.ts'
import { OpraCatalog } from './audio/opraCatalog.ts'
import { CoreCatalogService } from './catalog/service.ts'
import { CoreGenresService } from './library/genresService.ts'
import { CoreMusicRatingsService } from './library/ratingsService.ts'
import { CoreMusicPreferencesService } from './library/preferencesService.ts'
import { CoreMusicTagsService } from './library/tagsService.ts'
import { CoreMusicFocusService } from './library/focusService.ts'
import { CoreMusicExplorationService } from './library/explorationService.ts'
import type { CatalogDatabaseApi } from '../shared/musicCatalog.ts'
import { createMusicTagsView, observeMusicTagsView } from '../renderer/src/components/music-tags/musicTagsView.ts'
import { tagsFixture } from '../renderer/src/components/music-tags/musicTagsTest.fixture.ts'
import { createMusicFocusView, observeMusicFocusView } from '../renderer/src/components/music-focus/musicFocusView.ts'
import { focusFixture } from '../renderer/src/components/music-focus/musicFocusTest.fixture.ts'
import type { MusicExplorationDatabaseApi, MusicExplorationDetail, MusicExplorationPage, MusicExplorationReference, MusicExplorationRelationsPage } from '../shared/musicExploration.ts'
import type { MusicFocusDatabaseApi, MusicFocusQuery } from '../shared/musicFocus.ts'
import type { MusicTagsDatabaseApi, MusicTagsWriteResult } from '../shared/musicTags.ts'
import type { LibraryQueueSeedItem } from '../shared/libraryQueueBuild.ts'
import { CoreAlbumBrowseService } from './library/albumBrowseService.ts'
import { CoreUnifiedPlaybackService } from './catalog/unifiedPlayback.ts'
import { CoreCatalogPlaybackScope } from './catalog/playbackScope.ts'
import { LibraryDatabase } from '../main/library/libraryDatabase.ts'
import { emptyMusicVersions } from '../shared/musicVersions.ts'
import type { TrackData } from '../shared/track.ts'
import { CoreMetadataService } from './library/metadataService.ts'
import { CorePersonalBackupService } from './persistence/personalBackupService.ts'
import type { EntityMetadataDatabaseApi, EntityMetadataDetail, EntityMetadataJob } from '../shared/entityMetadata.ts'

function fixture(
  t: test.TestContext,
  migrated = true,
  downloads?: CoreDownloadsService,
  search?: CoreApplicationDependencies['search'],
  cache?: CoreApplicationDependencies['cache'],
  output?: CoreApplicationDependencies['output'],
  settings?: CoreApplicationDependencies['settings'],
  owners: Partial<CoreApplicationDependencies> = {}
) {
  const database = new CoreStateDatabase(':memory:'),
    calls: string[] = []
  if (migrated) {
    database.begin('previous-upgrade', { version: 1, counts: emptyCoreStateCounts() })
    database.commit('previous-upgrade')
  }
  const playback: CoreApplicationDependencies['playback'] = {
    queuePage: async () => ({ items: [], total: 0, revision: 0, libraryRevision: 0, offset: 0 }),
    assertIndependent: () => {},
    claimOutput: async () => {},
    releaseOutput: () => {},
    initialize: async () => {
      calls.push('playback.initialize')
    },
    snapshot: () => ({
      isStreamBuffering: false,
      loading: false,
      abLoop: { revision: 0, occurrenceId: null, a: null, b: null, mode: 'off' },
      mute: { muted: false, userVolume: 0.7, lastAudibleVolume: 0.7 },
      playback: null,
      track: null,
      queue: null,
      error: null,
      personalized: null,
      heart: null
    }),
    play: async () => {
      calls.push('play')
    },
    pause: async () => {
      calls.push('pause')
    },
    stop: async () => {
      calls.push('stop')
    },
    recoverAudio: async (restart) => restart(),
    seek: async () => {},
    navigate: async () => {},
    setVolume: async () => {},
    configureAbLoop: async () => ({
      revision: 0,
      occurrenceId: null,
      a: null,
      b: null,
      mode: 'off'
    }),
    configureMute: async () => {},
    control: async () => {},
    setMode: async () => {},
    select: async () => {},
    fromQuery: async () => {},
    fromPages: async () => {},
    fromTrack: async () => {},
    fromUnifiedTrack: async () => { throw new Error('No unified playback fixture') },
    restoreNamedSession: async () => ({ restored: 0, missing: [], deferred: 0 }),
    setRate: async () => {},
    startCast: async () => {
      calls.push('cast.start')
    },
    endCast: async () => {
      calls.push('cast.end')
    },
    observeCast: () => {},
    castFailed: () => {},
    maintainSources: async (action) => action([]),
    startPersonalized: async () => {},
    refillPersonalized: async () => 0,
    startLiked: async () => {},
    refillHeart: async () => 0,
    edit: async () => {},
    invalidateLibrary: () => {},
    refresh: async () => {},
    flush: async () => {
      calls.push('flush')
    },
    captureWorkspace: async () => {
      throw new Error('No fixture queue')
    },
    captureHandoff: async () => { throw new Error('No fixture queue') },
    receiveHandoff: async () => {},
    shutdown: async () => {
      calls.push('playback.shutdown')
    }
  }
  const scan: CoreApplicationDependencies['scan'] = {
    initialize: async () => {
      calls.push('scan.initialize')
    },
    activate: () => {
      calls.push('scan.activate')
    },
    snapshot: () => ({
      jobId: 'scan',
      phase: 'idle',
      state: 'failed',
      checkedFiles: 0,
      parsedFiles: 0,
      committedFiles: 0,
      failedFiles: 0,
      trackCount: 0,
      revision: 0,
      error: 'Scan failed for https://user:private@example.test/file?token=private'
    }),
    start: async () => scan.snapshot()!,
    pause: async () => true,
    resume: async () => scan.snapshot(),
    cancel: async () => true,
    enqueueDirectories: async () => {},
    startup: async () => {},
    poll: async () => undefined,
    shutdown: async () => {
      calls.push('scan.shutdown')
    }
  }
  const state: CoreStateApi = {
    coreStateOpen: async () => {},
    coreStateStatus: async () => database.status(),
    coreStateRead: async (...args) => database.read(...args),
    coreStateWrite: async (...args) => database.write(...args),
    coreMigrationBegin: async (...args) => database.begin(...args),
    coreMigrationStage: async (...args) => database.stage(...args),
    coreMigrationCommit: async (...args) => database.commit(...args),
    coreMigrationAbort: async (...args) => database.abort(...args)
  }
  const application = new CoreApplication({
    settings,
    output,
    cache,
    search,
    downloads,
    epoch: 'current',
    playback,
    scan,
    libraryBackground: {
      activate: () => {
        calls.push('libraryBackground.activate')
      },
      snapshot: () => ({ enabled: false, folders: [] }),
      shutdown: async () => {
        calls.push('libraryBackground.shutdown')
      }
    },
    state,
    statistics: {
      initialize: async () => {
        calls.push('statistics.initialize')
      },
      getRevision: () => 0,
      historySnapshot: () => new Map(),
      summary: () => ({
        revision: 0,
        trackCount: 0,
        days: {},
        persistence: { dirty: false, failureCount: 0, error: null }
      }),
      page: () => ({ revision: 0, total: 0, offset: 0, items: [] }),
      overview: async () => ({
        revision: 0,
        trackCount: 0,
        days: {},
        persistence: { dirty: false, failureCount: 0, error: null },
        recorded: { seconds: 0, plays: 0, trackCount: 0, formats: [] },
        artists: [],
        history: { mode: 'sqlite', ready: true, pending: false, revision: 0, error: '' }
      }),
      previewClear: (_range, revision) => ({
        revision,
        dayCount: 0,
        seconds: 0,
        trackCount: 0,
        hasUndatedTracks: false
      }),
      observe: () => {},
      clear: async () => {},
      flush: async () => {
        calls.push('statistics.flush')
      },
      shutdown: async () => {
        calls.push('statistics.shutdown')
      }
    },
    library: {
      queryCollections: async () => ({
        revision: 1,
        total: 0,
        offset: 0,
        items: [],
        letterOffsets: {}
      }),
      getTracksByIds: async () => ({ revision: 1, total: 0, offset: 0, tracks: [], versions: {} }),
      lookupTracksByPaths: async (paths) => ({ revision: 1, ids: paths.map(() => null) }),
      lookupPlaylistTracks: async ({ entries }) => ({ revision: 1, ids: entries.map(() => null) }),
      getMetadata: async () => ({
        revision: 1,
        trackCount: 1,
        fileCount: 1,
        folders: [],
        exclusions: []
      }),
      queryTracks: async () => ({
        revision: 1,
        total: 1,
        offset: 0,
        versions: { local: 1 },
        tracks: [
          {
            id: 'local',
            filePath: 'https://private:private@host.test/private?token=private',
            title: 'Track',
            credentials: 'private',
            streamUrl: 'private'
          }
        ]
      }),
      readLibraryQueue: async () => ({
        revision: 1,
        libraryRevision: 1,
        total: 1,
        offset: 0,
        items: [
          {
            position: 0,
            queueEntryId: 'occurrence',
            track: { id: 'local', filePath: 'private', title: 'Track', credentials: 'private' }
          }
        ]
      })
    },
    ready: () => calls.push('ready'),
    ...owners
  })
  const messages = new Map<string, CoreClientMessage[]>(),
    identities = new Map<string, CoreClientIdentity>()
  function connect(
    id: string,
    permissions: CoreClientIdentity['permissions'] = [
      'playback:read',
      'playback:write',
      'library:read',
      'library:write',
      'migration:write',
      'statistics:read',
      'statistics:write'
    ],
    role: CoreClientIdentity['role'] = 'desktop'
  ) {
    const identity: CoreClientIdentity = { id, role, permissions }
    identities.set(id, identity)
    messages.set(id, [])
    application.connect(identity, (message) => messages.get(id)!.push(message))
    return identity
  }
  let serial = 0
  async function request(
    id: string,
    name: string,
    payload = {},
    extra: Partial<CoreRequestEnvelope> = {}
  ): Promise<CoreResponse> {
    const requestId = extra.requestId ?? `request:${++serial}`
    await application.request(id, {
      kind: coreOperation(name)?.kind ?? 'command',
      name,
      payload,
      epoch: 'current',
      requestId,
      ...extra
    } as CoreRequestEnvelope)
    return messages
      .get(id)!
      .findLast(
        (message) => message.kind === 'response' && message.requestId === requestId
      ) as CoreResponse
  }
  t.after(async () => {
    await application.shutdown()
    database.close()
  })
  return { application, playback, scan, calls, messages, connect, request }
}

test('catalog-source playlist append resolves trusted identities in one revision, preserves duplicates and never commits missing or stale selections', async t => {
  const source = { id: 'D:/trusted/song.flac', filePath: 'D:/trusted/song.flac', title: 'Song', artist: 'Artist', album: 'Album', duration: 10, source: 'local' } as TrackData
  let catalogRevision = 7, missing = false
  const edits: unknown[] = [], resolves: string[] = []
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, {
    catalog: { activate() {}, shutdown: async () => {}, getRevision: () => catalogRevision, resolve: async (id: string, revision: number) => {
      resolves.push(id)
      if (revision !== 7) throw Object.assign(new Error('stale catalog'), { code: 'STALE_REVISION' })
      return missing ? null : source
    }, status: async () => ({ revision: catalogRevision }) } as unknown as CoreApplicationDependencies['catalog'],
    playlists: { waitForPending: async () => {}, initialize: async () => {}, getRevision: () => 2,
      edit: async (...args: unknown[]) => { edits.push(args.slice(0, 2)); return { revision: 3 } }, shutdown: async () => {}, flush: async () => {} } as unknown as CoreApplicationDependencies['playlists']
  })
  f.connect('phone', ['library:read', 'library:write'], 'remote')
  f.connect('read-only', ['library:read'], 'remote')
  f.connect('write-only', ['library:write'], 'remote')
  await f.application.initialize()
  const input = { id: 'playlist', revision: 2, catalogRevision: 7, sourceIds: ['source-a', 'source-a'] }
  assert.equal((await f.request('phone', 'playlists.addSources', input)).ok, true)
  assert.deepEqual(resolves, ['source-a', 'source-a'])
  assert.deepEqual(edits, [[2, { kind: 'add', id: 'playlist', tracks: [source, source] }]])
  for (const id of ['read-only', 'write-only']) assert.equal((await f.request(id, 'playlists.addSources', input)).ok, false)
  missing = true
  assert.equal((await f.request('phone', 'playlists.addSources', input)).ok, false)
  missing = false; catalogRevision = 8
  assert.equal((await f.request('phone', 'playlists.addSources', input)).ok, false)
  assert.equal((await f.request('phone', 'playlists.addSources', { ...input, filePath: 'D:/injected' })).ok, false)
  assert.equal(edits.length, 1)
})

test('shared group dispatch requires playback permissions and library reads before replacing a common queue', async t => {
  const groupId = 'group-11111111-1111-4111-8111-111111111111', zoneId = 'zone-22222222-2222-4222-8222-222222222222'
  const calls: string[] = []
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, { zones: {
    initialize: async () => {}, shutdown: async () => {},
    listGroups: async () => ({ revision: 0, error: null, groups: [] }),
    createGroup: async () => { calls.push('create'); return groupId },
    removeGroup: async () => { calls.push('remove') },
    groupTransport: async (_id: string, revision: number | null) => { calls.push(`transport:${revision}`) },
    groupFromQuery: async () => { calls.push('query') },
    groupSignalPath: async () => ({ zoneId })
  } as unknown as NonNullable<CoreApplicationDependencies['zones']> })
  await f.application.initialize()
  f.connect('reader', ['playback:read']); f.connect('controller', ['playback:read', 'playback:write'])
  f.connect('library', ['playback:read', 'playback:write', 'library:read'])
  assert.equal((await f.request('reader', 'groups.list')).ok, true)
  const payload = { revision: 0, name: 'Music', members: [{ zoneId: 'local', revision: 0, downstreamDelayMs: 0 },
    { zoneId, revision: 0, downstreamDelayMs: 3 }], source: { zoneId, queue: { id: 'queue', revision: 1, occurrenceId: 'a:2' } } }
  assert.equal((await f.request('reader', 'groups.create', payload)).ok, false)
  const created = await f.request('controller', 'groups.create', payload)
  assert.equal(created.ok, true); assert.deepEqual(created.ok && created.value, { id: groupId })
  assert.equal((await f.request('controller', 'groups.queueFromQuery', { groupId, revision: 0, query: {} })).ok, false)
  assert.equal((await f.request('library', 'groups.queueFromQuery', { groupId, revision: 0, query: {} })).ok, true)
  assert.equal((await f.request('controller', 'groups.transport', { groupId, revision: null, action: { kind: 'pause' } })).ok, true)
  assert.equal((await f.request('controller', 'groups.remove', { groupId, revision: 0 })).ok, true)
  assert.deepEqual(calls, ['create', 'query', 'transport:null', 'remove'])
})

test('only a trusted local desktop or server administrator can consent to Bridge and Zone provisioning', async t => {
  const calls: string[] = []
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, {
    bridge: { invite: async () => { calls.push('invite'); return {invitation:null} }, shutdown: async () => {} } as unknown as NonNullable<CoreApplicationDependencies['bridge']>,
    zones: { initialize: async () => {}, shutdown: async () => {}, create: async () => { calls.push('create'); return 'zone-id' } } as unknown as NonNullable<CoreApplicationDependencies['zones']>
  })
  await f.application.initialize()
  for (const role of ['desktop','server-admin','remote','system','plugin','mini-player'] as const) {
    f.connect(role, ['playback:read','playback:write','settings:read','settings:write'], role)
    for (const [name,payload] of [['bridge.invitation',{}],['zones.create',{revision:0,name:'Study'}]] as const) {
      const result = await f.request(role,name,payload)
      assert.equal(result.ok,role === 'desktop' || role === 'server-admin')
      if (!result.ok) assert.equal(result.error.code,'FORBIDDEN')
    }
  }
  f.connect('read-only-admin',['playback:read'],'server-admin')
  assert.equal((await f.request('read-only-admin','zones.create',{revision:0,name:'Study'})).ok,false)
  assert.deepEqual(calls,['invite','create','invite','create'])
})

test('Android bridge selection and controls use the real Core permission and query boundary', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'D:/private/track.flac',
        source: 'local',
        filePath: 'D:/private/track.flac',
        title: 'Desktop song',
        artist: 'Artist',
        album: 'Album',
        duration: 120,
        fileName: 'track.flac',
        size: 1,
        cover: null,
        lyrics: null
      }
    ]
  })
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, {
    library: {
      queryTracks: async (query) => db.queryTracks(query),
      queryCollections: async (...args) => db.queryCollections(...args),
      getTracksByIds: async (...args) => db.getTracksByIds(...args),
      lookupTracksByPaths: async (...args) => db.lookupTracksByPaths(...args),
      lookupPlaylistTracks: async (...args) => db.lookupPlaylistTracks(...args),
      getMetadata: async () => db.getMetadata(),
      readLibraryQueue: async (...args) => db.readLibraryQueue(...args)
    }
  })
  const rows: LibraryQueueSeedItem[] = []
  f.playback.fromPages = async (produce, options) => {
    await produce(async (items) => {
      rows.push(...items)
    })
    options?.guard?.()
  }
  const remoteSettings = createDefaultSettings('win32')
  const remote = new CoreRemoteService({
    server: {
      setCommandHandler() {},
      setBrowseHandler() {},
      setCoreRpcHandler() {},
      updatePlaybackSnapshot() {},
      updateCoreStateEvent() {},
      stop: async () => {}
    } as never,
    settings: {
      read: () => remoteSettings,
      update: (patch) => Object.assign(remoteSettings, patch)
    },
    playback: f.playback,
    playlistRecords: async () => {
      throw new Error('Not used')
    },
    castActive: () => false,
    resolveCover: async () => null,
    failed: () => {},
    now: () => 0
  })
  remote.attach(f.application)
  t.after(() => remote.shutdown())
  await f.application.initialize()
  const envelope = (requestId: string, kind: string, name: string, payload = {}) => ({
    protocolVersion: 1,
    requestId,
    epoch: 'current',
    kind,
    name,
    payload
  })
  const found = await remote.handleCoreRpc(
    envelope('search', 'query', 'search.songs', { query: 'Desktop' })
  )
  assert.equal(found.ok, true)
  const view = (found.value as { items: Array<{ id: string }> }).items[0]
  assert.match(view.id, /^remote-track:/)
  assert.doesNotMatch(JSON.stringify(found), /D:|private|filePath/)
  const selected = await remote.handleCoreRpc({
    ...envelope('select', 'command', 'playback.replaceQueue', {
      id: 'default',
      expectedRevision: 0,
      tracks: [view, view],
      startIndex: 1,
      play: false
    }),
    commandId: 'one-selection',
    expectedRevision: 0
  })
  assert.equal(selected.ok, true)
  assert.deepEqual(rows, [{ id: 'D:/private/track.flac' }, { id: 'D:/private/track.flac' }])
  assert.equal((await remote.handleCoreRpc(envelope('play', 'command', 'playback.play'))).ok, true)
  assert.ok(f.calls.includes('play'))
  assert.equal(
    (
      await remote.handleCoreRpc(
        envelope('volume', 'command', 'playback.setVolume', { volume: 0.5 })
      )
    ).ok,
    true
  )
  assert.equal(
    (
      await remote.handleCoreRpc(
        envelope('mode', 'command', 'playback.setPlayMode', { mode: 'loop' })
      )
    ).ok,
    true
  )
  const forbidden = await remote.handleCoreRpc(
    envelope('internal', 'query', 'library.paths.lookup', { paths: ['D:/private/track.flac'] })
  )
  assert.equal((forbidden.error as { code: string }).code, 'FORBIDDEN')
})

test('Core Focus keeps offline saved queries and library playback independent of provider authority', async t => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const local: TrackData = { id: 'local', source: 'local', title: 'Local', artist: 'Artist', album: 'Album',
    duration: 200, filePath: 'D:/music/local.flac', fileName: 'local.flac', size: 0, cover: null, lyrics: null }
  const remote: TrackData = { ...local, id: 'ncm:1', source: 'ncm', ncmSongId: 1, title: 'Remote', filePath: '', fileName: '' }
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [local] })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const begin = db.catalogSync({ kind: 'begin', revision: 1 })
  const appended = db.catalogSync({ kind: 'append', id: begin.id, sequence: begin.sequence, tracks: [remote] })
  db.catalogSync({ kind: 'commit', id: begin.id, sequence: appended.sequence })
  const database: MusicFocusDatabaseApi = {
    focusState: async () => db.focusState(), focusQuery: async (...a) => db.focusQuery(...a),
    focusFacets: async (...a) => db.focusFacets(...a), focusPlaybackPage: async (...a) => db.focusPlaybackPage(...a),
    focusSavedList: async q => db.focusSavedList(q), focusSavedCreate: async (...a) => db.focusSavedCreate(...a),
    focusSavedRename: async (...a) => db.focusSavedRename(...a), focusSavedUpdate: async (...a) => db.focusSavedUpdate(...a),
    focusSavedDelete: async q => db.focusSavedDelete(q)
  }
  let adopted: LibraryQueueSeedItem[] = [], providers = 0, historyChecks = 0
  const focus = new CoreMusicFocusService({ database, now: () => 1000, platformContexts: () => ({}),
    ensureHistory: async () => { historyChecks++ }, changed() {}, playback: {
      async fromPages(produce, options = {}, signal) {
        const staged: LibraryQueueSeedItem[] = []
        await produce(async items => { staged.push(...items) })
        await options.beforeAdopt?.(true)
        options.guard?.(); signal?.throwIfAborted(); adopted = staged; options.onAdopt?.()
      }
    } })
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, { focus,
    resolvePlaylistInputs: async inputs => { providers++; return inputs.map(() => remote) } })
  await f.application.initialize()
  f.connect('reader', ['library:read']); f.connect('writer', ['library:write'])
  f.connect('player', ['playback:write']); f.connect('local', ['library:read', 'playback:write'])
  f.connect('provider', ['library:read', 'playback:read', 'playback:write', 'providers:call'])
  const query: MusicFocusQuery = { version: 1, entity: 'recording', where: { source: { provider: 'local' } } }
  assert.equal((await f.request('reader', 'focus.saved.create', { name: 'Local', query, savedRevision: 0 })).ok, false)
  assert.equal((await f.request('writer', 'focus.saved.create', { name: 'Local', query, savedRevision: 0 })).ok, true)
  assert.equal((await f.request('reader', 'focus.saved.list')).ok, true)
  assert.equal((await f.request('writer', 'focus.query', { query })).ok, false)
  const page = await focus.query({ query })
  assert.equal((await f.request('reader', 'focus.query', { query, token: page.token })).ok, true)
  assert.equal((await f.request('reader', 'focus.facets', { query, token: page.token, facet: 'provider' })).ok, true)
  assert.equal(JSON.stringify(page).includes('D:/music'), false)
  assert.equal((await f.request('player', 'focus.play', { query, token: page.token })).ok, false)
  assert.equal((await f.request('local', 'focus.play', { query, token: page.token })).ok, true)
  assert.equal(adopted.length, 1); assert.equal(providers, 0); assert.ok(historyChecks > 0)
  const localQueue = adopted
  const remoteQuery: MusicFocusQuery = { ...query, where: { source: { provider: 'ncm' } } }
  const remotePage = await focus.query({ query: remoteQuery })
  assert.equal((await f.request('local', 'focus.play', { query: remoteQuery, token: remotePage.token })).ok, false)
  assert.equal(adopted, localQueue); assert.equal(providers, 0)
  const play = { query: remoteQuery, token: remotePage.token }
  assert.equal((await f.request('provider', 'focus.play', play, { requestId: 'once' })).ok, true)
  const frozen = adopted
  const duplicate = await f.request('provider', 'focus.play', play, { requestId: 'once' })
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) assert.equal(duplicate.error.code, 'OUTCOME_UNKNOWN')
  assert.equal(providers, 1); assert.equal(adopted, frozen)
  assert.equal((await f.request('reader', 'focus.play.status', { requestId: 'once', epoch: 'current' })).ok, false)
  const receipt = await f.request('provider', 'focus.play.status', { requestId: 'once', epoch: 'current' })
  assert.equal(receipt.ok, true)
  if (receipt.ok) assert.deepEqual(receipt.value, { status: 'committed', result: { total: 1, selectedIndex: 0 }, playback: 'confirmed' })
  f.connect('receipt', ['library:read', 'playback:read'])
  const unknown = await f.request('receipt', 'focus.play.status', { requestId: 'once', epoch: 'current' })
  assert.equal(unknown.ok, true)
  if (unknown.ok) assert.deepEqual(unknown.value, { status: 'unknown' })
  assert.equal(f.application.snapshot({ id: 'blind', role: 'plugin', permissions: [] }).focusRevision, null)
  assert.equal(f.application.snapshot({ id: 'reader', role: 'plugin', permissions: ['library:read'] }).focusRevision, db.focusState().savedRevision)
})

test('Core tags keep local management offline and require library plus playback and provider authority only where used', async t => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const local: TrackData = { id: 'local', source: 'local', title: 'Local', artist: 'Artist', album: 'Album',
    duration: 200, filePath: 'D:/music/local.flac', fileName: 'local.flac', size: 0, cover: null, lyrics: null }
  const remote: TrackData = { ...local, id: 'ncm:1', source: 'ncm', ncmSongId: 1, title: 'Remote', filePath: '', fileName: '' }
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [local] })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const sync = db.catalogSync({ kind: 'begin', revision: 1 })
  const appended = db.catalogSync({ kind: 'append', id: sync.id, sequence: sync.sequence, tracks: [remote] })
  db.catalogSync({ kind: 'commit', id: sync.id, sequence: appended.sequence })
  const localId = String(db.sql.prepare("SELECT recording_id FROM catalog_sources WHERE provider='local'").get()!.recording_id)
  const remoteId = String(db.sql.prepare("SELECT recording_id FROM catalog_sources WHERE provider='ncm'").get()!.recording_id)
  const database: MusicTagsDatabaseApi = {
    tagsState: async () => db.tagsState(), tagsList: async q => db.tagsList(q), tagsEntity: async q => db.tagsEntity(q),
    tagsMembers: async q => db.tagsMembers(q), tagsRecordings: async q => db.tagsRecordings(q),
    tagsCreate: async (...args) => db.tagsCreate(...args), tagsRename: async (...args) => db.tagsRename(...args),
    tagsDelete: async q => db.tagsDelete(q), tagsMemberSet: async (...args) => db.tagsMemberSet(...args),
    tagsPlaybackPage: async q => db.tagsPlaybackPage(q)
  }
  let adopted: LibraryQueueSeedItem[] = [], providerCalls = 0
  const tags = new CoreMusicTagsService({ database, now: () => 1234, changed() {}, playback: {
    async fromPages(produce, options = {}, signal) {
      const staged: LibraryQueueSeedItem[] = []
      await produce(async items => { staged.push(...items) })
      await options.beforeAdopt?.(true)
      options.guard?.(); signal?.throwIfAborted()
      adopted = staged
    }
  } })
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, {
    tags, resolvePlaylistInputs: async (_inputs, signal) => { signal.throwIfAborted(); providerCalls++; return [remote] }
  })
  await f.application.initialize()
  f.connect('reader', ['library:read'])
  f.connect('writer', ['library:write'])
  f.connect('player', ['playback:write'])
  f.connect('local-player', ['library:read', 'playback:write'])
  f.connect('stream-player', ['library:read', 'playback:write', 'providers:call'])
  assert.equal((await f.request('reader', 'tags.create', { name: 'Night', tagsRevision: 0 })).ok, false)
  const created = await f.request('writer', 'tags.create', { name: 'Night', tagsRevision: 0 })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const tag = (created.value as MusicTagsWriteResult).tag
  assert.equal((await f.request('writer', 'tags.list')).ok, false)
  assert.equal((await f.request('reader', 'tags.list')).ok, true)
  assert.equal((await f.request('writer', 'tags.member.set', { tagId: tag.id, entityId: localId, present: true, membersRevision: 0 })).ok, true)
  const token = db.tagsState()
  assert.equal((await f.request('reader', 'tags.members', { tagId: tag.id, token })).ok, true)
  assert.equal((await f.request('reader', 'tags.entity', { entityId: localId, token })).ok, true)
  const recordings = await f.request('reader', 'tags.recordings', { tagId: tag.id, token })
  assert.equal(recordings.ok, true)
  assert.equal(JSON.stringify(recordings).includes('D:/music'), false)
  assert.equal((await f.request('player', 'tags.play', { tagId: tag.id, token })).ok, false)
  assert.equal((await f.request('local-player', 'tags.play', { tagId: tag.id, token })).ok, true)
  assert.equal(providerCalls, 0); assert.equal(adopted.length, 1)
  const localQueue = adopted
  const { tag: remoteTag } = db.tagsCreate({ name: 'Streaming', tagsRevision: db.tagsState().tagsRevision }, 1235)
  db.tagsMemberSet({ tagId: remoteTag.id, entityId: remoteId, present: true, membersRevision: 0 }, 1236)
  const remoteRequest = { tagId: remoteTag.id, token: db.tagsState() }
  assert.equal((await f.request('local-player', 'tags.play', remoteRequest)).ok, false)
  assert.equal(adopted, localQueue); assert.equal(providerCalls, 0)
  assert.equal((await f.request('stream-player', 'tags.play', remoteRequest)).ok, true)
  assert.equal(providerCalls, 1); assert.equal(adopted[0].snapshot?.source, 'ncm')
  assert.equal(f.application.snapshot({ id: 'reader', role: 'plugin', permissions: ['library:read'] }).tagsRevision, db.tagsState().tagsRevision)
  const hidden = f.application.snapshot({ id: 'blind', role: 'plugin', permissions: [] })
  assert.equal(hidden.tagsRevision, null); assert.equal(hidden.tagsLinkRevision, null)
})

test('Core playlist reads wait for a published preference refresh before returning cached members', async t => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let reads = 0
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, {
    playlists: {
      getRevision: () => 4,
      initialize: async () => {},
      shutdown: async () => {},
      waitForPending: () => pending,
      list: () => { reads++; return { revision: 4, offset: 0, total: 0, items: [] } }
    } as unknown as CoreApplicationDependencies['playlists']
  })
  await f.application.initialize()
  f.connect('reader', ['library:read'])
  const request = f.request('reader', 'playlists.list', { offset: 0, limit: 20 })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(reads, 0)
  release()
  assert.equal((await request).ok, true)
  assert.equal(reads, 1)
})

test('Core preferences keep local bans independent from provider access and scope revisions to library readers', async t => {
  const db = new LibraryDatabase(':memory:')
  db.sql.exec("INSERT INTO catalog_entities VALUES('song','recording','Song','','source'),('album','release','Album','','source'),('project','album_project','Project','','source'),('artist','artist','Artist','','source')")
  const preferences = new CoreMusicPreferencesService({
    database: {
      preferencesDetail: async id => db.preferencesDetail(id),
      preferencesTargets: async query => db.preferencesTargets(query),
      preferencesSet: async (...args) => db.preferencesSet(...args),
      preferencesHistory: async query => db.preferencesHistory(query),
      preferencesAutomaticEligibility: async tracks => db.preferencesAutomaticEligibility(tracks),
      preferencesTrackStates: async tracks => db.preferencesTrackStates(tracks),
      preferencesPlaylistsLoad: async () => db.preferencesPlaylistsLoad(),
      preferencesPlaylistsMigrate: async (...args) => db.preferencesPlaylistsMigrate(...args),
      preferencesPlaylistsMigrationReceipt: async () => db.preferencesPlaylistsMigrationReceipt(),
      preferencesPlaylistsSave: async (...args) => db.preferencesPlaylistsSave(...args),
      preferencesPlaylistsRestore: async (...args) => db.preferencesPlaylistsRestore(...args)
    }, now: () => 1234, changed() {}
  })
  t.after(() => db.close())
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, { preferences })
  await f.application.initialize()
  f.connect('reader', ['library:read'])
  f.connect('writer', ['library:write'])
  f.connect('blind', ['playback:read', 'providers:call'])
  assert.equal((await f.request('blind', 'preferences.detail', { entityId: 'song' })).ok, false)
  assert.equal((await f.request('blind', 'preferences.targets', { entityId: 'song' })).ok, false)
  const targets = await f.request('reader', 'preferences.targets', { entityId: 'song' })
  assert.equal(targets.ok, true)
  if (targets.ok) assert.deepEqual((targets.value as import('../shared/musicPreferences.ts').MusicPreferencesTargetsPage).items.map(item => item.id), ['song'])
  assert.equal((await f.request('writer', 'preferences.history', { entityId: 'song' })).ok, false)
  const read = await f.request('reader', 'preferences.detail', { entityId: 'song' })
  assert.equal(read.ok, true)
  if (!read.ok) return
  const detail = read.value as import('../shared/musicPreferences.ts').MusicPreferencesDetail
  const set = { entityId: 'song', token: detail.token, state: 'ban' }
  assert.equal((await f.request('reader', 'preferences.set', set)).ok, false)
  assert.equal((await f.request('writer', 'preferences.set', set)).ok, true)
  assert.equal(db.preferencesDetail('song').value?.state, 'ban')
  assert.equal(db.preferencesDetail('song').value?.updatedAt, 1234)
  assert.equal(db.preferencesDetail('album').value, null)
  assert.equal((await f.request('writer', 'preferences.set', set)).ok, false)
  const invalid = await f.request('writer', 'preferences.set', { ...set, state: 'like' })
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.equal(invalid.error.code, 'INVALID_REQUEST')
  assert.equal((await f.request('reader', 'preferences.detail', { entityId: 'project' })).ok, false)
  assert.equal((await f.request('reader', 'preferences.detail', { entityId: 'artist' })).ok, false)
  assert.equal((await f.request('reader', 'preferences.history', { entityId: 'song' })).ok, true)
  assert.equal(f.application.snapshot({ id: 'reader', role: 'plugin', permissions: ['library:read'] }).preferencesRevision, db.getPreferencesRevision())
  assert.equal(f.application.snapshot({ id: 'blind', role: 'plugin', permissions: [] }).preferencesRevision, null)
})

test('Core ratings keep local writes independent from provider access and scope revisions to library readers', async t => {
  const db = new LibraryDatabase(':memory:')
  db.sql.exec("INSERT INTO catalog_entities VALUES('song','recording','Song','','source'),('album','release','Album','','source'),('project','album_project','Project','','source')")
  const ratings = new CoreMusicRatingsService({
    database: {
      ratingsDetail: async id => db.ratingsDetail(id),
      ratingsTargets: async query => db.ratingsTargets(query),
      ratingsSet: async (...args) => db.ratingsSet(...args),
      ratingsHistory: async query => db.ratingsHistory(query)
    }, now: () => 1234, changed() {}
  })
  t.after(() => db.close())
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, { ratings })
  await f.application.initialize()
  f.connect('reader', ['library:read'])
  f.connect('writer', ['library:write'])
  f.connect('blind', ['playback:read', 'providers:call'])
  assert.equal((await f.request('blind', 'ratings.detail', { entityId: 'song' })).ok, false)
  assert.equal((await f.request('blind', 'ratings.targets', { entityId: 'song' })).ok, false)
  const targets = await f.request('reader', 'ratings.targets', { entityId: 'song' })
  assert.equal(targets.ok, true)
  if (targets.ok) assert.deepEqual((targets.value as import('../shared/musicRatings.ts').MusicRatingsTargetsPage).items.map(item => item.id), ['song'])
  assert.equal((await f.request('writer', 'ratings.history', { entityId: 'song' })).ok, false)
  const read = await f.request('reader', 'ratings.detail', { entityId: 'song' })
  assert.equal(read.ok, true)
  if (!read.ok) return
  const detail = read.value as import('../shared/musicRatings.ts').MusicRatingsDetail
  assert.deepEqual(detail.external, { status: 'unavailable', reason: 'no_approved_source', items: [] })
  const set = { entityId: 'song', token: detail.token, steps: 9 }
  assert.equal((await f.request('reader', 'ratings.set', set)).ok, false)
  const saved = await f.request('writer', 'ratings.set', set)
  assert.equal(saved.ok, true)
  assert.equal(db.ratingsDetail('song').value?.steps, 9)
  assert.equal(db.ratingsDetail('song').value?.updatedAt, 1234)
  assert.equal(db.ratingsDetail('album').value, null)
  assert.equal((await f.request('writer', 'ratings.set', set)).ok, false)
  const invalid = await f.request('writer', 'ratings.set', { ...set, steps: 0 })
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.equal(invalid.error.code, 'INVALID_REQUEST')
  assert.equal((await f.request('reader', 'ratings.detail', { entityId: 'project' })).ok, false)
  assert.equal((await f.request('reader', 'ratings.history', { entityId: 'song' })).ok, true)
  assert.equal(f.application.snapshot({ id: 'reader', role: 'plugin', permissions: ['library:read'] }).ratingsRevision, db.getRatingsRevision())
  assert.equal(f.application.snapshot({ id: 'blind', role: 'plugin', permissions: [] }).ratingsRevision, null)
})

test('Core classification is permission-scoped and edits use current database revisions', async t => {
  const db = new LibraryDatabase(':memory:')
  const genres = new CoreGenresService({
    database: {
      genresBrowse: async (...args) => db.genresBrowse(...args),
      genresMembers: async (...args) => db.genresMembers(...args),
      genresFacets: async (...args) => db.genresFacets(...args),
      genresTree: async query => db.genresTree(query),
      genresUnmapped: async query => db.genresUnmapped(query),
      genresEvidence: async query => db.genresEvidence(query),
      genresEdit: async input => db.genresEdit(input),
      genresMap: async input => db.genresMap(input),
      genresOverride: async input => db.genresOverride(input),
      genresAdvance: async (...args) => db.genresAdvance(...args)
    }, separators: () => ';', changed() {}, failed: error => assert.fail(String(error))
  })
  t.after(() => db.close())
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, { genres })
  await f.application.initialize()
  f.connect('reader', ['library:read'])
  f.connect('writer', ['library:read', 'library:write'])
  f.connect('blind', [])
  assert.equal((await f.request('blind', 'genres.browse', { kind: 'recording' })).ok, false)
  const browse = await f.request('reader', 'genres.browse', { kind: 'recording', limit: 20 })
  assert.ok(browse.ok)
  const token = (browse.value as import('../shared/musicGenreBrowse.ts').GenreBrowsePage).token
  assert.equal((await f.request('reader', 'genres.members', { entityId: 'absent', token })).ok, true)
  const facets = await f.request('reader', 'genres.facets', { kind: 'recording', dimension: 'format', token })
  assert.ok(facets.ok)
  assert.equal((await f.request('reader', 'genres.browse', { kind: 'recording', platformContexts: { ncm: 'injected' } })).ok, false)
  assert.equal((await f.request('reader', 'genres.facets', { kind: 'recording', dimension: 'rating' })).ok, false)
  const page = await f.request('reader', 'genres.tree')
  assert.ok(page.ok)
  const revision = (page.value as { revision: number }).revision
  const edit = { action: 'create', revision, name: '实验', nameEn: 'Experimental' }
  assert.equal((await f.request('reader', 'genres.edit', edit)).ok, false)
  assert.equal((await f.request('writer', 'genres.edit', edit)).ok, true)
  assert.equal((await f.request('writer', 'genres.edit', edit)).ok, false)
  assert.equal(f.application.snapshot({ id: 'blind', role: 'plugin', permissions: [] }).genresRevision, null)
  genres.observeMetadata(7)
  assert.equal(f.application.snapshot().classificationMetadataRevision, 7)
  assert.equal(f.application.snapshot({ id: 'blind', role: 'plugin', permissions: [] }).classificationMetadataRevision, null)
  assert.ok(f.application.snapshot().genresRevision! > revision)
  await genres.shutdown()
})

test('Core album browse and unified play keep library, playback and per-candidate provider authorization separate', async t => {
  const db = new LibraryDatabase(':memory:')
  const local: TrackData = { id: 'local', source: 'local', filePath: 'D:/music/one.flac', fileName: 'one.flac',
    title: 'One', artist: 'Artist', album: 'Album', duration: 10, size: 1, cover: null, lyrics: null }
  db.replaceDocument({ version: 2, revision: 0, tracks: [local], folders: [], exclusions: [] })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const remote: TrackData = { ...local, id: 'ncm:7', source: 'ncm', ncmSongId: 7, albumId: '77', filePath: '' }
  let job = db.catalogSync({ kind: 'begin', revision: 0 })
  job = db.catalogSync({ kind: 'append', ...job, tracks: [remote] })
  db.catalogSync({ kind: 'commit', ...job })
  const context = { platformContexts: {} }
  const scopes = new CoreCatalogPlaybackScope({ database: {
    genresContainsSources: async (...args) => db.genresContainsSources(...args),
    albumsContainsSource: async (...args) => db.albumsContainsSource(...args)
  }, platformContexts: () => ({}) })
  const chosen: TrackData[] = []
  const unified = new CoreUnifiedPlaybackService({ database: { catalogPlaybackSources: async query => db.catalogPlaybackSources(query) },
    versions: { snapshot: emptyMusicVersions, getRevision: () => 0 },
    playback: { fromUnifiedTrack: async (select, signal, beforeAdopt) => {
      const selected = await select(signal ?? new AbortController().signal, async track => ({ track, resolved: { source: track.filePath || 'https://example.test/audio', expiresAt: null } }))
      if (selected.prepared) { await beforeAdopt?.(); chosen.push(selected.prepared.track) }
      return selected.result
    } }, restore: async () => { assert.fail('Global restorer must not replace request authorization') },
    assertScope: (request, ids, signal) => scopes.allowed(request, ids, signal)
  })
  const albums = new CoreAlbumBrowseService({ database: {
    albumsBrowse: async (...args) => db.albumsBrowse(...args), albumsSources: async (...args) => db.albumsSources(...args),
    albumsContainsSource: async (...args) => db.albumsContainsSource(...args)
  }, platformContexts: () => context.platformContexts, observeMetadata() {} })
  let providerCalls = 0
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, { unifiedPlayback: unified, albums,
    resolvePlaylistInputs: async () => { providerCalls++; return [remote] } })
  t.after(() => db.close())
  f.connect('reader', ['library:read'])
  f.connect('local-player', ['library:read', 'playback:write'])
  f.connect('remote-player', ['library:read', 'playback:write', 'providers:call'])
  f.connect('blind', ['playback:write'])
  await f.application.initialize()
  const release = db.catalogQuery({ kind: 'release', source: 'local' }).items[0]
  const reply = await f.request('reader', 'albums.browse', { entityId: release.id, limit: 1 })
  assert.ok(reply.ok)
  const page = reply.value as import('../shared/musicAlbumBrowse.ts').AlbumBrowsePage
  const albumScope = { entityId: release.id, releaseId: page.currentRelease!.id, token: page.token }
  const sources = db.albumsSources(albumScope)
  const localId = sources.items[0].sourceId
  const remoteEntity = db.catalogQuery({ kind: 'recording', source: 'ncm' }).items[0]
  const remoteId = db.catalogSources({ entityId: remoteEntity.id }).items[0].id
  const revision = db.catalogStatus().revision
  assert.equal((await f.request('blind', 'albums.browse', { entityId: release.id })).ok, false)
  assert.equal((await f.request('reader', 'albums.sources', albumScope)).ok, true)
  assert.equal((await f.request('reader', 'catalog.playUnified', { sourceId: localId, revision })).ok, false)
  assert.equal((await f.request('blind', 'catalog.playUnified', { sourceId: localId, revision })).ok, false)
  assert.equal((await f.request('local-player', 'catalog.playUnified', { sourceId: localId, revision, albumScope })).ok, true)
  assert.equal(chosen.length, 1)
  assert.equal(providerCalls, 0)
  const denied = await f.request('local-player', 'catalog.playUnified', { sourceId: remoteId, revision })
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.equal(denied.error.code, 'FORBIDDEN')
  assert.equal(providerCalls, 0)
  assert.equal((await f.request('remote-player', 'catalog.playUnified', { sourceId: remoteId, revision })).ok, true)
  assert.equal(providerCalls, 1)
  assert.equal(chosen[1].sourceSelection, 'explicit')
  assert.equal((await f.request('remote-player', 'catalog.playUnified', { sourceId: remoteId, revision, albumScope })).ok, false)
  assert.equal((await f.request('reader', 'albums.browse', { entityId: release.id, platformContexts: { fixture: 'injected' } })).ok, false)
})

test('Core owns catalog readiness, permissions and explicit source playback through the existing resolver', async t => {
  const db = new LibraryDatabase(':memory:')
  const local: TrackData = { id: 'cue:1', source: 'local', title: 'Local', artist: 'Artist', album: 'Album',
    filePath: 'D:/music/disc.flac', fileName: 'disc.flac', duration: 60, size: 0, cover: null, lyrics: null,
    cueRange: { startSeconds: 10, endSeconds: 70, pregapSeconds: 0 } }
  db.replaceDocument({ version: 2, revision: 0, tracks: [local], folders: [], exclusions: [] })
  const remote = { ...local, id: 'ncm:7', source: 'ncm', ncmSongId: 7, filePath: '', cueRange: undefined }
  let job = db.catalogSync({ kind: 'begin', revision: 0 })
  job = db.catalogSync({ kind: 'append', ...job, tracks: [remote] })
  db.catalogSync({ kind: 'commit', ...job })
  const catalog = new CoreCatalogService({
    database: {
      catalogStatus: async () => db.catalogStatus(), catalogAdvance: async limit => db.catalogAdvance(limit),
      catalogQuery: async query => db.catalogQuery(query), catalogDetail: async (...args) => db.catalogDetail(...args),
      catalogSources: async query => db.catalogSources(query), catalogSync: async request => db.catalogSync(request),
      catalogProjectVersions: async (...args) => db.catalogProjectVersions(...args), catalogResolve: async (...args) => db.catalogResolve(...args)
    },
    versions: { getRevision: () => 0, snapshot: emptyMusicVersions },
    playlists: { getRevision: () => 0, sourceTracks: () => [remote] },
    changed: () => {}, failed: error => assert.fail(String(error))
  })
  let providerEnabled = true
  const resolved: string[] = [], played: TrackData[] = []
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, {
    catalog,
    resolvePlaylistInputs: async inputs => {
      if (!providerEnabled) throw new Error('音源未启用')
      assert.equal(inputs[0].kind, 'provider')
      if (inputs[0].kind === 'provider') resolved.push(inputs[0].track.id)
      return [remote]
    }
  })
  f.playback.fromTrack = async (source, _position, _play, signal) => {
    played.push(typeof source === 'function' ? await source(signal ?? new AbortController().signal) : source)
  }
  f.connect('reader', ['library:read'])
  f.connect('player', ['library:read', 'playback:write', 'providers:call'])
  f.connect('blind', ['playback:write'])
  assert.equal((await f.request('reader', 'catalog.refresh')).ok, false)
  assert.equal(db.catalogStatus().localPending, true, 'catalog does not run before Core readiness')
  await f.application.initialize()
  for (let i = 0; i < 100 && (await catalog.status()).state === 'running'; i++)
    await new Promise<void>(resolve => setImmediate(resolve))
  const page = await f.request('reader', 'catalog.query', { kind: 'recording' })
  assert.ok(page.ok)
  const rows = db.catalogQuery({ kind: 'recording' }).items
  const sources = rows.flatMap(row => db.catalogSources({ entityId: row.id }).items)
  const ref = sources.find(source => source.provider === 'local')!
  const online = sources.find(source => source.provider === 'ncm')!
  const revision = db.catalogStatus().revision
  assert.equal((await f.request('blind', 'catalog.play', { sourceId: ref.id, revision })).ok, false)
  assert.equal(f.application.snapshot({ id: 'blind', role: 'desktop', permissions: [] }).catalogRevision, null)
  assert.equal((await f.request('player', 'catalog.play', { sourceId: ref.id, revision })).ok, true)
  assert.deepEqual(played[0].cueRange, local.cueRange)
  assert.equal(played[0].sourceSelection, 'explicit')
  assert.equal((await f.request('player', 'catalog.play', { sourceId: online.id, revision })).ok, true)
  assert.deepEqual(resolved, ['ncm:7'])
  providerEnabled = false
  assert.equal((await f.request('player', 'catalog.play', { sourceId: online.id, revision })).ok, false)
  assert.equal(played.length, 2, 'an explicit unavailable source never falls back to local')
  assert.equal((await f.request('player', 'catalog.play', { sourceId: ref.id, revision: revision - 1 })).ok, false)
  await catalog.shutdown()
  db.close()
})

test('entity metadata dispatch keeps mutations permissioned, runs without a window and preserves the old Track metadata API', async t => {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [{ id: 'one', source: 'local', filePath: 'D:/one.flac', title: 'One', artist: 'Artist' }] })
  db.catalogAdvance()
  const artist = db.catalogQuery({ kind: 'artist' }).items[0].id
  const repository = new Proxy({} as EntityMetadataDatabaseApi, { get: (_, key: keyof EntityMetadataDatabaseApi) => async (...args: unknown[]) => (db[key] as (...args: unknown[]) => unknown).apply(db, args) })
  const metadata = new CoreMetadataService({
    database: { queryTracks: async query => db.queryTracks(query), getTracksByIds: async ids => db.getTracksByIds(ids), patchTracks: async patches => db.patchTracks(patches) },
    available: () => false, provider: { searchSongs: async () => ({ items: [], total: 0 }) },
    policy: () => ({ metadata: false, cover: false, lyrics: false }), now: Date.now, newId: () => 'test', changed() {}, libraryChanged() {}, failed(e) { assert.fail(String(e)) },
    entities: { database: repository, provider: { id: 'musicbrainz-wiki', capabilities: { entities: ['artist'], fields: ['name', 'description', 'introduction'], explicitIdentity: true }, resolve: async () => { assert.fail('Disabled policy must not fetch') }, enrich: async () => [] },
      identificationProviders: () => [{ id: 'fixture', matcherVersion: 'fixture-v1', supports: () => true, context: () => '1', blockedReason: () => null,
        recall: async () => { assert.fail('Disabled policy must not recall') } }],
      policy: () => ({ enabled: false, publicServiceApproved: false, wikipediaText: false, contact: '' }), now: Date.now, changed() {}, failed(e) { assert.fail(String(e)) } }
  })
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, { metadata })
  t.after(() => db.close())
  f.connect('reader', ['library:read']); f.connect('writer')
  await f.application.initialize()
  const initialMetadataContentRevision = f.application.snapshot().entityMetadataContentRevision!
  const demand = { entityId: artist, language: 'en', batchId: 'durable', mbid: 'a223958d-5c56-4b2c-a30a-87e357bc121b' }
  assert.equal((await f.request('reader', 'metadata.entity.resolve', demand)).ok, false)
  const queued = await f.request('writer', 'metadata.entity.resolve', demand)
  assert.ok(queued.ok)
  const job = queued.value as EntityMetadataJob
  f.application.disconnect('writer')
  for (let i = 0; i < 100 && db.metadataJobs({ jobId: job.id }).items[0].state !== 'blocked'; i++) await new Promise<void>(r => setImmediate(r))
  assert.equal(db.metadataJobs({ jobId: job.id }).items[0].state, 'blocked')
  assert.equal(f.application.snapshot().entityMetadataContentRevision, initialMetadataContentRevision,
    'queued, running and blocked tasks do not invalidate displayed metadata')
  const persistedTasks = await f.request('reader', 'metadata.entity.tasks', { filter: 'attention', limit: 1 })
  assert.ok(persistedTasks.ok)
  assert.equal((persistedTasks.value as { items: Array<{ id: string }> }).items[0].id, job.id)
  const persistedDemands = await f.request('reader', 'metadata.entity.demands', { jobId: job.id, limit: 1 })
  assert.ok(persistedDemands.ok)
  assert.equal((persistedDemands.value as { items: Array<{ batchId: string }> }).items[0].batchId, 'durable')
  assert.equal((await f.request('reader', 'metadata.entity.cancel', { jobId: job.id, batchId: 'durable' })).ok, false)
  f.connect('writer')
  assert.equal((await f.request('reader', 'identification.start', { entityId: artist, batchId: 'recall' })).ok, false)
  const started = await f.request('writer', 'identification.start', { entityId: artist, batchId: 'recall' })
  assert.equal(started.ok, true)
  const recallJob = (started as { value: { batchId: string; jobs: EntityMetadataJob[] } }).value
  assert.equal(recallJob.batchId, 'recall')
  assert.equal(recallJob.jobs[0].type, 'identify')
  assert.equal((await f.request('writer', 'metadata.entity.cancel', { jobId: recallJob.jobs[0].id, batchId: 'recall' })).ok, true)
    const beforeMetadataRevision = f.application.snapshot().entityMetadataRevision!
    assert.equal((await f.request('writer', 'metadata.entity.override', { entityId: artist, revision: 0, mode: 'value', value: 'User introduction', language: 'en' })).ok, true)
    assert.ok(f.application.snapshot().entityMetadataRevision! > beforeMetadataRevision)
    assert.ok(f.application.snapshot().entityMetadataContentRevision! > initialMetadataContentRevision)
    assert.equal(f.application.snapshot({ id: 'unrelated', role: 'desktop', permissions: [] }).entityMetadataRevision, null)
    assert.equal(f.application.snapshot({ id: 'unrelated', role: 'desktop', permissions: [] }).entityMetadataContentRevision, null)
  const detail = await f.request('reader', 'metadata.entity.detail', { entityId: artist, language: 'en' })
  assert.ok(detail.ok)
  assert.equal((detail.value as EntityMetadataDetail).introduction!.value, 'User introduction')
  const personalRevision = (detail.value as EntityMetadataDetail).revision
  const preferred = { entityId: artist, revision: personalRevision, provider: 'wikipedia', language: 'en' }
  assert.equal((await f.request('reader', 'metadata.entity.sourcePreference', preferred)).ok, false)
  assert.equal((await f.request('writer', 'metadata.entity.sourcePreference', preferred)).ok, true)
  const image = { entityId: artist, revision: personalRevision + 1, mode: 'value', language: 'en',
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=' }
  assert.equal((await f.request('reader', 'metadata.entity.artworkOverride', image)).ok, false)
  assert.equal((await f.request('writer', 'metadata.entity.artworkOverride', { ...image, dataUrl: 'https://session.invalid/image' })).ok, false)
  assert.equal((await f.request('writer', 'metadata.entity.artworkOverride', image)).ok, true)
  const withImage = await f.request('reader', 'metadata.entity.detail', { entityId: artist, language: 'en' })
  assert.ok(withImage.ok)
  assert.equal((withImage.value as EntityMetadataDetail).manualArtwork?.dataUrl, image.dataUrl)
  assert.equal((withImage.value as EntityMetadataDetail).sourcePreference?.provider, 'wikipedia')
  assert.equal((withImage.value as EntityMetadataDetail).introduction!.value, 'User introduction', 'source preference never overrides personal prose')
  const input = db.identificationInput(artist)
  const [candidate] = db.identificationPublish(input, [{ provider: 'ncm', name: 'Artist', summary: 'Platform identity',
    references: [{ provider: 'ncm', kind: 'artist', idType: 'native', value: '42' }], matcherVersion: 'fixture-v1',
    evidence: { origin: 'search', matches: ['name'], missing: ['cross_reference'], conflicts: [], incomplete: false, provenance: 'fixture' } }], 1000)
  const review = { candidateId: candidate.id, revision: candidate.revision, linkRevision: candidate.linkRevision }
  const candidates = await f.request('reader', 'identification.candidates', { entityId: artist })
  assert.equal(candidates.ok && (candidates.value as { total: number }).total, 1)
  const reviewInbox = await f.request('reader', 'identification.inbox', { kind: 'artist', limit: 1 })
  assert.equal(reviewInbox.ok && (reviewInbox.value as { total: number }).total, 1)
  assert.equal((await f.request('reader', 'identification.preview', review)).ok, true)
  assert.equal((await f.request('reader', 'identification.decide', { ...review, decision: 'confirm' })).ok, false)
  assert.equal((await f.request('writer', 'identification.decide', { ...review, decision: 'confirm' })).ok, true)
  const identified = db.identificationDetail(artist)
  assert.equal((await f.request('reader', 'identification.detail', { entityId: artist })).ok, true)
  assert.equal((await f.request('reader', 'identification.status', {})).ok, true)
  assert.equal(db.metadataDetail(artist, 'en').introduction!.value, 'User introduction')
  assert.equal((await f.request('writer', 'identification.detach', { linkId: identified.link!.id, revision: identified.link!.revision })).ok, true)
  assert.equal(db.identificationDetail(artist).link!.state, 'detached')
  assert.equal((await f.request('reader', 'metadata.status')).ok, true)
  await metadata.shutdown()
})

test('Core owns OPRA queries and refresh survives window detach without blocking playback', async (t) => {
  const catalog = OpraCatalog.fromText([
    { type: 'vendor', id: 'v', data: { name: 'Vendor' } },
    { type: 'product', id: 'p', data: { name: 'Headphone', vendor_id: 'v' } },
    { type: 'eq', id: 'eq', data: { product_id: 'p', parameters: { gain_db: -3, bands: [{ type: 'peak_dip', frequency: 100, gain_db: 2, q: 1 }] } } }
  ].map(row => JSON.stringify(row)).join('\n'), 'profile/opra/database_v1.jsonl')
  let finish!: () => void
  let refreshes = 0
  catalog.refresh = async () => {
    refreshes++
    await new Promise<void>(resolve => { finish = resolve })
    return catalog.getStatus()
  }
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, { opra: catalog })
  await f.application.initialize()
  f.connect('reader', ['settings:read'])
  f.connect('writer', ['settings:write', 'playback:write'])
  assert.equal((await f.request('reader', 'opra.refresh')).ok, false)
  const search = await f.request('reader', 'opra.search', { query: ' vendor headphone ' })
  assert.ok(search.ok)
  assert.equal((search.value as { eqId: string }[])[0].eqId, 'eq')
  const profile = await f.request('reader', 'opra.profile', { id: ' eq ' })
  assert.ok(profile.ok)
  assert.equal((profile.value as { preampDb: number }).preampDb, -3)
  const updating = f.request('writer', 'opra.refresh')
  await new Promise<void>(resolve => setImmediate(resolve))
  f.application.disconnect('reader')
  assert.equal((await f.request('writer', 'playback.pause')).ok, true)
  assert.ok(f.calls.includes('pause'))
  f.connect('recreated', ['settings:read'])
  assert.equal((await f.request('recreated', 'opra.status')).ok, true)
  finish()
  assert.equal((await updating).ok, true)
  assert.equal(refreshes, 1)
  assert.equal((await f.request('recreated', 'opra.profile', { id: 'eq' })).ok, true)
})

test('queue identities feed playlist writes and output diagnostics keep their own permission', async (t) => {
  const writes: unknown[] = []
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, {
    playlists: {
      getRevision: () => 3,
      initialize: async () => {},
      waitForPending: async () => {},
      shutdown: async () => {},
      edit: async (...args: unknown[]) => {
        writes.push(args)
        return 4
      }
    } as unknown as CoreApplicationDependencies['playlists']
  })
  await f.application.initialize()
  f.connect('desktop')
  const locate = await f.request('desktop', 'queue.locate', {
    id: 'queue',
    revision: 1,
    occurrenceId: 'occurrence'
  })
  assert.deepEqual(locate, {
    kind: 'response',
    epoch: 'current',
    requestId: locate.requestId,
    ok: true,
    value: { position: 0 }
  })
  const added = await f.request('desktop', 'playlists.addQueueEntries', {
    id: 'playlist',
    revision: 3,
    queue: { id: 'queue', revision: 1 },
    occurrenceIds: ['occurrence']
  })
  assert.equal(added.ok, true)
  const [revision, edit] = writes[0] as [
    number,
    { kind: string; tracks: Array<{ filePath: string; queueEntryId: string }> }
  ]
  assert.equal(revision, 3)
  assert.equal(edit.kind, 'add')
  assert.equal(edit.tracks[0].filePath, 'private')
  assert.equal(edit.tracks[0].queueEntryId, 'occurrence')
  assert.doesNotMatch(JSON.stringify(added), /private/)
  f.connect('writer', ['library:write'])
  const denied = await f.request('writer', 'playlists.addQueueEntries', {
    id: 'playlist',
    revision: 3,
    queue: { id: 'queue', revision: 1 },
    occurrenceIds: ['occurrence']
  })
  assert.equal(denied.ok, false)
  const diagnostic = await f.request('desktop', 'playback.diagnostics')
  assert.equal(diagnostic.ok, false)
  if (!diagnostic.ok) assert.equal(diagnostic.error.code, 'FORBIDDEN')
  assert.equal(writes.length, 1)
  const hidden = f.application.snapshot({
    id: 'writer',
    role: 'plugin',
    permissions: ['library:write']
  })
  assert.equal(hidden.abLoop, null)
  assert.equal(hidden.mute, null)
  assert.equal(hidden.presentationRevision, null)
  assert.equal(hidden.playback, null)
})

test('finite Core playlist, import and file operations resolve source identities in Core without controlling playback', async (t) => {
  const writes: unknown[] = [],
    resolvedInputs: unknown[] = [],
    revealed: string[] = []
  const track = {
    id: 'ncm:7',
    source: 'ncm',
    title: 'Seven',
    artist: 'Singer',
    album: 'Album',
    filePath: 'private-core-path',
    fileName: 'seven.flac',
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null
  }
  const playlist = {
    getRevision: () => 4,
    initialize: async () => {},
    waitForPending: async () => {},
    shutdown: async () => {},
    edit: async (...args: unknown[]) => {
      writes.push(['edit', ...args])
      return { revision: 5 }
    },
    favorites: async (...args: unknown[]) => {
      writes.push(['favorites', ...args])
      return { revision: 5 }
    }
  }
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, {
    playlists: playlist as unknown as CoreApplicationDependencies['playlists'],
    library: {
      getMetadata: async () => ({
        revision: 1,
        trackCount: 1,
        fileCount: 1,
        folders: [],
        exclusions: []
      }),
      queryTracks: async () => ({ revision: 1, total: 1, offset: 0, tracks: [], versions: {} }),
      getTracksByIds: async () => ({
        revision: 1,
        total: 1,
        offset: 0,
        tracks: [{ id: 'local', source: 'local', filePath: 'D:/fixture/song.flac' }],
        versions: { local: 1 }
      }),
      queryCollections: async () => ({
        revision: 1,
        total: 0,
        offset: 0,
        items: [],
        letterOffsets: {}
      }),
      readLibraryQueue: async () => ({
        revision: 1,
        libraryRevision: 1,
        total: 0,
        offset: 0,
        items: []
      })
    } as unknown as CoreApplicationDependencies['library'],
    resolvePlaylistInputs: async (inputs) => {
      resolvedInputs.push(inputs)
      return [track]
    },
    playlistSources: {
      replace: async (...args) => {
        writes.push(['replace', ...args])
        return { revision: 5, count: 1, track: { id: track.id } }
      },
      rematch: async (...args) => {
        writes.push(['rematch', ...args])
        return { revision: 5, count: 1 }
      }
    } as unknown as CoreApplicationDependencies['playlistSources'],
    importPreviews: {
      bind: async (...args: unknown[]) => {
        writes.push(['previewBind', ...args])
        return { revision: 5 }
      },
      shutdown: async () => {}
    } as unknown as CoreApplicationDependencies['importPreviews'],
    revealAudioFile: async (path) => {
      revealed.push(path)
    }
  })
  await f.application.initialize()
  f.connect('desktop')
  const input = {
    kind: 'provider' as const,
    track: {
      id: track.id,
      source: 'ncm',
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration
    }
  }

  const favorites = await f.request('desktop', 'playlists.favorites', {
    revision: 4,
    items: [input]
  })
  assert.equal(favorites.ok, true)
  assert.deepEqual(resolvedInputs, [[input]])
  assert.deepEqual(writes[0], ['favorites', 4, [track]])

  const replaced = await f.request('desktop', 'playlists.replaceSource', {
    revision: 4,
    oldTrackId: 'local:old',
    input
  })
  assert.equal(replaced.ok, true)
  assert.equal((writes[1] as unknown[])[0], 'replace')
  assert.equal(f.calls.includes('play'), false)

  const bound = await f.request('desktop', 'imports.previewBind', {
    id: 'preview',
    revision: 4,
    entryId: 'entry',
    input
  })
  assert.equal(bound.ok, true)
  assert.equal((writes[2] as unknown[])[0], 'previewBind')

  const reveal = await f.request('desktop', 'library.reveal', { id: 'local' })
  assert.equal(reveal.ok, true)
  assert.deepEqual(revealed, ['D:/fixture/song.flac'])
  assert.equal(revealed.length, 1)

  const preview = await f.request('desktop', 'statistics.previewClear', {
    range: null,
    revision: 0
  })
  assert.equal(preview.ok, true)
  assert.equal(f.calls.includes('play'), false)
})

test('recent library resolution fences recording-version changes before publishing ids', async (t) => {
  let versionRevision = 3
  const lookup: unknown[] = []
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, {
    recordingVersions: {
      initialize: async () => {},
      getRevision: () => versionRevision,
      snapshot: () => ({
        tracks: { versions: [], families: [] },
        albums: { versions: [], families: [] }
      }),
      flush: async () => {}
    } as unknown as CoreApplicationDependencies['recordingVersions'],
    library: {
      getMetadata: async () => ({
        revision: 7,
        trackCount: 0,
        fileCount: 0,
        folders: [],
        exclusions: []
      }),
      queryTracks: async () => ({ revision: 7, total: 0, offset: 0, tracks: [], versions: {} }),
      queryCollections: async () => ({
        revision: 7,
        total: 0,
        offset: 0,
        items: [],
        letterOffsets: {}
      }),
      lookupTracksByPaths: async () => ({ revision: 7, ids: [] }),
      getTracksByIds: async () => ({ revision: 7, total: 0, offset: 0, tracks: [], versions: {} }),
      lookupPlaylistTracks: async (request, revision) => {
        lookup.push({ request, revision })
        versionRevision++
        return { ids: [null], revision }
      },
      readLibraryQueue: async () => ({
        revision: 7,
        libraryRevision: 7,
        total: 0,
        offset: 0,
        items: []
      })
    } as unknown as CoreApplicationDependencies['library']
  })
  await f.application.initialize()
  f.connect('desktop')
  const response = await f.request('desktop', 'library.recent.resolve', {
    entries: [
      {
        id: 'history',
        sourceIds: ['local:1'],
        snapshot: {
          id: 'history',
          title: 'Song',
          artist: 'Artist',
          cueRange: { startSeconds: 0, endSeconds: 1, pregapSeconds: 0 }
        }
      }
    ],
    revision: 7,
    versionsRevision: 3
  })
  assert.equal(response.ok, false)
  if (!response.ok) assert.equal(response.error.code, 'STALE_REVISION')
  assert.equal(lookup.length, 1)
})

test('settings readiness, permissions and a slow settings edit leave Pause independent', async (t) => {
  let finish!: () => void
  const held = new Promise<void>((done) => {
    finish = done
  })
  let initialized = false,
    edits = 0
  const volumes: number[] = []
  const settings: NonNullable<CoreApplicationDependencies['settings']> = {
    getRevision: () => 4,
    state: () => ({ revision: 4, settings: {} as import('../shared/appSettings.ts').AppSettings }),
    initialize: async () => {
      initialized = true
    },
    edit: async () => {
      edits++
      await held
      return settings.state()
    },
    flush: async () => {},
    rememberVolume: (volume) => {
      volumes.push(volume)
    }
  }
  const f = fixture(t, false, undefined, undefined, undefined, undefined, settings)
  f.connect('desktop', [
    'playback:read',
    'playback:write',
    'settings:read',
    'settings:write',
    'migration:write'
  ])
  f.connect('plugin', ['playback:read'])
  await f.application.initialize()
  assert.equal(initialized, false)
  assert.equal(
    (await f.request('desktop', 'settings.edit', { revision: 4, patch: { theme: 'dark' } })).ok,
    false
  )
  await f.request('desktop', 'migration.begin', {
    id: 'upgrade',
    manifest: { version: 1, counts: emptyCoreStateCounts() }
  })
  await f.request('desktop', 'migration.commit', { id: 'upgrade' })
  assert.equal(initialized, true)
  assert.equal(f.application.snapshot().settingsRevision, 4)
  assert.equal(
    f.application.snapshot({ id: 'plugin', role: 'plugin', permissions: ['playback:read'] })
      .settingsRevision,
    null
  )
  const denied = await f.request('plugin', 'settings.state')
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.equal(denied.error.code, 'FORBIDDEN')
  const editing = f.request('desktop', 'settings.edit', { revision: 4, patch: { theme: 'dark' } })
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(edits, 1)
  assert.equal((await f.request('desktop', 'playback.pause')).ok, true)
  finish()
  assert.equal((await editing).ok, true)
  const initial = f.playback.snapshot()
  const actual = { volume: 0.4, outputBackend: 'wasapi' } as NonNullable<typeof initial.playback>
  f.playback.snapshot = () => ({ ...initial, playback: actual })
  await f.request('desktop', 'playback.volume', { volume: 0.9 })
  assert.deepEqual(volumes, [0.4], 'persist the applied device ceiling, not the requested value')
  actual.outputBackend = 'cast'
  await f.request('desktop', 'playback.volume', { volume: 0.2 })
  assert.deepEqual(
    volumes,
    [0.4],
    'remote receiver volume is not the local software volume preference'
  )
})

test('audio output permissions, revision events and slow output work do not block Pause', async (t) => {
  let finish!: () => void
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  let edits = 0
  const output: NonNullable<CoreApplicationDependencies['output']> = {
    getRevision: () => 7,
    changed: () => {},
    state: async () =>
      ({ revision: 7 }) as Awaited<
        ReturnType<NonNullable<CoreApplicationDependencies['output']>['state']>
      >,
    profiles: async () =>
      ({ revision: 7 }) as Awaited<
        ReturnType<NonNullable<CoreApplicationDependencies['output']>['profiles']>
      >,
    edit: async () => {
      edits++
      await held
    },
    editProfiles: async () => {
      edits++
    },
    flush: async () => {},
    shutdown: async () => {}
  }
  const f = fixture(t, true, undefined, undefined, undefined, output)
  await f.application.initialize()
  f.connect('ordinary')
  f.connect('audio-editor', ['playback:read', 'playback:write', 'settings:read', 'settings:write'])
  assert.equal(
    f.application.snapshot({ id: 'plugin', role: 'plugin', permissions: ['playback:read'] })
      .audioRevision,
    null
  )
  assert.equal(f.application.snapshot().audioRevision, 7)
  const forbidden = await f.request('ordinary', 'audio.output.edit', {
    revision: 7,
    edit: { kind: 'exclusive', enabled: true }
  })
  assert.equal(forbidden.ok, false)
  if (!forbidden.ok) assert.equal(forbidden.error.code, 'FORBIDDEN')
  const editing = f.request('audio-editor', 'audio.output.edit', {
    revision: 7,
    edit: { kind: 'exclusive', enabled: true }
  })
  const paused = await f.request('audio-editor', 'playback.pause')
  assert.equal(paused.ok, true)
  assert.equal(edits, 1)
  finish()
  assert.equal((await editing).ok, true)
  const view = await f.request('audio-editor', 'audio.output')
  assert.equal(view.ok, true)
  if (view.ok) assert.deepEqual(view.value, { revision: 7 })
})

test('initial snapshot/subscription and readiness gate prevent all business work until atomic migration publication', async (t) => {
  const f = fixture(t, false)
  await f.application.initialize()
  f.connect('desktop')
  const initial = f.messages.get('desktop')![0]
  assert.equal(initial.kind, 'state')
  if (initial.kind !== 'state') return
  assert.equal(initial.sequence, initial.snapshot.sequence)
  assert.equal(initial.snapshot.phase, 'starting')
  assert.equal(initial.snapshot.migrationRequired, true)
  for (const name of ['playback.pause', 'scan.start', 'library.tracks', 'statistics.summary']) {
    const reply = await f.request('desktop', name, name === 'scan.start' ? { mode: 'full' } : {})
    assert.equal(reply.ok, false)
    if (!reply.ok) assert.equal(reply.error.code, 'NOT_READY')
  }
  assert.ok(!f.calls.includes('scan.activate'))
  assert.ok(!f.calls.includes('libraryBackground.activate'))
  assert.ok(!f.calls.includes('statistics.initialize'))
  await f.request('desktop', 'migration.begin', {
    id: 'upgrade',
    manifest: { version: 1, counts: emptyCoreStateCounts() }
  })
  const committed = await f.request('desktop', 'migration.commit', { id: 'upgrade' })
  assert.equal(committed.ok, true)
  assert.equal(f.application.snapshot().phase, 'ready')
  assert.equal(f.application.snapshot().migrationRequired, false)
  assert.equal(f.calls.filter((call) => call === 'scan.activate').length, 1)
  assert.equal(f.calls.filter((call) => call === 'libraryBackground.activate').length, 1)
  assert.ok(f.calls.indexOf('scan.activate') < f.calls.indexOf('libraryBackground.activate'))
  assert.equal(f.calls.filter((call) => call === 'statistics.initialize').length, 1)
  await f.request('desktop', 'migration.commit', { id: 'upgrade' })
  assert.equal(f.calls.filter((call) => call === 'ready').length, 1)
  assert.equal(f.calls.filter((call) => call === 'libraryBackground.activate').length, 1)
})

test('main-bound capabilities, exact command payloads, epoch and duplicate IDs fence dispatch at the Core too', async (t) => {
  const f = fixture(t)
  await f.application.initialize()
  f.connect('desktop')
  f.connect('plugin', ['playback:read'])
  const denied = await f.request('plugin', 'playback.pause')
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.equal(denied.error.code, 'FORBIDDEN')
  const invalid = await f.request('desktop', 'playback.pause', { injected: true })
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.equal(invalid.error.code, 'INVALID_REQUEST')
  const stale = await f.request('desktop', 'playback.pause', {}, { epoch: 'retired' })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.error.code, 'STALE_EPOCH')
  assert.equal((await f.request('desktop', 'playback.pause', {}, { requestId: 'once' })).ok, true)
  const duplicate = await f.request('desktop', 'playback.pause', {}, { requestId: 'once' })
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) assert.equal(duplicate.error.code, 'OUTCOME_UNKNOWN')
  assert.equal(f.calls.filter((call) => call === 'pause').length, 1)
  const history = await f.request('plugin', 'statistics.summary')
  assert.equal(history.ok, false)
  if (!history.ok) assert.equal(history.error.code, 'FORBIDDEN')
})

test('cache ownership is dispatched through Core and requires settings access rather than library write', async (t) => {
  let clears = 0
  const action = <T>(run: () => Promise<T>) => run()
  const cache = new CoreMusicCacheService({
    authorize: async () => {},
    maintainSources: (run) => run([]),
    maintainResources: action,
    maintainNetwork: action,
    maintainProvider: action,
    maintainScanner: action,
    clearFiles: async () => {
      clears++
    },
    clearPlatform: async () => {},
    info: async () => ({ sizeBytes: 4 }),
    clearNetwork: async () => ({ sizeBytes: 2 })
  })
  const f = fixture(t, true, undefined, undefined, cache)
  await f.application.initialize()
  f.connect('library-writer', ['library:write'])
  f.connect('settings-reader', ['settings:read'])
  f.connect('settings-writer', ['settings:write'])
  for (const id of ['library-writer', 'settings-reader']) {
    const denied = await f.request(id, 'cache.clear')
    assert.equal(denied.ok, false)
    if (!denied.ok) assert.equal(denied.error.code, 'FORBIDDEN')
  }
  assert.equal(clears, 0)
  const info = await f.request('settings-reader', 'cache.info')
  assert.ok(info.ok)
  assert.deepEqual(info.value, { sizeBytes: 4 })
  assert.equal(
    (await f.request('settings-writer', 'cache.clear', {}, { requestId: 'clear-once' })).ok,
    true
  )
  const duplicate = await f.request(
    'settings-writer',
    'cache.clear',
    {},
    { requestId: 'clear-once' }
  )
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) assert.equal(duplicate.error.code, 'OUTCOME_UNKNOWN')
  assert.equal(clears, 1)
})

test('slow source work is cancellable per client while another window can pause; disconnect suppresses late replies', async (t) => {
  const f = fixture(t)
  await f.application.initialize()
  f.connect('desktop')
  f.connect('mini')
  let aborted = false
  f.playback.play = async (_position, signal) =>
    new Promise<void>((_resolve, reject) => {
      signal!.addEventListener(
        'abort',
        () => {
          aborted = true
          reject(Object.assign(new Error('Preview cancelled'), { code: 'CANCELLED' }))
        },
        { once: true }
      )
    })
  const pending = f.application.request('desktop', {
    kind: 'command',
    name: 'playback.play',
    payload: {},
    epoch: 'current',
    requestId: 'slow'
  })
  assert.equal((await f.request('mini', 'playback.pause')).ok, true)
  f.application.disconnect('desktop')
  await pending
  assert.equal(aborted, true)
  assert.equal(
    f.messages.get('desktop')!.filter((message) => message.kind === 'response').length,
    0
  )
  assert.equal(f.calls.filter((call) => call === 'pause').length, 1)
})

test('reconnecting UI clients only reattach projections; ordered snapshots and library/queue responses never publish credentials', async (t) => {
  const f = fixture(t)
  await f.application.initialize()
  f.connect('desktop')
  f.connect('plugin', ['playback:read'])
  const before = [...f.calls]
  for (let i = 0; i < 5; i++) {
    f.application.disconnect('desktop')
    f.connect('desktop')
    const response = await f.request('desktop', 'state.snapshot')
    assert.equal(response.ok, true)
  }
  assert.deepEqual(f.calls, before)
  f.application.changed()
  f.application.changed()
  const events = f.messages.get('desktop')!.filter((message) => message.kind === 'state')
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3]
  )
  for (const name of ['library.tracks', 'queue.page', 'scan.status']) {
    const reply = await f.request(
      'desktop',
      name,
      name === 'queue.page' ? { id: 'queue', revision: 1, offset: 0 } : {}
    )
    assert.equal(reply.ok, true)
    assert.doesNotMatch(JSON.stringify(reply), /private|credentials|streamUrl|filePath/)
  }
  const plugin = await f.request('plugin', 'state.snapshot')
  assert.equal(plugin.ok, true)
  if (plugin.ok) assert.equal((plugin.value as CoreSnapshot).scan, null)
  if (plugin.ok) assert.equal((plugin.value as CoreSnapshot).statisticsRevision, null)
})

test('final shutdown stops the durable scan and waits for in-flight request cancellation before playback persistence', async (t) => {
  const f = fixture(t)
  await f.application.initialize()
  f.connect('desktop')
  f.playback.play = async (_position, signal) =>
    new Promise<void>((_resolve, reject) =>
      signal!.addEventListener(
        'abort',
        () => {
          f.calls.push('preview.cancelled')
          reject(new Error('Cancelled'))
        },
        { once: true }
      )
    )
  const pending = f.application.request('desktop', {
    kind: 'command',
    name: 'playback.play',
    payload: {},
    epoch: 'current',
    requestId: 'pending'
  })
  await f.application.shutdown()
  await pending
  assert.ok(f.calls.indexOf('preview.cancelled') < f.calls.indexOf('playback.shutdown'))
  assert.ok(f.calls.indexOf('scan.shutdown') < f.calls.indexOf('playback.shutdown'))
  assert.ok(f.calls.indexOf('playback.shutdown') < f.calls.indexOf('statistics.shutdown'))
  assert.equal(f.application.snapshot().phase, 'stopped')
  const stopped = await f.request('desktop', 'playback.pause')
  assert.equal(stopped.ok, false)
  assert.ok(!f.calls.includes('pause'))
})

test('download permissions are independent; library import and playback require their additional capabilities', async (t) => {
  let writes = 0
  const downloads = new CoreDownloadsService({
    authorizedRoots: async () => ({ libraryRoots: ['D:/Music'], downloadRoot: null }),
    grant: async (path) => path,
    changed: () => {},
    pluginManager: {
      callProvider: async () => {
        writes++
        return { jobId: 'private', status: 'failed', requestedQuality: 'lossless', error: 'failed' }
      }
    }
  })
  const f = fixture(t, true, downloads)
  await f.application.initialize()
  f.connect('plugin', ['playback:read', 'playback:write'])
  f.connect('downloader', ['playback:read', 'downloads:read', 'downloads:write'])
  const denied = await f.request('plugin', 'downloads.create', {
    providerId: 'fixture',
    track: { id: 'one', title: 'Song', artist: 'Artist' },
    quality: 'lossless'
  })
  assert.equal(denied.ok, false)
  assert.equal(writes, 0)
  assert.equal(
    f.application.snapshot({ id: 'plugin', role: 'plugin', permissions: ['playback:read'] })
      .downloads,
    null
  )
  const created = await f.request('downloader', 'downloads.create', {
    providerId: 'fixture',
    track: { id: 'one', title: 'Song', artist: 'Artist' },
    quality: 'lossless'
  })
  assert.equal(created.ok, true)
  assert.equal(writes, 1)
  const imported = await f.request('downloader', 'downloads.result', {
    id: 'one',
    addToLibrary: true
  })
  assert.equal(imported.ok, false)
  if (!imported.ok) assert.equal(imported.error.code, 'FORBIDDEN')
  const play = await f.request('plugin', 'downloads.play', { id: 'one' })
  assert.equal(play.ok, false)
  if (!play.ok) assert.equal(play.error.code, 'FORBIDDEN')
  let released!: () => void
  const gate = new Promise<void>((resolve) => {
    released = resolve
  })
  const original = downloads.shutdown.bind(downloads)
  downloads.shutdown = async () => {
    f.calls.push('downloads.stopping')
    await gate
    await original()
    f.calls.push('downloads.stopped')
  }
  const shutdown = f.application.shutdown()
  await Promise.resolve()
  assert.ok(!f.calls.includes('scan.shutdown'))
  released()
  await shutdown
  assert.ok(f.calls.indexOf('downloads.stopped') < f.calls.indexOf('scan.shutdown'))
})

test('AutoMix install intent is a desktop settings command and is applied by the Core owner', async (t) => {
  const intents: boolean[] = []
  const modelPack = {
    start: (enableAfterInstall: boolean) => {
      intents.push(enableAfterInstall)
      return { phase: 'selecting', completedBytes: 0, totalBytes: 0 }
    },
    cancel: () => ({ phase: 'cancelled', completedBytes: 0, totalBytes: 0 }),
    state: () => ({ phase: 'idle', completedBytes: 0, totalBytes: 0 }),
    shutdown: async () => {}
  } as unknown as CoreApplicationDependencies['modelPack']
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, { modelPack })
  await f.application.initialize()
  f.connect('installer', ['settings:read', 'settings:write'])
  const started = await f.request('installer', 'automix.install.start', {
    enableAfterInstall: true
  })
  assert.equal(started.ok, true)
  assert.deepEqual(intents, [true])

  const pluginMessages: CoreClientMessage[] = []
  f.application.connect(
    { id: 'plugin-installer', role: 'plugin', permissions: ['settings:read', 'settings:write'] },
    (message) => pluginMessages.push(message)
  )
  const denied = await f.application.request('plugin-installer', {
    kind: 'command',
    name: 'automix.install.start',
    payload: { enableAfterInstall: false },
    epoch: 'current',
    requestId: 'plugin-install'
  })
  const reply = pluginMessages.find(
    (message): message is CoreResponse =>
      message.kind === 'response' && message.requestId === 'plugin-install'
  )
  assert.equal(denied, undefined)
  assert.equal(reply?.ok, false)
  if (reply && !reply.ok) assert.equal(reply.error.code, 'FORBIDDEN')
  assert.deepEqual(intents, [true])
})

test('personalized playback requires both player control and provider access at the Core boundary', async (t) => {
  const f = fixture(t)
  await f.application.initialize()
  let starts = 0
  f.playback.startPersonalized = async () => {
    starts++
  }
  f.connect('control', ['playback:write'])
  f.connect('provider', ['providers:call'])
  f.connect('authorized', ['playback:write', 'providers:call'])
  for (const id of ['control', 'provider']) {
    const result = await f.request(id, 'personalized.start', { providerId: 'ncm', key: 'fm' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'FORBIDDEN')
  }
  assert.equal(starts, 0)
  assert.equal(
    (
      await f.request('authorized', 'personalized.start', {
        providerId: 'ncm',
        key: 'radar',
        play: false
      })
    ).ok,
    true
  )
  assert.equal(starts, 1)
})

test('liked and heart operations require playback control and provider permission together', async (t) => {
  const f = fixture(t)
  await f.application.initialize()
  f.connect('control', ['playback:write'])
  f.connect('provider', ['providers:call'])
  f.connect('authorized', ['playback:write', 'providers:call'])
  for (const [name, payload] of [
    ['liked.play', { play: false }],
    ['heart.refill', { id: 'q', revision: 1 }],
    ['playback.mode', { mode: 'heart' }]
  ] as const) {
    for (const id of ['control', 'provider']) {
      const result = await f.request(id, name, payload)
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.error.code, 'FORBIDDEN')
    }
    assert.equal((await f.request('authorized', name, payload)).ok, true)
  }
})

test('unified search needs provider permission; local-only search stays usable with library read access', async (t) => {
  const scopes: unknown[] = []
  const f = fixture(t, true, undefined, {
    collections: async (query) => {
      scopes.push(query.scope)
      return { items: [], total: 0, offset: 0, hasMore: false }
    },
    page: async (query) => {
      scopes.push(query.scope)
      return { items: [], logicalItems: [], health: {}, total: 0, versionsRevision: 0 }
    },
    shutdown: async () => {}
  })
  await f.application.initialize()
  f.connect('local', ['library:read'])
  f.connect('providers', ['providers:call'])
  f.connect('both', ['library:read', 'providers:call'])
  for (const name of ['search.songs', 'search.collections']) {
    const payload = { query: 'Moon', ...(name === 'search.collections' ? { kind: 'albums' } : {}) }
    for (const id of ['local', 'providers']) {
      const result = await f.request(id, name, payload)
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.error.code, 'FORBIDDEN')
    }
    assert.equal((await f.request('local', name, { ...payload, scope: 'local' })).ok, true)
    assert.equal((await f.request('both', name, payload)).ok, true)
  }
  assert.deepEqual(scopes, ['local', undefined, 'local', undefined])
})

test('a slow search is cancelled on disconnect while another client pauses independently', async (t) => {
  let started!: () => void,
    cancelled = false
  const entered = new Promise<void>((resolve) => (started = resolve))
  const f = fixture(t, true, undefined, {
    collections: async () => ({ items: [], total: 0, offset: 0, hasMore: false }),
    page: async (_query, signal) =>
      new Promise((_resolve, reject) => {
        started()
        signal!.addEventListener(
          'abort',
          () => {
            cancelled = true
            reject(signal!.reason)
          },
          { once: true }
        )
      }),
    shutdown: async () => {}
  })
  await f.application.initialize()
  f.connect('search', ['library:read', 'providers:call'])
  f.connect('mini', ['playback:write'])
  const search = f.request('search', 'search.songs', { query: 'Slow' })
  await entered
  assert.equal((await f.request('mini', 'playback.pause')).ok, true)
  f.application.disconnect('search')
  await search
  assert.equal(cancelled, true)
  assert.equal(f.calls.filter((call) => call === 'pause').length, 1)
  assert.equal(f.messages.get('search')!.filter((message) => message.kind === 'response').length, 0)
})

test('Core backup v2 selection and repreview retain desktop settings permissions and private database boundaries', async t => {
  const root = mkdtempSync(join(tmpdir(), 'backup-gateway-'))
  const dialogs: string[] = []
  const unavailable = async (): Promise<never> => { throw new Error('No database work should run after cancelling the file picker') }
  const backup = new CorePersonalBackupService({ root,
    database: { exportDocument: unavailable, restoreDocument: unavailable, restorePersonalLibrary: unavailable,
      previewPersonalLibrary: unavailable, getMetadata: unavailable, exportPlaybackQueue: unavailable,
      corePersonalRestore: async () => ({ id: null, applied: false }) },
    flush: async () => {}, personalData: () => ({}), chooseFile: async kind => { dialogs.push(kind); return null },
    chooseFolder: async () => null, authorizeRoots: async roots => roots, newId: () => 'preview'
  })
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, { personalBackup: backup })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await f.application.initialize()
  f.connect('reader', ['settings:read'])
  f.connect('writer', ['settings:write'])
  f.connect('blind', ['library:read'])
  f.connect('plugin', ['settings:read', 'settings:write'])
  f.application.disconnect('plugin')
  f.application.connect({ id: 'plugin', role: 'plugin', permissions: ['settings:read', 'settings:write'] }, message => f.messages.get('plugin')!.push(message))
  assert.equal((await f.request('reader', 'backup.export', {})).ok, true)
  assert.equal((await f.request('reader', 'backup.export', { domains: ['music'] })).ok, true)
  assert.deepEqual(dialogs, ['export', 'export'])
  assert.equal((await f.request('reader', 'backup.preview', {})).ok, false)
  assert.equal((await f.request('writer', 'backup.preview', {})).ok, true)
  assert.equal((await f.request('writer', 'backup.recover', {})).ok, true)
  for (const name of ['backup.repreview', 'backup.stage']) {
    const response = await f.request('writer', name, { id: 'missing', options: { domains: ['music'], conflict: 'keep-local', mappings: [] } })
    assert.equal(response.ok, false)
    if (!response.ok) assert.equal(response.error.code, 'STALE_REVISION')
  }
  for (const [name, payload] of [['backup.export', { domains: ['music'] }], ['backup.recover', {}], ['backup.preview', {}]] as const) {
    const response = await f.request('plugin', name, payload)
    assert.equal(response.ok, false)
    if (!response.ok) assert.equal(response.error.code, 'FORBIDDEN')
  }
  assert.equal((await f.request('blind', 'musicBackupExport', {})).ok, false)
  assert.equal(f.application.snapshot({ id: 'none', role: 'plugin', permissions: [] }).personalBackupRecovery, null)
  assert.equal(f.application.snapshot({ id: 'reader', role: 'desktop', permissions: ['settings:read'] }).personalBackupRecovery, false)
})

test('Core exploration dispatch keeps exact local navigation and manual performances under library permissions', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [{ id: 'exploration-local', source: 'local', filePath: 'D:/music/one.flac', title: 'One', artist: 'Same name', album: 'Album' }] })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const recording = db.catalogQuery({ kind: 'recording' }).items[0]
  const reference = (kind: MusicExplorationReference['kind'], value: string): MusicExplorationReference => ({ provider: 'musicbrainz', kind, idType: 'mbid', value })
  const recordingRef = reference('recording', '00000000-0000-0000-0000-000000000001'), personRef = reference('artist', '00000000-0000-0000-0000-000000000020'), workRef = reference('work', '00000000-0000-0000-0000-000000000010')
  db.sql.prepare('INSERT INTO metadata_entities VALUES(?,?,?,?,?)').run('exploration-target', 'musicbrainz', 'recording', recordingRef.value, 'One')
  db.sql.prepare('INSERT INTO metadata_identity_refs VALUES(?,?,?,?,?)').run(recordingRef.provider, recordingRef.kind, recordingRef.idType, recordingRef.value, 'exploration-target')
  db.sql.prepare("INSERT INTO metadata_identity_links VALUES(?,?,?,1,?,'confirmed')").run('exploration-link', recording.id, 'recording', 'exploration-target')
  const attribution = { provider: 'musicbrainz', externalId: personRef.value, url: 'https://musicbrainz.org', license: 'CC0', licenseUrl: '', attribution: 'MusicBrainz', revision: '1', retrievedAt: 1000 }
  db.explorationIngest({ owner: recordingRef, provider: 'musicbrainz-details', setKey: 'dispatch', nodes: [{ reference: recordingRef, title: 'One' }, { reference: personRef, title: 'Exact person' }, { reference: workRef, title: 'Work' }], relations: [
    { from: workRef, to: recordingRef, kind: 'work_recording', order: 0, attribution },
    { from: personRef, to: workRef, kind: 'credit', order: 0, attribution, credit: { personRef: { ...personRef, kind: 'artist' }, name: 'Exact person', targetRef: { ...workRef, kind: 'work' }, role: 'composer', rawRole: 'composer', relationTypeId: 'composer', direction: 'backward', order: 0, joinphrase: '', attributes: [], begin: '', end: '', attribution } }
  ], truncated: false })
  const api = new Proxy({} as MusicExplorationDatabaseApi, { get: (_, key: keyof MusicExplorationDatabaseApi) => async (...args: unknown[]) => (db[key] as (...args: unknown[]) => unknown).apply(db, args) })
  const catalogApi = new Proxy({} as CatalogDatabaseApi, { get: (_, key: keyof CatalogDatabaseApi) => async (...args: unknown[]) => (db[key] as (...args: unknown[]) => unknown).apply(db, args) })
  const catalog = new CoreCatalogService({ database: catalogApi, versions: { getRevision: () => 0, snapshot: emptyMusicVersions },
    playlists: { getRevision: () => 0, sourceTracks: () => [] }, changed() {}, failed: error => assert.fail(String(error)) })
  let changed = () => {}
  const exploration = new CoreMusicExplorationService({ database: api, platformContexts: () => ({}), now: () => 1001, changed: () => changed() })
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, { exploration, catalog })
  changed = () => f.application.changed()
  await f.application.initialize()
  for (let i = 0; i < 100 && (await catalog.status()).state === 'running'; i++) await new Promise<void>(resolve => setImmediate(resolve))
  await catalog.cancel()
  const indexedRevision = catalog.getRevision()
  assert.equal(indexedRevision, db.catalogStatus().revision)
  t.after(() => catalog.shutdown())
  f.connect('reader', ['library:read', 'playback:read']); f.connect('writer', ['library:write']); f.connect('provider', ['library:read', 'library:write', 'providers:call']); f.connect('no-library', ['playback:read'])
  const page = await f.request('reader', 'exploration.query', { kinds: ['artist'], scope: 'library' }); assert.equal(page.ok, true)
  if (!page.ok) return
  assert.equal((page.value as MusicExplorationPage).total, 1)
  const lookup = await f.request('reader', 'exploration.lookup', { reference: personRef }); assert.equal(lookup.ok, true)
  if (!lookup.ok) return
  const person = (lookup.value as MusicExplorationDetail).entity!
  assert.equal((await f.request('reader', 'exploration.detail', { entityId: person.id })).ok, true)
  const participation = await f.request('reader', 'exploration.participation', { entityId: person.id, roles: ['composer'] }); assert.equal(participation.ok, true)
  if (!participation.ok) return
  const work = (participation.value as MusicExplorationRelationsPage).items[0].entity
  const save = { title: 'Local confirmed rendition', workId: work.id, recordingIds: [recording.id], revision: db.explorationState().revision }
  assert.equal((await f.request('reader', 'exploration.performance.save', save)).ok, false)
  assert.equal((await f.request('writer', 'exploration.query', {})).ok, false)
  assert.equal((await f.request('no-library', 'exploration.lookup', { reference: personRef })).ok, false)
  assert.equal(f.application.snapshot({ id: 'none', role: 'desktop', permissions: ['playback:read'] }).explorationRevision, null)
  assert.equal(f.application.snapshot({ id: 'reader', role: 'desktop', permissions: ['library:read'] }).explorationRevision, db.explorationState().revision)
  for (const name of ['exploration.ingest', 'exploration.syncCredits', 'exploration.backfillCredits']) assert.equal((await f.request('provider', name, {})).ok, false)
  assert.equal((await f.request('reader', 'exploration.query', { platformContexts: { musicbrainz: 'forged' } })).ok, false)
  assert.equal((await f.request('reader', 'exploration.lookup', { name: 'Same name' })).ok, false)
  const saved = await f.request('writer', 'exploration.performance.save', save); assert.equal(saved.ok, true)
  if (!saved.ok) return
  const performance = saved.value as MusicExplorationDetail
  assert.equal(performance.entity!.inLibrary, true)
  assert.equal((await f.request('reader', 'exploration.relations', { entityId: performance.entity!.id, direction: 'outgoing' })).ok, true)
  assert.equal((await f.request('reader', 'exploration.performance.delete', { id: performance.entity!.id, revision: db.explorationState().revision })).ok, false)
  const snapshot = shallowRef(f.application.snapshot())
  const tagsData = tagsFixture(), tagsView = createMusicTagsView(tagsData.api)
  const focusData = focusFixture(), focusView = createMusicFocusView(focusData.api)
  const stopTags = observeMusicTagsView(tagsView, { entityId: () => person.id, scope: () => 'person', snapshot: () => snapshot.value })
  const stopFocus = observeMusicFocusView(focusView, { scope: () => 'library', snapshot: () => snapshot.value })
  t.after(() => { stopTags(); stopFocus(); tagsView.dispose(); focusView.dispose() })
  await new Promise<void>(resolve => setImmediate(resolve))
  await focusView.evaluate()
  tagsView.setCreateName('保留人物标签草稿')
  focusView.setName('保留筛选草稿')
  assert.ok(tagsView.state.value.entity)
  assert.ok(focusView.state.value.page)
  assert.ok(focusView.state.value.facets)
  const tagReads = tagsData.queries.length, focusReads = focusData.queries.length
  const beforeDelete = db.explorationState(), preferencesRevision = db.getPreferencesRevision()
  const tagsToken = db.tagsState(), focusState = db.focusState(), draft = focusView.state.value.draft
  const removed = await f.request('writer', 'exploration.performance.delete', { id: performance.entity!.id, revision: db.explorationState().revision }); assert.equal(removed.ok, true)
  if (removed.ok) assert.equal(removed.value, true)
  assert.ok(db.explorationState().catalogRevision > beforeDelete.catalogRevision)
  assert.equal(db.getPreferencesRevision(), preferencesRevision, 'deletion keeps anchors; no incidental preference invalidation')
  assert.equal(db.tagsState().tagsRevision, tagsToken.tagsRevision)
  assert.equal(db.focusState().savedRevision, focusState.savedRevision)
  assert.equal(catalog.getRevision(), indexedRevision, 'paused indexing is not restarted for graph writes')
  const event = f.messages.get('reader')!.findLast(message => message.kind === 'state')
  assert.ok(event?.kind === 'state')
  assert.equal(event.snapshot.catalogRevision, db.catalogStatus().revision)
  assert.equal(f.application.snapshot({ id: 'none', role: 'desktop', permissions: [] }).catalogRevision, null)
  snapshot.value = event.snapshot
  assert.equal(tagsView.state.value.entity, null)
  assert.equal(focusView.state.value.page, null)
  assert.equal(focusView.state.value.facets, null)
  assert.equal(tagsView.state.value.createName, '保留人物标签草稿')
  assert.equal(focusView.state.value.name, '保留筛选草稿')
  assert.deepEqual(focusView.state.value.draft, draft)
  assert.equal(tagsData.queries.length, tagReads)
  assert.equal(focusData.queries.length, focusReads)
  exploration.observe(beforeDelete)
  assert.equal(f.application.snapshot().catalogRevision, event.snapshot.catalogRevision, 'late replies do not roll back the observed revision')
  assert.equal(db.queryTracks({ limit: 10 }).total, 1)
})

test('listening sync status is query-only and respects listening history permissions', async t => {
  const sync = new CoreNcmListeningSync({ enabled: true, available: () => true,
    context: () => 'account', account: async () => 7, submit: async () => {},
    now: () => 0, newId: () => 'attempt', changed() {} })
  const f = fixture(t, true, undefined, undefined, undefined, undefined, undefined, { listeningSync: sync })
  await f.application.initialize()
  f.connect('reader', ['statistics:read'])
  f.connect('other', ['library:read'])
  const response = await f.request('reader', 'listeningSync.status')
  assert.equal(response.ok, true)
  if (response.ok) assert.deepEqual(response.value, sync.status())
  assert.equal((await f.request('other', 'listeningSync.status')).ok, false)
  assert.equal((await f.request('reader', 'listeningSync.status', { upload: true })).ok, false)
  await sync.shutdown()
})

test('recent history views require statistics permission as well as ordinary library access', async (t) => {
  const f = fixture(t)
  await f.application.initialize()
  f.connect('library-only', ['library:read'])
  const reply = await f.request('library-only', 'playlists.view', {
    id: 'core:recent',
    revision: 0,
    versionsRevision: 0
  })
  assert.equal(reply.ok, false)
  if (!reply.ok) assert.equal(reply.error.code, 'FORBIDDEN')
})
