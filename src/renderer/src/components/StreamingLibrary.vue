<script setup lang="ts">
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useHoldReorder } from '@renderer/composables/useHoldReorder'
import { useBoundedGrid } from '@renderer/composables/useBoundedGrid'
import { usePlaylistLibraryView } from '@renderer/components/streaming-page/usePlaylistLibraryView'
import NativeContextMenu from '@renderer/components/NativeContextMenu.vue'
import SavedMusicCollections from '@renderer/components/streaming-page/SavedMusicCollections.vue'
import { useProviderStore } from '@renderer/stores/useProviderStore'
import type {
  MediaProviderPlaylistSummary,
  MediaProviderAlbumSummary,
  MediaProviderArtistSummary,
  MediaProviderProfile
} from '@renderer/providers/mediaProvider'
import {
  buildProviderHealthPresentation,
  type ProviderHealthInput
} from '@renderer/utils/providerHealthPresentation'

interface LibraryViewState {
  collection: 'playlists' | 'albums' | 'artists'
  category: 'all' | 'owned' | 'saved'
  limit: number
}

interface ProviderOption {
  id: string
  name: string
  icon: string
  health?: ProviderHealthInput
  loggedIn?: boolean
}

const props = defineProps<{
  isLoggedIn: boolean
  providerLabel?: string
  profile: MediaProviderProfile | null
  profileSignature: string
  likedSummary: { name: string; trackCount: number; cover: string | null }
  likedPlaylistOptions?: MediaProviderPlaylistSummary[]
  selectedLikedPlaylistId?: string | number | null
  likedSelectionError?: string
  libraryLoaded: boolean
  userPlaylistEntries: MediaProviderPlaylistSummary[]
  showLikedPanel?: boolean
  showSocialStats?: boolean
  showFeatureCards?: boolean
  allowPinPlaylists?: boolean
  allowPlaylistMutations?: boolean
  pinnedPlaylistIds?: Array<string | number>
  pinningPlaylistId?: string | number | null
  deletingPlaylistId?: string | number | null
  availableProviders?: ProviderOption[]
  activeProvider?: string
  viewState?: LibraryViewState
}>()
const providerStore = useProviderStore()
const savedCollectionCapabilities = computed(() => {
  const methods = providerStore.getProvider(props.activeProvider ?? 'ncm')?.supportedMethods ?? []
  return {
    albums: props.isLoggedIn && methods.includes('fetchSavedAlbums'),
    artists: props.isLoggedIn && methods.includes('fetchSavedArtists')
  }
})
type CollectionKind = 'playlists' | 'albums' | 'artists'
const collectionKind = ref<CollectionKind>('playlists')
const collectionId = useId()
const collectionTabs = ref<HTMLElement | null>(null)
const visitedCollections = ref({ albums: false, artists: false })
const albumCollections = ref<InstanceType<typeof SavedMusicCollections> | null>(null)
const artistCollections = ref<InstanceType<typeof SavedMusicCollections> | null>(null)
const collectionOptions = computed(() => [
  { id: 'playlists' as const, label: '歌单' },
  ...(savedCollectionCapabilities.value.albums ? [{ id: 'albums' as const, label: '专辑' }] : []),
  ...(savedCollectionCapabilities.value.artists ? [{ id: 'artists' as const, label: '歌手' }] : [])
])
const activeSavedCollections = computed(() =>
  collectionKind.value === 'albums' ? albumCollections.value : artistCollections.value
)
watch(collectionKind, (kind) => {
  if (kind !== 'playlists') visitedCollections.value[kind] = true
})
watch(collectionOptions, (options) => {
  if (options.some((option) => option.id === collectionKind.value)) return
  const restoreFocus = collectionTabs.value?.contains(document.activeElement)
  collectionKind.value = 'playlists'
  if (restoreFocus)
    void nextTick(() =>
      collectionTabs.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
    )
})
watch(
  () => JSON.stringify([props.activeProvider, props.profile?.userId, props.isLoggedIn]),
  () => {
    collectionKind.value = 'playlists'
    visitedCollections.value = { albums: false, artists: false }
  }
)

function onCollectionTabKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const items = Array.from(
    collectionTabs.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []
  )
  if (!items.length) return
  event.preventDefault()
  const index = items.findIndex((item) => item === document.activeElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
  collectionKind.value = items[next].dataset.collection as CollectionKind
  items[next].focus()
}

const {
  category: playlistCategory,
  limit: playlistLimit,
  storageError: playlistOrderError,
  filtered: filteredPlaylists,
  visible: visiblePlaylists,
  counts: playlistCounts,
  move: movePlaylist,
  step: stepPlaylist
} = usePlaylistLibraryView(
  () => props.userPlaylistEntries,
  () =>
    `${props.activeProvider ?? props.providerLabel ?? 'ncm'}:${props.profile?.userId ?? 'guest'}`,
  () => new Set((props.pinnedPlaylistIds ?? []).map(String)),
  // Legacy provider pins must not override manual ordering when pin controls are unavailable.
  () => props.allowPinPlaylists === true
)

