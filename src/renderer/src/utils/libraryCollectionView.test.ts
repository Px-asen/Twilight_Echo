import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '../types/music'
import {
  applyLibraryCollectionView,
  availableCollectionGenres,
  availableCollectionLetters,
  collectionAddedAt,
  collectionIndexLetter,
  collectionLetterAtScroll,
  firstCollectionIndexForLetter,
  LibraryCollectionViewPreferences,
  type LibraryCollectionItem
} from './libraryCollectionView.ts'

function track(id: string, genre: string | null, addedAt: number): Track {
  return {
    id,
    title: id,
    artist: 'Artist',
    album: 'Album',
    genre,
    filePath: `D:\\Music\\${id}.flac`,
    fileName: `${id}.flac`,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    addedAt
  }
}

function item(name: string, genresAndTimes: Array<[string | null, number]>): LibraryCollectionItem {
  return {
    name,
    tracks: genresAndTimes.map(([genre, addedAt], index) =>
      track(`${name}-${index}`, genre, addedAt)
    )
  }
}

test('combines genre filters, natural order and stable ties without mutating the input', () => {
  const items = Object.freeze([
    item('Écho10', [['Rock', 300]]),
    item('Écho2', [
      ['Jazz', 200],
      ['Rock', 100]
    ]),
    item('echo2', [['Rock', 200]])
  ])
  items.forEach((entry) => Object.assign(entry, { id: 'duplicate' }))

  for (const [sort, expected] of [
    ['name-asc', ['Écho2', 'echo2', 'Écho10']],
    ['name-desc', ['Écho10', 'Écho2', 'echo2']],
    ['added-newest', ['Écho10', 'Écho2', 'echo2']],
    ['added-oldest', ['Écho2', 'echo2', 'Écho10']]
  ] as const) {
    assert.deepEqual(
      applyLibraryCollectionView(items, { sort, genre: 'rock' }).map((entry) => entry.name),
      expected
    )
  }
})

test('uses the latest track addedAt as the artist or album add time', () => {
  assert.equal(
    collectionAddedAt(
      item('Release', [
        ['Jazz', 100],
        ['Jazz', 450],
        ['Jazz', 200]
      ])
    ),
    450
  )
  assert.equal(collectionAddedAt(item('', [[null, Infinity]])), 0)
  assert.equal(collectionAddedAt({ name: '' }), 0)
})

test('builds deduplicated genre choices case-insensitively', () => {
  const items = [
    item('A', [
      ['Rock', 1],
      ['rock', 2]
    ]),
    item('B', [['Jazz', 3]])
  ]
  assert.deepEqual(availableCollectionGenres(items), ['Jazz', 'Rock'])
})

test('splits multi-genre tags in collection filters with custom separators', () => {
  const items = [item('A', [['Rock|Jazz', 1]]), item('B', [['Fusion/Rock', 2]])]
  assert.deepEqual(availableCollectionGenres(items, '|'), ['Fusion/Rock', 'Jazz', 'Rock'])
  assert.deepEqual(
    applyLibraryCollectionView(items, { sort: 'name-asc', genre: 'Jazz' }, '|').map(
      (entry) => entry.name
    ),
    ['A']
  )
})

test('builds an A-Z index, disables absent letters, and finds jump targets', () => {
  const items = [item('Alpha', []), item('Beta', []), item('Björk', []), item('周杰伦', [])]
  assert.equal(collectionIndexLetter('Éclair'), 'E')
  assert.equal(collectionIndexLetter('周杰伦'), 'Z')
  assert.deepEqual([...availableCollectionLetters(items)].sort(), ['A', 'B', 'Z'])
  assert.equal(firstCollectionIndexForLetter(items, 'B'), 1)
  assert.equal(firstCollectionIndexForLetter(items, 'Z'), 3)
  assert.equal(firstCollectionIndexForLetter(items, 'M'), -1)
  assert.equal(
    collectionLetterAtScroll(
      [item('Alpha', []), item('Beta', []), item('Mango', [])],
      0,
      0,
      1,
      200
    ),
    'A'
  )
  assert.equal(
    collectionLetterAtScroll(
      [item('Alpha', []), item('Beta', []), item('Mango', [])],
      400,
      0,
      1,
      200,
      0
    ),
    'M'
  )
})

test('Chinese collections share the existing letter jump and scroll highlight', () => {
  const items = [item('陈奕迅', []), item('范特西', []), item('周杰伦', [])]
  assert.deepEqual([...availableCollectionLetters(items)].sort(), ['C', 'F', 'Z'])
  assert.equal(firstCollectionIndexForLetter(items, 'f'), 1)
  assert.equal(collectionLetterAtScroll(items, 400, 0, 1, 200, 0), 'Z')
  assert.equal(collectionIndexLetter('  范特西 '), 'F')
  assert.equal(collectionIndexLetter('E\u0301cho'), 'E')
  assert.equal(collectionIndexLetter('Ａlbum'), 'A')
})

test('numbers, punctuation, unsupported scripts and blank names keep no-letter behavior', () => {
  for (const name of ['42 Songs', '#1', '🎵 Album', 'かな', '𠀀', '', '   ']) {
    assert.equal(collectionIndexLetter(name), null, name)
  }
  assert.equal(availableCollectionLetters([item('42 Songs', []), item('🎵 Album', [])]).size, 0)
})

test('persists independent artist and album collection preferences', () => {
  const values = new Map<string, string>()
  const storage = {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value)
  } satisfies Storage
  const preferences = new LibraryCollectionViewPreferences(storage)
  preferences.write('artists', { sort: 'added-newest', genre: 'Rock' })
  preferences.write('albums', { sort: 'name-desc', genre: null })
  assert.deepEqual(preferences.read('artists'), { sort: 'added-newest', genre: 'Rock' })
  assert.deepEqual(preferences.read('albums'), { sort: 'name-desc', genre: null })
})
