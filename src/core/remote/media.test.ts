import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteHttpServer } from '../cast/httpServer.ts'
import { RemoteDevicePairing } from '../cast/devicePairing.ts'
import { MediaStreamGrantStore } from '../cast/mediaTokens.ts'
import { RemoteMediaResolver } from './media.ts'
import { persistentLibraryId } from '../../main/remote/libraryIdentity.ts'
import type { TrackData } from '../../shared/track.ts'
import { RemoteCoreBridge } from './coreBridge.ts'
import type { CoreSnapshot } from '../../shared/coreProtocol.ts'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'phone-stream-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'song.flac')
  await writeFile(path, '0123456789')
  let now = Date.now()
  const pairing = new RemoteDevicePairing()
  const pair = (name: string) => {
    const ticket = pairing.request(name, '127.0.0.1')
    pairing.decide(ticket.requestId, true)
    return { id: ticket.requestId, token: pairing.claim(ticket.requestId, ticket.claimSecret)!.token! }
  }
  const a = pair('Phone A'), b = pair('Phone B')
  let track = { filePath: path, source: 'local', duration: 100 } as TrackData
  const grants = new MediaStreamGrantStore({ now: () => now })
  const libraryId = persistentLibraryId(root)
  assert.equal(persistentLibraryId(root), libraryId)
  assert.notEqual(libraryId, pairing.serverId)
  const media = new RemoteMediaResolver({ libraryId, grants, resolve: async id => id === 'source-1' ? track : null,
    authorizeFile: async path => path, now: () => now })
  const server = new RemoteHttpServer({ devicePairing: pairing, mediaGrants: grants,
    staticRoot: '', addresses: () => ['127.0.0.1'] })
  const bridge = new RemoteCoreBridge({ media,
    snapshot: () => ({ phase: 'ready', epoch: 'e1' }) as CoreSnapshot,
    request: (() => { throw new Error('must not touch desktop queue') }) as never,
    playback: { fromPages: () => { throw new Error('must not touch desktop queue') } } as never,
    resolveCover: async () => null, signal: new AbortController().signal,
    failed: error => { throw error },
    resolveTrackLyrics: async resolved => ({
      revision: 1,
      contentRevision: 1,
      current: {
        trackId: resolved.id ?? 'source-1',
        occurrenceId: resolved.queueEntryId ?? null
      },
      automatic: {
        original: '[00:01.00]Hello\n[00:04.50]World',
        originalSource: 'sidecar',
        translation: '[00:01.00]你好\n[00:04.50]世界',
        translationSource: 'sidecar',
        romanization: null,
        romanizationSource: null
      },
      effective: {
        original: '[00:01.00]Hello\n[00:04.50]World',
        originalSource: 'sidecar',
        translation: '[00:01.00]你好\n[00:04.50]世界',
        translationSource: 'sidecar',
        romanization: null,
        romanizationSource: null
      },
      offsetSeconds: 0,
      override: null
    }) })
  server.setCoreRpcHandler((raw, principal) => bridge.handle(raw, principal))
  const status = await server.start()
  t.after(() => server.stop())
  const base = `http://127.0.0.1:${status.port}`
  const reference = { libraryId, sourceId: 'source-1' }
  const plan = await media.resolve(reference, a.id)
  return { a, b, base, plan, reference, media, grants, path, root, server,
    setTrack: (value: Partial<TrackData>) => { track = { ...track, ...value } },
    expire: () => { now += 16 * 60_000 },
    headers: { authorization: `Bearer ${a.token}`, range: 'bytes=3-6' } }
}

