import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  CoreClientIdentity,
  CoreErrorCode,
  CoreClientMessage,
  CoreRequestEnvelope,
  CoreSnapshot
} from '../../shared/coreProtocol.ts'
import type { LibraryPage } from '../../shared/libraryDatabase.ts'
import { createDefaultSettings } from '../settings/normalization.ts'
import { CoreRemoteService } from './service.ts'
import type { CorePlaybackSession } from '../playback/session.ts'
import {
  negotiateRemoteProtocol,
  REMOTE_CORE_LOCAL_ZONE,
  REMOTE_CORE_PROTOCOL_RANGE,
  type RemoteProviderSession
} from '../../shared/remoteCoreBridge.ts'

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
const track = (id: string) => ({
  id,
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  duration: 120,
  source: 'local'
})
function fixture(t: test.TestContext, enabled = false) {
  const settings = createDefaultSettings('win32')
  settings.remoteControlEnabled = enabled
  let state = {
    phase: 'ready',
    epoch: 'test',
    presentationRevision: 0,
    playlistsRevision: 2,
    versionsRevision: 3,
    queue: { id: 'queue', revision: 7, total: 2, index: 0 },
    playback: { state: 'playing', playMode: 'shuffle', position: 23, volume: 0.5 },
    track: track('now'),
    mute: { muted: true },
    cast: null
  } as unknown as CoreSnapshot
  const starts: string[] = [],
    requests: CoreRequestEnvelope[] = [],
    identities: CoreClientIdentity[] = []
  const rows: unknown[] = [],
    edits: unknown[] = [],
    selected: number[] = [],
    failures: unknown[] = []
  let castActive = false,
    running = false,
    mode = 'full',
    pin = '111111'
  let receive!: (message: CoreClientMessage) => void
  const receivers = new Map<string, typeof receive>()
  let snapshot: unknown,
    disconnected = false
  let prepareAdoption = () => {}
  let resolveCover = async (_handle: string | null): Promise<string | null> => null
  let providerSession = async (): Promise<RemoteProviderSession> => ({ providerId: 'ncm', loggedIn: false })
  const coreEvents: Record<string, unknown>[] = []
  const requestClients: string[] = []
  let query = async (request: CoreRequestEnvelope): Promise<unknown> => {
    if (request.name === 'player.presentation') return { cover: null }
    if (request.name === 'library.tracks')
      return { tracks: [track('D:/private-song')], offset: 0, total: 1, revision: 4 }
    if (request.name === 'library.byIds')
      return {
        tracks: (request.payload as { ids: string[] }).ids.map(track),
        offset: 0,
        total: 1,
        revision: 4
      }
    if (request.name === 'playlists.catalog')
      return { items: [{ id: 'mix', name: 'Mix', count: 2 }], total: 1, offset: 0, revision: 2 }
    if (request.name === 'playlists.view')
      return {
        revision: 2,
        page: {
          tracks: [track('one'), track('one')],
          entryIds: ['a', 'b'],
          total: 2,
          offset: 0,
          revision: 4
        }
      }
    if (request.name === 'queue.page')
      return {
        items: [{ position: 0, queueEntryId: 'occurrence-a', track: track('one') }],
        total: 2,
        offset: 0,
        revision: 7
      }
    return undefined
  }
  let privatePage: LibraryPage = {
    tracks: [
      {
        ...track('one'),
        filePath: 'D:/private.cue',
        cueRange: { startSeconds: 5, endSeconds: 10 }
      },
      { ...track('one'), source: 'network', filePath: 'private-network-source' }
    ],
    entryIds: ['a', 'b'],
    total: 2,
    offset: 0,
    revision: 4,
    versions: {}
  }
  const server = {
    setCommandHandler() {},
    setBrowseHandler() {},
    getStatus: () => ({
      running,
      enabled: running && mode === 'full',
      mediaOnly: running && mode === 'mediaOnly',
      pin
    }),
    start: async (_port: number, next: { mode: string }) => {
      running = true
      mode = next.mode
      starts.push(mode)
    },
    stop: async () => {
      running = false
      starts.push('stop')
    },
    rotatePin: () => {
      pin = '222222'
      return pin
    },
    updatePlaybackSnapshot: (value: unknown) => {
      snapshot = value
    },
    updateCoreStateEvent: (value: Record<string, unknown>) => coreEvents.push(value)
  }
  const application = {
    connect: (identity: CoreClientIdentity, send: typeof receive) => {
      identities.push(identity)
      receivers.set(identity.id, send)
      if (!receive) receive = send
      send({ kind: 'state', epoch: 'test', sequence: 0, snapshot: state })
    },
    disconnect: () => {
      disconnected = true
    },
    request: async (id: string, request: CoreRequestEnvelope) => {
      requests.push(request)
      requestClients.push(id)
      const reply = receivers.get(id)!
      try {
        reply({
          kind: 'response',
          requestId: request.requestId,
          epoch: request.epoch,
          ok: true,
          value: await query(request)
        })
      } catch (error) {
        reply({
          kind: 'response',
          requestId: request.requestId,
          epoch: request.epoch,
          ok: false,
          error: { code: (error as { code?: CoreErrorCode }).code ?? 'FAILED', message: String(error) }
        })
      }
    }
  }
  const service = new CoreRemoteService({
    server: server as never,
    settings: { read: () => settings, update: (patch) => Object.assign(settings, patch) },
    playback: {
      fromPages: async (produce, options) => {
        await produce(async (page) => {
          rows.push(...page)
        })
        prepareAdoption()
        await options?.beforeAdopt?.(options.play !== false)
        options?.guard?.()
        selected.push(
          typeof options?.selectedIndex === 'function'
            ? options.selectedIndex()
            : (options?.selectedIndex ?? 0)
        )
      },
      edit: async (...args) => {
        edits.push(args)
      },
      snapshot: () => state as never
    } satisfies Pick<CorePlaybackSession, 'fromPages' | 'edit' | 'snapshot'>,
    playlistRecords: async () => ({
      revision: 2,
      versionsRevision: 3,
      viewId: 'mix-view',
      page: privatePage
    }),
    castActive: () => castActive,
    resolveCover: (handle) => resolveCover(handle),
    providerSession: () => providerSession(),
    now: () => 123,
    failed: (error) => failures.push(error)
  })
  service.attach(application)
  t.after(() => service.shutdown())
  return {
    service,
    starts,
    requests,
    requestClients,
    identities,
    rows,
    edits,
    selected,
    failures,
    coreEvents,
    current: () => state,
    beforeAdopt(callback: () => void) {
      prepareAdoption = callback
    },
    cover(callback: typeof resolveCover) {
      resolveCover = callback
    },
    providerSession(callback: typeof providerSession) {
      providerSession = callback
    },
    snapshot: () => snapshot,
    disconnected: () => disconnected,
    cast(value: boolean) {
      castActive = value
    },
    state(value: CoreSnapshot) {
      state = value
      receive({ kind: 'state', epoch: value.epoch, sequence: 1, snapshot: value })
    },
    query(value: typeof query) {
      query = value
    },
    page(value: LibraryPage) {
      privatePage = value
    }
  }
}

