import assert from 'node:assert/strict'
import test from 'node:test'
import type { TrackData as Track } from '../../../shared/track.ts'
import {
  getMusicVersions,
  previewMusicVersionEdit,
  loadMusicVersions,
  saveMusicVersions,
  musicVersionError
} from './musicVersions.ts'
import { emptyMusicVersions } from '@renderer/utils/musicVersions.ts'
import { versionSourceKey } from '@renderer/utils/trackSourceIdentity.ts'
import { buildLogicalTracks, canShareTrackIdentity } from '@renderer/utils/logicalTrackModel.ts'
import { buildAggregateRows, resolveAggregateQueue } from '@renderer/utils/aggregatePlaylistView.ts'
import { findPlaybackFallbackTrack } from '@renderer/utils/playbackFallback.ts'

import { installVersionsCoreFixture } from '../components/music-versions/versionsCore.fixture.mjs'

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
test('one persisted interpretation drives search, aggregate playlists, identity and fallback', async () => {
  const host = await installVersionsCoreFixture()
  await loadMusicVersions()
  const a = track('local:a'),
    b = track('ncm:1', 'Different title'),
    live = track('ncm:2')
  const mutate = async (operation: Parameters<typeof previewMusicVersionEdit>[1], tracks: Track[]) => {
    const { before, after } = previewMusicVersionEdit('tracks', operation, tracks.map(versionSourceKey), 'Version')
    await saveMusicVersions(after, before)
  }
  await mutate('sources', [a, b])
  assert.equal(canShareTrackIdentity(a, b), true)
  assert.equal(buildLogicalTracks([{ track: a }, { track: b }, { track: live }]).length, 2)
  await mutate('prefer-source', [b])
  assert.equal(buildLogicalTracks([{ track: a }, { track: b }])[0].preferredTrack.id, b.id)
  const missing = buildLogicalTracks([{ track: a }])[0]
  assert.equal(missing.preferenceUnavailable, true)
  assert.equal(resolveAggregateQueue(buildAggregateRows({ tracks: [a] })).length, 0)
  assert.equal(findPlaybackFallbackTrack({ failedTrack: b, candidates: [a, live] }), null)
  const original = [a, b, b, live]
  await mutate('split', [b])
  assert.equal(canShareTrackIdentity(a, b), false)
  assert.equal(original.length, 4)
  assert.equal(buildAggregateRows({ tracks: original }).length, 3)
  await loadMusicVersions()
  assert.equal(canShareTrackIdentity(a, b), false)
  const before = getMusicVersions()
  host.fail('quota')
  await assert.rejects(mutate('reset', [a]), /quota/)
  assert.equal(getMusicVersions(), before)
  host.fail('')
  await loadMusicVersions()
  const preview = previewMusicVersionEdit('tracks', 'reset', [versionSourceKey(a)], '')
  host.external(emptyMusicVersions(), false)
  await assert.rejects(saveMusicVersions(preview.after, preview.before), /其他窗口/)
  host.invalid(true)
  await assert.rejects(loadMusicVersions(), /重新读取/)
  assert.ok(musicVersionError.value)
  assert.throws(() => previewMusicVersionEdit('tracks', 'reset', [], ''), /重新读取/)
  host.invalid(false)
  host.external(emptyMusicVersions())
  await loadMusicVersions()

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
