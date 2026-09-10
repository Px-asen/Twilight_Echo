import assert from 'node:assert/strict'
import test from 'node:test'
import { movePlaylistEntry, orderPlaylistEntries } from './playlistLibraryView.ts'

test('saved ordering tolerates removed playlists and appends newly discovered playlists', () => {
  const entries = [{ id: 1 }, { id: 2 }, { id: 3 }]
  assert.deepEqual(
    orderPlaylistEntries(entries, ['deleted', '2', '1']).map((p) => p.id),
    [2, 1, 3]
  )
  assert.deepEqual(
    entries.map((p) => p.id),
    [1, 2, 3]
  )
})

test('dragging and keyboard moves preserve other groups and reject stale ids', () => {
  const order = ['a', 'b', 'c', 'd']
  assert.deepEqual(movePlaylistEntry(order, 'a', 'c'), ['b', 'c', 'a', 'd'])
  assert.deepEqual(movePlaylistEntry(order, 'd', 'b'), ['a', 'd', 'b', 'c'])
  assert.deepEqual(movePlaylistEntry(order, 'missing', 'b'), order)
})

test('pinned playlists keep priority over locally saved ordering', () => {
  const entries = [{ id: 1 }, { id: 2, pinned: true }, { id: 3 }]
  assert.deepEqual(
    orderPlaylistEntries(entries, ['1', '3', '2'], new Set(['3'])).map((p) => p.id),
    [3, 2, 1]
  )
})
