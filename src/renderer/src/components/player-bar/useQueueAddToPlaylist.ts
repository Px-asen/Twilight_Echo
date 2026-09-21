import { computed, ref, shallowRef, type ComputedRef, type Ref } from 'vue'
import type { Track } from '../../types/music.ts'
import {
  getTrackProviderId,
  resolveProviderTrackId,
  type MediaProvider,
  type MediaProviderPlaylistSummary,
  type MediaProviderRegistry
} from '../../providers/mediaProvider.ts'
import { friendlyStreamingError } from '../streaming-page/friendlyStreamingError.ts'

const MAX_PLAYLIST_NAME_LENGTH = 80

/** Only the fields this picker reads; the music store's `Playlist` satisfies it. */
export interface QueuePlaylistTarget {
  id: string
  name: string
  trackIds: string[]
}

export interface QueueAddToPlaylistNotice {
  kind: 'success' | 'info'
  message: string
}

export interface QueueLocalPlaylistRow {
  id: string
  name: string
  trackCount: number
  /** The queue entry is already a member, so the row reports it instead of re-adding. */
  contains: boolean
}

export interface QueueAddToPlaylistOptions {
  queue: Ref<Track[]>
  playlists: Ref<QueuePlaylistTarget[]> | ComputedRef<QueuePlaylistTarget[]>
  mediaProviders: MediaProviderRegistry
  /** Returns how many entries the playlist actually gained (0 when already a member). */
  addTracksToPlaylist: (playlistName: string, tracks: Track[]) => number
  createPlaylistWithTracks: (name: string, tracks: Track[]) => string
  notify: (notice: QueueAddToPlaylistNotice) => void
  /** Registers plugin providers before the registry is read. */
  syncProviders?: () => Promise<void>
}

function normalizePlaylistName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_PLAYLIST_NAME_LENGTH)
}

/**
 * Backs the queue drawer's "add to playlist" picker. A queue entry can be a
 * streaming track, so the picker offers both the app's own playlists (persisted
 * with a track snapshot, therefore replayable without the library) and, when the
 * entry belongs to a signed-in provider that accepts library writes, that
 * provider's own playlists.
 */
