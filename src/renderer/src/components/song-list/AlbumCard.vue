<script setup lang="ts">
import type { GridItem } from './types'
import AlbumArtwork from './AlbumArtwork.vue'

defineProps<{ album: GridItem }>()
defineEmits<{ open: [] }>()
</script>

<template>
  <button
    type="button"
    class="album-card local-album-card"
    data-te-interactive
    :aria-label="`打开专辑 ${album.name}，${album.artist || '未知歌手'}`"
    @click="$emit('open')"
  >
    <AlbumArtwork
      :cover="album.cover"
      :cover-source="album.coverSource"
      :identity="album.id"
      :name="album.name"
    />
    <span class="local-album-info">
      <span class="local-album-name" :title="album.name">{{ album.name }}</span>
      <span class="local-album-artist" :title="album.artist || '未知歌手'">{{
        album.artist || '未知歌手'
      }}</span>
    </span>
  </button>
</template>

<style scoped>
.album-card.local-album-card {
  appearance: none;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: var(--te-library-cover-radius, 8px);
  background: transparent;
  box-shadow: none;
  text-align: left;
  font: inherit;
  color: var(--te-neutral-900);
  cursor: pointer;
  overflow: visible;
  transform: none;
  transition: opacity 150ms ease;
}
.album-card.local-album-card::before {
  content: none;
}
.album-card.local-album-card:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 5px;
  box-shadow: none;
}
.album-card.local-album-card:active {
  opacity: 0.78;
}
.local-album-info {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  padding: 12px 0 2px;
  gap: 4px;
}
.local-album-name {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  height: 2.8em;
  overflow: hidden;
  overflow-wrap: anywhere;
  font-size: var(--te-type-body);
  font-weight: var(--te-type-weight-strong);
  line-height: 1.4;
}
.local-album-artist,
.local-album-meta {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  line-height: 1.5;
}
.local-album-artist {
  color: var(--te-neutral-700);
  font-size: var(--te-type-caption);
}
.local-album-meta {
  color: var(--te-neutral-500);
  font-size: var(--te-type-caption);
  font-variant-numeric: tabular-nums;
}
@media (hover: hover) and (pointer: fine) {
  .album-card.local-album-card:hover {
    background: transparent;
    transform: none;
    box-shadow: none;
  }
  .local-album-card:hover .local-album-name {
    color: var(--te-primary-500);
  }
}
@media (prefers-reduced-motion: reduce) {
  @scope (:root:not([data-te-motion='full'])) {
    .album-card.local-album-card {
      transition: none;
    }
  }
}
</style>
