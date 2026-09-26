<script setup lang="ts">
import { computed, toRef } from 'vue'
import { useSmoothedValue } from '@renderer/utils/useSmoothedValue'

const props = withDefaults(defineProps<{ percent: number; as?: 'div' | 'span' }>(), {
  as: 'div'
})

// Playback ticks arrive stepped (~4/s); chase them so the fill glides between
// ticks. Jumps over 2.5% (seek / track switch) snap instead of gliding. The
// per-frame updates stay inside this component so the parent does not re-render.
const smoothedPercent = useSmoothedValue(toRef(props, 'percent'), {
  tau: 160,
  snapThreshold: 2.5
})

const fillStyle = computed(() => ({
  transform: `scaleX(${Math.min(100, Math.max(0, smoothedPercent.value)) / 100})`
}))
</script>

<template>
  <component :is="as" :style="fillStyle"></component>
</template>
