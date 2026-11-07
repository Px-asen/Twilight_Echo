import { CoreLyricsService } from '../../../core/lyrics/service.ts'
import { projectCoreTrack } from '../../../core/projections.ts'
import { createInactiveVisualizationData } from '../stores/player/useVisualizationPolling.ts'

/** Test Core host: real committed-lyrics owner behind the production renderer bridge. */
export async function installPlayingMusicCoreFixture() {
  const fixture = window.__lyricsFixture
  const listeners = new Set()
  const subscriptions = new Map()
  let selected = null
  let occurrence = 0
  let samples = 0
  let ready = false
  let snapshot = {
    protocolVersion: 1, epoch: 'lyrics-fixture', sequence: 0, phase: 'ready', track: null, queue: null,
    playback: { state: 'paused', position: 0, duration: 180, playbackRate: 1, volume: 1, playMode: 'sequential', nativePlaybackActive: true,
      codec: '', bitrate: 0, sourceSampleRate: 44100, sourceChannels: 2, sourceBitDepth: 16 },
    loading: false, migrationRequired: false, error: null, isStreamBuffering: false,
    ...Object.fromEntries(['presentationRevision','pluginsRevision','libraryRevision','abLoop','mute','modelPack','cloudTransfers','inbox','libraryLoudness','loudness','scan','statisticsRevision','playlistsRevision','versionsRevision','audioRevision','settingsRevision','sleepTimer','bookmarksRevision','workspaceRevision','workspaceContentRevision','streams','cast','network','downloads','personalized','heart'].map((key) => [key, null])),
    lyricsRevision: fixture.revision, lyricsContentRevision: 0
  }
  const emit = (message) => { for (const listener of listeners) listener({ connectionId: 'ui', message }) }
  const publish = () => {
    if (!ready) return
    snapshot = { ...snapshot, sequence: snapshot.sequence + 1,
      lyricsRevision: lyrics.getRevision(), lyricsContentRevision: lyrics.getContentRevision() }
    emit({ kind: 'state', epoch: snapshot.epoch, sequence: snapshot.sequence, snapshot: structuredClone(snapshot) })
  }
  const envelope = () => ({ version: 2, revision: fixture.revision, savedAt: '2026-10-23T00:00:00Z', data: structuredClone(fixture.document) })
  const lyrics = new CoreLyricsService({
    repository: {
      load: async () => envelope(),
      save: async (document, expectedRevision) => {
        if (fixture.rejectNextSave) {
          fixture.rejectNextSave = false
          fixture.revision++
          throw Object.assign(new Error('fixture CAS conflict'), { code: 'ERR_PERSISTENCE_REVISION_CONFLICT', expectedRevision, current: envelope() })
        }
        if (expectedRevision !== fixture.revision) throw new Error('unexpected lyrics revision')
        fixture.document = structuredClone(document)
        fixture.revision++
        return envelope()
      }
    },
    now: Date.now, changed: publish, failed: (error) => { throw error },
    timers: { setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: handle => clearTimeout(handle) },
    sources: { getAppSettings: () => ({ value: { onlineLyricsFallback: false } }), loadLocalLyrics: async () => null,
      resolveProviderLyrics: async () => ({ lyrics: null, translatedLyrics: null }), loadAmlTtml: async () => null, loadOnlineLyrics: async () => null },
    search: async (track) => ({ query: { title: track.title, artist: track.artist }, candidates: [], best: null }),
    importDraft: async () => { fixture.importCalls++; return fixture.importResult },
    exportDraft: async (contents) => { fixture.saveCalls++; fixture.lastSavedContents = contents; return fixture.saveResult }
  })
  await lyrics.initialize()
  lyrics.activate()
  ready = true
  window.api.core = {
    connect: async () => ({ ok: true, value: { connectionId: 'ui', snapshot: structuredClone(snapshot) } }),
    onMessage: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    onStatus: () => () => {}, cancel: async () => ({ ok: true }), disconnect: async () => ({ ok: true }),
    request: async (_id, request) => {
      const payload = request.payload
      try {
        let value = null
        switch (request.name) {
          case 'lyrics.state': value = lyrics.state(); break
          case 'lyrics.current': value = lyrics.content(); break
          case 'lyrics.edit': value = await lyrics.edit(payload); break
          case 'lyrics.reload': await lyrics.reload(payload); break
          case 'lyrics.search': value = await lyrics.search(payload); break
          case 'lyrics.importDraft': value = await lyrics.importDraft(); break
          case 'lyrics.exportDraft': value = await lyrics.exportDraft(payload.contents); break
          case 'playback.seek':
            snapshot = { ...snapshot, playback: { ...snapshot.playback, position: payload.position } }; publish(); break
          case 'playback.diagnostics': value = { status: 'native' }; break
          case 'queue.page': value = { revision: snapshot.queue.revision, total: 1, offset: 0, items: [{ position: 0, queueEntryId: snapshot.queue.occurrenceId, track: snapshot.track }] }; break
          case 'visualization.subscribe': {
            let sequence = 0
            const timer = setInterval(() => {
              samples++
              emit({ kind: 'visualization', epoch: snapshot.epoch, subscriptionId: payload.subscriptionId, sequence: ++sequence,
                data: { ...createInactiveVisualizationData(), tapStatus: 'synthetic-fallback' } })
            }, 30)
            subscriptions.set(payload.subscriptionId, timer)
            break
          }
          case 'visualization.unsubscribe': clearInterval(subscriptions.get(payload.subscriptionId)); subscriptions.delete(payload.subscriptionId); break
          default: throw new Error('Unexpected Core UI fixture request: ' + request.name)
        }
        return { ok: true, value: structuredClone(value) }
      } catch (error) {
        return { ok: false, error: { code: error.code ?? 'FAILED', message: error.message } }
      }
    }
  }
  window.__coreFixture = {
    get samples() { return samples },
    snapshot: () => structuredClone(snapshot),
    select: (track) => {
      selected = structuredClone(track)
      selected.queueEntryId = 'occurrence-' + ++occurrence
      lyrics.observe(null)
      lyrics.observe(selected)
      snapshot = { ...snapshot, track: projectCoreTrack(selected),
        queue: { id: 'fixture-queue', revision: occurrence, total: 1, index: 0, occurrenceId: selected.queueEntryId },
        playback: { ...snapshot.playback, position: 0, duration: track.duration } }
      publish()
    },
    playing: (playing) => { snapshot = { ...snapshot, playback: { ...snapshot.playback, state: playing ? 'playing' : 'paused' } }; publish() },
    loading: (loading) => { snapshot = { ...snapshot, loading }; publish() },
    sample: (position) => { snapshot = { ...snapshot, playback: { ...snapshot.playback, position } }; publish() }
  }
}
