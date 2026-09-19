import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '@renderer/types/music.ts'
import {
  compareAlbumTrackOrder,
  getAlbumIdentity,
  mergeAlbumGroupsByReleaseEvidence
} from '@renderer/stores/library/musicStoreData.ts'
import { buildLibraryLoudnessPlan, type LoudnessAlbum } from './libraryLoudnessPlan.ts'

function track(id: string, patch: Partial<Track> = {}): Track {
  return {
    id,
    title: id,
    artist: 'Artist',
    album: 'Album',
    filePath: `D:/music/${id}.flac`,
    fileName: `${id}.flac`,
    source: 'local',
    size: 1,
    duration: 30,
    cover: null,
    lyrics: null,
    ...patch
  }
}

test('album analysis expands a selection to the materialized multi-disc album and keeps separate releases apart', () => {
  const selected = track('disc2', { discNumber: 2, trackNumber: 1, albumId: 'release-a' })
  const first = track('disc1', { discNumber: 1, trackNumber: 3, albumId: 'release-a' })
  const other = track('other', { albumId: 'release-b' })
  const album: LoudnessAlbum = {
    id: 'id:release-a',
    name: 'Album',
    trackCount: 2,
    cover: null,
    tracks: [selected, first].sort(compareAlbumTrackOrder)
  }
  const second: LoudnessAlbum = {
    id: 'id:release-b',
    name: 'Album',
    trackCount: 1,
    cover: null,
    tracks: [other]
  }
  const plan = buildLibraryLoudnessPlan([selected], [album, second], 'album')
  assert.equal(plan.groups.length, 1)
  assert.equal(plan.groups[0].id, 'album:id:release-a')
  assert.deepEqual(
    plan.groups[0].tracks.map((track) => track.id),
    ['disc1', 'disc2']
  )
  assert.equal(plan.trackCount, 2)
})

test('compilations and CUE tracks reuse existing album identity without synthetic pregap in the source range', () => {
  const cueRange = { startSeconds: 3, endSeconds: 10, pregapSeconds: 2, virtualPregapSeconds: 2 }
  const a = track('cue:1', {
    artist: 'First',
    filePath: 'D:/release/disc.flac',
    cueRange,
    subTrack: 'cue:1'
  })
  const b = track('cue:2', {
    artist: 'Second',
    filePath: a.filePath,
    cueRange: { ...cueRange, startSeconds: 10, endSeconds: 20 },
    subTrack: 'cue:2'
  })
  assert.equal(getAlbumIdentity(a), getAlbumIdentity(b))
  const merged = mergeAlbumGroupsByReleaseEvidence(
    new Map([[getAlbumIdentity(a), { tracks: [a, b], cover: null, artist: a.artist }]])
  )
  const albums = [...merged].map(([id, group]) => ({
    id,
    name: 'Album',
    trackCount: group.tracks.length,
    ...group
  }))
  const plan = buildLibraryLoudnessPlan([a], albums, 'album')
  assert.equal(plan.groups[0].tracks.length, 2)
  assert.deepEqual(plan.groups[0].tracks[0].cueRange, cueRange)
  assert.notEqual(plan.groups[0].tracks[0].cueRange, cueRange)
})

test('batch planning deduplicates selections, excludes remote tracks and bounds payloads', () => {
  const local = track('local', { lyrics: 'x'.repeat(10000), cover: 'data:image/png;base64,AAAA' })
  const remote = track('ncm:1', { source: 'ncm', filePath: 'https://example.test/1' })
  const plan = buildLibraryLoudnessPlan([local, local, remote], [], 'track')
  assert.equal(plan.trackCount, 1)
  assert.equal(plan.skipped, 1)
  assert.equal('lyrics' in plan.groups[0].tracks[0], false)
  assert.equal('cover' in plan.groups[0].tracks[0], false)
  const large = Array.from({ length: 10001 }, (_, index) => track(String(index)))
  assert.match(buildLibraryLoudnessPlan(large, [], 'track').error, /10,000/)
  const album = {
    id: 'huge',
    name: 'Huge',
    trackCount: 257,
    cover: null,
    tracks: large.slice(0, 257)
  }
  assert.match(buildLibraryLoudnessPlan([large[0]], [album], 'album').error, /256/)
})
