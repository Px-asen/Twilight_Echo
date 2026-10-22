<script setup lang="ts">
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import NativeDialogTransition from '@renderer/components/NativeDialogTransition.vue'
import { useHoldReorder } from '@renderer/composables/useHoldReorder'
import NativeContextMenu from '@renderer/components/NativeContextMenu.vue'
import { useLocalPlaylistOrder } from '@renderer/components/song-list/useLocalPlaylistOrder'
import TrackInfoDialog from '@renderer/components/TrackInfoDialog.vue'
import TrackSourcePicker from '@renderer/components/TrackSourcePicker.vue'
import PlaylistActionDialog from '@renderer/components/song-list/PlaylistActionDialog.vue'
import PlaylistLifecycleToolbar from '@renderer/components/song-list/PlaylistLifecycleToolbar.vue'
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  toRaw,
  watch
} from 'vue'
import type { LocalLibraryTagPatch } from '../../../shared/localLibraryTags.ts'
import { useUnifiedMusicSearch } from '../app/useUnifiedMusicSearch'
import { useLibraryUnifiedSearch } from '../app/useLibraryUnifiedSearch.ts'
import { syncPluginProviders, useMediaProviders } from '../providers'
import { useMusicStore } from '../stores/useMusicStore'
import { usePlayerStore } from '../stores/usePlayerStore'
import { useSettingsStore } from '../stores/useSettingsStore'
import { usePlaybackBookmarks } from '../stores/playbackBookmarks'
import { useProviderStore } from '../stores/useProviderStore'
import {
  buildLastPlayedByTrackId,
  getRecentTracks,
  libraryListeningProjection,
  useListeningStatsStore
} from '../stores/useListeningStatsStore'
import type { Track } from '../types/music'
import { copyTrackNamePages } from '../utils/copyTrackNames'
import { resolveUnifiedRecentTracks } from '../utils/unifiedRecentTracks'
import { getTrackSearchBlob, normalizeSearchText } from '../utils/localLibrarySearch'
import { getTrackSource as getLogicalTrackSource } from '../utils/logicalTrackModel'
import { useEscapeToClose } from '../app/useDismissLayer.ts'
import { useBackHandler } from '../app/useBackStack.ts'
import {
  buildMetadataMatchCandidates,
  enrichLocalTrackMetadata
} from '../utils/musicMetadataMatching'
import { searchMetadataTracks } from '../utils/musicMetadataSearch'
import {
  applyLibraryCollectionView,
  availableCollectionGenres,
  availableCollectionLetters,
  AZ_INDEX_LETTERS,
  collectionIndexLetter,
  collectionLetterAtScroll,
  firstCollectionIndexForLetter,
  LibraryCollectionViewPreferences,
  resolveLibraryArtistTracks,
  type LibraryCollectionSort,
  type LibraryCollectionViewState
} from '../utils/libraryCollectionView.ts'
import {
  formatPlaylistSourceSummary,
  summarizePlaylistSources
} from '../utils/playlistSourceSummary'
import {
  selectLocalLibraryActionTracks,
  notifyLocalTracksUnavailable,
  prepareLocalTracksForRemoval
} from '../utils/localTrackRemovalPolicy'
import {
  applyLibraryView,
  createDefaultLibraryViewState,
  libraryViewKey,
  LibraryViewPreferences,
  trackFolder,
  type LibrarySortDirection,
  type LibrarySortKey,
  type LibraryViewFilters,
  type LibraryViewState
} from '../utils/libraryViewPreferences.ts'
import CoverImg from './CoverImg.vue'
import AlbumCard from './song-list/AlbumCard.vue'
import AlbumDetailHeader from './song-list/AlbumDetailHeader.vue'
import CreateAggregatePlaylistDialog from './aggregate-playlist/CreateAggregatePlaylistDialog.vue'
import LocalLibraryTagManager from './LocalLibraryTagManager.vue'
const LibraryInboxDialog = defineAsyncComponent(
  () => import('@renderer/components/library-inbox/LibraryInboxDialog.vue')
)
import ThemeIcon from './ThemeIcon.vue'
import { formatDuration } from './song-list/formatDuration'
import type { GridItem } from './song-list/types'
import { useSongListContextMenu } from './song-list/useSongListContextMenu'
import { useSongListGridRendering } from './song-list/useSongListGridRendering'
import { usePlaylistLifecycleActions } from './song-list/usePlaylistLifecycleActions.ts'
import { useSongListSearch } from './song-list/useSongListSearch'
import { useSongListVirtualScroll } from './song-list/useSongListVirtualScroll'
import { useLocatePlayingTrack } from './song-list/useLocatePlayingTrack'
import { useTrackMultiSelect } from './song-list/useTrackMultiSelect'
import {
  createSongListActionSource,
  readSongListTagTargets,
  readSongListLoudnessTargets,
  type SongListActionLease,
  type SongListActionSource
} from './song-list/songListActionSource.ts'
import { buildLibraryLoudnessDatabasePlan } from './library-loudness/libraryLoudnessDatabasePlan.ts'
import { addSelectionRange } from '../../../shared/librarySelectionRanges.ts'
import type { LibrarySelectionRange } from '../../../shared/librarySelection.ts'
import { trackRowKeyAction } from './song-list/trackRowKeyboard'
import {
  type LibraryCollectionKind,
  type LibraryTrackRecord
} from '../../../shared/libraryDatabase.ts'
import { createLibraryStorageState } from '../stores/library/libraryStorageState.ts'
import { libraryDirectoriesForFiles } from '../utils/libraryScanDirectories.ts'
import { createLibraryTrackWindow } from '../stores/library/libraryTrackWindow.ts'
import { toPlaylistTrackSnapshot } from '../stores/library/musicStoreData.ts'
import { createLibraryPlaylistView } from '../stores/library/libraryPlaylistView.ts'
import { createLibraryCollectionPages } from '../stores/library/libraryCollectionPages.ts'
import { createLibraryCollectionWindow } from '../stores/library/libraryCollectionWindow.ts'
import { getMusicVersions, musicVersionRevision } from '../stores/musicVersions.ts'
import { libraryTrackQuery, libraryDetailScope } from '../utils/libraryTrackQuery.ts'
import { libraryTrack } from '../utils/libraryQueuePlayback.ts'
import {
  findExactProviderTrackCover,
  type ProviderTrackCover
} from '../utils/providerTrackCover.ts'

const props = defineProps<{
  category: string
  filter: string | null
  hasPlayer: boolean
  transitionName: 'page-down' | 'page-up'
  previewTracks?: Track[]
  returnFromDetail?: () => void
}>()

function activateCollectionCard(event: KeyboardEvent): void {
  if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return
  event.preventDefault()
  ;(event.currentTarget as HTMLElement).click()
}

const emit = defineEmits<{
  selectView: [category: string, filter: string | null]
  customizeAppearance: []
}>()

const {
  tracks,
  artists,
  albums,
  genres,
  localPlaylists,
  aggregatePlaylists,
  folders,
  scannedFolders,
  libraryRepairReport,
  excludedTracks,
  getPlaylistTracks,
  removeTrack,
  removeLocalTracks,
  restoreExcludedTracks,
  clearExcludedTracks,
  applyLocalTagWrite,
  startFullLibraryScan,
  scanLibraryDirectories,
  isScanning,
  clearTrackMetadataMatch,
  applyTrackMetadataMatch,
  refreshLibraryIndex,
  addToPlaylist,
  removeFromPlaylist,
  addTracksToPlaylist,
  removeTracksFromPlaylist,
  replaceTrackReference,
  createPlaylist,
  deletePlaylist,
  isFavoriteTrack,
  setFavoriteTracks,
  readFavoriteTrackPages,
  setFavoriteTrackPages,
  removeTrackIdPagesFromPlaylistById,
  addTrackPagesToPlaylistById,
  createPlaylistWithTrackPages,
  createAggregatePlaylistWithTrackPages
} = useMusicStore()
const playbackStore = usePlayerStore()
const settingsStore = useSettingsStore()
const { currentTrack } = playbackStore
const { playTrack, playTrackFromPosition, setPlayMode, playNextTrack } = playbackStore
const playbackBookmarks = usePlaybackBookmarks()
if (!props.previewTracks) void playbackBookmarks.ensureLoaded()
const mediaProviders = useMediaProviders({ sync: !props.previewTracks })
const unifiedSearch = useUnifiedMusicSearch({
  sync: !props.previewTracks,
  listen: !props.previewTracks
})
const rematchSearchSource = useLibraryUnifiedSearch(undefined, { listen: !props.previewTracks })
const providerStore = useProviderStore({ listen: !props.previewTracks })
const { listeningStats } = useListeningStatsStore()
const EMPTY_LAST_PLAYED_BY_TRACK_ID: ReadonlyMap<string, number> = new Map()
const libraryStorage = createLibraryStorageState({
  getStorageMode: () => window.api.library.getStorageMode()
})
onMounted(() => {
  if (!props.previewTracks) void libraryStorage.load()
})

const currentLibraryViewKey = computed(() => libraryViewKey(props.category, props.filter))
const { searchQuery, debouncedSearchQuery, searchInputFocused } = useSongListSearch(
  props.previewTracks ? undefined : currentLibraryViewKey
)

// ─── Recent playback source selector ──────────────────────────────────────
const recentSource = ref('all')
const recentSourceMenuOpen = ref(false)

const recentSourceOptions = computed(() => {
  const options = [
    { id: 'local', label: '本地音乐', icon: 'pi pi-desktop' },
    { id: 'all', label: '全平台', icon: 'pi pi-bolt' }
  ]
  if (props.previewTracks) return options
  for (const provider of providerStore.providers.value) {
    if (provider.capabilities.includes('library')) {
      options.push({
        id: provider.id,
        label: provider.name,
        icon: provider.ui?.icon || 'pi pi-cloud'
      })
    }
  }
  return options
})

const activeRecentSourceLabel = computed(
  () => recentSourceOptions.value.find((o) => o.id === recentSource.value)?.label ?? '本地音乐'
)

function selectRecentSource(sourceId: string): void {
  recentSourceMenuOpen.value = false
  recentSource.value = sourceId
}

function closeRecentSourceMenuDelayed(): void {
  setTimeout(() => {
    recentSourceMenuOpen.value = false
  }, 150)
}

// ─── 库管理下拉（重复检查 + 已移除） ────────────────────────────────────────
const libraryToolsMenuOpen = ref(false)
const LibraryLoudnessDialog = defineAsyncComponent(
  () => import('@renderer/components/library-loudness/LibraryLoudnessDialog.vue')
)
const loudnessOpen = ref(false)
const loudnessSelection = shallowRef<Track[] | null>(null)
const loudnessPlanResolver = shallowRef<
  | ((
      mode: 'track' | 'album',
      signal: AbortSignal
    ) => ReturnType<typeof buildLibraryLoudnessDatabasePlan>)
  | undefined
>()
const loudnessFocusTarget = shallowRef<HTMLElement | null>(null)

async function openLoudness(all: boolean, event: Event): Promise<void> {
  const target = event.currentTarget as HTMLElement
  loudnessFocusTarget.value =
    target.closest('.library-tools-dropdown')?.querySelector('button') ?? target
  if (libraryStorage.mode.value === 'sqlite' && !props.previewTracks) {
    try {
      let source: SongListActionSource
      if (all) {
        const metadata = await window.api.library.database.getMetadata()
        if (metadata.trackCount > 10_000) throw new Error('单次最多分析 10,000 首，请选择较小范围')
        source = createSongListActionSource({
          api: window.api.library.database,
          request: {
            query: { contentRevision: metadata.revision, sort: 'insertion' },
            total: metadata.trackCount,
            ranges: metadata.trackCount ? [[0, metadata.trackCount]] : []
          }
        })
      } else source = captureActionSource()
      await withActionSource(source, async (lease) => {
        const selected = await readSongListLoudnessTargets(lease)
        source.guard()
        const revision = lease.revision!
        loudnessSelection.value = selected
        loudnessPlanResolver.value = (mode, signal) =>
          buildLibraryLoudnessDatabasePlan(
            window.api.library.database,
            selected,
            revision,
            mode,
            signal
          )
        libraryToolsMenuOpen.value = false
        loudnessOpen.value = true
      })
    } catch (error) {
      repairMessage.value = error instanceof Error ? error.message : '读取响度分析范围失败'
    }
    return
  }
  loudnessPlanResolver.value = undefined
  loudnessSelection.value = all ? null : selectLocalLibraryActionTracks(getSelectedTracks())
  libraryToolsMenuOpen.value = false
  loudnessOpen.value = true
}

const baseDisplayTracks = computed(() => {
  if (props.previewTracks) return props.previewTracks
  if (databaseTableCandidate.value && libraryStorage.mode.value !== 'json') return []
  if (props.category === 'allSongs') return tracks.value
  if (props.category === 'recent') {
    const recentStats = getRecentTracks()
    const source = recentSource.value
    if (source === 'all') {
      return resolveUnifiedRecentTracks({ recentStats, localTracks: tracks.value })
    }
    const filteredStats =
      source === 'local'
        ? recentStats.filter((stat) => stat.sourceIds?.some((sid) => sid.source === 'local'))
        : recentStats.filter((stat) => stat.sourceIds?.some((sid) => sid.source === source))
    return resolveUnifiedRecentTracks({ recentStats: filteredStats, localTracks: tracks.value })
  }
  if (props.filter) {
    if (props.filter.startsWith('artist:')) {
      const name = props.filter.slice(7)
      return resolveLibraryArtistTracks(tracks.value, name)
    }
    if (props.filter.startsWith('album:')) {
      const id = props.filter.slice(6)
      return albums.value.find((album) => album.id === id)?.tracks ?? []
    }
    if (props.filter.startsWith('genre:')) {
      const name = props.filter.slice(6)
      return genres.value.find((genre) => genre.name === name)?.tracks ?? []
    }
    if (props.filter.startsWith('playlist:')) {
      const name = props.filter.slice(9)
      return getPlaylistTracks(name)
    }
    if (props.filter.startsWith('folder:')) {
      const path = props.filter.slice(7)
      const folder = folders.value.find((f) => f.path === path)
      return folder?.tracks ?? []
    }
  }
  return []
})

const libraryViewPreferences = new LibraryViewPreferences(
  props.previewTracks ? { getItem: () => null, setItem: () => {} } : undefined
)
const libraryViewState = ref<LibraryViewState>(
  libraryViewPreferences.read(currentLibraryViewKey.value, props.category)
)

watch(
  [currentLibraryViewKey, () => props.category],
  ([viewKey, category]) => {
    libraryViewState.value = libraryViewPreferences.read(viewKey, category)
  },
  { immediate: true }
)

function updateLibraryView(next: LibraryViewState): void {
  libraryViewState.value = next
  libraryViewPreferences.write(currentLibraryViewKey.value, next)
}

function setSortKey(value: string): void {
  updateLibraryView({ ...libraryViewState.value, sortKey: value as LibrarySortKey })
}

function setSortDirection(value: string): void {
  updateLibraryView({ ...libraryViewState.value, sortDirection: value as LibrarySortDirection })
}

function setLibraryFilter<K extends keyof LibraryViewFilters>(
  key: K,
  value: LibraryViewFilters[K]
): void {
  updateLibraryView({
    ...libraryViewState.value,
    filters: { ...libraryViewState.value.filters, [key]: value }
  })
}

const libraryFilterPanelOpen = ref(false)
const libraryFilterDropdownRef = ref<HTMLElement | null>(null)

function toggleLibraryFilterPanel(): void {
  libraryFilterPanelOpen.value = !libraryFilterPanelOpen.value
  if (libraryFilterPanelOpen.value) libraryToolsMenuOpen.value = false
}

function closeLibraryFilterPanel(): void {
  libraryFilterPanelOpen.value = false
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!libraryFilterPanelOpen.value) return
  const root = libraryFilterDropdownRef.value
  const target = event.target
  if (!(target instanceof Node) || !root || root.contains(target)) return
  closeLibraryFilterPanel()
}

function resetLibraryFilters(): void {
  const defaults = createDefaultLibraryViewState(props.category)
  updateLibraryView({
    ...libraryViewState.value,
    sortKey: defaults.sortKey,
    sortDirection: defaults.sortDirection,
    filters: { ...defaults.filters }
  })
}

const activeLibraryFilterCount = computed(() => {
  const filters = libraryViewState.value.filters
  let count = 0
  if (filters.lossless) count += 1
  if (filters.dsd) count += 1
  if (filters.sampleRate !== null) count += 1
  if (filters.bitDepth !== null) count += 1
  if (filters.folder) count += 1
  if (filters.provider) count += 1
  return count
})

watch([() => props.category, () => props.filter], () => {
  closeLibraryFilterPanel()
  libraryToolsMenuOpen.value = false
})

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
})

const libraryFilterOptions = computed(() => {
  if (databaseTableEnabled.value) {
    // Do not build facets from a page (or walk the compatibility Track[]).
    // Numeric/path inputs below accept the actual values rather than truncating options.
    return { sampleRates: [], bitDepths: [], folders: [], providers: [] }
  }
  const values = baseDisplayTracks.value
  const sampleRates = [
    ...new Set(
      values
        .map((track) => track.sampleRate)
        .filter((value): value is number => typeof value === 'number' && value > 0)
    )
  ].sort((left, right) => left - right)
  const bitDepths = [
    ...new Set(
      values
        .map((track) => track.bitDepth)
        .filter((value): value is number => typeof value === 'number' && value > 0)
    )
  ].sort((left, right) => left - right)
  const folders = [
    ...new Set(values.map(trackFolder).filter((value): value is string => !!value))
  ].sort((left, right) => left.localeCompare(right, 'zh'))
  const providers = [...new Set(values.map((track) => getLogicalTrackSource(track)))].sort(
    (left, right) => left.localeCompare(right, 'zh')
  )
  return { sampleRates, bitDepths, folders, providers }
})

const lastPlayedByTrackId = computed(() => {
  // Listening stats tick every five seconds. Unless this view is actually
  // sorted by last-played, keep stats out of the displayTracks dependency
  // graph so a playback tick cannot re-filter and re-sort the whole library.
  if (libraryViewState.value.sortKey !== 'lastPlayed') return EMPTY_LAST_PLAYED_BY_TRACK_ID
  if (databaseTableCandidate.value && libraryStorage.mode.value === 'sqlite')
    return EMPTY_LAST_PLAYED_BY_TRACK_ID
  return buildLastPlayedByTrackId(listeningStats.value)
})

const viewTitle = computed(() => {
  if (props.category === 'folders') {
    if (props.filter && props.filter.startsWith('folder:')) {
      if (!props.previewTracks && libraryStorage.mode.value !== 'json') {
        const path = props.filter.slice(7)
        return (
          path
            .replace(/[\\/]+$/, '')
            .split(/[\\/]/)
            .pop() || path
        )
      }
      return folders.value.find((f) => f.path === props.filter?.slice(7))?.name ?? '文件夹'
    }
    return '文件夹'
  }
  if (props.category === 'allSongs') return '本地音乐'
  if (props.category === 'recent') return '最近播放'
  if (props.category === 'artists') {
    if (props.filter && props.filter.startsWith('artist:')) return props.filter.slice(7)
    return '艺术家'
  }
  if (props.category === 'albums') {
    if (props.filter && props.filter.startsWith('album:')) {
      const id = props.filter.slice(6)
      if (libraryStorage.mode.value !== 'json' && !props.previewTracks)
        return databaseAlbumState.value.page?.items[0]?.name ?? '专辑'
      return albums.value.find((album) => album.id === id)?.name ?? '专辑'
    }
    return '专辑'
  }
  if (props.category === 'genres') {
    if (props.filter && props.filter.startsWith('genre:')) return props.filter.slice(6)
    return '流派'
  }
  if (props.category === 'playlists') {
    if (props.filter && props.filter.startsWith('playlist:')) return props.filter.slice(9)
    return '歌单'
  }
  return '我的音乐'
})

