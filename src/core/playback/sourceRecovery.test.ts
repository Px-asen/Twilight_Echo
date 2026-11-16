import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlaybackSourceRecovery } from './sourceRecovery.ts'
import { createLogicalTrackModel } from '../../shared/logicalTrackModel.ts'
import type { TrackData } from '../../shared/track.ts'
import type { UnifiedSearchResult } from '../../shared/unifiedMusicSearch.ts'
import { createSourceResolver } from './sourceResolver.ts'
import { versionSourceKey } from '../../shared/trackSourceIdentity.ts'

const song = (source = 'expired', id = `${source}:one`): TrackData => ({
  id,
  source,
  title: 'One',
  artist: 'Artist',
  album: 'Album',
  duration: 180,
  filePath: '',
  fileName: '',
  size: 0,
  cover: null,
  lyrics: null,
  queueEntryId: 'occurrence:one'
})
const identity = createLogicalTrackModel(() => undefined)
function found(...tracks: TrackData[]): UnifiedSearchResult {
  return {
    items: tracks.map((track) => ({ kind: 'track', ...identity.toSourceVariant({ track }) })),
    logicalItems: [],
    health: {},
    total: tracks.length
  }
}
function fixture(extra: Partial<Parameters<typeof createPlaybackSourceRecovery>[0]> = {}) {
  const reads: string[] = []
  const searches: string[] = []
  const recovery = createPlaybackSourceRecovery({
    resolver: {
      resolve: async (track) => {
        const value = track as TrackData
        reads.push(value.id)
        return value.source === 'expired'
          ? null
          : { source: `https://audio.test/${value.id}`, expiresAt: null }
      }
    },
    identity,
    versionsRevision: () => 0,
    now: () => 1000,
    authorize: async (source) => source,
    search: async (query) => {
      searches.push(query)
      return found(song('other'))
    },
    ...extra
  })
  return { recovery, reads, searches }
}

test('Core prepares the actual replacement identity while retaining only the requested occurrence', async () => {
  const f = fixture()
  const prepared = await f.recovery.prepare(song())
  assert.equal(prepared.track.id, 'other:one')
  assert.equal(prepared.track.queueEntryId, 'occurrence:one')
  assert.equal(prepared.resolved.source, 'https://audio.test/other:one')
  assert.deepEqual(f.reads, ['expired:one', 'other:one'])
  assert.deepEqual(f.searches, ['One Artist'])
})

test('explicit catalog source selection permits fresh URLs for that identity but never searches a replacement', async () => {
  const f = fixture()
  await assert.rejects(f.recovery.prepare({ ...song(), sourceSelection: 'explicit' }), /Unable to resolve/)
  await assert.rejects(f.recovery.recover!({ ...song('other'), sourceSelection: 'explicit' }), /Unable to resolve/)
  assert.deepEqual(f.searches, [])
  assert.equal((await f.recovery.prepare({ ...song('other'), sourceSelection: 'explicit' })).track.id, 'other:one')
})

test('same-provider expired IDs can rematch, but explicit recording relationships and preferred sources cannot be bypassed', async () => {
  const replacement = song('expired', 'expired:new')
  const f = fixture({
    search: async () => found(replacement),
    resolver: {
      resolve: async (track) =>
        (track as TrackData).id === replacement.id
          ? { source: 'https://audio.test/new', expiresAt: null }
          : null
    }
  })
  assert.equal((await f.recovery.prepare(song())).track.id, replacement.id)
  const preferred = fixture({
    identity: createLogicalTrackModel(() => ({
      id: 'version',
      sources: ['expired:one', 'other:one'],
      preferredSource: 'expired:one'
    }))
  })
  await assert.rejects(preferred.recovery.prepare(song()), /Unable to resolve/)
  assert.deepEqual(preferred.searches, [])
  const separate = fixture({
    identity: createLogicalTrackModel((key) =>
      key === versionSourceKey(song())
        ? { id: 'version', sources: [key], preferredSource: null }
        : undefined
    )
  })
  await assert.rejects(separate.recovery.prepare(song()), /matching replacement/)
})

