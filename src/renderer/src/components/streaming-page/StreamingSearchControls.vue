<script setup lang="ts">
import type { SearchSource, SearchSourceOption, SearchType } from './useStreamingSearch'
const props = defineProps<{
  searchType: SearchType
  availableSearchTypes: SearchType[]
  searchSources: SearchSourceOption[]
  searchSource: SearchSource
}>()
const emit = defineEmits<{
  'update:searchType': [value: SearchType]
  'select-source': [value: SearchSource]
}>()
const searchTypes = [
  { value: 'songs', label: '单曲' },
  { value: 'albums', label: '专辑' },
  { value: 'playlists', label: '歌单' },
  { value: 'artists', label: '歌手' }
] as const
function selectSearchSource(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  const source = props.searchSources.find((candidate) => candidate.id === value)
  if (source?.available) emit('select-source', source.id)
}
</script>

<template>
  <div class="streaming-search-tabs">
    <div class="search-type-group" role="group" aria-label="搜索类型">
      <button
        v-for="type in searchTypes"
        :key="type.value"
        type="button"
        class="search-tab-pill"
        :class="{ active: searchType === type.value }"
        :disabled="!availableSearchTypes.includes(type.value)"
        :aria-pressed="searchType === type.value"
        @click="emit('update:searchType', type.value)"
      >
        {{ type.label }}
      </button>
    </div>
    <label class="search-source-field">
      <span class="search-source-label">来源</span>
      <select
        class="search-source-trigger"
        aria-label="搜索音源"
        :value="searchSource"
        @change="selectSearchSource"
      >
        <option
          v-for="source in searchSources"
          :key="source.id"
          :value="source.id"
          :disabled="!source.available"
        >
          {{ source.label }}{{ source.available ? '' : '（暂不可用）' }}
        </option>
      </select>
    </label>
  </div>
</template>

<style scoped src="./StreamingSearchControls.css"></style>
