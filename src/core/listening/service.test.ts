import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreStateDatabase } from '../../main/library/coreStateDatabase.ts'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { emptyCoreStateCounts } from '../../shared/coreState.ts'
import type { CoreStatisticsApi } from '../../shared/coreStatistics.ts'
import type { TrackData } from '../../shared/track.ts'
import { CoreStatisticsRepository } from './repository.ts'
import { CoreStatisticsService, type CoreStatisticsOptions } from './service.ts'
import { createLibraryListeningProjection } from './libraryProjection.ts'
import { listeningSourceIdentity } from '../../shared/listeningSourceIdentity.ts'
import { buildLastPlayedBySource } from './model.ts'

const local: TrackData = {
  id: 'local:cue',
  title: 'Song',
  artist: 'Singer',
  album: 'Album',
  filePath: 'D:/Music/disc.flac',
  fileName: 'disc.flac',
  duration: 100,
  size: 1,
  cover: null,
  lyrics: null,
  source: 'local',
  queueEntryId: 'first',
  cueRange: { startSeconds: 100, endSeconds: 200, pregapSeconds: 0 },
  cueSheetPath: 'D:/Music/disc.cue'
}
const provider: TrackData = {
  ...local,
  id: 'provider:1',
  source: 'provider',
  filePath: 'provider:1',
  streamUrl: 'https://private:secret@host.test/file?token=secret',
  cueRange: undefined,
  queueEntryId: 'second',
  duration: 100
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
class Timers {
  now = Date.UTC(2026, 9, 22, 12)
  serial = 0
  pending = new Map<number, { at: number; callback: () => void }>()
  setTimeout = (callback: () => void, delay: number) => {
    const id = ++this.serial
    this.pending.set(id, { at: this.now + delay, callback })
    return id
  }
  clearTimeout = (id: unknown) => {
    this.pending.delete(id as number)
  }
  advance(ms: number) {
    const end = this.now + ms
    for (;;) {
      const first = [...this.pending]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!first) break
      this.now = first[1].at
      this.pending.delete(first[0])
      first[1].callback()
    }
    this.now = end
  }
}
async function fixture(
  t: test.TestContext,
  extra: Partial<Pick<CoreStatisticsOptions, 'artwork' | 'recoverArtwork'>> = {}
) {
  const db = new CoreStateDatabase(':memory:')
  db.begin('upgrade', { version: 1, counts: emptyCoreStateCounts() })
  db.commit('upgrade')
  const library = new LibraryDatabase(':memory:')
  const timers = new Timers()
  let id = 0,
    changes = 0
  const database: CoreStatisticsApi &
    Pick<import('../../shared/coreState.ts').CoreStateApi, 'coreStateRead'> = {
    coreStateRead: async (...args) => db.read(...args),
    coreStatisticsStatus: async () => db.statisticsStatus(),
    coreStatisticsBegin: async (...args) => db.statisticsBegin(...args),
    coreStatisticsStage: async (...args) => db.statisticsStage(...args),
    coreStatisticsCommit: async (...args) => db.statisticsCommit(...args),
    coreStatisticsAbort: async (...args) => db.statisticsAbort(...args)
  }
  const history = createLibraryListeningProjection({
    getStorageMode: async () => 'sqlite',
    ready: async () => {},
    snapshot: () => service.historySnapshot(),
    identity: () => `history:${++id}`,
    sync: async (request) => library.syncListeningHistory(request)
  })
  const repository = new CoreStatisticsRepository({ database, newId: () => `stats:${++id}` })
  const service = new CoreStatisticsService({
    repository,
    now: () => timers.now,
    timers,
    history,
    changed: () => changes++,
    ...extra
  })
  await service.initialize()
  t.after(async () => {
    await service.shutdown()
    db.close()
    library.close()
  })
  const observe = (
    track: TrackData | null,
    state: 'playing' | 'paused' | 'stopped',
    position = 0,
    duration = 100
  ) => service.observe(track, { state, position, duration })
  const snapshot = async () => {
    await service.flush()
    return new CoreStatisticsRepository({ database, newId: () => `read:${++id}` }).load()
  }
  return {
    db,
    library,
    repository,
    database,
    service,
    timers,
    observe,
    snapshot,
    get changes() {
      return changes
    }
  }
}