const playlistReorder = useHoldReorder(movePlaylist)
const { setGridElement: playlistGrid, gridStyle: playlistGridStyle } = useBoundedGrid(
  () => visiblePlaylists.value.length
)
watch(
  () => [props.activeProvider, props.profile?.userId, playlistCategory.value],
  playlistReorder.cancel
)

const emit = defineEmits<{
  openUserList: [type: 'follows' | 'followers']
  openLikedTracks: []
  playLikedSongs: []
  selectLikedPlaylist: [playlistId: string]
  openPlaylist: [playlist: MediaProviderPlaylistSummary]
  openAlbum: [album: MediaProviderAlbumSummary]
  openArtist: [artist: MediaProviderArtistSummary]
  togglePinnedPlaylist: [playlist: MediaProviderPlaylistSummary]
  createPlaylist: []
  deletePlaylist: [playlist: MediaProviderPlaylistSummary]
  openRecent: []
  openRanking: []
  switchProvider: [id: string]
  'update:viewState': [state: LibraryViewState]
}>()

let viewStateRevision = 0
let applyingViewState = false
const emitViewState = (): void =>
  emit('update:viewState', {
    collection: collectionKind.value,
    category: playlistCategory.value,
    limit: playlistLimit.value
  })
watch(
  () => props.viewState,
  async (state) => {
    if (
      !state ||
      (state.collection === collectionKind.value &&
        state.category === playlistCategory.value &&
        state.limit === playlistLimit.value)
    )
      return
    const revision = ++viewStateRevision
    applyingViewState = true
    collectionKind.value = collectionOptions.value.some((option) => option.id === state.collection)
      ? state.collection
      : 'playlists'
    playlistCategory.value = state.category
    // The playlist view resets its page when category changes. Restore the caller's
    // reveal count after that watcher so a detail return doesn't collapse 96 to 48.
    await nextTick()
    if (revision !== viewStateRevision) return
    playlistLimit.value = Number.isFinite(state.limit) ? Math.max(48, state.limit) : 48
    await nextTick()
    if (revision === viewStateRevision) {
      applyingViewState = false
      if (
        state.collection !== collectionKind.value ||
        state.category !== playlistCategory.value ||
        state.limit !== playlistLimit.value
      )
        emitViewState()
    }
  },
  { immediate: true }
)
watch(
  [collectionKind, playlistCategory, playlistLimit],
  () => {
    if (!applyingViewState) emitViewState()
  },
  { flush: 'post' }
)

// ─── Provider switcher (music library toggle) ───────────────────────────
// Only renders when more than one library provider is available, so the
// toggle button appears once a second provider (e.g. ytmusic) is loaded and
// disappears when it is gone.
const providerMenuOpen = ref(false)
const providerMenuId = useId()
const providerMenuElement = ref<HTMLElement | null>(null)
const providerTrigger = ref<HTMLButtonElement | null>(null)
const providerMenuStyle = ref({ left: '0px', top: '0px', width: '240px', maxHeight: '320px' })

const providerOptions = computed<ProviderOption[]>(() => props.availableProviders ?? [])
const canSwitchProvider = computed(() => providerOptions.value.length > 1)

const activeProviderName = computed(() => {
  const active = providerOptions.value.find((p) => p.id === props.activeProvider)
  return active?.name ?? props.providerLabel ?? '在线音源'
})

const activeProviderIcon = computed(() => {
  const active = providerOptions.value.find((p) => p.id === props.activeProvider)
  return active?.icon ?? 'pi pi-music'
})

function closeProviderMenu(restoreFocus = false): void {
  if (providerMenuElement.value) providerMenuElement.value.inert = true
  providerMenuElement.value?.hidePopover()
  providerMenuOpen.value = false
  if (restoreFocus) providerTrigger.value?.focus()
}

async function toggleProviderMenu(): Promise<void> {
  const menu = providerMenuElement.value
  const trigger = providerTrigger.value
  if (!menu || !trigger) return
  if (menu.matches(':popover-open')) {
    closeProviderMenu()
    return
  }
  positionProviderMenu()
  menu.inert = false
  menu.showPopover()
  providerMenuOpen.value = true
  await nextTick()
  const selected =
    menu.querySelector<HTMLElement>('[aria-selected="true"]') ??
    menu.querySelector<HTMLElement>('[role="option"]')
  selected?.focus()
}

function onProviderMenuKeydown(event: KeyboardEvent): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = Array.from(
    providerMenuElement.value?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []
  )
  if (!items.length) return
  event.preventDefault()
  event.stopPropagation()
  const index = items.findIndex((item) => item === document.activeElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[next]?.focus()
}