test('explicit session queues require TLS, redact paths and fence every mutation without granting file or topology operations', async t => {
  const f = fixture(t, true)
  const target = { kind: 'zone', id: 'local', revision: 3 }, queue = { id: 'queue', revision: 7 }
  const rpc = (name: string, payload: unknown, command = false) => ({ requestId: crypto.randomUUID(), epoch: 'test', kind: command ? 'command' : 'query', name, payload })
  const payload = { target, queue, offset: 0, limit: 100 }
  f.query(async request => request.name === 'zones.queue.page' ? { total: 2, offset: 0, revision: 7, libraryRevision: 1,
    items: [{ position: 0, queueEntryId: 'first', track: { ...track('C:/private.flac'), filePath: 'C:/private.flac' } },
      { position: 1, queueEntryId: 'second', track: { ...track('C:/private.flac'), filePath: 'C:/private.flac' } }] } : {})
  assert.equal(code(await f.service.handleCoreRpc(rpc('zones.queue.page', payload), 'phone')), 'FORBIDDEN')
  const result = await f.service.handleCoreRpc(rpc('zones.queue.page', payload), 'phone', { encrypted: true })
  assert.equal(result.ok, true)
  assert.doesNotMatch(JSON.stringify(result), /C:|filePath|private.flac/)
  const page = result.value as { items: { track: { id: string }; queueEntryId: string }[] }
  assert.equal(page.items[0].track.id, page.items[1].track.id)
  assert.notEqual(page.items[0].queueEntryId, page.items[1].queueEntryId)
  const mutation = rpc('zones.queue.edit', { target, queue, edit: { kind: 'remove', entryIds: ['second'] } }, true)
  assert.equal((await f.service.handleCoreRpc(mutation, 'phone', { encrypted: true })).ok, true)
  assert.equal(code(await f.service.handleCoreRpc(mutation, 'phone', { encrypted: true })), 'OUTCOME_UNKNOWN')
  for (const edit of [{ kind: 'insert', items: [{ id: 'evil', snapshot: { filePath: 'C:/evil.flac' } }] }, { kind: 'mode', mode: 'heart' }])
    assert.equal(code(await f.service.handleCoreRpc(rpc('zones.queue.edit', { target, queue, edit }, true), 'phone', { encrypted: true })), 'INVALID_REQUEST')
  for (const value of [
    { target: { ...target, id: 'other-pc' }, queue, offset: 0 },
    { ...payload, limit: 201 }, { ...payload, filePath: 'C:/evil' }
  ]) assert.equal(code(await f.service.handleCoreRpc(rpc('zones.queue.page', value), 'phone', { encrypted: true })), 'INVALID_REQUEST')
  const load = { target, queue: null, play: false, selection: { kind: 'catalog', revision: 4, sourceIds: ['source-one', 'source-one'] } }
  assert.equal((await f.service.handleCoreRpc(rpc('zones.queue.load', load, true), 'phone', { encrypted: true })).ok, true)
  assert.deepEqual(f.requests.at(-1)!.payload, load)
  assert.equal(code(await f.service.handleCoreRpc(rpc('zones.queue.load', { ...load, selection: { ...load.selection, sourceIds: Array(201).fill('one') } }, true), 'phone', { encrypted: true })), 'INVALID_REQUEST')
})

test('DSP library uses separate paired-device owners, keeps upload receipts and rejects host paths before dispatch', async t => {
  const f = fixture(t, true)
  await turn()
  f.query(async request => request.name === 'zones.dsp.upload.begin' ? { uploadId: 'upload', chunkBytes: 1024 } : {})
  const begin = () => command('zones.dsp.upload.begin', { zoneId: 'local', kind: 'impulseResponse', fileName: 'room.wav', byteSize: 128 })
  assert.equal(code(await f.service.handleCoreRpc(begin())), 'FORBIDDEN')
  assert.equal(code(await f.service.handleCoreRpc(begin(), 'phone', { encrypted: false })), 'FORBIDDEN')
  const response = await f.service.handleCoreRpc(begin(), 'phone', { encrypted: true })
  assert.deepEqual((response.value as { result: unknown }).result, { uploadId: 'upload', chunkBytes: 1024 })
  const phone = f.requestClients.at(-1)
  await f.service.handleCoreRpc(begin(), 'tablet', { encrypted: true })
  assert.notEqual(phone, f.requestClients.at(-1))
  assert.deepEqual(f.identities.at(-1)?.permissions, ['settings:read', 'settings:write'])
  const count = f.requests.length
  assert.equal(code(await f.service.handleCoreRpc(command('zones.dsp.library.edit', {
    zoneId: 'local', revision: 1, edit: { kind: 'scan', paths: ['C:/private'] }
  }), 'phone', { encrypted: true })), 'INVALID_REQUEST')
  assert.equal(f.requests.length, count)
})

test('profile transfer and parameter operations require TLS and bounded identities, never host paths', async t => {
  const f = fixture(t, true); await turn()
  f.query(async () => ({}))
  for (const name of ['zones.dsp.profile.preview', 'zones.dsp.profile.import', 'zones.dsp.profile.export', 'zones.dsp.profile.release'])
    assert.equal(code(await f.service.handleCoreRpc(command(name, { zoneId: 'local' }), 'phone', { encrypted: false })), 'FORBIDDEN')
  const parameter = { zoneId: 'local', revision: 1, edit: { kind: 'parameter', sceneId: 'scene', nodeId: 'node', parameterId: 1, value: 0.5 } }
  assert.equal((await f.service.handleCoreRpc(command('zones.dsp.library.edit', parameter), 'phone', { encrypted: true })).ok, true)
  for (const value of [-0.1, 1.1, '0.5']) assert.equal(code(await f.service.handleCoreRpc(command('zones.dsp.library.edit', {
    ...parameter, edit: { ...parameter.edit, value }
  }), 'phone', { encrypted: true })), 'INVALID_REQUEST')
  assert.equal(code(await f.service.handleCoreRpc(rpc('zones.dsp.profile.chunk', { zoneId: 'local', downloadId: 'download', offset: 0, path: 'C:/secret' }), 'phone', { encrypted: true })), 'INVALID_REQUEST')
  assert.equal(code(await f.service.handleCoreRpc(rpc('zones.dsp.parameters', { zoneId: 'local', revision: 1, sceneId: 'scene', nodeId: 'node', offset: -1 }), 'phone', { encrypted: true })), 'INVALID_REQUEST')
})

test('authorized DSP control is encrypted, bounded, path-free and cannot enable a Bridge host', async t => {
  const f = fixture(t, true)
  f.query(async request => {
    if (request.name === 'audio.dsp') return { revision: 6, processing: { eqPreamp: -6, convolverIrPath: 'private-path' },
      scenes: { scenes: [{ id: 'room', name: 'Room', enabled: true, graph: { path: 'private-path' } }], activeSceneId: 'room', pinnedSceneId: 'room' } }
    if (request.name === 'zones.state') return { revision: 2, selectedOutputId: 'bridge', outputs: [{ id: 'bridge', name: 'USB DAC' }] }
    return {}
  })
  const secure = { encrypted: true, serverId: 'desktop-a' }
  assert.equal(code(await f.service.handleCoreRpc(rpc('audio.dsp'))), 'FORBIDDEN')
  const state = await f.service.handleCoreRpc(rpc('audio.dsp'), 'phone', secure)
  assert.equal(state.ok, true); assert.doesNotMatch(JSON.stringify(state), /private-path/)
  const edit = command('audio.dsp.edit', { revision: 6, edit: { kind: 'processing', settings: { eqPreamp: -9 } } })
  assert.equal((await f.service.handleCoreRpc(edit, 'phone', secure)).ok, true)
  assert.equal(f.requests.at(-1)?.name, 'audio.dsp.edit')
  const injected = command('audio.dsp.edit', { revision: 6, edit: { kind: 'processing', settings: { convolverIrPath: 'injected' } } })
  assert.equal(code(await f.service.handleCoreRpc(injected, 'phone', secure)), 'INVALID_REQUEST')
  assert.equal(code(await f.service.handleCoreRpc(command('bridge.host', { revision: 0, enabled: true, sampleRate: 48000 }), 'phone', secure)), 'FORBIDDEN')
  assert.equal((await f.service.handleCoreRpc(command('zones.select', { revision: 2, outputId: 'bridge' }), 'phone', secure)).ok, true)
})

