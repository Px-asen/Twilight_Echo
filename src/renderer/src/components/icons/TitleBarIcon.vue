<script setup lang="ts">
import { titleBarIconPaths } from './titleBarIconPaths'

defineProps<{ name: keyof typeof titleBarIconPaths }>()
</script>

<template>
  <svg
    class="title-bar-icon"
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(path, index) in titleBarIconPaths[name]" :key="index" :d="path" />
  </svg>
</template>

<style scoped>
.title-bar-icon {
  display: block;
  flex: 0 0 auto;
  width: var(--te-titlebar-icon-size, 16px);
  height: var(--te-titlebar-icon-size, 16px);
}
</style>
