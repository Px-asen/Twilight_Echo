<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import CoverImg from '@renderer/components/CoverImg.vue'
import ExplicitBadge from '@renderer/components/ExplicitBadge.vue'
import NcmAlbumFilters from './NcmAlbumFilters.vue'
import { filterNcmAlbums, formatNcmAlbumClassification } from './ncmAlbumClassification'
import { useMediaProviders } from '@renderer/providers'
import { useProviderStore } from '@renderer/stores/useProviderStore'
import type {
  MediaProviderAlbumSummary,
  MediaProviderArtistSummary
} from '@renderer/providers/mediaProvider'

const props = defineProps<{ userId: number | string; providerId: string }>()
const emit = defineEmits<{
  openAlbum: [album: MediaProviderAlbumSummary]
  openArtist: [artist: MediaProviderArtistSummary]
}>()
const providers = useMediaProviders()
const providerStore = useProviderStore()
const tab = ref<'albums' | 'artists'>('albums')
const supportedTabs = computed(() => {
  const methods = providerStore.getProvider(props.providerId)?.supportedMethods ?? []
  return {
    albums: methods.includes('fetchSavedAlbums'),
    artists: methods.includes('fetchSavedArtists')
  }
})
watch(supportedTabs, (supported) => {
  if (!supported[tab.value]) tab.value = supported.albums ? 'albums' : 'artists'
})
const albums = shallowRef<MediaProviderAlbumSummary[]>([])
const artists = shallowRef<MediaProviderArtistSummary[]>([])
const loading = ref(false)
const error = ref('')
const limit = ref(40)
const releaseType = ref('')
const isNcm = computed(() => props.providerId === 'ncm')
let request = 0
const filteredAlbums = computed(() =>
  isNcm.value ? filterNcmAlbums(albums.value, releaseType.value) : albums.value
)
const visibleAlbums = computed(() => filteredAlbums.value.slice(0, limit.value))
const visibleArtists = computed(() => artists.value.slice(0, limit.value))
const count = computed(() =>
  tab.value === 'albums' ? filteredAlbums.value.length : artists.value.length
)
watch(releaseType, () => {
  limit.value = 40
})

async function load(): Promise<void> {
  const current = ++request
  loading.value = true
  error.value = ''
  limit.value = 40
  albums.value = []
  artists.value = []
  try {
    const provider = providers.get(props.providerId)
    if (tab.value === 'albums') {
      if (!provider?.fetchSavedAlbums) throw new Error('这个平台未提供收藏专辑功能')
      const result = await provider.fetchSavedAlbums()
      if (current === request) albums.value = result
    } else {
      if (!provider?.fetchSavedArtists) throw new Error('这个平台未提供收藏歌手功能')
      const result = await provider.fetchSavedArtists()
      if (current === request) artists.value = result
    }
  } catch (cause) {
    if (current === request) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (current === request) loading.value = false
  }
}
watch(
  [() => props.userId, () => props.providerId, tab],
  () => {
    releaseType.value = ''
    if (!supportedTabs.value[tab.value])
      tab.value = supportedTabs.value.albums ? 'albums' : 'artists'
    void load()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  request++
})
</script>

<template>
  <section class="saved-music">
    <header>
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
      <button type="button" :disabled="loading" @click="load">刷新</button>
    </header>
    <NcmAlbumFilters
      v-if="isNcm && tab === 'albums' && albums.length && !loading && !error"
      :albums="albums"
      v-model:release-type="releaseType"
    />
    <p v-if="loading" role="status">正在加载收藏…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <p v-else-if="tab === 'albums' && albums.length && !count" role="status">
      没有符合筛选条件的专辑
    </p>
    <p v-else-if="!count">暂无收藏{{ tab === 'albums' ? '专辑' : '歌手' }}</p>
    <div v-else class="saved-grid">
      <template v-if="tab === 'albums'">
        <button
          v-for="album in visibleAlbums"
          :key="album.id"
          type="button"
          @click="emit('openAlbum', album)"
        >
          <CoverImg :cover="album.cover" :cover-source="album.coverSource" size="grid" alt="" />
          <span class="saved-album-title">
            <span>{{ album.name }}</span>
            <ExplicitBadge v-if="isNcm && album.isExplicit" />
          </span>
          <small
            v-if="isNcm && formatNcmAlbumClassification(album)"
            class="saved-album-classification"
          >
            {{ formatNcmAlbumClassification(album) }}
          </small>
        </button>
      </template>
      <template v-else>
        <button
          v-for="artist in visibleArtists"
          :key="artist.id"
          type="button"
          @click="emit('openArtist', artist)"
        >
          <CoverImg :cover="artist.picUrl" :cover-source="artist.picUrlSource" size="grid" alt="" />
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
  margin: 24px 0;
}
header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}
header h2 {
  margin: 0;
  font-size: 20px;
}
button {
  color: inherit;
  border: 1px solid var(--te-card-border);
  border-radius: 12px;
  background: var(--te-card-bg);
  padding: 10px 14px;
  cursor: pointer;
}
button[aria-pressed='true'] {
  color: var(--te-primary-500);
  background: var(--te-active-bg);
}
.saved-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}
.saved-grid button {
  display: flex;
  flex-direction: column;
  gap: 10px;
  text-align: left;
  min-width: 0;
}
.saved-grid :deep(img) {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 8px;
}
.saved-grid span {
  overflow-wrap: anywhere;
}
.saved-album-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
}
.saved-album-title > span:first-child {
  flex: 1;
  min-width: 0;
}
.saved-album-classification {
  color: var(--te-neutral-500);
  overflow-wrap: anywhere;
}
</style>
