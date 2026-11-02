import { ref, shallowRef } from 'vue'
import type { NcmCloudSelectedFile, NcmCloudTransferProgress } from '../../../shared/ncmCloud.ts'
import type { NcmCloudUploadResult, NcmCloudDownloadResult } from '../../../shared/ncmCloud.ts'
import { useCoreConnection } from './coreConnection.ts'
import { createCoreCloudTransfers } from './coreCloudTransfers.ts'
import type { Track } from '../types/music'
import { syncPluginProviders, useMediaProviders } from '@renderer/providers'

export interface NcmProfile {
  userId: number
  nickname: string
  avatarUrl: string
  avatarUrlSource?: string | null
  signature: string
  follows: number
  followeds: number
}

export interface NcmPlaylistSummary {
  id: number
  name: string
  cover: string | null
  /** Durable remote origin when `cover` is a session-scoped twilight-media grant. */
  coverSource?: string | null
  coverSmall?: string | null
  coverSmallSource?: string | null
  trackCount: number
  creatorName?: string
  /** True when the signed-in user owns (created) the playlist. */
  owned?: boolean
  /** Play count surfaced by discovery endpoints (top/highquality playlists). */
  playCount?: number
}

export interface NcmPlaylistCategoryTag {
  name: string
  hot: boolean
}

export interface NcmPlaylistCategoryGroup {
  id: number
  name: string
  tags: NcmPlaylistCategoryTag[]
}

export interface NcmPlaylistCatalogue {
  hotTags: string[]
  groups: NcmPlaylistCategoryGroup[]
}

export interface NcmDiscoveryPlaylistPage {
  items: NcmPlaylistSummary[]
  total: number
  hasMore: boolean
  offset: number
  limit: number
}

export interface NcmHighQualityPlaylistPage {
  items: NcmPlaylistSummary[]
  total: number
  hasMore: boolean
  lasttime: number
}

export interface NcmAlbumSummary {
  id: number
  name: string
  cover: string | null
  coverSource?: string | null
  coverSmall?: string | null
  coverSmallSource?: string | null
  trackCount: number
  publishTime?: number
  releaseType?: string
  isExplicit?: boolean
}

export interface NcmArtistSummary {
  id: number
  name: string
  picUrl: string | null
  picUrlSource?: string | null
  picUrlSmall?: string | null
  picUrlSmallSource?: string | null
  albumSize: number
  musicSize: number
}

export interface NcmUserSummary {
  id: number
  name: string
  picUrl: string | null
  picUrlSource?: string | null
  picUrlSmall?: string | null
  picUrlSmallSource?: string | null
  musicSize: number
  userType: number
  artistId?: number
  followed?: boolean
}

export interface NcmLoginState {
  loggedIn: boolean
  profile: NcmProfile | null
}

export interface NcmLikedTracksPage {
  tracks: Track[]
  total: number
  offset: number
  limit: number
  nextOffset: number
  hasMore: boolean
}

export interface NcmCloudSong {
  cloudSongId: string | number
  songId: string | number
  fileName: string
  addTime?: number
  track: Track
}

export interface NcmCloudSongsPage {
  items: NcmCloudSong[]
  total: number
  offset: number
  limit: number
  nextOffset: number
  hasMore: boolean
}

export interface NcmCloudTransferTask extends NcmCloudTransferProgress {}

export type NcmStore = ReturnType<typeof useNcmStore>

const NCM_PROVIDER_ID = 'ncm'

const providerAvailable = ref(true)
const providerError = ref('')
const isLoggedIn = ref(false)
const profile = ref<NcmProfile | null>(null)
const libraryLoading = ref(false)
const libraryLoaded = ref(false)
const libraryError = ref('')
const likedPlaylist = ref<NcmPlaylistSummary | null>(null)
const userPlaylists = shallowRef<NcmPlaylistSummary[]>([])
const likedSongIds = shallowRef<Set<number>>(new Set())
const cloudSongs = shallowRef<NcmCloudSong[]>([])
const cloudTotal = ref(0)
const cloudNextOffset = ref(0)
const cloudHasMore = ref(false)
const cloudLoading = ref(false)
const cloudLoadingMore = ref(false)
const cloudError = ref('')
const cloudSelectedFiles = ref<NcmCloudSelectedFile[]>([])
let cloudProjection: ReturnType<typeof createCoreCloudTransfers> | null = null
let cloudStateRevision = 0
let accountRevision = 0
let loginRequestRevision = 0
let libraryRequestRevision = 0

