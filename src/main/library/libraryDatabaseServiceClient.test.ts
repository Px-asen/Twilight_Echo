import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  LibraryDatabaseServiceClient,
  type DatabaseUtilityProcess,
  type DatabaseServiceOptions
} from './libraryDatabaseServiceClient.ts'
import type { LibraryDatabaseWorkerRequest } from './libraryDatabaseProtocol.ts'
import { getLibraryDatabasePath, LibraryDatabase } from './libraryDatabase.ts'
import { versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import { PlatformIdentificationProvider } from '../../core/library/musicIdentificationProvider.ts'
import type { MusicAlbum } from '../../shared/rhineMusic.ts'
import { listeningSourceIdentity } from '../../shared/listeningSourceIdentity.ts'
import { CoreMetadataService } from '../../core/library/metadataService.ts'

class ManualProcess extends EventEmitter {
  messages: LibraryDatabaseWorkerRequest[] = []
  kills = 0
  postMessage(message: LibraryDatabaseWorkerRequest) {
    this.messages.push(message)
  }
  kill() {
    this.kills++
    this.emit('exit', 0)
  }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('personal metadata images, source choices and legacy provenance survive the real worker transport and replacement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'metadata-personal-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = [], revisions: number[] = []
  writeFileSync(json, JSON.stringify([{ id: 'one', source: 'local', filePath: join(root, 'one.flac'), title: 'One', artist: 'Artist', album: 'Album' }]))
  const open = () => workerClient(json, children, undefined, revision => revisions.push(revision))
  let client = open()
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata()
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance()
  const artist = (await client.catalogQuery({ kind: 'artist' })).items[0].id
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII='
  const before = await client.musicBackupRevision()
  await client.metadataArtworkOverride({ entityId: artist, revision: 0, mode: 'value', language: 'en', dataUrl: png }, 10)
  await client.metadataSourcePreference({ entityId: artist, revision: 1, language: 'en', provider: 'wikipedia' }, 11)
  assert.ok((await client.musicBackupRevision()).metadata > before.metadata)
  await tick(); assert.ok(revisions.length > 0)
  const plugin = 'com.example.metadata'
  const contentRevision = (await client.getMetadata()).revision
  await client.legacyMusicBegin(plugin, 0, { albums: {} }, 1, contentRevision)
  await client.legacyMusicStage({ pluginId: plugin, sourceRevision: 0, contentRevision, entries: [
    { id: 'old', value: { title: 'Old', description: 'User reviewed text', descriptionSource: { name: 'Old marker' } } }
  ] })
  await client.legacyMusicPublish(plugin, 0, contentRevision)
  const pending = await client.legacyMusicProvenanceList(plugin)
  assert.equal(pending.total, 1)
  const read = await client.legacyMusicProvenanceRead(plugin, 'old', -1)
  await client.legacyMusicProvenanceReview(plugin, { expectedRevision: read.revision, albumId: 'old', snapshotRevision: -1,
    description: read.item.description, disposition: 'manual' })
  assert.equal((await client.legacyMusicProvenanceList(plugin)).total, 0)
  const saved = await client.metadataDetail(artist, 'en')
  const exited = once(children.at(-1)!, 'exit')
  client.destroy(); await exited; client = open()
  const detail = await client.metadataDetail(artist, 'en')
  assert.deepEqual(detail, saved)
  assert.equal(detail.manualArtwork?.dataUrl, png)
  assert.equal(detail.sourcePreference?.provider, 'wikipedia')
  assert.equal((await client.legacyMusicProvenanceRead(plugin, 'old', -1)).item.disposition, 'manual')
  const portable = await client.musicBackupExport(180 * 1024 * 1024)
  assert.equal(portable.records.artworkOverrides!.length, 1)
  assert.equal(portable.records.sourcePreferences![0].provider, 'wikipedia')
})

test('Focus saved queries, complete revision events and frozen history tokens survive real worker replacement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'focus-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = [], states: import('../../shared/musicFocus.ts').MusicFocusState[] = []
  writeFileSync(json, JSON.stringify([{ id: 'focus-one', source: 'local', filePath: join(root, 'one.flac'),
    title: 'One', artist: 'Artist', album: 'Album', duration: 200 }]))
  const open = () => workerClient(json, children, undefined, undefined, undefined, undefined, undefined, state => states.push(state))
  let client = open()
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata()
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance()
  const query = { version: 1 as const, entity: 'recording' as const, where: { source: { provider: 'local' } } }
  const created = await client.focusSavedCreate({ name: 'Night', query, savedRevision: 0 }, 100)
  const renamed = await client.focusSavedRename({ id: created.item.id, name: 'Local music', nameRevision: 1 }, 101)
  const updated = await client.focusSavedUpdate({ id: created.item.id, query: { ...query, where: { text: 'One' } }, queryRevision: 1 }, 102)
  assert.equal(updated.item.nameRevision, renamed.item.nameRevision)
  await assert.rejects(client.focusSavedUpdate({ id: created.item.id, query, queryRevision: 1 }, 103), { code: 'STALE_REVISION' })
  const page = await client.focusQuery({ query: updated.item.query })
  const facets = await client.focusFacets({ query: updated.item.query, token: page.token, facet: 'provider' })
  const privatePage = await client.focusPlaybackPage({ query: updated.item.query, token: page.token, anchorSourceId: page.items[0].sourceId! })
  assert.equal(page.total, 1); assert.equal(facets.items[0].count, 1); assert.equal(privatePage.total, 1)
  assert.equal(privatePage.items[0].track.filePath, join(root, 'one.flac'))
  assert.equal(privatePage.items[0].sourceId, page.items[0].sourceId)
  assert.equal(JSON.stringify(page).includes(root.replaceAll('\\', '\\\\')), false)
  assert.equal('track' in page.items[0], false)
  const history = await client.syncListeningHistory({ kind: 'begin', id: 'focus-history', mode: 'replace' })
  await client.syncListeningHistory({ kind: 'append', id: history.id, sequence: 1,
    entries: [{ id: listeningSourceIdentity('local', 'focus-one'), lastPlayed: 1000 }] })
  await client.syncListeningHistory({ kind: 'commit', id: history.id, sequence: 2 })
  await assert.rejects(client.focusQuery({ query: updated.item.query, token: page.token }), { code: 'STALE_REVISION' })
  const after = await client.focusQuery({ query: updated.item.query })
  assert.equal(after.items[0].lastPlayed, 1000)
  const current = await client.focusState()
  await tick()
  assert.deepEqual(states.at(-1), current)
  const exited = once(children.at(-1)!, 'exit')
  client.destroy(); await exited; client = open()
  assert.deepEqual(await client.focusState(), current)
  assert.deepEqual((await client.focusSavedList({})).items, [updated.item])
  assert.equal((await client.focusQuery({ query: updated.item.query })).items[0].lastPlayed, 1000)
  assert.equal((await client.focusSavedDelete({ id: updated.item.id, nameRevision: updated.item.nameRevision, queryRevision: updated.item.queryRevision })).deletedId, updated.item.id)
  assert.equal((await client.focusSavedList({})).total, 0)
  assert.equal((await client.getMetadata()).trackCount, 1)
})

test('tag references, private queue pages and full revision events survive real database worker replacement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tags-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = [], tokens: import('../../shared/musicTags.ts').MusicTagsToken[] = []
  writeFileSync(json, JSON.stringify([{ id: 'tagged', source: 'local', filePath: join(root, 'tagged.flac'),
    title: 'Tagged', artist: 'Artist', album: 'Album', duration: 200 }]))
  const open = () => workerClient(json, children, undefined, undefined, undefined, undefined, token => tokens.push(token))
  let client = open()
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata()
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance()
  const release = (await client.catalogQuery({ kind: 'release' })).items[0]
  const initial = await client.tagsState()
  const created = await client.tagsCreate({ name: '雨夜', tagsRevision: initial.tagsRevision }, 1000)
  const assigned = await client.tagsMemberSet({ tagId: created.tag.id, entityId: release.id, present: true, membersRevision: 0 }, 1001)
  const renamed = await client.tagsRename({ tagId: created.tag.id, name: '夜晚', nameRevision: created.tag.nameRevision }, 1002)
  assert.equal(renamed.tag.membersRevision, assigned.tag.membersRevision)
  await assert.rejects(client.tagsMemberSet({ tagId: created.tag.id, entityId: release.id, present: false, membersRevision: 0 }, 1003), { code: 'STALE_REVISION' })
  assert.equal((await client.tagsEntity({ entityId: release.id })).items[0].id, created.tag.id)
  const members = await client.tagsMembers({ tagId: created.tag.id, token: renamed.token })
  const recordings = await client.tagsRecordings({ tagId: created.tag.id, token: renamed.token })
  const privatePage = await client.tagsPlaybackPage({ tagId: created.tag.id, token: renamed.token })
  assert.equal(members.total, 1); assert.equal(recordings.total, 1)
  assert.equal(privatePage.items[0].track.filePath, join(root, 'tagged.flac'))
  assert.equal(JSON.stringify(recordings).includes(root.replaceAll('\\', '\\\\')), false)
  assert.equal('track' in recordings.items[0], false)
  await client.updateConfiguration({ folders: [root], exclusions: [] })
  const updated = await client.tagsState()
  assert.equal(updated.tagsRevision, renamed.token.tagsRevision)
  assert.ok(updated.contentRevision > renamed.token.contentRevision)
  await assert.rejects(client.tagsRecordings({ tagId: created.tag.id, token: renamed.token }), { code: 'STALE_REVISION' })
  await tick()
  assert.deepEqual(tokens.at(-1), updated)
  const exited = once(children.at(-1)!, 'exit')
  client.destroy(); await exited
  client = open()
  assert.deepEqual(await client.tagsState(), updated)
  assert.deepEqual((await client.tagsList({})).items, [renamed.tag])
  assert.deepEqual((await client.tagsMembers({ tagId: created.tag.id })).items, members.items)
  assert.deepEqual((await client.tagsPlaybackPage({ tagId: created.tag.id })).items, privatePage.items)
  assert.equal((await client.tagsDelete({ tagId: created.tag.id, nameRevision: renamed.tag.nameRevision, membersRevision: assigned.tag.membersRevision })).deletedId, created.tag.id)
  assert.equal((await client.tagsList({})).total, 0)
  assert.equal((await client.getTracksByIds(['tagged'])).tracks.length, 1)
})

test('preferences migration, bans and revision events survive real database worker replacement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'preferences-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = [], revisions: number[] = []
  const track = { id: 'preferred', source: 'local' as const, filePath: join(root, 'preferred.flac'),
    title: 'Preferred', artist: 'Artist', album: 'Album', fileName: 'preferred.flac', duration: 200,
    size: 0, cover: null, lyrics: null }
  writeFileSync(json, JSON.stringify([track]))
  let client = workerClient(json, children, undefined, undefined, undefined, revision => revisions.push(revision))
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata()
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance()
  const recording = (await client.catalogQuery({ kind: 'recording' })).items[0]
  const ordinary = { id: 'ordinary', name: '我收藏的音乐', createdAt: '2026-01-01', trackIds: [track.id, track.id] }
  assert.equal(await client.preferencesPlaylistsMigrationReceipt(), null)
  const migrated = await client.preferencesPlaylistsMigrate({ version: 2, revision: 7, savedAt: '2026-01-01', data: [
    { id: 'system', name: 'Original favorites', createdAt: '2026-01-01', isDefault: true,
      trackIds: [track.id], trackSnapshots: { [track.id]: track } }, ordinary
  ] }, 1000, { logicalMemberCount: 1 })
  assert.equal(migrated.revision, 7)
  assert.deepEqual(migrated.data.find(item => item.id === 'ordinary'), ordinary)
  const receipt = await client.preferencesPlaylistsMigrationReceipt()
  assert.equal(receipt!.sourceRevision, 7)
  assert.equal(receipt!.defaultPlaylistId, 'system')
  assert.equal(receipt!.rawRowCount, 1)
  assert.equal(receipt!.logicalMemberCount, 1)
  assert.equal(receipt!.resolvedRowCount, 1)
  assert.equal(receipt!.unresolvedRowCount, 0)
  assert.equal(receipt!.items[0].trackId, track.id)
  const detail = await client.preferencesDetail(recording.id)
  assert.equal(detail.value?.state, 'favorite')
  assert.deepEqual((await client.preferencesTargets({ entityId: recording.id, trackContext: { provider: 'local', id: track.id } })).items.map(item => item.id), [recording.id])
  assert.equal((await client.preferencesTargets({ entityId: recording.id, trackContext: { provider: 'local', id: 'forged' } })).total, 0)
  const banned = await client.preferencesSet({ entityId: recording.id, token: detail.token, state: 'ban' }, 1001)
  await assert.rejects(client.preferencesSet({ entityId: recording.id, token: detail.token, state: 'favorite' }, 1002), { code: 'STALE_REVISION' })
  const after = await client.preferencesPlaylistsLoad()
  assert.deepEqual(after!.data.find(item => item.id === 'system')!.trackIds, [])
  assert.deepEqual(after!.data.find(item => item.id === 'ordinary'), ordinary)
  assert.deepEqual(await client.preferencesAutomaticEligibility([track]), [false])
  assert.deepEqual(await client.preferencesTrackStates([track]), ['ban'])
  const history = await client.preferencesHistory({ entityId: recording.id, limit: 1 })
  assert.equal(history.items[0].state, 'ban')
  await tick()
  assert.equal(revisions.at(-1), banned.token.preferencesRevision)
  const exited = once(children.at(-1)!, 'exit')
  client.destroy(); await exited
  client = workerClient(json, children, undefined, undefined, undefined, revision => revisions.push(revision))
  assert.deepEqual(await client.preferencesDetail(recording.id), banned)
  assert.deepEqual(await client.preferencesPlaylistsLoad(), after)
  assert.deepEqual(await client.preferencesHistory({ entityId: recording.id, limit: 1 }), history)
  assert.deepEqual(await client.preferencesAutomaticEligibility([track]), [false])
  assert.deepEqual(await client.preferencesPlaylistsMigrationReceipt(), receipt)
})

test('personal ratings, clearing history and revision events survive real database worker replacement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ratings-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = [], revisions: number[] = []
  writeFileSync(json, JSON.stringify([{ id: 'rated', source: 'local', filePath: join(root, 'rated.flac'),
    title: 'Rated', artist: 'Artist', album: 'Album' }]))
  let client = workerClient(json, children, undefined, undefined, revision => revisions.push(revision))
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata()
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance()
  const recording = (await client.catalogQuery({ kind: 'recording' })).items[0]
  const album = (await client.catalogQuery({ kind: 'release' })).items[0]
  const detail = await client.ratingsDetail(recording.id)
  assert.deepEqual((await client.ratingsTargets({ entityId: recording.id })).items.map(item => item.id), [recording.id])
  assert.deepEqual((await client.ratingsTargets({ entityId: recording.id, trackContext: { provider: 'local', id: 'rated' } })).items.map(item => item.id), [recording.id])
  assert.equal((await client.ratingsTargets({ entityId: recording.id, trackContext: { provider: 'local', id: 'not-this-source' } })).total, 0)
  const set = await client.ratingsSet({ entityId: recording.id, token: detail.token, steps: 7 }, 1000)
  await assert.rejects(client.ratingsSet({ entityId: recording.id, token: detail.token, steps: 9 }, 1001), { code: 'STALE_REVISION' })
  const cleared = await client.ratingsSet({ entityId: recording.id, token: set.token, steps: null }, 1002)
  assert.equal((await client.ratingsDetail(album.id)).value, null)
  const history = await client.ratingsHistory({ entityId: recording.id, limit: 1 })
  assert.equal(history.total, 2)
  assert.equal(history.items[0].steps, null)
  await tick()
  assert.equal(revisions.at(-1), cleared.token.ratingsRevision)
  const exited = once(children.at(-1)!, 'exit')
  client.destroy(); await exited
  client = workerClient(json, children, undefined, undefined, revision => revisions.push(revision))
  assert.deepEqual(await client.ratingsDetail(recording.id), cleared)
  assert.deepEqual(await client.ratingsHistory({ entityId: recording.id, limit: 1 }), history)
  const old = await client.ratingsHistory({ entityId: recording.id, limit: 1, offset: 1 })
  assert.equal(old.items[0].steps, 7)
})

