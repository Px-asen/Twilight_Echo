<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import CoverImg from '@renderer/components/CoverImg.vue'
import { useMediaProviders } from '@renderer/providers'
import type {
  MediaProviderAlbumSummary,
  MediaProviderArtistSummary
} from '@renderer/providers/mediaProvider'

const props = defineProps<{ userId: number | string }>()
const emit = defineEmits<{
  openAlbum: [album: MediaProviderAlbumSummary]
  openArtist: [artist: MediaProviderArtistSummary]
}>()
const providers = useMediaProviders()
const tab = ref<'albums' | 'artists'>('albums')
const albums = shallowRef<MediaProviderAlbumSummary[]>([])
const artists = shallowRef<MediaProviderArtistSummary[]>([])
const loading = ref(false)
const error = ref('')
const limit = ref(40)
let request = 0
const visibleAlbums = computed(() => albums.value.slice(0, limit.value))
const visibleArtists = computed(() => artists.value.slice(0, limit.value))
const count = computed(() => (tab.value === 'albums' ? albums.value.length : artists.value.length))

async function load(): Promise<void> {
  const current = ++request
  loading.value = true
  error.value = ''
  limit.value = 40
  albums.value = []
  artists.value = []
  try {
    const provider = providers.get('ncm')
    if (tab.value === 'albums') {
      if (!provider?.fetchSavedAlbums) throw new Error('当前网易云插件不支持收藏专辑，请更新插件')
      const result = await provider.fetchSavedAlbums()
      if (current === request) albums.value = result
    } else {
      if (!provider?.fetchSavedArtists) throw new Error('当前网易云插件不支持收藏歌手，请更新插件')
      const result = await provider.fetchSavedArtists()
      if (current === request) artists.value = result
    }
  } catch (cause) {
    if (current === request) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (current === request) loading.value = false
  }
}
watch([() => props.userId, tab], () => void load(), { immediate: true })
onBeforeUnmount(() => {
  request++
})
</script>

<template>
  <section class="saved-music">
    <header>
      <h2>我收藏的</h2>
      <div role="group" aria-label="收藏类型">
        <button type="button" :aria-pressed="tab === 'albums'" @click="tab = 'albums'">专辑</button>
        <button type="button" :aria-pressed="tab === 'artists'" @click="tab = 'artists'">
          歌手
        </button>
      </div>
      <button type="button" :disabled="loading" @click="load">刷新</button>
    </header>
    <p v-if="loading" role="status">正在加载收藏…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <p v-else-if="!count">暂无收藏{{ tab === 'albums' ? '专辑' : '歌手' }}</p>
    <div v-else class="saved-grid">
      <template v-if="tab === 'albums'">
        <button
          v-for="album in visibleAlbums"
          :key="album.id"
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
</style>
