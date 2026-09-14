import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '@renderer/types/music'
import { findNativeQueueTrackIndex } from './nativeQueueTrackIndex.ts'

const queue = [
  { id: 'ncm:123', queueEntryId: 'first', streamUrl: 'https://media.test/123', filePath: '' },
  { id: 'other', queueEntryId: 'other', filePath: 'C:\\music\\other.flac' },
  { id: 'ncm:123', queueEntryId: 'second', streamUrl: 'https://media.test/123', filePath: '' }
] as Track[]

test('delegated duplicate playback resolves the engine entry before the source-to-track hint', () => {
  assert.equal(
    findNativeQueueTrackIndex(
      queue,
      0,
      { queueIndex: 2, source: 'C:\\cache\\123.flac' },
      'ncm:123',
      true
    ),
    2
  )
})

test('single-track native queues and pending queue edits retain the renderer occurrence', () => {
  assert.equal(
    findNativeQueueTrackIndex(
      queue,
      2,
      { queueIndex: 0, source: 'C:\\cache\\123.flac' },
      'ncm:123',
      false
    ),
    2
  )
})

test('a stale index cannot select an unrelated track after replacement', () => {
  assert.equal(
    findNativeQueueTrackIndex(queue, 2, { queueIndex: 1, source: 'removed.flac' }, undefined, true),
    -1
  )
  assert.equal(
    findNativeQueueTrackIndex(
      queue,
      0,
      { queueIndex: 0, source: 'C:\\music\\other.flac' },
      undefined,
      true
    ),
    1
  )
})