test('missing local files may use another music source; platform/media refusals never trigger fallback', async () => {
  const local = { ...song('local', 'local'), filePath: 'D:/missing.flac' }
  const f = fixture({
    resolver: {
      resolve: async (track) => ({
        source: (track as TrackData).filePath || 'https://audio.test/other',
        expiresAt: null
      })
    },
    authorize: async (source) => (source === local.filePath ? null : source)
  })
  assert.equal((await f.recovery.prepare(local)).track.id, 'other:one')
  const refused = fixture({
    authorize: async () => {
      throw new Error('platform denied')
    }
  })
  await assert.rejects(refused.recovery.prepare(song('other')), {
    code: 'SOURCE_ACCESS_DENIED', message: 'platform denied'
  })
  assert.deepEqual(refused.searches, [])
  const grant = fixture({
    resolver: createSourceResolver({
      callProvider: async () => 'twilight-media://audio/denied',
      grants: {
        resolve: async () => {
          throw new Error('grant denied')
        }
      }
    })
  })
  await assert.rejects(grant.recovery.prepare(song()), { code: 'SOURCE_ACCESS_DENIED' })
  assert.deepEqual(grant.searches, [])
})

test('Core never rematches radio/podcast or a live/remastered variant as the failed recording', async () => {
  for (const source of ['radio', 'podcast']) {
    const f = fixture({ resolver: { resolve: async () => null } })
    await assert.rejects(f.recovery.prepare(song(source)), /Unable to resolve/)
    assert.deepEqual(f.searches, [])
  }
  const f = fixture({ search: async () => found({ ...song('other'), album: 'Live' }) })
  await assert.rejects(f.recovery.prepare(song()), /matching replacement/)
})

test('cancellation and recording revision changes fence both pending and prepared source reads', async () => {
  let revision = 0
  const f = fixture({ versionsRevision: () => revision })
  const prepared = await f.recovery.prepare(song())
  revision++
  assert.throws(() => prepared.confirm?.(), { code: 'STALE_REVISION' })
  const controller = new AbortController()
  const cancelled = fixture({
    search: async (_query, signal) => {
      controller.abort(new Error('Pause cancelled source preparation'))
      assert.equal(signal?.aborted, true)
      return found(song('other'))
    }
  })
  await assert.rejects(cancelled.recovery.prepare(song(), controller.signal), /Pause cancelled/)
  assert.deepEqual(cancelled.reads, ['expired:one'])

  let batchRevision = 0
  const batchController = new AbortController()
  const decoupled = fixture({ versionsRevision: () => batchRevision })
  const retained = await decoupled.recovery.prepare(song('other'), batchController.signal)
  batchController.abort(new Error('Batch superseded'))
  assert.doesNotThrow(() => retained.confirm?.())
  batchRevision++
  assert.throws(() => retained.confirm?.(), { code: 'STALE_REVISION' })

  const noFallback = fixture()
  await assert.rejects(
    noFallback.recovery.prepare(song('expired'), undefined, { allowFallbackSearch: false }),
    /Unable to resolve the selected audio source$/
  )
  assert.deepEqual(noFallback.searches, [])
})

test('CUE and SACD direct identities retain their segments and authorize only the physical ISO', async () => {
  const paths: string[] = []
  const f = fixture({
    resolver: createSourceResolver(),
    authorize: async (path) => {
      paths.push(path)
      return path
    }
  })
  const cue = {
    ...song('local', 'cue'),
    filePath: 'D:/disc.flac',
    cueRange: { startSeconds: 30, endSeconds: 60, pregapSeconds: 0 }
  }
  assert.equal((await f.recovery.prepare(cue)).track, cue)
  const sacd = {
    ...song('local', 'sacd'),
    filePath: 'D:/disc.iso',
    subTrack: 'D:/disc.iso?area=stereo&track=2'
  }
  assert.equal((await f.recovery.prepare(sacd)).resolved.source, sacd.subTrack)
  assert.deepEqual(paths, [cue.filePath, sacd.filePath])
  assert.deepEqual(f.searches, [])
})

test('source recovery requests AutoMix preparation only when background prepare opts in', async () => {
  const calls: Array<{ id: string; autoMixPrepare: boolean }> = []
  const recovery = createPlaybackSourceRecovery({
    resolver: {
      resolve: async (candidate, _signal, resolveOptions) => {
        const value = candidate as TrackData
        calls.push({ id: value.id, autoMixPrepare: resolveOptions?.autoMixPrepare === true })
        return value.source === 'expired'
          ? null
          : { source: `https://audio.test/${value.id}`, expiresAt: null }
      }
    },
    identity,
    versionsRevision: () => 0,
    now: () => 1000,
    authorize: async (source) => source,
    search: async () => found(song('other'))
  })

  await recovery.prepare(song('other'))
  await recovery.prepare(song('other'), undefined, { autoMixPrepare: true })
  await recovery.recover!(song('expired'))

  assert.deepEqual(calls, [
    { id: 'other:one', autoMixPrepare: false },
    { id: 'other:one', autoMixPrepare: true },
    { id: 'other:one', autoMixPrepare: false }
  ])
})