test('phone media RPC resolves stable sources without revealing paths or editing desktop playback', async t => {
  const f = await fixture(t)
  const response = await fetch(`${f.base}/api/core/rpc`, { method: 'POST',
    headers: { authorization: `Bearer ${f.a.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'resolve', epoch: 'e1', kind: 'query', name: 'media.resolve', payload: f.reference }) })
  const body = await response.json() as { ok: boolean; value: unknown }
  assert.equal(body.ok, true)
  assert.ok(!JSON.stringify(body).includes(f.path))
  const head = await fetch(f.base + f.plan.contentPath, { method: 'HEAD', headers: f.headers })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), '10')
  const range = await fetch(f.base + f.plan.contentPath, { headers: f.headers })
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('content-range'), 'bytes 3-6/10')
  assert.equal(await range.text(), '3456')
  for (const headers of [{}, { ...f.headers, authorization: `Bearer ${f.b.token}` }])
    assert.equal((await fetch(f.base + f.plan.contentPath, { headers })).status, 401)
  assert.equal((await fetch(f.base + f.plan.contentPath, { headers: { authorization: f.headers.authorization } })).status, 416)
})

test('expired grants renew only the pinned file version; replacement cannot splice bytes', async t => {
  const f = await fixture(t)
  f.expire()
  assert.equal((await fetch(f.base + f.plan.contentPath, { headers: f.headers })).status, 404)
  const renewed = await f.media.resolve({ ...f.reference, sourceVersion: f.plan.sourceVersion }, f.a.id)
  assert.equal(renewed.sourceVersion, f.plan.sourceVersion)
  await writeFile(f.path, 'new replacement data')
  assert.ok((await stat(f.path)).size !== f.plan.size)
  assert.equal((await fetch(f.base + renewed.contentPath, { headers: f.headers })).status, 409)
  await assert.rejects(f.media.resolve({ ...f.reference, sourceVersion: f.plan.sourceVersion }, f.a.id), { code: 'SOURCE_CHANGED' })
})

test('device revocation and disabling control revoke phone streams while preserving Cast grants', async t => {
  const f = await fixture(t)
  const cast = f.grants.issueFile(f.path)
  f.server.revokeDevice(f.a.id)
  assert.equal((await fetch(f.base + f.plan.contentPath, { headers: f.headers })).status, 404)
  const planB = await f.media.resolve(f.reference, f.b.id)
  assert.equal((await fetch(f.base + planB.contentPath, { headers: { ...f.headers, authorization: `Bearer ${f.b.token}` } })).status, 206)
  f.server.applyMode('mediaOnly')
  assert.equal(f.grants.resolve(planB.contentPath.slice('/media/'.length)), null)
  assert.ok(f.grants.resolve(cast))
})

test('resolver refuses foreign libraries, missing sources, segmented CUE and unsupported formats', async t => {
  const f = await fixture(t)
  await assert.rejects(f.media.resolve({ ...f.reference, libraryId: 'other' }, f.a.id), { code: 'NOT_FOUND' })
  await assert.rejects(f.media.resolve({ ...f.reference, sourceId: 'gone' }, f.a.id), { code: 'NOT_FOUND' })
  f.setTrack({ cueRange: { startSeconds: 10, endSeconds: 20, pregapSeconds: 0 } })
  await assert.rejects(f.media.resolve(f.reference, f.a.id), { code: 'UNSUPPORTED_CAPABILITY' })
  f.setTrack({ cueRange: undefined, filePath: join(f.root, 'song.dsf') })
  await assert.rejects(f.media.resolve(f.reference, f.a.id), { code: 'UNSUPPORTED_CAPABILITY' })
})

test('resolver streams ALAC m4a and other FFmpeg-supported local containers while media.lyrics projects bilingual lines safely', async t => {
  const f = await fixture(t)
  const cases: Array<[string, string]> = [
    ['alac.m4a', 'audio/mp4'],
    ['track.alac', 'audio/mp4'],
    ['track.wav', 'audio/wav'],
    ['track.ogg', 'audio/ogg'],
    ['track.opus', 'audio/opus'],
    ['track.ape', 'audio/x-ape'],
    ['track.wv', 'audio/x-wavpack']
  ]
  for (const [name, expectedType] of cases) {
    const file = join(f.root, name)
    await writeFile(file, '0123456789abcdef')
    f.setTrack({ filePath: file, cueRange: undefined, subTrack: undefined })
    const plan = await f.media.resolve(f.reference, f.a.id)
    assert.equal(plan.contentType, expectedType)
    assert.equal(plan.size, 16)
  }

  const unauthLyrics = await fetch(`${f.base}/api/core/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'lyr-unauth', epoch: 'e1', kind: 'query', name: 'media.lyrics', payload: f.reference })
  })
  assert.equal(unauthLyrics.status, 401)

  const lyricsRes = await fetch(`${f.base}/api/core/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${f.a.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'lyr-1', epoch: 'e1', kind: 'query', name: 'media.lyrics', payload: f.reference })
  })
  const lyricsBody = await lyricsRes.json() as {
    ok: boolean
    value: { trackId: string; source: string; synced: boolean; lines: Array<{ timeMs: number; text: string; translation?: string }> }
  }
  assert.equal(lyricsBody.ok, true)
  assert.ok(!JSON.stringify(lyricsBody).includes(f.root))
  assert.deepEqual(lyricsBody.value, {
    trackId: 'source-1',
    source: 'sidecar',
    synced: true,
    lines: [
      { timeMs: 1000, text: 'Hello', translation: '你好' },
      { timeMs: 4500, text: 'World', translation: '世界' }
    ]
  })
})
