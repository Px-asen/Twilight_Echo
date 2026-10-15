<script setup lang="ts">
import { nextTick, ref } from 'vue'
import AnimatedInput from '../AnimatedInput.vue'
import StreamingProviderSwitcher from './StreamingProviderSwitcher.vue'
import type { StreamingProviderOption } from '../../utils/streamingNavigation'

defineProps<{
  isDetail: boolean
  isSearching: boolean
  showSubtitle: boolean
  title: string
  subtitle: string
  showUnifiedSearch: boolean
  searchQuery: string
  searchLoading: boolean
  providerId: string
  providerOptions: StreamingProviderOption[]
}>()

const emit = defineEmits<{
  back: []
  'clear-search': []
  'update:searchQuery': [value: string]
  'select-provider': [providerId: string]
}>()

const searchInputFocused = ref(false)
const searchBox = ref<HTMLDivElement | null>(null)

const clearSearch = async (): Promise<void> => {
  emit('clear-search')
  await nextTick()
  searchBox.value?.querySelector('input')?.focus()
}
</script>

<template>
  <header
    v-if="!isDetail || showUnifiedSearch || providerOptions.length > 0"
    class="streaming-content-header"
    :class="{
      'is-detail': isDetail,
      'is-searching': isSearching,
      'is-search-workspace': showUnifiedSearch && !isDetail
    }"
  >
    <div class="streaming-header-left">
      <button
        v-if="isDetail"
        type="button"
        class="detail-back-button"
        data-te-back-button="pill"
        @click="emit('back')"
      >
        <i class="pi pi-arrow-left" aria-hidden="true"></i>
        <span>返回</span>
      </button>
      <div v-else class="streaming-header-copy">
        <h1 class="streaming-content-title">{{ title }}</h1>
        <p v-if="showSubtitle" class="streaming-content-subtitle">
          {{ subtitle }}
        </p>
      </div>
    </div>
    <div v-if="showUnifiedSearch || providerOptions.length > 0" class="streaming-header-right">
      <div
        v-if="showUnifiedSearch"
        ref="searchBox"
        class="streaming-search-box"
        :class="{ focused: searchInputFocused }"
        role="search"
        aria-label="音乐搜索"
      >
        <i class="pi pi-search streaming-search-icon" aria-hidden="true"></i>
        <AnimatedInput
          :model-value="searchQuery"
          type="search"
          class="streaming-search-input"
          placeholder="搜索歌曲、专辑、歌单、歌手"
          aria-label="搜索歌曲、专辑、歌单和歌手"
          @update:model-value="emit('update:searchQuery', $event)"
          @focus="searchInputFocused = true"
          @blur="searchInputFocused = false"
        />
        <i
          v-if="searchLoading"
          class="pi pi-spin pi-spinner streaming-search-spinner"
          aria-hidden="true"
        ></i>
        <button
          v-if="searchQuery"
          type="button"
          class="streaming-search-clear"
          aria-label="清除搜索"
          @click="clearSearch"
        >
          <i class="pi pi-times" aria-hidden="true"></i>
        </button>
      </div>
      <StreamingProviderSwitcher
        v-if="providerOptions.length > 0"
        class="streaming-header-provider-switcher"
        :model-value="providerId"
        :options="providerOptions"
        @change="emit('select-provider', $event)"
      />
    </div>
  </header>
</template>

<style scoped src="./StreamingContentHeader.css"></style>