export function captureNcmSession(): () => boolean {
  const revision = accountRevision
  const userId = profile.value?.userId
  const registry = useMediaProviders()
  const generation = registry.getGeneration(NCM_PROVIDER_ID)
  return () =>
    revision === accountRevision &&
    userId === profile.value?.userId &&
    generation === registry.getGeneration(NCM_PROVIDER_ID)
}
let cloudRefreshTimer: ReturnType<typeof setTimeout> | null = null

function scheduleCloudRefresh(): void {
  if (cloudRefreshTimer || !isLoggedIn.value) return
  const isCurrentSession = captureNcmSession()
  const revision = cloudStateRevision
  const userId = profile.value?.userId
  cloudRefreshTimer = setTimeout(() => {
    cloudRefreshTimer = null
    if (
      !isCurrentSession() ||
      !isLoggedIn.value ||
      cloudStateRevision !== revision ||
      profile.value?.userId !== userId
    )
      return
    void callNcmProvider<NcmCloudSongsPage>('fetchCloudSongsPage', [0, 50])
      .then((page) => {
        if (
          !isCurrentSession() ||
          !isLoggedIn.value ||
          cloudStateRevision !== revision ||
          profile.value?.userId !== userId
        )
          return
        cloudSongs.value = page.items
        cloudTotal.value = page.total
        cloudNextOffset.value = page.nextOffset
        cloudHasMore.value = page.hasMore
      })
      .catch(() => undefined)
  }, 150)
}

function ensureCloudProgressListener(): void {
  if (cloudProjection) return
  const core = useCoreConnection()
  cloudProjection = createCoreCloudTransfers({
    state: core.state,
    page: (revision, offset, signal) =>
      core.query('ncm.cloud.page', { revision, offset, limit: 200 }, signal),
    completed(progress) {
      if (progress.kind !== 'upload') return
      cloudSelectedFiles.value = cloudSelectedFiles.value.filter(
        (file) => file.handle !== progress.handle
      )
      scheduleCloudRefresh()
    },
    failed: (error) => {
      cloudError.value = error instanceof Error ? error.message : String(error)
    }
  })
}

function resetCloudState(): void {
  cloudStateRevision += 1
  if (cloudRefreshTimer) {
    clearTimeout(cloudRefreshTimer)
    cloudRefreshTimer = null
  }
  cloudSongs.value = []
  cloudTotal.value = 0
  cloudNextOffset.value = 0
  cloudHasMore.value = false
  cloudLoading.value = false
  cloudLoadingMore.value = false
  cloudError.value = ''
  cloudSelectedFiles.value = []
}

function resetLibraryState(): void {
  accountRevision += 1
  loginRequestRevision += 1
  libraryRequestRevision += 1
  libraryLoading.value = false
  libraryLoaded.value = false
  libraryError.value = ''
  likedPlaylist.value = null
  userPlaylists.value = []
  likedSongIds.value = new Set()
  resetCloudState()
}

function markProviderAvailable(): void {
  providerAvailable.value = true
  providerError.value = ''
}

function markProviderUnavailable(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  providerAvailable.value = false
  providerError.value = message || '网易云音乐插件未启用'
  isLoggedIn.value = false
  profile.value = null
  resetLibraryState()
}