test('named Zones require authenticated TLS, redact track paths and cannot grant desktop lifecycle consent', async t => {
  const f = fixture(t, true), zoneId = 'zone-11111111-1111-4111-8111-111111111111'
  f.query(async request => {
    if (request.name === 'zones.list') return { revision: 0, limit: 4, error: null, zones: [{ id: zoneId, name: 'Study', revision: 3,
      track: { ...track('D:/secret.flac'), filePath: 'D:/secret.flac' }, queue: null, output: null, error: null,
      playback: { state: 'paused', upcomingTrack: { ...track('D:/next.flac'), filePath: 'D:/next.flac' } } }] }
    if (request.name === 'zones.dsp') return { revision: 2, processing: { eqPreamp: -6, convolverIrPath: 'D:/private.wav' },
      scenes: { scenes: [], activeSceneId: null, pinnedSceneId: null } }
    return {}
  })
  const secure = { encrypted: true }
  for (const [principal, context] of [[undefined, secure], ['phone', undefined], ['phone', { encrypted: false }]] as const)
    assert.equal(code(await f.service.handleCoreRpc(rpc('zones.list'), principal, context)), 'FORBIDDEN')
  const list = await f.service.handleCoreRpc(rpc('zones.list'), 'phone', secure)
  assert.equal(list.ok, true); assert.doesNotMatch(JSON.stringify(list), /D:|secret.flac|next.flac|filePath/)
  const dsp = await f.service.handleCoreRpc(rpc('zones.dsp', { zoneId }), 'phone', secure)
  assert.equal(dsp.ok, true); assert.doesNotMatch(JSON.stringify(dsp), /private.wav/)
  assert.equal((await f.service.handleCoreRpc(command('zones.transport', { zoneId, revision: 3, action: { kind: 'pause' } }), 'phone', secure)).ok, true)
  assert.deepEqual(f.requests.at(-1)?.payload, { zoneId, revision: 3, action: { kind: 'pause' } })
  assert.equal((await f.service.handleCoreRpc(command('zones.transport', { zoneId, revision: null, action: { kind: 'stop' } }), 'phone', secure)).ok, true)
  const handoff = { source: { zoneId: 'local', revision: 0, queue: { id: 'source-q', revision: 2, occurrenceId: 'second' } },
    target: { zoneId, revision: 4, queue: null }, replace: false, resume: false }
  assert.equal(code(await f.service.handleCoreRpc(command('zones.handoff', handoff), 'phone')), 'FORBIDDEN')
  assert.equal((await f.service.handleCoreRpc(command('zones.handoff', handoff), 'phone', secure)).ok, true)
  assert.deepEqual(f.requests.at(-1)?.payload, handoff)
  for (const name of ['zones.create', 'zones.connect', 'zones.remove'])
    assert.equal(code(await f.service.handleCoreRpc(command(name, { zoneId, revision: 3 }), 'phone', secure)), 'FORBIDDEN')
  assert.equal(code(await f.service.handleCoreRpc(command('zones.dsp.edit', { zoneId, revision: 2,
    edit: { kind: 'processing', settings: { convolverIrPath: 'D:/inject.wav' } } }), 'phone', secure)), 'INVALID_REQUEST')
})

test('groups require authenticated TLS and project shared media without private paths', async t => {
  const f = fixture(t, true), groupId = 'group-11111111-1111-4111-8111-111111111111'
  const zoneId = 'zone-22222222-2222-4222-8222-222222222222'
  f.query(async request => {
    if (request.name === 'groups.list') return { revision: 2, error: null, groups: [{ id: groupId, name: 'Music', revision: 0,
      members: [{ zoneId: 'local', downstreamDelayMs: 0 }, { zoneId, downstreamDelayMs: 3 }],
      track: { ...track('D:/private.flac'), filePath: 'D:/private.flac' }, playback: { state: 'paused',
        upcomingTrack: { ...track('D:/next.flac'), filePath: 'D:/next.flac' } }, queue: null, coordination: null, error: null }] }
    if (request.name === 'groups.create') return { id: groupId }
    return {}
  })
  for (const context of [undefined, { encrypted: false }]) {
    assert.equal(code(await f.service.handleCoreRpc(rpc('groups.list'), 'phone', context)), 'FORBIDDEN')
    assert.equal(code(await f.service.handleCoreRpc(command('groups.transport', { groupId, revision: null, action: { kind: 'pause' } }), 'phone', context)), 'FORBIDDEN')
  }
  assert.equal(code(await f.service.handleCoreRpc(rpc('groups.list'), undefined, { encrypted: true })), 'FORBIDDEN')
  const list = await f.service.handleCoreRpc(rpc('groups.list'), 'phone', { encrypted: true })
  assert.equal(list.ok, true); assert.doesNotMatch(JSON.stringify(list), /D:|private.flac|next.flac|filePath/)
  const payload = { revision: 2, name: 'Music', members: [{ zoneId: 'local', revision: 0, downstreamDelayMs: 0 },
    { zoneId, revision: 1, downstreamDelayMs: 3 }], source: { zoneId, queue: { id: 'queue', revision: 0, occurrenceId: 'a:2' } } }
  const created = await f.service.handleCoreRpc(command('groups.create', payload), 'phone', { encrypted: true })
  assert.equal(created.ok, true); assert.equal((created.value as { id: string }).id, groupId)
  assert.equal(code(await f.service.handleCoreRpc(command('groups.create', { ...payload, filePath: 'injected' }), 'phone', { encrypted: true })), 'INVALID_REQUEST')
  assert.equal((await f.service.handleCoreRpc(command('groups.transport', { groupId, revision: null, action: { kind: 'stop' } }), 'phone', { encrypted: true })).ok, true)
})

test('LAN stays disabled by default and remote toggles share the Cast media server', async (t) => {
  const f = fixture(t)
  await turn()
  assert.deepEqual(f.starts, ['stop'])
  assert.deepEqual(f.identities[0].permissions, ['playback:read', 'playback:write', 'library:read', 'settings:read', 'settings:write'])
  assert.equal((await f.service.setEnabled(true)).enabled, true)
  f.cast(true)
  assert.equal((await f.service.setEnabled(false)).mediaOnly, true)
  f.cast(false)
  await f.service.sync(true)
  assert.deepEqual(f.starts, ['stop', 'full', 'mediaOnly', 'stop'])
  assert.equal(f.service.rotatePin().pin, '222222')
  assert.deepEqual(f.failures, [])
})

