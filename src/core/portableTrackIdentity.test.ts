import assert from 'node:assert/strict'
import test from 'node:test'
import { migrateSafTrackIds } from './portableTrackIdentity.ts'
import { qualifySafTrackId, safBookmarkTrackKey } from '../shared/safTrackIdentity.ts'
import { createPlaybackBookmarks } from './bookmarks/controller.ts'
import { DEFAULT_PLAYBACK_BOOKMARKS } from '../shared/playbackBookmarks.ts'

const ID = `local:saf:${'a'.repeat(24)}`
const CUE = `local:cue:${'b'.repeat(24)}`
const SACD = `local:sacd:${'c'.repeat(24)}:stereo:2`
const DELETED = `local:saf:${'f'.repeat(24)}`
const EXTERNAL = 'com.android.externalstorage.documents'
const source = (authority: string, tree = 'root') => `content://${authority}/tree/${tree}/document/shared%3AMusic%2Fa%23%25%3F.flac`
const record = (id: string, authority: string) => ({ id, filePath: source(authority), source: 'local' })

test('SAF namespaces agree for all track kinds, preserve external IDs, and do not depend on a tree grant', () => {
  for (const id of [ID, CUE, SACD]) {
    assert.equal(qualifySafTrackId(id, source(EXTERNAL)), id)
    assert.equal(qualifySafTrackId(id, source('alpha.documents')), `${id}@alpha.documents`)
    assert.equal(qualifySafTrackId(id, source('beta.documents')), `${id}@beta.documents`)
    assert.equal(qualifySafTrackId(`${id}@alpha.documents`, source('alpha.documents')), `${id}@alpha.documents`)
    assert.equal(safBookmarkTrackKey(id, source('alpha.documents', 'overlap')), `saf:${id}@alpha.documents`)
    assert.equal(safBookmarkTrackKey(id, source('alpha.documents').replace('tree/root/', '')), `saf:${id}@alpha.documents`)
    assert.equal(qualifySafTrackId(id, 'D:/Music/a.flac'), id)
    assert.equal(safBookmarkTrackKey(id, 'D:/Music/a.flac'), null)
  }
  assert.equal(safBookmarkTrackKey('provider:1', source('alpha.documents')), null)
})

test('colliding library, queue and playlist records migrate from their own sources, not scan order', () => {
  const library = record(ID, 'alpha.documents')
  const beta = record(ID, 'beta.documents')
  const external = record(ID, EXTERNAL)
  const envelope = {
    tracks: [library],
    session: { track: { ...beta, queueEntryId: 'second' }, queue: [external, beta], queueIndex: 1, position: 12.75 },
    queues: [{ id: 'q', revision: 8, rows: [
      { queueEntryId: 'first', trackId: ID, snapshot: { ...external } },
      { queueEntryId: 'second', trackId: ID, snapshot: { ...beta } },
      { queueEntryId: 'third', trackId: ID, snapshot: null }
    ] }],
    playlists: [
      { id: 'favorite', trackIds: [ID] },
      { id: 'beta', trackIds: [ID], trackSnapshots: { [ID]: { ...beta } }, variantPreferences: { [ID]: ID } }
    ],
    customPlaylists: [{ id: 'legacy', trackIds: [ID] }],
    lyricsManagement: { tracks: { [ID]: { original: 'Manual lyrics', offsetMs: 250 } } },
    bookmarks: { bookmarks: [library, beta, external].map((track, i) => ({
      id: `bm-${i}`, trackId: ID, trackKey: `local:${track.filePath}`, label: `Bookmark ${i}`, positionSeconds: i + 1
    })) }
  }
  migrateSafTrackIds(envelope)
  assert.equal(envelope.tracks[0].id, `${ID}@alpha.documents`)
  assert.equal(envelope.session.track.id, `${ID}@beta.documents`)
  assert.deepEqual(envelope.session.queue.map(({ id }) => id), [ID, `${ID}@beta.documents`])
  assert.deepEqual(envelope.queues[0].rows.map(({ trackId }) => trackId), [ID, `${ID}@beta.documents`, `${ID}@alpha.documents`])
  assert.equal(envelope.queues[0].rows[1].queueEntryId, 'second')
  assert.equal(envelope.queues[0].revision, 8)
  assert.equal(envelope.session.position, 12.75)
  assert.deepEqual(envelope.playlists[0].trackIds, [`${ID}@alpha.documents`])
  assert.deepEqual(envelope.playlists[1].trackIds, [`${ID}@beta.documents`])
  assert.equal(envelope.playlists[1].trackSnapshots![`${ID}@beta.documents`].filePath, source('beta.documents'))
  assert.deepEqual(envelope.playlists[1].variantPreferences, { [`${ID}@beta.documents`]: `${ID}@beta.documents` })
  assert.deepEqual(envelope.customPlaylists[0].trackIds, [`${ID}@alpha.documents`])
  assert.deepEqual(envelope.lyricsManagement.tracks, { [`${ID}@alpha.documents`]: { original: 'Manual lyrics', offsetMs: 250 } })
  assert.deepEqual(envelope.bookmarks.bookmarks.map(({ trackId }) => trackId), [`${ID}@alpha.documents`, `${ID}@beta.documents`, ID])
  assert.deepEqual(envelope.bookmarks.bookmarks.map(({ trackKey }) => trackKey), [`saf:${ID}@alpha.documents`, `saf:${ID}@beta.documents`, `saf:${ID}`])
  const migrated = structuredClone(envelope)
  migrateSafTrackIds(envelope)
  assert.deepEqual(envelope, migrated, 'a second boot must not remap namespaces or bookmarks')
})