test('album version reads and private unified playback fences use the real database worker transport', async t => {
  const root = mkdtempSync(join(tmpdir(), 'album-version-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = []
  writeFileSync(json, JSON.stringify([{ id: 'one', source: 'local', filePath: join(root, 'one.flac'),
    title: 'One', artist: 'Artist', album: 'Album', genre: 'Jazz' }]))
  const client = workerClient(json, children)
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata()
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance()
  while ((await client.genresAdvance()).pending) { /* production bounded projection */ }
  const release = (await client.catalogQuery({ kind: 'release' })).items[0]
  const page = await client.albumsBrowse({ entityId: release.id, limit: 1 })
  const scope = { entityId: release.id, releaseId: page.currentRelease!.id, token: page.token }
  const sources = await client.albumsSources(scope)
  assert.equal(sources.total, 1)
  const sourceId = sources.items[0].sourceId
  assert.equal(await client.albumsContainsSource(scope, sourceId), true)
  assert.equal(await client.albumsContainsSource(scope, 'not-a-source'), false)
  const privatePage = await client.catalogPlaybackSources({ sourceId, revision: page.token.catalogRevision })
  assert.equal(privatePage.items[0].inLibrary, true)
  assert.equal(privatePage.items[0].track?.filePath, join(root, 'one.flac'))
  const classification = await client.genresBrowse({ kind: 'recording', source: 'local' })
  const frozen = { entityId: classification.items[0].id, source: 'local', token: classification.token }
  assert.deepEqual(await client.genresContainsSources(frozen, [sourceId]), [sourceId])
  const artist = (await client.catalogQuery({ kind: 'artist' })).items[0]
  await client.metadataOverride({ entityId: artist.id, revision: 0, mode: 'value', value: 'Updated introduction', language: 'en' }, Date.now())
  await assert.rejects(client.albumsSources(scope), { code: 'STALE_REVISION' })
  await assert.rejects(client.albumsContainsSource(scope, sourceId), { code: 'STALE_REVISION' })
  await assert.rejects(client.genresContainsSources(frozen, [sourceId]), { code: 'STALE_REVISION' })
})

test('genre evidence, mappings and explicit empty overrides survive database worker replacement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'genre-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = []
  const metadataRevisions: number[] = []
  writeFileSync(json, JSON.stringify([{ id: 'genre-one', source: 'local', filePath: join(root, 'one.flac'),
    title: 'One', artist: 'Artist', album: 'Album', genre: 'Jazz;Local oddity' }]))
  let client = workerClient(json, children, undefined, revision => metadataRevisions.push(revision))
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata()
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance()
  while ((await client.genresAdvance(2, ';')).pending) { /* bounded index batches */ }
  const recording = (await client.catalogQuery({ kind: 'recording' })).items[0]
  const source = (await client.catalogSources({ entityId: recording.id })).items[0]
  const target = { kind: 'source' as const, id: source.id }
  const raw = await client.genresEvidence({ target })
  assert.deepEqual(raw.selection.genreIds, ['genre:jazz'])
  const unmapped = await client.genresUnmapped({ provider: 'local' })
  assert.equal(unmapped.items[0].value, 'Local oddity')
  const mapped = await client.genresMap({ provider: 'local', value: 'Local oddity',
    genreId: 'genre:folk', revision: unmapped.revision })
  await client.genresOverride({ target, revision: mapped.revision, genreIds: [] })
  const browse = await client.genresBrowse({ kind: 'recording', limit: 20 })
  assert.equal(browse.total, 1)
  assert.equal(browse.items[0].genres.total, 0)
  const members = await client.genresMembers({ entityId: recording.id, token: browse.token })
  assert.equal(members.items[0].sourceId, source.id)
  const facets = await client.genresFacets({ kind: 'recording', dimension: 'format', token: browse.token })
  assert.equal(facets.token.contextKey, browse.token.contextKey)
  const before = await client.genresEvidence({ target })
  const exited = once(children.at(-1)!, 'exit')
  client.destroy()
  await exited
  client = workerClient(json, children, undefined, revision => metadataRevisions.push(revision))
  const after = await client.genresEvidence({ target })
  await assert.rejects(client.genresBrowse({ kind: 'recording', token: browse.token }), { code: 'STALE_REVISION' })
  const recovered = await client.genresBrowse({ kind: 'recording' })
  assert.equal(recovered.items[0].id, recording.id)
  assert.equal(recovered.items[0].genres.total, 0)
  assert.deepEqual(after, before)
  assert.deepEqual(after.selection.override, [])
  assert.deepEqual(after.items[0].raw, { format: 'text', value: 'Jazz;Local oddity', separators: ';' })
  const reset = await client.genresOverride({ target, revision: after.revision, genreIds: null })
  assert.deepEqual(new Set(reset.genreIds), new Set(['genre:jazz', 'genre:folk']))
  // The old string filter still matches exact split values, not stable IDs.
  assert.equal((await client.queryTracks({ genre: 'Jazz', genreSeparators: ';' })).total, 1)
  assert.equal((await client.queryTracks({ genre: 'genre:jazz', genreSeparators: ';' })).total, 0)
  const fresh = await client.genresBrowse({ kind: 'recording' })
  const artist = (await client.catalogQuery({ kind: 'artist' })).items[0]
  const detail = await client.metadataDetail(artist.id, 'en')
  await client.metadataOverride({ entityId: artist.id, revision: detail.revision, language: 'en', mode: 'value', value: 'Updated introduction' }, Date.now())
  await client.getMetadata()
  await tick()
  assert.ok(metadataRevisions.at(-1)! > fresh.token.metadataRevision)
  await assert.rejects(client.genresBrowse({ kind: 'recording', token: fresh.token }), { code: 'STALE_REVISION' })
})

test('catalog references, identity inbox and candidate decisions survive real database worker replacement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-reference-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = []
  writeFileSync(json, JSON.stringify([{ id: 'one', source: 'local', filePath: join(root, 'one.flac'), title: 'One', artist: 'Artist', album: 'Album' }]))
  let client = workerClient(json, children)
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata()
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance()
  const page = await client.getTracksByIds(['one', 'one'])
  const albums = await client.queryCollections('albums')
  const context = { type: 'collection' as const, collection: 'albums' as const, id: albums.items[0].id }
  const entities = await client.catalogQuery({ kind: 'release', context })
  assert.equal(page.catalog!.tracks.length, 2)
  assert.deepEqual(page.catalog!.tracks[0], page.catalog!.tracks[1])
  assert.equal(albums.items[0].catalog!.items.find(i => i.kind === 'release')!.id, entities.items[0].id)
  const artistId = page.catalog!.tracks[0]!.items.find(i => i.kind === 'artist')!.id
  await client.metadataOverride({ entityId: artistId, revision: 0, mode: 'value', value: 'Stored introduction', language: 'en' }, 1000)
  const [candidate] = await client.identificationPublish(await client.identificationInput(artistId), [{
    provider: 'ncm', name: 'Artist', summary: '', matcherVersion: 'manual',
    references: [{ provider: 'ncm', kind: 'artist', idType: 'native', value: '42' }],
    evidence: { origin: 'search', matches: ['name'], missing: ['manual'], conflicts: [], incomplete: true, provenance: 'fixture' }
  }], 1001)
  const inbox = await client.identificationInbox({ kind: 'artist', offset: 0, limit: 20 })
  assert.equal(inbox.total, 1)
  assert.equal(inbox.items[0].entity.id, artistId)
  assert.equal(inbox.items[0].candidateCount, 1)
  assert.deepEqual(inbox.items[0].sample, { provider: 'local', title: 'One', album: 'Album' })
  assert.equal((await client.metadataJobs({})).total, 0)
  const exited = once(children.at(-1)!, 'exit')
  client.destroy(); await exited
  client = workerClient(json, children)
  assert.deepEqual(await client.getTracksByIds(['one','one']), page)
  assert.deepEqual(await client.queryCollections('albums'), albums)
  assert.deepEqual(await client.catalogQuery({ kind: 'release', context, revision: entities.revision }), entities)
  assert.equal((await client.metadataDetail(artistId, 'en', { sourceProvider: 'local' })).introduction!.value, 'Stored introduction')
  assert.deepEqual(await client.identificationInbox({ kind: 'artist', offset: 0, limit: 20 }), inbox)
  const review = { candidateId: candidate.id, revision: candidate.revision, linkRevision: candidate.linkRevision }
  assert.equal((await client.identificationPreview(review)).canConfirm, true)
  const confirmed = await client.identificationDecide({ ...review, decision: 'confirm' }, 1002)
  assert.equal((await client.identificationInbox({})).total, 0)
  const secondExit = once(children.at(-1)!, 'exit')
  client.destroy(); await secondExit
  client = workerClient(json, children)
  assert.deepEqual(await client.identificationDetail(artistId), confirmed)
  const confirmedInbox = await client.identificationInbox({ state: 'confirmed', limit: 1 })
  assert.equal(confirmedInbox.total, 1)
  assert.equal(confirmedInbox.items[0].entity.id, artistId)
  assert.equal((await client.metadataDetail(artistId, 'en', { sourceProvider: 'local' })).introduction!.value, 'Stored introduction')
  assert.deepEqual(await client.getTracksByIds(['one','one']), page)
  const [task] = await client.identificationEnqueue({ entityId: artistId, batchId: 'task-center',
    providers: [{ id: 'platform.ncm', matcherVersion: 'fixture' }] }, 3000)
  await client.identificationEnqueue({ entityId: artistId, batchId: 'other-consumer',
    providers: [{ id: 'platform.ncm', matcherVersion: 'fixture' }] }, 3000)
  const taskPage = await client.metadataTasks({ filter: 'active', batchId: 'task-center', limit: 1 })
  assert.equal(taskPage.items[0].id, task.id)
  assert.equal(taskPage.items[0].entity!.id, artistId)
  assert.equal(taskPage.items[0].demandCount, 2)
  const demandPage = await client.metadataTaskDemands({ jobId: task.id, limit: 1 })
  assert.equal(demandPage.total, 2)
  const taskExit = once(children.at(-1)!, 'exit')
  client.destroy(); await taskExit
  client = workerClient(json, children)
  assert.deepEqual(await client.metadataTasks({ filter: 'active', batchId: 'task-center', limit: 1 }), taskPage)
  assert.deepEqual(await client.metadataTaskDemands({ jobId: task.id, limit: 1 }), demandPage)
  assert.equal(await client.metadataCancel(task.id, 'task-center', 3001), true)
  assert.equal((await client.metadataTasks({ filter: 'active' })).items[0].demandCount, 1)
  assert.equal((await client.metadataTaskDemands({ jobId: task.id })).items[0].batchId, 'other-consumer')
  await client.metadataCancel(task.id, 'other-consumer', 3002)
  const history = await client.identificationHistory({ entityId: artistId, limit: 1 })
  const historySeq = history.items[0].seq
  await client.identificationDetach(confirmed.link!.id, confirmed.link!.revision, 3003)
  const detached = await client.identificationHistory({ entityId: artistId, limit: 1 })
  const restore = { entityId: artistId, historySeq, inputVersion: detached.inputVersion,
    linkRevision: detached.current.link!.revision }
  assert.equal((await client.identificationRestorePreview(restore)).canRestore, true)
  const historyExit = once(children.at(-1)!, 'exit')
  client.destroy(); await historyExit
  client = workerClient(json, children)
  assert.equal((await client.identificationRestorePreview(restore)).canRestore, true)
  await client.identificationRestore(restore, 3004)
  await assert.rejects(client.identificationRestore(restore, 3005), /变化/)
  assert.equal((await client.identificationHistory({ entityId: artistId })).items[0].restoredFrom, historySeq)
  const enrichment = await client.metadataEnqueue({ entityId: artistId, type: 'enrich', provider: 'platform.ncm',
    providerContext: 'worker-fixture', language: 'en', batchId: 'enrich' }, 4000)
  const enrichmentWork = (await client.metadataClaim(4000))!
  assert.equal(enrichmentWork.job.id, enrichment.id)
  await client.metadataFinish(enrichmentWork, { state: 'failed', reason: 'fixture' }, 4001)
  const sources = await client.metadataTaskSources({ jobId: enrichment.id, limit: 1 })
  assert.equal(sources.items[0].entity.id, artistId)
  const source = sources.items[0]
  const requery = { demandId: 'worker-requery', batchId: 'enrich', items: [{ jobId: enrichment.id,
    generation: enrichment.generation, entityId: artistId, inputVersion: source.inputVersion,
    linkRevision: source.linkRevision }] }
  await client.metadataRequery(requery, { 'platform.ncm': 'worker-fixture' }, 4002)
  const requeryExit = once(children.at(-1)!, 'exit')
  client.destroy(); await requeryExit
  client = workerClient(json, children)
  assert.equal((await client.identificationDetail(artistId)).references[0].value, '42')
  assert.equal((await client.metadataTasks({ batchId: 'worker-requery' })).total, 1)
  const recovered = (await client.metadataClaim(4003))!
  assert.equal(recovered.job.id, enrichment.id)
  assert.equal(recovered.job.generation, enrichment.generation + 1)
  assert.equal(recovered.job.requeryConsumers![0].entityId, artistId)
  await client.metadataFinish(recovered, { state: 'completed', outcome: 'not_found', facts: [] }, 4004)
  assert.equal((await client.metadataDetail(artistId, 'en', { sourceProvider: 'local' })).introduction!.value, 'Stored introduction')
})