test('renderer-free browsing issues opaque bounded identities and native Core transport commands', async (t) => {
  const f = fixture(t, true)
  await turn()
  const page = await f.service.browse({ view: 'library', query: 'album', offset: 0, limit: 40 })
  assert.doesNotMatch(JSON.stringify(page), /D:\/private/)
  await f.service.command({ action: 'playTrack', id: page.items[0].id })
  assert.deepEqual(f.requests.at(-1)?.payload, {
    query: { search: 'album', searchLiteral: true, sort: 'insertion', direction: 'asc' },
    selectedId: 'D:/private-song'
  })
  await f.service.command({ action: 'pause' })
  assert.equal(f.requests.at(-1)?.name, 'playback.pause')
  const calls = f.requests.length
  await assert.rejects(
    f.service.command({ action: 'removeQueue', index: 0, revision: 6 }),
    /queue_changed/
  )
  assert.equal(f.requests.length, calls)
  await f.service.command({ action: 'removeQueue', index: 0, revision: 7 })
  assert.deepEqual(f.requests.at(-1)?.payload, {
    id: 'queue',
    revision: 7,
    edit: { kind: 'remove', entryIds: ['occurrence-a'] }
  })
  assert.equal((f.snapshot() as { playMode: string }).playMode, 'shuffle')
})

test('mixed playlist playback keeps private sources, CUE and repeated occurrence selection in Core', async (t) => {
  const f = fixture(t, true)
  await turn()
  const lists = await f.service.browse({ view: 'playlists', query: '', offset: 0, limit: 40 })
  const members = await f.service.browse({
    view: 'playlists',
    playlistId: lists.items[0].id,
    query: '',
    offset: 0,
    limit: 40
  })
  await f.service.command({ action: 'playTrack', id: members.items[1].id })
  assert.deepEqual(f.selected, [1])
  assert.equal(
    (f.rows[0] as { localSnapshot: { filePath: string } }).localSnapshot.filePath,
    'D:/private.cue'
  )
  assert.equal(
    (f.rows[1] as { snapshot: { filePath: string } }).snapshot.filePath,
    'private-network-source'
  )
  assert.doesNotMatch(JSON.stringify(members), /private/)
  await f.service.command({ action: 'enqueueTrack', id: members.items[1].id })
  assert.equal(f.edits.length, 1)
  await f.service.shutdown()
  assert.equal(f.disconnected(), true)
  await assert.rejects(f.service.command({ action: 'play' }), /core_not_ready/)
})

test('Roon-style Core RPC bridge translates mobile CoreRequestEnvelope queries and commands', async (t) => {
  const f = fixture(t, true)
  await turn()
  const snapRes = await f.service.handleCoreRpc({
    requestId: 'req-1',
    epoch: 'epoch-boot',
    kind: 'query',
    name: 'core.getSnapshot',
    payload: {}
  })
  assert.equal(snapRes.ok, true)
  assert.equal(snapRes.epoch, 'test')
  assert.equal((snapRes.value as { playback: { playMode: string } }).playback.playMode, 'shuffle')

  const winRes = await f.service.handleCoreRpc({
    requestId: 'req-2',
    epoch: 'test',
    kind: 'query',
    name: 'playback.getQueueWindow',
    payload: { offset: 0, limit: 10 }
  })
  assert.equal(winRes.ok, true)
  assert.equal((winRes.value as { limit: number }).limit, 10)
  assert.equal(
    (winRes.value as { items: Array<{ occurrenceId: string }> }).items[0].occurrenceId,
    'occurrence-a'
  )

  const searchRes = await f.service.handleCoreRpc({
    requestId: 'req-3',
    epoch: 'test',
    kind: 'query',
    name: 'search.songs',
    payload: { query: 'Song' }
  })
  assert.equal(searchRes.ok, true)
  assert.equal((searchRes.value as { total: number }).total, 1)

  const modeRes = await f.service.handleCoreRpc({
    requestId: 'req-4',
    epoch: 'test',
    kind: 'command',
    name: 'playback.setPlayMode',
    payload: { mode: 'single' }
  })
  assert.equal(modeRes.ok, true)
  assert.equal(f.requests.at(-1)?.name, 'playback.mode')
  assert.deepEqual(f.requests.at(-1)?.payload, { mode: 'repeat' })
})

let rpcSerial = 0
function rpc(
  name: string,
  payload: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
) {
  return {
    requestId: `mobile-${++rpcSerial}`,
    epoch: 'test',
    kind: 'query',
    name,
    payload,
    ...extra
  }
}
function command(
  name: string,
  payload: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
) {
  return rpc(name, payload, { kind: 'command', ...extra })
}
function code(response: Record<string, unknown>) {
  return (response.error as { code?: string } | undefined)?.code
}
async function search(f: ReturnType<typeof fixture>) {
  const result = await f.service.handleCoreRpc(rpc('search.songs', { query: '' }))
  assert.equal(result.ok, true)
  return (result.value as { items: Array<{ id: string }> }).items
}

test('mobile selection resolves issued references in Core and preserves order, repeats and paused intent', async (t) => {
  const f = fixture(t, true)
  const [track] = await search(f)
  assert.match(track.id, /^remote-track:/)
  assert.doesNotMatch(track.id, /private|D:/)
  const result = await f.service.handleCoreRpc(
    command(
      'playback.replaceQueue',
      {
        id: 'default',
        expectedRevision: 7,
        startIndex: 1,
        play: false,
        tracks: [
          { ...track, title: 'untrusted', source: 'http://attacker', filePath: 'D:/injected.flac' },
          track
        ]
      },
      { expectedRevision: 7 }
    )
  )
  assert.equal(result.ok, true)
  assert.deepEqual(f.rows, [{ id: 'D:/private-song' }, { id: 'D:/private-song' }])
  assert.deepEqual(f.selected, [1])
  assert.equal(f.requests.filter((r) => r.name === 'library.byIds').length, 1)
  assert.doesNotMatch(JSON.stringify(result), /private|injected|attacker/)
})

test('queue mutations reject missing, conflicting and stale revisions without dispatch', async (t) => {
  const f = fixture(t, true)
  const [track] = await search(f)
  for (const [payload, extra, expected] of [
    [{ tracks: [track] }, {}, 'INVALID_REQUEST'],
    [{ tracks: [track], expectedRevision: 6 }, {}, 'STALE_REVISION'],
    [{ tracks: [track], expectedRevision: 7 }, { expectedRevision: 6 }, 'INVALID_REQUEST'],
    [{ tracks: [track], expectedRevision: 7 }, { epoch: 'retired-core' }, 'STALE_EPOCH'],
    [{ id: 'other-queue', tracks: [track], expectedRevision: 7 }, {}, 'STALE_REVISION']
  ] as const) {
    const before = f.requests.length
    assert.equal(
      code(await f.service.handleCoreRpc(command('playback.replaceQueue', payload, extra))),
      expected
    )
    assert.equal(f.requests.length, before)
  }
  assert.deepEqual(f.selected, [])
})

test('queue replacement rejects arbitrary IDs and missing or unsupported sources before adoption', async (t) => {
  const f = fixture(t, true)
  const [track] = await search(f)
  assert.equal(
    code(
      await f.service.handleCoreRpc(
        command('playback.replaceQueue', {
          tracks: [{ id: 'D:/private-song', source: 'local' }],
          expectedRevision: 7
        })
      )
    ),
    'NOT_FOUND'
  )
  f.query(async () => ({ tracks: [], revision: 4, total: 0, offset: 0 }))
  assert.equal(
    code(
      await f.service.handleCoreRpc(
        command('playback.replaceQueue', {
          tracks: [track],
          expectedRevision: 7
        })
      )
    ),
    'NOT_FOUND'
  )
  f.query(async () => ({
    tracks: [{ id: 'D:/private-song', source: 'network' }],
    revision: 4,
    total: 1,
    offset: 0
  }))
  assert.equal(
    code(
      await f.service.handleCoreRpc(
        command('playback.replaceQueue', {
          tracks: [track],
          expectedRevision: 7
        })
      )
    ),
    'UNSUPPORTED_CAPABILITY'
  )
  assert.deepEqual(f.selected, [])
})

