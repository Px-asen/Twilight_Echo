import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '@renderer/types/music'
import {
  getMusicVersions,
  loadMusicVersions,
  saveMusicVersions,
  musicVersionError
} from './musicVersions.ts'
import { editMusicVersions, emptyMusicVersions } from '@renderer/utils/musicVersions.ts'
import { versionSourceKey } from '@renderer/utils/trackSourceIdentity.ts'
import { buildLogicalTracks, canShareTrackIdentity } from '@renderer/utils/logicalTrackModel.ts'
import { buildAggregateRows, resolveAggregateQueue } from '@renderer/utils/aggregatePlaylistView.ts'
import { findPlaybackFallbackTrack } from '@renderer/utils/playbackFallback.ts'

const track = (id: string, title = 'Song'): Track => ({
  id,
  title,
  artist: 'Artist',
  album: 'Album',
  source: id.split(':')[0],
  filePath: id,
  fileName: id,
  duration: 180,
  size: 1,
  cover: null,
  lyrics: null
})
test('one persisted interpretation drives search, aggregate playlists, identity and fallback', () => {
  let raw: string | null = null
  let fail = false
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => raw,
      setItem: (_key: string, value: string) => {
        if (fail) throw new Error('quota')
        raw = value
      }
    }
  })
  loadMusicVersions()
  const a = track('local:a'),
    b = track('ncm:1', 'Different title'),
    live = track('ncm:2')
  const mutate = (operation: Parameters<typeof editMusicVersions>[2], tracks: Track[]) => {
    const before = getMusicVersions()
    saveMusicVersions(
      editMusicVersions(before, 'tracks', operation, tracks.map(versionSourceKey), 'Version'),
      before
    )
  }
  mutate('sources', [a, b])
  assert.equal(canShareTrackIdentity(a, b), true)
  assert.equal(buildLogicalTracks([{ track: a }, { track: b }, { track: live }]).length, 2)
  mutate('prefer-source', [b])
  assert.equal(buildLogicalTracks([{ track: a }, { track: b }])[0].preferredTrack.id, b.id)
  const missing = buildLogicalTracks([{ track: a }])[0]
  assert.equal(missing.preferenceUnavailable, true)
  assert.equal(resolveAggregateQueue(buildAggregateRows({ tracks: [a] })).length, 0)
  assert.equal(findPlaybackFallbackTrack({ failedTrack: b, candidates: [a, live] }), null)
  const original = [a, b, b, live]
  mutate('split', [b])
  assert.equal(canShareTrackIdentity(a, b), false)
  assert.equal(original.length, 4)
  assert.equal(buildAggregateRows({ tracks: original }).length, 3)
  loadMusicVersions()
  assert.equal(canShareTrackIdentity(a, b), false)
  const before = getMusicVersions()
  fail = true
  assert.throws(() => saveMusicVersions(emptyMusicVersions(), before), /quota/)
  assert.equal(getMusicVersions(), before)
  fail = false
  raw = JSON.stringify(emptyMusicVersions())
  assert.throws(() => saveMusicVersions(before, before), /其他窗口/)
  raw = 'invalid'
  loadMusicVersions()
  assert.ok(musicVersionError.value)
  assert.throws(() => saveMusicVersions(emptyMusicVersions(), getMusicVersions()), /重新读取/)
  raw = null
  loadMusicVersions()
  Reflect.deleteProperty(globalThis, 'localStorage')
})

test('provider IDs and explicit live release markers cannot bridge through a local candidate', () => {
  const local = track('local:a'),
    first = track('ncm:1'),
    second = track('ncm:2')
  assert.equal(
    buildLogicalTracks([{ track: local }, { track: first }, { track: second }]).length,
    2
  )
  assert.equal(canShareTrackIdentity(first, { ...local, album: 'Live' }), false)
})