function workerClient(json: string, children: ChildProcess[], changed?: (revision: number) => void, classificationMetadataChanged?: (revision: number) => void, ratingsChanged?: (revision: number) => void, preferencesChanged?: (revision: number) => void, tagsChanged?: DatabaseServiceOptions['tagsChanged'], focusChanged?: DatabaseServiceOptions['focusChanged'], explorationChanged?: DatabaseServiceOptions['explorationChanged']) {
  return new LibraryDatabaseServiceClient({
    changed,
    classificationMetadataChanged,
    ratingsChanged,
    preferencesChanged,
    tagsChanged,
    focusChanged,
    explorationChanged,
    serviceEntry: fileURLToPath(new URL('./libraryDatabaseService.ts', import.meta.url)),
    libraryFilePath: json,
    fork: (entry) => {
      const child = fork(entry, [], {
        execArgv: ['--experimental-strip-types'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      })
      children.push(child)
      Object.assign(child, {
        postMessage: (message: LibraryDatabaseWorkerRequest) => child.send(message)
      })
      return child as unknown as DatabaseUtilityProcess
    }
  })
}

test('track completion batches real worker writes while playback queue reads keep making progress', { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'metadata-listening-worker-'))
  const json = join(root, 'library.json')
  const tracks = Array.from({ length: 200 }, (_, i) => ({
    id: `local:${i}`, source: 'local', filePath: join(root, `${i}.flac`),
    fileName: `${i}.flac`, title: 'Moon River', artist: 'Audrey', album: '',
    duration: 181, size: 100, cover: null, lyrics: null
  }))
  writeFileSync(json, JSON.stringify(tracks))
  const children: ChildProcess[] = [], revisions: number[] = [], batches: number[] = []
  const client = workerClient(json, children, revision => revisions.push(revision))
  let service: CoreMetadataService | undefined = undefined
  t.after(async () => {
    await service?.shutdown()
    client.destroy()
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    assert.equal(dirname(root), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('metadata-listening-worker-'))
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata()
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance()
  const queue = await client.createLibraryQueue({ sort: 'insertion' }, 'local:0')
  await tick()
  revisions.length = 0
  const errors: unknown[] = []
  service = new CoreMetadataService({
    database: {
      queryTracks: query => client.queryTracks(query),
      getTracksByIds: ids => client.getTracksByIds(ids),
      patchTracks: patches => { batches.push(patches.length); return client.patchTracks(patches) }
    },
    provider: { searchSongs: async () => ({ items: [{ ...tracks[0], id: 'ncm:one', source: 'ncm', album: 'Online Album', genre: 'Jazz' }], total: 1 }) },
    available: () => true, policy: () => ({ cover: false, lyrics: false, metadata: true }),
    now: Date.now, newId: () => 'manual-token', changed: () => {}, libraryChanged: () => {},
    failed: error => errors.push(error)
  })
  service.activate()
  const latencies: number[] = []
  const deadline = Date.now() + 5000
  do {
    const started = performance.now()
    const page = await client.readLibraryQueue(queue.id, 0, 1)
    latencies.push(performance.now() - started)
    assert.equal(page.items[0].track?.id, 'local:0')
    assert.equal(page.revision, queue.revision, 'completion does not rebuild the playing queue')
    await new Promise<void>(done => setTimeout(done, 5))
  } while (service.snapshot().state === 'enriching' && Date.now() < deadline)
  assert.equal(service.snapshot().state, 'completed')
  assert.equal(service.snapshot().completed, 200)
  assert.deepEqual(batches, Array(8).fill(25))
  assert.equal(new Set(revisions).size, 8)
  assert.equal((await client.getTracksByIds(['local:199'])).tracks[0].album, 'Online Album')
  assert.ok(latencies.length > 3)
  assert.ok(Math.max(...latencies) < 500, 'queue reads must interleave with background writes')
  assert.deepEqual(errors, [])
  t.diagnostic(`${latencies.length} queue reads during completion; max ${Math.max(...latencies).toFixed(1)} ms; ${batches.length} commits for 200 tracks`)
})

test('legacy query publication, input fences, results and cancellation survive real database worker replacement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-query-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = []
  writeFileSync(json, JSON.stringify([{ id: 'one', source: 'local', filePath: join(root, 'one.flac'), title: 'One', artist: 'Artist', album: 'Album', duration: 200 }]))
  let client = workerClient(json, children)
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  const replace = async () => {
    client.destroy(); await once(children.at(-1)!, 'exit'); client = workerClient(json, children)
    await client.getMetadata()
    await client.metadataRecover(1001)
  }
  await client.getMetadata()
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance(200)
  const collections = await client.queryCollections('albums', { limit: 200 }), contentRevision = collections.revision
  const pluginId = 'com.example.rhine', id = 'legacy-album', collectionId = collections.items[0].id
  const album: MusicAlbum = { id, title: 'Album', artist: 'Artist', year: 2000, genreId: 'unknown', rawGenres: [],
    folder: '', producers: [], offline: false, tracks: [{ id: 'one', albumId: id, title: 'One', artist: 'Artist', duration: 200,
      audioUrl: '', relativePath: '', browserPlayable: true, format: 'flac' }] }
  const seed = { album, collectionId, contentRevision, force: false }
  await client.legacyMusicBegin(pluginId, 7, { albums: {} }, 0, contentRevision)
  await client.legacyMusicPublish(pluginId, 7, contentRevision)
  await client.legacyMusicBatchBegin({ id: 'incomplete', pluginId, operation: 'credits', expected: 2, documentRevision: 7 }, 1000)
  await client.legacyMusicBatchStage('incomplete', [seed], 1000)
  await client.legacyMusicBatchBegin({ id: 'published', pluginId, operation: 'introductions', expected: 1, documentRevision: 7 }, 1000)
  await client.legacyMusicBatchStage('published', [seed], 1000)
  await client.legacyMusicBatchPublish('published', 1000)
  const lost = (await client.metadataClaim(1000))!
  assert.equal(lost.legacy!.collectionId, collectionId)
  assert.equal('album' in (await client.metadataJobs({ jobId: lost.job.id })).items[0].legacy!, false)
  await replace()
  assert.equal((await client.legacyMusicTaskStatus(pluginId, 'credits'))!.state, 'abandoned')
  assert.equal((await client.legacyMusicTaskStatus(pluginId, 'introductions'))!.running, true)
  const result = { state: 'legacy_result' as const, taskState: 'completed' as const, outcome: 'matched' as const, reason: null,
    lookup: { operation: 'introductions' as const, value: { status: 'matched' as const, description: 'Durable introduction',
      descriptionSource: { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Album' } } } }
  assert.equal(await client.metadataFinish(lost, result, 1002), false)
  const resumed = (await client.metadataClaim(1002))!
  assert.ok(resumed.job.generation > lost.job.generation)
  assert.equal(await client.metadataFinish(resumed, result, 1003), true)
  await client.legacyMusicBatchBegin({ id: 'cancel', pluginId, operation: 'credits', expected: 1, documentRevision: 8 }, 1004)
  await client.legacyMusicBatchStage('cancel', [seed], 1004)
  await client.legacyMusicBatchPublish('cancel', 1004)
  await client.legacyMusicBatchCancel(pluginId, 'credits', 1005)
  await replace()
  assert.equal((await client.legacyMusicTaskStatus(pluginId, 'introductions'))!.updated, 1)
  assert.equal((await client.legacyMusicTaskStatus(pluginId, 'credits'))!.cancelled, 1)
  assert.equal(((await client.legacyMusicRead(pluginId))!.value.albums as Record<string, MusicAlbum>)[id].description, 'Durable introduction')
  assert.deepEqual((await client.legacyMusicHistory(pluginId)).revisions, [8, 7])
})

test('legacy source migration, publication, history and bindings survive real database worker replacement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-music-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = [], changes: number[] = []
  writeFileSync(json, JSON.stringify([{ id: 'one', source: 'local', filePath: join(root, 'one.flac'), title: 'One', artist: 'Artist', album: 'Album' }]))
  let client = workerClient(json, children, revision => changes.push(revision))
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata()
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance(200)
  const collections = await client.queryCollections('albums', { limit: 200 }), revision = collections.revision
  const before = [...changes], pluginId = 'com.example.rhine'
  const staged = { pluginId, sourceRevision: 7, contentRevision: revision, entries: [
    { id: 'old-one', value: { description: 'Imported', localNote: 'Keep' }, collectionId: collections.items[0].id }
  ] }
  await client.legacyMusicBegin(pluginId, 7, { proofs: { keep: 'edition' }, albums: {} }, 2, revision)
  await client.legacyMusicStage(staged)
  client.destroy(); await once(children.at(-1)!, 'exit'); client = workerClient(json, children, revision => changes.push(revision))
  assert.equal(await client.legacyMusicRead(pluginId), null)
  assert.equal((await client.legacyMusicStatus(pluginId))?.staged, 1)
  await client.legacyMusicStage(staged)
  await client.legacyMusicStage({ ...staged, entries: [{ id: 'orphan', value: { localNote: 'Orphan' } }] })
  await client.legacyMusicPublish(pluginId, 7, revision)
  const original = (await client.legacyMusicRead(pluginId))!
  const inventory = await client.legacyMusicInventory(pluginId)
  const entityId = inventory.items.find(item => item.id === 'old-one')!.bindings[0].entityId
  assert.equal((await client.metadataDetail(entityId, 'en')).introduction?.value, 'Imported')
  await client.legacyMusicEdit(pluginId, { revision: 7, value: { albums: {} } })
  client.destroy(); await once(children.at(-1)!, 'exit'); client = workerClient(json, children, revision => changes.push(revision))
  assert.equal((await client.legacyMusicRead(pluginId))?.revision, 8)
  assert.deepEqual(await client.legacyMusicHistory(pluginId), { total: 1, revisions: [7] })
  assert.deepEqual(await client.legacyMusicHistoryRead(pluginId, 7), original)
  assert.deepEqual((await client.legacyMusicRestore(pluginId, 7, 8)).value, original.value)
  assert.deepEqual(await client.legacyMusicInventory(pluginId), inventory)
  await tick()
  // Each replacement announces its initial revision. None of these metadata
  // mutations may advance that content revision.
  assert.deepEqual(new Set(changes), new Set(before))
})

test('automatic identification outbox, history cursor and demands survive real database worker replacement', async t => {
  const root = mkdtempSync(join(tmpdir(),'identification-schedule-worker-')), json=join(root,'library.json')
  const children: ChildProcess[]=[]
  writeFileSync(json,JSON.stringify([{id:'one',source:'local',filePath:join(root,'one.flac'),title:'One',artist:'Artist'}]))
  let client=workerClient(json,children)
  t.after(async()=>{
    client.destroy()
    for(const child of children) if(child.exitCode===null&&child.signalCode===null) await once(child,'exit')
    rmSync(root,{recursive:true,force:true})
  })
  await client.getMetadata(); await client.catalogAdvance(200)
  const request={enabled:true,newImports:true,history:true,providers:[{id:'platform.ncm',matcherVersion:'fixture-v1',kinds:['artist' as const]}]}
  await client.identificationSchedule(request,1000)
  const progress=await client.identificationScheduleStatus(), work=(await client.metadataClaim(1000))!
  assert.equal(work.automatic!.origin,'new')
  client.destroy(); await once(children[0],'exit'); client=workerClient(json,children)
  await client.metadataRecover(2000)
  assert.deepEqual(await client.identificationScheduleStatus(),progress)
  assert.equal((await client.metadataJobs({})).total,1)
  const resumed=(await client.metadataClaim(2000))!
  assert.equal(resumed.job.id,work.job.id)
  assert.equal(resumed.job.generation,work.job.generation+1)
  assert.equal(await client.metadataFinish(work,{state:'identified',proposals:[],incomplete:false,reasons:[]},2001,request),false)
  assert.equal(await client.metadataFinish(resumed,{state:'identified',proposals:[],incomplete:false,reasons:[]},2002,request),true)
  await client.identificationSchedule(request,2003)
  assert.equal((await client.metadataJobs({})).items[0].state,'completed')
})

test('confirmed-identity enrichment outbox and language/context demands survive real worker replacement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'automatic-enrichment-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = []
  writeFileSync(json, JSON.stringify([{ id: 'one', source: 'local', filePath: join(root, 'one.flac'), title: 'One', artist: 'Artist' }]))
  let client = workerClient(json, children)
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  const replace = async () => {
    client.destroy(); await once(children.at(-1)!, 'exit'); client = workerClient(json, children)
    await client.getMetadata(); await client.metadataRecover(2000)
  }
  await client.getMetadata()
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance(200)
  const entityId = (await client.catalogQuery({ kind: 'artist' })).items[0].id
  const request = { enabled: true, newImports: true, history: false, providers: [], enrichment: {
    language: 'zh-Hant' as const, providers: [{ id: 'platform.ncm', context: 'account-a', kinds: ['artist' as const] }]
  } }
  await client.identificationSchedule(request, 1000)
  const [candidate] = await client.identificationPublish(await client.identificationInput(entityId), [{
    provider: 'ncm', name: 'Artist', summary: '', matcherVersion: 'manual',
    references: [{ provider: 'ncm', kind: 'artist', idType: 'native', value: '42' }],
    evidence: { origin: 'search', matches: [], missing: ['manual'], conflicts: [], incomplete: true, provenance: 'fixture' }
  }], 1001)
  await client.identificationDecide({ candidateId: candidate.id, revision: candidate.revision, linkRevision: candidate.linkRevision, decision: 'confirm' }, 1002)
  await replace()
  assert.equal((await client.identificationScheduleStatus()).pending, 1)
  await client.identificationSchedule(request, 2000)
  const work = (await client.metadataClaim(2000))!
  assert.equal(work.job.language, 'zh-Hant')
  assert.equal(work.job.providerContext, 'account-a')
  assert.equal(work.automatic!.origin, 'new')
  await replace()
  const resumed = (await client.metadataClaim(2000))!
  assert.equal(resumed.job.id, work.job.id)
  assert.equal(resumed.job.generation, work.job.generation + 1)
  const result = { state: 'completed' as const, outcome: 'not_found' as const, facts: [] }
  assert.equal(await client.metadataFinish(work, result, 2001, request), false)
  assert.equal(await client.metadataFinish(resumed, result, 2001, request), true)
  await client.identificationSchedule(request, 2002)
  assert.equal((await client.metadataJobs({})).total, 1)
  assert.equal((await client.metadataJobs({})).items[0].state, 'completed')
})

test('catalog worker transport persists derived identity without publishing library content changes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = [], revisions: number[] = []
  writeFileSync(json, JSON.stringify([{ id: 'one', source: 'local', filePath: join(root, 'one.flac'), title: 'One', artist: 'Artist', album: 'Album' }]))
  const client = workerClient(json, children, revision => revisions.push(revision))
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata()
  const before = [...revisions]
  assert.equal((await client.catalogStatus()).localPending, true)
  await client.catalogAdvance(200)
  const page = await client.catalogQuery({ kind: 'recording' })
  const entity = (await client.catalogDetail(page.items[0].id, page.revision)).entity!
  const sources = await client.catalogSources({ entityId: entity.id, revision: page.revision })
  assert.equal(sources.total, 1)
  assert.equal((await client.catalogResolve(sources.items[0].id, page.revision))!.filePath, join(root, 'one.flac'))
  assert.equal(JSON.stringify(sources).includes('filePath'), false)
  const job = await client.catalogSync({ kind: 'begin', revision: 0 })
  await client.catalogSync({ kind: 'commit', ...job })
  await client.catalogProjectVersions({ version: 1, tracks: { versions: [], families: [] }, albums: { versions: [], families: [] } }, 0)
  await tick()
  assert.deepEqual(revisions, before)
})

test('entity metadata traverses the real database worker, survives its replacement and never publishes scan revisions', async t => {
  const root = mkdtempSync(join(tmpdir(), 'metadata-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = [], revisions: number[] = []
  writeFileSync(json, JSON.stringify([{ id: 'one', source: 'local', filePath: join(root, 'one.flac'), title: 'One', artist: 'Artist', album: 'Album' }]))
  let client = workerClient(json, children, revision => revisions.push(revision))
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata(); await client.catalogAdvance(200)
  const artist = (await client.catalogQuery({ kind: 'artist' })).items[0].id
  const before = [...revisions], mbid = 'a223958d-5c56-4b2c-a30a-87e357bc121b'
  const job = await client.metadataEnqueue({ type: 'resolve', entityId: artist, mbid, language: 'en', batchId: 'durable' }, 1000)
  assert.equal(await client.metadataNextAttempt(), 1000)
  await client.metadataClaim(1000)
  client.destroy()
  await once(children[0], 'exit')
  client = workerClient(json, children, revision => revisions.push(revision))
  await client.metadataRecover(2000)
  const work = (await client.metadataClaim(2000))!
  assert.equal(work.job.generation, job.generation + 1)
  await client.metadataFinish(work, { state: 'needs_review', candidate: { mbid, name: 'Artist', type: 'Person', disambiguation: '', wikidataId: null, evidence: { provider: 'musicbrainz', externalId: mbid, url: `https://musicbrainz.org/artist/${mbid}`, license: 'CC0-1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', attribution: 'MusicBrainz contributors', revision: '', retrievedAt: 2000 } } }, 2001)
  const candidate = (await client.identificationCandidates({ entityId: artist })).items[0]
  assert.equal(candidate.references[0].value, mbid)
  const review = { candidateId: candidate.id, revision: candidate.revision, linkRevision: candidate.linkRevision }
  assert.equal((await client.identificationPreview(review)).canConfirm, true)
  const detail = await client.metadataDecide({ jobId: job.id, generation: work.job.generation, decision: 'confirm' }, 2002)
  assert.ok(detail.targetId)
  assert.equal((await client.identificationDetail(artist)).link!.targetId, detail.targetId)
  await client.metadataOverride({ entityId: artist, revision: detail.revision, mode: 'value', value: 'User introduction', language: 'en' }, 2003)
  const enriched = await client.metadataEnqueue({ type: 'enrich', entityId: artist, language: 'en', batchId: 'one' }, 2004)
  assert.equal(await client.metadataCancel(enriched.id, 'one', 2005), true)
  const saved = await client.metadataDetail(artist, 'en')
  assert.equal(saved.introduction!.value, 'User introduction')
  await client.metadataDetach(artist, saved.revision, 2006)
  const input = await client.identificationInput(artist)
  const [native] = await client.identificationPublish(input, [{ provider: 'ncm', name: 'Artist', summary: '', matcherVersion: 'fixture-v1',
    references: [{ provider: 'ncm', kind: 'artist', idType: 'native', value: '42' }],
    evidence: { origin: 'search', matches: [], missing: [], conflicts: [], incomplete: false, provenance: 'fixture' } }], 2007)
  const nativeDetail = await client.identificationDecide({ candidateId: native.id, revision: native.revision, linkRevision: native.linkRevision, decision: 'confirm' }, 2008)
  await client.identificationDetach(nativeDetail.link!.id, nativeDetail.link!.revision, 2009)
  assert.equal((await client.identificationDetail(artist)).link!.state, 'detached')
  assert.equal((await client.metadataJobs({ jobId: enriched.id })).items[0].state, 'cancelled')
  await tick()
  // Worker replacement emits its initial current revision once, no new revision.
  assert.ok(revisions.every(revision => before.includes(revision)))
})

test('generic identification demands and input fences traverse a replaced real database worker', async t => {
  const root = mkdtempSync(join(tmpdir(), 'identification-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = [], revisions: number[] = []
  writeFileSync(json, JSON.stringify([{ id: 'one', source: 'local', filePath: join(root, 'one.flac'), title: 'One', artist: 'Artist', album: 'Album' }]))
  let client = workerClient(json, children, revision => revisions.push(revision))
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata(); await client.catalogAdvance(200)
  const entityId = (await client.catalogQuery({ kind: 'artist' })).items[0].id
  const before = [...revisions]
  const request = { entityId, batchId: 'one', providers: [{ id: 'platform.ncm', matcherVersion: 'fixture-v1' }] }
  const [job] = await client.identificationEnqueue(request, 1000)
  await client.identificationEnqueue({ ...request, batchId: 'two' }, 1000)
  const old = (await client.metadataClaim(1000))!
  assert.equal(old.identification!.entityId, entityId)
  client.destroy(); await once(children[0], 'exit')
  client = workerClient(json, children, revision => revisions.push(revision))
  await client.metadataRecover(2000)
  const work = (await client.metadataClaim(2000))!
  assert.equal(work.job.generation, job.generation + 1)
  const result = { state: 'identified' as const, incomplete: true, reasons: ['first_page_only'], proposals: [{
    provider: 'ncm', name: 'Artist', summary: '', matcherVersion: 'fixture-v1',
    references: [{ provider: 'ncm', kind: 'artist' as const, idType: 'native', value: '42' }],
    evidence: { origin: 'search' as const, matches: ['name'], missing: ['verified_identity'], conflicts: [], incomplete: true, provenance: 'fixture' }
  }] }
  assert.equal(await client.metadataFinish(old, result, 2001), false)
  assert.equal(await client.metadataFinish(work, result, 2001), true)
  const saved = (await client.metadataJobs({ entityId })).items[0]
  assert.equal(saved.state, 'needs_review'); assert.equal(saved.identification!.incomplete, true)
  const candidate = (await client.identificationCandidates({ entityId })).items[0]
  assert.equal(candidate.id, saved.identification!.candidateIds[0])
  assert.equal((await client.identificationDetail(entityId)).link!.state, 'unresolved')
  assert.equal(await client.metadataCancel(job.id, 'one', 2002), true)
  assert.equal((await client.metadataJobs({ entityId })).items[0].state, 'needs_review')
  await client.identificationDecide({ candidateId: candidate.id, revision: candidate.revision, linkRevision: candidate.linkRevision, decision: 'confirm' }, 2003)
  assert.equal((await client.metadataJobs({ entityId })).items[0].state, 'completed')
  assert.ok(revisions.every(revision => before.includes(revision)))
})

test('verified native identification commits automatically across the real worker and preserves detach after replacement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'auto-identification-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = [], revisions: number[] = []
  writeFileSync(json, '[]')
  let client = workerClient(json, children, revision => revisions.push(revision))
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata()
  let batch = await client.catalogSync({ kind: 'begin', revision: 1 })
  batch = await client.catalogSync({ kind: 'append', ...batch, tracks: [{
    id: 'ncm:7', source: 'ncm', filePath: '', fileName: '', title: 'Song', artist: 'Artist', album: 'Album',
    artists: [{ id: 42, name: 'Artist' }], duration: 200, size: 0, cover: null, lyrics: null
  }] })
  await client.catalogSync({ kind: 'commit', ...batch })
  const entityId = (await client.catalogQuery({ kind: 'artist', source: 'ncm' })).items[0].id, before = [...revisions]
  const request = { entityId, batchId: 'native', providers: [{ id: 'platform.ncm', matcherVersion: 'native-test' }] }
  const [job] = await client.identificationEnqueue(request, 1000), work = (await client.metadataClaim(1000))!
  const ref = { provider: 'ncm', kind: 'artist' as const, idType: 'native', value: '42' }
  const result = { state: 'identified' as const, incomplete: false, reasons: [], proposals: [{
    provider: 'ncm', name: 'Artist', summary: '', matcherVersion: 'native-test', references: [ref],
    evidence: { origin: 'provider_native' as const, matches: ['provider_native_id'], missing: [], conflicts: [], incomplete: false,
      provenance: 'indexed_source', verification: { method: 'provider_native' as const, reference: ref,
        sourceIds: work.identification!.sources!.map(s => s.sourceId) } }
  }] }
  assert.equal(await client.metadataFinish(work, result, 1001), true)
  const original = await client.identificationDetail(entityId)
  assert.deepEqual(original.link!.confirmation, { mode: 'automatic', rule: 'provider_native' })
  client.destroy(); await once(children[0], 'exit'); client = workerClient(json, children, revision => revisions.push(revision))
  await client.metadataRecover(2000)
  assert.equal(await client.metadataClaim(2000), null)
  assert.deepEqual(await client.identificationDetail(entityId), original)
  assert.equal((await client.metadataJobs({ jobId: job.id })).items[0].state, 'completed')
  await client.identificationDetach(original.link!.id, original.link!.revision, 2001)
  await client.identificationEnqueue({ ...request, batchId: 'after-detach' }, 2002)
  const after = (await client.metadataClaim(2002))!
  assert.equal(await client.metadataFinish(after, result, 2003), true)
  assert.equal((await client.identificationDetail(entityId)).link!.state, 'detached')
  assert.equal((await client.identificationCandidates({ entityId })).items[0].suppressed, true)
  assert.ok(revisions.every(revision => before.includes(revision)))
})

test('real NCM album evidence crosses the database worker and survives replacement without changing local playback', async t => {
  const root = mkdtempSync(join(tmpdir(), 'platform-album-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = [], requests: string[] = []
  const ncm = await import(new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href)
  let handlers!: {
    searchAlbums(query: string, limit: number, offset: number, context: { signal: AbortSignal }): Promise<unknown>
    fetchAlbumIdentity(id: string, context: { signal: AbortSignal }): Promise<unknown>
  }
  const songs = [1, 2].map(n => ({ id: 100 + n, name: `Song ${n}`, ar: [{ id: 7, name: 'Artist' }],
    al: { id: 42, name: 'Album' }, cd: '01', no: n, dt: 200250 }))
  await ncm.activate({
    twilight: { providers: { register: async (p: typeof handlers) => { handlers = p } }, internal: { ncm: {
      request: async (path: string, cookie: string, options: { signal: AbortSignal }) => {
        assert.ok(!cookie); options.signal.throwIfAborted()
        const url = new URL(path, 'https://fixture.invalid'); requests.push(url.pathname)
        if (url.pathname === '/cloudsearch') return { code: 200, result: {
          albums: [{ id: 42, name: 'Album', size: 2, artists: [{ id: 7, name: 'Artist' }] }], albumCount: 1
        } }
        if (url.pathname === '/album') return { code: 200, album: {
          id: 42, name: 'Album', size: 2, artists: [{ id: 7, name: 'Artist' }]
        }, songs }
        throw new Error(`unexpected endpoint ${url.pathname}`)
      }
    } } },
    settings: { get: async (key?: string) => key ? undefined : {}, set: async () => {}, delete: async () => {} },
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  })
  writeFileSync(json, JSON.stringify(songs.map((s, i) => ({
    id: `local-${i + 1}`, source: 'local', filePath: join(root, `${i + 1}.flac`), fileName: `${i + 1}.flac`,
    title: s.name, artist: 'Artist', album: 'Album', duration: 200, size: 0, cover: null, lyrics: null,
    identityTags: { version: 1, scope: 'audio_file', title: { value: s.name, origin: 'audio_tag' },
      artists: { value: ['Artist'], origin: 'audio_tag' }, album: { value: 'Album', origin: 'audio_tag' },
      durationSeconds: { value: 200.25, origin: 'audio_tag' }, trackNumber: { value: s.no, origin: 'audio_tag' },
      trackTotal: { value: 2, origin: 'audio_tag' }, discNumber: { value: 1, origin: 'audio_tag' },
      discTotal: { value: 1, origin: 'audio_tag' } }
  }))))
  let client = workerClient(json, children)
  t.after(async () => {
    ncm.deactivate(); client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata(); await client.catalogAdvance(200)
  const entityId = (await client.catalogQuery({ kind: 'release' })).items[0].id
  const p = new PlatformIdentificationProvider('ncm', {
    inventory: () => [{ id: 'ncm', enabled: true, configuration: '1', supportedMethods: ['searchAlbums', 'fetchAlbumIdentity'] }],
    search: async (_id, method, query, limit, offset, signal) => {
      assert.equal(method, 'searchAlbums'); return handlers.searchAlbums(query, limit, offset, { signal })
    },
    albumIdentity: async (_id, id, signal) => handlers.fetchAlbumIdentity(id, { signal })
  })
  const request = { entityId, batchId: 'platform-album', providers: [{ id: p.id, matcherVersion: p.matcherVersion }] }
  await client.identificationEnqueue(request, 1000)
  const work = (await client.metadataClaim(1000))!
  const result = await p.recall(work.identification!, new AbortController().signal)
  assert.equal(await client.metadataFinish(work, { state: 'identified', ...result }, 1001), true)
  const original = await client.identificationDetail(entityId)
  assert.deepEqual(original.link!.confirmation, { mode: 'automatic', rule: 'platform_album_tracks' })
  const memberResults = (await client.metadataJobs({ entityId })).items[0].identification!.members!
  assert.equal(memberResults.length, 4)
  assert.ok(memberResults.every(m => m.state === 'confirmed'))
  const memberDetails = await Promise.all(memberResults.map(m => client.identificationDetail(m.entityId)))
  assert.ok(memberDetails.every(d => d.link!.confirmation?.rule === 'album_member'))
  assert.deepEqual(memberDetails.filter(d => d.kind === 'recording').map(d => d.references[0].value).sort(), ['ncm:101', 'ncm:102'])
  assert.ok(memberDetails.filter(d => d.kind === 'artist').every(d => d.references[0].value === '7'))
  assert.deepEqual(requests, ['/cloudsearch', '/album'])
  client.destroy(); await once(children[0], 'exit'); client = workerClient(json, children)
  await client.metadataRecover(2000)
  assert.equal(await client.metadataClaim(2000), null)
  assert.deepEqual(await client.identificationDetail(entityId), original)
  assert.deepEqual((await client.metadataJobs({ entityId })).items[0].identification!.members, memberResults)
  for (const detail of memberDetails) assert.deepEqual(await client.identificationDetail(detail.entityId), detail)
  const input = await client.identificationInput(entityId)
  assert.ok(input.sources!.every(s => s.provider === 'local' && s.tags.durationSeconds!.value === 200.25))
  assert.deepEqual((await client.getTracksByIds(['local-1', 'local-2'])).tracks.map(t => t.source), ['local', 'local'])
})

test('database worker publishes content changes without position polling or duplicate read notifications', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'core-library-changed-'))
  const json = join(root, 'library.json'), children: ChildProcess[] = [], revisions: number[] = []
  writeFileSync(json, JSON.stringify([{ id: 'one', filePath: join(root, 'one.flac'), title: 'One' }]))
  const client = workerClient(json, children, (revision) => revisions.push(revision))
  t.after(async () => { client.destroy(); for (const child of children) { if (child.exitCode === null) await once(child, 'exit') }; rmSync(root, { recursive: true, force: true }) })
  const initial = await client.getMetadata()
  await client.getMetadata()
  await tick()
  assert.deepEqual(revisions, [initial.revision])
  const page = await client.getTracksByIds(['one'])
  await client.patchTracks([{ id: 'one', expectedVersion: page.versions.one, patch: { title: 'Changed' } }])
  const after = await client.getMetadata()
  await tick()
  assert.deepEqual(revisions, [initial.revision, after.revision])
  assert.ok(after.revision > initial.revision)
})

async function uploadWorkerView(
  client: LibraryDatabaseServiceClient,
  id: string,
  count = 12_005,
  mixed = false
) {
  await client.syncPlaylistView({ kind: 'begin', id, versions: [] })
  let sequence = 0
  for (let offset = 0; offset < count; offset += 200)
    await client.syncPlaylistView({
      kind: 'append',
      id,
      sequence: ++sequence,
      entries: Array.from({ length: Math.min(200, count - offset) }, (_, i) =>
        mixed && (offset + i) % 7 === 0
          ? {
              id: 'ncm:7',
              snapshot: {
                id: 'ncm:7',
                filePath: '',
                title: 'Remote',
                artist: 'Artist',
                source: 'ncm'
              }
            }
          : { id: (offset + i) % 2 ? 'one' : 'two' }
      )
    })
  await client.syncPlaylistView({ kind: 'commit', id, sequence: ++sequence })
}

async function queueWorkerFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'queue-worker-build-')),
    json = join(root, 'music-library.json'),
    children: ChildProcess[] = []
  writeFileSync(
    json,
    JSON.stringify([
      { id: 'one', filePath: join(root, 'one.flac'), title: 'One' },
      { id: 'two', filePath: join(root, 'two.flac'), title: 'Two' }
    ])
  )
  const client = workerClient(json, children)
  await client.getMetadata()
  const inspector = new DatabaseSync(getLibraryDatabasePath(json), { readOnly: true })
  t.after(async () => {
    inspector.close()
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'exit')
      }
    client.destroy()
    rmSync(root, { recursive: true, force: true })
  })
  return { client, inspector, children, json }
}