async function callNcmProvider<T>(
  method: string,
  args: unknown[] = [],
  options?: { signal?: AbortSignal }
): Promise<T> {
  const isCurrent = captureNcmSession()
  try {
    const value = await useMediaProviders().call<T>(NCM_PROVIDER_ID, method, args, options)
    if (isCurrent()) markProviderAvailable()
    return value
  } catch (error) {
    if (
      isCurrent() &&
      error instanceof Error &&
      /Provider 未启用|provider is disabled|does not implement/i.test(error.message)
    ) {
      markProviderUnavailable(error)
    }
    throw error
  }
}

function syncLikedIds(tracks: Track[]): void {
  const ids = new Set<number>()
  for (const track of tracks) {
    if (track.ncmSongId != null) ids.add(track.ncmSongId)
  }
  likedSongIds.value = ids
}

function applyLoginState(state: NcmLoginState): boolean {
  if (!state.loggedIn || profile.value?.userId !== state.profile?.userId) resetLibraryState()
  isLoggedIn.value = state.loggedIn
  profile.value = state.profile
  return state.loggedIn
}

export function useNcmStore() {
  ensureCloudProgressListener()

  async function buildProfile(prof: {
    userId: number
    nickname: string
    avatarUrl: string
    avatarUrlSource?: string | null
    signature?: string
    follows?: number
    followeds?: number
  }): Promise<NcmProfile> {
    return {
      userId: prof.userId,
      nickname: prof.nickname,
      avatarUrl: prof.avatarUrl,
      avatarUrlSource: prof.avatarUrlSource ?? null,
      signature: prof.signature ?? '',
      follows: prof.follows ?? 0,
      followeds: prof.followeds ?? 0
    }
  }

  async function checkLogin(): Promise<boolean> {
    const request = ++loginRequestRevision
    try {
      await syncPluginProviders()
      if (request !== loginRequestRevision) return isLoggedIn.value
      const provider = useMediaProviders().get(NCM_PROVIDER_ID)
      if (provider && (!provider.isEnabled || (await provider.isEnabled()))) {
        if (request !== loginRequestRevision) return isLoggedIn.value
        markProviderAvailable()
      }
      const isCurrent = captureNcmSession()
      const state = await callNcmProvider<NcmLoginState>('checkLogin')
      if (request !== loginRequestRevision || !isCurrent()) return isLoggedIn.value
      return applyLoginState(state)
    } catch {
      if (request !== loginRequestRevision) return isLoggedIn.value
      isLoggedIn.value = false
      profile.value = null
      resetLibraryState()
      return false
    }
  }

  function setLogin(prof: NcmProfile): void {
    resetLibraryState()
    isLoggedIn.value = true
    profile.value = prof
    markProviderAvailable()
  }

  async function logout(): Promise<void> {
    isLoggedIn.value = false
    profile.value = null
    resetLibraryState()
    await callNcmProvider<void>('logout')
  }

  async function openOfficialLogin(): Promise<boolean> {
    const request = ++loginRequestRevision
    const isCurrent = captureNcmSession()
    const state = await callNcmProvider<NcmLoginState>('openOfficialLogin')
    if (request !== loginRequestRevision || !isCurrent()) return isLoggedIn.value
    return applyLoginState(state)
  }

  async function getQrKey(): Promise<string | null> {
    return callNcmProvider<string | null>('getQrKey')
  }

  async function getQrImage(key: string): Promise<string | null> {
    return callNcmProvider<string | null>('getQrImage', [key])
  }

  async function checkQrLogin(key: string): Promise<{ code: number }> {
    return callNcmProvider<{ code: number }>('checkQrLogin', [key])
  }

  async function fetchUserLibrary(force = false): Promise<{
    likedPlaylist: NcmPlaylistSummary | null
    playlists: NcmPlaylistSummary[]
  }> {
    const isCurrentSession = captureNcmSession()
    const request = ++libraryRequestRevision
    const isCurrent = (): boolean => isCurrentSession() && request === libraryRequestRevision
    libraryLoading.value = true
    libraryError.value = ''
    try {
      const library = await callNcmProvider<{
        likedPlaylist: NcmPlaylistSummary | null
        playlists: NcmPlaylistSummary[]
      }>('fetchUserLibrary', [force])
      if (!isCurrent()) return library
      likedPlaylist.value = library.likedPlaylist
      userPlaylists.value = library.playlists
      libraryLoaded.value = true
      return library
    } catch (error) {
      if (isCurrent())
        libraryError.value = error instanceof Error ? error.message : '加载网易云音乐库失败'
      throw error
    } finally {
      if (request === libraryRequestRevision) libraryLoading.value = false
    }
  }

  async function fetchPlaylistTracks(playlistId: number | string, force = false): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchPlaylistTracks', [playlistId, force])
  }

  async function fetchLikedTracks(force = false): Promise<Track[]> {
    const isCurrent = captureNcmSession()
    const tracks = await callNcmProvider<Track[]>('fetchLikedTracks', [force])
    if (isCurrent()) syncLikedIds(tracks)
    return tracks
  }

  async function fetchLikedTracksPage(
    offset = 0,
    limit = 100,
    force = false
  ): Promise<NcmLikedTracksPage> {
    const isCurrent = captureNcmSession()
    const page = await callNcmProvider<NcmLikedTracksPage>('fetchLikedTracksPage', [
      offset,
      limit,
      force
    ])
    if (isCurrent()) syncLikedIds(page.tracks)
    return page
  }

  async function fetchCloudSongsPage(
    offset = 0,
    limit = 50,
    append = false
  ): Promise<NcmCloudSongsPage> {
    if (!isLoggedIn.value) throw new Error('请先登录网易云音乐')
    const isCurrentSession = captureNcmSession()
    const revision = cloudStateRevision
    const userId = profile.value?.userId
    const isCurrentCloudSession = (): boolean =>
      isCurrentSession() &&
      isLoggedIn.value &&
      cloudStateRevision === revision &&
      profile.value?.userId === userId
    if (append) cloudLoadingMore.value = true
    else cloudLoading.value = true
    cloudError.value = ''
    try {
      const page = await callNcmProvider<NcmCloudSongsPage>('fetchCloudSongsPage', [offset, limit])
      if (!isCurrentCloudSession()) return page
      cloudSongs.value = append ? [...cloudSongs.value, ...page.items] : page.items
      cloudTotal.value = page.total
      cloudNextOffset.value = page.nextOffset
      cloudHasMore.value = page.hasMore
      return page
    } catch (error) {
      if (!isCurrentCloudSession()) throw error
      cloudError.value = error instanceof Error ? error.message : '加载网易云云盘失败'
      if (/请先登录|未登录|登录.*失效/i.test(cloudError.value)) {
        isLoggedIn.value = false
        profile.value = null
        resetLibraryState()
        cloudError.value = '登录状态已失效，请重新登录网易云音乐'
      }
      throw error
    } finally {
      if (isCurrentCloudSession()) {
        cloudLoading.value = false
        cloudLoadingMore.value = false
      }
    }
  }

  async function refreshCloudSongs(): Promise<NcmCloudSongsPage> {
    return fetchCloudSongsPage(0, 50, false)
  }

  async function loadMoreCloudSongs(): Promise<NcmCloudSongsPage | null> {
    if (!cloudHasMore.value || cloudLoading.value || cloudLoadingMore.value) return null
    return fetchCloudSongsPage(cloudNextOffset.value, 50, true)
  }

  async function chooseCloudUploadFiles(): Promise<NcmCloudSelectedFile[]> {
    if (!isLoggedIn.value) throw new Error('请先登录网易云音乐')
    const isCurrent = captureNcmSession()
    const files = (await useCoreConnection().command(
      'ncm.cloud.chooseUploadFiles',
      {}
    )) as NcmCloudSelectedFile[]
    if (!isCurrent()) return []
    const existing = new Set(cloudSelectedFiles.value.map((file) => file.handle))
    cloudSelectedFiles.value = [
      ...cloudSelectedFiles.value,
      ...files.filter((file) => !existing.has(file.handle))
    ]
    return files
  }

  async function uploadCloudFile(handle: string): Promise<string> {
    if (!isLoggedIn.value) throw new Error('请先登录网易云音乐')
    ensureCloudProgressListener()
    const result = (await useCoreConnection().command('ncm.cloud.upload', {
      handle
    })) as NcmCloudUploadResult
    return result.transferId
  }

  async function downloadCloudSong(song: NcmCloudSong): Promise<string | null> {
    if (!isLoggedIn.value) throw new Error('请先登录网易云音乐')
    ensureCloudProgressListener()
    const result = (await useCoreConnection().command('ncm.cloud.download', {
      cloudSongId: song.cloudSongId,
      fileName:
        song.fileName || song.track.fileName || `${song.track.title}.${song.track.format || 'mp3'}`
    })) as NcmCloudDownloadResult
    return result.accepted ? result.transferId : null
  }

  async function cancelCloudTransfer(transferId: string): Promise<boolean> {
    return useCoreConnection().command('ncm.cloud.cancel', { id: transferId }) as Promise<boolean>
  }

  function removeCloudSelectedFile(handle: string): void {
    const active = Object.values(cloudProjection!.tasks.value).some(
      (task) => task.handle === handle && !['completed', 'failed', 'cancelled'].includes(task.stage)
    )
    if (!active) {
      cloudSelectedFiles.value = cloudSelectedFiles.value.filter((file) => file.handle !== handle)
    }
  }

  async function getSongStreamUrl(songId: number, force = false): Promise<string | null> {
    return callNcmProvider<string | null>('getPlaybackUrl', [
      { id: `ncm:${songId}`, filePath: `ncm:${songId}`, source: 'ncm', ncmSongId: songId },
      { force }
    ])
  }

  async function fetchRecommendSongs(): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchRecommendSongs')
  }

  async function fetchRecommendPlaylists(): Promise<NcmPlaylistSummary[]> {
    return callNcmProvider<NcmPlaylistSummary[]>('fetchRecommendPlaylists')
  }

  async function fetchPlaylistCategories(): Promise<NcmPlaylistCatalogue> {
    return callNcmProvider<NcmPlaylistCatalogue>('fetchPlaylistCategories')
  }

  async function fetchDiscoveryPlaylists(
    cat = '全部',
    order: 'hot' | 'new' = 'hot',
    limit = 30,
    offset = 0
  ): Promise<NcmDiscoveryPlaylistPage> {
    return callNcmProvider<NcmDiscoveryPlaylistPage>('fetchDiscoveryPlaylists', [
      cat,
      order,
      limit,
      offset
    ])
  }

  async function fetchHighQualityPlaylists(
    cat = '全部',
    limit = 30,
    before = 0
  ): Promise<NcmHighQualityPlaylistPage> {
    return callNcmProvider<NcmHighQualityPlaylistPage>('fetchHighQualityPlaylists', [
      cat,
      limit,
      before
    ])
  }

  async function fetchPersonalFm(): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchPersonalFm')
  }

  async function fetchPrivateContent(): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchPrivateContent')
  }

  async function fetchLyric(songId: number): Promise<{
    lyrics: string | null
    translatedLyrics: string | null
  }> {
    return callNcmProvider<{ lyrics: string | null; translatedLyrics: string | null }>(
      'getLyrics',
      [{ id: `ncm:${songId}`, filePath: `ncm:${songId}`, source: 'ncm', ncmSongId: songId }]
    )
  }

  async function searchSongs(
    keywords: string,
    limit = 30,
    offset = 0,
    options?: { signal?: AbortSignal }
  ): Promise<{ tracks: Track[]; total: number }> {
    const result = await callNcmProvider<{ items: Track[]; total: number }>(
      'searchSongs',
      [keywords, limit, offset],
      options
    )
    return { tracks: result.items, total: result.total }
  }

  async function searchPlaylists(
    keywords: string,
    limit = 30,
    offset = 0,
    options?: { signal?: AbortSignal }
  ): Promise<{ playlists: NcmPlaylistSummary[]; total: number }> {
    const result = await callNcmProvider<{ items: NcmPlaylistSummary[]; total: number }>(
      'searchPlaylists',
      [keywords, limit, offset],
      options
    )
    return { playlists: result.items, total: result.total }
  }

  async function searchArtists(
    keywords: string,
    limit = 30,
    offset = 0,
    options?: { signal?: AbortSignal }
  ): Promise<{ artists: NcmArtistSummary[]; total: number }> {
    const result = await callNcmProvider<{ items: NcmArtistSummary[]; total: number }>(
      'searchArtists',
      [keywords, limit, offset],
      options
    )
    return { artists: result.items, total: result.total }
  }

  async function fetchArtistTopSongs(artistId: number): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchArtistTopSongs', [artistId])
  }

  async function fetchArtistAlbums(artistId: number): Promise<NcmAlbumSummary[]> {
    return callNcmProvider<NcmAlbumSummary[]>('fetchArtistAlbums', [artistId])
  }

  async function fetchArtistIntro(artistId: number): Promise<string> {
    return callNcmProvider<string>('fetchArtistIntro', [artistId])
  }

  async function fetchArtistFollowState(artistId: number): Promise<boolean | null> {
    return callNcmProvider<boolean | null>('fetchArtistFollowState', [artistId])
  }

  async function fetchAlbumTracks(albumId: number): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchAlbumTracks', [albumId])
  }

  async function fetchArtistPlaylists(artistId: number): Promise<NcmPlaylistSummary[]> {
    return callNcmProvider<NcmPlaylistSummary[]>('fetchArtistPlaylists', [artistId])
  }

  async function fetchUserPlaylistsByUid(
    uid: number,
    createdOnly = false
  ): Promise<NcmPlaylistSummary[]> {
    return callNcmProvider<NcmPlaylistSummary[]>('fetchUserPlaylistsByUid', [uid, createdOnly])
  }

  async function fetchUserFollows(uid: number, limit = 30, offset = 0): Promise<NcmUserSummary[]> {
    return callNcmProvider<NcmUserSummary[]>('fetchUserFollows', [uid, limit, offset])
  }

  async function fetchUserFolloweds(
    uid: number,
    limit = 30,
    offset = 0
  ): Promise<NcmUserSummary[]> {
    return callNcmProvider<NcmUserSummary[]>('fetchUserFolloweds', [uid, limit, offset])
  }

  async function likeTrack(songId: number, like: boolean): Promise<void> {
    const isCurrent = captureNcmSession()
    await callNcmProvider<void>('likeTrack', [songId, like])
    if (!isCurrent()) return
    if (like) {
      likedSongIds.value = new Set([...likedSongIds.value, songId])
    } else {
      const next = new Set(likedSongIds.value)
      next.delete(songId)
      likedSongIds.value = next
    }
  }

  function isTrackLiked(ncmSongId: number | undefined): boolean {
    return ncmSongId != null && likedSongIds.value.has(ncmSongId)
  }

  async function fetchPlayRecords(type = 0): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchPlayRecords', [type])
  }

  async function fetchRecentSongs(limit = 100): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchRecentSongs', [limit])
  }

  async function fetchIntelligenceList(options: {
    songId: number
    playlistId: number
    startSongId?: number
    count?: number
  }): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchIntelligenceList', [options])
  }

  async function followArtist(artistId: number, follow: boolean): Promise<void> {
    await callNcmProvider<void>('followArtist', [artistId, follow])
  }

  async function followUser(userId: number, follow: boolean): Promise<void> {
    await callNcmProvider<void>('followUser', [userId, follow])
  }

  async function createPlaylist(
    name: string,
    options?: { privacy?: 0 | 10 }
  ): Promise<NcmPlaylistSummary> {
    const isCurrent = captureNcmSession()
    const playlist = await callNcmProvider<NcmPlaylistSummary>('createPlaylist', [name, options])
    const summary: NcmPlaylistSummary = {
      id: Number(playlist.id),
      name: playlist.name || name,
      cover: playlist.cover ?? null,
      coverSource: playlist.coverSource ?? null,
      coverSmall: playlist.coverSmall ?? null,
      coverSmallSource: playlist.coverSmallSource ?? null,
      trackCount: typeof playlist.trackCount === 'number' ? playlist.trackCount : 0,
      creatorName: playlist.creatorName,
      owned: playlist.owned !== false
    }
    if (isCurrent()) {
      userPlaylists.value = [
        summary,
        ...userPlaylists.value.filter((item) => item.id !== summary.id)
      ]
      libraryLoaded.value = true
    }
    return summary
  }

  async function deletePlaylist(playlistId: number | string): Promise<void> {
    const isCurrent = captureNcmSession()
    await callNcmProvider<void>('deletePlaylist', [playlistId])
    if (!isCurrent()) return
    const id = String(playlistId)
    userPlaylists.value = userPlaylists.value.filter((item) => String(item.id) !== id)
  }

  async function addTracksToPlaylist(
    playlistId: number | string,
    trackIds: Array<number | string>
  ): Promise<void> {
    const isCurrent = captureNcmSession()
    await callNcmProvider<void>('addTracksToPlaylist', [playlistId, trackIds])
    if (!isCurrent()) return
    const id = String(playlistId)
    userPlaylists.value = userPlaylists.value.map((item) =>
      String(item.id) === id
        ? { ...item, trackCount: (item.trackCount ?? 0) + trackIds.length }
        : item
    )
  }

  async function removeTracksFromPlaylist(
    playlistId: number | string,
    trackIds: Array<number | string>
  ): Promise<void> {
    const isCurrent = captureNcmSession()
    await callNcmProvider<void>('removeTracksFromPlaylist', [playlistId, trackIds])
    if (!isCurrent()) return
    const id = String(playlistId)
    const removed = trackIds.length
    userPlaylists.value = userPlaylists.value.map((item) =>
      String(item.id) === id
        ? { ...item, trackCount: Math.max(0, (item.trackCount ?? 0) - removed) }
        : item
    )
  }

  return {
    providerAvailable,
    providerError,
    isLoggedIn,
    profile,
    libraryLoading,
    libraryLoaded,
    libraryError,
    likedPlaylist,
    userPlaylists,
    likedSongIds,
    cloudSongs,
    cloudTotal,
    cloudHasMore,
    cloudLoading,
    cloudLoadingMore,
    cloudError,
    cloudSelectedFiles,
    cloudTransferTasks: cloudProjection!.tasks,
    buildProfile,
    checkLogin,
    setLogin,
    logout,
    openOfficialLogin,
    getQrKey,
    getQrImage,
    checkQrLogin,
    fetchUserLibrary,
    fetchPlaylistTracks,
    fetchLikedTracks,
    fetchLikedTracksPage,
    fetchCloudSongsPage,
    refreshCloudSongs,
    loadMoreCloudSongs,
    chooseCloudUploadFiles,
    uploadCloudFile,
    downloadCloudSong,
    cancelCloudTransfer,
    removeCloudSelectedFile,
    getSongStreamUrl,
    fetchRecommendSongs,
    fetchRecommendPlaylists,
    fetchPlaylistCategories,
    fetchDiscoveryPlaylists,
    fetchHighQualityPlaylists,
    fetchPersonalFm,
    fetchPrivateContent,
    fetchLyric,
    searchSongs,
    searchPlaylists,
    searchArtists,
    fetchArtistTopSongs,
    fetchArtistAlbums,
    fetchArtistIntro,
    fetchArtistFollowState,
    fetchAlbumTracks,
    fetchArtistPlaylists,
    fetchUserPlaylistsByUid,
    fetchUserFollows,
    fetchUserFolloweds,
    fetchPlayRecords,
    fetchRecentSongs,
    fetchIntelligenceList,
    followArtist,
    followUser,
    likeTrack,
    isTrackLiked,
    syncLikedIds,
    createPlaylist,
    deletePlaylist,
    addTracksToPlaylist,
    removeTracksFromPlaylist
  }
}

if (import.meta.hot) import.meta.hot.dispose(() => cloudProjection?.dispose())
