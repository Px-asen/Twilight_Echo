import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import type { TrackData } from '../../shared/track.ts'
import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import { CoreMetadataService } from './metadataService.ts'
import { patchLibraryMetadataBatch } from './metadataPatch.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const track = (id = 'local:moon'): TrackData => ({
  id,
  source: 'local',
  title: 'Moon River',
  artist: 'Audrey',
  album: '',
  duration: 181,
  filePath: 'D:/Music/moon.flac',
  fileName: 'moon.flac',
  size: 100,
  cover: null,
  lyrics: null
})
const candidate: TrackData = {
  ...track('provider:moon'),
  source: 'provider',
  album: 'Online Album',
  genre: 'Jazz',
  cover: 'https://example.test/cover',
  lyrics: '[00:00]Moon',
  translatedLyrics: '[00:00]月亮',
  streamUrl: 'https://private.invalid/audio?token=secret'
}

function fixture(t: test.TestContext, tracks = [track()]) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks })
  const errors: unknown[] = [],
    offsets: number[] = [],
    writes: number[] = []
  let libraryChanges = 0
  let searches = 0,
    available = true,
    changes = 0,
    serial = 0
  let search = async (_signal?: AbortSignal, _query?: string): Promise<TrackData[]> => [candidate]
  const database: Pick<LibraryDatabaseApi, 'queryTracks' | 'getTracksByIds' | 'patchTracks'> = {
    queryTracks: async (query) => {
      assert.ok(query)
      assert.ok(query.limit! <= 200)
      offsets.push(query.offset!)
      return db.queryTracks(query)
    },
    getTracksByIds: async (ids) => db.getTracksByIds(ids),
    patchTracks: async (patches) => {
      writes.push(patches.length)
      return db.patchTracks(patches)
    }
  }
  const service = new CoreMetadataService({
    database,
    provider: {
      searchSongs: async (query, _limit, _offset, signal) => {
        searches++
        const items = await search(signal, query)
        return { items, total: items.length }
      }
    },
    available: () => available,
    policy: () => ({ cover: true, lyrics: true, metadata: true }),
    now: Date.now,
    newId: () => `candidates:${++serial}`,
    changed: () => {
      changes++
    },
    libraryChanged: () => {
      libraryChanges++
    },
    failed: (error) => errors.push(error)
  })
  t.after(async () => {
    await service.shutdown()
    db.close()
  })
  return {
    db,
    database,
    service,
    errors,
    offsets,
    writes,
    searches: () => searches,
    changes: () => changes,
    libraryChanges: () => libraryChanges,
    search: (run: typeof search) => {
      search = run
    },
    available: (value: boolean) => {
      available = value
    },
    async until(condition: () => boolean) {
      const deadline = Date.now() + 3000
      while (!condition() && Date.now() < deadline)
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
      assert.ok(condition(), JSON.stringify(service.snapshot()))
    }
  }
}

test('automatic metadata enrichment uses bounded DB pages, provider grouping and authority-owned commits', async (t) => {
  const f = fixture(
    t,
    Array.from({ length: 320 }, (_, i) => track(`local:${i}`))
  )
  f.service.activate()
  f.service.activate()
  await f.until(
    () => f.db.queryTracks({ limit: 1, offset: 319 }).tracks[0].album === 'Online Album'
  )
  await tick()
  assert.deepEqual(f.offsets, [0, 200])
  assert.equal(f.searches(), 2, 'duplicate search group stays coalesced within each bounded page')
  assert.equal(f.service.snapshot().total, 320)
  assert.equal(f.service.snapshot().completed, 320)
  assert.equal(f.libraryChanges(), 13, 'one invalidation per bounded commit, not per track')
  assert.deepEqual(f.writes, [...Array(12).fill(25), 20])
  const saved = f.db.getTracksByIds(['local:0']).tracks[0]
  assert.equal(saved.lyrics, candidate.lyrics)
  assert.equal(saved.genre, 'Jazz')
  assert.equal(saved.streamUrl, undefined)
  assert.equal((saved.metadataMatch as any).trackId, candidate.id)
  assert.ok(f.changes() > 0)
  const before = f.searches()
  f.service.refresh()
  await tick()
  assert.equal(f.searches(), before, 'reconnection/unchanged scans do not repeat metadata work')
  assert.deepEqual(f.errors, [])
})

