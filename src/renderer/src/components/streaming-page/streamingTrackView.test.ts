import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStreamingTrackView, indexStreamingTracks } from './streamingTrackView.ts'
import type { Track } from '@renderer/types/music'

const tracks = [
  { id: 'a', title: '夜曲 10', artist: '周杰伦', album: '十一月', duration: 240 },
  { id: 'b', title: '夜曲 2', artist: '周杰伦', album: '现场', duration: 180 },
  { id: 'c', title: 'Sunrise', artist: 'Alice', album: 'Morning', duration: 200 }
] as Track[]

test('playlist search combines terms across metadata and does not change the source', () => {
  const index = indexStreamingTracks(tracks)
  assert.deepEqual(
    buildStreamingTrackView(tracks, index, ' 周杰伦 现场 ', 'default', 'asc').map((t) => t.id),
    ['b']
  )
  assert.deepEqual(
    buildStreamingTrackView(tracks, index, 'SUNRISE', 'default', 'asc').map((t) => t.id),
    ['c']
  )
  assert.equal(buildStreamingTrackView(tracks, index, '不存在', 'default', 'asc').length, 0)
  assert.deepEqual(
    tracks.map((t) => t.id),
    ['a', 'b', 'c']
  )
})

test('view order is numeric, stable, reversible and returns original track identities', () => {
  const index = indexStreamingTracks(tracks)
  const title = buildStreamingTrackView(tracks, index, '夜曲', 'title', 'asc')
  assert.deepEqual(
    title.map((t) => t.id),
    ['b', 'a']
  )
  assert.equal(title[0], tracks[1])
  assert.deepEqual(
    buildStreamingTrackView(tracks, index, '', 'duration', 'desc').map((t) => t.id),
    ['a', 'c', 'b']
  )
  assert.deepEqual(buildStreamingTrackView(tracks, index, '', 'default', 'desc'), tracks)
})