export function useQueueAddToPlaylist(options: QueueAddToPlaylistOptions): {
  open: Ref<boolean>
  targetTrack: Ref<Track | null>
  targetLabel: ComputedRef<string>
  localPlaylists: ComputedRef<QueueLocalPlaylistRow[]>
  providerId: Ref<string | null>
  providerName: Ref<string>
  providerWritable: Ref<boolean>
  providerCanCreate: Ref<boolean>
  providerPlaylists: Ref<MediaProviderPlaylistSummary[]>
  providerLoading: Ref<boolean>
  providerError: Ref<string>
  errorMessage: Ref<string>
  busyTarget: Ref<string | null>
  createScope: Ref<'local' | 'provider' | null>
  newPlaylistName: Ref<string>
  canConfirmCreate: ComputedRef<boolean>
  openForEntry: (queueEntryId: string) => void
  openForTrack: (track: Track) => void
  close: () => void
  startCreate: (scope: 'local' | 'provider') => void
  cancelCreate: () => void
  reloadProviderPlaylists: () => Promise<void>
  addToLocalPlaylist: (name: string) => void
  confirmCreate: () => Promise<void>
  addToProviderPlaylist: (playlist: MediaProviderPlaylistSummary) => Promise<void>
} {
  const open = ref(false)
  // Shallow: the detached copy is only ever replaced, and playlist writes must
  // receive a plain object rather than a deep reactive proxy.
  const targetTrack = shallowRef<Track | null>(null)
  const errorMessage = ref('')
  const busyTarget = ref<string | null>(null)
  const createScope = ref<'local' | 'provider' | null>(null)
  const newPlaylistName = ref('')

  const providerId = ref<string | null>(null)
  const providerName = ref('')
  const providerWritable = ref(false)
  const providerCanCreate = ref(false)
  const providerPlaylists = ref<MediaProviderPlaylistSummary[]>([])
  const providerLoading = ref(false)
  const providerError = ref('')
  // Held outside a ref: provider methods cross the IPC bridge and must not be
  // invoked through a reactive proxy.
  let activeProvider: MediaProvider | null = null
  let providerRequestId = 0

  const targetLabel = computed(() => {
    const track = targetTrack.value
    if (!track) return ''
    return track.artist ? `${track.title} · ${track.artist}` : track.title
  })

  const localPlaylists = computed<QueueLocalPlaylistRow[]>(() => {
    const trackId = targetTrack.value?.id
    return options.playlists.value.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      trackCount: playlist.trackIds.length,
      contains: !!trackId && playlist.trackIds.includes(trackId)
    }))
  })

  const canConfirmCreate = computed(
    () => createScope.value !== null && normalizePlaylistName(newPlaylistName.value).length > 0
  )

  function resetState(): void {
    errorMessage.value = ''
    busyTarget.value = null
    createScope.value = null
    newPlaylistName.value = ''
    providerId.value = null
    providerName.value = ''
    providerWritable.value = false
    providerCanCreate.value = false
    providerPlaylists.value = []
    providerLoading.value = false
    providerError.value = ''
    activeProvider = null
  }

  /**
   * Resolves the entry from the queue at click time — virtual rows are recycled
   * while scrolling — then detaches a copy, so a queue mutation while the picker
   * is open cannot retarget the write.
   */
  function openForEntry(queueEntryId: string): void {
    const track = options.queue.value.find((item) => item.queueEntryId === queueEntryId)
    if (!track) return
    openForTrack(track)
  }

  function openForTrack(track: Track): void {
    ++providerRequestId
    resetState()
    targetTrack.value = { ...track }
    open.value = true
    void reloadProviderPlaylists()
  }

  function close(): void {
    ++providerRequestId
    open.value = false
    targetTrack.value = null
    resetState()
  }

  function startCreate(scope: 'local' | 'provider'): void {
    if (busyTarget.value) return
    createScope.value = scope
    newPlaylistName.value = ''
    errorMessage.value = ''
  }

  function cancelCreate(): void {
    if (busyTarget.value) return
    createScope.value = null
    newPlaylistName.value = ''
  }

  async function reloadProviderPlaylists(): Promise<void> {
    const requestId = ++providerRequestId
    const track = targetTrack.value
    providerPlaylists.value = []
    providerError.value = ''
    providerWritable.value = false
    providerCanCreate.value = false
    activeProvider = null

    const source = track ? getTrackProviderId(track) : null
    providerId.value = source === null || source === 'local' ? null : source
    providerName.value = ''
    if (!track || providerId.value === null) return

    providerLoading.value = true
    try {
      if (options.syncProviders) {
        await options.syncProviders()
        if (requestId !== providerRequestId) return
      }
      const provider = options.mediaProviders.get(providerId.value)
      // Sources without a registered provider (network shares, radio) have no
      // remote playlists at all: the section disappears instead of explaining
      // itself.
      if (!provider) {
        providerId.value = null
        return
      }
      providerName.value = provider.name || providerId.value
      if (!provider.addTracksToPlaylist || !provider.fetchUserLibrary) return

      activeProvider = provider
      providerWritable.value = true
      providerCanCreate.value = typeof provider.createPlaylist === 'function'
      const library = await provider.fetchUserLibrary(false)
      if (requestId !== providerRequestId) return
      providerPlaylists.value = library.playlists.filter((playlist) => playlist.owned === true)
    } catch (error) {
      if (requestId !== providerRequestId) return
      providerError.value = friendlyStreamingError(error, '读取云端歌单失败')
    } finally {
      if (requestId === providerRequestId) providerLoading.value = false
    }
  }

  function addToLocalPlaylist(name: string): void {
    const track = targetTrack.value
    if (!track || busyTarget.value) return
    errorMessage.value = ''
    const added = options.addTracksToPlaylist(name, [{ ...track }])
    options.notify(
      added > 0
        ? { kind: 'success', message: `已添加到歌单「${name}」` }
        : { kind: 'info', message: `「${track.title}」已在歌单「${name}」中` }
    )
    close()
  }

  function createLocalPlaylist(name: string, track: Track): void {
    options.createPlaylistWithTracks(name, [{ ...track }])
    options.notify({ kind: 'success', message: `已创建歌单「${name}」并添加` })
    close()
  }

  async function createProviderPlaylist(name: string, track: Track): Promise<void> {
    const provider = activeProvider
    const source = providerId.value
    if (!provider?.createPlaylist || !provider.addTracksToPlaylist || !source) return
    const remoteTrackId = resolveProviderTrackId(track, source)
    if (remoteTrackId == null) {
      errorMessage.value = '该曲目缺少可写入云端歌单的歌曲 ID'
      return
    }

    busyTarget.value = 'provider:create'
    errorMessage.value = ''
    let created: MediaProviderPlaylistSummary | null = null
    try {
      created = await provider.createPlaylist(name)
      await provider.addTracksToPlaylist(created.id, [remoteTrackId])
      options.notify({
        kind: 'success',
        message: `已创建${providerName.value}歌单「${created.name || name}」并添加`
      })
      close()
    } catch (error) {
      errorMessage.value = created
        ? friendlyStreamingError(error, `歌单「${name}」已创建，但添加歌曲失败`)
        : friendlyStreamingError(error, '创建歌单失败')
    } finally {
      busyTarget.value = null
    }
  }

  async function confirmCreate(): Promise<void> {
    const track = targetTrack.value
    const scope = createScope.value
    const name = normalizePlaylistName(newPlaylistName.value)
    if (!track || !scope || !name || busyTarget.value) return
    if (scope === 'local') {
      createLocalPlaylist(name, track)
      return
    }
    await createProviderPlaylist(name, track)
  }

  async function addToProviderPlaylist(playlist: MediaProviderPlaylistSummary): Promise<void> {
    const track = targetTrack.value
    const provider = activeProvider
    const source = providerId.value
    if (!track || !provider?.addTracksToPlaylist || !source || busyTarget.value) return
    const remoteTrackId = resolveProviderTrackId(track, source)
    if (remoteTrackId == null) {
      errorMessage.value = '该曲目缺少可写入云端歌单的歌曲 ID'
      return
    }

    busyTarget.value = `provider:${playlist.id}`
    errorMessage.value = ''
    try {
      await provider.addTracksToPlaylist(playlist.id, [remoteTrackId])
      options.notify({
        kind: 'success',
        message: `已添加到${providerName.value}歌单「${playlist.name}」`
      })
      close()
    } catch (error) {
      errorMessage.value = friendlyStreamingError(error, '添加到歌单失败')
    } finally {
      busyTarget.value = null
    }
  }

  return {
    open,
    targetTrack,
    targetLabel,
    localPlaylists,
    providerId,
    providerName,
    providerWritable,
    providerCanCreate,
    providerPlaylists,
    providerLoading,
    providerError,
    errorMessage,
    busyTarget,
    createScope,
    newPlaylistName,
    canConfirmCreate,
    openForEntry,
    openForTrack,
    close,
    startCreate,
    cancelCreate,
    reloadProviderPlaylists,
    addToLocalPlaylist,
    confirmCreate,
    addToProviderPlaylist
  }
}