function positionProviderMenu(): void {
  const rect = providerTrigger.value?.getBoundingClientRect()
  if (!rect) return
  const below = Math.max(0, window.innerHeight - rect.bottom - 14)
  const above = Math.max(0, rect.top - 14)
  const openAbove = below < 240 && above > below
  const maxHeight = Math.min(320, openAbove ? above : below)
  const width = Math.min(240, window.innerWidth - 16)
  providerMenuStyle.value = {
    left: `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`,
    top: `${openAbove ? Math.max(8, rect.top - maxHeight - 6) : rect.bottom + 6}px`,
    width: `${width}px`,
    maxHeight: `${maxHeight}px`
  }
}

function onProviderMenuToggle(event: Event): void {
  providerMenuOpen.value = (event as ToggleEvent).newState === 'open'
  if (providerMenuElement.value) providerMenuElement.value.inert = !providerMenuOpen.value
}

function onProviderViewportChange(event: Event): void {
  if (event.target instanceof Node && providerMenuElement.value?.contains(event.target)) return
  if (providerMenuOpen.value) positionProviderMenu()
}

function onProviderFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget
  if (
    next instanceof Node &&
    next !== providerTrigger.value &&
    !providerMenuElement.value?.contains(next)
  ) {
    closeProviderMenu()
  }
}

watch(
  () => props.activeProvider,
  () => closeProviderMenu()
)
onMounted(() => {
  window.addEventListener('scroll', onProviderViewportChange, true)
  window.addEventListener('resize', onProviderViewportChange)
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onProviderViewportChange, true)
  window.removeEventListener('resize', onProviderViewportChange)
})

function selectProvider(id: string): void {
  closeProviderMenu(true)
  emit('switchProvider', id)
}

function providerMenuHealthLabel(provider: ProviderOption): string {
  return buildProviderHealthPresentation({
    health: provider.health,
    loggedIn: provider.loggedIn ?? props.isLoggedIn
  }).label
}

function providerMenuHealthDetail(provider: ProviderOption): string {
  return buildProviderHealthPresentation({
    health: provider.health,
    loggedIn: provider.loggedIn ?? props.isLoggedIn
  }).detail
}

function playlistId(playlist: MediaProviderPlaylistSummary): string {
  return String(playlist.id)
}

function isPlaylistPinned(playlist: MediaProviderPlaylistSummary): boolean {
  const playlistWithPinned = playlist as MediaProviderPlaylistSummary & { pinned?: boolean }
  return (
    playlistWithPinned.pinned === true ||
    (props.pinnedPlaylistIds ?? []).some((id) => String(id) === playlistId(playlist))
  )
}

function isPlaylistPinning(playlist: MediaProviderPlaylistSummary): boolean {
  return String(props.pinningPlaylistId ?? '') === playlistId(playlist)
}

function onPlaylistKeydown(event: KeyboardEvent, playlist: MediaProviderPlaylistSummary): void {
  if (event.target !== event.currentTarget) return
  if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault()
    stepPlaylist(String(playlist.id), event.key === 'ArrowUp' ? -1 : 1)
    return
  }
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  emit('openPlaylist', playlist)
}

function canDeletePlaylist(): boolean {
  return props.allowPlaylistMutations === true
}

function isPlaylistDeleting(playlist: MediaProviderPlaylistSummary): boolean {
  return String(props.deletingPlaylistId ?? '') === playlistId(playlist)
}

function deletePlaylistLabel(playlist: MediaProviderPlaylistSummary): string {
  return playlist.owned === false ? '取消收藏歌单' : '删除歌单'
}
const menuPlaylist = ref<MediaProviderPlaylistSummary | null>(null)
function closePlaylistMenu(): void {
  menuPlaylist.value = null
}
function openPlaylistMenu(event: MouseEvent, playlist: MediaProviderPlaylistSummary): void {
  if (!canDeletePlaylist()) return
  const trigger = event.currentTarget as HTMLElement
  trigger.focus()
  menuPlaylist.value = playlist
}
function deleteMenuPlaylist(): void {
  const playlist = menuPlaylist.value
  closePlaylistMenu()
  if (playlist && !isPlaylistDeleting(playlist)) emit('deletePlaylist', playlist)
}
</script>