test('worker navigation preview returns one exact occurrence without committing or exposing a renderer method', async (t) => {
  const { client } = await queueWorkerFixture(t)
  const queue = await client.createLibraryQueue({ ids: ['one', 'two', 'one'], sort: 'playlist' })
  const page = await client.readLibraryQueue(queue.id)
  assert.deepEqual(await client.readLibraryQueueNeighbor(queue.id, queue.revision, 0, -1, true), {
    ...page.items[2],
    logicalQueueEnd: true
  })
  assert.deepEqual(await client.readLibraryQueueNeighbor(queue.id, queue.revision, 2, 1, true), {
    ...page.items[0],
    logicalQueueEnd: false
  })
  assert.equal(await client.readLibraryQueueNeighbor(queue.id, queue.revision, 2, 1, false), null)
  const window = await client.readLibraryQueuePlaybackWindow(queue.id, queue.revision, 2, true)
  assert.deepEqual(window.queue, queue)
  assert.deepEqual(window.items, [page.items[2], { ...page.items[0], logicalQueueEnd: false }])
  assert.equal(window.lastPlayablePosition, 2)
  assert.equal(window.libraryRevision, page.libraryRevision)
  assert.deepEqual(await client.getLibraryQueue(queue.id), queue)
  await assert.rejects(
    client.readLibraryQueueNeighbor(queue.id, queue.revision + 1, 0, 1, true),
    /变化|revision|changed/i
  )
})

