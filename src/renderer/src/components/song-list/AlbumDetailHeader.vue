<script setup lang="ts">
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { LibraryItem } from '../../stores/library/musicStoreTypes'
import AlbumArtwork from './AlbumArtwork.vue'
import { formatReleaseDate } from '../../../../shared/releaseDate.ts'
import { resolveCover } from '../../utils/coverLoader.ts'
import { extractAverageColor, normalizeAccentColor } from '../../utils/colorExtractor.ts'

const props = defineProps<{ album: LibraryItem; durationText: string; canPlay: boolean }>()
defineEmits<{ play: []; shuffle: [] }>()
const tint = ref<string | null>(null)
const ambientStyle = computed(() => (tint.value ? { '--album-tint': tint.value } : {}))
let generation = 0
watch(
  () => [props.album.id, props.album.cover, props.album.coverSource] as const,
  async () => {
    const request = ++generation
    tint.value = null
    if (!props.album.cover && !props.album.coverSource) return
    try {
      const cover = await resolveCover(props.album.cover, props.album.coverSource)
      if (!cover || request !== generation) return
      const color = await extractAverageColor(cover)
      if (request === generation && color) tint.value = normalizeAccentColor(color)
    } catch {
      /* Neutral theme background is the fallback for unreadable artwork. */
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  generation++
})
</script>

<template>
  <section class="album-detail-header" :style="ambientStyle" aria-labelledby="local-album-title">
    <AlbumArtwork
      class="album-detail-artwork"
      :cover="album.cover"
      :cover-source="album.coverSource"
      :identity="album.id"
      :name="album.name"
      eager
    />
    <div class="album-detail-information">
      <span class="album-detail-kicker">本地专辑</span>
      <h2 id="local-album-title" class="album-detail-title" :title="album.name">
        {{ album.name }}
      </h2>
      <p class="album-detail-artist" :title="album.artist || '未知歌手'">
        {{ album.artist || '未知歌手' }}
      </p>
      <p class="album-detail-release">{{ formatReleaseDate(album.releaseDate) }}</p>
      <p class="album-detail-stats">
        {{ album.trackCount }} 首<span v-if="durationText"> · {{ durationText }}</span>
      </p>
      <div class="album-detail-actions">
        <button
          type="button"
          class="album-play-primary"
          :disabled="!canPlay"
          @click="$emit('play')"
        >
          <PlaybackIcon name="play" aria-hidden="true" />播放全部
        </button>
        <button
          type="button"
          class="album-play-secondary"
          :disabled="!canPlay"
          @click="$emit('shuffle')"
        >
          <i class="pi pi-sort-alt" aria-hidden="true"></i>随机播放
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.album-detail-header {
  --album-tint: var(--te-primary-500);
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  align-items: center;
  gap: 32px;
  position: relative;
  isolation: isolate;
  padding: 28px 32px 36px;
  margin-bottom: 24px;
}
.album-detail-header::before {
  content: '';
  position: absolute;
  z-index: -1;
  inset: -10px -12px -20px;
  pointer-events: none;
  border-radius: 28px;
  background: radial-gradient(
    ellipse at 12% 16%,
    color-mix(in srgb, var(--album-tint) 17%, transparent),
    transparent 72%
  );
}
.album-detail-artwork {
  width: 240px;
}
.album-detail-information {
  min-width: 0;
}
.album-detail-kicker {
  display: block;
  margin-bottom: 12px;
  font-size: calc(var(--te-font-size-body, 14px) * 0.79);
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--te-neutral-500);
}
.album-detail-title {
  margin: 0 0 14px;
  font-size: clamp(24px, 3vw, 40px);
  font-weight: 750;
  letter-spacing: -0.035em;
  line-height: 1.18;
  color: var(--te-neutral-900);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}
.album-detail-artist {
  margin: 0 0 14px;
  color: var(--te-neutral-700);
  font-size: calc(var(--te-font-size-body, 14px) * 1.14);
  font-weight: 550;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.album-detail-release,
.album-detail-stats {
  margin: 0 0 6px;
  font-size: var(--te-font-size-body, 14px);
  line-height: 1.5;
  color: var(--te-neutral-500);
}
.album-detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 24px;
}
.album-detail-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-height: 40px;
  padding: 0 20px;
  border: 1px solid transparent;
  border-radius: 999px;
  font: inherit;
  font-size: var(--te-font-size-body, 14px);
  font-weight: 600;
  cursor: pointer;
  transition:
    opacity 150ms ease,
    transform 150ms ease-out;
}
.album-play-primary {
  color: var(--te-neutral-50);
  background: var(--te-primary-500);
}
.album-play-secondary {
  color: var(--te-neutral-900);
  background: color-mix(in srgb, var(--te-card-bg) 80%, transparent);
  border-color: color-mix(in srgb, var(--te-neutral-500) 18%, transparent) !important;
}
.album-detail-actions button:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 4px;
}
.album-detail-actions button:active:not(:disabled) {
  transform: scale(0.97);
}
.album-detail-actions button:disabled {
  cursor: default;
  opacity: 0.45;
}
@media (hover: hover) and (pointer: fine) {
  .album-detail-actions button:hover:not(:disabled) {
    opacity: 0.85;
  }
}
@media (max-width: 900px) {
  .album-detail-header {
    grid-template-columns: 200px minmax(0, 1fr);
    gap: 24px;
    padding-inline: 16px;
  }
  .album-detail-artwork {
    width: 200px;
  }
}
@media (max-width: 640px) {
  .album-detail-header {
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
    padding: 16px 4px 28px;
  }
  .album-detail-artwork {
    width: min(240px, 72%);
    justify-self: center;
  }
  .album-detail-information {
    text-align: center;
  }
  .album-detail-actions {
    justify-content: center;
  }
  .album-detail-header::before {
    background: radial-gradient(
      ellipse at 50% 10%,
      color-mix(in srgb, var(--album-tint) 17%, transparent),
      transparent 74%
    );
  }
}
@media (prefers-reduced-motion: reduce) {
  .album-detail-actions button {
    transition: none;
  }
  .album-detail-actions button:active:not(:disabled) {
    transform: none;
  }
}
</style>