test('queue changes while resolving tracks or immediately before adoption do not overwrite the new queue', async (t) => {
  for (const timing of ['read', 'adopt']) {
    const f = fixture(t, true)
    const [track] = await search(f)
    const change = () => f.state({ ...f.current(), queue: { ...f.current().queue!, revision: 8 } })
    if (timing === 'read')
      f.query(async () => {
        change()
        return {
          tracks: [{ id: 'D:/private-song', source: 'local' }],
          revision: 4,
          offset: 0,
          total: 1
        }
      })
    else f.beforeAdopt(change)
    assert.equal(
      code(
        await f.service.handleCoreRpc(
          command('playback.replaceQueue', {
            tracks: [track],
            expectedRevision: 7
          })
        )
      ),
      'STALE_REVISION',
      timing
    )
    assert.deepEqual(f.selected, [], timing)
  }
})

test('mobile queue selection forwards the observed occurrence and revision instead of choosing a new one', async (t) => {
  const f = fixture(t, true)
  await turn()
  const request = command(
    'playback.selectQueueIndex',
    {
      id: 'queue',
      revision: 7,
      index: 1,
      occurrenceId: 'second-occurrence'
    },
    { expectedRevision: 7 }
  )
  assert.equal((await f.service.handleCoreRpc(request)).ok, true)
  assert.equal(f.requests.at(-1)?.name, 'queue.select')
  assert.equal(f.requests.at(-1)?.epoch, 'test')
  assert.deepEqual(f.requests.at(-1)?.payload, {
    id: 'queue',
    revision: 7,
    index: 1,
    occurrenceId: 'second-occurrence'
  })
  const before = f.requests.length
  assert.equal(
    code(
      await f.service.handleCoreRpc(
        command('playback.selectQueueIndex', {
          revision: 6,
          index: 1,
          occurrenceId: 'second-occurrence'
        })
      )
    ),
    'STALE_REVISION'
  )
  assert.equal(f.requests.length, before)
})

test('a retried command ID is never dispatched a second time, including overlapping retries', async (t) => {
  const f = fixture(t, true)
  await turn()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.query(async (request) => {
    assert.equal(request.name, 'playback.next')
    entered()
    await gate
  })
  const first = f.service.handleCoreRpc(command('playback.next', {}, { commandId: 'one-intent' }))
  await started
  try {
    assert.equal(
      code(
        await f.service.handleCoreRpc(command('playback.next', {}, { commandId: 'one-intent' }))
      ),
      'OUTCOME_UNKNOWN'
    )
  } finally {
    release()
  }
  assert.equal((await first).ok, true)
  assert.equal(f.requests.filter((r) => r.name === 'playback.next').length, 1)
})

test('bridge exposes only bounded public operations and rejects malformed envelopes', async (t) => {
  const f = fixture(t, true)
  await turn()
  const before = f.requests.length
  for (const name of [
    'settings.state',
    'library.paths.lookup',
    'library.byIds',
    'metadata.entity.override',
    'library.syncTracks',
    'queue.submit',
    'plugins.list'
  ]) {
    assert.equal(code(await f.service.handleCoreRpc(rpc(name))), 'FORBIDDEN', name)
  }
  for (const request of [
    rpc('search.songs', { query: '', limit: 201 }),
    rpc('search.songs', { query: '', offset: -1 }),
    rpc('search.songs', { query: '', folder: 'D:/music' }),
    rpc('search.songs', {}, { protocolVersion: '1' }),
    rpc('search.songs', {}, { targetId: '' }),
    rpc('search.songs', {}, { kind: 'cancel' }),
    rpc('search.songs', {}, { role: 'desktop' }),
    rpc('search.songs', {}, { requestId: '' }),
    command('playback.setVolume', { volume: 2 }),
    command('playback.setPlayMode', { mode: 'invalid' })
  ])
    assert.equal(code(await f.service.handleCoreRpc(request)), 'INVALID_REQUEST')
  assert.equal(f.requests.length, before)
  assert.equal(
    (await f.service.handleCoreRpc(rpc('search.songs', { query: '', offset: 100, limit: 20 }))).ok,
    true
  )
  assert.deepEqual(f.requests.at(-1)?.payload, {
    search: '',
    searchLiteral: true,
    sort: 'insertion',
    direction: 'asc',
    offset: 100,
    limit: 20
  })
})

test('version negotiation, target and zone are checked before any Core request', async (t) => {
  const f = fixture(t, true)
  await turn()
  const before = f.requests.length
  const desktop = { encrypted: true, serverId: 'desktop-a' }
  for (const [extra, expected] of [
    [{ protocolVersion: 0 }, 'UNSUPPORTED_PROTOCOL'],
    [{ protocolVersion: REMOTE_CORE_PROTOCOL_RANGE.max + 1 }, 'UNSUPPORTED_PROTOCOL'],
    [{ targetId: 'desktop-b' }, 'WRONG_TARGET'],
    [{ zoneId: 'kitchen' }, 'UNKNOWN_ZONE']
  ] as const)
    assert.equal(code(await f.service.handleCoreRpc(rpc('search.songs', { query: '' }, extra), undefined, desktop)), expected)
  // Without a server identity no target can be confirmed.
  assert.equal(code(await f.service.handleCoreRpc(rpc('search.songs', { query: '' }, { targetId: 'desktop-a' }))), 'WRONG_TARGET')
  assert.equal(f.requests.length, before)
  for (const extra of [{}, { protocolVersion: 1, targetId: 'desktop-a', zoneId: REMOTE_CORE_LOCAL_ZONE }])
    assert.equal((await f.service.handleCoreRpc(rpc('search.songs', { query: '' }, extra), undefined, desktop)).ok, true)
  assert.equal(negotiateRemoteProtocol({ min: 1, max: 3 }, { min: 1, max: 2 }), 2)
  assert.equal(negotiateRemoteProtocol({ min: 1, max: 1 }, { min: 1, max: 2 }), 1)
  assert.equal(negotiateRemoteProtocol({ min: 3, max: 4 }, { min: 1, max: 2 }), null)
})

test('RPC and SSE use the same Android-compatible, path-free track projection', async (t) => {
  const f = fixture(t, true)
  f.state({
    ...f.current(),
    error: 'C:/private/secret.flac',
    track: {
      ...track('C:/private/song.flac'),
      ncmSongId: 123,
      artists: [{ id: 1, name: 'Correct Artist' }],
      subTrack: 'C:/private/disc.cue'
    }
  } as unknown as CoreSnapshot)
  const response = await f.service.handleCoreRpc(
    rpc('core.getSnapshot', {}, { epoch: 'epoch-boot' })
  )
  const value = response.value as { track: { id: string; artists: string[]; ncmSongId: string } }
  assert.deepEqual(value.track.artists, ['Correct Artist'])
  assert.equal(value.track.ncmSongId, '123')
  assert.doesNotMatch(JSON.stringify(response), /C:|private|secret|subTrack/)
  assert.deepEqual(f.coreEvents.at(-1)?.snapshot, value)
})

