<script setup lang="ts">
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import type { LibraryItem } from '../../stores/library/musicStoreTypes'
import AlbumArtwork from './AlbumArtwork.vue'
import { formatReleaseDate } from '../../../../shared/releaseDate.ts'

defineProps<{ album: LibraryItem; durationText: string; canPlay: boolean }>()
defineEmits<{ play: []; shuffle: [] }>()
</script>

<template>
  <section class="album-detail-header" aria-labelledby="local-album-title">
    <AlbumArtwork
      class="album-detail-artwork"
      :cover="album.cover"
      :cover-source="album.coverSource"
      :identity="album.id"
      :name="album.name"
      eager
    />
    <div class="album-detail-information">
      <h2 id="local-album-title" class="album-detail-title" :title="album.name">
        {{ album.name }}
      </h2>
      <div class="album-detail-meta">
        <p class="album-detail-artist" :title="album.artist || '未知歌手'">
          {{ album.artist || '未知歌手' }}
        </p>
        <p class="album-detail-release">{{ formatReleaseDate(album.releaseDate) }}</p>
        <p class="album-detail-stats">
          {{ album.trackCount }} 首<span v-if="durationText"> · {{ durationText }}</span>
        </p>
      </div>
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
  --album-detail-cover-size: 160px;
  display: grid;
  grid-template-columns: var(--album-detail-cover-size) minmax(0, 1fr);
  align-items: start;
  gap: 24px;
  position: relative;
  isolation: isolate;
  padding: 0;
  margin-bottom: 24px;
}
.album-detail-artwork {
  width: var(--album-detail-cover-size);
}
.album-detail-information {
  min-width: 0;
}
.album-detail-title {
  margin: 0 0 8px;
  font-size: var(--te-type-page-title);
  font-weight: var(--te-type-weight-strong);
  letter-spacing: -0.015em;
  line-height: 1.2;
  color: var(--te-neutral-900);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.album-detail-artist {
  max-width: 100%;
  min-width: 0;
  margin: 0;
  color: var(--te-neutral-700);
  font-size: var(--te-type-body);
  font-weight: var(--te-type-weight-medium);
  line-height: 1.3;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.album-detail-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 12px;
  row-gap: 4px;
}
.album-detail-release,
.album-detail-stats {
  margin: 0;
  font-size: var(--te-type-caption);
  line-height: 1.5;
  color: var(--te-neutral-500);
}
.album-detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.album-detail-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: var(--te-control-height-md);
  padding: 6px 16px;
  border: 1px solid transparent;
  border-radius: var(--te-control-radius-sm, 8px);
  font: inherit;
  font-size: var(--te-type-caption);
  font-weight: 500;
  cursor: pointer;
  transition:
    opacity 150ms ease,
    transform 150ms ease-out;
}
.album-play-primary {
  color: var(--te-control-on-accent);
  background: var(--te-primary-500);
}
.album-play-secondary {
  color: var(--te-neutral-900);
  background: var(--te-subtle-bg);
  border-color: var(--te-card-border) !important;
}
.album-detail-actions button:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
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
@media (max-height: 760px), (max-width: 640px) {
  .album-detail-header {
    --album-detail-cover-size: 120px;
    gap: 16px;
    margin-bottom: 16px;
  }
}
@container (max-width: 640px) {
  .album-detail-header {
    --album-detail-cover-size: 120px;
    gap: 16px;
    margin-bottom: 16px;
  }
}
@container (max-width: 360px) {
  .album-detail-header {
    --album-detail-cover-size: 96px;
    gap: 12px;
  }
}
@media (prefers-reduced-motion: reduce) {
  @scope (:root:not([data-te-motion='full'])) {
    .album-detail-actions button {
      transition: none;
    }
    .album-detail-actions button:active:not(:disabled) {
      transform: none;
    }
  }
}
</style>
