import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track, QueuePlaybackOrigin } from '../types/music'
import {
  preserveQueueEntryContext,
  resolveQueuePlaybackOrigin,
  withQueuePlaybackOrigin
} from './queuePlaybackOrigin.ts'
import { toPlaybackQueueSnapshots, patchPlaybackQueueTrack } from './playbackQueueVirtualization.ts'

const song: Track = {
  id: 'ncm:1',
  title: 'Song',
  artist: 'Artist',
  album: 'Track album',
  albumId: 'track-album',
  source: 'ncm',
  filePath: '',
  fileName: 'Song',
  duration: 100,
  size: 0,
  cover: null,
  lyrics: null
}
const album: QueuePlaybackOrigin = {
  kind: 'album',
  scope: 'provider',
  providerId: 'ncm',
  id: 'album-1',
  name: 'Selected album'
}
const playlist: QueuePlaybackOrigin = {
  kind: 'playlist',
  scope: 'aggregate',
  id: 'playlist-1',
  name: 'Selected playlist'
}

test('queue source resolves only captured collection identities and never fabricates a playlist from album text', () => {
  assert.equal(resolveQueuePlaybackOrigin(song), null)
  assert.deepEqual(resolveQueuePlaybackOrigin(withQueuePlaybackOrigin(song, album)), {
    label: '专辑 · Selected album',
    target: album
  })
  assert.deepEqual(resolveQueuePlaybackOrigin(withQueuePlaybackOrigin(song, playlist)), {
    label: '歌单 · Selected playlist',
    target: playlist
  })
  assert.equal(resolveQueuePlaybackOrigin(withQueuePlaybackOrigin(song, null)), null)
  assert.equal(resolveQueuePlaybackOrigin({ queuePlaybackOrigin: { ...album, id: '' } }), null)
})

test('duplicate entries retain different origins when library metadata or the playback provider changes', () => {
  const queue = toPlaybackQueueSnapshots([
    withQueuePlaybackOrigin(song, album),
    withQueuePlaybackOrigin(song, playlist)
  ])
  assert.notEqual(queue[0].queueEntryId, queue[1].queueEntryId)
  assert.equal(patchPlaybackQueueTrack(queue, song), queue)
  const patched = patchPlaybackQueueTrack(queue, { ...song, title: 'Updated metadata' })
  assert.deepEqual(
    patched.map((track) => track.queuePlaybackOrigin),
    [album, playlist]
  )
  const replacement = withQueuePlaybackOrigin({ ...song, id: 'local:replacement' }, playlist)
  const rematched = preserveQueueEntryContext(replacement, patched[0])
  assert.equal(rematched.id, 'local:replacement')
  assert.equal(rematched.queueEntryId, patched[0].queueEntryId)
  assert.deepEqual(rematched.queuePlaybackOrigin, album)
})
