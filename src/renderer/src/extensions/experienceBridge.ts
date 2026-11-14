import { watch, type WatchStopHandle } from 'vue'
import { corePlugins } from './corePlugins.ts'
import {
  assertExperienceMethod,
  experienceRequestLimit,
  EXPERIENCE_MUSIC_OPERATIONS,
  type ExperienceMusicOperation,
  EXPERIENCE_METHOD_PERMISSIONS,
  type InstalledExperience
} from '../../../shared/pluginExperience.ts'
import { useMusicStore } from '../stores/useMusicStore'
import { useCoreConnection } from '../stores/coreConnection.ts'
import type { CoreTrackView } from '../../../shared/coreViews.ts'
import { usePlayerStore } from '../stores/usePlayerStore'
import { useSettingsStore } from '../stores/useSettingsStore'
import type { Track } from '../types/music'
import type { ExperienceLibraryAlbum } from './experienceLibrary.ts'
import { useProviderStore } from '../stores/useProviderStore'
import {
  createDspFactoryScene,
  DSP_FACTORY_SCENE_TEMPLATES,
  type DspFactorySceneTemplateId
} from '../../../shared/dspGraph.ts'
import { nodeCatalog, normalizeNodeEditorParams, singletonNodeTypes } from '../utils/dspNodeParams'
import { createExperienceServices } from './experienceServices'
import {
  createExperienceLibraryReader,
  readExperiencePlaylistTrackDtos
} from './experienceLibrary.ts'

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const bounded = (value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error('Value outside supported range')
  return value
}