test('Focus history projection distinguishes equal raw provider IDs and keeps original raw sorting keys', async t => {
  const f = await fixture(t)
  f.observe({ ...provider, id: '42', source: 'ncm', title: 'NCM song' }, 'playing')
  f.timers.advance(5_000)
  const ncmAt = f.timers.now
  f.observe({ ...provider, id: '42', source: 'other', title: 'Other provider song' }, 'playing')
  f.timers.advance(5_000)
  const otherAt = f.timers.now
  await f.service.overview()
  const snapshot = f.service.historySnapshot()
  assert.equal(snapshot.get(listeningSourceIdentity('ncm', 'ncm:42')), ncmAt)
  assert.equal(snapshot.get(listeningSourceIdentity('other', '42')), otherAt)
  assert.equal(snapshot.get('42'), otherAt)
  assert.equal(f.library.sql.prepare('SELECT last_played FROM library_history WHERE id=?').get(listeningSourceIdentity('ncm', '42'))!.last_played, ncmAt)
  assert.equal(f.library.sql.prepare('SELECT last_played FROM library_history WHERE id=?').get(listeningSourceIdentity('other', '42'))!.last_played, otherAt)
  assert.equal(snapshot.has(listeningSourceIdentity('unplayed', '42')), false)
})

test('Focus qualified history uses catalog local-path detection and normalized recorded provider identities', async t => {
  const f = await fixture(t), id = 'D:\\Music\\legacy.flac'
  f.observe({ ...local, id, source: undefined }, 'playing')
  f.timers.advance(5_000)
  await f.service.overview()
  assert.equal(f.service.historySnapshot().get(listeningSourceIdentity('local', id)), f.timers.now)
  const stats = await f.snapshot()
  Object.values(stats.tracks)[0].sourceIds = [{ source: ' NCM ', trackId: 'ncm:42' }]
  const qualified = buildLastPlayedBySource(stats)
  assert.equal(qualified.get(listeningSourceIdentity('ncm', '42')), f.timers.now)
  assert.equal(qualified.has(JSON.stringify(['focus-source-v1', 'D', id])), false)
})

test('one Core timer counts five-second ticks; duplicate state observations and reconnect-style reads cannot multiply listening', async (t) => {
  const f = await fixture(t)
  f.observe(local, 'playing')
  for (let i = 0; i < 20; i++) {
    f.observe(local, 'playing', i)
    f.service.summary()
    f.service.page({})
  }
  f.timers.advance(15_000)
  const before = f.service.page({}).items[0]
  assert.equal(before.seconds, 15)
  assert.equal(before.plays, 1)
  f.observe(local, 'paused', 15)
  f.timers.advance(60_000)
  assert.equal(f.service.page({}).items[0].seconds, 15)
  f.observe(local, 'playing', 15)
  f.timers.advance(5_000)
  const saved = await f.snapshot(),
    stat = saved.tracks['logic:song::singer']
  assert.equal(stat.seconds, 20)
  assert.equal(stat.plays, 1)
  assert.deepEqual(stat.track?.cueRange, local.cueRange)
  assert.equal(stat.track?.cueSheetPath, local.cueSheetPath)
  assert.equal(stat.track?.queueEntryId, 'first')
  assert.equal(saved.days['2026-10-22'], 20)
  await tick()
  await f.service.shutdown()
  assert.equal(f.timers.pending.size, 0)
})