test('CUE and SACD selectors, imported bindings, deleted bookmarks and qualified lyric edits survive migration', () => {
  const cue = { ...record(CUE, 'alpha.documents'), cueRange: { startSeconds: 12, endSeconds: 60 } }
  const sacd = { ...record(SACD, 'alpha.documents'), subTrack: `${source('alpha.documents')}#twilight-sacd=stereo:2` }
  const secondArea = { ...sacd, id: SACD.replace('stereo:2', 'multichannel:2'), subTrack: sacd.subTrack.replace('stereo:2', 'multichannel:2') }
  const envelope = {
    tracks: [cue, sacd, secondArea, record('provider:42', 'alpha.documents')],
    playlists: [{ trackIds: ['import-entry'], imported: { entries: [
      { entryId: 'import-entry', resolution: { track: { ...cue } }, manualBinding: { ...sacd } }
    ] } }],
    lyricsManagement: { tracks: { [CUE]: { original: 'Old' }, [`${CUE}@alpha.documents`]: { original: 'New' },
      [DELETED]: { original: 'Offline edit' } } },
    bookmarks: { bookmarks: [
      { trackId: CUE, trackKey: `local:${cue.filePath}#cue:12` },
      { trackId: SACD, trackKey: `local:${sacd.filePath}#${sacd.subTrack}` },
      { trackId: DELETED, trackKey: `local:${source('offline.documents')}` }
    ] }
  }
  migrateSafTrackIds(envelope)
  assert.equal(cue.id, `${CUE}@alpha.documents`)
  assert.deepEqual(cue.cueRange, { startSeconds: 12, endSeconds: 60 })
  assert.equal(sacd.subTrack, `${source('alpha.documents')}#twilight-sacd=stereo:2`)
  assert.notEqual(sacd.id, secondArea.id)
  assert.equal(envelope.tracks[3].id, 'provider:42')
  assert.deepEqual(envelope.playlists[0].trackIds, ['import-entry'])
  assert.equal(envelope.playlists[0].imported.entries[0].resolution.track.id, cue.id)
  assert.equal(envelope.playlists[0].imported.entries[0].manualBinding.id, sacd.id)
  assert.deepEqual(envelope.lyricsManagement.tracks, { [`${CUE}@alpha.documents`]: { original: 'New' },
    [`${DELETED}@offline.documents`]: { original: 'Offline edit' } })
  assert.deepEqual(envelope.bookmarks.bookmarks.map(({ trackKey }) => trackKey), [
    `saf:${CUE}@alpha.documents`, `saf:${SACD}@alpha.documents`, `saf:${DELETED}@offline.documents`
  ])
})

test('bookmark lookup uses stable document-track IDs across grants but keeps CUE sheets and SACD areas separate', () => {
  const controller = createPlaybackBookmarks({
    document: { value: structuredClone(DEFAULT_PLAYBACK_BOOKMARKS) },
    repository: { load: async () => null, save: async (data, revision) => ({ version: 2, revision: revision + 1, savedAt: '', data }) },
    now: () => 0, newId: () => 'bm', changed() {}
  })
  const one = { ...record(CUE, 'alpha.documents'), cueRange: { startSeconds: 12, endSeconds: 60, pregapSeconds: 0 }, source: 'local' }
  const key = controller.trackKeyFor(one)
  assert.equal(key, controller.trackKeyFor({ ...one, filePath: source('alpha.documents', 'nested') }))
  assert.notEqual(key, controller.trackKeyFor({ ...one, filePath: source('beta.documents') }))
  assert.notEqual(key, controller.trackKeyFor({ ...one, id: `local:cue:${'d'.repeat(24)}` }))
  assert.notEqual(controller.trackKeyFor({ ...record(SACD, 'alpha.documents') }),
    controller.trackKeyFor({ ...record(SACD.replace('stereo:2', 'multichannel:2'), 'alpha.documents') }))
  assert.equal(controller.trackKeyFor({ ...one, filePath: 'D:/Music/a.flac' }), 'local:D:/Music/a.flac#cue:12')
})