test('real worker preserves queue revision conflicts through the database transport without replaying edits', async (t) => {
  const { client } = await queueWorkerFixture(t)
  const queue = await client.createLibraryQueue({ ids: ['one', 'two', 'one'], sort: 'playlist' })
  const original = await client.readLibraryQueue(queue.id)
  const edited = await client.editLibraryQueue(queue.id, queue.revision, {
    kind: 'remove', entryIds: [original.items[1].queueEntryId]
  })
  await assert.rejects(
    client.readLibraryQueue(queue.id, 0, 1, { expectedRevision: queue.revision }),
    { code: 'STALE_REVISION', message: 'Library queue changed concurrently' }
  )
  await assert.rejects(
    client.editLibraryQueue(queue.id, queue.revision, { kind: 'clear' }),
    { code: 'STALE_REVISION', message: 'Library queue changed concurrently' }
  )
  assert.deepEqual(await client.getLibraryQueue(queue.id), edited.queue)
  assert.deepEqual(
    (await client.readLibraryQueue(queue.id)).items.map(item => item.queueEntryId),
    [original.items[0].queueEntryId, original.items[2].queueEntryId]
  )
  await assert.rejects(client.getLibraryQueue('missing'), error => {
    assert.equal((error as { code?: string }).code, undefined)
    assert.match(String(error), /does not exist/)
    return true
  })
})

test('the private database worker replaces only the requested source identity and does not replay a stale replacement', async (t) => {
  const { client } = await queueWorkerFixture(t)
  const queue = await client.createLibraryQueue({ ids: ['one', 'two', 'one'], sort: 'playlist' })
  const page = await client.readLibraryQueue(queue.id)
  const command = {
    queue: {
      id: queue.id,
      revision: queue.revision,
      index: queue.index,
      entryId: queue.selectedEntryId!
    },
    contentRevision: page.libraryRevision,
    occurrenceId: page.items[2].queueEntryId,
    expectedTrackId: 'one',
    replacement: {
      id: 'fixture:new',
      snapshot: { id: 'fixture:new', source: 'fixture', title: 'New source', filePath: '' }
    }
  }
  const updated = await client.replacePlaybackQueueSource(command)
  assert.equal(updated.revision, queue.revision + 1)
  const result = await client.readLibraryQueue(queue.id)
  assert.deepEqual(
    result.items.map((row) => row.queueEntryId),
    page.items.map((row) => row.queueEntryId)
  )
  assert.deepEqual(
    result.items.map((row) => row.track?.id),
    ['one', 'two', 'fixture:new']
  )
  await assert.rejects(client.replacePlaybackQueueSource(command), /changed concurrently/i)
  assert.deepEqual(await client.readLibraryQueue(queue.id), result)
})

async function waitForQueueCleanup(inspector: DatabaseSync) {
  const deadline = Date.now() + 10_000
  while (
    Number(inspector.prepare("SELECT count(*) AS n FROM queues WHERE state<>'ready'").get()?.n)
  ) {
    assert.ok(
      Date.now() < deadline,
      'worker background cleanup must converge without a new mutation'
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('real worker yields during completed checkpoint cleanup and recovers after termination mid-cleanup', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'scan-cleanup-worker-')),
    json = join(root, 'music-library.json'),
    path = getLibraryDatabasePath(json),
    children: ChildProcess[] = [],
    clients: LibraryDatabaseServiceClient[] = []
  const seed = new LibraryDatabase(path)
  seed.replaceDocument({
    version: 2,
    revision: 5,
    folders: [root],
    exclusions: [],
    tracks: [{ id: 'one', filePath: join(root, 'one.wav'), title: 'Retained' }]
  })
  seed.sql
    .exec(`INSERT INTO scan_jobs(id,mode,roots,state,updated_at) VALUES('done','full','[]','completed',1234);
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<30000)
    INSERT INTO scan_items SELECT 'done',printf('file-%05d',i),'{}','committed',NULL,1,1 FROM n;
    INSERT INTO scan_directories VALUES('done','root','complete',NULL);`)
  const progress = seed.getScanProgress('done'),
    queue = seed.createLibraryQueue({ ids: ['one', 'one'], sort: 'playlist' }),
    queuePage = seed.readLibraryQueue(queue.id)
  seed.close()
  const inspector = new DatabaseSync(path, { readOnly: true })
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit')
        child.kill()
        await exit
      }
    for (const client of clients) client.destroy()
    inspector.close()
    rmSync(root, { recursive: true, force: true })
  })
  const client = workerClient(json, children)
  clients.push(client)
  const page = await client.queryTracks({ limit: 1 })
  assert.equal(page.tracks[0].title, 'Retained')
  const left = Number(inspector.prepare('SELECT count(*) AS n FROM scan_items').get()!.n)
  assert.ok(left > 0 && left < 30000, 'ordinary query must return between bounded cleanup pulses')
  assert.deepEqual(await client.getScanProgress('done'), progress)
  const exit = once(children[0], 'exit')
  children[0].kill()
  await exit
  assert.ok(Number(inspector.prepare('SELECT count(*) AS n FROM scan_items').get()!.n) > 0)
  const restarted = workerClient(json, children)
  clients.push(restarted)
  assert.deepEqual(await restarted.getScanProgress('done'), progress)
  const deadline = Date.now() + 10000
  while (
    inspector.prepare("SELECT checkpoints_reclaimed FROM scan_jobs WHERE id='done'").get()!
      .checkpoints_reclaimed !== 1
  ) {
    assert.ok(Date.now() < deadline, 'cleanup must resume and drain without a mutation')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(inspector.prepare('SELECT count(*) AS n FROM scan_items').get()!.n, 0)
  assert.equal(inspector.prepare('SELECT count(*) AS n FROM scan_directories').get()!.n, 0)
  assert.deepEqual(await restarted.getScanProgress('done'), progress)
  assert.deepEqual(await restarted.getLibraryQueue(queue.id), queue)
  assert.deepEqual(await restarted.readLibraryQueue(queue.id), queuePage)
  assert.equal(inspector.prepare('SELECT updated_at FROM scan_jobs').get()!.updated_at, 1234)
})

test('real worker streams both queue orders in bounded pages and restart keeps publication but abandons an unfinished seed', async (t) => {
  const { client, inspector, children } = await queueWorkerFixture(t)
  const metadata = await client.getMetadata()
  const id = 'worker-stream-ready'
  await client.buildLibraryQueue({
    kind: 'begin',
    id,
    order: 'shuffle',
    contentRevision: metadata.revision
  })
  const originals = Array.from({ length: 605 }, (_, index) =>
    index % 7 === 0
      ? {
          id: 'ncm:7',
          snapshot: { id: 'ncm:7', filePath: 'ncm:7', source: 'ncm', title: `Remote ${index}` }
        }
      : { id: index % 2 ? 'one' : 'two' }
  )
  const displayed = originals.map((_, index) => {
    const originalPosition = (index + 200) % originals.length
    return { ...originals[originalPosition], originalPosition }
  })
  let sequence = 0
  for (let offset = 0; offset < displayed.length; offset += 200) {
    const reply = await client.buildLibraryQueue({
      kind: 'append',
      id,
      sequence: ++sequence,
      items: displayed.slice(offset, offset + 200)
    })
    assert.deepEqual(reply, {
      kind: 'building',
      id,
      sequence,
      total: Math.min(displayed.length, offset + 200)
    })
    assert.equal(
      inspector.prepare('SELECT state FROM queues WHERE id=?').get(id)?.state,
      'building'
    )
    await assert.rejects(client.getLibraryQueue(id), /does not exist/)
    assert.equal(
      (await client.getTracksByIds(['one'])).tracks.length,
      1,
      'an unfinished seed does not block ordinary reads'
    )
  }
  const reply = await client.buildLibraryQueue({
    kind: 'commit',
    id,
    sequence: ++sequence,
    selectedIndex: 0
  })
  if (reply.kind !== 'ready') throw new Error('Expected ready worker queue')
  assert.equal(reply.queue.total, 605)
  assert.equal(reply.queue.order, 'shuffle')
  const tail = await client.readLibraryQueue(id, 600, 200)
  assert.equal(tail.items.length, 5)
  assert.deepEqual(
    tail.items.map((row) => row.track?.id),
    displayed.slice(600).map((item) => item.id)
  )
  await client.buildLibraryQueue({
    kind: 'begin',
    id: 'worker-stream-interrupted',
    order: 'original',
    contentRevision: metadata.revision
  })
  await client.buildLibraryQueue({
    kind: 'append',
    id: 'worker-stream-interrupted',
    sequence: 1,
    items: Array(200).fill({ id: 'one' })
  })
  const child = children.at(-1)!
  child.kill()
  await once(child, 'exit')
  assert.deepEqual(await client.getLibraryQueue(id), reply.queue)
  assert.deepEqual(await client.readLibraryQueue(id, 600, 200), tail)
  await assert.rejects(
    client.buildLibraryQueue({
      kind: 'commit',
      id: 'worker-stream-interrupted',
      sequence: 2,
      selectedIndex: 0
    }),
    /expired/
  )
  await waitForQueueCleanup(inspector)
  assert.equal(
    inspector.prepare('SELECT 1 FROM queues WHERE id=?').get('worker-stream-interrupted'),
    undefined
  )
  const restored = await client.editLibraryQueue(id, reply.queue.revision, {
    kind: 'order',
    order: 'original'
  })
  assert.equal(restored.queue.index, 200)
  const first = await client.readLibraryQueue(id, 0, 200)
  assert.deepEqual(
    first.items.map((row) => row.track?.id),
    originals.slice(0, 200).map((item) => item.id)
  )
  assert.deepEqual(await client.getMetadata(), metadata)
})

test('real worker rejects an oversized seed, releases its shared build slot and cannot replay the rejected batch', async (t) => {
  const { client, inspector } = await queueWorkerFixture(t)
  const { revision } = await client.getMetadata()
  const id = 'worker-stream-invalid'
  await client.buildLibraryQueue({
    kind: 'begin',
    id,
    order: 'original',
    contentRevision: revision
  })
  await assert.rejects(
    client.buildLibraryQueue({
      kind: 'append',
      id,
      sequence: 1,
      items: Array(201).fill({ id: 'one' })
    }),
    /oversized/
  )
  await assert.rejects(
    client.buildLibraryQueue({ kind: 'append', id, sequence: 1, items: [{ id: 'one' }] }),
    /expired/
  )
  await waitForQueueCleanup(inspector)
  assert.equal(inspector.prepare('SELECT 1 FROM queues WHERE id=?').get(id), undefined)
  assert.equal(inspector.prepare('SELECT count(*) AS n FROM queue_entries').get()?.n, 0)
})

test('worker recent activity uses indexed timestamp and reverse-insertion ties, and freezes the same full order', async (t) => {
  const { client } = await queueWorkerFixture(t)
  const initial = await client.queryTracks({ sort: 'recentlyAdded', limit: 1 })
  assert.deepEqual(
    await client.getTracksByIds([]),
    {
      tracks: [],
      versions: {},
      revision: initial.revision,
      total: 0,
      offset: 0,
      historyRevision: 0
    },
    'empty-ID version probes must not transfer configuration or exclusions'
  )
  assert.deepEqual(
    initial.tracks.map((track) => track.id),
    ['two']
  )
  const track = await client.getTracksByIds(['one'])
  await client.patchTracks([
    { id: 'one', expectedVersion: track.versions.one, patch: { addedAt: 50 } }
  ])
  const recent = await client.queryTracks({ sort: 'recentlyAdded', limit: 1 })
  assert.ok(recent.revision > initial.revision)
  assert.equal((await client.getTracksByIds([])).revision, recent.revision)
  await assert.rejects(client.getTracksByIds([], initial.revision), /发生变化/)
  assert.deepEqual(
    recent.tracks.map((track) => track.id),
    ['one']
  )
  const queue = await client.createLibraryQueue(
    { sort: 'recentlyAdded', contentRevision: recent.revision },
    'two'
  )
  assert.equal(queue.total, 2)
  assert.equal(queue.index, 1)
  assert.deepEqual(
    (await client.readLibraryQueue(queue.id)).items.map((item) => item.track?.id),
    ['one', 'two']
  )
})

test('transport is lazy, waits for database open, and bounds pending requests including startup', async (t) => {
  const child = new ManualProcess()
  let forks = 0
  const client = new LibraryDatabaseServiceClient({
    serviceEntry: 'worker.js',
    libraryFilePath: 'library.json',
    maxPendingRequests: 2,
    fork: () => {
      forks++
      return child
    }
  })
  t.after(() => client.destroy())
  assert.equal(forks, 0)
  const first = client.getMetadata(),
    second = client.queryTracks({ limit: 200 })
  await assert.rejects(client.getMetadata(), /queue is full/)
  assert.equal(forks, 1)
  child.emit('message', { kind: 'ready' })
  await tick()
  assert.deepEqual(child.messages, [
    { kind: 'open', libraryFilePath: 'library.json', coverCacheDir: undefined }
  ])
  child.emit('message', { kind: 'opened' })
  await tick()
  for (const request of child.messages)
    if (request.kind === 'call')
      child.emit('message', {
        kind: 'response',
        requestId: request.requestId,
        ok: true,
        value: { revision: 1 }
      })
  assert.deepEqual(await first, { revision: 1 })
  assert.deepEqual(await second, { revision: 1 })
})

test('worker exit rejects an unconfirmed mutation and never silently replays it', async (t) => {
  const child = new ManualProcess()
  let forks = 0
  const client = new LibraryDatabaseServiceClient({
    serviceEntry: 'worker.js',
    libraryFilePath: 'library.json',
    fork: () => {
      forks++
      return child
    }
  })
  t.after(() => client.destroy())
  const pending = client.patchTracks([{ id: 'one', expectedVersion: 1, patch: { title: 'next' } }])
  child.emit('message', { kind: 'ready' })
  child.emit('message', { kind: 'opened' })
  await tick()
  child.emit('exit', 1)
  await assert.rejects(pending, /Refresh its state before retrying a write/)
  assert.equal(forks, 1)
  assert.equal(child.messages.filter((message) => message.kind === 'call').length, 1)
})

test('an unknown streamed publication rejects without replaying commit or opening a replacement worker', async (t) => {
  const child = new ManualProcess()
  let forks = 0
  const client = new LibraryDatabaseServiceClient({
    serviceEntry: 'worker.js',
    libraryFilePath: 'library.json',
    fork: () => {
      forks++
      return child
    }
  })
  t.after(() => client.destroy())
  const command = { kind: 'commit' as const, id: 'uncertain-stream', sequence: 2, selectedIndex: 0 }
  const pending = client.buildLibraryQueue(command)
  child.emit('message', { kind: 'ready' })
  child.emit('message', { kind: 'opened' })
  await tick()
  child.emit('exit', 1)
  await assert.rejects(pending, /Refresh its state before retrying a write/)
  assert.equal(forks, 1)
  const calls = child.messages.filter((message) => message.kind === 'call')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'buildLibraryQueue')
  assert.deepEqual(calls[0].args, [command])
})

test('startup failure rejects every waiting request without JSON fallback', async (t) => {
  const child = new ManualProcess()
  const client = new LibraryDatabaseServiceClient({
    serviceEntry: 'worker.js',
    libraryFilePath: 'library.json',
    fork: () => child
  })
  t.after(() => client.destroy())
  const one = client.getMetadata(),
    two = client.queryTracks()
  child.emit('message', { kind: 'open-error', error: 'Migration rejected malformed library' })
  await assert.rejects(one, /Migration rejected/)
  await assert.rejects(two, /Migration rejected/)
})