<template>
  <div class="library-view">
    <section class="top-cards" aria-label="账户与音源">
      <div class="glass-card profile-card">
        <div class="profile-avatar-wrap">
          <div class="profile-avatar-ring">
            <img v-if="profile?.avatarUrl" :src="profile.avatarUrl" class="profile-avatar" alt="" />
            <span v-else class="profile-avatar profile-avatar-placeholder"
              ><i class="pi pi-user" aria-hidden="true"></i
            ></span>
          </div>
        </div>
        <div class="profile-info">
          <div class="profile-title-row">
            <h2 :title="profile?.nickname || '未登录用户'">
              {{ profile?.nickname || '未登录用户' }}
            </h2>
            <div
              v-if="canSwitchProvider"
              class="provider-switcher"
              @keydown.esc.stop.prevent="closeProviderMenu(true)"
            >
              <button
                ref="providerTrigger"
                type="button"
                class="provider-switch-btn"
                :class="{ active: providerMenuOpen }"
                :title="`切换音源（当前：${activeProviderName}）`"
                :aria-expanded="providerMenuOpen"
                :aria-controls="providerMenuId"
                aria-haspopup="listbox"
                @click="toggleProviderMenu"
                @keydown.down.prevent="toggleProviderMenu"
                @focusout="onProviderFocusOut"
              >
                <i :class="activeProviderIcon"></i>
                <span class="provider-switch-name">{{ activeProviderName }}</span>
                <i class="pi pi-chevron-down provider-switch-caret"></i>
              </button>
              <div
                :id="providerMenuId"
                ref="providerMenuElement"
                class="provider-menu"
                data-te-material="popover"
                popover="auto"
                role="listbox"
                aria-label="选择音源"
                :style="providerMenuStyle"
                @toggle="onProviderMenuToggle"
                @focusout="onProviderFocusOut"
                @keydown="onProviderMenuKeydown"
              >
                <button
                  v-for="provider in providerOptions"
                  :key="provider.id"
                  type="button"
                  class="provider-menu-item"
                  :class="{ active: provider.id === activeProvider }"
                  :title="providerMenuHealthDetail(provider)"
                  role="option"
                  :aria-selected="provider.id === activeProvider"
                  :tabindex="provider.id === activeProvider ? 0 : -1"
                  @click="selectProvider(provider.id)"
                >
                  <i :class="provider.icon"></i>
                  <span>
                    {{ provider.name }}
                    <small class="provider-menu-health">
                      {{ providerMenuHealthLabel(provider) }}
                    </small>
                  </span>
                  <i
                    v-if="provider.id === activeProvider"
                    class="pi pi-check provider-menu-check"
                  ></i>
                </button>
              </div>
            </div>
            <span v-else class="profile-source">{{ providerLabel || '在线音源' }}</span>
          </div>
          <p v-if="profileSignature" :title="profileSignature">{{ profileSignature }}</p>
        </div>
        <div v-if="isLoggedIn && showSocialStats !== false" class="profile-stats">
          <button type="button" class="stat-badge" @click="emit('openUserList', 'follows')">
            {{ profile?.follows || 0 }} <span>关注</span>
          </button>
          <button type="button" class="stat-badge" @click="emit('openUserList', 'followers')">
            {{ profile?.followeds || 0 }} <span>粉丝</span>
          </button>
        </div>
      </div>
    </section>
    <section
      class="library-shortcuts"
      aria-label="常用音乐"
      :class="{ 'shortcuts-single': !isLoggedIn || showFeatureCards === false }"
    >
      <div
        v-if="showLikedPanel !== false"
        class="glass-card favorites-card"
        role="button"
        tabindex="0"
        @click="emit('openLikedTracks')"
        @keydown.enter.self.prevent="emit('openLikedTracks')"
        @keydown.space.self.prevent="emit('openLikedTracks')"
      >
        <div class="favorites-info">
          <div class="favorites-heading">
            <h2>我喜欢</h2>
            <label
              v-if="(likedPlaylistOptions?.length ?? 0) > 1"
              class="favorites-picker"
              @click.stop
              @keydown.stop
            >
              <span>切换收藏夹</span>
              <i class="pi pi-chevron-down" aria-hidden="true"></i>
              <select
                :value="String(selectedLikedPlaylistId ?? '')"
                aria-label="切换展示的收藏夹"
                :title="`当前收藏夹：${likedSummary.name}`"
                @change="emit('selectLikedPlaylist', ($event.target as HTMLSelectElement).value)"
              >
                <option
                  v-for="playlist in likedPlaylistOptions"
                  :key="String(playlist.id)"
                  :value="String(playlist.id)"
                >
                  {{ playlist.name }}（{{ playlist.trackCount }} 首）
                </option>
              </select>
            </label>
          </div>
          <p
            v-if="likedSummary.name && !['我喜欢', '我喜欢的音乐'].includes(likedSummary.name)"
            class="favorites-name"
            :title="likedSummary.name"
          >
            {{ likedSummary.name }}
          </p>
          <div class="favorites-footer">
            <p>{{ likedSummary.trackCount }} 首歌曲</p>
            <button type="button" class="btn-play" @click.stop="emit('playLikedSongs')">
              <PlaybackIcon name="play" />播放全部
            </button>
          </div>
        </div>
        <div class="favorites-cover">
          <img v-if="likedSummary.cover" :src="likedSummary.cover" alt="" class="liked-cover-img" />
          <span v-else class="liked-cover-img liked-card-cover-placeholder">
            <i class="pi pi-heart-fill"></i>
          </span>
          <div class="heart-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path
                d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
              />
            </svg>
          </div>
        </div>
      </div>
      <!-- Recent Played Card -->
      <button
        v-if="isLoggedIn && showFeatureCards !== false"
        type="button"
        class="glass-card feature-card recent-card"
        data-te-interactive
        @click="emit('openRecent')"
      >
        <div class="feature-info">
          <div class="icon-wrap">
            <i class="pi pi-history" style="font-size: 1.1rem"></i>
          </div>
          <h3>最近播放</h3>
          <p>回顾您最近的音乐足迹</p>
        </div>
        <div class="feature-preview">
          <div class="enter-btn">
            <i class="pi pi-chevron-right"></i>
          </div>
        </div>
      </button>

      <!-- Top Ranking Card -->
      <button
        v-if="isLoggedIn && showFeatureCards !== false"
        type="button"
        class="glass-card feature-card ranking-card"
        data-te-interactive
        @click="emit('openRanking')"
      >
        <div class="feature-info">
          <div class="icon-wrap">
            <i class="pi pi-chart-bar" style="font-size: 1.1rem"></i>
          </div>
          <h3>听歌排行</h3>
          <p>探索您的最常播放榜单</p>
        </div>
        <div class="feature-preview">
          <div class="enter-btn">
            <i class="pi pi-chevron-right"></i>
          </div>
        </div>
      </button>
    </section>
    <p v-if="showLikedPanel === false" class="provider-liked-empty">这个平台未提供“我喜欢”列表。</p>
    <p
      v-if="likedSelectionError && showLikedPanel !== false"
      role="status"
      class="playlist-order-hint"
    >
      {{ likedSelectionError }}
    </p>

    <section class="library-collections" aria-label="我的音乐集合">
      <header class="collection-toolbar">
        <div
          ref="collectionTabs"
          class="library-collection-tabs"
          role="tablist"
          aria-label="音乐库内容"
          @keydown="onCollectionTabKeydown"
        >
          <button
            v-for="option in collectionOptions"
            :id="collectionId + '-tab-' + option.id"
            :key="option.id"
            type="button"
            role="tab"
            :data-collection="option.id"
            :aria-selected="collectionKind === option.id"
            :aria-controls="collectionId + '-panel-' + option.id"
            :tabindex="collectionKind === option.id ? 0 : -1"
            @click="collectionKind = option.id"
          >
            {{ option.label }}
          </button>
        </div>
        <button
          v-if="collectionKind === 'playlists' && allowPlaylistMutations"
          type="button"
          class="create-playlist-btn"
          title="创建歌单"
          @click="emit('createPlaylist')"
        >
          <i class="pi pi-plus" aria-hidden="true"></i><span>创建歌单</span>
        </button>
        <button
          v-else-if="collectionKind !== 'playlists'"
          type="button"
          class="create-playlist-btn"
          :disabled="activeSavedCollections?.loading"
          @click="activeSavedCollections?.refresh()"
        >
          <i class="pi pi-refresh" aria-hidden="true"></i><span>刷新</span>
        </button>
      </header>
      <section
        :id="collectionId + '-panel-playlists'"
        v-show="collectionKind === 'playlists'"
        class="playlist-section"
        role="tabpanel"
        :aria-labelledby="collectionId + '-tab-playlists'"
      >
        <div class="playlist-organization">
          <div class="playlist-filters" role="group" aria-label="歌单分类">
            <button
              v-for="tab in [
                { id: 'all', label: '全部' },
                { id: 'owned', label: '我创建的' },
                { id: 'saved', label: '我收藏的' }
              ] as const"
              :key="tab.id"
              type="button"
              :aria-pressed="playlistCategory === tab.id"
              @click="playlistCategory = tab.id"
            >
              {{ tab.label }} <span>{{ playlistCounts[tab.id] }}</span>
            </button>
          </div>
          <span class="collection-count">{{ userPlaylistEntries.length }} 个歌单</span>
          <p class="playlist-sort-help">
            拖动排序（触屏长按）；<template v-if="allowPinPlaylists">置顶优先。</template>键盘 Alt +
            ↑ / ↓ 调整。
          </p>
        </div>
        <p v-if="playlistOrderError" role="status" class="playlist-order-hint">
          {{ playlistOrderError }}
        </p>
        <p
          v-if="!libraryLoaded && filteredPlaylists.length === 0"
          class="playlist-order-hint"
          role="status"
        >
          正在加载歌单…
        </p>
        <div v-else-if="libraryLoaded && filteredPlaylists.length === 0" class="empty-state">
          <span class="empty-icon">
            <i class="pi pi-list"></i>
          </span>
          <p class="empty-text">暂无在线歌单</p>
          <p class="empty-hint">
            {{
              allowPlaylistMutations
                ? '点击右上角「创建歌单」开始整理在线音乐'
                : '当前账号还没有可展示的在线歌单'
            }}
          </p>
        </div>

        <div
          v-else
          :ref="playlistGrid"
          class="playlist-grid"
          :style="playlistGridStyle"
          data-reorder-group
          @click.capture="playlistReorder.click"
        >
          <article
            v-for="playlist in visiblePlaylists"
            :key="playlist.id"
            class="playlist-item"
            :class="{
              'is-dragging': playlistReorder.active.value === String(playlist.id),
              'is-drop-target':
                playlistReorder.over.value === String(playlist.id) &&
                playlistReorder.active.value !== String(playlist.id)
            }"
            :data-reorder-id="String(playlist.id)"
            @pointerdown="playlistReorder.start($event, String(playlist.id))"
            @dragstart.prevent
            role="button"
            tabindex="0"
            :aria-label="`打开歌单 ${playlist.name}`"
            @click="emit('openPlaylist', playlist)"
            @keydown="onPlaylistKeydown($event, playlist)"
            @contextmenu.prevent.stop="openPlaylistMenu($event, playlist)"
          >
            <img
              v-if="playlist.cover"
              :src="playlist.cover"
              class="playlist-item-cover"
              alt=""
              loading="lazy"
              decoding="async"
            />
            <span v-else class="playlist-item-cover playlist-cover-placeholder">
              <i class="pi pi-list"></i>
            </span>
            <div class="playlist-item-info">
              <h4 class="playlist-item-title" :title="playlist.name">{{ playlist.name }}</h4>
            </div>
            <span class="playlist-item-count">
              {{ playlist.trackCount }} 首
              <template v-if="playlist.owned === true"> · 创建</template>
              <template v-else-if="playlist.owned === false"> · 收藏</template>
            </span>

            <button
              v-if="allowPinPlaylists"
              type="button"
              class="playlist-pin-button"
              :class="{ active: isPlaylistPinned(playlist) }"
              :disabled="isPlaylistPinning(playlist)"
              :title="isPlaylistPinned(playlist) ? '取消置顶收藏夹' : '置顶收藏夹'"
              @click.stop="emit('togglePinnedPlaylist', playlist)"
            >
              <i
                :class="
                  isPlaylistPinning(playlist)
                    ? 'pi pi-spin pi-spinner'
                    : isPlaylistPinned(playlist)
                      ? 'pi pi-star-fill'
                      : 'pi pi-star'
                "
              ></i>
            </button>

            <button
              v-if="canDeletePlaylist()"
              type="button"
              class="playlist-more-button"
              :disabled="isPlaylistDeleting(playlist)"
              :aria-label="`更多操作：${playlist.name}`"
              title="更多操作"
              aria-haspopup="menu"
              @click.stop="openPlaylistMenu($event, playlist)"
            >
              <i
                :class="isPlaylistDeleting(playlist) ? 'pi pi-spin pi-spinner' : 'pi pi-ellipsis-h'"
              ></i>
            </button>

            <div class="playlist-item-arrow">
              <i class="pi pi-chevron-right"></i>
            </div>
          </article>
        </div>
        <button
          v-if="visiblePlaylists.length < filteredPlaylists.length"
          type="button"
          class="playlist-load-more"
          @click="playlistLimit += 48"
        >
          显示更多歌单 · 还有 {{ filteredPlaylists.length - visiblePlaylists.length }} 个
        </button>
      </section>
      <section
        v-if="savedCollectionCapabilities.albums"
        :id="collectionId + '-panel-albums'"
        v-show="collectionKind === 'albums'"
        class="saved-collection-panel"
        role="tabpanel"
        :aria-labelledby="collectionId + '-tab-albums'"
      >
        <SavedMusicCollections
          v-if="visitedCollections.albums"
          ref="albumCollections"
          :user-id="profile?.userId ?? 'guest'"
          :provider-id="activeProvider ?? 'ncm'"
          collection-type="albums"
          hide-header
          :active="collectionKind === 'albums'"
          @open-album="emit('openAlbum', $event)"
          @open-artist="emit('openArtist', $event)"
        />
      </section>
      <section
        v-if="savedCollectionCapabilities.artists"
        :id="collectionId + '-panel-artists'"
        v-show="collectionKind === 'artists'"
        class="saved-collection-panel"
        role="tabpanel"
        :aria-labelledby="collectionId + '-tab-artists'"
      >
        <SavedMusicCollections
          v-if="visitedCollections.artists"
          ref="artistCollections"
          :user-id="profile?.userId ?? 'guest'"
          :provider-id="activeProvider ?? 'ncm'"
          collection-type="artists"
          hide-header
          :active="collectionKind === 'artists'"
          @open-album="emit('openAlbum', $event)"
          @open-artist="emit('openArtist', $event)"
        />
      </section>
    </section>
  </div>
  <Teleport to="body">
    <NativeContextMenu v-if="menuPlaylist" @close="closePlaylistMenu">
      <button
        type="button"
        role="menuitem"
        :disabled="isPlaylistDeleting(menuPlaylist)"
        @click="deleteMenuPlaylist"
      >
        <i class="pi pi-trash" aria-hidden="true"></i>{{ deletePlaylistLabel(menuPlaylist) }}
      </button>
    </NativeContextMenu>
  </Teleport>