test('cross-source aggregation, skips and completions retain existing thresholds without exposing private sources', async (t) => {
  const f = await fixture(t)
  f.observe(local, 'playing', 20)
  f.timers.advance(5_000)
  f.observe(local, 'playing', 49)
  f.observe(provider, 'playing', 0)
  f.timers.advance(5_000)
  f.observe(provider, 'playing', 90)
  f.observe({ ...local, queueEntryId: 'third' }, 'paused', 0)
  const [stat] = f.service.page({ sort: 'plays' }).items
  assert.equal(stat.seconds, 10)
  assert.equal(stat.plays, 2)
  assert.equal(stat.skips, 1)
  assert.equal(stat.completions, 1)
  assert.doesNotMatch(
    JSON.stringify(f.service.page({})),
    /private|secret|token=|streamUrl|filePath/
  )
  const saved = await f.snapshot()
  assert.deepEqual(
    saved.tracks['logic:song::singer'].sourceIds?.map((source) => source.trackId),
    [local.id, provider.id]
  )
  assert.equal(saved.tracks['logic:song::singer'].track?.streamUrl, null)
})

test('Pause and Stop do not count outcomes, same-track occurrences keep legacy play counting, and 50–90 percent is neither outcome', async (t) => {
  const f = await fixture(t)
  f.observe(local, 'playing', 55)
  f.timers.advance(5_000)
  f.observe(local, 'paused', 55)
  f.observe(local, 'stopped', 0)
  assert.equal(f.service.page({}).items[0].skips, 0)
  f.observe({ ...local, queueEntryId: 'duplicate' }, 'playing', 55)
  f.timers.advance(5_000)
  f.observe({ ...local, id: 'other', title: 'Other' }, 'paused', 0)
  const stat = f.service.page({}).items.find((stat) => stat.id === 'logic:song::singer')!
  assert.equal(stat.plays, 1)
  assert.equal(stat.completions, 0)
  assert.equal(stat.skips, 0)
})

test('clear ranges preserve other days and legacy totals; clear is revision-fenced, immediate, and continues counting freshly', async (t) => {
  const f = await fixture(t)
  f.observe(local, 'playing', 30)
  f.timers.advance(5_000)
  const firstDay = '2026-10-22'
  f.observe(local, 'paused', 30)
  f.timers.advance(86_400_000)
  f.observe(provider, 'playing', 20)
  f.timers.advance(5_000)
  const revision = f.service.getRevision()
  await assert.rejects(
    f.service.clear(null, revision - 1),
    (error) => (error as { code: string }).code === 'STALE_REVISION'
  )
  await f.service.clear({ startDay: firstDay, endDay: firstDay }, revision)
  let saved = await f.snapshot()
  assert.equal(saved.days[firstDay], undefined)
  assert.equal(saved.tracks['logic:song::singer'].seconds, 5)
  await f.service.clear(null, f.service.getRevision())
  saved = await f.snapshot()
  assert.deepEqual(saved, { days: {}, tracks: {} })
  f.timers.advance(5_000)
  assert.equal(f.service.page({}).items[0].plays, 1)
  assert.equal(f.service.page({}).items[0].seconds, 5)
})

test('ticks during a slow checkpoint stay dirty; commit loss followed by unreadable status is recovered without replay or duplicate counters', async (t) => {
  const f = await fixture(t)
  const commit = f.database.coreStatisticsCommit,
    status = f.database.coreStatisticsStatus
  let release!: () => void,
    offline = false,
    commits = 0
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.database.coreStatisticsCommit = async (...args) => {
    commits++
    if (commits !== 1) return commit(...args)
    const result = await commit(...args)
    await gate
    offline = true
    void result
    throw Error('Lost commit reply')
  }
  f.database.coreStatisticsStatus = async () => {
    if (offline) throw Error('Offline')
    return status()
  }
  f.observe(local, 'playing')
  f.timers.advance(5_000)
  const pending = f.service.flush()
  await tick()
  f.timers.advance(5_000)
  release()
  await assert.rejects(pending, /Offline/)
  assert.equal(f.service.summary().persistence.dirty, true)
  assert.equal(f.service.page({}).items[0].seconds, 10)
  offline = false
  await f.service.flush()
  assert.equal(commits, 2, 'one old confirmed commit and one new checkpoint for the later tick')
  assert.equal((await f.snapshot()).tracks['logic:song::singer'].seconds, 10)
  assert.equal(f.service.summary().persistence.dirty, false)
})