test('actual database process recovers WAL data, preserves cancelled scans and marks interrupted work', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'library-worker-'))
  const json = join(root, 'music-library.json'),
    audio = join(root, 'one.flac')
  writeFileSync(json, JSON.stringify({ version: 2, revision: 4, tracks: [], folders: [root] }))
  writeFileSync(audio, 'fixture')
  const children: ChildProcess[] = []
  const factory = () => workerClient(json, children)
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'exit')
      }
    rmSync(root, { recursive: true, force: true })
  })
  const first = factory()
  await first.getMetadata()
  await first.startScan({ id: 'cancelled', mode: 'full', roots: [root] })
  await first.setScanState('cancelled', 'cancelled')
  await first.startScan({ id: 'running', mode: 'startup', roots: [root] })
  const info = statSync(audio)
  await first.recordScanFiles('running', [
    { filePath: audio, size: info.size, mtimeMs: info.mtimeMs }
  ])
  await first.claimScanFiles('running')
  await first.commitScanBatch({
    jobId: 'running',
    sequence: 1,
    files: [
      {
        identity: { filePath: audio, size: info.size, mtimeMs: info.mtimeMs },
        tracks: [
          {
            id: 'one',
            filePath: audio,
            title: 'Committed before crash',
            artist: '周杰伦',
            album: 'Release',
            genre: 'Rock',
            duration: 60
          }
        ],
        metadataRead: true
      }
    ]
  })
  // Terminate without closing the database: recovery must consume its WAL, not legacy JSON.
  await first.syncListeningHistory({ kind: 'begin', id: 'durable-history', mode: 'replace' })
  await first.syncListeningHistory({
    kind: 'append',
    id: 'durable-history',
    sequence: 1,
    entries: [{ id: 'one', lastPlayed: 12345 }]
  })
  await first.syncListeningHistory({ kind: 'commit', id: 'durable-history', sequence: 2 })
  await first.syncListeningHistory({ kind: 'begin', id: 'unfinished-history', mode: 'replace' })
  await first.syncListeningHistory({
    kind: 'append',
    id: 'unfinished-history',
    sequence: 1,
    entries: [{ id: 'one', lastPlayed: 99999 }]
  })
  const exited = once(children[0], 'exit')
  first.destroy()
  await exited
  const restarted = factory()
  try {
    assert.equal((await restarted.queryTracks()).tracks[0].title, 'Committed before crash')
    assert.equal((await restarted.queryTracks()).totalDuration, 60)
    const unified = await restarted.queryTracks({
      search: 'zjl',
      sort: 'unifiedSearch',
      preferredSources: [versionSourceKey({ id: 'one', filePath: audio })],
      limit: 1
    })
    assert.equal(unified.total, 1)
    assert.equal(unified.tracks[0].id, 'one')
    assert.equal(unified.revision, (await restarted.getMetadata()).revision)
    const frozenSearch = await restarted.createLibraryQueue(
      { search: 'zjl', sort: 'playlist', contentRevision: unified.revision },
      'one'
    )
    assert.equal(frozenSearch.total, 1)
    await assert.rejects(
      restarted.createLibraryQueue({ search: 'zjl', contentRevision: unified.revision - 1 }, 'one'),
      /发生变化/
    )
    const paths = await restarted.lookupTracksByPaths([audio, 'one.flac', 'missing.flac'])
    assert.deepEqual(paths.ids, ['one', 'one', null])
    const playlist = await restarted.lookupPlaylistTracks(
      { entries: [{ id: 'one' }, { id: 'missing' }], versions: [] },
      paths.revision
    )
    assert.deepEqual(playlist.ids, ['one', null])
    assert.equal(playlist.revision, paths.revision)
    const recent = await restarted.lookupPlaylistTracks(
      {
        entries: [
          { id: 'history:one', sourceIds: ['absent', 'one'] },
          {
            id: 'history:fallback',
            snapshot: {
              id: 'gone',
              title: 'Committed before crash',
              artist: '周杰伦',
              duration: 999
            }
          }
        ],
        versions: [],
        resolution: 'recent'
      },
      paths.revision
    )
    assert.deepEqual(recent.ids, ['one', 'one'])
    assert.equal(recent.revision, paths.revision)
    await assert.rejects(
      restarted.lookupPlaylistTracks({ entries: [], versions: [] }, paths.revision - 1),
      /发生变化/
    )
    assert.equal(
      (await restarted.getTracksByIds(['one'], paths.revision)).tracks[0].title,
      'Committed before crash'
    )
    await assert.rejects(restarted.lookupTracksByPaths([audio], paths.revision - 1), /发生变化/)
    await assert.rejects(restarted.getTracksByIds(['one'], paths.revision - 1), /发生变化/)
    const duplicateCandidates = await restarted.readDuplicateCandidates()
    assert.equal(duplicateCandidates.items[0].id, 'one')
    assert.equal(duplicateCandidates.items[0].title, 'Committed before crash')
    assert.equal(duplicateCandidates.items[0].duration, 60)
    assert.equal(duplicateCandidates.nextCursor, null)
    assert.equal('lyrics' in duplicateCandidates.items[0], false)
    assert.equal(
      (await restarted.queryTracks({ sort: 'lastPlayed', historyRevision: 1 })).historyRevision,
      1
    )
    await assert.rejects(
      restarted.syncListeningHistory({ kind: 'commit', id: 'unfinished-history', sequence: 2 }),
      /session or sequence expired/
    )
    const artists = await restarted.queryCollections('artists', {
      collectionGenre: 'rock',
      limit: 1
    })
    assert.equal(artists.items[0].name, '周杰伦')
    assert.equal(artists.items[0].duration, 60)
    assert.deepEqual(artists.letterOffsets, { Z: 0 })
    assert.equal(artists.offset, 0)
    assert.equal('tracks' in artists.items[0], false)
    const albumCatalog = await restarted.queryCollections('albums', {
      search: 'release zjl',
      collectionSearchMode: 'albumTerms',
      limit: 1
    })
    assert.equal(albumCatalog.total, 1)
    assert.equal(albumCatalog.items[0].name, 'Release')
    const homeAlbums = await restarted.queryCollections('albums', {
      collectionSort: 'trackCount',
      direction: 'desc',
      limit: 5,
      contentRevision: paths.revision
    })
    assert.equal(homeAlbums.items[0].trackCount, 1)
    assert.equal(homeAlbums.total, 1)
    assert.equal(homeAlbums.revision, paths.revision)
    const artistCount = await restarted.queryCollections('artists', {
      collectionCountOnly: true,
      contentRevision: paths.revision
    })
    assert.equal(artistCount.total, 1)
    assert.deepEqual(artistCount.items, [])
    assert.deepEqual(artistCount.letterOffsets, {})
    const tail = await restarted.queryTracks({
      sort: 'insertion',
      direction: 'desc',
      limit: 6,
      contentRevision: paths.revision
    })
    assert.deepEqual(
      tail.tracks.map((track) => track.id),
      ['one']
    )
    assert.equal(
      (
        await restarted.queryCollections('albums', {
          search: 'releasezjl',
          collectionSearchMode: 'albumTerms',
          limit: 1
        })
      ).total,
      0
    )
    assert.equal(
      (
        await restarted.queryCollections('artists', {
          search: '周杰伦',
          collectionSearchMode: 'artistName',
          limit: 1
        })
      ).total,
      1
    )
    assert.equal(
      (
        await restarted.queryCollections('artists', {
          search: 'zjl',
          collectionSearchMode: 'artistName',
          limit: 1
        })
      ).total,
      0
    )
    const jobs = await restarted.listScanJobs()
    assert.equal(jobs.find((job) => job.id === 'running')?.state, 'interrupted')
    assert.equal(jobs.find((job) => job.id === 'cancelled')?.state, 'cancelled')
  } finally {
    restarted.destroy()
  }
})

test('a killed database worker retains queue edits, duplicate cursor and shuffle order', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'library-queue-worker-')),
    json = join(root, 'music-library.json')
  writeFileSync(
    json,
    JSON.stringify({
      version: 2,
      revision: 4,
      folders: [],
      tracks: [
        { id: 'one', filePath: join(root, 'one.flac') },
        { id: 'two', filePath: join(root, 'two.flac') }
      ]
    })
  )
  const children: ChildProcess[] = []
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'exit')
      }
    rmSync(root, { recursive: true, force: true })
  })
  const client = workerClient(json, children)
  let queue = await client.createLibraryQueue({ ids: ['one', 'two', 'one'], sort: 'playlist' })
  const duplicate = (await client.readLibraryQueue(queue.id)).items[2].queueEntryId
  queue = (
    await client.editLibraryQueue(queue.id, queue.revision, { kind: 'select', entryId: duplicate })
  ).queue
  queue = (
    await client.editLibraryQueue(queue.id, queue.revision, {
      kind: 'insert',
      afterEntryId: duplicate,
      trackIds: ['two', 'two']
    })
  ).queue
  queue = (
    await client.editLibraryQueue(queue.id, queue.revision, { kind: 'order', order: 'shuffle' })
  ).queue
  const page = await client.readLibraryQueue(queue.id)
  assert.equal(page.items.length, 5)
  assert.equal(page.items[0].queueEntryId, duplicate)
  const exited = once(children[0], 'exit')
  // Kill without SQLite close/checkpoint; the new process must read committed WAL.
  children[0].kill()
  await exited
  const restarted = workerClient(json, children)
  try {
    assert.deepEqual(await restarted.getLibraryQueue(queue.id), queue)
    assert.deepEqual(await restarted.readLibraryQueue(queue.id), page)
    const portable = await restarted.exportPlaybackQueue(
      { id: queue.id, revision: queue.revision, entryId: duplicate, index: queue.index },
      32 * 1024 * 1024 - 1024
    )
    assert.equal(portable.queue.length, 5)
    assert.equal(portable.queue[portable.queueIndex].queueEntryId, duplicate)
    await assert.rejects(
      restarted.editLibraryQueue(queue.id, queue.revision - 1, { kind: 'clear' }),
      /changed concurrently/
    )
    assert.deepEqual(await restarted.getLibraryQueue(queue.id), queue)
    const original = (
      await restarted.editLibraryQueue(queue.id, queue.revision, {
        kind: 'order',
        order: 'original'
      })
    ).queue
    assert.equal(original.index, 2)
    assert.equal(original.selectedEntryId, duplicate)
    assert.deepEqual(
      (await restarted.readLibraryQueue(queue.id)).items.map((item) => item.track?.id),
      ['one', 'two', 'one', 'two', 'two']
    )
    await restarted.deleteLibraryQueue(queue.id, original.revision)
    await assert.rejects(restarted.getLibraryQueue(queue.id), /does not exist/)
  } finally {
    client.destroy()
    restarted.destroy()
  }
})

test(
  'actual worker prepares playlist catalog summaries cooperatively and loses only the private projection on restart',
  { timeout: 30_000 },
  async (t) => {
    const { client, children } = await queueWorkerFixture(t)
    await client.syncPlaylistView({ kind: 'begin', id: 'catalog', versions: [], catalog: true })
    let sequence = 0
    for (let i = 0; i < 405; i += 200)
      await client.syncPlaylistView({
        kind: 'groups',
        id: 'catalog',
        sequence: ++sequence,
        groups: Array.from({ length: Math.min(200, 405 - i) }, (_, j) => ({
          id: String(i + j),
          name: `Mix ${i + j}`,
          isDefault: i + j === 0
        }))
      })
    const count = 12_005
    for (let i = 0; i < count; i += 200)
      await client.syncPlaylistView({
        kind: 'append',
        id: 'catalog',
        sequence: ++sequence,
        entries: Array.from({ length: Math.min(200, count - i) }, (_, j) => ({
          id: (i + j) % 2 ? 'one' : 'two',
          collectionId: String((i + j) % 405)
        }))
      })
    await client.syncPlaylistView({ kind: 'commit', id: 'catalog', sequence: ++sequence })
    let finished = false
    const pending = client
      .queryCollections('playlists', { playlistView: 'catalog', offset: 400 })
      .then((page) => {
        finished = true
        return page
      })
    assert.equal((await client.getTracksByIds(['one'])).tracks[0].id, 'one')
    assert.equal(finished, false, 'ordinary reads are served between catalog projection batches')
    const last = await pending
    assert.equal(last.total, 405)
    assert.equal(last.items.length, 5)
    assert.equal(last.items[0].id, '400')
    assert.ok(last.items.every((summary) => summary.trackCount === 29))
    assert.equal('trackIds' in last.items[0], false)
    const changed = await client.patchTracks([
      { id: 'one', expectedVersion: 1, patch: { duration: 7 } }
    ])
    const refreshed = await client.queryCollections('playlists', {
      playlistView: 'catalog',
      limit: 1
    })
    assert.equal(refreshed.revision, changed.revision)
    assert.equal(refreshed.items[0].trackCount, 30)
    assert.equal(refreshed.items[0].duration, 105)
    const exiting = once(children[0], 'exit')
    children[0].kill()
    await exiting
    await assert.rejects(
      client.queryCollections('playlists', { playlistView: 'catalog' }),
      /expired/
    )
    assert.equal((await client.getTracksByIds(['one'])).tracks[0].duration, 7)
  }
)

test('mixed playlist views disappear on worker restart but committed mixed queues and remote occurrences survive', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'library-playlist-worker-')),
    json = join(root, 'music-library.json')
  writeFileSync(
    json,
    JSON.stringify([{ id: 'one', title: 'Local', filePath: join(root, 'one.flac') }])
  )
  const children: ChildProcess[] = []
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'exit')
      }
    rmSync(root, { recursive: true, force: true })
  })
  const client = workerClient(json, children)
  let restarted: LibraryDatabaseServiceClient | undefined
  try {
    await client.syncPlaylistView({ kind: 'begin', id: 'view', versions: [] })
    await client.syncPlaylistView({
      kind: 'append',
      id: 'view',
      sequence: 1,
      entries: [
        { id: 'one' },
        {
          id: 'ncm:7',
          snapshot: { id: 'ncm:7', filePath: '', title: 'Remote', artist: 'Artist', source: 'ncm' }
        },
        {
          id: 'ncm:7',
          snapshot: { id: 'ncm:7', filePath: '', title: 'Remote', artist: 'Artist', source: 'ncm' }
        }
      ]
    })
    await client.syncPlaylistView({ kind: 'commit', id: 'view', sequence: 2 })
    const page = await client.queryTracks({ playlistView: 'view', sort: 'playlist' })
    assert.deepEqual(page.entryIds, ['0', '1', '2'])
    const queue = await client.createLibraryQueue(
      {
        playlistView: 'view',
        sort: 'playlist',
        playlistEntryId: '2',
        contentRevision: page.revision
      },
      'ncm:7'
    )
    const queued = await client.readLibraryQueue(queue.id)
    const exit = once(children[0], 'exit')
    children[0].kill()
    await exit
    restarted = workerClient(json, children)
    await assert.rejects(restarted.queryTracks({ playlistView: 'view' }), /expired/)
    assert.deepEqual(await restarted.getLibraryQueue(queue.id), queue)
    assert.deepEqual(await restarted.readLibraryQueue(queue.id), queued)
    const previous = await restarted.editLibraryQueue(queue.id, queue.revision, {
      kind: 'step',
      direction: -1,
      wrap: false
    })
    assert.equal(previous.queue.index, 1)
    const exported = await restarted.exportPlaybackQueue(
      {
        id: queue.id,
        revision: previous.queue.revision,
        entryId: previous.queue.selectedEntryId!,
        index: 1
      },
      32000
    )
    assert.equal(exported.queue[1].source, 'ncm')
    await restarted.deleteLibraryQueue(queue.id, previous.queue.revision)
  } finally {
    client.destroy()
    restarted?.destroy()
  }
})

