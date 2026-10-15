<script setup lang="ts">
import ThemeIcon from '../ThemeIcon.vue'

const iconSlots = {
  navigation: 'navigation.menu',
  home: 'navigation.home',
  search: 'navigation.search',
  settings: 'navigation.settings',
  appearance: 'navigation.appearance',
  puzzle_piece: 'navigation.plugin',
  arrow_left: 'navigation.back',
  person: 'navigation.person',
  bell: 'navigation.notification',
  bell_off: 'navigation.quiet'
} as const

defineProps<{ name: keyof typeof iconSlots }>()
</script>

<template>
  <ThemeIcon class="title-bar-icon" :icon-slot="iconSlots[name]" />
</template>

<style scoped>
.title-bar-icon {
  display: inline-grid;
  flex: 0 0 auto;
  width: var(--te-titlebar-icon-size, 16px);
  height: var(--te-titlebar-icon-size, 16px);
  font-size: var(--te-titlebar-icon-size, 16px);
}
</style>