test('restarting Core and rotating the pairing PIN invalidate compatibility references', async (t) => {
  const f = fixture(t, true)
  const [first] = await search(f)
  const cached = f.coreEvents.at(-1)?.snapshot as { track: { id: string } }
  f.service.rotatePin()
  const fresh = await f.service.handleCoreRpc(rpc('core.getSnapshot'))
  assert.notEqual((fresh.value as { track: { id: string } }).track.id, cached.track.id)
  assert.deepEqual(f.coreEvents.at(-1)?.snapshot, fresh.value)
  assert.equal(
    code(
      await f.service.handleCoreRpc(
        command('playback.replaceQueue', {
          tracks: [first],
          expectedRevision: 7
        })
      )
    ),
    'NOT_FOUND'
  )
  const [second] = await search(f)
  f.state({ ...f.current(), epoch: 'new-core' })
  assert.equal(
    code(
      await f.service.handleCoreRpc(
        command(
          'playback.replaceQueue',
          {
            tracks: [second],
            expectedRevision: 7
          },
          { epoch: 'new-core' }
        )
      )
    ),
    'NOT_FOUND'
  )
  assert.deepEqual(f.selected, [])
})

test('catalog IDs and approved metadata remain readable without exposing source paths or artwork grants', async (t) => {
  const f = fixture(t, true)
  await turn()
  const read: string[] = []
  f.cover(async (handle) => {
    read.push(handle!)
    return 'data:image/png;base64,preview'
  })
  f.query(async (request) => {
    if (request.name === 'catalog.query')
      return {
        revision: 5,
        total: 1,
        offset: 0,
        items: [
          {
            id: 'artist-entity',
            kind: 'artist',
            title: 'Corrected Name',
            artist: '',
            identity: 'source',
            sourceCount: 1
          }
        ]
      }
    if (request.name === 'catalog.sources')
      return {
        revision: 5,
        total: 1,
        offset: 0,
        items: [
          {
            id: 'source-stable-id',
            provider: 'local',
            recordingId: 'recording-id',
            releaseId: 'release-id',
            availability: 'indexed',
            inLibrary: true,
            preferred: true,
            track: { ...track('private'), filePath: 'D:/private.flac', subTrack: 'D:/private.cue' }
          }
        ]
      }
    if (request.name === 'metadata.entity.detail')
      return {
        entityId: 'artist-entity',
        targetId: 'matched-artist',
        revision: 9,
        name: 'Corrected Name',
        introduction: {
          value: 'User correction',
          language: 'zh-Hans',
          origin: 'manual',
          attribution: null
        },
        manualArtwork: { dataUrl: 'data:image/png;base64,manual' },
        artworkOverride: { mode: 'value' },
        facts: [],
        imports: [{ credentials: 'do-not-export' }],
        artwork: [
          {
            handle: 'twilight-media://image/private-grant',
            scope: 'artist',
            targetRef: { provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: 'artist' },
            attribution: { provider: 'public-artwork', license: 'CC-BY' },
            usage: {
              display: true,
              cache: false,
              crossSource: true,
              export: false,
              expiresAt: 12345
            }
          }
        ]
      }
    throw new Error('Unexpected request')
  })
  const artists = await f.service.handleCoreRpc(rpc('catalog.query', { kind: 'artist', limit: 20 }))
  assert.equal(artists.ok, true)
  assert.deepEqual(f.requests.at(-1)?.payload, { kind: 'artist', limit: 20, scope: 'library' })
  assert.equal(
    code(await f.service.handleCoreRpc(rpc('catalog.query', { kind: 'artist', scope: 'all' }))),
    'FORBIDDEN'
  )
  const sources = await f.service.handleCoreRpc(
    rpc('catalog.sources', { entityId: 'recording-id' })
  )
  assert.equal(sources.ok, true)
  assert.doesNotMatch(JSON.stringify(sources), /private|subTrack|remote-track/)
  const detail = await f.service.handleCoreRpc(
    rpc('metadata.entity.detail', { entityId: 'artist-entity', language: 'zh-Hans' })
  )
  assert.equal(detail.ok, true)
  const view = detail.value as {
    introduction: { value: string }
    artwork: Array<{ usage: { cache: boolean }; dataUrl: string }>
    manualArtwork: { dataUrl: string }
    artworkOverride: { mode: string }
  }
  assert.equal(view.introduction.value, 'User correction')
  assert.equal(view.artwork[0].usage.cache, false)
  assert.match(view.artwork[0].dataUrl, /^data:image/)
  assert.equal(view.manualArtwork.dataUrl, 'data:image/png;base64,preview')
  assert.equal(view.artworkOverride.mode, 'value')
  assert.deepEqual(read, ['twilight-media://image/private-grant', 'data:image/png;base64,manual'])
  assert.doesNotMatch(JSON.stringify(detail), /private-grant|imports|credentials|do-not-export/)
})

test('library artwork resolves issued references and bounded previews rather than client paths', async (t) => {
  const f = fixture(t, true)
  const [track] = await search(f)
  f.cover(async () => 'data:image/webp;base64,preview')
  f.query(async (request) => {
    assert.equal(request.name, 'library.artwork')
    assert.deepEqual(request.payload, { ids: ['D:/private-song'] })
    return { revision: 4, items: [{ id: 'D:/private-song', cover: 'cover://private.png' }] }
  })
  const response = await f.service.handleCoreRpc(rpc('library.artwork', { ids: [track.id] }))
  assert.equal(response.ok, true)
  assert.deepEqual(response.value, {
    revision: 4,
    items: [{ id: track.id, cover: 'data:image/webp;base64,preview' }]
  })
  assert.equal(
    code(await f.service.handleCoreRpc(rpc('library.artwork', { ids: ['file:///private.png'] }))),
    'NOT_FOUND'
  )
  assert.equal(
    code(await f.service.handleCoreRpc(rpc('library.artwork', { ids: Array(9).fill(track.id) }))),
    'INVALID_REQUEST'
  )
})

test('errors from native or storage code never expose paths or credentials to the network', async (t) => {
  const f = fixture(t, true)
  await turn()
  f.query(async () => {
    throw new Error('D:/private/secret.flac token=credential')
  })
  const result = await f.service.handleCoreRpc(command('playback.play'))
  assert.equal(code(result), 'FAILED')
  assert.doesNotMatch(JSON.stringify(result), /private|secret|credential|D:/)
  assert.equal(f.failures.length, 1)
})

test('provider sessions require authenticated transport encryption, not caller assertions', async t => {
  const f = fixture(t, true)
  let reads = 0
  f.providerSession(async () => {
    reads++
    return { providerId: 'ncm', loggedIn: true, cookie: 'MUSIC_U=test-secret' }
  })
  const query = () => rpc('providers.session', { providerId: 'ncm' })
  for (const [principal, context] of [[undefined, { encrypted: true }], ['phone', undefined],
    ['phone', { encrypted: false }]] as const) {
    assert.equal(code(await f.service.handleCoreRpc(query(), principal, context)), 'FORBIDDEN')
  }
  assert.equal(code(await f.service.handleCoreRpc(
    rpc('providers.session', { providerId: 'ncm', encrypted: true }), 'phone', { encrypted: true })), 'INVALID_REQUEST')
  assert.equal(reads, 0)
  const result = await f.service.handleCoreRpc(query(), 'phone', { encrypted: true })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { providerId: 'ncm', loggedIn: true, cookie: 'MUSIC_U=test-secret' })
  assert.equal(reads, 1)
  assert.ok(!f.requests.some(request => String(request.name) === 'providers.session'))
  assert.ok(!JSON.stringify(f.coreEvents).includes('test-secret'))
})