test('provider replies cannot overwrite a newer manual edit or changed CUE identity', async (t) => {
  for (const patch of [
    { artist: 'New performer' },
    { cueRange: { startSeconds: 10, endSeconds: 181 } }
  ]) {
    const f = fixture(t)
    let release!: (tracks: TrackData[]) => void
    f.search(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    f.service.activate()
    await tick()
    const page = f.db.getTracksByIds([track().id])
    f.db.patchTracks([{ id: track().id, expectedVersion: page.versions[track().id], patch }])
    release([candidate])
    await f.until(() => f.service.snapshot().state === 'completed')
    assert.equal(f.db.getTracksByIds([track().id]).tracks[0].album, '')
    assert.deepEqual(f.errors, [])
  }
})

test('cancel/quit join a slow provider without late commits, and automatic refresh respects user cancellation', async (t) => {
  const f = fixture(t)
  let release!: (tracks: TrackData[]) => void,
    joined = false
  f.search(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  f.service.activate()
  await tick()
  assert.equal(f.service.cancel(), true)
  f.service.refresh(true)
  assert.equal(f.searches(), 1)
  const closing = f.service.shutdown().then(() => {
    joined = true
  })
  await tick()
  assert.equal(joined, false)
  release([candidate])
  await closing
  assert.equal(f.db.getTracksByIds([track().id]).tracks[0].album, '')
  assert.equal(f.service.snapshot().state, 'cancelled')
})

test('manual candidates are bounded private tokens, stale versions are rejected, and apply/clear retain local identity', async (t) => {
  const f = fixture(t)
  let version = f.db.getTracksByIds([track().id]).versions[track().id]
  const found = await f.service.find(track().id, version)
  assert.equal(found.items.length, 1)
  assert.doesNotMatch(JSON.stringify(found), /filePath|streamUrl|private\.invalid|secret/)
  f.db.patchTracks([
    { id: track().id, expectedVersion: version, patch: { lyrics: 'Manual lyrics' } }
  ])
  await assert.rejects(
    f.service.apply(found.token, 0),
    (error: any) => error.code === 'STALE_REVISION'
  )
  version = f.db.getTracksByIds([track().id]).versions[track().id]
  const current = await f.service.find(track().id, version)
  await f.service.apply(current.token, 0)
  let saved = f.db.getTracksByIds([track().id])
  assert.equal(saved.tracks[0].filePath, track().filePath)
  assert.equal(saved.tracks[0].id, track().id)
  assert.equal(saved.tracks[0].lyrics, 'Manual lyrics')
  assert.equal(saved.tracks[0].album, 'Online Album')
  assert.equal(saved.tracks[0].streamUrl, undefined)
  await assert.rejects(f.service.apply(current.token, 0), /失效/)
  await f.service.clear(track().id, saved.versions[track().id])
  saved = f.db.getTracksByIds([track().id])
  assert.equal(saved.tracks[0].metadataMatch, null)
  assert.equal(saved.tracks[0].album, 'Online Album')
  assert.equal(f.libraryChanges(), 2)
})

test('date-only scan updates do not resubmit provider enrichment; a newly enabled provider can retry', async (t) => {
  const f = fixture(t)
  f.available(false)
  f.service.activate()
  await tick()
  assert.equal(f.searches(), 0)
  f.available(true)
  f.service.refresh(true)
  await f.until(() => f.service.snapshot().state === 'completed')
  await tick()
  const page = f.db.getTracksByIds([track().id])
  f.db.patchTracks([
    {
      id: track().id,
      expectedVersion: page.versions[track().id],
      patch: { releaseDate: '2020-01-01' }
    }
  ])
  f.service.refresh()
  await tick()
  assert.equal(f.searches(), 1)
  assert.deepEqual(f.errors, [])
})

test('queued metadata writes are dropped on cancel before the batch timer runs', async (t) => {
  const f = fixture(t)
  f.service.activate()
  await tick()
  assert.equal(f.searches(), 1)
  assert.equal(f.service.snapshot().state, 'enriching', 'completion waits for durable writes')
  f.service.cancel()
  await f.service.shutdown()
  assert.deepEqual(f.writes, [])
  assert.equal(f.db.getTracksByIds([track().id]).tracks[0].album, '')
})

test('background provider searches use two slots instead of flooding foreground providers', async (t) => {
  const f = fixture(
    t,
    Array.from({ length: 10 }, (_, i) => ({ ...track(`local:${i}`), title: `Song ${i}` }))
  )
  f.search(
    (signal) =>
      new Promise((_, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
  )
  f.service.activate()
  await tick()
  assert.equal(f.searches(), 2)
  f.service.cancel()
  await f.service.shutdown()
})

test('batch metadata writes fence each source separately and preserve concurrent manual edits', async (t) => {
  const f = fixture(t, [track('local:one'), track('local:two'), track('local:removed')])
  const sources = f.db.getTracksByIds(['local:one', 'local:two', 'local:removed'])
  f.db.patchTracks([
    {
      id: 'local:one',
      expectedVersion: sources.versions['local:one'],
      patch: { lyrics: 'Manual lyrics' }
    }
  ])
  f.db.sql.prepare('DELETE FROM tracks WHERE id=?').run('local:removed')
  const saved = await patchLibraryMetadataBatch(
    {
      getTracksByIds: async (ids) => f.db.getTracksByIds(ids),
      patchTracks: async (patches) => f.db.patchTracks(patches)
    },
    sources.tracks.map((record) => {
      const source = libraryTrack(record)
      return { source, track: { ...source, album: 'Online Album', lyrics: 'Provider lyrics' } }
    }),
    () => true
  )
  assert.deepEqual(
    saved?.tracks.map((track) => track.id),
    ['local:two']
  )
  assert.equal(f.db.getTracksByIds(['local:one']).tracks[0].lyrics, 'Manual lyrics')
  assert.equal(f.db.getTracksByIds(['local:one']).tracks[0].album, '')
  assert.equal(f.db.getTracksByIds(['local:two']).tracks[0].album, 'Online Album')
  assert.equal(f.db.getTracksByIds(['local:removed']).tracks.length, 0)
})

test('cancellation fences a batch waiting for its source read and shutdown joins it', async (t) => {
  const f = fixture(t)
  let entered!: () => void,
    release!: () => void,
    joined = false
  const reading = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const read = f.database.getTracksByIds
  f.database.getTracksByIds = async (ids) => {
    entered()
    await held
    return read(ids)
  }
  f.service.activate()
  await reading
  f.service.cancel()
  const closing = f.service.shutdown().then(() => {
    joined = true
  })
  await tick()
  assert.equal(joined, false)
  release()
  await closing
  assert.deepEqual(f.writes, [])
  assert.equal(f.db.getTracksByIds([track().id]).tracks[0].album, '')
})

test('shutdown joins an already accepted batch write instead of losing its durable result', async (t) => {
  const f = fixture(t)
  let entered!: () => void,
    release!: () => void,
    joined = false
  const writing = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const patch = f.database.patchTracks
  f.database.patchTracks = async (patches) => {
    entered()
    await held
    return patch(patches)
  }
  f.service.activate()
  await writing
  const closing = f.service.shutdown().then(() => {
    joined = true
  })
  await tick()
  assert.equal(joined, false)
  release()
  await closing
  assert.equal(f.db.getTracksByIds([track().id]).tracks[0].album, 'Online Album')
  assert.equal(f.service.snapshot().state, 'cancelled')
})

test('a failed batch settles every pending update and reports a save failure', async (t) => {
  const f = fixture(
    t,
    Array.from({ length: 70 }, (_, i) => track(`local:${i}`))
  )
  let attempts = 0
  f.database.patchTracks = async () => {
    attempts++
    throw new Error('disk full')
  }
  f.service.activate()
  await f.until(() => f.service.snapshot().state === 'failed')
  assert.equal(attempts, 3)
  assert.equal(f.service.snapshot().failed, 70)
  assert.match(f.service.snapshot().error, /元数据保存失败/)
  assert.equal(f.db.getTracksByIds(['local:0']).tracks[0].album, '')
})

test('independent search groups share bounded writes and the writer drains every subsequent group', async (t) => {
  const tracks = Array.from({ length: 10 }, (_, i) => ({
    ...track(`local:${i}`),
    title: `Song ${i}`
  }))
  const f = fixture(t, tracks)
  f.search(async (_signal, query) => {
    const source = tracks.find((track) => `${track.title} ${track.artist}` === query)!
    return [{ ...candidate, id: `ncm:${source.id}`, title: source.title }]
  })
  f.service.activate()
  await f.until(() => f.service.snapshot().completed === 10)
  assert.equal(f.searches(), 10)
  assert.deepEqual(f.writes, [2, 2, 2, 2, 2])
  assert.equal(f.libraryChanges(), 5)
  assert.deepEqual(f.errors, [])
})

test('completion can restart immediately after cancelling buffered updates', async (t) => {
  const f = fixture(t)
  f.service.activate()
  await tick()
  f.service.cancel()
  f.service.start()
  await f.until(() => f.service.snapshot().state === 'completed')
  assert.deepEqual(f.writes, [1])
  assert.equal(f.db.getTracksByIds([track().id]).tracks[0].album, 'Online Album')
  assert.deepEqual(f.errors, [])
})