const gridStatsText = computed(() => {
  const count = collectionResultCount.value
  if (count === 0) return ''
  const unit =
    props.category === 'artists'
      ? '位艺术家'
      : props.category === 'albums'
        ? '张专辑'
        : props.category === 'genres'
          ? '种流派'
          : props.category === 'playlists'
            ? '份歌单'
            : props.category === 'folders'
              ? '个文件夹'
              : '个条目'
  return `共 ${count} ${unit}`
})

const totalDurationText = computed(() => {
  let total = databaseTableEnabled.value ? (databasePageState.value.page?.totalDuration ?? 0) : 0
  if (!databaseTableEnabled.value)
    for (const track of displayTracks.value) total += track.duration || 0
  if (total <= 0) return ''
  const minutes = Math.round(total / 60)
  if (minutes < 1) return '不足 1 分钟'
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`
})

const viewStatsText = computed(() => {
  if (props.category === 'allSongs') return ''
  const count = tableTrackCount.value
  if (count === 0) return ''
  return totalDurationText.value ? `${count} 首 · ${totalDurationText.value}` : `${count} 首`
})

const currentPlaylistName = computed(() => {
  if (props.category !== 'playlists' || !props.filter?.startsWith('playlist:')) return null
  return props.filter.slice(9)
})

const isPlaylistDetail = computed(() => currentPlaylistName.value !== null)
const isAlbumDetail = computed(
  () => props.category === 'albums' && props.filter?.startsWith('album:') === true
)
const currentAlbum = computed(() => {
  if (!isAlbumDetail.value) return null
  if (!props.previewTracks && libraryStorage.mode.value !== 'json')
    return databaseAlbumState.value.page?.items[0] ?? null
  return albums.value.find((album) => album.id === props.filter?.slice(6)) ?? null
})
const albumDurationText = computed(() => {
  const album = currentAlbum.value
  const seconds =
    album && 'duration' in album
      ? album.duration
      : (album?.tracks.reduce((sum, track) => sum + Math.max(0, track.duration || 0), 0) ?? 0)
  const minutes = Math.round(seconds / 60)
  if (seconds <= 0) return ''
  if (minutes < 1) return '不足 1 分钟'
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`
})

function trackListNumber(track: Track, visibleIndex: number): number {
  if (
    isAlbumDetail.value &&
    typeof track.trackNumber === 'number' &&
    Number.isFinite(track.trackNumber) &&
    track.trackNumber > 0
  ) {
    return track.trackNumber
  }
  return visibleRange.value.start + visibleIndex + 1
}

const currentPlaylist = computed(() =>
  currentPlaylistName.value
    ? (localPlaylists.value.find((playlist) => playlist.name === currentPlaylistName.value) ?? null)
    : null
)
const repairMessage = ref('')
const showExcludedTracksDialog = ref(false)
const showTagManager = ref(false)
const showLibraryInbox = ref(false)
const showMusicVersions = ref(false)
const musicVersionsInitialTrack = shallowRef<Track>()
const musicVersionsOpening = ref(false)
const MusicVersionsHost = defineAsyncComponent(
  () => import('@renderer/components/music-versions/MusicVersionsHost.vue')
)
const libraryToolsTrigger = ref<HTMLButtonElement | null>(null)
const tagManagerInitialView = ref<'edit' | 'duplicates'>('edit')
const tagManagerTracks = ref<Track[]>([])
const tagManagerContentRevision = ref<number | null>(null)
const tagManagerFocusRestoreTarget = ref<HTMLElement | null>(null)
const libraryMutationPending = ref(false)
const exclusionRestorePending = ref(false)
const searchOnlineSongs = ref(false)

const showOnlineSearchToggle = computed(() => props.category === 'allSongs' && !props.filter)
const shouldUseUnifiedSearch = computed(
  () => showOnlineSearchToggle.value && searchOnlineSongs.value
)
const databasePlaylistView = createLibraryPlaylistView({
  syncPlaylistView: (request) => window.api.library.database.syncPlaylistView(request)
})
const databasePlaylistState = databasePlaylistView.state
watch(
  [
    () => libraryStorage.mode.value,
    localPlaylists,
    musicVersionRevision,
    currentPlaylistName,
    () => props.previewTracks
  ],
  () => {
    const versions = props.previewTracks ? [] : getMusicVersions().tracks.versions
    void databasePlaylistView.setPlaylist(
      !props.previewTracks && libraryStorage.mode.value === 'sqlite' ? currentPlaylist.value : null,
      { revision: musicVersionRevision.value, versions }
    )
  },
  { immediate: true, flush: 'sync' }
)
const databaseDetailScope = computed(() => {
  if (isPlaylistDetail.value) return {}
  const scope = libraryDetailScope(props.category, props.filter)
  if (scope?.folder)
    scope.recursive =
      scannedFolders.value.length > 0 || settingsStore.settings.value.libraryFolders.length > 0
  return scope
})
const databaseTableCandidate = computed(
  () => !props.previewTracks && databaseDetailScope.value !== null && !shouldUseUnifiedSearch.value
)
const databaseHistoryRequested = computed(
  () =>
    databaseTableCandidate.value &&
    libraryStorage.mode.value === 'sqlite' &&
    libraryViewState.value.sortKey === 'lastPlayed'
)
const databaseTableEnabled = computed(
  () => databaseTableCandidate.value && libraryStorage.mode.value === 'sqlite'
)
const historyProjectionState = libraryListeningProjection.state
const databaseHistoryReady = computed(
  () => !databaseHistoryRequested.value || historyProjectionState.value.ready
)
const databaseHistoryRevision = computed(() =>
  databaseHistoryRequested.value && historyProjectionState.value.ready
    ? historyProjectionState.value.revision!
    : undefined
)
watch(
  databaseHistoryRequested,
  (needed) => {
    if (needed) void libraryListeningProjection.ensure()
  },
  { immediate: true }
)
const databaseQuery = computed(() =>
  databaseTableEnabled.value &&
  databaseHistoryReady.value &&
  (!isPlaylistDetail.value || databasePlaylistState.value.id !== null)
    ? {
        ...libraryTrackQuery(libraryViewState.value, debouncedSearchQuery.value),
        ...databaseDetailScope.value,
        ...(isPlaylistDetail.value ? { playlistView: databasePlaylistState.value.id! } : {}),
        genreSeparators: settingsStore.settings.value.genreSeparators,
        ...(databaseHistoryRequested.value
          ? { historyRevision: databaseHistoryRevision.value }
          : {})
      }
    : null
)
const databasePages = createLibraryTrackWindow({
  queryTracks: async (query) => {
    try {
      const page = await window.api.library.database.queryTracks(query)
      return { ...page, tracks: page.tracks.map((record) => ({ ...libraryTrack(record) })) }
    } catch (error) {
      if (query?.playlistView) databasePlaylistView.recover(query.playlistView, error)
      throw error
    }
  }
})
const databasePageState = databasePages.state
const databaseWindowPages = databasePages.pages
const databaseReadPending = computed(
  () =>
    (databaseTableCandidate.value &&
      (libraryStorage.mode.value === null ||
        (databaseTableEnabled.value && databasePageState.value.loading))) ||
    (databaseTableEnabled.value && isPlaylistDetail.value && databasePlaylistState.value.pending) ||
    (databaseHistoryRequested.value &&
      !historyProjectionState.value.ready &&
      historyProjectionState.value.pending)
)
const databaseReadError = computed(() =>
  databaseTableCandidate.value
    ? libraryStorage.error.value ||
      (isPlaylistDetail.value ? databasePlaylistState.value.error : '') ||
      (databaseHistoryRequested.value ? historyProjectionState.value.error : '') ||
      (databaseTableEnabled.value ? databasePageState.value.error : '')
    : ''
)
watch(
  databaseQuery,
  (query, previous) => {
    const { historyRevision: _nextHistory, ...next } = query ?? {}
    const { historyRevision: _previousHistory, ...before } = previous ?? {}
    const historyOnly =
      query?.sort === 'lastPlayed' &&
      previous?.sort === 'lastPlayed' &&
      query.historyRevision !== previous.historyRevision &&
      JSON.stringify(next) === JSON.stringify(before)
    databasePages.setQuery(query, historyOnly)
  },
  { immediate: true, flush: 'sync' }
)
let unsubscribeDatabasePages: (() => void) | undefined
onMounted(() => {
  if (props.previewTracks) return
  unsubscribeDatabasePages = window.api?.library?.onChanged((change) => {
    const revision = change?.kind === 'scan' ? change.update.libraryRevision : change?.revision
    if (
      showTagManager.value &&
      tagManagerContentRevision.value !== null &&
      revision !== undefined &&
      revision > tagManagerContentRevision.value
    ) {
      closeTagManager()
      repairMessage.value = '曲库已变化，请重新选择歌曲后编辑标签'
    }
    if (databaseTableEnabled.value) databasePages.invalidate(revision)
    if (databaseGridEnabled.value) databaseCollections.invalidate(revision)
    if (databaseAlbumEnabled.value) databaseAlbumPages.invalidate(revision)
    if (databaseGridEnabled.value && isCollectionGrid.value) databaseGenrePages.invalidate(revision)
  })
})
onBeforeUnmount(() => {
  unsubscribeDatabasePages?.()
  databasePages.dispose()
  void databasePlaylistView.dispose()
  void databasePlaylistCatalog.dispose()
  databaseCollections.dispose()
  databaseAlbumPages.dispose()
  databaseGenrePages.dispose()
})
function retryDatabaseRead(): void {
  if (libraryStorage.mode.value === null) void libraryStorage.load()
  else if (databaseHistoryRequested.value && !historyProjectionState.value.ready)
    void libraryListeningProjection.retry()
  else if (isPlaylistDetail.value && databasePlaylistState.value.error)
    void databasePlaylistView.retry()
  else databasePages.retry()
}
const libraryRepairStatusText = computed(() => {
  if (props.previewTracks || props.category !== 'allSongs' || props.filter) return ''
  const report = libraryRepairReport.value
  if (!report || (report.repairedCount === 0 && report.unresolvedCount === 0)) return ''
  const parts: string[] = []
  if (report.repairedCount > 0) parts.push(`已自动重定位 ${report.repairedCount} 首`)
  if (report.unresolvedCount > 0) {
    parts.push(`${report.unresolvedCount} 首本地文件未找到，可右键重新匹配音源`)
  }
  return parts.join('，')
})

watch(
  [debouncedSearchQuery, () => props.category, () => props.filter, searchOnlineSongs],
  ([query]) => {
    const q = query.trim()
    if (!q || !shouldUseUnifiedSearch.value) {
      unifiedSearch.clear()
      return
    }
    void unifiedSearch.search(q, { limit: 100, offset: 0 })
  },
  { immediate: true }
)

const searchedTracks = computed(() => {
  const q = debouncedSearchQuery.value.trim()
  if (!q) return baseDisplayTracks.value
  if (shouldUseUnifiedSearch.value) {
    return unifiedSearch.items.value.map((item) => item.track)
  }
  const normalizedQuery = normalizeSearchText(q)
  if (!normalizedQuery) return baseDisplayTracks.value
  return baseDisplayTracks.value.filter((t) => getTrackSearchBlob(t).includes(normalizedQuery))
})

const displayTracks = computed(() =>
  applyLibraryView(searchedTracks.value, libraryViewState.value, lastPlayedByTrackId.value)
)
// A bounded loaded window, never the complete displayTracks/tracks contract.
const tableTracks = computed<Track[]>(() =>
  databaseTableEnabled.value
    ? databaseWindowPages.value.flatMap((page) => page.tracks as unknown as Track[])
    : displayTracks.value
)
const tableEntryIds = computed(() => {
  if (!databaseTableEnabled.value) return new Map<Track, string>()
  return new Map(
    databaseWindowPages.value.flatMap((page) =>
      page.entryIds
        ? page.tracks.map(
            (track, index) => [track as unknown as Track, page.entryIds![index]] as const
          )
        : []
    )
  )
})
const tableRowPositions = computed(
  () =>
    new Map(
      databaseTableEnabled.value
        ? databaseWindowPages.value.flatMap((page) =>
            page.tracks.map(
              (track, index) => [track as unknown as Track, page.offset + index] as const
            )
          )
        : []
    )
)
function databasePageForTrack(track: Track) {
  return databasePages.pageForTrack(toRaw(track) as unknown as LibraryTrackRecord)
}
// Weak keys retain only selected compact records, not evicted pages or row payloads.
const selectedTableRows = new WeakMap<
  Track,
  { key: string; definitionId: string; version?: number; position?: number }
>()
function tableTrackKey(track: Track): string {
  const selected = selectedTableRows.get(toRaw(track))
  if (selected) return selected.key
  const entry = tableEntryIds.value.get(toRaw(track))
  return entry === undefined ? track.id : `${databasePlaylistState.value.id}:${entry}`
}
// Configuration edits address the original member, not the preferred/relinked
// local ID that SQL resolved for display/playback. Do not rewrite the row itself.
function playlistDefinitionTrack(track: Track): Track {
  const entry = tableEntryIds.value.get(toRaw(track))
  const id =
    selectedTableRows.get(toRaw(track))?.definitionId ??
    (entry === undefined ? undefined : currentPlaylist.value?.trackIds[Number(entry)])
  return id === undefined || id === track.id ? track : { ...track, id }
}
function snapshotSelectedTableTrack(track: Track): Track {
  const snapshot = toPlaylistTrackSnapshot(track)
  // Old embedded covers can be megabytes; action records use cache/remote covers.
  if (snapshot.cover?.startsWith('data:')) snapshot.cover = null
  if (snapshot.coverSmall?.startsWith('data:')) delete snapshot.coverSmall
  if (snapshot.coverSource?.startsWith('data:')) delete snapshot.coverSource
  if (snapshot.coverSmallSource?.startsWith('data:')) delete snapshot.coverSmallSource
  selectedTableRows.set(snapshot, {
    key: tableTrackKey(track),
    definitionId: playlistDefinitionTrack(track).id,
    version: databasePageForTrack(track)?.versions[track.id],
    position: tableRowPositions.value.get(toRaw(track))
  })
  return snapshot
}
function databasePlaybackQuery(track?: Track) {
  const query = databaseQuery.value,
    page = track ? databasePageForTrack(track) : databasePageState.value.page
  if (!query || !page || (track && !tableTracks.value.includes(toRaw(track)))) return null
  return {
    ...query,
    contentRevision: page.revision,
    ...(track && query.playlistView
      ? { playlistEntryId: tableEntryIds.value.get(toRaw(track)) }
      : {})
  }
}
function databasePlaybackOptions(
  query: NonNullable<typeof databaseQuery.value>,
  options: Parameters<typeof playbackStore.playLibraryQuery>[2] = {}
) {
  const id = query.playlistView
  if (!id) return options
  return {
    ...options,
    onQueryFailure: (error: unknown) => {
      if (databasePlaylistView.recover(id, error))
        repairMessage.value = '歌单视图已失效，正在重建；完成后请重新播放'
    }
  }
}
const tableTrackCount = computed(() =>
  databaseTableEnabled.value ? (databasePageState.value.total ?? 0) : displayTracks.value.length
)

const unifiedSearchSourceNames = computed(
  () => new Map(unifiedSearch.items.value.map((item) => [item.track.id, item.sourceName]))
)

const showUnifiedSearchStatus = computed(
  () => shouldUseUnifiedSearch.value && debouncedSearchQuery.value.trim().length > 0
)

const unifiedSearchHealthItems = computed(() =>
  Object.values(unifiedSearch.providerHealth.value).map((health) => ({
    ...health,
    state: unifiedSearchHealthState(health),
    label: unifiedSearchHealthLabel(health),
    detail: unifiedSearchHealthDetail(health)
  }))
)

const unifiedSearchStatusText = computed(() => {
  if (!showUnifiedSearchStatus.value) return ''
  if (unifiedSearch.loading.value) return '正在同时搜索本地库和在线音源'
  if (unifiedSearch.error.value) return `统一搜索失败：${unifiedSearch.error.value}`
  const providerCount = unifiedSearchHealthItems.value.length
  const failedCount = unifiedSearchHealthItems.value.filter((item) => item.state === 'error').length
  const resultCount = displayTracks.value.length
  if (failedCount > 0)
    return `找到 ${resultCount} 首，${failedCount}/${providerCount} 个在线音源不可用`
  return `找到 ${resultCount} 首，已合并本地库和 ${providerCount} 个在线音源`
})

const isDetailView = computed(() => {
  // Top-level views (including recent / all songs) are reached from the side
  // menu; a back action that only clears the filter is a no-op there.
  return !!props.filter
})

function handleDetailBack(): void {
  if (props.returnFromDetail) props.returnFromDetail()
  else emit('selectView', props.category, null)
}
useBackHandler(isDetailView, handleDetailBack)

const showGrid = computed(() => {
  if (props.category === 'allSongs' || props.category === 'recent') return false
  return !props.filter
})

const showTable = computed(() => {
  if (props.category === 'allSongs' || props.category === 'recent') return true
  return !!props.filter
})

const isCollectionGrid = computed(
  () => showGrid.value && (props.category === 'artists' || props.category === 'albums')
)

const collectionViewPreferences = new LibraryCollectionViewPreferences(
  props.previewTracks ? null : undefined
)
const collectionViewState = ref<LibraryCollectionViewState>(
  collectionViewPreferences.read(props.category)
)
const activeCollectionLetter = ref<string | null>(null)

watch(
  () => props.category,
  (category) => {
    if (category === 'artists' || category === 'albums') {
      collectionViewState.value = collectionViewPreferences.read(category)
    }
    activeCollectionLetter.value = null
  }
)

function updateCollectionView(next: LibraryCollectionViewState): void {
  collectionViewState.value = next
  collectionViewPreferences.write(props.category, next)
  activeCollectionLetter.value = null
}

function setCollectionSort(value: string): void {
  updateCollectionView({ ...collectionViewState.value, sort: value as LibraryCollectionSort })
}

function setCollectionGenre(value: string): void {
  updateCollectionView({ ...collectionViewState.value, genre: value || null })
}