test('provider sessions are ncm-only and never include unrelated settings or signed-out cookies', async t => {
  const f = fixture(t, true)
  for (const payload of [{}, { providerId: '' }, { providerId: 3 }, { providerId: 'ncm', key: 'cookie' }]) {
    assert.equal(code(await f.service.handleCoreRpc(rpc('providers.session', payload), 'phone', { encrypted: true })), 'INVALID_REQUEST')
  }
  assert.equal(code(await f.service.handleCoreRpc(rpc('providers.session', { providerId: 'other' }),
    'phone', { encrypted: true })), 'UNSUPPORTED_CAPABILITY')
  f.providerSession(async () => ({ providerId: 'ncm', loggedIn: false, cookie: 'MUSIC_U=stale-secret' }))
  const result = await f.service.handleCoreRpc(rpc('providers.session', { providerId: 'ncm' }), 'phone', { encrypted: true })
  assert.deepEqual(result.value, { providerId: 'ncm', loggedIn: false })
  assert.doesNotMatch(JSON.stringify(result), /cookie|stale-secret/)
  f.providerSession(async () => ({ providerId: 'ncm', loggedIn: true, cookie: 'MUSIC_U=current', profile: 'private' } as RemoteProviderSession))
  const signedIn = await f.service.handleCoreRpc(rpc('providers.session', { providerId: 'ncm' }), 'phone', { encrypted: true })
  assert.doesNotMatch(JSON.stringify(signedIn), /profile|private/)
})

test('credential-read failures cannot leak the original exception into network replies or logs', async t => {
  const f = fixture(t, true)
  f.providerSession(async () => { throw new Error('MUSIC_U=secret-from-keyring') })
  const result = await f.service.handleCoreRpc(rpc('providers.session', { providerId: 'ncm' }), 'phone', { encrypted: true })
  assert.equal(code(result), 'FAILED')
  assert.doesNotMatch(JSON.stringify(result), /MUSIC_U|secret-from-keyring/)
  assert.equal(f.failures.length, 1)
  assert.doesNotMatch(String(f.failures[0]), /MUSIC_U|secret-from-keyring/)
})

test('stable catalog playback uses the native source and catalog revision contract', async (t) => {
  const f = fixture(t, true)
  await turn()
  const result = await f.service.handleCoreRpc(
    command('catalog.play', {
      sourceId: 'source-stable-id',
      revision: 5
    })
  )
  assert.equal(result.ok, true)
  assert.equal(f.requests.at(-1)?.name, 'catalog.play')
  assert.equal(f.requests.at(-1)?.epoch, 'test')
  assert.deepEqual(f.requests.at(-1)?.payload, { sourceId: 'source-stable-id', revision: 5 })
  const before = f.requests.length
  assert.equal(
    code(
      await f.service.handleCoreRpc(
        command('catalog.play', {
          sourceId: 'source-stable-id',
          revision: 5,
          filePath: 'D:/injected.flac'
        })
      )
    ),
    'INVALID_REQUEST'
  )
  assert.equal(f.requests.length, before)
})

test('bridge bounds outstanding requests and releases capacity after failures', async (t) => {
  const f = fixture(t, true)
  await turn()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.query(async () => {
    await gate
    throw new Error('database unavailable')
  })
  const pending = Array.from({ length: 8 }, () => f.service.handleCoreRpc(rpc('search.songs')))
  try {
    assert.equal(code(await f.service.handleCoreRpc(rpc('search.songs'))), 'BUSY')
  } finally {
    release()
  }
  for (const result of await Promise.all(pending)) assert.equal(code(result), 'FAILED')
  f.query(async () => ({ tracks: [], total: 0, offset: 0, revision: 4 }))
  assert.equal((await f.service.handleCoreRpc(rpc('search.songs'))).ok, true)
})

test('remote lyrics.current projects bilingual synced lines with opaque track reference', async (t) => {
  const f = fixture(t, true)
  await turn()
  f.query(async (request) => {
    if (request.name === 'lyrics.current') {
      return {
        current: null,
        effective: {
          original: '[00:10.00]Line 1\n[00:15.50]Line 2',
          originalSource: 'online',
          translation: '[00:10.00]第一行\n[00:15.50]第二行',
          translationSource: 'online',
          romanization: null,
          romanizationSource: null
        },
        offsetSeconds: 0.5,
        override: null,
        policy: {
          enableEmbeddedLyrics: true,
          enableLocalLrcSidecar: true,
          enableOnlineFallback: true
        }
      }
    }
    throw new Error(`Unexpected ${request.name}`)
  })
  const result = await f.service.handleCoreRpc(rpc('lyrics.current'))
  assert.equal(result.ok, true)
  const view = result.value as {
    trackId: string
    source: string
    synced: boolean
    lines: Array<{ timeMs: number; text: string; translation?: string }>
  }
  assert.match(view.trackId, /^remote-track:/)
  assert.equal(view.source, 'online')
  assert.equal(view.synced, true)
  assert.deepEqual(view.lines, [
    { timeMs: 10500, text: 'Line 1', translation: '第一行' },
    { timeMs: 16000, text: 'Line 2', translation: '第二行' }
  ])
})

test('daily library RPC requires a paired TLS principal and preserves legacy permissions, revision fences and mutation receipts', async t => {
  const f = fixture(t, true)
  await turn()
  f.query(async request => {
    if (request.name === 'tags.list') return { token: { tagsRevision: 3, catalogRevision: 4, contentRevision: 5, linkRevision: 6 }, offset: 0, total: 0, items: [] }
    if (request.name === 'tags.create') return { token: { tagsRevision: 4 }, tag: { id: 'tag-night', name: '夜航' } }
    return {}
  })
  const secure = { encrypted: true }
  const before = f.requests.length
  for (const [principal, context] of [[undefined, secure], ['phone', { encrypted: false }], ['phone', undefined]] as const) {
    assert.equal(code(await f.service.handleCoreRpc(rpc('tags.list'), principal, context)), 'FORBIDDEN')
    assert.equal(code(await f.service.handleCoreRpc(command('tags.create', { name: '夜航', tagsRevision: 3 }), principal, context)), 'FORBIDDEN')
  }
  assert.equal(f.requests.length, before)
  assert.equal(f.identities.length, 1)
  assert.equal(f.identities[0].permissions.includes('library:write'), false)
  const listed = await f.service.handleCoreRpc(rpc('tags.list'), 'phone', secure)
  assert.equal(listed.ok, true)
  const create = command('tags.create', { name: '夜航', tagsRevision: 3 }, { commandId: 'create-once' })
  const result = await f.service.handleCoreRpc(create, 'phone', secure)
  assert.deepEqual((result.value as { result: unknown }).result, { token: { tagsRevision: 4 }, tag: { id: 'tag-night', name: '夜航' } })
  assert.equal(f.requests.at(-1)?.requestId, 'create-once')
  assert.equal(f.identities[1].role, 'remote')
  assert.equal(f.identities[1].permissions.includes('library:write'), true)
  assert.equal(f.identities[1].permissions.includes('settings:write'), false)
  assert.equal(code(await f.service.handleCoreRpc(create, 'phone', secure)), 'OUTCOME_UNKNOWN')
  // Another paired device owns a different Core identity and may use its own same command ID.
  assert.equal((await f.service.handleCoreRpc(create, 'tablet', secure)).ok, true)
  assert.notEqual(f.requestClients.at(-1), f.requestClients.at(-2))
  assert.equal(code(await f.service.handleCoreRpc(command('settings.edit', { patch: {} }), 'phone', secure)), 'FORBIDDEN')
  assert.equal(code(await f.service.handleCoreRpc(command('library.remove', { selectionId: 'x', mode: 'trash' }), 'phone', secure)), 'FORBIDDEN')
  const count = f.requests.length
  assert.equal(code(await f.service.handleCoreRpc(command('tags.create', { name: '夜航', tagsRevision: 3, filePath: 'D:/inject' }), 'phone', secure)), 'INVALID_REQUEST')
  assert.equal(f.requests.length, count)
})

