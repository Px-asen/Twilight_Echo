import assert from 'node:assert/strict'
import test from 'node:test'
import { editMusicVersions, emptyMusicVersions, parseMusicVersions } from './musicVersions.ts'
import { versionSourceKey } from './trackSourceIdentity.ts'

test('recording sources, version families and preferences are separate and reversible', () => {
  const empty = emptyMusicVersions()
  let next = editMusicVersions(empty, 'tracks', 'sources', ['local:a', 'remote:a'], 'Studio')
  assert.equal(empty.tracks.versions.length, 0)
  next = editMusicVersions(next, 'tracks', 'family', ['local:a', 'remote:live'], '')
  assert.equal(next.tracks.versions.length, 2)
  next = editMusicVersions(next, 'tracks', 'prefer-version', ['remote:live'], '')
  next = editMusicVersions(next, 'tracks', 'prefer-source', ['remote:a'], '')
  assert.equal(next.tracks.versions[0].preferredSource, 'remote:a')
  assert.equal(next.tracks.families[0].preferredVersion, next.tracks.versions[1].id)
  const restored = parseMusicVersions(JSON.stringify(next))
  assert.deepEqual(restored, next)
  next = editMusicVersions(next, 'tracks', 'split', ['remote:a'], 'Separate')
  assert.equal(next.tracks.versions.length, 3)
  assert.equal(
    next.tracks.versions.find((item) => item.sources.includes('local:a'))?.preferredSource,
    null
  )
  next = editMusicVersions(next, 'tracks', 'reset', ['remote:a'], '')
  assert.ok(next.tracks.versions.every((item) => !item.sources.includes('remote:a')))
  assert.equal(next.tracks.families.length, 1)
})

test('merging connected families preserves every source once and removes empty references', () => {
  let next = editMusicVersions(emptyMusicVersions(), 'albums', 'family', ['a', 'b'], 'Release')
  next = editMusicVersions(next, 'albums', 'family', ['c', 'd'], 'Edition')
  next = editMusicVersions(next, 'albums', 'sources', ['b', 'c'], 'Same release')
  assert.equal(next.albums.families.length, 1)
  assert.deepEqual(
    new Set(next.albums.versions.flatMap((item) => item.sources)),
    new Set(['a', 'b', 'c', 'd'])
  )
  next = editMusicVersions(next, 'albums', 'reset', ['a', 'b', 'c', 'd'], '')
  assert.deepEqual(next.albums, { versions: [], families: [] })
  assert.deepEqual(next.tracks, { versions: [], families: [] })
})

test('persistence rejects unsupported, corrupt and overlapping records without inventing replacements', () => {
  assert.deepEqual(parseMusicVersions(null), emptyMusicVersions())
  assert.throws(() => parseMusicVersions('{'))
  assert.throws(() => parseMusicVersions('{"version":2}'))
  assert.throws(() => editMusicVersions(emptyMusicVersions(), 'tracks', 'sources', ['a'], ''))
  assert.throws(() =>
    editMusicVersions(emptyMusicVersions(), 'tracks', 'prefer-version', ['a'], '')
  )
  const next = editMusicVersions(emptyMusicVersions(), 'tracks', 'sources', ['a', 'b'], 'A')
  next.tracks.versions.push({ id: 'bad', label: 'B', sources: ['a'], preferredSource: null })
  assert.throws(() => parseMusicVersions(JSON.stringify(next)))
})

test('stable source identity ignores URLs, title and quality, preserves provider and CUE identity', () => {
  assert.equal(
    versionSourceKey({ id: 'ncm:12', source: 'ncm' }),
    versionSourceKey({ id: '12', source: 'ncm', ncmSongId: 12, streamUrl: 'expired' })
  )
  assert.notEqual(versionSourceKey({ id: 'ncm:12' }), versionSourceKey({ id: 'qq:12' }))
  assert.equal(
    versionSourceKey({ id: 'first', source: 'local', filePath: 'D:\\Music\\a.flac' }),
    versionSourceKey({ id: 'rescanned', source: 'local', filePath: 'd:/music/a.flac' })
  )
  assert.notEqual(
    versionSourceKey({ id: 'cue', source: 'local', filePath: 'D:/a.flac', subTrack: '1' }),
    versionSourceKey({ id: 'cue', source: 'local', filePath: 'D:/a.flac', subTrack: '2' })
  )
})