</template>
<style scoped>
.library-view {
  min-width: 0;
  container-type: inline-size;
  color: var(--te-text);
  font-family: var(--te-font-sans);
  font-size: var(--te-type-body);
}
.library-view :is(h1, h2, h3, h4, p) {
  margin: 0;
}
.library-view button {
  font: inherit;
  cursor: pointer;
}
.library-view button:disabled {
  opacity: 0.5;
  cursor: default;
}
.library-view :is(button, [role='button'], select):focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 3px;
}
.top-cards {
  margin-bottom: 16px;
}
.library-view .glass-card {
  min-width: 0;
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
.profile-card {
  display: flex;
  align-items: center;
  gap: 16px;
}
.profile-avatar-wrap,
.profile-avatar-ring {
  flex-shrink: 0;
}
.profile-avatar {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 50%;
}
.profile-avatar-placeholder {
  background: var(--te-subtle-bg);
  color: var(--te-text-secondary);
}
.profile-info {
  min-width: 0;
  flex: 1;
}
.profile-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.profile-source {
  color: var(--te-text-secondary);
  font-size: var(--te-type-caption);
  line-height: 1.5;
}
.profile-info h2 {
  font-size: var(--te-type-headline);
  line-height: 1.4;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.profile-info > p {
  font-size: var(--te-type-caption);
  line-height: 1.5;
  color: var(--te-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 4px;
}
.profile-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin-left: auto;
}
.stat-badge,
.provider-switch-btn {
  min-height: var(--te-control-height-md);
  padding: 6px 8px;
  border: 0;
  border-radius: var(--te-control-radius-sm);
  color: var(--te-text-secondary);
  background: transparent;
  font-size: var(--te-type-caption) !important;
  line-height: 1.5;
}
.stat-badge:hover,
.provider-switch-btn:is(:hover, .active) {
  background: var(--te-subtle-bg);
  color: var(--te-text);
}
.stat-badge {
  font-variant-numeric: tabular-nums;
}
.provider-switch-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
}
.provider-switch-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 14em;
}
.provider-switch-caret {
  font-size: 0.8em;
}
.provider-menu {
  position: fixed;
  margin: 0;
  padding: 6px;
  box-sizing: border-box;
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-control-radius-sm);
  background: var(--te-material-background, var(--te-card-bg));
  color: var(--te-text);
  box-shadow: var(--te-material-shadow, none);
  overflow-y: auto;
}
.provider-menu-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  min-height: var(--te-control-height-md);
  border: 0;
  border-radius: var(--te-control-radius-sm);
  background: transparent;
  color: inherit;
  text-align: left;
  font-size: var(--te-type-caption) !important;
  line-height: 1.5;
}
.provider-menu-item:is(:hover, .active) {
  background: var(--te-subtle-bg);
}
.provider-menu-health {
  display: block;
  font-size: var(--te-type-caption);
  color: var(--te-text-secondary);
}
.provider-menu-check {
  margin-left: auto;
}
.favorites-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 56px;
  gap: 12px;
  align-items: center;
  cursor: pointer;
}
.favorites-info {
  min-width: 0;
}
.favorites-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.favorites-picker {
  position: relative;
  display: inline-flex;
  gap: 8px;
  align-items: center;
  min-height: var(--te-control-height-md);
  color: var(--te-text-secondary);
  font-size: var(--te-type-caption);
  line-height: 1.5;
  cursor: pointer;
}
.favorites-picker select {
  position: absolute;
  inset: 0;
  width: 100%;
  opacity: 0;
  cursor: pointer;
}
.favorites-picker:focus-within {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 3px;
  border-radius: 4px;
}
.favorites-info h2 {
  font-size: var(--te-type-headline);
  line-height: 1.3;
  font-weight: 600;
  overflow-wrap: anywhere;
  margin-top: 0;
}
.favorites-footer p,
.favorites-info > p {
  color: var(--te-text-secondary);
  font-size: var(--te-type-caption);
  line-height: 1.5;
  margin-top: 4px;
}
.btn-play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: var(--te-control-height-md);
  padding: 7px 14px;
  margin-top: 0;
  border: 0;
  border-radius: var(--te-control-radius-sm);
  background: var(--te-primary-500);
  color: var(--te-control-on-accent);
  font-size: var(--te-type-caption) !important;
  line-height: 1.5;
}
.favorites-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.favorites-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: center;
  margin-top: 8px;
}
.favorites-cover {
  width: 56px;
  aspect-ratio: 1;
  border-radius: 6px;
  overflow: hidden;
  background: var(--te-subtle-bg);
}
.liked-cover-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.liked-card-cover-placeholder {
  display: grid;
  place-items: center;
  color: var(--te-text-secondary);
}
.heart-icon {
  display: none;
}
.library-shortcuts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}
.library-shortcuts.shortcuts-single {
  grid-template-columns: minmax(0, 460px);
}
.library-view .library-shortcuts .glass-card {
  padding: 16px;
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-card-radius, 12px);
  background: var(--te-card-bg);
  box-shadow: none;
}
.feature-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 16px;
  color: inherit;
  text-align: left;
}
.feature-card:hover {
  background: var(--te-subtle-bg);
}
.feature-info {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 4px 8px;
  align-items: center;
}
.icon-wrap {
  grid-column: 1;
  grid-row: 1/3;
  color: var(--te-text-secondary);
}
.feature-info h3 {
  grid-column: 2;
  font-size: var(--te-type-headline);
  font-weight: 600;
  line-height: 1.4;
}
.feature-info p {
  grid-column: 2;
  font-size: var(--te-type-caption);
  color: var(--te-text-secondary);
  line-height: 1.5;
}
.feature-preview {
  color: var(--te-text-secondary);
}
.collection-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--te-card-border);
}
.library-collection-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}
.library-collection-tabs button {
  min-height: var(--te-control-height-md);
  padding: 8px 0;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--te-text-secondary);
  font-size: var(--te-type-headline);
  line-height: 1.4;
}
.library-collection-tabs button[aria-selected='true'] {
  border-bottom-color: var(--te-primary-500);
  color: var(--te-text);
  font-weight: 600;
}
.collection-count {
  color: var(--te-text-secondary);
  font-size: var(--te-type-caption);
  line-height: 1.5;
  align-self: center;
  white-space: nowrap;
}
.playlist-sort-help {
  font-size: var(--te-type-caption);
  line-height: 1.5;
  color: var(--te-text-secondary);
}
.collection-toolbar > button {
  margin-bottom: 6px;
}
.create-playlist-btn,
.playlist-load-more {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: var(--te-control-height-md);
  padding: 7px 12px;
  border: 0;
  border-radius: var(--te-control-radius-sm);
  background: var(--te-subtle-bg);
  color: var(--te-text);
  font-size: var(--te-type-caption) !important;
  line-height: 1.5;
}
.playlist-organization {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: center;
  margin-bottom: 16px;
}
.playlist-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.playlist-filters button {
  min-height: var(--te-control-height-md);
  padding: 7px 10px;
  border: 0;
  border-radius: var(--te-control-radius-sm);
  background: transparent;
  color: var(--te-text-secondary);
  font-size: var(--te-type-caption);
  line-height: 1.5;
}
.playlist-filters button[aria-pressed='true'] {
  background: var(--te-subtle-bg);
  color: var(--te-text);
  font-weight: 500;
}
.playlist-filters span {
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
}
.playlist-order-hint,
.provider-liked-empty {
  color: var(--te-text-secondary);
  font-size: var(--te-type-caption);
  line-height: 1.5;
  margin-bottom: 16px !important;
}
.playlist-grid {
  display: grid;
  min-width: 0;
}
.playlist-item {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px 4px;
  align-content: start;
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  cursor: pointer;
}
.playlist-item[data-reorder-id] {
  user-select: none;
  touch-action: pan-y;
}
.playlist-item.is-dragging {
  opacity: 0.55;
  cursor: grabbing;
  outline: 2px solid var(--te-primary-500);
}
.playlist-item.is-drop-target {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
.playlist-item-cover {
  grid-column: 1/-1;
  display: block;
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 6px;
  background: var(--te-subtle-bg);
}
.playlist-cover-placeholder {
  display: grid;
  place-items: center;
  color: var(--te-text-secondary);
}
.playlist-item-info {
  grid-column: 1/-1;
  grid-row: 2;
  min-width: 0;
}
.playlist-item-title {
  font-size: var(--te-type-body);
  line-height: 1.4;
  font-weight: 500;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.playlist-item-count {
  grid-row: 3;
  grid-column: 1;
  align-self: center;
  color: var(--te-text-secondary);
  font-size: var(--te-type-caption);
  line-height: 1.5;
}
.playlist-pin-button,
.playlist-more-button {
  grid-row: 3;
  align-self: start;
  display: grid;
  place-items: center;
  min-width: var(--te-control-height-md);
  min-height: var(--te-control-height-md);
  padding: 4px;
  border: 0;
  border-radius: var(--te-control-radius-sm);
  color: var(--te-text-secondary);
  background: transparent;
}
.playlist-pin-button {
  grid-column: 2;
}
.playlist-more-button {
  grid-column: 3;
}
.playlist-pin-button.active {
  color: var(--te-primary-500);
}
.playlist-item-arrow {
  display: none;
}
.playlist-load-more {
  margin-top: 24px;
}
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 16px 0;
}
.empty-icon {
  display: none;
}
.empty-text {
  font-size: var(--te-type-headline);
  font-weight: 600;
  line-height: 1.4;
}
.empty-hint {
  font-size: var(--te-type-caption);
  color: var(--te-text-secondary);
  line-height: 1.5;
}
@container (max-width:720px) {
  .library-shortcuts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .library-shortcuts .favorites-card {
    grid-column: 1 / -1;
  }
  .feature-info p {
    display: none;
  }
}
@container (max-width:600px) {
  .profile-card {
    flex-wrap: wrap;
    gap: 12px;
  }
  .profile-stats {
    margin-left: 60px;
  }
  .profile-info {
    flex-basis: calc(100% - 60px);
  }
}
</style>
