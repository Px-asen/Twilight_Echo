import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '@renderer/types/music'
import {
  buildVersionCatalog,
  resolvePreferredVersion,
  versionDescriptions
} from './versionCatalog.ts'
import { emptyMusicVersions, editMusicVersions } from '@renderer/utils/musicVersions.ts'

function track(id: string, album: string, disc = 1, index = 1): Track {
  return {
    id,
    title: id,
    artist: 'Artist',
    album,
    albumId: album,
    filePath: `D:/music/${id}.flac`,
    fileName: `${id}.flac`,
    source: 'local',
    duration: 180,
    size: 100,
    cover: null,
    lyrics: null,
    discNumber: disc,
    trackNumber: index
  }
}
test('album versions preserve disc/track order and refuse to play unavailable preferred releases', () => {
  const tracks = [track('b2', 'B', 2), track('b1', 'B'), track('a', 'A')]
  const catalog = buildVersionCatalog(tracks, 'albums')
  assert.deepEqual(
    catalog[0].tracks.map((item) => item.id),
    ['b1', 'b2']
  )
  const [b, a] = catalog
  let doc = editMusicVersions(emptyMusicVersions(), 'albums', 'family', [a.key, b.key], '')
  doc = editMusicVersions(doc, 'albums', 'label', [b.key], 'Live 2024')
  doc = editMusicVersions(doc, 'albums', 'prefer-version', [b.key], '')
  assert.deepEqual(
    resolvePreferredVersion(doc, 'albums', a.key, catalog).map((item) => item.id),
    ['b1', 'b2']
  )
  assert.throws(() => resolvePreferredVersion(doc, 'albums', a.key, [a]), /未载入/)
  assert.match(versionDescriptions(doc, 'albums').get(b.key)!, /Live 2024.*偏好版本/)
  assert.deepEqual(
    tracks.map((item) => item.id),
    ['b2', 'b1', 'a']
  )
})

test('a preferred source never silently falls back and changes do not rewrite track payloads', () => {
  const tracks = [track('a', 'A'), track('b', 'A')]
  const [a, b] = buildVersionCatalog(tracks, 'tracks')
  let doc = editMusicVersions(emptyMusicVersions(), 'tracks', 'sources', [a.key, b.key], 'Studio')
  doc = editMusicVersions(doc, 'tracks', 'prefer-source', [b.key], '')
  assert.equal(resolvePreferredVersion(doc, 'tracks', a.key, [a, b])[0], tracks[1])
  assert.throws(() => resolvePreferredVersion(doc, 'tracks', a.key, [a]), /未载入/)
  assert.equal(tracks[0].album, 'A')
})
