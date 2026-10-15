import assert from 'node:assert/strict'
import test from 'node:test'
import { createPluginMarketIndex, searchPluginMarket } from './pluginMarketSearch.ts'

const entries = [
  {
    id: 'com.alice.lyrics',
    name: '歌词工具',
    author: 'Alice',
    description: '同步显示歌词',
    tags: ['lyrics', 'karaoke', 'community'],
    type: ['tool']
  },
  {
    id: 'org.bob.radio',
    name: 'Radio',
    author: 'Bob',
    description: '网络电台目录',
    tags: ['streaming'],
    type: ['provider', 'ui']
  }
]

test('searches plugin names, authors, descriptions, ids and tags across publishers', () => {
  const index = createPluginMarketIndex(entries)
  for (const query of ['歌词', 'Alice', '同步显示', 'com.alice', 'karaoke', 'community']) {
    assert.deepEqual(
      searchPluginMarket(index, query).map((entry) => entry.id),
      ['com.alice.lyrics']
    )
  }
  assert.deepEqual(
    searchPluginMarket(index, 'streaming').map((entry) => entry.id),
    ['org.bob.radio']
  )
  assert.deepEqual(index.authors, ['Alice', 'Bob'])
})

test('combines type and author filters without hiding plugins with multiple types', () => {
  const index = createPluginMarketIndex(entries)
  assert.deepEqual(
    searchPluginMarket(index, '', 'ui').map((entry) => entry.id),
    ['org.bob.radio']
  )
  assert.deepEqual(
    searchPluginMarket(index, 'radio', 'provider', 'Bob').map((entry) => entry.id),
    ['org.bob.radio']
  )
  assert.deepEqual(searchPluginMarket(index, 'radio', 'provider', 'Alice'), [])
})

test('classifies by an exact publisher tag and combines it with search and author', () => {
  const index = createPluginMarketIndex([
    ...entries,
    { ...entries[0], id: 'com.alice.other', tags: [' Karaoke ', 'karaoke', '', 'karaoke-extra'] }
  ])
  assert.deepEqual(index.tags, ['community', 'karaoke', 'karaoke-extra', 'lyrics', 'streaming'])
  assert.equal(searchPluginMarket(index, '', '', '', 'KARAOKE').length, 2)
  assert.deepEqual(searchPluginMarket(index, '同步', 'tool', 'Alice', 'lyrics'), [entries[0]])
  assert.deepEqual(searchPluginMarket(index, '', '', 'Bob', 'karaoke'), [])
  assert.deepEqual(searchPluginMarket(index, '', '', '', 'missing'), [])
})