const playlistOrderNotice = ref('')
const localPlaylistEntries = computed(() =>
  props.previewTracks
    ? []
    : localPlaylists.value.map((playlist) => ({ ...playlist, id: playlist.id ?? playlist.name }))
)
const localPlaylistOrder = useLocalPlaylistOrder(
  localPlaylistEntries,
  () => 'library',
  (message) => {
    playlistOrderNotice.value = message
  },
  { persist: !props.previewTracks }
)
const databasePlaylistCatalog = createLibraryPlaylistView({
  syncPlaylistView: (request) => window.api.library.database.syncPlaylistView(request)
})
const databaseCatalogState = databasePlaylistCatalog.state
const databaseGridKind = computed<LibraryCollectionKind | null>(() =>
  !props.previewTracks &&
  showGrid.value &&
  ['albums', 'artists', 'genres', 'folders', 'playlists'].includes(props.category)
    ? (props.category as LibraryCollectionKind)
    : null
)
const databaseGridEnabled = computed(
  () => databaseGridKind.value !== null && libraryStorage.mode.value === 'sqlite'
)
const databaseCollections = createLibraryCollectionWindow({
  queryCollections: async (kind, query) => {
    try {
      return await window.api.library.database.queryCollections(kind, query)
    } catch (error) {
      if (query?.playlistView) databasePlaylistCatalog.recover(query.playlistView, error)
      throw error
    }
  }
})
watch(
  () => ({
    enabled: databaseGridEnabled.value && databaseGridKind.value === 'playlists',
    playlists: localPlaylistEntries.value,
    revision: musicVersionRevision.value
  }),
  ({ enabled, playlists, revision }) =>
    void databasePlaylistCatalog.setCatalog(enabled ? playlists : null, {
      revision,
      versions: props.previewTracks ? [] : getMusicVersions().tracks.versions
    }),
  { immediate: true, flush: 'sync' }
)
const databaseCollectionState = databaseCollections.state
const databaseGridPending = computed(
  () =>
    databaseGridKind.value !== null &&
    (libraryStorage.mode.value === null ||
      (databaseGridEnabled.value &&
        (databaseCollectionState.value.loading ||
          (databaseGridKind.value === 'playlists' && databaseCatalogState.value.pending))))
)
const databaseGridError = computed(() =>
  databaseGridKind.value !== null
    ? libraryStorage.error.value ||
      (databaseGridEnabled.value
        ? (databaseGridKind.value === 'playlists' ? databaseCatalogState.value.error : '') ||
          databaseCollectionState.value.error
        : '')
    : ''
)
const collectionResultCount = computed(() =>
  databaseGridEnabled.value ? (databaseCollectionState.value.total ?? 0) : gridTotalCount.value
)
const databaseGridSelection = computed(() => ({
  kind:
    databaseGridEnabled.value &&
    (databaseGridKind.value !== 'playlists' || databaseCatalogState.value.id !== null)
      ? databaseGridKind.value
      : null,
  query:
    databaseGridKind.value === 'playlists'
      ? {
          search: debouncedSearchQuery.value,
          playlistView: databaseCatalogState.value.id ?? undefined,
          collectionOrder: localPlaylistOrder.playlists.value.map((playlist) => playlist.id)
        }
      : {
          search: debouncedSearchQuery.value,
          genreSeparators: settingsStore.settings.value.genreSeparators,
          ...(isCollectionGrid.value
            ? {
                collectionGenre: collectionViewState.value.genre ?? undefined,
                sort: collectionViewState.value.sort.startsWith('added-')
                  ? ('addedAt' as const)
                  : ('title' as const),
                direction: ['name-desc', 'added-newest'].includes(collectionViewState.value.sort)
                  ? ('desc' as const)
                  : ('asc' as const)
              }
            : {})
        }
}))

let databaseGridIntent = ''
watch(
  databaseGridSelection,
  ({ kind, query }) => {
    const intent = JSON.stringify([
      databaseGridEnabled.value,
      databaseGridKind.value,
      debouncedSearchQuery.value,
      isCollectionGrid.value ? collectionViewState.value : null
    ])
    const preservePosition = databaseGridEnabled.value && intent === databaseGridIntent
    databaseGridIntent = intent
    databaseCollections.setQuery(kind, query, preservePosition)
  },
  { immediate: true }
)

function retryDatabaseCollections(): void {
  if (libraryStorage.mode.value === null) void libraryStorage.load()
  else if (databaseGridKind.value === 'playlists' && databaseCatalogState.value.error)
    void databasePlaylistCatalog.retry()
  else databaseCollections.retry()
}
// Album headers describe the entire release, independent of the detail table's
// search, filters and current page. No placeholder Track[] is fabricated.
const databaseAlbumEnabled = computed(
  () => !props.previewTracks && isAlbumDetail.value && libraryStorage.mode.value === 'sqlite'
)
const databaseAlbumPages = createLibraryCollectionPages(
  {
    queryCollections: (kind, query) => window.api.library.database.queryCollections(kind, query)
  },
  1
)
const databaseAlbumState = databaseAlbumPages.state
watch(
  () => ({ enabled: databaseAlbumEnabled.value, albumId: props.filter?.slice(6) }),
  ({ enabled, albumId }) => databaseAlbumPages.setQuery(enabled ? 'albums' : null, { albumId }),
  { immediate: true }
)

// Keep suggestions bounded and searchable instead of exporting every genre to
// populate a select. The filter still accepts any complete, case-insensitive label.
const databaseGenrePages = createLibraryCollectionPages({
  queryCollections: (kind, query) => window.api.library.database.queryCollections(kind, query)
})
const databaseGenreState = databaseGenrePages.state
const databaseGenreSearch = ref(collectionViewState.value.genre ?? '')
let genreSearchTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => collectionViewState.value.genre,
  (genre) => {
    clearTimeout(genreSearchTimer)
    genreSearchTimer = setTimeout(() => {
      databaseGenreSearch.value = genre ?? ''
    }, 180)
  }
)
onBeforeUnmount(() => clearTimeout(genreSearchTimer))
watch(
  () => ({
    enabled: databaseGridEnabled.value && isCollectionGrid.value,
    search: databaseGenreSearch.value,
    genreSeparators: settingsStore.settings.value.genreSeparators
  }),
  ({ enabled, search, genreSeparators }) =>
    databaseGenrePages.setQuery(enabled ? 'genres' : null, {
      search,
      genreSeparators,
      collectionNamesOnly: true
    }),
  { immediate: true }
)

const baseCollectionItems = computed<GridItem[]>(() => {
  if (databaseGridKind.value !== null && libraryStorage.mode.value !== 'json') return []
  if (props.category === 'artists') return artists.value
  if (props.category === 'albums') return albums.value
  return []
})
const collectionGenreOptions = computed(() =>
  availableCollectionGenres(baseCollectionItems.value, settingsStore.settings.value.genreSeparators)
)
const collectionGridItems = computed(() =>
  applyLibraryCollectionView(
    baseCollectionItems.value,
    collectionViewState.value,
    settingsStore.settings.value.genreSeparators
  )
)

watch(
  () => settingsStore.settings.value.genreSeparators,
  () => {
    if (!props.previewTracks) refreshLibraryIndex()
  }
)
const localPlaylistReorderEntries = computed(() => {
  if (!databaseGridEnabled.value) return filteredGridItems.value as Array<GridItem & { id: string }>
  const search = normalizeSearchText(debouncedSearchQuery.value.trim())
  // Catalog search matches configured names only. Keep all matching header IDs,
  // including unloaded neighbors, without resolving any track membership.
  return localPlaylistOrder.playlists.value.filter((playlist) =>
    normalizeSearchText(playlist.name).includes(search)
  )
})
const localPlaylistReorder = useHoldReorder((from, to) => {
  localPlaylistOrder.move(from, to, localPlaylistReorderEntries.value)
})
watch(() => [props.category, props.filter], localPlaylistReorder.cancel)
function localPlaylistKeydown(event: KeyboardEvent, playlist: GridItem): void {
  if (event.target !== event.currentTarget) return
  if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault()
    const entries = localPlaylistReorderEntries.value
    const index = entries.findIndex((entry) => entry.id === playlist.id)
    const target = entries[index + (event.key === 'ArrowUp' ? -1 : 1)]
    if (playlist.id && target?.id)
      localPlaylistOrder.move(playlist.id, target.id, entries as Array<GridItem & { id: string }>)
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    emit('selectView', 'playlists', `playlist:${playlist.name}`)
  }
}

const currentGridItems = computed<GridItem[]>(() => {
  if (databaseGridKind.value !== null && libraryStorage.mode.value !== 'json')
    return databaseCollectionState.value.page?.items ?? []
  if (isCollectionGrid.value) return collectionGridItems.value
  if (props.category === 'genres') return genres.value
  if (props.category === 'playlists') return localPlaylistOrder.playlists.value
  if (props.category === 'folders') return folders.value
  return []
})

function onRowDblClick(track: Track, event: MouseEvent): void {
  const target = event.target as HTMLElement
  if (target.closest('.btn-remove') || target.closest('.track-select-checkbox')) return
  if (multiSelect.shouldSuppressRowDoubleClick(event)) return
  if (settingsStore.settings.value.trackActivationMode !== 'doubleClick') return
  if (track.source === 'network' && !databaseTableEnabled.value) {
    void playNetworkTrack(track)
    return
  }
  playTableTrack(track)
}

function playTableTrack(track: Track): void {
  if (databaseTableEnabled.value) {
    const query = databasePlaybackQuery(track)
    if (query) void playbackStore.playLibraryQuery(query, track.id, databasePlaybackOptions(query))
  } else playTrack(track, displayTracks.value)
}

async function playNetworkTrack(track: Track): Promise<void> {
  const network = track.networkSource
  if (!network || !window.api?.networkSources) return
  try {
    const plan = await window.api.networkSources.resolvePlayback(network.profileId, network.entry)
    const resolved: Track = {
      ...track,
      filePath: plan.kind === 'direct-url' ? (plan.url ?? '') : (plan.cacheFilePath ?? '')
    }
    playTrack(resolved, [resolved])
  } catch (err) {
    unifiedSearch.error.value = `网络源播放失败：${err instanceof Error ? err.message : String(err)}`
  }
}

function playAllTracks(): void {
  if (databaseTableEnabled.value) {
    const query = databasePlaybackQuery()
    if (query && tableTrackCount.value > 0)
      void playbackStore.playLibraryQuery(query, undefined, databasePlaybackOptions(query))
    return
  }
  const list = displayTracks.value
  if (list.length === 0) return
  playTrack(list[0], list)
}

function shufflePlayTracks(): void {
  if (databaseTableEnabled.value) {
    const query = databasePlaybackQuery()
    if (!query || tableTrackCount.value === 0) return
    void playbackStore.playLibraryQuery(
      query,
      undefined,
      databasePlaybackOptions(query, {
        randomStart: true,
        playMode: 'shuffle'
      })
    )
    return
  }
  const list = displayTracks.value
  if (list.length === 0) return
  setPlayMode('shuffle')
  playTrack(list[Math.floor(Math.random() * list.length)], list)
}

function trackQualityLabel(track: Track): string {
  const parts: string[] = []
  if (track.format) parts.push(track.format.toUpperCase())
  if (typeof track.sampleRate === 'number' && track.sampleRate > 0) {
    const khz = track.sampleRate / 1000
    parts.push(`${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`)
  }
  if (typeof track.bitDepth === 'number' && track.bitDepth > 0) parts.push(`${track.bitDepth} bit`)
  return parts.join(' · ')
}

function metadataMatchLabel(track: Track): string {
  const match = track.metadataMatch
  if (!match) return ''
  const confidence = match.confidence === 'high' ? '高置信度' : '中置信度'
  return `已匹配 ${match.providerId} · ${confidence}`
}

function metadataMatchTitle(track: Track): string {
  const match = track.metadataMatch
  if (!match) return ''
  const confidence = match.confidence === 'high' ? '高置信度' : '中置信度'
  return `流媒体元数据匹配：${match.providerId} / ${match.trackId} · ${confidence} · ${match.score} 分`
}

function unifiedSearchHealthLabel(health: {
  searchable: boolean
  available: boolean
  resultCount: number
  lastError: string | null
  pluginStatus: string | null
  playbackUrlSuccessRate: number | null
}): string {
  if (health.pluginStatus && health.pluginStatus !== 'enabled') return `插件 ${health.pluginStatus}`
  if (!health.searchable) return '不支持搜索'
  if (health.lastError) return health.lastError
  if (!health.available) return '音源不可用'
  if (health.playbackUrlSuccessRate !== null && health.playbackUrlSuccessRate < 0.95) {
    return `播放 URL ${formatPercent(health.playbackUrlSuccessRate)}`
  }
  return `${health.resultCount} 首`
}

function unifiedSearchHealthState(health: {
  searchable: boolean
  available: boolean
  lastError: string | null
  pluginStatus: string | null
  successRate: number | null
  playbackUrlSuccessRate: number | null
}): 'ok' | 'warning' | 'error' {
  if (health.pluginStatus && health.pluginStatus !== 'enabled') return 'error'
  if (!health.searchable || !health.available || health.lastError) return 'error'
  if (
    (health.successRate !== null && health.successRate < 0.95) ||
    (health.playbackUrlSuccessRate !== null && health.playbackUrlSuccessRate < 0.95)
  ) {
    return 'warning'
  }
  return 'ok'
}