export function createExperienceBridge(
  experience: InstalledExperience,
  port: MessagePort,
  exit: () => void,
  openPanel: (name: string) => void
) {
  const music = useMusicStore(),
    player = usePlayerStore(),
    settings = useSettingsStore()
  let disposed = false,
    inFlight = 0
  const stops: WatchStopHandle[] = []
  const core = useCoreConnection()
  const providers = useProviderStore()
  const invokeService = createExperienceServices(experience.permissions)
  const remoteTracks = new Map<string, Track>()
  const sqliteLibrary = createExperienceLibraryReader(core)
  const rememberTracks = (tracks: Track[]) =>
    tracks.map((track) => {
      remoteTracks.set(track.id, track)
      if (remoteTracks.size > 10000) remoteTracks.delete(remoteTracks.keys().next().value!)
      return trackDto(track)
    })
  type ExperienceAlbum = {
    id?: string
    name: string
    artist?: string
    releaseDate?: string
    cover?: string | null
    coverSource?: string | null
    genre?: string | null
    trackCount: number
    duration?: number
    extensionId?: string
    tracks?: Track[]
  }
  function trackDto(track: CoreTrackView, albumIdOverride?: string) {
    return {
      id: track.id,
      albumId:
        albumIdOverride ?? sqliteLibrary.trackAlbumId(track.id),
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      format: track.format ?? '',
      trackNumber: track.trackNumber,
      discNumber: track.discNumber,
      sampleRate: track.sampleRate,
      bitsPerSample: track.bitDepth,
      bitrate: track.bitrate,
      browserPlayable: true,
      audioUrl: '',
      relativePath: '',
      favorite: player.currentTrack.value?.id === track.id ? player.currentFavorite.value?.liked ?? false : music.isFavoriteTrack(track),
      queueEntryId: track.queueEntryId
    }
  }
  function albumDto(album: ExperienceAlbum, full = false) {
    const tracks = album.tracks ?? []
    return {
      id: album.extensionId ?? album.id,
      title: album.name,
      artist: album.artist ?? '',
      year: album.releaseDate ? Number(album.releaseDate.slice(0, 4)) : undefined,
      genreId: tracks[0]?.genre || album.genre || '未分类',
      rawGenres: [],
      folder: '',
      coverUrl:
        album.cover?.startsWith('cover://') || album.cover?.startsWith('data:image/')
          ? album.cover
          : undefined,
      trackCount: album.trackCount,
      totalDuration: album.duration ?? tracks.reduce((sum, t) => sum + t.duration, 0),
      tracks: full ? tracks.map((track) => trackDto(track, album.extensionId)) : [],
      producers: [],
      offline: false
    }
  }
  function rememberDatabaseAlbum(album: ExperienceLibraryAlbum): ExperienceAlbum {
    return { ...album, tracks: album.tracks }
  }
  function state() {
    return {
      transport: player.isLoading.value
        ? 'loading'
        : player.isPlaying.value
          ? 'playing'
          : player.currentTrack.value
            ? 'paused'
            : 'idle',
      currentTrack: player.currentTrack.value ? trackDto(player.currentTrack.value) : null,
      playing: player.isPlaying.value,
      loading: player.isLoading.value,
      duration: player.duration.value,
      currentTime: player.currentTime.value,
      volume: player.volume.value,
      currentIndex: player.queueIndex.value,
      playMode: player.playMode.value,
      error: player.audioEngineError.value || null,
      songTransitionMode:
        player.audioProcessing.value.crossfadeSeconds > 0 ? 'fade-in-out' : 'gapless',
      backend: 'twilight',
      outputDeviceId: player.audioDevice.value,
      sleepTimer: player.sleepTimerState.value,
      playbackRate: player.playbackRate.value
    }
  }
  const send = (event: string, value: unknown) => {
    if (!disposed) port.postMessage({ event, value: plain(value) })
  }
  async function resolveTracks(ids: string[]): Promise<Track[]> {
    const found = new Map<string, Track>(),
      missing: string[] = []
    for (const id of ids) {
      const track = remoteTracks.get(id)
      if (track) found.set(id, track)
      else missing.push(id)
    }
    if (missing.length) {
      for (let offset = 0; offset < missing.length; offset += 200) {
        const page = await music.getTracksByIds(missing.slice(offset, offset + 200))
        await sqliteLibrary.rememberTrackAlbums(page.tracks)
        for (const track of page.tracks) found.set(track.id, track)
      }
    }
    return ids.map((id) => {
      const track = found.get(id)
      if (!track) throw new Error('Track no longer available')
      return track
    })
  }
  async function resolveTrack(id: unknown): Promise<Track> {
    if (typeof id !== 'string') throw new Error('Missing track id')
    return (await resolveTracks([id]))[0]
  }
  async function invoke(method: string, args: Record<string, unknown>) {
    assertExperienceMethod(method, experience.permissions)
    if (disposed) throw new Error('Experience session closed')
    if (
      /^(radio|podcasts|network|stats|diagnostics|themes)\./.test(method) ||
      ['plugins.catalog', 'plugins.update'].includes(method)
    )
      return invokeService(method, args)
    switch (method) {
      case 'online.providers':
        await providers.syncProviders()
        return providers.providers.value.map((p) => ({
          id: p.id,
          name: p.name,
          methods: p.supportedMethods,
          authType: p.ui?.authType,
          qrStatusCodes: p.ui?.qrStatusCodes
        }))
      case 'online.search': {
        const result = await providers.callProvider<{ items: Track[]; total: number }>(
          String(args.providerId),
          'searchSongs',
          [String(args.query ?? '').slice(0, 200), 50, bounded(args.offset ?? 0, 0, 100000)]
        )
        return { items: rememberTracks(result.items), total: result.total }
      }
      case 'online.login': {
        const result = await providers.checkLogin(String(args.providerId))
        return { loggedIn: result.loggedIn, nickname: result.profile?.nickname ?? '' }
      }
      case 'online.qr': {
        const result = await providers.getQrLogin(String(args.providerId))
        return result
          ? {
              key: result.key,
              qrContent: result.qrContent,
              imageDataUrl: result.imageDataUrl,
              expiresInSeconds: result.expiresInSeconds
            }
          : null
      }
      case 'online.qrStatus': {
        const result = await providers.checkQrLogin(
          String(args.providerId),
          String(args.key).slice(0, 4096)
        )
        return { code: result.code, message: result.message }
      }
      case 'online.logout':
        return providers.logout(String(args.providerId))
      case 'online.library': {
        const result = await providers.fetchUserLibrary(String(args.providerId))
        return [...(result.likedPlaylist ? [result.likedPlaylist] : []), ...result.playlists].map(
          (p) => ({ id: p.id, name: p.name, trackCount: p.trackCount })
        )
      }
      case 'online.playlist': {
        const result = await providers.fetchPlaylistTracksPage(
          String(args.providerId),
          String(args.id),
          bounded(args.offset ?? 0, 0, 100000),
          100
        )
        return {
          total: result.total,
          nextOffset: result.nextOffset,
          hasMore: result.hasMore,
          items: rememberTracks(result.tracks)
        }
      }
      case 'online.recommendations':
        return rememberTracks(
          await providers.callProvider<Track[]>(String(args.providerId), 'fetchRecommendSongs')
        )
      case 'online.cloud': {
        const result = await providers.callProvider<{
          items: Array<{ track: Track; cloudSongId: string; fileName: string }>
          total: number
        }>(String(args.providerId), 'fetchCloudSongsPage', [
          bounded(args.offset ?? 0, 0, 100000),
          100
        ])
        return {
          total: result.total,
          items: result.items.map((item) => ({
            ...rememberTracks([item.track])[0],
            cloudSongId: item.cloudSongId
          }))
        }
      }
      case 'downloads.list': {
        const state = await core.query('downloads.state', {})
        const tasks: Array<{ id: string; title: string; artist: string; status: string; progress: number; error: string | null }> = []
        for (let offset = 0; offset < state.total; offset += 200) {
          const page = await core.query('downloads.page', { revision: state.revision, offset, limit: 200 })
          tasks.push(...page.items.map(t => ({ id: t.id, title: t.track.title, artist: t.track.artist, status: t.status, progress: t.progress, error: t.error })))
        }
        return tasks
      }
      case 'downloads.create': {
        assertExperienceMethod('online.providers', experience.permissions)
        const track = await resolveTrack(args.id)
        const quality = String(args.quality ?? 'lossless')
        if (!['aac', 'lossless', 'hi-res'].includes(quality)) throw new Error('Invalid quality')
        const task = await core.command('downloads.create', {
          providerId: String(args.providerId),
          track: { id: track.id, title: track.title, artist: track.artist, album: track.album, cover: track.cover ?? undefined },
          quality: quality as 'aac' | 'lossless' | 'hi-res'
        }) as { id: string }
        return { id: task.id }
      }
      case 'downloads.cancel':
        return core.command('downloads.cancel', { id: String(args.id) })
      case 'downloads.retry':
        await core.command('downloads.retry', { id: String(args.id) })
        return null
      case 'music.metadata.operate': {
        if (!EXPERIENCE_MUSIC_OPERATIONS.includes(args.operation as ExperienceMusicOperation))
          throw new Error('Invalid metadata operation')
        if (args.operation !== 'status' && args.operation !== 'cancel' && music.isScanning.value)
          throw new Error('曲库正在扫描，请完成后重试资料操作')
        return core.command('extensions.music', {
          id: experience.pluginId,
          operation: args.operation as ExperienceMusicOperation,
          args: (args.body ?? {}) as Record<string, unknown>
        })
      }
      case 'host.capabilities':
        return {
          bridgeVersion: experience.bridgeVersion,
          methods: Object.keys(EXPERIENCE_METHOD_PERMISSIONS).filter((method) =>
            experience.permissions.includes(EXPERIENCE_METHOD_PERMISSIONS[method])
          )
        }
      case 'files.export':
        return core.command('extensions.export', { id: experience.pluginId, name: String(args.name), content: String(args.content) })
      case 'music.metadata.read':
        return core.query('extensions.document', { id: experience.pluginId })
      case 'music.metadata.write':
        return core.command('extensions.document.edit', { id: experience.pluginId, update: { revision: bounded(args.revision, 0, Number.MAX_SAFE_INTEGER), value: plain(args.value) as Record<string, unknown> } })
      case 'music.scan': {
        if (Array.isArray(args.roots)) {
          if (
            args.roots.length > 100 ||
            args.roots.some((p) => typeof p !== 'string' || p.length > 4096)
          )
            throw new Error('Invalid library folders')
          // Removing a root does not erase songs or playlists. The host scan owns reconciliation.
          const roots = [...new Set(args.roots as string[])]
          await settings.updateSettings({ libraryFolders: roots })
        }
        await music.startFullLibraryScan()
        return null
      }
      case 'music.library': {
        const libraryRevision = core.state.value?.libraryRevision
        if (args.revision === libraryRevision) return { unchanged: true, revision: libraryRevision }
        const offset = Math.floor(bounded(args.offset ?? 0, 0, 10000000))
        const limit = Math.floor(bounded(args.limit ?? 100, 1, 100))
        const page = await sqliteLibrary.detailedPage(offset, limit, libraryRevision ?? undefined)
        const albums = page.albums.map(rememberDatabaseAlbum)
        const genres = await sqliteLibrary.allGenres(page.revision)
        return {
          version: 1,
          revision: page.revision,
          albums: albums.map(album => ({
            ...albumDto(album, true),
            discCount: Math.max(1, ...(album.tracks ?? []).map(track => track.discNumber ?? 1))
          })),
          total: page.total,
          genres: genres.map(name => ({ id: name, name })),
          roots: music.scannedFolders.value.map(path => ({ path, status: 'online' })),
          scan: { running: music.isScanning.value, error: music.libraryScanStatus.value.error || undefined },
          onlineEnabled: false
        }
      }
      case 'library.list': {
        const offset = Math.floor(bounded(args.offset ?? 0, 0, 10000000))
        const limit = Math.floor(bounded(args.limit ?? 200, 1, 500))
        const page = await sqliteLibrary.albumPage(offset, limit)
        return { albums: page.albums.map(album => albumDto(rememberDatabaseAlbum(album))), total: page.total }
      }
      case 'library.album': {
        const result = await sqliteLibrary.detailedAlbum(args.id)
        if (!result) throw new Error('Album no longer available')
        return albumDto(rememberDatabaseAlbum(result.album), true)
      }
      case 'library.search': {
        const query = String(args.query ?? '').slice(0, 200)
        const result = await sqliteLibrary.search(query)
        return { albums: result.albums.map(album => albumDto(rememberDatabaseAlbum(album))), tracks: result.tracks.map(track => trackDto(track)) }
      }
      case 'library.playlists': {
        const revision = core.state.value?.playlistsRevision
        if (revision == null) throw new Error('Core 歌单尚未就绪')
        const playlists: Array<{ id: string; name: string; tracks: Array<ReturnType<typeof trackDto>>; isDefault?: boolean }> = []
        for (const playlist of music.localPlaylists.value) {
          const tracks = await readExperiencePlaylistTrackDtos(core, playlist.id, revision, sqliteLibrary, trackDto)
          playlists.push({ id: playlist.id, name: playlist.name, tracks, isDefault: playlist.isDefault })
        }
        return playlists
      }
      case 'library.favorite': {
        const track = await resolveTrack(args.id)
        const [liked] = await music.getFavoriteTrackStates([track])
        await music.setFavoriteTracks([track], !liked)
        await music.getFavoriteTrackStates([track])
        return { ...trackDto(track), favorite: !liked }
      }
      case 'library.createPlaylist':
        return music.createPlaylist(String(args.name ?? ''))
      case 'library.addToPlaylist': {
        const p = music.localPlaylists.value.find((p) => p.id === args.playlistId)
        if (!p) throw new Error('Playlist unavailable')
        const track = await resolveTrack(args.id)
        await music.addToPlaylist(p.name, track.id, track)
        return null
      }
      case 'library.removeFromPlaylist': {
        const p = music.localPlaylists.value.find((p) => p.id === args.playlistId)
        if (!p) throw new Error('Playlist unavailable')
        await music.removeFromPlaylist(p.name, String(args.id))
        return null
      }
      case 'library.deletePlaylist':
        await music.deletePlaylist(String(args.id))
        return null
      case 'library.scan':
        return music.startFullLibraryScan()
      case 'player.state':
        return state()
      case 'player.sleep':
        if (args.mode === null) await player.cancelSleepTimer()
        else {
          if (!['minutes', 'trackEnd', 'queueEnd'].includes(String(args.mode)))
            throw new Error('无效的定时模式')
          await player.configureSleepTimer(
            args.mode as 'minutes' | 'trackEnd' | 'queueEnd',
            bounded(args.minutes ?? 30, 1, 720)
          )
        }
        return state()
      case 'player.rate':
        await player.setPlaybackRate(bounded(args.value, 0.5, 2))
        return state()
      case 'player.queue': {
        const queue = player.libraryQueueSnapshot.value
        if (!queue) return []
        if (queue.total > 10000) throw new Error('体验界面仅支持读取最多 10,000 首的队列')
        const tracks: ReturnType<typeof trackDto>[] = []
        for (let offset = 0; offset < queue.total; offset += 200) {
          const page = await core.query('queue.page', { id: queue.id, revision: queue.revision, offset, limit: 200 })
          for (const item of page.items) {
            if (!item.track) throw new Error('队列曲目已不可用，请刷新后重试')
            tracks.push(trackDto({ ...item.track, queueEntryId: item.queueEntryId }))
          }
        }
        return tracks
      }
      case 'player.lyrics':
        return {
          id: player.currentTrack.value?.id,
          lyrics: player.currentTrack.value?.lyrics ?? '',
          translatedLyrics: player.currentTrack.value?.translatedLyrics ?? ''
        }
      case 'player.play': {
        const selected = await resolveTrack(args.id)
        const ids = Array.isArray(args.ids) ? args.ids.slice(0, 10000) : undefined
        if (ids) {
          if (ids.some(id => typeof id !== 'string')) throw new Error('Invalid queue')
          await player.playTrack(selected, await resolveTracks(ids as string[]))
        } else if (args.albumId !== undefined) {
          const databaseAlbumId = sqliteLibrary.databaseId(args.albumId)
          if (!databaseAlbumId) throw new Error('Album no longer available')
          await player.playLibraryQuery({ albumId: databaseAlbumId, sort: 'trackNumber' }, selected.id)
        } else await player.playTrack(selected)
        return state()
      }
      case 'player.toggle':
        await player.togglePlay()
        return state()
      case 'player.pause':
        if (player.isPlaying.value) await player.togglePlay()
        return state()
      case 'player.stop':
        await player.stopPlayback()
        return state()
      case 'player.next':
        await player.next()
        return null
      case 'player.previous':
        await player.prev()
        return null
      case 'player.seek':
        await player.seek(bounded(args.value, 0, Math.max(0, player.duration.value)))
        return null
      case 'player.volume':
        await player.setVolume(bounded(args.value, 0, 1))
        return null
      case 'player.mode':
        if (args.value === undefined) await player.cyclePlayMode()
        else if (['sequential', 'listLoop', 'repeat', 'shuffle'].includes(String(args.value)))
          await player.setPlayMode(args.value as 'sequential' | 'listLoop' | 'repeat' | 'shuffle')
        else throw new Error('Invalid play mode')
        return null
      case 'player.transition': {
        if (!['gapless', 'fade-in-out'].includes(String(args.mode)))
          throw new Error('当前宿主支持无缝播放和交叉淡化')
        await player.setAudioProcessing({
          gapless: true,
          crossfadeSeconds:
            args.mode === 'gapless' ? 0 : Math.max(2, player.audioProcessing.value.crossfadeSeconds)
        })
        return state()
      }
      case 'player.setQueue': {
        if (!Array.isArray(args.ids) || args.ids.length > 10000) throw new Error('Invalid queue')
        if (args.ids.some((id) => typeof id !== 'string')) throw new Error('Invalid queue')
        const tracks = await resolveTracks(args.ids as string[])
        await player.replaceQueue(tracks)
        return null
      }
      case 'player.reorderQueue': {
        const from = Math.floor(bounded(args.from, 0, player.queueCount.value - 1))
        const to = Math.floor(bounded(args.to, 0, player.queueCount.value - 1))
        await player.reorderQueue(from, to)
        return null
      }
      case 'player.playQueue': {
        const queue = player.libraryQueueSnapshot.value
        if (!queue || typeof args.entryId !== 'string') throw new Error('Queue entry unavailable')
        await player.playLibraryQueueEntry(args.entryId, queue)
        return state()
      }
      case 'player.removeQueue': {
        const queue = player.libraryQueueSnapshot.value
        if (!queue) throw new Error('Queue entry unavailable')
        if (typeof args.entryId === 'string')
          await player.editLibraryQueue({ kind: 'remove', entryIds: [args.entryId] }, queue)
        else await player.removeQueueItem(Math.floor(bounded(args.index, 0, player.queueCount.value - 1)))
        return null
      }
      case 'player.clearQueue':
        await player.clearQueue()
        return null
      case 'preferences.read':
        return core.query('extensions.preferences', { id: experience.pluginId })
      case 'preferences.write':
        return core.command('extensions.preferences.edit', { id: experience.pluginId, value: plain(args.value) as Record<string, unknown> })
      case 'settings.read':
        return plain({
          settings: settings.settings.value,
          defaults: settings.defaults.value,
          appVersion: settings.appVersion.value
        })
      case 'settings.update': {
        if (!args.patch || typeof args.patch !== 'object' || Array.isArray(args.patch))
          throw new Error('Invalid settings patch')
        return settings.updateSettings(plain(args.patch))
      }
      case 'audio.read':
        return plain({
          processing: player.audioProcessing.value,
          output: player.audioOutput.value,
          device: player.audioDevice.value,
          outputs: player.audioOutputOptions.value,
          devices: player.audioDeviceOptions.value
        })
      case 'dsp.read': {
        const [state, status] = await Promise.all([
          core.query('audio.dsp', {}).then(value => value.scenes),
          core.query('audio.dsp.status', {})
        ])
        return { state, status, catalog: nodeCatalog, templates: DSP_FACTORY_SCENE_TEMPLATES }
      }
      case 'dsp.create': {
        if (!DSP_FACTORY_SCENE_TEMPLATES.some((t) => t.id === args.template))
          throw new Error('Unknown scene template')
        const dsp = await core.query('audio.dsp', {})
        const state = plain(dsp.scenes)
        const scene = createDspFactoryScene(
          args.template as DspFactorySceneTemplateId,
          crypto.randomUUID()
        )
        if (typeof args.name === 'string' && args.name.trim())
          scene.name = args.name.trim().slice(0, 120)
        await core.command('audio.dsp.edit', { revision: dsp.revision, edit: { kind: 'scenes', scenes: [...state.scenes, scene], pinnedSceneId: state.pinnedSceneId } })
        return (await core.query('audio.dsp', {})).scenes
      }
      case 'dsp.apply': {
        const dsp = await core.query('audio.dsp', {})
        await core.command('audio.dsp.edit', { revision: dsp.revision, edit: { kind: 'apply', id: args.id === null ? null : String(args.id), confirmDsdPcmFallback: args.confirmDsdPcmFallback === true } })
        return (await core.query('audio.dsp', {})).scenes
      }
      case 'dsp.node': {
        const dsp = await core.query('audio.dsp', {})
        const state = plain(dsp.scenes)
        const scene = state.scenes.find((s) => s.id === args.sceneId)
        if (!scene) throw new Error('DSP scene unavailable')
        const index = scene.graph.nodes.findIndex((n) => n.id === args.nodeId)
        if (args.action === 'add') {
          const template = nodeCatalog.find((n) => n.type === args.type)
          if (!template || ['nativePlugin', 'vst3Plugin'].includes(template.type))
            throw new Error('Unsupported node type')
          if (
            singletonNodeTypes.has(template.type) &&
            scene.graph.nodes.some((n) => n.type === template.type)
          )
            throw new Error('该模块已存在')
          const node = {
            id: crypto.randomUUID(),
            type: template.type,
            enabled: true,
            params: plain(template.params)
          }
          normalizeNodeEditorParams(node)
          scene.graph.nodes.push(node)
        } else {
          if (index < 0) throw new Error('DSP node unavailable')
          const node = scene.graph.nodes[index]
          if (args.action === 'remove') scene.graph.nodes.splice(index, 1)
          else if (args.action === 'move') {
            const to = Math.floor(bounded(args.to, 0, scene.graph.nodes.length - 1))
            scene.graph.nodes.splice(index, 1)
            scene.graph.nodes.splice(to, 0, node)
          } else if (args.action === 'update') {
            if (typeof args.enabled === 'boolean') node.enabled = args.enabled
            if (args.params && typeof args.params === 'object' && !Array.isArray(args.params))
              node.params = { ...node.params, ...plain(args.params) }
            normalizeNodeEditorParams(node)
          } else throw new Error('Invalid DSP operation')
        }
        await core.command('audio.dsp.edit', { revision: dsp.revision, edit: { kind: 'scenes', scenes: state.scenes, pinnedSceneId: state.pinnedSceneId } })
        return (await core.query('audio.dsp', {})).scenes
      }
      case 'dsp.import':
        await core.command('audio.dsp.import', { revision: (await core.query('audio.dsp', {})).revision, kind: 'profile' })
        return null
      case 'dsp.export':
        await core.command('audio.dsp.export', { revision: (await core.query('audio.dsp', {})).revision, name: String(args.name ?? 'Rhine Music') })
        return null
      case 'audio.processing': {
        if (!args.patch || typeof args.patch !== 'object' || Array.isArray(args.patch))
          throw new Error('Invalid processing patch')
        await player.setAudioProcessing(plain(args.patch))
        return null
      }
      case 'audio.output': {
        if (typeof args.output === 'string')
          await player.setAudioOutput(args.output as Parameters<typeof player.setAudioOutput>[0])
        if (typeof args.device === 'string') await player.setAudioDevice(args.device)
        return null
      }
      case 'plugins.list':
        return (await corePlugins.list()).map((p) => ({
          id: p.id,
          name: p.name,
          version: p.version,
          description: p.description,
          enabled: p.enabled,
          error: p.error,
          builtIn: p.builtIn,
          permissions: p.permissions,
          status: p.status
        }))
      case 'plugins.enable':
        await corePlugins.enable(String(args.id))
        return null
      case 'plugins.disable':
        await corePlugins.disable(String(args.id))
        return null
      case 'plugins.install':
        await corePlugins.chooseAndInstall('package')
        return null
      case 'plugins.uninstall':
        await corePlugins.uninstall(String(args.id))
        return null
      case 'plugin.request': {
        if (args.request === undefined || args.request === null || typeof args.request !== 'object' || Array.isArray(args.request))
          throw new Error('Invalid plugin request')
        return core.command('extensions.pluginRequest', {
          id: experience.pluginId,
          request: args.request
        })
      }
      case 'host.panel':
        if (args.name === 'plugins') assertExperienceMethod('plugins.list', experience.permissions)
        openPanel(String(args.name))
        return null
      case 'host.environment':
        return {
          reducedMotion: ['reduced', 'off'].includes(
            document.documentElement.dataset.teMotion ?? ''
          )
        }
      case 'host.exit':
        exit()
        return null
      case 'host.openLink': {
        const url = new URL(String(args.url))
        if (url.protocol !== 'https:' || url.username || url.password)
          throw new Error('Only HTTPS reference links are supported')
        await window.api.shell.openExternal(url.href)
        return null
      }
      case 'window.mini':
      case 'window.tray':
      case 'window.lyrics': {
        const theme =
          experience.pluginId === 'com.twilightecho.experience.rhine-lab'
            ? document.querySelector('.experience-window')?.getAttribute('data-tone') === 'night'
              ? 'rhine-night'
              : 'rhine'
            : 'default'
        if (method === 'window.mini') return window.api.miniPlayer.open({ theme })
        if (method === 'window.tray') return window.api.window.showTrayPlayer({ theme })
        return window.api.desktopLyrics.setEnabled(true, { theme })
      }
      case 'host.fullscreen':
        if (document.fullscreenElement) await document.exitFullscreen()
        else await document.documentElement.requestFullscreen()
        return null
    }
    throw new Error('Unsupported operation')
  }
  port.onmessage = async ({ data }) => {
    if (disposed || !data || !Number.isSafeInteger(data.id) || typeof data.method !== 'string')
      return
    if (inFlight >= 16) {
      port.postMessage({ id: data.id, error: 'Too many requests' })
      return
    }
    inFlight++
    try {
      if (
        new TextEncoder().encode(JSON.stringify(data)).byteLength >
        experienceRequestLimit(data.method)
      )
        throw new Error('Request too large')
      const value = await invoke(
        data.method,
        data.args && typeof data.args === 'object' ? data.args : {}
      )
      if (!disposed)
        port.postMessage({ id: data.id, value: value === undefined ? null : plain(value) })
    } catch (error) {
      if (!disposed)
        port.postMessage({
          id: data.id,
          error: error instanceof Error ? error.message : String(error)
        })
    } finally {
      inFlight--
    }
  }
  port.start()
  // Live events pushed by the plugin's own background code (utility process)
  // arrive as core 'plugin-experience' messages and are forwarded to the iframe.
  const unsubscribePluginEvents = core.subscribe((message) => {
    if (disposed || message.kind !== 'plugin-experience' || message.pluginId !== experience.pluginId)
      return
    send('plugin', { event: message.event, value: message.value })
  })
  if (experience.permissions.includes('player:observe')) {
    stops.push(
      watch(
        [
          player.currentTrack,
          player.isPlaying,
          player.isLoading,
          player.volume,
          player.duration,
          player.queueIndex
        ],
        () => send('player', state())
      )
    )
    stops.push(watch(() => [player.libraryQueueSnapshot.value?.id, player.libraryQueueSnapshot.value?.revision], () => send('queue', null)))
    stops.push(
      watch(
        () => player.currentTrack.value?.lyrics,
        () => send('lyrics', null)
      )
    )
  }
  if (experience.permissions.includes('library:read'))
    stops.push(watch(
      () => [
        core.state.value?.epoch,
        core.state.value?.libraryRevision,
        core.state.value?.playlistsRevision,
        core.state.value?.scan?.jobId,
        core.state.value?.scan?.state,
        core.state.value?.scan?.phase,
        core.state.value?.scan?.checkedFiles,
        core.state.value?.scan?.parsedFiles,
        core.state.value?.scan?.error
      ],
      () => send('library', null)
    ))
  const timer = setInterval(() => {
    if (!document.hidden && experience.permissions.includes('player:observe'))
      send('player', state())
  }, 250)
  send('player', experience.permissions.includes('player:observe') ? state() : null)
  return () => {
    disposed = true
    clearInterval(timer)
    unsubscribePluginEvents()
    stops.forEach((stop) => stop())
    port.close()
  }
}