test('history hydration projects the complete cross-source last-played index and clearing updates that derived SQL index', async (t) => {
  const f = await fixture(t)
  f.observe(local, 'playing')
  f.timers.advance(5_000)
  f.observe(provider, 'playing')
  f.timers.advance(5_000)
  await tick()
  const rows = f.library.sql.prepare('SELECT id,last_played FROM library_history ORDER BY id').all()
  assert.deepEqual(
    rows.map((row) => row.id),
    [listeningSourceIdentity('local', local.id), listeningSourceIdentity('provider', provider.id), local.id, provider.id].sort()
  )
  assert.ok(rows.every((row) => Number(row.last_played) > 0))
  await f.service.clear(null, f.service.getRevision())
  await tick()
  assert.equal(f.library.sql.prepare('SELECT COUNT(*) AS n FROM library_history').get()?.n, 0)
})

test('overview and clear preview cover history beyond the 200-row ranking window', async (t) => {
  const f = await fixture(t)
  for (let i = 0; i < 451; i++) {
    f.observe({ ...local, id: `local:${i}`, title: `Song ${i}`, format: i < 300 ? 'FLAC' : 'MP3' }, 'playing')
    f.timers.advance(5_000)
  }
  f.observe(null, 'stopped')
  const overview = await f.service.overview()
  assert.equal(f.service.page({ limit: 200 }).items.length, 200)
  assert.deepEqual(overview.recorded, {
    seconds: 2255, plays: 451, trackCount: 451,
    formats: [
      { key: 'FLAC', label: 'FLAC', count: 300, percent: 300 / 451 * 100 },
      { key: 'MP3', label: 'MP3', count: 151, percent: 151 / 451 * 100 }
    ]
  })
  assert.equal(overview.artists[0].trackCount, 451)
  assert.equal(overview.artists[0].seconds, 2255)
  assert.equal(overview.artists[0].sourceIds.length, 200)
  const preview = f.service.previewClear(null, overview.revision)
  assert.equal(preview.trackCount, 451)
  assert.equal(preview.seconds, 2255)
  assert.throws(() => f.service.previewClear(null, overview.revision - 1), { code: 'STALE_REVISION' })
  assert.equal(overview.history.ready, true)
})

