import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '@renderer/types/music'
import {
  captureQueueSession,
  restoreQueueTrackIdentity,
  saveQueueTrack
} from './queueSessionTrack.ts'

const track = {
  id: 'ncm:123',
  queueEntryId: 'q1',
  ncmSongId: 123,
  source: 'ncm',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  filePath: 'C:\\cache\\expired.flac',
  fileName: 'Song',
  streamUrl: 'https://expired.test/token',
  cover: 'twilight-media://old-cover',
  lyrics: 'heavy',
  duration: 120,
  size: 100
} as Track

test('saved queue entries retain provider identity without media URLs, cached files or heavy metadata', () => {
  const saved = saveQueueTrack(track)
  assert.doesNotMatch(JSON.stringify(saved), /expired|old-cover|heavy/)
  const restored = restoreQueueTrackIdentity(saved)
  assert.equal(restored.streamUrl, null)
  assert.equal(restored.filePath, '')
  assert.equal(restored.ncmSongId, 123)
  assert.equal(restored.queueEntryId, 'q1')
  const network = saveQueueTrack({
    ...track,
    source: 'network',
    networkSource: {
      profileId: 'nas',
      entry: { id: 'entry', profileId: 'nas', kind: 'audio', path: '/music/a.flac', name: 'a.flac' }
    }
  })
  assert.equal(restoreQueueTrackIdentity(network).networkSource?.entry.path, '/music/a.flac')
  assert.equal(restoreQueueTrackIdentity(network).filePath, '')
})

test('named sessions keep actual and original orders, duplicate cursors and bounded position', () => {
  const second = { ...track, queueEntryId: 'q2' }
  const saved = captureQueueSession('work', [second, track], [track, second], second, 30, 'shuffle')
  assert.deepEqual(
    saved.entries.map((entry) => entry.queueEntryId),
    ['q2', 'q1']
  )
  assert.deepEqual(saved.originalEntryIds, ['q1', 'q2'])
  assert.equal(saved.currentEntryId, 'q2')
  assert.equal(saved.position, 30)
  assert.equal(
    captureQueueSession('heart', [track], [track], track, Infinity, 'heart').playMode,
    'sequential'
  )
  assert.throws(() => captureQueueSession('empty', [], [], null, 0, 'sequential'), /队列为空/)
  assert.throws(
    () => captureQueueSession('large', Array(20_001).fill(track), [], null, 0, 'sequential'),
    /20,000/
  )
})