test(
  'actual worker lets ordinary reads and playback pass two cold views and shared-build readers',
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'playlist-worker-fair-')),
      json = join(root, 'music-library.json'),
      children: ChildProcess[] = []
    writeFileSync(
      json,
      JSON.stringify([
        { id: 'one', filePath: join(root, 'one.flac'), title: 'One' },
        { id: 'two', filePath: join(root, 'two.flac'), title: 'Two' }
      ])
    )
    const client = workerClient(json, children)
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
          await once(child, 'exit')
        }
      client.destroy()
      rmSync(root, { recursive: true, force: true })
    })
    const queue = await client.createLibraryQueue({ ids: ['one', 'two'], sort: 'playlist' })
    await uploadWorkerView(client, 'a')
    await uploadWorkerView(client, 'b')
    const finished: string[] = []
    const a = client
      .queryTracks({ playlistView: 'a', sort: 'playlist', offset: 12_000 })
      .then((result) => {
        finished.push('a')
        return result
      })
    const b = client.queryTracks({ playlistView: 'b', sort: 'playlist' }).then((result) => {
      finished.push('b')
      return result
    })
    const shared = client
      .queryTracks({ playlistView: 'a', sort: 'playlist', offset: 200 })
      .then((result) => {
        finished.push('shared')
        return result
      })
    const quick = await Promise.all([
      client.getMetadata(),
      client.queryTracks({ sort: 'playlist', limit: 1 }),
      client.getTracksByIds(['two']),
      client.readLibraryQueue(queue.id)
    ])
    assert.deepEqual(finished, [], 'cold preparation must leave the serial owner between batches')
    assert.equal(quick[0].trackCount, 2)
    assert.equal(quick[1].tracks.length, 1)
    assert.equal(quick[2].tracks[0].id, 'two')
    assert.equal(quick[3].items[0].track?.id, 'one')
    const pages = await Promise.all([a, b, shared])
    assert.deepEqual(
      pages.map((page) => page.total),
      [12_005, 12_005, 12_005]
    )
    assert.deepEqual(pages[0].entryIds, ['12000', '12001', '12002', '12003', '12004'])
    assert.equal(pages[2].entryIds?.[0], '200')
  }
)

test(
  'actual worker rejects an in-progress old revision or dropped view and rebuilds only on a fresh request',
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'playlist-worker-invalidate-')),
      json = join(root, 'music-library.json'),
      children: ChildProcess[] = []
    writeFileSync(
      json,
      JSON.stringify([
        { id: 'one', filePath: join(root, 'one.flac'), title: 'One' },
        { id: 'two', filePath: join(root, 'two.flac'), title: 'Two' }
      ])
    )
    const client = workerClient(json, children)
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
          await once(child, 'exit')
        }
      client.destroy()
      rmSync(root, { recursive: true, force: true })
    })
    await uploadWorkerView(client, 'revision')
    const stale = assert.rejects(client.queryTracks({ playlistView: 'revision' }), /变化/)
    await client.patchTracks([{ id: 'one', expectedVersion: 1, patch: { title: 'Updated' } }])
    await stale
    assert.equal((await client.getTracksByIds(['one'])).tracks[0].title, 'Updated')
    const fresh = await client.queryTracks({
      playlistView: 'revision',
      search: 'Updated',
      sort: 'playlist'
    })
    assert.equal(fresh.total, 6002)
    assert.equal(
      fresh.tracks.every((track) => track.title === 'Updated'),
      true
    )
    await uploadWorkerView(client, 'history')
    const oldHistory = assert.rejects(
      client.queryTracks({ playlistView: 'history', sort: 'lastPlayed', direction: 'desc' }),
      /Listening history changed/
    )
    await client.syncListeningHistory({ kind: 'begin', id: 'interleaved-history', mode: 'replace' })
    await client.syncListeningHistory({
      kind: 'append',
      id: 'interleaved-history',
      sequence: 1,
      entries: [{ id: 'one', lastPlayed: 999 }]
    })
    await client.syncListeningHistory({ kind: 'commit', id: 'interleaved-history', sequence: 2 })
    await oldHistory
    const currentHistory = await client.queryTracks({
      playlistView: 'history',
      sort: 'lastPlayed',
      direction: 'desc'
    })
    assert.equal(currentHistory.total, 12_005)
    assert.equal(currentHistory.tracks[0].id, 'one')
    await uploadWorkerView(client, 'dropped')
    const cancelled = assert.rejects(client.queryTracks({ playlistView: 'dropped' }), /expired/)
    await client.syncPlaylistView({ kind: 'drop', id: 'dropped' })
    await cancelled
    assert.equal((await client.queryTracks()).total, 2)
    // A released slot is eventually reclaimed by the worker without another sync.
    let released = false
    for (let i = 0; i < 200 && !released; i++) {
      try {
        await client.syncPlaylistView({ kind: 'begin', id: 'dropped', versions: [] })
        released = true
      } catch (error) {
        assert.match(String(error), /being released/)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    assert.equal(released, true)
  }
)

test(
  'closing a worker during cold preparation rejects the pending read instead of publishing a partial page',
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'playlist-worker-close-')),
      json = join(root, 'music-library.json'),
      children: ChildProcess[] = []
    writeFileSync(
      json,
      JSON.stringify([
        { id: 'one', filePath: join(root, 'one.flac') },
        { id: 'two', filePath: join(root, 'two.flac') }
      ])
    )
    const client = workerClient(json, children)
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
          await once(child, 'exit')
        }
      client.destroy()
      rmSync(root, { recursive: true, force: true })
    })
    await uploadWorkerView(client, 'closing')
    const pending = assert.rejects(client.queryTracks({ playlistView: 'closing' }), /not open/)
    await client.getMetadata()
    children[0].send({ kind: 'close', requestId: 'close-test' })
    await pending
  }
)

test(
  'actual worker builds two complete mixed queues without blocking ordinary reads or the currently playing queue',
  { timeout: 30_000 },
  async (t) => {
    const { client, inspector } = await queueWorkerFixture(t)
    const previous = await client.createLibraryQueue({ ids: ['one', 'two'], sort: 'playlist' })
    await uploadWorkerView(client, 'large', 32_005, true)
    await client.queryTracks({ playlistView: 'large', sort: 'playlist' })
    const finished: string[] = []
    const a = client
      .createLibraryQueue(
        { playlistView: 'large', sort: 'playlist', playlistEntryId: '31997' },
        'ncm:7'
      )
      .then((queue) => {
        finished.push('a')
        return queue
      })
    const b = client
      .createLibraryQueue(
        { playlistView: 'large', sort: 'playlist', playlistEntryId: '0' },
        'ncm:7'
      )
      .then((queue) => {
        finished.push('b')
        return queue
      })
    const quick = await Promise.all([
      client.getMetadata(),
      client.getTracksByIds(['one']),
      client.queryTracks({ sort: 'playlist', limit: 1 }),
      client.readLibraryQueue(previous.id)
    ])
    assert.deepEqual(
      finished,
      [],
      'building queue rows must leave the serial owner between batches'
    )
    assert.equal(quick[0].trackCount, 2)
    assert.equal(quick[1].tracks[0].id, 'one')
    assert.equal(quick[2].total, 2)
    assert.equal(quick[3].items[0].track?.id, 'one')
    assert.equal(
      inspector.prepare("SELECT count(*) AS n FROM queues WHERE state='building'").get()?.n,
      2
    )
    const queues = await Promise.all([a, b])
    assert.deepEqual(
      queues.map((queue) => queue.total),
      [32_005, 32_005]
    )
    assert.deepEqual(
      queues.map((queue) => queue.index),
      [31_997, 0]
    )
    for (const queue of queues) {
      const selected = (await client.readLibraryQueue(queue.id, queue.index, 1)).items[0]
      assert.equal(selected.queueEntryId, queue.selectedEntryId)
      assert.equal(selected.track?.source, 'ncm')
    }
    assert.notEqual(queues[0].selectedEntryId, queues[1].selectedEntryId)
    await client.syncPlaylistView({ kind: 'drop', id: 'large' })
    assert.equal((await client.readLibraryQueue(queues[0].id, 32_000)).items.length, 5)
    assert.deepEqual(await client.getLibraryQueue(previous.id), previous)
  }
)

test(
  'actual worker abandons queue construction promptly on content/history changes or view release',
  { timeout: 30_000 },
  async (t) => {
    const { client, inspector } = await queueWorkerFixture(t)
    const previous = await client.createLibraryQueue({ ids: ['one', 'two'], sort: 'playlist' })
    await uploadWorkerView(client, 'large', 32_005, true)
    await client.queryTracks({ playlistView: 'large', sort: 'playlist' })
    const old = assert.rejects(
      client.createLibraryQueue({ playlistView: 'large', sort: 'playlist' }),
      /变化/
    )
    await client.getMetadata()
    assert.equal(
      inspector.prepare("SELECT count(*) AS n FROM queues WHERE state='building'").get()?.n,
      1
    )
    await client.patchTracks([{ id: 'one', expectedVersion: 1, patch: { title: 'Updated' } }])
    await old
    await waitForQueueCleanup(inspector)
    assert.deepEqual(await client.getLibraryQueue(previous.id), previous)
    await client.queryTracks({ playlistView: 'large', sort: 'playlist' })
    const history = assert.rejects(
      client.createLibraryQueue({ playlistView: 'large', sort: 'lastPlayed' }),
      /Listening history changed/
    )
    await client.getMetadata()
    await client.syncListeningHistory({ kind: 'begin', id: 'queue-history', mode: 'replace' })
    await client.syncListeningHistory({
      kind: 'append',
      id: 'queue-history',
      sequence: 1,
      entries: [{ id: 'one', lastPlayed: 100 }]
    })
    await client.syncListeningHistory({ kind: 'commit', id: 'queue-history', sequence: 2 })
    await history
    await waitForQueueCleanup(inspector)
    const released = assert.rejects(
      client.createLibraryQueue({ playlistView: 'large', sort: 'playlist' }),
      /expired/
    )
    await client.getMetadata()
    await client.syncPlaylistView({ kind: 'drop', id: 'large' })
    await released
    await waitForQueueCleanup(inspector)
    assert.deepEqual(await client.getLibraryQueue(previous.id), previous)
    assert.equal((await client.queryTracks()).total, 2)
  }
)

test(
  'killing the actual worker mid-build never recovers a partial queue and preserves the committed mixed queue',
  { timeout: 30_000 },
  async (t) => {
    const { client, inspector, children, json } = await queueWorkerFixture(t)
    await uploadWorkerView(client, 'large', 32_005, true)
    await client.queryTracks({ playlistView: 'large', sort: 'playlist' })
    const ready = await client.createLibraryQueue(
      { playlistView: 'large', sort: 'playlist', playlistEntryId: '31997' },
      'ncm:7'
    )
    const before = await client.readLibraryQueue(ready.id, 31_995, 10)
    const pending = assert.rejects(
      client.createLibraryQueue({ playlistView: 'large', sort: 'playlist' }),
      /exited/
    )
    await client.getMetadata()
    const hidden = String(
      inspector.prepare("SELECT id FROM queues WHERE state='building'").get()?.id
    )
    assert.notEqual(hidden, 'undefined')
    const exit = once(children[0], 'exit')
    children[0].kill()
    await exit
    await pending
    assert.equal(
      inspector.prepare('SELECT state FROM queues WHERE id=?').get(hidden)?.state,
      'building'
    )
    const restarted = workerClient(json, children)
    t.after(() => restarted.destroy())
    await restarted.getMetadata()
    await assert.rejects(restarted.getLibraryQueue(hidden), /does not exist/)
    assert.deepEqual(await restarted.getLibraryQueue(ready.id), ready)
    assert.deepEqual(await restarted.readLibraryQueue(ready.id, 31_995, 10), before)
    await waitForQueueCleanup(inspector)
    assert.equal(inspector.prepare('SELECT 1 FROM queues WHERE id=?').get(hidden), undefined)
  }
)

test(
  'an actual worker exits on failed durability restoration; its replacement recovers without replaying the failed queue',
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'queue-sync-worker-')),
      json = join(root, 'music-library.json'),
      harness = join(root, 'worker-fault.mjs'),
      children: ChildProcess[] = [],
      calls: LibraryDatabaseWorkerRequest[] = []
    writeFileSync(
      json,
      JSON.stringify([
        { id: 'one', filePath: join(root, 'one.flac') },
        { id: 'two', filePath: join(root, 'two.flac') }
      ])
    )
    writeFileSync(
      harness,
      `import { DatabaseSync } from 'node:sqlite';
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      if(sql === 'PRAGMA synchronous=FULL') throw new Error('injected restore failure');
      return exec.call(this, sql);
    };
    await import(${JSON.stringify(new URL('./libraryDatabaseService.ts', import.meta.url).href)});`
    )
    const client = new LibraryDatabaseServiceClient({
      serviceEntry: fileURLToPath(new URL('./libraryDatabaseService.ts', import.meta.url)),
      libraryFilePath: json,
      fork: (entry) => {
        const child = fork(children.length ? entry : harness, [], {
          execArgv: ['--experimental-strip-types'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc']
        })
        children.push(child)
        Object.assign(child, {
          postMessage: (message: LibraryDatabaseWorkerRequest) => {
            calls.push(message)
            child.send(message)
          }
        })
        return child as unknown as DatabaseUtilityProcess
      }
    })
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
          await once(child, 'exit')
        }
      client.destroy()
      rmSync(root, { recursive: true, force: true })
    })
    const previous = await client.createLibraryQueue({ ids: ['one', 'two'], sort: 'playlist' })
    await uploadWorkerView(client, 'view', 605)
    await client.queryTracks({ playlistView: 'view', sort: 'playlist' })
    await assert.rejects(
      client.createLibraryQueue({ playlistView: 'view', sort: 'playlist' }),
      /exited.*Refresh/
    )
    assert.equal(children[0].exitCode, 1)
    await client.getMetadata()
    assert.equal(children.length, 2)
    assert.deepEqual(await client.getLibraryQueue(previous.id), previous)
    assert.equal(
      calls.filter((call) => call.kind === 'call' && call.method === 'createLibraryQueue').length,
      2
    )
    const patched = await client.patchTracks([
      { id: 'one', expectedVersion: 1, patch: { title: 'After recovery' } }
    ])
    assert.equal(patched.tracks[0].title, 'After recovery')
    const inspector = new DatabaseSync(getLibraryDatabasePath(json), { readOnly: true })
    try {
      await waitForQueueCleanup(inspector)
    } finally {
      inspector.close()
    }
  }
)

test(
  'killing migration leaves the source intact and the next worker rebuilds its staging database',
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'library-migration-crash-')),
      json = join(root, 'music-library.json')
    const source = JSON.stringify({
      version: 2,
      revision: 23,
      folders: [root],
      tracks: Array.from({ length: 6000 }, (_, i) => ({
        id: `track:${i}`,
        filePath: join(root, `${i}.flac`),
        extension: 'x'.repeat(512)
      }))
    })
    writeFileSync(json, source)
    const children: ChildProcess[] = []
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
          await once(child, 'exit')
        }
      rmSync(root, { recursive: true, force: true })
    })
    const first = workerClient(json, children),
      pending = first.getMetadata()
    const rejected = assert.rejects(pending, /stopped|exited/)
    const staging = `${getLibraryDatabasePath(json)}.migrating`,
      deadline = Date.now() + 10_000
    while (!existsSync(staging) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(existsSync(staging))
    assert.equal(existsSync(getLibraryDatabasePath(json)), false)
    const exited = once(children[0], 'exit')
    first.destroy()
    await exited
    await rejected
    assert.equal(readFileSync(json, 'utf8'), source)
    const restarted = workerClient(json, children)
    try {
      const metadata = await restarted.getMetadata()
      assert.equal(metadata.trackCount, 6000)
      assert.equal(metadata.revision, 23)
      assert.equal(
        (await restarted.getTracksByIds(['track:5999'])).tracks[0].extension,
        'x'.repeat(512)
      )
      assert.equal(existsSync(staging), false)
    } finally {
      restarted.destroy()
    }
  }
)

