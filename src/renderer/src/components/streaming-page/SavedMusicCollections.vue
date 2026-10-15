<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import CoverImg from '@renderer/components/CoverImg.vue'
import { useBoundedGrid } from '@renderer/composables/useBoundedGrid'
import { useMediaProviders } from '@renderer/providers'
import { useProviderStore } from '@renderer/stores/useProviderStore'
import type {
  MediaProviderAlbumSummary,
  MediaProviderArtistSummary
} from '@renderer/providers/mediaProvider'

type CollectionType = 'albums' | 'artists'
const props = withDefaults(
  defineProps<{
    userId: number | string
    providerId: string
    collectionType?: CollectionType
    hideHeader?: boolean
    active?: boolean
  }>(),
  { hideHeader: false, active: true }
)
const emit = defineEmits<{
  openAlbum: [album: MediaProviderAlbumSummary]
  openArtist: [artist: MediaProviderArtistSummary]
  'update:collectionType': [type: CollectionType]
}>()
const providers = useMediaProviders()
const providerStore = useProviderStore()
const localTab = ref<CollectionType>('albums')
const supportedTabs = computed(() => {
  const methods = providerStore.getProvider(props.providerId)?.supportedMethods ?? []
  return {
    albums: methods.includes('fetchSavedAlbums'),
    artists: methods.includes('fetchSavedArtists')
  }
})
const tab = computed<CollectionType>({
  get: () => {
    const preferred = props.collectionType ?? localTab.value
    return supportedTabs.value[preferred]
      ? preferred
      : supportedTabs.value.albums
        ? 'albums'
        : 'artists'
  },
  set: (type) => {
    localTab.value = type
    emit('update:collectionType', type)
  }
})
type CollectionState = {
  loading: boolean
  error: string
  loaded: boolean
  limit: number
  request: number
}
const freshState = (): CollectionState => ({
  loading: false,
  error: '',
  loaded: false,
  limit: 40,
  request: 0
})
const states = reactive<Record<CollectionType, CollectionState>>({
  albums: freshState(),
  artists: freshState()
})
const albums = shallowRef<MediaProviderAlbumSummary[]>([])
const artists = shallowRef<MediaProviderArtistSummary[]>([])
const currentState = computed(() => states[tab.value])
const loading = computed(() => currentState.value.loading)
const error = computed(() => currentState.value.error)
const limit = computed({
  get: () => currentState.value.limit,
  set: (value: number) => {
    currentState.value.limit = value
  }
})
const visibleAlbums = computed(() => albums.value.slice(0, limit.value))
const visibleArtists = computed(() => artists.value.slice(0, limit.value))
const count = computed(() => (tab.value === 'albums' ? albums.value.length : artists.value.length))
const { setGridElement, gridStyle } = useBoundedGrid(() => Math.min(count.value, limit.value))
let context = 0
let loadedScope = ''

async function load(force = false): Promise<void> {
  if (!props.active || !supportedTabs.value[tab.value]) return
  const type = tab.value
  const state = states[type]
  if (state.loading || (state.loaded && !force)) return
  const token = context
  const request = ++state.request
  const providerId = props.providerId
  state.loading = true
  state.error = ''
  try {
    const provider = providers.get(providerId)
    if (type === 'albums') {
      if (!provider?.fetchSavedAlbums) throw new Error('这个平台未提供收藏专辑功能')
      const result = await provider.fetchSavedAlbums()
      if (token === context && request === state.request) albums.value = result
    } else {
      if (!provider?.fetchSavedArtists) throw new Error('这个平台未提供收藏歌手功能')
      const result = await provider.fetchSavedArtists()
      if (token === context && request === state.request) artists.value = result
    }
  } catch (cause) {
    if (token === context && request === state.request)
      state.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (token === context && request === state.request) {
      state.loading = false
      state.loaded = true
    }
  }
}
watch(
  [() => JSON.stringify([props.providerId, props.userId]), tab, () => props.active, supportedTabs],
  ([scope]) => {
    if (scope !== loadedScope) {
      loadedScope = scope
      context++
      albums.value = []
      artists.value = []
      states.albums = freshState()
      states.artists = freshState()
    }
    if (props.active) void load()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  context++
})
const refresh = (): Promise<void> => load(true)
defineExpose({ refresh, loading, count })
</script>

