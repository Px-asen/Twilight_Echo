<script setup lang="ts">
import { computed } from 'vue'
import { COMPACT_VISUALIZER_BAND_COUNT, compactSkylineBands } from './compactPlayerBarVisualizer.ts'

const props = defineProps<{
  spectrum: readonly number[]
  waveform: readonly number[]
  active: boolean
  playing: boolean
}>()

const skylineBands = computed(() =>
  compactSkylineBands(
    props.active && props.playing ? props.spectrum : [],
    props.active && props.playing ? props.waveform : []
  )
)
</script>

<template>
  <div
    class="compact-visualizer"
    :class="{ 'is-active': active && playing }"
    :style="{ '--te-compact-band-count': COMPACT_VISUALIZER_BAND_COUNT }"
    aria-hidden="true"
  >
    <span
      v-for="(level, index) in skylineBands"
      :key="index"
      class="compact-visualizer__band"
      :style="{ '--te-compact-band-level': Math.max(0.07, level) }"
    ></span>
  </div>
</template>

<style scoped>
.compact-visualizer {
  position: absolute;
  inset: 0 0 auto;
  z-index: 0;
  height: var(--te-compact-visualizer-height, 138px);
  overflow: hidden;
  pointer-events: none;
  isolation: isolate;
  display: grid;
  grid-template-columns: repeat(var(--te-compact-band-count), minmax(0, 1fr));
  align-items: end;
  gap: clamp(1px, 0.08vw, 2px);
  padding: 0 1px 3px;
  background: transparent;
  box-shadow: inset 0 -1px color-mix(in srgb, var(--te-shell-control-text) 9%, transparent);
}

.compact-visualizer__band {
  width: 100%;
  height: 44px;
  min-width: 1px;
  border-radius: 999px;
  background: color-mix(
    in srgb,
    var(--te-shell-control-text) 68%,
    var(--accent-color, var(--te-primary-500)) 32%
  );
  box-shadow:
    0 0 2px color-mix(in srgb, var(--te-shell-control-text) 28%, transparent),
    0 0 6px color-mix(in srgb, var(--accent-color, var(--te-primary-500)) 18%, transparent);
  opacity: 0.68;
  transform: scaleY(var(--te-compact-band-level));
  transform-origin: 50% 100%;
  transition: transform 55ms linear;
}

.compact-visualizer:not(.is-active) .compact-visualizer__band {
  opacity: 0.3;
}

html[data-theme='dark'] .compact-visualizer,
.player-bar-glass .compact-visualizer {
  background: transparent;
}

html[data-te-motion='reduced'] .compact-visualizer__band {
  transition-duration: var(--te-motion-hover, 100ms);
}

html[data-te-motion='off'] .compact-visualizer__band {
  display: none;
}

@media (forced-colors: active) {
  .compact-visualizer {
    display: none;
  }
}
</style>