test('Focus playback receipts retain the caller command ID and are queried through the same paired-device Core identity', async t => {
  const f = fixture(t, true)
  await turn()
  const token = { savedRevision: 0, catalogRevision: 1, contentRevision: 1, genresRevision: 0, metadataRevision: 0,
    ratingsRevision: 0, preferencesRevision: 0, tagsRevision: 0, linkRevision: 0, historyRevision: 0,
    queryKey: '{}', contextKey: '{}', asOf: 123, expiresAt: null }
  f.query(async request => request.name === 'focus.play' ? { total: 240, selectedIndex: 205 } : { status: 'committed', result: { total: 240, selectedIndex: 205 }, playback: 'confirmed' })
  const secure = { encrypted: true }, query = { version: 1, entity: 'recording', scope: 'library' }
  const result = await f.service.handleCoreRpc(command('focus.play', { query, token }, { commandId: 'focus-play-1' }), 'phone', secure)
  assert.equal(result.ok, true)
  assert.equal(f.requests.at(-1)?.requestId, 'focus-play-1')
  const owner = f.requestClients.at(-1)
  const receipt = await f.service.handleCoreRpc(rpc('focus.play.status', { requestId: 'focus-play-1', epoch: 'test' }), 'phone', secure)
  assert.equal((receipt.value as { status: string }).status, 'committed')
  assert.equal(f.requestClients.at(-1), owner)
  await f.service.handleCoreRpc(rpc('focus.play.status', { requestId: 'focus-play-1', epoch: 'test' }), 'tablet', secure)
  assert.notEqual(f.requestClients.at(-1), owner)
})

test('playlist membership stays opaque and device-scoped; edits resolve only issued members and never export full snapshots', async t => {
  const f = fixture(t, true)
  await turn()
  f.query(async request => {
    if (request.name === 'playlists.catalog') return { revision: 2, total: 1, offset: 0,
      items: [{ id: 'mix', name: 'Mix', kind: 'normal', count: 1, cover: null, hiddenSources: ['D:/secret'], imported: { sourcePath: 'D:/private.m3u' } }] }
    if (request.name === 'playlists.members') return { revision: 2, total: 1, offset: 0,
      items: [{ id: 'D:/private-song.flac', position: 0, track: track('D:/private-song.flac') }] }
    if (request.name === 'playlists.edit') return { revision: 3, result: { filePath: 'D:/private', trackSnapshots: { secret: true } } }
    return {}
  })
  const secure = { encrypted: true }
  const catalog = await f.service.handleCoreRpc(rpc('playlists.catalog'), 'phone', secure)
  assert.doesNotMatch(JSON.stringify(catalog), /D:|hiddenSources|sourcePath/)
  const members = await f.service.handleCoreRpc(rpc('playlists.members', { id: 'mix', revision: 2 }), 'phone', secure)
  assert.doesNotMatch(JSON.stringify(members), /D:|private-song/)
  const member = (members.value as { items: Array<{ id: string }> }).items[0].id
  assert.match(member, /^remote-member:/)
  const edit = () => command('playlists.edit', { revision: 2, edit: { kind: 'remove', id: 'mix', ids: [member] } })
  assert.equal(code(await f.service.handleCoreRpc(edit(), 'tablet', secure)), 'STALE_REVISION')
  assert.equal((await f.service.handleCoreRpc(edit(), 'phone', secure)).ok, true)
  assert.deepEqual(f.requests.at(-1)?.payload, { revision: 2, edit: { kind: 'remove', id: 'mix', ids: ['D:/private-song.flac'] } })
  const result = await f.service.handleCoreRpc(command('playlists.edit', { revision: 2, edit: { kind: 'pin', id: 'mix', pinned: true } }), 'phone', secure)
  assert.deepEqual((result.value as { result: unknown }).result, { revision: 3 })
  assert.doesNotMatch(JSON.stringify(result), /trackSnapshots|filePath|D:/)
  const before = f.requests.length
  for (const payload of [
    { revision: 2, edit: { kind: 'remove', id: 'mix', ids: ['D:/private-song.flac'] } },
    { revision: 2, edit: { kind: 'add', id: 'mix', tracks: [track('D:/inject')] } },
    { revision: 2, edit: { kind: 'cover', id: 'mix', cover: 'https://injected.test/image.png' } }
  ]) assert.equal((await f.service.handleCoreRpc(command('playlists.edit', payload), 'phone', secure)).ok, false)
  assert.equal(f.requests.length, before)
  // An epoch change invalidates session membership references.
  f.state({ ...f.current(), epoch: 'restarted' })
  assert.equal(code(await f.service.handleCoreRpc({ ...edit(), epoch: 'restarted' }, 'phone', secure)), 'STALE_REVISION')
})

test('library DTOs retain semantic revisions while rejecting host Track contexts and oversized pages', async t => {
  const f = fixture(t, true)
  await turn()
  const secure = { encrypted: true }, before = f.requests.length
  for (const request of [rpc('ratings.targets', { entityId: 'recording', trackContext: { provider: 'local', id: 'D:/private' } }),
    rpc('preferences.targets', { entityId: 'recording', trackContext: { provider: 'local', id: 'D:/private' } }),
    rpc('focus.query', { query: { version: 1, entity: 'recording' }, limit: 201 }),
    rpc('tags.list', { limit: 101 })])
    assert.equal(code(await f.service.handleCoreRpc(request, 'phone', secure)), 'INVALID_REQUEST')
  assert.equal(f.requests.length, before)
  f.query(async request => { throw Object.assign(new Error('actual stale token'), { code: request.name === 'ratings.set' ? 'STALE_REVISION' : 'FAILED' }) })
  assert.equal(code(await f.service.handleCoreRpc(command('ratings.set', { entityId: 'recording', token: { ratingsRevision: 0, linkRevision: 0, targetKey: 'entity:recording' }, steps: 8 }), 'phone', secure)), 'STALE_REVISION')
  f.state({ ...f.current(), ratingsRevision: 11, preferencesRevision: 12, tagsRevision: 13, focusRevision: 14 })
  const snapshot = await f.service.handleCoreRpc(rpc('state.snapshot'))
  assert.equal((snapshot.value as { tagsRevision: number }).tagsRevision, 13)
  assert.equal((snapshot.value as { focusRevision: number }).focusRevision, 14)
})

test('overlapping library reads with the same wire request ID never replace the first pending response owner', async t => {
  const f = fixture(t, true)
  await turn()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.query(async () => { await gate; return { offset: 0, total: 0, items: [], token: {} } })
  const request = rpc('tags.list'), secure = { encrypted: true }
  const first = f.service.handleCoreRpc(request, 'phone', secure)
  assert.equal(code(await f.service.handleCoreRpc(request, 'phone', secure)), 'OUTCOME_UNKNOWN')
  release()
  assert.equal((await first).ok, true)
  assert.equal(f.requests.filter(r => r.name === 'tags.list').length, 1)
})
