<script setup lang="ts">
import PlaybackIcon from '../components/icons/PlaybackIcon.vue'

defineProps<{
  name: 'play' | 'pause' | 'previous' | 'next'
}>()
</script>

<template>
  <PlaybackIcon :name="name" class="mini-glyph" />
</template>