<template>
  <section class="saved-music" :class="{ embedded: hideHeader }" :aria-busy="loading">
    <header v-if="!hideHeader">
      <h2>我收藏的</h2>
      <div role="group" aria-label="收藏类型">
        <button
          v-if="supportedTabs.albums"
          type="button"
          :aria-pressed="tab === 'albums'"
          @click="tab = 'albums'"
        >
          专辑
        </button>
        <button
          v-if="supportedTabs.artists"
          type="button"
          :aria-pressed="tab === 'artists'"
          @click="tab = 'artists'"
        >
          歌手
        </button>
      </div>
      <button type="button" :disabled="loading" @click="refresh">刷新</button>
    </header>
    <p v-if="!supportedTabs.albums && !supportedTabs.artists" role="status">
      这个平台未提供收藏专辑或歌手功能
    </p>
    <p v-else-if="loading" role="status">正在加载收藏…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <p v-else-if="!count">暂无收藏{{ tab === 'albums' ? '专辑' : '歌手' }}</p>
    <div v-else :ref="setGridElement" class="saved-grid" :style="gridStyle">
      <template v-if="tab === 'albums'">
        <button
          v-for="album in visibleAlbums"
          :key="album.id"
          :title="album.name"
          type="button"
          @click="emit('openAlbum', album)"
        >
          <CoverImg :cover="album.cover" :cover-source="album.coverSource" alt="" />
          <span>{{ album.name }}</span>
        </button>
      </template>
      <template v-else>
        <button
          v-for="artist in visibleArtists"
          :key="artist.id"
          :title="artist.name"
          type="button"
          @click="emit('openArtist', artist)"
        >
          <CoverImg :cover="artist.picUrl" :cover-source="artist.picUrlSource" alt="" />
          <span>{{ artist.name }}</span>
        </button>
      </template>
    </div>
    <button v-if="!loading && !error && count > limit" type="button" @click="limit += 40">
      显示更多
    </button>
  </section>
</template>

<style scoped>
.saved-music {
  margin: 32px 0 0;
  min-width: 0;
}
.saved-music.embedded {
  margin: 0;
}
header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px 24px;
  margin-bottom: 16px;
}
header h2 {
  margin: 0;
  font-size: var(--te-type-section-title);
  font-weight: var(--te-type-weight-strong);
  line-height: var(--te-type-line-title);
}
header [role='group'] {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
p {
  font-size: var(--te-type-caption);
  line-height: var(--te-type-line-caption);
  color: var(--te-neutral-600, var(--te-neutral-500));
}
button {
  color: var(--te-neutral-900);
  font: inherit;
  font-size: var(--te-type-caption);
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-control-radius-sm);
  background: var(--te-subtle-bg);
  min-height: max(var(--te-control-height-md), 2.5em);
  padding: 6px 12px;
  cursor: pointer;
}
button:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 3px;
}
button[aria-pressed='true'] {
  color: var(--te-primary-500);
  background: var(--te-active-bg);
}
button:hover:not(:disabled) {
  background: var(--te-hover-bg);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.saved-grid {
  display: grid;
  gap: 20px;
  justify-content: start;
  margin-bottom: 16px;
}
.saved-grid button {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: var(--te-control-radius-sm);
  background: transparent;
  text-align: left;
  font-size: var(--te-type-body);
  line-height: var(--te-type-line-body);
}
.saved-grid :deep(img) {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: var(--te-control-radius-sm);
  background: var(--te-subtle-bg);
}
.saved-grid span {
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow-wrap: anywhere;
}
</style>
