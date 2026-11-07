import { CorePlaylistService } from '../../../core/playlists/service.ts'
import { CorePlaylistSubmission } from '../../../core/playlists/submission.ts'
import { createLogicalTrackModel } from '../../../shared/logicalTrackModel.ts'
import { emptyMusicVersions } from '../../../shared/musicVersions.ts'
import { projectCoreTrack } from '../../../core/projections.ts'
import { configurePortablePathPlatform } from '../../../shared/portablePath.ts'
import { useCoreConnection } from '../stores/coreConnection.ts'

/** In-memory host for UI tests, with the production playlist owner and wire projections. */
export async function installMusicCoreFixture(fixture) {
  configurePortablePathPlatform('win32')
  const listeners = new Set()
  const clone = structuredClone
  let ready = false
  let snapshot = {
    protocolVersion: 1, epoch: 'music-ui', sequence: 0, phase: 'ready',
    libraryRevision: 1, playlistsRevision: fixture.revision, versionsRevision: 0,
    statisticsRevision: 0, bookmarksRevision: 0, pluginsRevision: 0
  }
  const envelope = () => ({ version: 2, revision: fixture.revision,
    savedAt: new Date().toISOString(), data: clone(fixture.authoritative) })
  const page = (tracks, query = {}) => {
    let selected = tracks
    if (query.ids) selected = selected.filter(track => query.ids.includes(track.id))
    if (query.search) selected = selected.filter(track => track.title.toLowerCase().includes(query.search.toLowerCase()))
    if (query.filters?.dsd === true) selected = selected.filter(track => /dsf|dff|dsd/i.test(track.format ?? ''))
    if (query.artist) selected = selected.filter(track => track.artist === query.artist)
    if (query.album) selected = selected.filter(track => [track.album, track.albumId, 'id:' + track.albumId].includes(query.album))
    if (query.folder) selected = selected.filter(track => track.filePath.startsWith(query.folder))
    if (query.sort && query.sort !== 'playlist') selected = [...selected].sort((a, b) => String(a[query.sort] ?? '').localeCompare(String(b[query.sort] ?? '')))
    if (query.direction === 'desc') selected = [...selected].reverse()
    const anchorIndex = query.anchorId ? selected.findIndex(track => track.id === query.anchorId) : undefined
    const limit = query.limit ?? 200
    const offset = anchorIndex >= 0 ? Math.floor(anchorIndex / limit) * limit : query.offset ?? 0
    return { revision: 1, offset, total: selected.length, totalDuration: selected.length * 180,
      tracks: selected.slice(offset, offset + limit), anchorIndex }
  }
  const metadata = () => ({ revision: 1, trackCount: fixture.localTracks.length, folders: ['C:/Music'], exclusions: [] })
  const publish = () => {
    if (!ready) return
    snapshot = { ...snapshot, sequence: snapshot.sequence + 1, playlistsRevision: playlists.getRevision() }
    for (const listener of listeners) listener({ connectionId: 'music-ui',
      message: { kind: 'state', epoch: snapshot.epoch, sequence: snapshot.sequence, snapshot: clone(snapshot) } })
  }
  const playlists = new CorePlaylistService({
    runtime: {
      repository: {
        load: async () => envelope(),
        save: async (data, revision) => {
          if (fixture.conflictNext) {
            fixture.conflictNext = false
            fixture.revision++
            fixture.authoritative.push({ id: 'pl-remote', name: 'Remote', trackIds: [], createdAt: new Date().toISOString() })
            throw Object.assign(new Error('concurrent playlist write'), {
              code: 'ERR_PERSISTENCE_REVISION_CONFLICT', current: envelope(), expectedRevision: revision })
          }
          if (revision !== fixture.revision) throw new Error('unexpected playlist revision')
          fixture.authoritative = clone(data)
          fixture.revision++
          return envelope()
        }
      },
      now: Date.now, newId: () => crypto.randomUUID(), clone, notify() { /* Core publication owns fixture notifications. */ },
      identity: createLogicalTrackModel(() => undefined), versions: { ensure() { /* This host has no version overrides. */ }, revision: () => 0 }
    },
    database: {
      getMetadata: async () => metadata(),
      getTracksByIds: async ids => page(fixture.localTracks, { ids }),
      queryTracks: async query => page(fixture.localTracks, query),
      lookupTracksByPaths: async paths => ({ revision: 1, tracks: fixture.localTracks.filter(track => paths.includes(track.filePath)) }),
      syncPlaylistView: async () => { throw new Error('JSON fixture must not allocate a SQL view') }
    },
    loadJsonLibrary: async () => ({ revision: 1, tracks: clone(fixture.localTracks) }),
    versions: { getRevision: () => 0, snapshot: emptyMusicVersions },
    recentHistory: { getRevision: () => snapshot.statisticsRevision,
      recentPlaylist: () => ({ id: 'core:recent', name: 'Recent', trackIds: (fixture.recentTracks ?? []).map(track => track.id),
        trackSnapshots: Object.fromEntries((fixture.recentTracks ?? []).map(track => [track.id, track])), createdAt: '' }) },
    findRelocationsInFolder: async missing => ({
      relocations: missing.map(track => ({ trackId: track.id, fromPath: track.filePath,
        toTrack: { ...track, id: 'relocated-missing', filePath: 'E:\\Relocated\\Missing.flac' } })),
      unresolvedTrackIds: [], ambiguousTrackIds: []
    }),
    changed: publish
  })
  await playlists.initialize()
  const submissions = new CorePlaylistSubmission({
    playlists,
    resolve: async inputs => inputs.map(input => {
      const track = fixture.localTracks.find(track => track.id === input.id)
      if (!track) throw new Error('Unknown fixture track ' + input.id)
      return track
    }),
    newId: () => crypto.randomUUID(),
    schedule: (callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer) }
  })
  ready = true
  snapshot.playlistsRevision = playlists.getRevision()
  window.api.core = {
    connect: async () => ({ ok: true, value: { connectionId: 'music-ui', snapshot: clone(snapshot) } }),
    onMessage: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    onStatus: () => () => {}, disconnect: async () => ({ ok: true }), cancel: async () => ({ ok: true }),
    request: async (_id, { name, payload: p }) => {
      try {
        let value
        switch (name) {
          case 'library.metadata': value = metadata(); break
          case 'library.collections': {
            const key = { albums: 'album', artists: 'artist', genres: 'genre' }[p.kind]
            const items = p.kind === 'folders' ? [{ id: 'C:/Music', name: 'Music', path: 'C:/Music', trackCount: fixture.localTracks.length, duration: 0, cover: null }]
              : [...new Set(fixture.localTracks.map(track => track[key]).filter(Boolean))].map(name => ({
                id: p.kind === 'albums' ? fixture.localTracks.find(track => track.album === name).albumId ?? name : name,
                name, trackCount: fixture.localTracks.filter(track => track[key] === name).length, duration: 0, cover: null }))
            value = { revision: 1, offset: 0, total: items.length, items, letterOffsets: {} }
            break
          }
          case 'library.tracks': { const result = page(fixture.localTracks, p); value = { ...result, tracks: result.tracks.map(track => projectCoreTrack(track)) }; break }
          case 'library.byIds': { const result = page(fixture.localTracks, p); value = { ...result, tracks: result.tracks.map(track => projectCoreTrack(track)) }; break }
          case 'playlists.state': value = playlists.state(); break
          case 'playlists.catalog': value = playlists.catalog(p.offset, p.limit, p.revision); break
          case 'playlists.collection': {
            const items = fixture.authoritative.filter(item => (item.kind === 'aggregate') === p.aggregate)
              .sort((a, b) => String(b.pinnedAt ?? '').localeCompare(String(a.pinnedAt ?? '')) || a.name.localeCompare(b.name))
              .map(item => ({ id: item.id, name: item.name, trackCount: item.trackIds.length, duration: 0, cover: item.cover ?? null }))
            value = { revision: 1, offset: 0, total: items.length, items, letterOffsets: {} }
            break
          }
          case 'playlists.members': value = await playlists.members(p); break
          case 'playlists.membership': value = playlists.membership(p.id, p.revision, p.ids); break
          case 'playlists.view': value = await playlists.view(p); break
          case 'playlists.edit': value = await playlists.edit(p.revision, p.edit); break
          case 'playlists.submit': value = await submissions.submit('music-ui', p); break
          case 'playlists.export': value = await playlists.exportDocument(p.id, p.revision, p.format); break
          case 'playlists.importDocument': value = await playlists.importDocument(p.id, p.revision, p.fileName, p.contents); break
          case 'playlists.repair': value = await playlists.startRepair(p.id, p.revision, p.folder); break
          case 'playlists.repair.status': value = playlists.repairSnapshot(); break
          case 'playlists.flush': await playlists.flush(); value = true; break
          case 'bookmarks.state': value = { revision: 0, longTrackResumeSeconds: 1200 }; break
          case 'statistics.overview': value = { revision: snapshot.statisticsRevision, days: {}, artists: [], recorded: { seconds: 0, plays: 0, trackCount: 0, formats: [] },
            history: { mode: 'sqlite', ready: true, pending: false, revision: snapshot.statisticsRevision, error: '' }, persistence: { dirty: false, error: null } }; break
          case 'bookmarks.page': case 'statistics.tracks': case 'catalog.query': value = { revision: 0, offset: 0, total: 0, items: [] }; break
          case 'providers.list': value = []; break
          case 'library.artwork': value = { cover: null }; break
          case 'metadata.status': value = { state: 'idle', total: 0, queued: 0, active: 0, completed: 0, failed: 0, skipped: 0, error: '' }; break
          default: throw new Error('Unexpected music fixture request: ' + name)
        }
        return { ok: true, value: clone(value) }
      } catch (error) {
        console.error('Music fixture request failed', name, error.message)
        return { ok: false, error: { code: error.code ?? 'FAILED', message: error.message } }
      }
    }
  }
  await useCoreConnection().attach()
  return { playlists, publish,
    replacePlaylists: async next => {
      fixture.authoritative = clone(next)
      fixture.revision++
      await playlists.refreshPreferences()
      publish()
    },
    setRecent: tracks => { fixture.recentTracks = clone(tracks); snapshot.statisticsRevision++; publish() }
  }
}
