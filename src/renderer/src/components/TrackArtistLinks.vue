<script setup lang="ts">
import { computed } from 'vue'
import type { Track, TrackArtistRef } from '../types/music'
import { libraryArtistCredits } from '../../../shared/libraryCollections.ts'

const props = defineProps<{ track: Pick<Track, 'artist' | 'artists' | 'identityTags'> }>()
const emit = defineEmits<{ openArtist: [artist: TrackArtistRef] }>()

const artists = computed<TrackArtistRef[]>(() => libraryArtistCredits(props.track))
</script>

<template>
  <span class="artist-links">
    <template v-for="(artist, index) in artists" :key="index">
      <span v-if="index > 0" class="artist-separator" aria-hidden="true">/</span>
      <button
        type="button"
        class="artist-link"
        :title="artist.name"
        @click.stop="emit('openArtist', artist)"
        @dblclick.stop
        @keydown.stop
        @keyup.stop
      >
        {{ artist.name }}
      </button>
    </template>
  </span>
</template>

<style scoped>
.artist-links {
  display: inline-flex;
  max-width: 100%;
  min-width: 0;
  gap: 4px;
  vertical-align: bottom;
}

.artist-separator {
  flex: none;
}

.artist-link {
  flex: 0 1 auto;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.artist-link:hover {
  text-decoration: underline;
}

.artist-link:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
</style>
