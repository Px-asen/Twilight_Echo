import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreNcmListeningSync } from './ncmSync.ts'
import type { NcmListeningReport } from '../../shared/listeningSync.ts'
import type { TrackData } from '../../shared/track.ts'

const track = (id = 1, entry = `entry-${id}`): TrackData => ({
  id: `ncm:${id}`,
  queueEntryId: entry,
  source: 'ncm',
  ncmSongId: id,
  title: `Song ${id}`,
  artist: 'Artist',
  album: '',
  filePath: '',
  fileName: '',
  duration: 120,
  size: 0,
  cover: null,
  lyrics: null
})
function fixture(enabled = true) {
  let now = 0,
    context = 'account-A',
    sequence = 0,
    account: number | null = 7
  let failure: Error | null = null
  const reports: Array<NcmListeningReport & { key: string }> = []
  const sync = new CoreNcmListeningSync({
    enabled,
    available: () => true,
    context: () => context,
    account: async () => account,
    submit: async (report, key) => {
      if (failure) throw failure
      reports.push({ ...report, key })
    },
    now: () => now,
    newId: () => `listen-${++sequence}`,
    changed() {}
  })
  return {
    sync,
    reports,
    tick(
      seconds: number,
      position: number,
      state: 'playing' | 'paused' | 'stopped' = 'playing',
      item: TrackData | null = track(),
      serial = 0,
      session = 'local',
      rate = 1
    ) {
      now += seconds * 1000
      sync.observe(session, item, {
        state,
        position,
        duration: item?.duration ?? 120,
        playbackRate: rate,
        naturalBoundaries: { trackSerial: serial, queueSerial: 0, trackTimeMs: now, queueTimeMs: 0 }
      })
    },
    account(value: number | null) {
      account = value
    },
    changeAccount() {
      context = 'account-B'
      account = 8
      sync.accountChanged()
    },
    fail(value: Error | null) {
      failure = value
    }
  }
}

test('disabled listening and unmapped local songs never submit', async () => {
  const f = fixture(false)
  f.tick(0, 0)
  f.tick(30, 30)
  f.tick(0, 30, 'stopped')
  f.sync.setEnabled(true)
  const local = { ...track(), id: 'local:file', ncmSongId: undefined, source: 'local' }
  f.tick(0, 0, 'playing', local)
  f.tick(30, 30, 'stopped', local)
  await f.sync.flush()
  assert.equal(f.reports.length, 0)
})

test('pause/resume, stalled playback and seeks only contribute actual listening seconds', async () => {
  const f = fixture()
  f.tick(0, 0)
  f.tick(10, 10)
  f.tick(0, 90) // seek forward cannot create 80 seconds
  f.tick(5, 95)
  f.tick(0, 95, 'paused')
  f.tick(200, 95, 'paused')
  f.tick(0, 95)
  f.tick(20, 95) // decoder stalled
  f.tick(0, 5) // backwards seek
  f.tick(10, 15)
  f.tick(0, 15, 'stopped')
  await f.sync.flush()
  assert.equal(f.reports.length, 1)
  assert.equal(f.reports[0].time, 25)
  assert.equal(f.reports[0].accountId, 7)
  assert.equal(f.sync.status().lastSubmitted?.seconds, 25)
})

test('duplicate observations and repeated stop/flush do not resubmit', async () => {
  const f = fixture()
  f.tick(0, 0)
  f.tick(20, 20)
  f.tick(0, 20)
  f.tick(0, 20, 'stopped')
  f.tick(0, 20, 'stopped')
  await f.sync.flush()
  await f.sync.flush()
  await f.sync.shutdown()
  assert.equal(f.reports.length, 1)
})

test('cached publications preserve the sampling baseline while explicit seeks discard stalled time', async () => {
  const f = fixture()
  f.tick(0, 0)
  f.tick(10, 0) // cached sample published just before a fresh native read
  f.tick(0, 10)
  f.tick(100, 10) // stalled decoder
  f.sync.seeked('local', { state: 'playing', position: 50, duration: 120 })
  f.tick(0, 50)
  f.tick(5, 55, 'stopped')
  await f.sync.flush()
  assert.equal(f.reports[0].time, 15)
})

test('natural single-song repeats and duplicate queue occurrences are distinct attempts', async () => {
  const f = fixture()
  f.tick(0, 0)
  f.tick(119, 119)
  f.tick(1, 0, 'playing', track(), 1)
  f.tick(20, 20, 'playing', track(), 1)
  f.tick(0, 0, 'playing', track(1, 'another-occurrence'), 1)
  f.tick(10, 10, 'stopped', track(1, 'another-occurrence'), 1)
  await f.sync.flush()
  assert.deepEqual(
    f.reports.map((r) => r.time),
    [120, 20, 10]
  )
  assert.equal(new Set(f.reports.map((r) => r.key)).size, 3)
})

test('turning off discards the unfinished attempt; turning on never backfills', async () => {
  const f = fixture()
  f.tick(0, 0)
  f.tick(30, 30)
  f.sync.setEnabled(false)
  f.tick(30, 60)
  f.sync.setEnabled(true)
  f.tick(0, 60)
  f.tick(10, 70, 'stopped')
  await f.sync.flush()
  assert.deepEqual(
    f.reports.map((r) => r.time),
    [10]
  )
})

test('account changes discard old pending work and bind new attempts to the new account', async () => {
  const f = fixture()
  f.tick(0, 0)
  f.tick(10, 10, 'stopped')
  f.changeAccount()
  f.tick(0, 10)
  f.tick(5, 15, 'stopped')
  await f.sync.flush()
  assert.deepEqual(
    f.reports.map((r) => [r.accountId, r.time]),
    [[8, 5]]
  )
})

test('signed-out playback is not uploaded after a later login', async () => {
  const f = fixture()
  f.account(null)
  f.tick(0, 0)
  f.tick(10, 10, 'stopped')
  await f.sync.flush()
  assert.match(f.sync.status().error!, /登录/)
  assert.equal(f.reports.length, 0)
})

test('ambiguous failures are visible and never automatically retried', async () => {
  const f = fixture()
  f.fail(new Error('PLV 成功但 PLD 失败'))
  f.tick(0, 0)
  f.tick(10, 10, 'stopped')
  await f.sync.flush()
  assert.match(f.sync.status().error!, /PLD/)
  assert.equal(f.sync.status().lastSubmitted, null)
  f.fail(null)
  await f.sync.flush()
  assert.equal(f.reports.length, 0)
  f.tick(0, 0)
  f.tick(5, 5, 'stopped')
  await f.sync.flush()
  assert.equal(f.reports[0].time, 5)
  assert.equal(f.sync.status().error, null)
})

test('session shutdown sends observed listening and independent sessions remain separate', async () => {
  const f = fixture()
  f.tick(0, 0)
  f.tick(0, 0, 'playing', track(2), 0, 'group:1')
  f.tick(10, 10)
  f.tick(0, 10, 'playing', track(2), 0, 'group:1')
  f.sync.closeSession('group:1')
  await f.sync.shutdown()
  assert.deepEqual(
    f.reports.map((r) => [r.id, r.time]),
    [
      [2, 10],
      [1, 10]
    ]
  )
})

test('rate changes count wall-clock listening, and trusted matched local songs are accepted', async () => {
  const f = fixture()
  const local = { ...track(9), id: 'local:matched', source: 'local' }
  f.tick(0, 0, 'playing', local, 0, 'local', 2)
  f.tick(10, 20, 'stopped', local, 0, 'local', 2)
  await f.sync.flush()
  assert.equal(f.reports[0].id, 9)
  assert.equal(f.reports[0].time, 10)
})