test(
  'real worker aggregate preparation, variant sorting, full queues and recovery yield to normal reads and fence revisions',
  { timeout: 30_000 },
  async (t) => {
    const { client, children, json } = await queueWorkerFixture(t)
    const id = 'aggregate',
      count = 12_005
    await client.syncPlaylistView({ kind: 'begin', id, versions: [], preserveSources: true })
    let sequence = 0
    for (let offset = 0; offset < count; offset += 200)
      await client.syncPlaylistView({
        kind: 'append',
        id,
        sequence: ++sequence,
        entries: Array.from({ length: Math.min(200, count - offset) }, (_, i) => ({
          id: `ncm:${offset + i}`,
          snapshot: {
            id: `ncm:${offset + i}`,
            filePath: '',
            source: 'ncm',
            title: 'Same',
            artist: 'Artist',
            duration: 180
          }
        }))
      })
    await client.syncPlaylistView({ kind: 'commit', id, sequence: ++sequence })
    const query = { playlistView: id, sort: 'playlist' as const, aggregate: {} }
    let done = false
    const cold = client.queryTracks(query).finally(() => {
      done = true
    })
    const rejected = assert.rejects(cold, /变化/)
    assert.equal((await client.getTracksByIds(['one'])).tracks.length, 1)
    assert.equal(done, false, 'cold aggregation must let ordinary reads finish before it')
    const patched = await client.patchTracks([
      { id: 'one', expectedVersion: 1, patch: { title: 'Persistent patch' } }
    ])
    await rejected
    const first = await client.queryTracks(query)
    assert.equal(first.total, count)
    assert.equal(first.tracks.length, 200)
    assert.equal(first.revision, patched.revision)
    let searchDone = false
    const ordinarySearch = client
      .queryTracks({ ...query, aggregate: undefined, search: 'same' })
      .finally(() => {
        searchDone = true
      })
    await client.getTracksByIds(['one'])
    assert.equal(searchDone, false, 'deferred occurrence FTS must yield to ordinary reads')
    const searched = await ordinarySearch
    assert.equal(searched.total, count)
    assert.equal(searched.tracks.length, 200)
    assert.deepEqual(searched.entryIds, first.entryIds)
    const last = await client.queryTracks({ ...query, offset: 12_000 })
    const queue = await client.createLibraryQueue(
      { ...query, contentRevision: last.revision, playlistEntryId: last.entryIds![4] },
      'ncm:12004'
    )
    assert.equal(queue.total, count)
    assert.equal(queue.index, 12_004)
    const window = await client.readLibraryQueue(queue.id, 12_000)
    assert.equal(window.items[4].track!.id, 'ncm:12004')

    // A single recording with many occurrences uses cooperative sort runs too.
    const variantsId = 'variants'
    await client.syncPlaylistView({
      kind: 'begin',
      id: variantsId,
      versions: [],
      preserveSources: true
    })
    sequence = 0
    for (let offset = 0; offset < count; offset += 200)
      await client.syncPlaylistView({
        kind: 'append',
        id: variantsId,
        sequence: ++sequence,
        entries: Array.from({ length: Math.min(200, count - offset) }, () => ({ id: 'two' }))
      })
    await client.syncPlaylistView({ kind: 'commit', id: variantsId, sequence: ++sequence })
    const row = await client.queryTracks({
      playlistView: variantsId,
      sort: 'playlist',
      aggregate: {}
    })
    let sorted = false
    const variants = client
      .queryTracks({
        playlistView: variantsId,
        sort: 'playlist',
        aggregate: { variantRow: row.aggregate!.rows[0].rowId },
        offset: 12_000
      })
      .finally(() => {
        sorted = true
      })
    await client.getTracksByIds(['one'])
    assert.equal(sorted, false)
    const page = await variants
    assert.equal(page.total, count)
    assert.deepEqual(page.entryIds, ['12000', '12001', '12002', '12003', '12004'])

    const dropping = assert.rejects(
      client.queryTracks({ ...query, search: 'new selection' }),
      /expired/
    )
    await client.getMetadata()
    await client.syncPlaylistView({ kind: 'drop', id })
    await dropping
    const exited = once(children[0], 'exit')
    children[0].kill()
    await exited
    const restarted = workerClient(json, children)
    t.after(() => restarted.destroy())
    await assert.rejects(
      restarted.queryTracks({ playlistView: variantsId, sort: 'playlist', aggregate: {} }),
      /expired/
    )
    assert.deepEqual(await restarted.getLibraryQueue(queue.id), queue)
    assert.deepEqual(await restarted.readLibraryQueue(queue.id, 12_000), window)
    assert.equal((await restarted.getTracksByIds(['one'])).tracks[0].title, 'Persistent patch')
  }
)


test('portable favorites reattachment publishes one real worker preference event and an immediately readable view', async t => {
  const root = mkdtempSync(join(tmpdir(), 'portable-favorite-events-')), json = join(root, 'library.json')
  const children: ChildProcess[] = [], revisions: number[] = [], refreshes: Array<ReturnType<LibraryDatabaseServiceClient['preferencesPlaylistsLoad']>> = []
  const tracks = [1, 2].map(n => ({ id: `portable-${n}`, source: 'local' as const, filePath: join(root, `${n}.flac`), fileName: `${n}.flac`, title: `Track ${n}`, artist: 'Artist', album: `Album ${n}`, duration: 200, size: 0, cover: null, lyrics: null }))
  const document = { version: 2 as const, revision: 0, folders: [], exclusions: [], tracks }
  const seed = new LibraryDatabase(':memory:')
  let music: ReturnType<LibraryDatabase['musicBackupExport']>
  try {
    seed.replaceDocument(document)
    while (seed.catalogStatus().localPending) seed.catalogAdvance()
    seed.preferencesPlaylistsMigrate({ version: 2, revision: 1, savedAt: '2026-01-01', data: [{ id: 'favorites', name: 'Favorites', isDefault: true, createdAt: '2026-01-01', trackIds: [tracks[0].id], trackSnapshots: { [tracks[0].id]: tracks[0] } }] }, 100)
    const source = seed.sql.prepare('SELECT id FROM catalog_sources WHERE track_id=?').get(tracks[1].id)!
    seed.sql.prepare("INSERT INTO music_genre_overrides VALUES('source',?,'[\"genre:jazz\"]')").run(String(source.id))
    music = seed.musicBackupExport(4 * 1024 * 1024)
  } finally { seed.close() }
  writeFileSync(json, '[]')
  const client = workerClient(json, children, undefined, undefined, undefined, revision => {
    revisions.push(revision)
    refreshes.push(client.preferencesPlaylistsLoad())
  })
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata()
  await client.musicBackupRestore({ restoreId: 'offline-events', conflict: 'use-backup', music, expectedRevision: await client.musicBackupRevision(), now: 200 })
  const before = await client.musicBackupRevision()
  await Promise.all(refreshes)
  const eventCount = revisions.length, refreshCount = refreshes.length
  assert.ok((await client.preferencesPlaylistsLoad())!.data[0].trackIds[0].startsWith('offline_favorite_'))
  // This exact source has portable genres but no favorite placeholder to replace.
  await client.replaceDocument({ ...document, tracks: [tracks[1]] })
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance()
  assert.equal((await client.musicBackupRevision()).preferences, before.preferences)
  assert.equal(revisions.length, eventCount)
  const recording = (await client.catalogQuery({ kind: 'recording' })).items[0], source = (await client.catalogSources({ entityId: recording.id })).items[0]
  assert.deepEqual((await client.genresEvidence({ target: { kind: 'source', id: source.id } })).selection.override, ['genre:jazz'])
  await client.replaceDocument(document)
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance()
  const after = await client.musicBackupRevision()
  const views = await Promise.all(refreshes.slice(refreshCount))
  assert.equal(after.preferences, before.preferences + 1)
  assert.deepEqual(revisions.slice(eventCount), [after.preferences])
  assert.equal(views.length, 1)
  assert.deepEqual(views[0]!.data[0].trackIds, [tracks[0].id], 'the event consumer sees the real source without restart or manual refresh')
  // The receipt remains portable, but no current placeholder means no new event.
  await client.replaceDocument(document)
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance()
  assert.equal((await client.musicBackupRevision()).preferences, after.preferences)
  assert.deepEqual(revisions.slice(eventCount), [after.preferences])
})

test('personal music backup crosses the real worker and restores clears once across an unknown ACK and restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'personal-music-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = []
  writeFileSync(json, JSON.stringify([{ id: 'backup-one', source: 'local', filePath: join(root, 'one.flac'), title: 'One', artist: 'Artist', album: 'Album' }]))
  let client = workerClient(json, children)
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata()
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance()
  const recording = (await client.catalogQuery({ kind: 'recording' })).items[0]
  let detail = await client.ratingsDetail(recording.id)
  detail = await client.ratingsSet({ entityId: recording.id, token: detail.token, steps: 8 }, 1000)
  await client.ratingsSet({ entityId: recording.id, token: detail.token, steps: null }, 1001)
  const tag = await client.tagsCreate({ name: 'Portable', tagsRevision: (await client.tagsState()).tagsRevision }, 1002)
  await client.tagsMemberSet({ tagId: tag.tag.id, entityId: recording.id, present: true, membersRevision: tag.tag.membersRevision }, 1003)
  const revision = await client.musicBackupRevision()
  const data = await client.musicBackupExport(4 * 1024 * 1024)
  assert.deepEqual(await client.musicBackupRevision(), revision, 'export changes no personal revision')
  assert.equal(data.version, 1)
  assert.equal(data.records.ratings[0].steps, null)
  detail = await client.ratingsDetail(recording.id)
  await client.ratingsSet({ entityId: recording.id, token: detail.token, steps: 2 }, 1004)
  const preview = await client.musicBackupPreview(data)
  assert.ok(preview.conflicts > 0)
  assert.equal(preview.missingSources, 0)
  const bundle = { restoreId: 'portable-worker-once', conflict: 'use-backup' as const, expectedRevision: preview.revision, music: data, now: 1005 }
  await client.musicBackupRestore(bundle)
  assert.equal((await client.ratingsDetail(recording.id)).value?.steps, null)
  assert.equal((await client.tagsMembers({ tagId: tag.tag.id })).items[0].id, recording.id)
  detail = await client.ratingsDetail(recording.id)
  await client.ratingsSet({ entityId: recording.id, token: detail.token, steps: 9 }, 1006)
  const historyCount = (await client.ratingsHistory({ entityId: recording.id })).total
  await client.musicBackupRestore(bundle)
  assert.equal((await client.ratingsDetail(recording.id)).value?.steps, 9, 'replay never overwrites later edits')
  const exited = once(children.at(-1)!, 'exit')
  client.destroy(); await exited
  client = workerClient(json, children)
  await client.getMetadata()
  await client.musicBackupRestore(bundle)
  assert.equal((await client.ratingsDetail(recording.id)).value?.steps, 9)
  assert.equal((await client.ratingsHistory({ entityId: recording.id })).total, historyCount)
  assert.equal((await client.queryTracks({ limit: 10 })).total, 1)
})

test('exploration exact lookup, roles, work and manual ordered performances survive real worker replacement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'exploration-worker-')), json = join(root, 'library.json')
  const children: ChildProcess[] = [], states: import('../../shared/musicExploration.ts').MusicExplorationState[] = []
  writeFileSync(json, JSON.stringify([{ id: 'explore-one', source: 'local', filePath: join(root, 'one.flac'), title: 'One', artist: 'Artist', album: 'Album' }]))
  const open = () => workerClient(json, children, undefined, undefined, undefined, undefined, undefined, undefined, state => states.push(state))
  let client = open()
  t.after(async () => {
    client.destroy()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  await client.getMetadata()
  while ((await client.catalogStatus()).localPending) await client.catalogAdvance()
  const recording = (await client.catalogQuery({ kind: 'recording' })).items[0]
  const recordingRef = { provider: 'musicbrainz', kind: 'recording' as const, idType: 'mbid', value: '00000000-0000-0000-0000-000000000001' }
  const personRef = { ...recordingRef, kind: 'artist' as const, value: '00000000-0000-0000-0000-000000000020' }
  const workRef = { ...recordingRef, kind: 'work' as const, value: '00000000-0000-0000-0000-000000000010' }
  const [candidate] = await client.identificationPublish(await client.identificationInput(recording.id), [{
    provider: 'musicbrainz', name: 'One', summary: '', matcherVersion: 'manual', references: [recordingRef],
    evidence: { origin: 'search', matches: ['name'], missing: ['manual'], conflicts: [], incomplete: true, provenance: 'fixture' }
  }], 1000)
  await client.identificationDecide({ candidateId: candidate.id, revision: candidate.revision, linkRevision: candidate.linkRevision, decision: 'confirm' }, 1001)
  const attribution = { provider: 'musicbrainz', externalId: personRef.value, url: 'https://musicbrainz.org', license: 'CC0', licenseUrl: '', attribution: 'MusicBrainz', revision: '1', retrievedAt: 1000 }
  await client.explorationIngest({ owner: recordingRef, provider: 'musicbrainz-details', setKey: 'worker-test',
    nodes: [{ reference: recordingRef, title: 'One' }, { reference: personRef, title: 'Exact person' }, { reference: workRef, title: 'Real work' }],
    relations: [{ from: workRef, to: recordingRef, kind: 'work_recording', order: 0, attribution },
      { from: personRef, to: workRef, kind: 'credit', order: 0, attribution, credit: { personRef, name: 'Exact person', targetRef: workRef, role: 'composer', rawRole: 'composer', relationTypeId: 'composer-id', direction: 'backward', order: 0, joinphrase: '', attributes: [], begin: '', end: '', attribution } }], truncated: false })
  const person = (await client.explorationLookup({ reference: personRef })).entity!, work = (await client.explorationLookup({ reference: workRef })).entity!
  assert.equal(person.inLibrary, true); assert.equal(work.inLibrary, true)
  const participation = await client.explorationParticipation({ entityId: person.id, roles: ['composer'] })
  assert.equal(participation.total, 1); assert.equal(participation.items[0].entity.id, work.id)
  assert.equal((await client.explorationParticipation({ entityId: person.id, roles: ['producer'] })).total, 0)
  assert.equal((await client.explorationRelations({ entityId: work.id, direction: 'outgoing' })).items[0].entity.id, recording.id)
  assert.equal((await client.explorationQuery({ kinds: ['performance'] })).total, 0)
  const performance = await client.explorationPerformanceSave({ title: 'Confirmed concert', workId: work.id, recordingIds: [recording.id, recording.id], revision: (await client.explorationState()).revision })
  await assert.rejects(client.explorationQuery({ token: participation.token }), { code: 'STALE_REVISION' })
  const movements = await client.explorationRelations({ entityId: performance.entity!.id, direction: 'outgoing', relations: ['performance_recording'] })
  assert.deepEqual(movements.items.map(x => x.relation.order), [0, 1]); assert.equal(movements.items[0].entity.id, recording.id)
  await tick(); assert.deepEqual(states.at(-1), await client.explorationState())
  const before = await client.explorationState(), exited = once(children.at(-1)!, 'exit')
  client.destroy(); await exited; client = open(); await client.getMetadata()
  assert.deepEqual(await client.explorationState(), before)
  assert.equal((await client.explorationLookup({ reference: workRef })).entity!.id, work.id)
  assert.equal((await client.explorationDetail({ entityId: performance.entity!.id })).entity!.title, 'Confirmed concert')
  assert.equal((await client.explorationRelations({ entityId: performance.entity!.id, direction: 'outgoing', relations: ['performance_recording'] })).total, 2)
  await assert.rejects(client.explorationPerformanceDelete({ id: performance.entity!.id, revision: before.revision - 1 }), { code: 'STALE_REVISION' })
  assert.equal(await client.explorationPerformanceDelete({ id: performance.entity!.id, revision: before.revision }), true)
  assert.equal((await client.explorationDetail({ entityId: performance.entity!.id })).entity!.inLibrary, false)
  assert.equal((await client.explorationQuery({ kinds: ['performance'] })).total, 0)
  assert.equal((await client.queryTracks({ limit: 10 })).total, 1)
  assert.equal(JSON.stringify(participation).includes(root.replaceAll('\\', '\\\\')), false)
  assert.deepEqual(await client.explorationBackfillCredits(1), { processed: 0, pending: false })
})
