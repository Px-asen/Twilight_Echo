<script setup lang="ts">
defineProps<{
  name: 'play' | 'pause' | 'previous' | 'next'
}>()
</script>

<template>
  <svg
    class="playback-icon"
    :data-playback-icon="name"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <g v-if="name === 'play'" transform="scale(0.046875)">
      <path
        d="M133 440a35.37 35.37 0 0 1-17.5-4.67c-12-6.8-19.46-20-19.46-34.33V111c0-14.37 7.46-27.53 19.46-34.33a35.13 35.13 0 0 1 35.77.45l247.85 148.36a36 36 0 0 1 0 61l-247.89 148.4A35.5 35.5 0 0 1 133 440"
      />
    </g>
    <template v-else-if="name === 'pause'">
      <rect x="6" y="3" width="4" height="18" rx="1" />
      <rect x="14" y="3" width="4" height="18" rx="1" />
    </template>
    <g v-else :transform="name === 'previous' ? 'translate(24 0) scale(-1 1)' : undefined">
      <path
        d="M4.6 6.1v11.8c0 .78.86 1.26 1.52.84l8.95-5.9a1 1 0 0 0 0-1.68L6.12 5.26c-.66-.42-1.52.06-1.52.84Z"
      />
      <rect x="16.8" y="5.2" width="2.6" height="13.6" rx="1.3" />
    </g>
  </svg>
</template>

<style scoped>
.playback-icon {
  display: inline-block;
  vertical-align: -0.125em;
  pointer-events: none;
  width: 1em;
  height: 1em;
  flex-shrink: 0;
}
</style>