test('projectPage and overview project provider and stream artwork into session handles with bounded caching and zero origin leaks', async (t) => {
  let artworkCalls = 0
  const f = await fixture(t, {
    artwork: async (track) => {
      artworkCalls++
      if (track.cover?.startsWith('cover://')) return { cover: track.cover }
      if (/^https?:\/\//i.test(track.coverSource ?? track.cover ?? ''))
        return { cover: 'twilight-media://image/granted-recent' }
      return { cover: null }
    }
  })
  f.observe(
    {
      ...provider,
      id: 'ncm:777',
      source: 'ncm',
      title: 'Online Hit',
      artist: 'Online Singer',
      cover: 'twilight-media://image/ephemeral-input',
      coverSource: 'https://p2.music.126.net/cover.jpg?token=secret'
    },
    'playing'
  )
  f.timers.advance(5_000)

  const page1 = await f.service.projectPage({ sort: 'recent', limit: 10 })
  assert.equal(page1.items.length, 1)
  assert.equal(page1.items[0].cover, 'twilight-media://image/granted-recent')
  assert.doesNotMatch(JSON.stringify(page1), /https:\/\/|126\.net|token=secret|ephemeral-input/)
  assert.equal(artworkCalls, 1)

  const overview1 = await f.service.overview()
  assert.equal(overview1.artists[0]?.cover, 'twilight-media://image/granted-recent')
  assert.doesNotMatch(JSON.stringify(overview1), /https:\/\/|126\.net|token=secret/)
  assert.equal(artworkCalls, 1, 'overview reuses the projected cover cache for identical durable source')

  // Subsequent 5-second playback ticks reuse the TTL cache without extra IPC calls.
  f.timers.advance(5_000)
  const page2 = await f.service.projectPage({ sort: 'recent', limit: 10 })
  assert.equal(page2.items[0].cover, 'twilight-media://image/granted-recent')
  assert.equal(page2.items[0].seconds, 10)
  assert.equal(artworkCalls, 1)

  const saved = await f.snapshot()
  const persisted = saved.tracks['logic:online hit::online singer']
  assert.equal(persisted.cover, null, 'ephemeral session handles are never persisted as durable cover')
  assert.equal(persisted.coverSource, 'https://p2.music.126.net/cover.jpg?token=secret')

  const fallback = f.service.artworkTracks(new Set(['ncm:777', 'missing:1']))
  assert.equal(fallback.get('ncm:777')?.coverSource, 'https://p2.music.126.net/cover.jpg?token=secret')
  assert.equal(fallback.has('missing:1'), false)
})

test('rememberArtwork enriches both pre-tick active playback and existing coverless history rows without altering counters', async (t) => {
  const f = await fixture(t, {
    artwork: async (track) =>
      track.coverSource ? { cover: 'twilight-media://image/recovered-handle' } : { cover: null }
  })
  const trackA: TrackData = {
    ...provider,
    id: 'ncm:101',
    source: 'ncm',
    title: 'Pre Tick Song',
    artist: 'Artist A',
    cover: null,
    coverSource: null
  }
  f.observe(trackA, 'playing')
  // Presentation recovers artwork before the first 5-second tick fires.
  f.service.rememberArtwork(trackA, {
    cover: 'twilight-media://image/temp',
    coverSource: 'https://p2.music.126.net/a.jpg'
  })
  f.timers.advance(5_000)

  const trackB: TrackData = {
    ...provider,
    id: 'ncm:202',
    source: 'ncm',
    title: 'Post Tick Song',
    artist: 'Artist B',
    cover: null,
    coverSource: null
  }
  f.observe(trackB, 'playing')
  f.timers.advance(5_000)
  f.observe(null, 'stopped')

  const beforeRecovery = (await f.service.projectPage({ sort: 'recent' })).items
  assert.equal(beforeRecovery.find((i) => i.title === 'Pre Tick Song')?.cover, 'twilight-media://image/recovered-handle')
  assert.equal(beforeRecovery.find((i) => i.title === 'Post Tick Song')?.cover, null)

  f.service.rememberArtwork(trackB, {
    cover: null,
    coverSource: 'https://p2.music.126.net/b.jpg'
  })
  const afterRecovery = (await f.service.projectPage({ sort: 'recent' })).items
  const enrichedB = afterRecovery.find((i) => i.title === 'Post Tick Song')!
  assert.equal(enrichedB.cover, 'twilight-media://image/recovered-handle')
  assert.equal(enrichedB.plays, 1)
  assert.equal(enrichedB.seconds, 5)
})

test('projectPage recovers and persists missing artwork in the background for legacy coverless provider entries', async (t) => {
  let recoveries = 0
  const f = await fixture(t, {
    artwork: async (track) =>
      track.coverSource ? { cover: 'twilight-media://image/backfilled' } : { cover: null },
    recoverArtwork: {
      canRecover: (track) => track.source === 'ncm',
      recover: async (track) => {
        recoveries++
        if (track.id === 'ncm:legacy-1') {
          return {
            cover: 'https://p2.music.126.net/legacy-1.jpg',
            coverSource: 'https://p2.music.126.net/legacy-1.jpg'
          }
        }
        return null
      }
    }
  })

  f.observe(
    {
      ...provider,
      id: 'ncm:legacy-1',
      source: 'ncm',
      title: 'Legacy Provider Track',
      artist: 'Singer',
      cover: null,
      coverSource: null
    },
    'playing'
  )
  f.timers.advance(5_000)
  f.observe(null, 'stopped')

  const firstRead = await f.service.projectPage({ sort: 'recent' })
  assert.equal(firstRead.items[0].cover, null)

  await tick()
  await tick()

  const secondRead = await f.service.projectPage({ sort: 'recent' })
  assert.equal(secondRead.items[0].cover, 'twilight-media://image/backfilled')
  assert.equal(recoveries, 1, 'recovery runs once per coverless history entry')

  const saved = await f.snapshot()
  assert.equal(
    saved.tracks['logic:legacy provider track::singer'].coverSource,
    'https://p2.music.126.net/legacy-1.jpg'
  )
})
