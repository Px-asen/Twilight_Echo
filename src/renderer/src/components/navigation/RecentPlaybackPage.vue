<script setup lang="ts">
import { defineAsyncComponent } from 'vue'

const SongList = defineAsyncComponent(() => import('@renderer/components/SongList.vue'))
defineProps<{
  hasPlayer: boolean
  active: boolean
  target?: { kind: 'recent'; scope?: 'device' | 'platform'; providerId?: string }
}>()
const emit = defineEmits<{
  selectView: [category: string, filter: string | null]
}>()
</script>

<template>
  <section class="recent-playback-page">
    <SongList
      category="recent"
      :filter="null"
      :has-player="hasPlayer"
      :recent-provider-id="target?.providerId"
      transition-name="page-down"
      @select-view="(category, filter) => emit('selectView', category, filter)"
    />
  </section>
</template>

<style scoped>
.recent-playback-page {
  --recent-content-inset: min(4.4vw, 48px);
  --recent-header-inset: 32px;
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 0;
  min-width: 0;
  container: te-recent-page / inline-size;
}
.recent-playback-page :deep(.song-list) {
  height: 0 !important;
  flex: 1;
  min-height: 0;
  padding-top: 24px;
  padding-inline: var(--recent-content-inset);
}
.recent-playback-page :deep(.song-list-header) {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  min-height: 0;
  gap: 20px;
  padding: 0 var(--recent-header-inset);
  margin-bottom: 20px;
}
.recent-playback-page :deep(.header-right) {
  flex-wrap: nowrap;
  gap: 12px;
}
.recent-playback-page :deep(.recent-source-dropdown),
.recent-playback-page :deep(.library-filter-dropdown) {
  display: flex;
  align-items: center;
}
.recent-playback-page :deep(.search-box) {
  box-sizing: border-box;
  width: clamp(220px, 22vw, 320px);
  min-width: 0;
}
.recent-playback-page :deep(.library-play-actions) {
  padding-inline: var(--recent-header-inset);
}
@container te-recent-page (max-width: 1000px) {
  .recent-playback-page :deep(.song-list-header) {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .recent-playback-page :deep(.header-right) {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
  .recent-playback-page :deep(.search-box) {
    flex: 1 1 220px;
    width: auto;
  }
}
@container te-recent-page (max-width: 640px) {
  .recent-playback-page :deep(.song-list-header),
  .recent-playback-page :deep(.library-play-actions) {
    padding-inline: 10px;
  }
  .recent-playback-page :deep(.search-box) {
    flex-basis: 100%;
  }
}
:global(html[data-theme='pureWhite'] .recent-playback-page) {
  background: var(--te-card-bg);
}
:global(html[data-te-shell-layout='custom'] .recent-playback-page) {
  height: 100%;
}
</style>