function unifiedSearchHealthDetail(health: {
  searchable: boolean
  available: boolean
  resultCount: number
  lastError: string | null
  pluginStatus: string | null
  successRate: number | null
  playbackUrlSuccessRate: number | null
  playbackUrlLastError: string | null
  lastCheckedAt: string | null
}): string {
  return [
    `搜索 ${health.searchable ? '支持' : '不支持'}`,
    `可用性 ${health.available ? '可用' : '不可用'}`,
    health.pluginStatus ? `插件 ${health.pluginStatus}` : '',
    health.successRate !== null ? `API 成功率 ${formatPercent(health.successRate)}` : '',
    health.playbackUrlSuccessRate !== null
      ? `播放 URL 成功率 ${formatPercent(health.playbackUrlSuccessRate)}`
      : '',
    `结果 ${health.resultCount} 首`,
    health.lastError ? `最近错误 ${health.lastError}` : '',
    health.playbackUrlLastError ? `播放 URL 最近错误 ${health.playbackUrlLastError}` : '',
    health.lastCheckedAt ? `最后检查 ${health.lastCheckedAt}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
}

function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
}

function trackSourceLabel(track: Track): string {
  const searchSourceName = unifiedSearchSourceNames.value.get(track.id)
  return searchSourceName || getLogicalTrackSource(track)
}

function trackSourceClass(track: Track): string {
  return getLogicalTrackSource(track) === 'local' ? 'local' : 'provider'
}

function playlistSourceSummaryLabel(playlist: GridItem): string {
  if (playlist.imported) return ''
  return formatPlaylistSourceSummary(playlist.sourceSummary ?? summarizePlaylistSources(playlist))
}

async function handleManualRematch(track: Track): Promise<void> {
  repairMessage.value = `正在重新匹配 ${track.title || '当前曲目'}...`
  try {
    await syncPluginProviders()
    const query = [track.title, track.artist].filter(Boolean).join(' ')
    const result = await mediaProviders.searchAllSongs({
      query,
      localTracks: [],
      localSource: rematchSearchSource,
      limit: 20,
      offset: 0
    })
    const candidates = buildMetadataMatchCandidates(
      track,
      result.items.map((item) => item.track)
    )
    const rematched = candidates[0]?.track
    if (!rematched) {
      repairMessage.value = `未找到可替换 ${track.title || '当前曲目'} 的音源`
      return
    }
    const replacedCount = replaceTrackReference(track.id, rematched)
    repairMessage.value =
      replacedCount > 0
        ? `已重新匹配到 ${rematched.source ?? getTrackSource(rematched)}：${rematched.title || track.title}`
        : `找到 ${rematched.title || track.title}，但没有需要替换的引用`
  } catch (error) {
    repairMessage.value = error instanceof Error ? error.message : '重新匹配音源失败'
  }
}

async function handleMetadataRematch(track: Track): Promise<void> {
  const expectedVersion = databaseTableEnabled.value
    ? databasePageForTrack(track)?.versions[track.id]
    : undefined
  const useDatabase = databaseTableEnabled.value
  repairMessage.value = `正在匹配 ${track.title || '当前曲目'} 的流媒体元数据...`
  try {
    await syncPluginProviders()
    const providerTracks = await searchMetadataTracks([track], async (query, limit, offset) => {
      const result = await mediaProviders.searchAllSongs({
        query,
        localTracks: [],
        limit,
        offset
      })
      return { items: result.items.map((item) => item.track) }
    })
    const candidates = buildMetadataMatchCandidates(track, providerTracks)
    const best = candidates[0]
    if (!best) {
      repairMessage.value = `未找到可匹配 ${track.title || '当前曲目'} 的流媒体元数据`
      return
    }
    let changed: boolean
    if (useDatabase) {
      if (expectedVersion === undefined) throw new Error('曲目窗口已变化，请刷新后重试')
      const next = enrichLocalTrackMetadata(track, best, settingsStore.settings.value.cachePolicy)
      const patch = Object.fromEntries(
        (
          [
            'artist',
            'album',
            'genre',
            'cover',
            'lyrics',
            'translatedLyrics',
            'lyricsSource',
            'translatedLyricsSource',
            'metadataMatch'
          ] as const
        )
          .filter((key) => next[key] !== track[key])
          .map((key) => [key, next[key]])
      )
      if (track.streamUrl !== undefined) patch.streamUrl = null
      await window.api.library.database.patchTracks([{ id: track.id, expectedVersion, patch }])
      changed = true
    } else
      changed = applyTrackMetadataMatch(track.id, best.track, {
        confidence: best.confidence,
        score: best.score
      })
    repairMessage.value = changed
      ? `已匹配 ${best.sourceLabel}：${best.track.title || track.title}`
      : `找到 ${best.track.title || track.title}，但未能应用到本地曲目`
  } catch (error) {
    repairMessage.value = error instanceof Error ? error.message : '重新匹配流媒体元数据失败'
  }
}

const {
  showContextMenu,
  menuX,
  menuY,
  selectedTrack,
  canViewSelectedContext,
  canPlayNextSelectedTrack,
  handlePlayNext,
  handleViewArtist,
  handleViewAlbum,
  showPlaylistSubmenu,
  showCreatePlaylistDialog,
  newPlaylistName,
  onContextMenu,
  handleOpenFolder,
  canRematchSelectedTrack,
  handleRematchTrack,
  canRematchMetadataSelectedTrack,
  handleRematchMetadata,
  canClearMetadataMatchSelectedTrack,
  handleClearMetadataMatch,
  openCreatePlaylistDialog,
  handleCreatePlaylist,
  completeCreatePlaylistDialog,
  handleDeletePlaylist,
  closeContextMenu,
  showAggregateSubmenu,
  handleAddToAggregatePlaylist,
  handleCreateAggregatePlaylistFromMenu
} = useSongListContextMenu({
  currentPlaylistName,
  removeTrack,
  addToPlaylist,
  removeFromPlaylist,
  rematchTrack: handleManualRematch,
  rematchMetadata: handleMetadataRematch,
  clearMetadataMatch: async (track) => {
    if (!databaseTableEnabled.value) {
      clearTrackMetadataMatch(track.id)
      return
    }
    try {
      const expectedVersion = databasePageForTrack(track)?.versions[track.id]
      if (expectedVersion === undefined) throw new Error('曲目窗口已变化，请刷新后重试')
      await window.api.library.database.patchTracks([
        { id: track.id, expectedVersion, patch: { metadataMatch: null } }
      ])
    } catch (error) {
      repairMessage.value = error instanceof Error ? error.message : String(error)
    }
  },
  createPlaylist,
  deletePlaylist,
  playNext: playNextTrack,
  viewArtist: (track) => {
    const artist = track.artist.trim()
    if (!artist) return
    emit('selectView', 'artists', `artist:${artist}`)
  },
  viewAlbum: (track) => {
    const album = track.album?.trim()
    if (!album) return
    if (libraryStorage.mode.value === 'sqlite') {
      void openDatabaseAlbum(track)
      return
    }
    const albumItem = albums.value.find((item) =>
      item.tracks.some((albumTrack) => albumTrack.id === track.id)
    )
    if (!albumItem?.id) return
    emit('selectView', 'albums', `album:${albumItem.id}`)
  },
  addToAggregatePlaylist: (playlistId) => {
    void addActionSourceToPlaylist(playlistId, captureActionSource(contextTracksForAction()))
  },
  createAggregatePlaylist: () => {
    const source = captureActionSource(contextTracksForAction())
    if (!source.count) return
    createAggregateSource.value = source
    showCreateAggregateDialog.value = true
  }
})

let albumNavigationIntent = 0
watch(currentLibraryViewKey, () => {
  albumNavigationIntent++
})
onBeforeUnmount(() => {
  albumNavigationIntent++
})
async function openDatabaseAlbum(track: Track): Promise<void> {
  const intent = ++albumNavigationIntent
  try {
    const result = await window.api.library.database.queryCollections('albums', {
      ids: [track.id],
      limit: 1
    })
    if (intent !== albumNavigationIntent) return
    const album = result.items[0]
    if (!album) throw new Error('此歌曲已不在曲库中，请刷新后重试')
    emit('selectView', 'albums', `album:${album.id}`)
  } catch (error) {
    if (intent === albumNavigationIntent)
      repairMessage.value = error instanceof Error ? error.message : String(error)
  }
}

const showCreateAggregateDialog = ref(false)
const createAggregateSource = shallowRef<SongListActionSource | null>(null)

function dismissCreateAggregateDialog(): void {
  showCreateAggregateDialog.value = false
  createAggregateSource.value = null
}

async function createSelectedAggregatePlaylist(
  name: string
): Promise<{ playlistId: string; addedCount: number }> {
  const source = createAggregateSource.value
  if (!source) throw new Error('歌曲选择已失效，请重新选择')
  let playlistId = ''
  const done = await withActionSource(
    source,
    async (lease, signal) => {
      playlistId = await createAggregatePlaylistWithTrackPages(
        name,
        async (append) => {
          await lease.tracks(append)
          return () => {
            source.guard()
            if (createAggregateSource.value !== source || !showCreateAggregateDialog.value)
              throw new Error('创建聚合歌单已取消')
          }
        },
        signal
      )
    },
    true
  )
  if (!done) throw new Error(repairMessage.value || '创建聚合歌单失败')
  return {
    playlistId,
    addedCount:
      aggregatePlaylists.value.find((playlist) => playlist.id === playlistId)?.trackIds.length ?? 0
  }
}

function onAggregatePlaylistCreated(_playlistId: string, addedCount: number): void {
  createAggregateSource.value = null
  repairMessage.value = addedCount > 0 ? `已创建聚合歌单并加入 ${addedCount} 首` : '已创建聚合歌单'
}

useEscapeToClose(showContextMenu, closeContextMenu)

// Query totals can arrive while out-in still displays the previous (shorter)
// table. Wait for the new view before restoring a deep absolute position.
const scrollViewReady = ref(true)
watch(
  currentLibraryViewKey,
  () => {
    scrollViewReady.value = false
  },
  { flush: 'sync' }
)

const {
  containerRef,
  tbodyRef,
  rowHeight,
  visibleRange,
  visibleTracks: legacyVisibleTracks,
  totalHeight,
  paddingTop,
  onScroll,
  updateViewportHeight,
  restoreScrollAndMeasure,
  scrollToTrack,
  scrollTop,
  viewportHeight
} = useSongListVirtualScroll({
  displayTracks: tableTracks,
  itemCount: tableTrackCount,
  restoreReady: computed(
    () =>
      scrollViewReady.value &&
      (!databaseTableCandidate.value ||
        libraryStorage.mode.value === 'json' ||
        (databaseTableEnabled.value && databasePageState.value.total !== null)) &&
      (!databaseGridKind.value ||
        libraryStorage.mode.value === 'json' ||
        (databaseGridEnabled.value && databaseCollectionState.value.total !== null))
  ),
  resetSources: [],
  viewIdentity: props.previewTracks ? undefined : currentLibraryViewKey,
  viewKey: props.previewTracks
    ? undefined
    : computed(() =>
        JSON.stringify([
          currentLibraryViewKey.value,
          debouncedSearchQuery.value,
          libraryViewState.value,
          databaseGridEnabled.value ? collectionViewState.value : null
        ])
      ),
  shouldResetOnSearch: showTable,
  debouncedSearchQuery
})
void containerRef.value
void tbodyRef.value
const visibleTracks = computed(() =>
  databaseTableEnabled.value
    ? Array.from(
        { length: visibleRange.value.end - visibleRange.value.start },
        (_, index) =>
          databasePages.trackAt(visibleRange.value.start + index) as unknown as Track | undefined
      )
    : legacyVisibleTracks.value
)
watch(
  [visibleRange, databaseTableEnabled, () => databasePageState.value.total],
  ([range, enabled, total]) => {
    if (enabled && total !== null) databasePages.setRange(range.start, range.end)
  },
  { flush: 'post' }
)

const providerTrackCovers = shallowRef(new Map<string, ProviderTrackCover | null>())
const providerCoverRequests = new Map<string, Promise<void>>()
const providerCoverTails = new Map<string, Promise<unknown>>()
const providerCoverController = new AbortController()
async function resolveMissingTrackCover(track: Track): Promise<void> {
  if (props.previewTracks) return
  if (track.cover || track.coverSource || track.coverSmall || track.coverSmallSource) return
  const source = getLogicalTrackSource(track)
  if (
    !source ||
    source === 'local' ||
    providerTrackCovers.value.has(track.id) ||
    providerCoverRequests.has(track.id)
  )
    return
  const provider = mediaProviders.get(source)
  if (!provider?.searchSongs) return
  const previous = providerCoverTails.get(source) ?? Promise.resolve()
  const task = previous
    .catch(() => undefined)
    .then(async () => {
      try {
        if (provider.isEnabled && !(await provider.isEnabled())) return
        const cover = await findExactProviderTrackCover(
          track,
          provider,
          providerCoverController.signal
        )
        if (providerCoverController.signal.aborted) return
        const next = new Map(providerTrackCovers.value)
        next.set(track.id, cover)
        while (next.size > 400) next.delete(next.keys().next().value!)
        providerTrackCovers.value = next
      } catch {
        if (!providerCoverController.signal.aborted) {
          const next = new Map(providerTrackCovers.value)
          next.set(track.id, null)
          providerTrackCovers.value = next
        }
      } finally {
        await new Promise((resolve) => setTimeout(resolve, 180))
      }
    })
  providerCoverTails.set(source, task)
  providerCoverRequests.set(
    track.id,
    task.then(() => undefined)
  )
  try {
    await providerCoverRequests.get(track.id)
  } finally {
    providerCoverRequests.delete(track.id)
    if (providerCoverTails.get(source) === task) providerCoverTails.delete(source)
  }
}
function displayTrackCover(track: Track): string | null {
  return (
    track.coverSmall ||
    track.cover ||
    providerTrackCovers.value.get(track.id)?.coverSmall ||
    providerTrackCovers.value.get(track.id)?.cover ||
    null
  )
}
function displayTrackCoverSource(track: Track): string | null {
  return (
    track.coverSmallSource ||
    track.coverSource ||
    providerTrackCovers.value.get(track.id)?.coverSmallSource ||
    providerTrackCovers.value.get(track.id)?.coverSource ||
    null
  )
}
watch(
  visibleTracks,
  (items) => {
    for (const track of items) if (track) void resolveMissingTrackCover(track)
  },
  { immediate: true }
)
onBeforeUnmount(() => providerCoverController.abort())

const databaseQuerySelection = computed(() =>
  databaseTableEnabled.value && databaseQuery.value
    ? {
        total: tableTrackCount.value,
        positions: new Map(
          tableTracks.value.map((track) => [
            tableTrackKey(track),
            tableRowPositions.value.get(toRaw(track)) ?? -1
          ])
        )
      }
    : null
)
const multiSelect = useTrackMultiSelect({
  tracks: tableTracks,
  keyForTrack: tableTrackKey,
  querySelection: () => {
    const query = databaseQuerySelection.value
    return query
      ? { total: query.total, positionForKey: (key) => query.positions.get(key) ?? null }
      : null
  },
  root: containerRef,
  resetSources: [
    () => props.category,
    () => props.filter,
    debouncedSearchQuery,
    recentSource,
    databasePages.selectionEpoch
  ],
  enabled: showTable,
  preserveSelectedTracks: () => databaseTableEnabled.value,
  snapshotTrack: snapshotSelectedTableTrack,
  selectionOrder: (track, index) => tableRowPositions.value.get(toRaw(track)) ?? index,
  rangeContext: () => databaseWindowPages.value.map((page) => page.offset).join(':')
})

const { selectedCount, hasSelection, isSelected, clearSelection, toggle, getSelectedTracks } =
  multiSelect
watch(() => databasePageState.value.generation, closeContextMenu)

// SQL action intent contains positions, not a renderer copy of the full result.
// Legacy explicit cross-window callers can still supply retained absolute
// positions; query-mode consumers never request the selected Track array.
function captureActionSource(actionTracks?: Track[]): SongListActionSource {
  const unavailable = (message: string) => {
    repairMessage.value = message
    return createSongListActionSource({ rows: [] }, () => {
      throw new Error(message)
    })
  }
  const selectionVersion = multiSelect.selectionVersion.value
  const view = currentLibraryViewKey.value
  const mode = libraryStorage.mode.value
  const queryKey = JSON.stringify(databaseQuery.value)
  const guard = () => {
    if (
      view !== currentLibraryViewKey.value ||
      mode !== libraryStorage.mode.value ||
      queryKey !== JSON.stringify(databaseQuery.value) ||
      selectionVersion !== multiSelect.selectionVersion.value
    )
      throw new Error('歌曲选择或视图已变化，请重新操作')
  }
  if (databaseTableEnabled.value) {
    const page = databasePageState.value.page
    const query = databaseQuery.value
    const total = databasePageState.value.total
    if (!page || !query || total === null) return unavailable('歌曲查询尚未准备完成，请稍后重试')
    let ranges: LibrarySelectionRange[] =
      actionTracks === undefined ? (multiSelect.getSelectedRanges() ?? []) : []
    if (actionTracks !== undefined || multiSelect.getSelectedRanges() === null) {
      for (const track of actionTracks ?? getSelectedTracks()) {
        const position =
          selectedTableRows.get(toRaw(track))?.position ?? tableRowPositions.value.get(toRaw(track))
        if (position === undefined || position < 0 || position >= total)
          return unavailable('所选歌曲位置已失效，请重新选择')
        ranges = addSelectionRange(ranges, position, position + 1)
      }
    }
    return createSongListActionSource(
      {
        api: window.api.library.database,
        request: {
          query: { ...query, contentRevision: page.revision },
          total,
          ranges
        }
      },
      guard
    )
  }
  return createSongListActionSource(
    {
      rows: (actionTracks ?? getSelectedTracks()).map((track) => ({
        track,
        definitionId: track.id
      }))
    },
    guard
  )
}

let activeSelectionAction: AbortController | null = null
watch([currentLibraryViewKey, () => libraryStorage.mode.value], () =>
  activeSelectionAction?.abort()
)
onBeforeUnmount(() => activeSelectionAction?.abort())
async function withActionSource(
  source: SongListActionSource,
  action: (lease: SongListActionLease, signal: AbortSignal) => Promise<void | boolean>,
  clear = false
): Promise<boolean> {
  if (libraryMutationPending.value || !source.count) return false
  const version = multiSelect.selectionVersion.value
  const controller = new AbortController()
  activeSelectionAction = controller
  libraryMutationPending.value = true
  closeContextMenu()
  try {
    const lease = await source.open(controller.signal)
    try {
      source.guard()
      const completed = (await action(lease, controller.signal)) !== false
      if (completed && clear && multiSelect.selectionVersion.value === version) clearSelection()
      return completed
    } finally {
      await lease.close()
    }
  } catch (error) {
    repairMessage.value = error instanceof Error ? error.message : '所选歌曲操作失败'
    return false
  } finally {
    activeSelectionAction = null
    libraryMutationPending.value = false
  }
}

const {
  playlistImportInput,
  playlistCoverInput,
  playlistExportFormat,
  playlistRepairPending,
  playlistDialog,
  playlistDialogError,
  playlistMoveTargets,
  dismissPlaylistDialog,
  confirmPlaylistDialog,
  triggerPlaylistImport,
  handlePlaylistImport,
  downloadPlaylistDocument,
  triggerPlaylistCoverPicker,
  handlePlaylistCover,
  handleRenamePlaylist,
  handleCopyPlaylist,
  handleMoveSelectedWithinPlaylist,
  handlePlaylistDragStart,
  handlePlaylistDrop,
  handleMoveSelectedToPlaylist,
  handlePlaylistRepair
} = usePlaylistLifecycleActions({
  currentPlaylist,
  isPlaylistDetail,
  repairMessage,
  getSelectedTracks: () => getSelectedTracks().map(playlistDefinitionTrack),
  isSelected: (id) => getSelectedTracks().some((track) => playlistDefinitionTrack(track).id === id),
  clearSelection,
  definitionTrack: playlistDefinitionTrack,
  streamingSelection: {
    enabled: () => databaseTableEnabled.value,
    capture: (track) =>
      captureActionSource(track && !isSelected(tableTrackKey(track)) ? [track] : undefined),
    run: withActionSource
  },
  selectPlaylist: (name) => emit('selectView', 'playlists', `playlist:${name}`)
})
void playlistImportInput.value
void playlistCoverInput.value

const pendingBatchCreateSource = shallowRef<SongListActionSource | null>(null)

function absoluteIndex(indexInVisible: number, track?: Track): number {
  if (databaseTableEnabled.value && track) return tableTracks.value.indexOf(toRaw(track))
  return visibleRange.value.start + indexInVisible
}

function onRowClick(track: Track, indexInVisible: number, event: MouseEvent): void {
  const target = event.target as HTMLElement
  if (target.closest('.btn-remove')) return
  if (target.closest('.track-select-checkbox')) return
  if (event.detail > 1) return
  const index = absoluteIndex(indexInVisible, track)
  const result = multiSelect.onRowClick(track, index, event)
  if (result !== 'play') return
  if (track.source === 'network' && !databaseTableEnabled.value) {
    void playNetworkTrack(track)
    return
  }
  if (settingsStore.settings.value.trackActivationMode === 'doubleClick') return
  playTableTrack(track)
}

function onRowKeydown(track: Track, index: number, event: KeyboardEvent): void {
  const action = trackRowKeyAction(event)
  if (action === 'select') toggle(tableTrackKey(track), absoluteIndex(index, track), track)
  if (action !== 'play') return
  if (track.source === 'network' && !databaseTableEnabled.value) void playNetworkTrack(track)
  else playTableTrack(track)
}

function onTrackSelectToggle(track: Track, indexInVisible: number, event: Event): void {
  event.stopPropagation()
  toggle(tableTrackKey(track), absoluteIndex(indexInVisible, track), track)
}

function onTrackContextMenu(event: MouseEvent, track: Track): void {
  onContextMenu(event, track)
}

function customizeLibraryAppearance(): void {
  closeContextMenu()
  emit('customizeAppearance')
}

const contextUsesSelection = computed(
  () =>
    !!selectedTrack.value &&
    isSelected(tableTrackKey(selectedTrack.value)) &&
    selectedCount.value > 0
)
const contextActionTracks = computed(() =>
  contextUsesSelection.value
    ? getSelectedTracks()
    : selectedTrack.value
      ? [selectedTrack.value]
      : []
)
function contextTracksForAction(): Track[] | undefined {
  return contextUsesSelection.value ? undefined : selectedTrack.value ? [selectedTrack.value] : []
}
const contextActionCount = computed(() =>
  contextUsesSelection.value ? selectedCount.value : selectedTrack.value ? 1 : 0
)
const contextActionLabel = computed(() =>
  contextActionCount.value > 1 ? ` (${contextActionCount.value})` : ''
)

async function handleContextCopyTrackNames(): Promise<void> {
  const source = captureActionSource(contextTracksForAction())
  await withActionSource(source, async (lease) => {
    await copyTrackNamePages(lease.tracks)
  })
}

const contextAllFavorited = computed(() => {
  if (databaseTableEnabled.value && contextUsesSelection.value) return null
  const targets = contextActionTracks.value
  return targets.length > 0 && targets.every((track) => isFavoriteTrack(track))
})
const contextLocalTrackCount = computed(() =>
  databaseTableEnabled.value && contextUsesSelection.value
    ? null
    : selectLocalLibraryActionTracks(contextActionTracks.value).length
)
const contextLocalActionLabel = computed(() =>
  contextLocalTrackCount.value !== null && contextLocalTrackCount.value > 1
    ? ` (${contextLocalTrackCount.value})`
    : ''
)

const selectionAllFavorited = computed(() => {
  if (databaseTableEnabled.value) return null
  const selected = getSelectedTracks()
  return selected.length > 0 && selected.every((track) => isFavoriteTrack(track))
})
const selectedLocalTrackCount = computed(() =>
  databaseTableEnabled.value ? null : selectLocalLibraryActionTracks(getSelectedTracks()).length
)
const localSelectionActionLabel = computed(() =>
  selectedLocalTrackCount.value !== null && selectedLocalTrackCount.value > 1
    ? ` (${selectedLocalTrackCount.value})`
    : ''
)

async function runLocalLibraryRemoval(
  mode: 'library' | 'trash',
  actionTracks?: Track[]
): Promise<void> {
  if (libraryMutationPending.value) return
  if (databaseTableEnabled.value) {
    const source = captureActionSource(actionTracks)
    await withActionSource(
      source,
      async (lease, signal) => {
        if (!lease.fileCount) return false
        const prompt =
          mode === 'library'
            ? `确定从音乐库移除选中的 ${lease.fileCount} 个本地文件？\n文件仍保留在磁盘；共享文件中的 CUE 曲目会一并移除，可在「已从音乐库移除」中恢复。`
            : `确定将选中的 ${lease.fileCount} 个本地文件移到系统回收站吗？共享文件中的 CUE 曲目会一并移除；失败的文件会继续保留在音乐库中。`
        if (!window.confirm(prompt)) return false
        await removeDatabaseSelectionFiles(lease, mode, signal)
        return true
      },
      true
    )
    return
  }
  const selected = selectLocalLibraryActionTracks(actionTracks ?? getSelectedTracks())
  if (selected.length === 0) return
  if (
    mode === 'library' &&
    !window.confirm(
      `确定从音乐库移除选中的 ${selected.length} 首？\n文件仍保留在磁盘，不会删除；可在「已从音乐库移除」中恢复。`
    )
  ) {
    return
  }
  if (
    mode === 'trash' &&
    !window.confirm(
      `确定将选中的 ${selected.length} 个本地文件移到系统回收站吗？失败的文件会继续保留在音乐库中。`
    )
  ) {
    return
  }

  libraryMutationPending.value = true
  try {
    const result = await removeLocalTracks(selected, mode)
    const action = mode === 'trash' ? '移到回收站' : '从音乐库移除'
    repairMessage.value = `${action} ${result.removedTrackIds.length} 首${
      result.failures.length > 0 ? `，${result.failures.length} 项失败` : ''
    }`
    if (result.failures.length > 0) {
      const details = result.failures
        .slice(0, 8)
        .map((failure) => `${failure.filePath}\n${failure.message}`)
        .join('\n\n')
      window.alert(`${action}未全部完成：\n\n${details}`)
    }
    clearSelection()
    closeContextMenu()
  } catch (error) {
    repairMessage.value = error instanceof Error ? error.message : '本地音乐库操作失败'
  } finally {
    libraryMutationPending.value = false
  }
}

async function removeDatabaseSelectionFiles(
  lease: SongListActionLease,
  mode: 'library' | 'trash',
  signal: AbortSignal
): Promise<void> {
  let removed = 0,
    failed = 0
  const details: string[] = []
  try {
    await lease.forEachPage(async (rows) => {
      if (signal.aborted) throw new Error('选择操作已取消')
      if (mode === 'trash')
        await prepareLocalTracksForRemoval(
          rows.map(({ track }) => track.id),
          rows.map(({ track }) => track.filePath)
        )
      if (signal.aborted) throw new Error('选择操作已取消')
      const result = await window.api.library.database.removeFiles({
        mode,
        items: rows.map(({ track, version, instance }) => {
          if (version === undefined || instance === undefined)
            throw new Error('本地文件选择缺少版本身份，请重新选择')
          return {
            id: track.id,
            filePath: track.filePath,
            title: track.title,
            artist: track.artist,
            expectedVersion: version,
            expectedInstance: instance
          }
        })
      })
      // Confirmed results are published before another page is read. Never
      // retain the entire removal result or replay a lost destructive reply.
      removed += result.removedTrackIds.length
      failed += result.failures.length
      for (const failure of result.failures)
        if (details.length < 8) details.push(`${failure.filePath}\n${failure.message}`)
      notifyLocalTracksUnavailable(result.removedTrackIds, result.removedFilePaths)
      databasePages.invalidate(result.metadata.revision)
    }, 'files')
  } catch (error) {
    databasePages.invalidate()
    throw new Error(
      `已确认移除 ${removed} 首，${failed} 项失败；操作中断，请刷新后检查，不要直接重试未知批次：${error instanceof Error ? error.message : String(error)}`
    )
  }
  const action = mode === 'trash' ? '移到回收站' : '从音乐库移除'
  repairMessage.value = `${action} ${removed} 首${failed ? `，${failed} 项失败` : ''}`
  if (details.length) window.alert(`${action}未全部完成：\n\n${details.join('\n\n')}`)
}

async function handleRestoreExclusions(filePaths: string[]): Promise<void> {
  if (exclusionRestorePending.value || filePaths.length === 0) return
  exclusionRestorePending.value = true
  try {
    const restoredCount = await restoreExcludedTracks(filePaths)
    repairMessage.value = `已恢复 ${restoredCount} 个排除项`
    if (excludedTracks.value.length === 0) showExcludedTracksDialog.value = false
  } catch (error) {
    repairMessage.value = error instanceof Error ? error.message : '恢复排除项失败'
  } finally {
    exclusionRestorePending.value = false
  }
}

async function handleClearExclusions(): Promise<void> {
  if (exclusionRestorePending.value || excludedTracks.value.length === 0) return
  if (
    !window.confirm(
      `确定清除这 ${excludedTracks.value.length} 条已移除记录吗？文件不会被删除；清除后可重新扫描并重新加入音乐库。`
    )
  ) {
    return
  }
  exclusionRestorePending.value = true
  try {
    const clearedCount = await clearExcludedTracks(
      excludedTracks.value.map((item) => item.filePath)
    )
    repairMessage.value = `已清除 ${clearedCount} 条移除记录`
    if (excludedTracks.value.length === 0) showExcludedTracksDialog.value = false
  } catch (error) {
    repairMessage.value = error instanceof Error ? error.message : '清除移除记录失败'
  } finally {
    exclusionRestorePending.value = false
  }
}

function excludedTrackLabel(filePath: string, title: string): string {
  return title || filePath.split(/[\\/]/).pop() || filePath
}

function formatExcludedAt(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString() : ''
}

async function appendActionTracksToQueue(actionTracks?: Track[]): Promise<void> {
  if (actionTracks?.length === 0 || libraryMutationPending.value) return
  if (databaseTableEnabled.value) {
    const source = captureActionSource(actionTracks)
    await withActionSource(
      source,
      async (lease, signal) => {
        await playbackStore.appendLibraryQueuePages(
          async (append) => {
            await lease.forEachPage((rows) =>
              append(
                rows.map(({ track }) => ({
                  id: track.id,
                  ...(getTrackSource(track) === 'local'
                    ? {}
                    : { snapshot: toPlaylistTrackSnapshot(track) as unknown as LibraryTrackRecord })
                }))
              )
            )
          },
          true,
          { signal, guard: source.guard }
        )
        repairMessage.value = `已添加 ${lease.count} 首到播放队列`
      },
      true
    )
    return
  }
  const selectionIntent = multiSelect.selectionVersion.value
  const selected = actionTracks ?? getSelectedTracks()
  libraryMutationPending.value = true
  closeContextMenu()
  try {
    await playbackStore.appendQueueTracksAsync(selected)
    repairMessage.value = `已添加 ${selected.length} 首到播放队列`
    if (multiSelect.selectionVersion.value === selectionIntent) clearSelection()
  } catch (error) {
    repairMessage.value = error instanceof Error ? error.message : '添加到播放队列失败'
  } finally {
    libraryMutationPending.value = false
  }
}

async function removeActionTracksFromCurrentPlaylist(actionTracks?: Track[]): Promise<void> {
  const playlistName = currentPlaylistName.value
  if (!playlistName || actionTracks?.length === 0) return
  if (databaseTableEnabled.value) {
    const playlist = currentPlaylist.value
    if (!playlist) return
    const source = captureActionSource(actionTracks)
    await withActionSource(
      source,
      async (lease, signal) => {
        const removed = await removeTrackIdPagesFromPlaylistById(playlist.id, lease.ids, signal)
        repairMessage.value = `已从歌单移除 ${removed} 首`
      },
      true
    )
    return
  }
  removeTracksFromPlaylist(
    playlistName,
    (actionTracks ?? getSelectedTracks()).map((track) => playlistDefinitionTrack(track).id)
  )
  clearSelection()
  closeContextMenu()
}

function handleBatchRemoveFromPlaylist(): void {
  void removeActionTracksFromCurrentPlaylist()
}

async function favoriteActionTracks(actionTracks?: Track[]): Promise<void> {
  if (actionTracks?.length === 0) return
  if (databaseTableEnabled.value) {
    const source = captureActionSource(actionTracks)
    await withActionSource(source, async (lease, signal) => {
      const state = await readFavoriteTrackPages(lease.tracks, signal)
      const favorite = state.favoriteCount !== state.count
      const changed = await setFavoriteTrackPages(lease.tracks, favorite, signal)
      repairMessage.value = favorite
        ? `已加入应用收藏 ${changed} 首`
        : `已移出应用收藏 ${changed} 首`
    })
    return
  }
  const selected = actionTracks ?? getSelectedTracks()
  if (selected.every((track) => isFavoriteTrack(track))) {
    setFavoriteTracks(selected, false)
  } else {
    setFavoriteTracks(selected, true)
  }
  closeContextMenu()
}

function handleBatchFavorite(): void {
  void favoriteActionTracks()
}

async function addActionTracksToPlaylist(
  playlistName: string,
  actionTracks?: Track[]
): Promise<void> {
  if (actionTracks?.length === 0) return
  if (databaseTableEnabled.value) {
    const playlist = localPlaylists.value.find((item) => item.name === playlistName)
    if (!playlist) return
    await addActionSourceToPlaylist(playlist.id, captureActionSource(actionTracks))
    return
  }
  addTracksToPlaylist(playlistName, actionTracks ?? getSelectedTracks())
  closeContextMenu()
}

async function addActionSourceToPlaylist(
  playlistId: string,
  source: SongListActionSource
): Promise<void> {
  await withActionSource(source, async (lease, signal) => {
    const added = await addTrackPagesToPlaylistById(playlistId, lease.tracks, signal)
    repairMessage.value = added ? `已加入歌单 ${added} 首` : '歌单里已经有这些歌了'
  })
}

function handleBatchCreatePlaylistFromMenu(actionTracks?: Track[]): void {
  if (actionTracks?.length === 0) return
  const source = captureActionSource(actionTracks)
  if (!source.count) return
  pendingBatchCreateSource.value = source
  openCreatePlaylistDialog()
}

function dismissCreatePlaylistDialog(): void {
  pendingBatchCreateSource.value = null
  completeCreatePlaylistDialog()
}

async function handleConfirmCreatePlaylist(): Promise<void> {
  const name = newPlaylistName.value.trim()
  if (!name) return
  const source = pendingBatchCreateSource.value
  if (source) {
    const done = await withActionSource(
      source,
      async (lease, signal) => {
        await createPlaylistWithTrackPages(
          name,
          async (append) => {
            await lease.tracks(append)
            return () => {
              source.guard()
              if (pendingBatchCreateSource.value !== source || !showCreatePlaylistDialog.value)
                throw new Error('创建歌单已取消')
            }
          },
          signal
        )
      },
      true
    )
    if (done && pendingBatchCreateSource.value === source) {
      pendingBatchCreateSource.value = null
      completeCreatePlaylistDialog()
    }
    return
  }
  handleCreatePlaylist()
}

function handleContextRemoveFromLibrary(): void {
  void runLocalLibraryRemoval('library', contextTracksForAction())
}

function handleContextMoveToTrash(): void {
  void runLocalLibraryRemoval('trash', contextTracksForAction())
}

function handleContextRemoveFromPlaylist(): void {
  void removeActionTracksFromCurrentPlaylist(contextTracksForAction())
}

function handleContextFavorite(): void {
  void favoriteActionTracks(contextTracksForAction())
}

function handleContextAddToPlaylist(playlistName: string): void {
  void addActionTracksToPlaylist(playlistName, contextTracksForAction())
}

function handleContextCreatePlaylist(): void {
  handleBatchCreatePlaylistFromMenu(contextTracksForAction())
}

const canContinueFromBookmark = computed(() => {
  const track = selectedTrack.value
  if (!track || contextActionCount.value > 1) return false
  return (
    !!playbackBookmarks.resumeBookmarkFor(track) || playbackBookmarks.bookmarksFor(track).length > 0
  )
})

function handleContinueFromBookmark(): void {
  const track = selectedTrack.value
  if (!track) return
  const resume =
    playbackBookmarks.resumeBookmarkFor(track) ?? playbackBookmarks.bookmarksFor(track)[0]
  if (!resume) return
  closeContextMenu()
  if (databaseTableEnabled.value) {
    const query = databasePlaybackQuery(track)
    if (query)
      void playbackStore.playLibraryQuery(
        query,
        track.id,
        databasePlaybackOptions(query, {
          positionSeconds: resume.positionSeconds
        })
      )
  } else playTrackFromPosition(track, resume.positionSeconds, displayTracks.value)
}

function handleToolbarRemoveFromLibrary(): void {
  void runLocalLibraryRemoval('library')
}

function handleToolbarMoveToTrash(): void {
  void runLocalLibraryRemoval('trash')
}

function handleToolbarFavorite(): void {
  handleBatchFavorite()
}

async function openTagManager(initialView: 'edit' | 'duplicates' = 'edit'): Promise<void> {
  if (databaseTableEnabled.value && initialView === 'edit') {
    const source = captureActionSource()
    await withActionSource(source, async (lease) => {
      const selected = await readSongListTagTargets(lease)
      source.guard()
      if (!selected.length) return
      tagManagerFocusRestoreTarget.value =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      tagManagerTracks.value = selected
      tagManagerContentRevision.value = lease.revision ?? null
      tagManagerInitialView.value = initialView
      showTagManager.value = true
    })
    return
  }
  const selected = databaseTableEnabled.value
    ? []
    : selectLocalLibraryActionTracks(getSelectedTracks())
  tagManagerFocusRestoreTarget.value =
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  tagManagerTracks.value = selected
  tagManagerContentRevision.value = null
  tagManagerInitialView.value = initialView
  showTagManager.value = true
  closeContextMenu()
}

function closeLibraryToolsMenuDelayed(): void {
  setTimeout(() => {
    libraryToolsMenuOpen.value = false
  }, 150)
}

function openLibraryDuplicates(): void {
  libraryToolsMenuOpen.value = false
  openTagManager('duplicates')
}

async function openMusicVersions(): Promise<void> {
  if (musicVersionsOpening.value) return
  libraryToolsMenuOpen.value = false
  musicVersionsOpening.value = true
  const view = currentLibraryViewKey.value
  try {
    musicVersionsInitialTrack.value = undefined
    if (isAlbumDetail.value) {
      if (!props.previewTracks && libraryStorage.mode.value !== 'json') {
        if (libraryStorage.mode.value !== 'sqlite') throw new Error('无法确认曲库存储，请重试读取')
        const page = await window.api.library.database.queryTracks({
          albumId: props.filter!.slice(6),
          sort: 'trackNumber',
          limit: 1
        })
        if (page.tracks[0]) musicVersionsInitialTrack.value = libraryTrack(page.tracks[0])
      } else musicVersionsInitialTrack.value = displayTracks.value[0]
    }
    if (view === currentLibraryViewKey.value) showMusicVersions.value = true
  } catch (error) {
    repairMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    musicVersionsOpening.value = false
  }
}

function openLibraryInbox(): void {
  showLibraryInbox.value = true
  libraryToolsMenuOpen.value = false
}

function openLibraryExcluded(): void {
  libraryToolsMenuOpen.value = false
  showExcludedTracksDialog.value = true
}

function closeTagManager(): void {
  showTagManager.value = false
  const target = tagManagerFocusRestoreTarget.value
  tagManagerFocusRestoreTarget.value = null
  void nextTick(() => {
    if (target?.isConnected) target.focus()
  })
}

const pendingTagRecheckPaths = ref<string[]>([])
const tagRecheckPending = ref(false)
let tagRecheckGeneration = 0

async function applyTagManagerWrite(
  filePaths: string[],
  patch: LocalLibraryTagPatch
): Promise<void> {
  if (!libraryStorage.mode.value) await libraryStorage.load()
  if (!libraryStorage.mode.value) {
    pendingTagRecheckPaths.value = [...new Set([...pendingTagRecheckPaths.value, ...filePaths])]
    repairMessage.value = `标签已写入，无法确认曲库存储：${libraryStorage.error.value}`
    return
  }
  if (libraryStorage.mode.value === 'sqlite') {
    pendingTagRecheckPaths.value = [...new Set([...pendingTagRecheckPaths.value, ...filePaths])]
    tagRecheckGeneration++
    await recheckWrittenTags()
    return
  }
  const changed = applyLocalTagWrite(filePaths, patch)
  repairMessage.value =
    changed > 0 ? `已更新 ${changed} 首本地歌曲的本地视图` : '标签已写入，等待下次扫描刷新本地视图'
}

async function recheckWrittenTags(): Promise<void> {
  if (tagRecheckPending.value || !pendingTagRecheckPaths.value.length) return
  tagRecheckPending.value = true
  const generation = tagRecheckGeneration
  try {
    await libraryStorage.load()
    if (libraryStorage.mode.value !== 'sqlite')
      throw new Error(libraryStorage.error.value || '请重新扫描已写入标签的文件夹')
    repairMessage.value = '标签已写入，正在检查受影响目录'
    const update = await scanLibraryDirectories({
      directories: libraryDirectoriesForFiles(pendingTagRecheckPaths.value),
      reason: 'tags'
    })
    if (update.state === 'completed' && generation === tagRecheckGeneration) {
      pendingTagRecheckPaths.value = []
      repairMessage.value = '标签检查已完成'
    } else {
      repairMessage.value = '标签检查尚未完成，可继续扫描或重试目录检查'
    }
  } catch (error) {
    repairMessage.value = `标签已写入，目录检查未完成：${error instanceof Error ? error.message : String(error)}；可在当前扫描结束后重试`
  } finally {
    tagRecheckPending.value = false
  }
}

const {
  filteredGridItems,
  gridTotalCount,
  visibleGridSlots,
  gridDataRange,
  gridRowGap,
  gridPaddingTop,
  gridPaddingBottom,
  showPlaylistCreateCard,
  gridColumns,
  gridRowStride,
  gridOffsetTop,
  renderGridThroughIndex,
  localTransitionName,
  viewKey,
  isSwitching,
  onViewBeforeLeave,
  finishViewSwitch
} = useSongListGridRendering({
  category: () => props.category,
  filter: () => props.filter,
  transitionName: () => props.transitionName,
  debouncedSearchQuery,
  currentGridItems,
  serverFiltered: databaseGridEnabled,
  itemCount: computed(() => databaseCollectionState.value.total ?? 0),
  itemAt: (index) => databaseCollections.itemAt(index),
  showGrid,
  updateViewportHeight,
  containerRef,
  scrollTop,
  viewportHeight
})

const availableIndexLetters = computed(() =>
  databaseGridEnabled.value
    ? new Set(Object.keys(databaseCollections.letterOffsets.value))
    : availableCollectionLetters(filteredGridItems.value)
)
watch(
  [gridDataRange, databaseGridEnabled, () => databaseCollectionState.value.total],
  ([range, enabled, total]) => {
    if (enabled && total !== null) databaseCollections.setRange(range.start, range.end)
  },
  { flush: 'post' }
)

useLocatePlayingTrack({
  containerRef,
  tbodyRef,
  displayTracks,
  // Application playlists and device history can retain online snapshots.
  libraryTracks: computed(() =>
    props.category === 'playlists' || props.category === 'recent'
      ? displayTracks.value
      : tracks.value
  ),
  currentTrack,
  enabled: computed(
    () =>
      showTable.value &&
      !isSwitching.value &&
      (!databaseTableEnabled.value ||
        isPlaylistDetail.value ||
        (!!currentTrack.value && getLogicalTrackSource(currentTrack.value) === 'local'))
  ),
  rowHeight,
  database: { enabled: databaseTableEnabled, locate: locateCurrentTrack }
})

function collectionLetterDisabled(letter: string): boolean {
  return !availableIndexLetters.value.has(letter)
}

function jumpToCollectionLetter(letter: string): void {
  if (!isCollectionGrid.value || collectionLetterDisabled(letter)) return
  if (databaseGridEnabled.value) {
    const index = databaseCollections.letterOffsets.value[letter]
    if (index === undefined) return
    renderGridThroughIndex(index)
    activeCollectionLetter.value = letter
    return
  }
  const index = firstCollectionIndexForLetter(filteredGridItems.value, letter)
  if (index < 0) return
  activeCollectionLetter.value = letter
  renderGridThroughIndex(index)
}

function updateActiveCollectionLetter(): void {
  if (!isCollectionGrid.value) return
  const index =
    Math.max(
      0,
      Math.floor((scrollTop.value + 104 - gridOffsetTop.value) / Math.max(1, gridRowStride.value))
    ) * Math.max(1, gridColumns.value)
  const next = databaseGridEnabled.value
    ? (Object.entries(databaseCollections.letterOffsets.value)
        .filter(([, offset]) => offset <= index)
        .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null)
    : (collectionLetterAtScroll(
        filteredGridItems.value,
        scrollTop.value,
        gridOffsetTop.value,
        gridColumns.value,
        gridRowStride.value
      ) ?? collectionIndexLetter(filteredGridItems.value[0]?.name ?? ''))
  if (next === activeCollectionLetter.value) return
  activeCollectionLetter.value = next
}

let collectionLetterFrame: number | null = null
function onSongListScroll(event: Event): void {
  onScroll(event)
  if (collectionLetterFrame !== null) return
  collectionLetterFrame = window.requestAnimationFrame(() => {
    collectionLetterFrame = null
    updateActiveCollectionLetter()
  })
}

onBeforeUnmount(() => {
  if (collectionLetterFrame !== null) window.cancelAnimationFrame(collectionLetterFrame)
  collectionLetterFrame = null
})

watch([filteredGridItems, () => props.category], updateActiveCollectionLetter)

watch([scrollTop, gridDataRange], () => {
  if (isCollectionGrid.value) updateActiveCollectionLetter()
})

function getTrackSource(track: Pick<Track, 'id' | 'source'>): string {
  if (track.source) return track.source
  if (/^[a-zA-Z]:[\\/]/.test(track.id) || /^[\\/]/.test(track.id)) return 'local'
  const separatorIndex = track.id.indexOf(':')
  return separatorIndex > 0 ? track.id.slice(0, separatorIndex) : 'local'
}
function openRowArtist(track: Track): void {
  selectedTrack.value = track
  handleViewArtist()
}

function openRowAlbum(track: Track): void {
  selectedTrack.value = track
  handleViewAlbum()
}

const infoTrack = shallowRef<Track | null>(null)
const sourcePickerTrack = shallowRef<Track | null>(null)

function openSourcePicker(track: Track | null): void {
  if (!track) return
  sourcePickerTrack.value = track
}

function applySourceSelection(replacement: Track): void {
  const original = sourcePickerTrack.value
  if (!original) return
  const replacedCount = replaceTrackReference(original.id, replacement)
  repairMessage.value = replacedCount
    ? `已切换到 ${replacement.source || '本地音乐'}：${replacement.title || original.title}`
    : `已选择 ${replacement.title || original.title}，但没有需要替换的歌单引用`
  sourcePickerTrack.value = null
}

function openSelectedSourcePicker(): void {
  openSourcePicker(selectedTrack.value)
  closeContextMenu()
}

function beginViewSwitch(): void {
  scrollViewReady.value = false
  onViewBeforeLeave()
}

function finishViewSwitchAndRestoreScroll(): void {
  finishViewSwitch()
  scrollViewReady.value = true
  restoreScrollAndMeasure()
}

function locateCurrentTrack(): void {
  if (databaseTableEnabled.value && currentTrack.value) {
    databasePages.locate(currentTrack.value.id)
    return
  }
  const index = tableTracks.value.findIndex((track) => track.id === currentTrack.value?.id)
  if (index >= 0) scrollToTrack(index)
}

watch(
  () => databasePageState.value.page,
  (page) => {
    if (!page || page.anchorIndex === undefined || page.anchorIndex < 0) return
    void nextTick(() => scrollToTrack(page.anchorIndex!))
  },
  { flush: 'post' }
)
</script>

<template>
  <div
    ref="containerRef"
    class="song-list"
    :class="{
      'has-player': props.hasPlayer,
      'is-switching': isSwitching,
      'playlist-library': category === 'playlists' && showGrid
    }"
    :style="{ height: '100vh' }"
    @scroll="onSongListScroll"
  >
    <div v-if="pendingTagRecheckPaths.length" class="tag-recheck-notice" role="status">
      <span>{{ repairMessage }}</span>
      <button type="button" :disabled="tagRecheckPending" @click="recheckWrittenTags">
        {{ tagRecheckPending ? '检查中…' : '重试标签目录检查' }}
      </button>
    </div>
    <Teleport to="body">
      <NativeDialogTransition>
        <TrackInfoDialog v-if="infoTrack" :track="infoTrack" @close="infoTrack = null" />
      </NativeDialogTransition>
      <TrackSourcePicker
        v-if="sourcePickerTrack"
        :track="sourcePickerTrack"
        @close="sourcePickerTrack = null"
        @select="applySourceSelection"
      />
    </Teleport>
    <Transition
      :name="localTransitionName"
      mode="out-in"
      @before-leave="beginViewSwitch"
      @after-enter="finishViewSwitchAndRestoreScroll"
      @enter-cancelled="finishViewSwitchAndRestoreScroll"
      @leave-cancelled="finishViewSwitchAndRestoreScroll"
    >
      <div :key="viewKey" :class="showGrid ? 'grid-view' : 'table-view'">
        <template v-if="showGrid">
          <div class="song-list-header">
            <div class="title-group">
              <div class="title-line">
                <h2 class="song-list-title">{{ viewTitle }}</h2>
                <span v-if="gridStatsText" class="view-stats">{{ gridStatsText }}</span>
              </div>
            </div>
            <div class="header-right">
              <div v-if="isCollectionGrid" class="collection-view-controls" aria-label="分类与排序">
                <label>
                  <span class="sr-only">排序方式</span>
                  <select
                    :value="collectionViewState.sort"
                    aria-label="排序方式"
                    @change="setCollectionSort(($event.target as HTMLSelectElement).value)"
                  >
                    <option value="name-asc">名称 A-Z</option>
                    <option value="name-desc">名称 Z-A</option>
                    <option value="added-newest">添加时间：最新优先</option>
                    <option value="added-oldest">添加时间：最旧优先</option>
                  </select>
                </label>
                <label v-if="databaseGridEnabled">
                  <span class="sr-only">按流派筛选</span>
                  <input
                    :value="collectionViewState.genre ?? ''"
                    list="library-genre-suggestions"
                    aria-label="按流派筛选"
                    placeholder="全部流派（输入筛选）"
                    title="从建议中选择或输入完整流派名，清空后显示全部流派"
                    @input="setCollectionGenre(($event.target as HTMLInputElement).value)"
                  />
                  <datalist id="library-genre-suggestions">
                    <option
                      v-for="genre in databaseGenreState.page?.items ?? []"
                      :key="genre.id"
                      :value="genre.name"
                    />
                  </datalist>
                </label>
                <label v-else>
                  <span class="sr-only">按流派筛选</span>
                  <select
                    :value="collectionViewState.genre ?? ''"
                    aria-label="按流派筛选"
                    @change="setCollectionGenre(($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">全部流派</option>
                    <option v-for="genre in collectionGenreOptions" :key="genre" :value="genre">
                      {{ genre }}
                    </option>
                  </select>
                </label>
              </div>
              <div class="search-box" :class="{ focused: searchInputFocused }">
                <ThemeIcon class="search-icon" icon-slot="library.search" />
                <input
                  v-model="searchQuery"
                  type="text"
                  class="search-input"
                  :placeholder="
                    category === 'playlists' && showGrid
                      ? '搜索歌单'
                      : '搜索歌曲、歌手、专辑或文件夹'
                  "
                  @focus="searchInputFocused = true"
                  @blur="searchInputFocused = false"
                />
                <button v-if="searchQuery" class="search-clear" @click="searchQuery = ''">
                  <ThemeIcon icon-slot="library.clear" />
                </button>
              </div>
            </div>
          </div>
          <div v-if="databaseGridEnabled" class="database-page-controls" aria-label="分类读取状态">
            <span role="status" aria-live="polite"
              >{{
                databaseCollectionState.total === null
                  ? '正在读取总数'
                  : gridStatsText || '共 0 项'
              }}{{
                databaseGridPending && databaseCollectionState.total !== null ? ' · 正在读取…' : ''
              }}</span
            >
            <button
              type="button"
              class="selection-btn ghost"
              :disabled="databaseGridPending"
              @click="databaseCollections.invalidate()"
            >
              刷新
            </button>
          </div>
          <p
            v-if="databaseGridEnabled && isCollectionGrid && databaseGenreState.error"
            class="repair-status"
            role="status"
          >
            流派建议读取失败：{{ databaseGenreState.error }}
            <button type="button" class="selection-btn" @click="databaseGenrePages.retry()">
              重试
            </button>
          </p>
          <p
            v-if="databaseGridError && databaseCollectionState.total !== null"
            class="repair-status"
            role="alert"
          >
            {{ databaseGridError }}
            <button type="button" class="selection-btn" @click="retryDatabaseCollections">
              重试
            </button>
          </p>
          <div
            v-if="databaseGridError && databaseCollectionState.total === null"
            class="empty-state"
            role="alert"
          >
            <p class="empty-text">分类读取失败</p>
            <p class="empty-hint">{{ databaseGridError }}</p>
            <button type="button" class="selection-btn" @click="retryDatabaseCollections">
              重试
            </button>
          </div>
          <div
            v-else-if="databaseGridPending && databaseCollectionState.total === null"
            class="empty-state"
            role="status"
          >
            <p class="empty-text">正在读取分类…</p>
          </div>
          <div
            v-else-if="
              databaseGridEnabled && category !== 'playlists' && collectionResultCount === 0
            "
            class="empty-state"
          >
            <p class="empty-text">
              {{
                searchQuery.trim() || (isCollectionGrid && collectionViewState.genre)
                  ? '没有符合条件的分类'
                  : '暂无内容'
              }}
            </p>
            <p class="empty-hint">
              {{
                searchQuery.trim() || (isCollectionGrid && collectionViewState.genre)
                  ? '请更改流派筛选或搜索条件'
                  : '打开左侧菜单，点击「导入歌曲」添加本地音乐。'
              }}
            </p>
          </div>
          <div
            v-else-if="!databaseGridEnabled && category === 'artists' && artists.length === 0"
            class="empty-state"
          >
            <p class="empty-text">暂无艺术家</p>
            <p class="empty-hint">打开左侧菜单，点击「导入歌曲」添加本地音乐。</p>
          </div>
          <div
            v-else-if="!databaseGridEnabled && category === 'albums' && albums.length === 0"
            class="empty-state"
          >
            <p class="empty-text">暂无专辑</p>
            <p class="empty-hint">打开左侧菜单，点击「导入歌曲」添加本地音乐。</p>
          </div>
          <div v-else-if="isCollectionGrid && gridTotalCount === 0" class="empty-state">
            <p class="empty-text">没有符合条件的{{ category === 'artists' ? '艺术家' : '专辑' }}</p>
            <p class="empty-hint">请更改流派筛选或搜索条件</p>
          </div>
          <div
            v-else-if="!databaseGridEnabled && category === 'genres' && genres.length === 0"
            class="empty-state"
          >
            <p class="empty-text">暂无流派</p>
            <p class="empty-hint">导入带流派标签的音乐，或完整重扫媒体库以回填</p>
          </div>
          <div
            v-else-if="!databaseGridEnabled && category === 'folders' && folders.length === 0"
            class="empty-state"
          >
            <div class="empty-icon">
              <ThemeIcon class="empty-library-icon" icon-slot="library.folder" />
            </div>
            <p class="empty-text">暂无可显示的文件夹</p>
            <p class="empty-hint">打开左侧菜单，点击「导入歌曲」选择并扫描音乐文件夹。</p>
          </div>
          <div v-else-if="gridTotalCount === 0 && category !== 'playlists'" class="empty-state">
            <p class="empty-text">没有符合搜索条件的内容</p>
            <p class="empty-hint">请清除搜索内容后重试</p>
          </div>
          <div v-else class="collection-grid-layout" :class="{ 'has-az-index': isCollectionGrid }">
            <p v-if="category === 'playlists'" class="playlist-order-notice" role="status">
              {{ playlistOrderNotice || '长按歌单拖动排序，顺序保存在当前设备。' }}
            </p>
            <div class="card-grid" data-reorder-group @click.capture="localPlaylistReorder.click">
              <div
                v-if="gridPaddingTop > 0"
                class="grid-virtual-spacer"
                :style="{ height: `${gridPaddingTop}px` }"
                aria-hidden="true"
              ></div>
              <!-- Create Playlist Card -->
              <div
                v-if="showPlaylistCreateCard"
                class="playlist-card create-playlist-card"
                role="button"
                tabindex="0"
                @keydown="activateCollectionCard"
                data-te-interactive
                @click="openCreatePlaylistDialog()"
              >
                <div class="playlist-cover-placeholder create-placeholder">
                  <ThemeIcon class="library-placeholder-icon" icon-slot="library.add" />
                </div>
                <div class="playlist-name">创建歌单</div>
                <div class="playlist-count">点击创建新歌单</div>
                <div class="playlist-source-summary" aria-hidden="true">&nbsp;</div>
              </div>
              <template
                v-for="{ item, index } in visibleGridSlots"
                :key="item ? (item.id ?? item.path ?? item.name) : `slot:${index}`"
              >
                <div
                  v-if="!item"
                  class="collection-card-placeholder"
                  :style="{ height: `${Math.max(1, gridRowStride - gridRowGap)}px` }"
                  aria-hidden="true"
                ></div>
                <template v-else>
                  <!-- Artist Cards -->
                  <template v-if="category === 'artists'">
                    <div
                      class="artist-card"
                      :data-collection-index="index"
                      role="button"
                      tabindex="0"
                      @keydown="activateCollectionCard"
                      :data-collection-letter="collectionIndexLetter(item.name) ?? undefined"
                      data-te-interactive
                      @click="emit('selectView', 'artists', `artist:${item.name}`)"
                    >
                      <CoverImg
                        v-if="item.cover"
                        :cover="item.cover"
                        class="artist-cover"
                        alt="cover"
                        loading="lazy"
                      />
                      <div v-else class="artist-cover-placeholder">
                        <ThemeIcon class="library-placeholder-icon" icon-slot="library.artist" />
                      </div>
                      <div class="artist-name">{{ item.name }}</div>
                      <div class="artist-count">{{ item.trackCount }} 首</div>
                    </div>
                  </template>
                  <!-- Album Cards -->
                  <template v-if="category === 'albums'">
                    <AlbumCard
                      :album="item"
                      :data-collection-index="index"
                      :data-collection-letter="collectionIndexLetter(item.name) ?? undefined"
                      @open="emit('selectView', 'albums', `album:${item.id}`)"
                    />
                  </template>
                  <!-- Genre Cards -->
                  <template v-if="category === 'genres'">
                    <div
                      class="artist-card"
                      role="button"
                      tabindex="0"
                      @keydown="activateCollectionCard"
                      data-te-interactive
                      @click="emit('selectView', 'genres', `genre:${item.name}`)"
                    >
                      <CoverImg
                        v-if="item.cover"
                        :cover="item.cover"
                        class="artist-cover"
                        alt="cover"
                        loading="lazy"
                      />
                      <div v-else class="artist-cover-placeholder">
                        <ThemeIcon class="library-placeholder-icon" icon-slot="library.genre" />
                      </div>
                      <div class="artist-name">{{ item.name }}</div>
                      <div class="artist-count">{{ item.trackCount }} 首</div>
                    </div>
                  </template>
                  <!-- Playlist Cards -->
                  <template v-if="category === 'playlists'">
                    <div
                      class="playlist-card"
                      data-te-interactive
                      :data-reorder-id="item.id"
                      :class="{
                        'is-dragging': localPlaylistReorder.active.value === item.id,
                        'is-drop-target':
                          localPlaylistReorder.over.value === item.id &&
                          localPlaylistReorder.active.value !== item.id
                      }"
                      role="button"
                      tabindex="0"
                      title="长按拖动排序；Alt + ↑ / ↓ 调整顺序"
                      @pointerdown="item.id && localPlaylistReorder.start($event, item.id)"
                      @dragstart.prevent
                      @keydown="localPlaylistKeydown($event, item)"
                      @click="emit('selectView', 'playlists', `playlist:${item.name}`)"
                    >
                      <CoverImg
                        v-if="item.cover"
                        :cover="item.cover"
                        class="album-cover"
                        alt="playlist cover"
                        loading="lazy"
                      />
                      <div
                        v-else
                        class="playlist-cover-placeholder"
                        :class="{ 'default-playlist-cover': item.isDefault }"
                      >
                        <i
                          :class="item.isDefault ? 'pi pi-heart' : 'pi pi-list'"
                          class="playlist-placeholder-icon"
                        ></i>
                      </div>
                      <div class="playlist-name">{{ item.name }}</div>
                      <div class="playlist-count">
                        {{
                          item.trackCount ??
                          item.imported?.entries.length ??
                          item.trackIds?.length ??
                          0
                        }}
                        首
                      </div>
                      <div class="playlist-source-summary">
                        {{ playlistSourceSummaryLabel(item) || '\u00a0' }}
                      </div>
                      <button
                        v-if="!item.isDefault"
                        type="button"
                        class="playlist-delete-btn"
                        data-te-interactive
                        title="删除歌单"
                        :aria-label="`删除歌单 ${item.name}`"
                        @pointerdown.stop
                        @keydown.stop
                        @click.stop="handleDeletePlaylist(item.id || '', $event)"
                      >
                        <i
                          class="pi pi-trash"
                          style="font-size: calc(var(--te-font-size-body, 14px) * 12 / 14)"
                        ></i>
                      </button>
                    </div>
                  </template>
                  <template v-if="category === 'folders'">
                    <div
                      class="playlist-card folder-card"
                      role="button"
                      tabindex="0"
                      @keydown="activateCollectionCard"
                      data-te-interactive
                      @click="emit('selectView', 'folders', `folder:${item.path}`)"
                    >
                      <CoverImg
                        v-if="item.cover"
                        :cover="item.cover"
                        class="album-cover"
                        alt="cover"
                        loading="lazy"
                      />
                      <div v-else class="playlist-cover-placeholder">
                        <ThemeIcon class="library-placeholder-icon" icon-slot="library.folder" />
                      </div>
                      <div class="playlist-name">{{ item.name }}</div>
                      <div class="playlist-count">{{ item.trackCount }} 首</div>
                    </div>
                  </template>
                </template>
              </template>
              <div
                v-if="gridPaddingBottom > 0"
                class="grid-virtual-spacer"
                :style="{ height: `${gridPaddingBottom}px` }"
                aria-hidden="true"
              ></div>
            </div>
            <nav v-if="isCollectionGrid" class="az-index" aria-label="A-Z 快捷索引">
              <button
                v-for="letter in AZ_INDEX_LETTERS"
                :key="letter"
                type="button"
                :class="{ active: activeCollectionLetter === letter }"
                :disabled="collectionLetterDisabled(letter)"
                :aria-current="activeCollectionLetter === letter ? 'location' : undefined"
                :title="
                  collectionLetterDisabled(letter) ? `${letter} 暂无内容` : `跳转到 ${letter}`
                "
                @click="jumpToCollectionLetter(letter)"
              >
                {{ letter }}
              </button>
            </nav>
          </div>
        </template>
        <template v-else>
          <div class="song-list-header" :class="{ 'album-detail-toolbar': !!currentAlbum }">
            <div v-if="!currentAlbum" class="header-left">
              <div class="title-group">
                <div class="title-line">
                  <h2 class="song-list-title">{{ viewTitle }}</h2>
                  <span v-if="viewStatsText" class="view-stats">{{ viewStatsText }}</span>
                </div>
                <span v-if="repairMessage" class="repair-status">{{ repairMessage }}</span>
                <span v-else-if="libraryRepairStatusText" class="library-repair-status">
                  {{ libraryRepairStatusText }}
                </span>
                <div class="library-play-actions" aria-label="播放控制">
                  <button
                    type="button"
                    class="btn-play-all"
                    title="播放全部"
                    :disabled="tableTrackCount === 0 || databaseReadPending"
                    @click="playAllTracks"
                  >
                    <PlaybackIcon name="play" />
                    <span>播放全部</span>
                  </button>
                  <button
                    type="button"
                    class="btn-shuffle-all"
                    title="随机播放"
                    :disabled="tableTrackCount === 0 || databaseReadPending"
                    @click="shufflePlayTracks"
                  >
                    <i class="ph ph-shuffle"></i>
                    <span>随机播放</span>
                  </button>
                </div>
              </div>
            </div>
            <div class="header-right">
              <PlaylistLifecycleToolbar
                v-if="isPlaylistDetail"
                v-model:export-format="playlistExportFormat"
                :repair-pending="playlistRepairPending"
                @rename="handleRenamePlaylist"
                @copy="handleCopyPlaylist"
                @cover="triggerPlaylistCoverPicker"
                @import="triggerPlaylistImport"
                @export="downloadPlaylistDocument(playlistExportFormat)"
                @repair="handlePlaylistRepair"
              />
              <button
                v-if="category === 'albums'"
                type="button"
                class="library-tools-trigger album-version-trigger"
                @click="openMusicVersions"
              >
                专辑版本管理
              </button>
              <div
                v-if="category === 'allSongs'"
                class="library-tools-dropdown"
                :class="{ open: libraryToolsMenuOpen }"
              >
                <button
                  type="button"
                  class="excluded-tracks-trigger library-tools-trigger"
                  ref="libraryToolsTrigger"
                  title="重复检查与已移除管理"
                  :aria-expanded="libraryToolsMenuOpen"
                  aria-haspopup="menu"
                  @click="libraryToolsMenuOpen = !libraryToolsMenuOpen"
                  @blur="closeLibraryToolsMenuDelayed"
                >
                  <i class="pi pi-sitemap"></i>
                  <span>库管理</span>
                  <span
                    v-if="!previewTracks && excludedTracks.length > 0"
                    class="library-tools-badge"
                    >{{ excludedTracks.length }}</span
                  >
                  <i
                    class="pi pi-chevron-down"
                    style="font-size: calc(var(--te-font-size-body, 14px) * 10 / 14)"
                  ></i>
                </button>
                <div v-if="libraryToolsMenuOpen" class="library-tools-menu" role="menu">
                  <button
                    type="button"
                    class="library-tools-option"
                    role="menuitem"
                    @click="openMusicVersions"
                  >
                    歌曲与专辑版本
                  </button>
                  <button
                    type="button"
                    class="library-tools-option"
                    role="menuitem"
                    @click="openLibraryInbox"
                  >
                    <i class="pi pi-inbox"></i><span>曲库整理收件箱</span>
                  </button>
                  <button
                    type="button"
                    class="library-tools-option"
                    role="menuitem"
                    @click="openLoudness(true, $event)"
                  >
                    <i class="pi pi-chart-bar"></i>
                    <span>响度分析与结果</span>
                  </button>
                  <button
                    type="button"
                    class="library-tools-option"
                    role="menuitem"
                    @mousedown.prevent="openLibraryDuplicates"
                  >
                    <i class="pi pi-copy"></i>
                    <span>重复检查</span>
                  </button>
                  <button
                    type="button"
                    class="library-tools-option"
                    role="menuitem"
                    @mousedown.prevent="openLibraryExcluded"
                  >
                    <i class="pi pi-ban"></i>
                    <span>已移除 {{ excludedTracks.length }}</span>
                  </button>
                </div>
              </div>
              <div
                v-if="category === 'recent'"
                class="recent-source-dropdown"
                :class="{ open: recentSourceMenuOpen }"
              >
                <button
                  class="recent-source-trigger"
                  @click="recentSourceMenuOpen = !recentSourceMenuOpen"
                  @blur="closeRecentSourceMenuDelayed"
                >
                  <i
                    class="pi pi-bolt"
                    style="font-size: calc(var(--te-font-size-body, 14px) * 13 / 14)"
                  ></i>
                  <span>{{ activeRecentSourceLabel }}</span>
                  <i
                    class="pi pi-chevron-down"
                    style="font-size: calc(var(--te-font-size-body, 14px) * 10 / 14)"
                  ></i>
                </button>
                <div v-if="recentSourceMenuOpen" class="recent-source-menu">
                  <div
                    v-for="opt in recentSourceOptions"
                    :key="opt.id"
                    class="recent-source-option"
                    :class="{ active: recentSource === opt.id }"
                    @mousedown.prevent="selectRecentSource(opt.id)"
                  >
                    <i
                      class="pi"
                      :class="opt.icon"
                      style="font-size: calc(var(--te-font-size-body, 14px) * 13 / 14)"
                    ></i>
                    <span>{{ opt.label }}</span>
                    <i
                      v-if="recentSource === opt.id"
                      class="pi pi-check"
                      style="
                        font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
                        margin-left: auto;
                      "
                    ></i>
                  </div>
                </div>
              </div>
              <div
                ref="libraryFilterDropdownRef"
                class="library-filter-dropdown"
                :class="{ open: libraryFilterPanelOpen }"
                aria-label="媒体库排序和过滤"
              >
                <button
                  type="button"
                  class="library-filter-trigger"
                  :class="{ active: libraryFilterPanelOpen || activeLibraryFilterCount > 0 }"
                  :aria-expanded="libraryFilterPanelOpen"
                  aria-haspopup="dialog"
                  title="筛选器"
                  @click="toggleLibraryFilterPanel"
                >
                  <ThemeIcon icon-slot="library.filter" />
                  <span>筛选器</span>
                  <span
                    v-if="activeLibraryFilterCount > 0"
                    class="library-filter-badge"
                    aria-label="已启用筛选条件数量"
                  >
                    {{ activeLibraryFilterCount }}
                  </span>
                  <i
                    class="pi pi-chevron-down"
                    style="font-size: calc(var(--te-font-size-body, 14px) * 10 / 14)"
                  ></i>
                </button>
                <div
                  v-if="libraryFilterPanelOpen"
                  class="library-filter-panel"
                  role="dialog"
                  aria-label="筛选器"
                >
                  <div class="library-filter-panel-header">
                    <strong>筛选器</strong>
                    <button
                      type="button"
                      class="library-filter-reset"
                      :disabled="activeLibraryFilterCount === 0"
                      @click="resetLibraryFilters"
                    >
                      重置
                    </button>
                  </div>
                  <div class="library-view-controls">
                    <label>
                      <span>排序</span>
                      <select
                        :value="libraryViewState.sortKey"
                        @change="setSortKey(($event.target as HTMLSelectElement).value)"
                      >
                        <option value="playlist">歌单顺序</option>
                        <option value="title">标题</option>
                        <option value="artist">歌手</option>
                        <option value="album">专辑</option>
                        <option value="trackNumber">曲目号</option>
                        <option value="duration">时长</option>
                        <option value="format">格式</option>
                        <option value="sampleRate">采样率</option>
                        <option value="addedAt">加入时间</option>
                        <option value="lastPlayed">最近播放</option>
                      </select>
                    </label>
                    <label>
                      <span>顺序</span>
                      <select
                        :value="libraryViewState.sortDirection"
                        @change="setSortDirection(($event.target as HTMLSelectElement).value)"
                      >
                        <option value="asc">升序</option>
                        <option value="desc">降序</option>
                      </select>
                    </label>
                    <label class="library-filter-toggle">
                      <input
                        type="checkbox"
                        :checked="libraryViewState.filters.lossless"
                        @change="
                          setLibraryFilter('lossless', ($event.target as HTMLInputElement).checked)
                        "
                      />
                      <span>无损</span>
                    </label>
                    <label class="library-filter-toggle">
                      <input
                        type="checkbox"
                        :checked="libraryViewState.filters.dsd"
                        @change="
                          setLibraryFilter('dsd', ($event.target as HTMLInputElement).checked)
                        "
                      />
                      <span>DSD</span>
                    </label>
                    <label>
                      <span>采样率</span>
                      <input
                        v-if="databaseTableEnabled"
                        type="number"
                        min="1"
                        :aria-label="'采样率（Hz）'"
                        placeholder="全部"
                        :value="libraryViewState.filters.sampleRate ?? ''"
                        @change="
                          setLibraryFilter(
                            'sampleRate',
                            Number(($event.target as HTMLInputElement).value) > 0
                              ? Number(($event.target as HTMLInputElement).value)
                              : null
                          )
                        "
                      />
                      <select
                        v-else
                        :value="libraryViewState.filters.sampleRate ?? ''"
                        @change="
                          setLibraryFilter(
                            'sampleRate',
                            Number(($event.target as HTMLSelectElement).value) || null
                          )
                        "
                      >
                        <option value="">全部</option>
                        <option
                          v-for="value in libraryFilterOptions.sampleRates"
                          :key="value"
                          :value="value"
                        >
                          {{ value / 1000 }} kHz
                        </option>
                      </select>
                    </label>
                    <label>
                      <span>位深</span>
                      <input
                        v-if="databaseTableEnabled"
                        type="number"
                        min="1"
                        :aria-label="'位深（bit）'"
                        placeholder="全部"
                        :value="libraryViewState.filters.bitDepth ?? ''"
                        @change="
                          setLibraryFilter(
                            'bitDepth',
                            Number(($event.target as HTMLInputElement).value) > 0
                              ? Number(($event.target as HTMLInputElement).value)
                              : null
                          )
                        "
                      />
                      <select
                        v-else
                        :value="libraryViewState.filters.bitDepth ?? ''"
                        @change="
                          setLibraryFilter(
                            'bitDepth',
                            Number(($event.target as HTMLSelectElement).value) || null
                          )
                        "
                      >
                        <option value="">全部</option>
                        <option
                          v-for="value in libraryFilterOptions.bitDepths"
                          :key="value"
                          :value="value"
                        >
                          {{ value }} bit
                        </option>
                      </select>
                    </label>
                    <label>
                      <span>文件夹</span>
                      <input
                        v-if="databaseTableEnabled"
                        type="text"
                        aria-label="文件夹完整路径"
                        placeholder="全部"
                        :value="libraryViewState.filters.folder ?? ''"
                        @change="
                          setLibraryFilter(
                            'folder',
                            ($event.target as HTMLInputElement).value.trim() || null
                          )
                        "
                      />
                      <select
                        v-else
                        :value="libraryViewState.filters.folder ?? ''"
                        @change="
                          setLibraryFilter(
                            'folder',
                            ($event.target as HTMLSelectElement).value || null
                          )
                        "
                      >
                        <option value="">全部</option>
                        <option
                          v-for="folder in libraryFilterOptions.folders"
                          :key="folder"
                          :value="folder"
                        >
                          {{ folder }}
                        </option>
                      </select>
                    </label>
                    <label>
                      <span>来源</span>
                      <input
                        v-if="databaseTableEnabled"
                        type="text"
                        aria-label="来源"
                        placeholder="全部"
                        :value="libraryViewState.filters.provider ?? ''"
                        @change="
                          setLibraryFilter(
                            'provider',
                            ($event.target as HTMLInputElement).value.trim() || null
                          )
                        "
                      />
                      <select
                        v-else
                        :value="libraryViewState.filters.provider ?? ''"
                        @change="
                          setLibraryFilter(
                            'provider',
                            ($event.target as HTMLSelectElement).value || null
                          )
                        "
                      >
                        <option value="">全部</option>
                        <option
                          v-for="provider in libraryFilterOptions.providers"
                          :key="provider"
                          :value="provider"
                        >
                          {{ provider }}
                        </option>
                      </select>
                    </label>
                  </div>
                </div>
              </div>
              <label
                v-if="showOnlineSearchToggle"
                class="online-search-toggle"
                title="搜索网络歌曲"
              >
                <span>网络搜索</span>
                <input v-model="searchOnlineSongs" type="checkbox" aria-label="搜索网络歌曲" />
                <span class="online-search-toggle-track" aria-hidden="true"></span>
              </label>
              <div class="search-box" :class="{ focused: searchInputFocused }">
                <ThemeIcon class="search-icon" icon-slot="library.search" />
                <input
                  v-model="searchQuery"
                  type="text"
                  class="search-input"
                  placeholder="搜索歌曲、歌手、专辑或文件夹"
                  @focus="searchInputFocused = true"
                  @blur="searchInputFocused = false"
                />
                <button v-if="searchQuery" class="search-clear" @click="searchQuery = ''">
                  <ThemeIcon icon-slot="library.clear" />
                </button>
              </div>
            </div>
          </div>
          <AlbumDetailHeader
            v-if="currentAlbum"
            :album="currentAlbum"
            :duration-text="albumDurationText"
            :can-play="tableTrackCount > 0 && !databaseReadPending"
            @play="playAllTracks"
            @shuffle="shufflePlayTracks"
          />
          <p
            v-if="databaseAlbumEnabled && databaseAlbumState.error"
            class="repair-status"
            role="alert"
          >
            专辑信息读取失败：{{ databaseAlbumState.error }}
            <button type="button" class="selection-btn" @click="databaseAlbumPages.retry()">
              重试
            </button>
          </p>
          <nav
            v-if="databaseTableEnabled"
            class="database-page-controls database-track-window-status"
            aria-label="曲库浏览"
          >
            <span>
              {{
                databasePageState.total === null
                  ? '正在读取总数'
                  : `共 ${databasePageState.total} 首`
              }}
              <template v-if="tableTrackCount > 0">
                · {{ visibleRange.start + 1 }}–{{ visibleRange.end }}
              </template>
            </span>
            <div class="database-page-actions">
              <span v-if="databaseReadPending" role="status" aria-live="polite">正在读取…</span>
              <button
                v-if="databaseReadError"
                type="button"
                class="selection-btn"
                @click="retryDatabaseRead"
              >
                重试
              </button>
              <button
                type="button"
                class="selection-btn ghost"
                :disabled="databaseReadPending"
                @click="databasePages.invalidate()"
              >
                刷新
              </button>
            </div>
            <span v-if="databaseReadError && databasePageState.total !== null" role="alert">{{
              databaseReadError
            }}</span>
          </nav>
          <div
            v-if="showUnifiedSearchStatus"
            class="unified-search-status"
            :class="{ error: !!unifiedSearch.error.value }"
          >
            <div class="unified-search-summary">
              <i
                :class="
                  unifiedSearch.loading.value
                    ? 'pi pi-spin pi-spinner'
                    : unifiedSearch.error.value
                      ? 'pi pi-times-circle'
                      : 'pi pi-search'
                "
              ></i>
              <span>{{ unifiedSearchStatusText }}</span>
            </div>
            <div v-if="unifiedSearchHealthItems.length" class="unified-search-health-list">
              <span
                v-for="health in unifiedSearchHealthItems"
                :key="health.providerId"
                class="unified-search-health-chip"
                :class="health.state"
                :title="health.detail"
              >
                {{ health.providerName }} · {{ health.label }}
              </span>
            </div>
          </div>
          <div
            v-if="databaseReadError && databasePageState.total === null"
            class="empty-state"
            role="alert"
          >
            <p class="empty-text">曲库读取失败</p>
            <p class="empty-hint">{{ databaseReadError }}</p>
            <button type="button" class="selection-btn" @click="retryDatabaseRead">重试</button>
          </div>
          <div
            v-else-if="databaseReadPending && databasePageState.total === null"
            class="empty-state"
            role="status"
            aria-live="polite"
          >
            <p class="empty-text">正在读取曲库…</p>
          </div>
          <div v-else-if="tableTrackCount === 0" class="empty-state">
            <div class="empty-icon">
              <ThemeIcon class="empty-library-icon" icon-slot="library.empty" />
            </div>
            <p class="empty-text">
              {{
                searchQuery.trim() || activeLibraryFilterCount > 0
                  ? '没有匹配的歌曲'
                  : category === 'recent'
                    ? '暂无播放记录'
                    : '暂无歌曲'
              }}
            </p>
            <p class="empty-hint">
              {{
                searchQuery.trim() || activeLibraryFilterCount > 0
                  ? '请更改搜索内容或清除筛选条件。'
                  : category === 'recent'
                    ? '播放歌曲后，本机记录会显示在这里。'
                    : isPlaylistDetail
                      ? '从歌曲列表或播放队列中添加歌曲到这个歌单。'
                      : '打开左侧菜单，点击「导入歌曲」添加本地音乐。'
              }}
            </p>
          </div>
          <div v-else class="track-table-wrapper">
            <div v-if="hasSelection" class="selection-toolbar">
              <span class="selection-count">已选择 {{ selectedCount }} 首</span>
              <div class="selection-actions">
                <button
                  v-if="databaseTableEnabled"
                  type="button"
                  class="selection-btn"
                  title="选中当前筛选和搜索结果中的全部歌曲，包含未加载的行"
                  @click="multiSelect.selectAll()"
                >
                  <span>选中全部查询结果</span>
                </button>
                <button
                  type="button"
                  class="selection-btn"
                  :disabled="libraryMutationPending"
                  @click="appendActionTracksToQueue()"
                >
                  <i class="pi pi-list"></i>
                  <span>添加到播放队列</span>
                </button>
                <button
                  v-if="selectedLocalTrackCount === null || selectedLocalTrackCount > 0"
                  type="button"
                  class="selection-btn"
                  @click="openLoudness(false, $event)"
                >
                  <i class="pi pi-chart-bar"></i>
                  <span>响度分析</span>
                </button>
                <button type="button" class="selection-btn" @click="handleToolbarFavorite">
                  <i :class="selectionAllFavorited ? 'pi pi-heart-fill' : 'pi pi-heart'"></i>
                  <span>{{
                    selectionAllFavorited === null
                      ? '切换应用收藏'
                      : selectionAllFavorited
                        ? '移出应用收藏'
                        : '加入应用收藏'
                  }}</span>
                </button>
                <button
                  v-if="selectedLocalTrackCount === null || selectedLocalTrackCount > 0"
                  type="button"
                  class="selection-btn"
                  :disabled="libraryMutationPending"
                  @click="openTagManager('edit')"
                >
                  <i class="pi pi-tag"></i>
                  <span>编辑标签{{ localSelectionActionLabel }}</span>
                </button>
                <button
                  v-if="isPlaylistDetail"
                  type="button"
                  class="selection-btn"
                  @click="handleBatchRemoveFromPlaylist"
                >
                  <i class="pi pi-minus-circle"></i>
                  <span>从歌单移除</span>
                </button>
                <button
                  v-if="isPlaylistDetail"
                  type="button"
                  class="selection-btn"
                  @click="handleMoveSelectedWithinPlaylist(false)"
                >
                  <i class="pi pi-angle-double-up"></i>
                  <span>移到开头</span>
                </button>
                <button
                  v-if="isPlaylistDetail"
                  type="button"
                  class="selection-btn"
                  @click="handleMoveSelectedWithinPlaylist(true)"
                >
                  <i class="pi pi-angle-double-down"></i>
                  <span>移到末尾</span>
                </button>
                <button
                  v-if="isPlaylistDetail"
                  type="button"
                  class="selection-btn"
                  @click="handleMoveSelectedToPlaylist"
                >
                  <i class="pi pi-arrow-right-arrow-left"></i>
                  <span>移动到歌单</span>
                </button>
                <button
                  v-if="selectedLocalTrackCount === null || selectedLocalTrackCount > 0"
                  type="button"
                  class="selection-btn"
                  :disabled="libraryMutationPending"
                  @click="handleToolbarRemoveFromLibrary"
                >
                  <i class="pi pi-minus-circle"></i>
                  <span>从音乐库移除</span>
                </button>
                <button
                  v-if="selectedLocalTrackCount === null || selectedLocalTrackCount > 0"
                  type="button"
                  class="selection-btn danger"
                  :disabled="libraryMutationPending"
                  @click="handleToolbarMoveToTrash"
                >
                  <i class="pi pi-trash"></i>
                  <span>移到回收站</span>
                </button>
                <button type="button" class="selection-btn ghost" @click="clearSelection">
                  <i class="pi pi-times"></i>
                  <span>取消</span>
                </button>
              </div>
            </div>
            <table class="track-table">
              <thead>
                <tr>
                  <th class="col-index">#</th>
                  <th class="col-cover-header"></th>
                  <th class="col-info">标题</th>
                  <th class="col-album">专辑</th>
                  <th class="col-duration">时长</th>
                </tr>
              </thead>
              <tbody ref="tbodyRef" :style="{ height: totalHeight + 'px' }">
                <tr
                  class="virtual-spacer"
                  :style="{ height: paddingTop + 'px' }"
                  aria-hidden="true"
                >
                  <td colspan="5"></td>
                </tr>
                <template
                  v-for="(track, index) in visibleTracks"
                  :key="track ? tableTrackKey(track) : `pending:${visibleRange.start + index}`"
                >
                  <tr
                    v-if="track"
                    class="track-row"
                    data-te-interactive
                    tabindex="0"
                    :aria-label="`${track.title} · ${track.artist}，按回车播放，空格选择`"
                    :aria-selected="isSelected(tableTrackKey(track))"
                    :class="{
                      'track-playing': currentTrack?.id === track.id,
                      'track-selected': isSelected(tableTrackKey(track)),
                      'playlist-draggable': isPlaylistDetail
                    }"
                    :aria-current="currentTrack?.id === track.id ? 'true' : undefined"
                    :style="{ height: rowHeight - 4 + 'px', display: 'flex' }"
                    :draggable="isPlaylistDetail"
                    @click="onRowClick(track, Number(index), $event)"
                    @keydown="onRowKeydown(track, Number(index), $event)"
                    @dblclick="onRowDblClick(track, $event)"
                    @dragstart="handlePlaylistDragStart($event, track)"
                    @dragover.prevent
                    @drop="handlePlaylistDrop($event, track)"
                    @contextmenu="onTrackContextMenu($event, track)"
                  >
                    <td class="col-index">
                      <span v-if="currentTrack?.id === track.id" class="playing-indicator">
                        <ThemeIcon icon-slot="library.playing" />
                      </span>
                      <span v-else>{{ trackListNumber(track, Number(index)) }}</span>
                    </td>
                    <td class="col-cover">
                      <div class="track-cover-cell" :class="{ 'has-selection': hasSelection }">
                        <label
                          v-if="hasSelection"
                          class="track-select-checkbox"
                          :title="isSelected(tableTrackKey(track)) ? '取消选中' : '选中'"
                          @click.stop
                        >
                          <input
                            type="checkbox"
                            :checked="isSelected(tableTrackKey(track))"
                            :aria-label="`选中 ${track.title}`"
                            @change="onTrackSelectToggle(track, Number(index), $event)"
                          />
                          <span class="track-select-box" aria-hidden="true">
                            <ThemeIcon
                              v-if="isSelected(tableTrackKey(track))"
                              icon-slot="library.selected"
                            />
                          </span>
                        </label>
                        <CoverImg
                          :cover="displayTrackCover(track)"
                          :cover-source="displayTrackCoverSource(track)"
                          :identity="track.id"
                          class="cover-img"
                          alt="cover"
                        />
                      </div>
                    </td>
                    <td class="col-info">
                      <div class="track-title-row">
                        <button
                          type="button"
                          class="track-title metadata-link"
                          @click.stop="infoTrack = track"
                          @dblclick.stop
                        >
                          {{ track.title }}
                        </button>
                        <div class="track-badges">
                          <span
                            v-if="getLogicalTrackSource(track) !== 'local'"
                            class="track-source-chip"
                            :class="trackSourceClass(track)"
                            :title="`来源：${trackSourceLabel(track)}`"
                          >
                            {{ trackSourceLabel(track) }}
                          </span>
                          <span
                            v-if="track.metadataMatch"
                            class="metadata-match-chip"
                            :title="metadataMatchTitle(track)"
                          >
                            {{ metadataMatchLabel(track) }}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        class="track-artist metadata-link"
                        @click.stop="openRowArtist(track)"
                        @dblclick.stop
                      >
                        {{ track.artist }}
                      </button>
                    </td>
                    <td class="col-album">
                      <button
                        type="button"
                        class="metadata-link"
                        @click.stop="openRowAlbum(track)"
                        @dblclick.stop
                      >
                        {{ track.album }}
                      </button>
                    </td>
                    <td class="col-duration">
                      <span class="duration-time">{{ formatDuration(track.duration) }}</span>
                      <span v-if="trackQualityLabel(track)" class="duration-quality">
                        {{ trackQualityLabel(track) }}
                      </span>
                    </td>
                  </tr>
                  <tr
                    v-else
                    class="track-row track-row-pending"
                    aria-hidden="true"
                    :style="{ height: rowHeight - 4 + 'px', display: 'flex' }"
                  >
                    <td class="col-index">{{ visibleRange.start + index + 1 }}</td>
                    <td class="col-cover"><span class="pending-cover"></span></td>
                    <td class="col-info"><span class="pending-line"></span></td>
                    <td class="col-album"><span class="pending-line"></span></td>
                    <td class="col-duration"></td>
                  </tr>
                </template>
                <tr
                  class="virtual-spacer"
                  :style="{
                    height: totalHeight - paddingTop - visibleTracks.length * rowHeight + 'px'
                  }"
                  aria-hidden="true"
                >
                  <td colspan="5"></td>
                </tr>
              </tbody>
            </table>

            <!-- Context Menu -->
            <Teleport to="body">
              <NativeContextMenu
                v-if="showContextMenu"
                class="context-menu"
                :style="{ top: menuY + 'px', left: menuX + 'px' }"
                @click.stop
                @close="closeContextMenu"
              >
                <div
                  class="menu-item"
                  data-te-interactive
                  @click="appendActionTracksToQueue(contextTracksForAction())"
                >
                  <i class="pi pi-list"></i>
                  <span>添加到播放队列{{ contextActionLabel }}</span>
                </div>
                <div
                  v-if="canPlayNextSelectedTrack && contextActionCount <= 1"
                  class="menu-item"
                  data-te-interactive
                  @click="handlePlayNext"
                >
                  <PlaybackIcon name="next" />
                  <span>下一首播放</span>
                </div>
                <div
                  class="menu-item"
                  role="menuitem"
                  tabindex="0"
                  data-te-interactive
                  @click="handleContextCopyTrackNames"
                  @keydown.enter.prevent="handleContextCopyTrackNames"
                  @keydown.space.prevent="handleContextCopyTrackNames"
                >
                  <i class="pi pi-copy"></i>
                  <span>复制歌曲名-作者{{ contextActionLabel }}</span>
                </div>
                <div
                  v-if="
                    canViewSelectedContext &&
                    selectedTrack?.artist.trim() &&
                    contextActionCount <= 1
                  "
                  class="menu-item"
                  data-te-interactive
                  @click="handleViewArtist"
                >
                  <i class="ph ph-microphone-stage"></i>
                  <span>查看歌手</span>
                </div>
                <div
                  v-if="
                    canViewSelectedContext && selectedTrack?.album.trim() && contextActionCount <= 1
                  "
                  class="menu-item"
                  data-te-interactive
                  @click="handleViewAlbum"
                >
                  <i class="ph ph-disc"></i>
                  <span>查看专辑</span>
                </div>
                <div
                  v-if="contextLocalTrackCount === null || contextLocalTrackCount > 0"
                  class="menu-item"
                  data-te-interactive
                  @click="handleContextRemoveFromLibrary"
                >
                  <i class="pi pi-minus-circle"></i>
                  <span>从音乐库移除{{ contextLocalActionLabel }}</span>
                </div>
                <div
                  v-if="contextLocalTrackCount === null || contextLocalTrackCount > 0"
                  class="menu-item danger"
                  data-te-interactive
                  @click="handleContextMoveToTrash"
                >
                  <i class="pi pi-trash"></i>
                  <span>移到回收站{{ contextLocalActionLabel }}</span>
                </div>
                <div
                  v-if="isPlaylistDetail"
                  class="menu-item"
                  data-te-interactive
                  @click="handleContextRemoveFromPlaylist"
                >
                  <i class="pi pi-minus-circle"></i>
                  <span>从歌单移除{{ contextActionLabel }}</span>
                </div>
                <div class="menu-item" data-te-interactive @click="handleContextFavorite">
                  <i :class="contextAllFavorited ? 'pi pi-heart-fill' : 'pi pi-heart'"></i>
                  <span
                    >{{
                      contextAllFavorited === null
                        ? '切换应用收藏'
                        : contextAllFavorited
                          ? '移出应用收藏'
                          : '加入应用收藏'
                    }}{{ contextActionLabel }}</span
                  >
                </div>
                <div
                  v-if="isPlaylistDetail && selectedTrack && contextActionCount <= 1"
                  class="menu-item"
                  data-te-interactive
                  @click="openSelectedSourcePicker"
                >
                  <i class="pi pi-sliders-h"></i>
                  <span>选择播放来源</span>
                </div>
                <div
                  v-if="canRematchSelectedTrack && contextActionCount <= 1"
                  class="menu-item"
                  data-te-interactive
                  @click="handleRematchTrack"
                >
                  <i class="pi pi-refresh"></i>
                  <span>重新匹配音源</span>
                </div>
                <div
                  v-if="canRematchMetadataSelectedTrack && contextActionCount <= 1"
                  class="menu-item"
                  data-te-interactive
                  @click="handleRematchMetadata"
                >
                  <i class="pi pi-sync"></i>
                  <span>重新匹配流媒体元数据</span>
                </div>
                <div
                  v-if="canClearMetadataMatchSelectedTrack && contextActionCount <= 1"
                  class="menu-item"
                  data-te-interactive
                  @click="handleClearMetadataMatch"
                >
                  <i class="pi pi-times-circle"></i>
                  <span>取消流媒体匹配</span>
                </div>
                <div
                  v-if="contextActionCount <= 1"
                  class="menu-item"
                  data-te-interactive
                  @click="handleOpenFolder"
                >
                  <i class="pi pi-folder-open"></i>
                  <span>打开文件所在位置</span>
                </div>
                <div
                  v-if="canContinueFromBookmark"
                  class="menu-item"
                  data-te-interactive
                  @click="handleContinueFromBookmark"
                >
                  <i class="pi pi-bookmark"></i>
                  <span>从书签继续</span>
                </div>
                <div
                  class="menu-item"
                  @mouseenter="showPlaylistSubmenu = true"
                  @mouseleave="showPlaylistSubmenu = false"
                >
                  <i class="pi pi-plus"></i>
                  <span>加入到歌单{{ contextActionLabel }}</span>
                  <i class="pi pi-chevron-right submenu-icon"></i>

                  <div class="submenu">
                    <div
                      class="menu-item create-playlist-menu-item"
                      data-te-interactive
                      @click="handleContextCreatePlaylist"
                    >
                      <i
                        class="pi pi-plus"
                        style="
                          font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
                          margin-right: 6px;
                        "
                      ></i>
                      <span>创建新歌单</span>
                    </div>
                    <div v-if="localPlaylists.length === 0" class="menu-item disabled">
                      暂无歌单
                    </div>
                    <div
                      v-for="pl in localPlaylists"
                      :key="pl.id"
                      class="menu-item"
                      data-te-interactive
                      @click="handleContextAddToPlaylist(pl.name)"
                    >
                      {{ pl.name }}
                    </div>
                  </div>
                </div>
                <div
                  class="menu-item"
                  @mouseenter="showAggregateSubmenu = true"
                  @mouseleave="showAggregateSubmenu = false"
                >
                  <i class="pi pi-sitemap"></i>
                  <span>添加到聚合歌单{{ contextActionLabel }}</span>
                  <i class="pi pi-chevron-right submenu-icon"></i>

                  <div class="submenu">
                    <div
                      class="menu-item create-playlist-menu-item"
                      data-te-interactive
                      @click="handleCreateAggregatePlaylistFromMenu"
                    >
                      <i
                        class="pi pi-plus"
                        style="
                          font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
                          margin-right: 6px;
                        "
                      ></i>
                      <span>新建聚合歌单…</span>
                    </div>
                    <div v-if="aggregatePlaylists.length === 0" class="menu-item disabled">
                      暂无聚合歌单
                    </div>
                    <div
                      v-for="pl in aggregatePlaylists"
                      :key="pl.id"
                      class="menu-item"
                      data-te-interactive
                      @click="handleAddToAggregatePlaylist(pl.id)"
                    >
                      {{ pl.name }}
                    </div>
                  </div>
                </div>
                <div class="menu-item" data-te-interactive @click="customizeLibraryAppearance">
                  <i class="ph ph-palette"></i>
                  <span>定制此区域外观</span>
                </div>
              </NativeContextMenu>
            </Teleport>
          </div>
        </template>
      </div>
    </Transition>

    <input
      ref="playlistImportInput"
      type="file"
      accept=".m3u,.m3u8,.pls,audio/x-mpegurl,audio/x-scpls"
      hidden
      @change="handlePlaylistImport"
    />
    <input
      ref="playlistCoverInput"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      hidden
      @change="handlePlaylistCover"
    />

    <CreateAggregatePlaylistDialog
      :show="showCreateAggregateDialog"
      :tracks="[]"
      :track-count="createAggregateSource?.count ?? 0"
      :create-with-tracks="createSelectedAggregatePlaylist"
      @close="dismissCreateAggregateDialog"
      @created="onAggregatePlaylistCreated"
    />

    <!-- Create Playlist Dialog -->
    <Teleport to="body">
      <Transition name="dialog-fade">
        <div
          v-if="showCreatePlaylistDialog"
          class="dialog-overlay"
          @click.self="dismissCreatePlaylistDialog"
        >
          <div class="create-playlist-dialog" @click.stop>
            <h3 class="dialog-title">创建歌单</h3>
            <input
              v-model="newPlaylistName"
              class="dialog-input"
              type="text"
              placeholder="请输入歌单名称"
              maxlength="50"
              autofocus
              @keyup.enter="handleConfirmCreatePlaylist"
            />
            <div class="dialog-actions">
              <button class="dialog-btn cancel" @click="dismissCreatePlaylistDialog">取消</button>
              <button
                class="dialog-btn confirm"
                :disabled="!newPlaylistName.trim()"
                @click="handleConfirmCreatePlaylist"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <NativeDialogTransition>
      <PlaylistActionDialog
        v-if="playlistDialog"
        :request="playlistDialog"
        :error="playlistDialogError"
        :targets="playlistMoveTargets"
        @close="dismissPlaylistDialog"
        @confirm="confirmPlaylistDialog"
      />
    </NativeDialogTransition>

    <Teleport to="body">
      <NativeDialogTransition>
        <LibraryLoudnessDialog
          v-if="loudnessOpen"
          :library-tracks="tracks"
          :selected-tracks="loudnessSelection"
          :resolve-plan="loudnessPlanResolver"
          :albums="albums"
          :restore-focus="loudnessFocusTarget"
          @close="loudnessOpen = false"
        />
      </NativeDialogTransition>
    </Teleport>

    <Teleport to="body">
      <NativeDialogTransition>
        <MusicVersionsHost
          v-if="showMusicVersions"
          :restore-focus="libraryToolsTrigger"
          :initial-scope="category === 'albums' ? 'albums' : 'tracks'"
          :initial-track="musicVersionsInitialTrack"
          @close="showMusicVersions = false"
        />
      </NativeDialogTransition>
      <NativeDialogTransition overlay :restore-focus="libraryToolsTrigger">
        <LibraryInboxDialog
          v-if="showLibraryInbox"
          :tracks="tracks"
          :scanning="isScanning"
          :rescan="startFullLibraryScan"
          :restore-focus="libraryToolsTrigger"
          @close="showLibraryInbox = false"
          @applied="applyTagManagerWrite"
        />
      </NativeDialogTransition>
    </Teleport>

    <Teleport to="body">
      <Transition name="dialog-fade">
        <div v-if="showTagManager" class="dialog-overlay" @click.self="closeTagManager">
          <LocalLibraryTagManager
            :key="`${tagManagerInitialView}:${tagManagerTracks.map((track) => track.id).join(',')}`"
            :initial-view="tagManagerInitialView"
            :tracks="tagManagerTracks"
            :current-tracks="databaseTableEnabled ? tagManagerTracks : tracks"
            @close="closeTagManager"
            @applied="applyTagManagerWrite"
          />
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="dialog-fade">
        <div
          v-if="showExcludedTracksDialog"
          class="dialog-overlay"
          @click.self="showExcludedTracksDialog = false"
        >
          <div class="excluded-tracks-dialog" @click.stop>
            <div class="excluded-dialog-header">
              <div>
                <h3 class="dialog-title">已从音乐库移除</h3>
                <p class="excluded-dialog-count">{{ excludedTracks.length }} 个排除项</p>
              </div>
              <button
                type="button"
                class="excluded-dialog-close"
                title="关闭"
                @click="showExcludedTracksDialog = false"
              >
                <i class="pi pi-times"></i>
              </button>
            </div>
            <div v-if="excludedTracks.length === 0" class="excluded-empty">暂无排除项</div>
            <div v-else class="excluded-track-list">
              <div v-for="item in excludedTracks" :key="item.filePath" class="excluded-track-row">
                <div class="excluded-track-copy">
                  <strong>{{ excludedTrackLabel(item.filePath, item.title) }}</strong>
                  <span v-if="item.artist">{{ item.artist }}</span>
                  <span class="excluded-track-path" :title="item.filePath">{{
                    item.filePath
                  }}</span>
                  <time v-if="formatExcludedAt(item.excludedAt)">{{
                    formatExcludedAt(item.excludedAt)
                  }}</time>
                </div>
                <button
                  type="button"
                  class="excluded-restore-button"
                  :disabled="exclusionRestorePending"
                  title="恢复到音乐库"
                  @click="handleRestoreExclusions([item.filePath])"
                >
                  <i class="pi pi-refresh"></i>
                  <span>恢复</span>
                </button>
              </div>
            </div>
            <div class="dialog-actions excluded-dialog-actions">
              <button class="dialog-btn cancel" @click="showExcludedTracksDialog = false">
                关闭
              </button>
              <button
                class="dialog-btn confirm"
                :disabled="excludedTracks.length === 0 || exclusionRestorePending"
                @click="handleRestoreExclusions(excludedTracks.map((item) => item.filePath))"
              >
                全部恢复
              </button>
              <button
                class="dialog-btn danger"
                :disabled="excludedTracks.length === 0 || exclusionRestorePending"
                @click="handleClearExclusions"
              >
                清除记录
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped src="./song-list/SongList.css"></style>
