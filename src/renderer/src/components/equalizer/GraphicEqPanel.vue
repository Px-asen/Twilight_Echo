<script setup lang="ts">
import type { EqualizerBand } from '@renderer/types/settings'
import {
  formatFrequency,
  getFillStyle,
  getThumbTop,
  isGainDisabled
} from '@renderer/utils/equalizerPageLogic'

const props = defineProps<{
  preamp: number
  bands: EqualizerBand[]
  autoPreampEnabled: boolean
}>()

// Sliders preview on every input and commit once the gesture ends. Applying to
// the engine per input event issued overlapping async round trips whose
// out-of-order responses left the board showing an earlier gain than the one the
// user dragged to.
const emit = defineEmits<{
  'preview-preamp': [value: number]
  'preview-band': [index: number, patch: Partial<EqualizerBand>]
  commit: []
  advanced: [index: number]
}>()
</script>

<template>
  <section class="sliders-board">
    <div class="slider-column master-column">
      <div class="slider-gain">
        {{ props.preamp > 0 ? '+' + props.preamp.toFixed(1) : props.preamp.toFixed(1) }}
      </div>
      <div class="slider-track">
        <div class="slider-fill" :style="getFillStyle(props.preamp, 24)"></div>
        <div class="slider-thumb" :style="{ top: getThumbTop(props.preamp, 24) }"></div>
        <input
          type="range"
          aria-orientation="vertical"
          min="-24"
          max="24"
          step="0.1"
          :value="props.preamp"
          aria-label="前置增益（dB）"
          :aria-valuetext="`${props.preamp.toFixed(1)} dB`"
          @input="emit('preview-preamp', Number(($event.target as HTMLInputElement).value))"
          @change="emit('commit')"
          class="invisible-range"
        />
      </div>
      <div class="slider-freq">{{ props.autoPreampEnabled ? 'PREAMP · AUTO' : 'PREAMP' }}</div>
    </div>

    <div v-for="(band, index) in props.bands" :key="'band-' + index" class="slider-column">
      <div class="slider-gain">
        {{ band.gain > 0 ? '+' + band.gain.toFixed(1) : band.gain.toFixed(1) }}
      </div>
      <div class="slider-track">
        <div class="slider-fill" :style="getFillStyle(band.gain, 12)"></div>
        <div class="slider-thumb" :style="{ top: getThumbTop(band.gain, 12) }"></div>
        <input
          type="range"
          aria-orientation="vertical"
          min="-12"
          max="12"
          step="0.1"
          :value="band.gain"
          :aria-label="`频段 ${index + 1} · ${formatFrequency(band.frequency)} 增益（dB）`"
          :aria-valuetext="`${band.gain.toFixed(1)} dB`"
          :disabled="isGainDisabled(band)"
          @input="
            emit('preview-band', index, { gain: Number(($event.target as HTMLInputElement).value) })
          "
          @change="emit('commit')"
          class="invisible-range"
        />
      </div>
      <div
        class="slider-freq"
        data-te-interactive
        role="button"
        tabindex="0"
        :aria-label="`高级设置 ${formatFrequency(band.frequency)}`"
        style="cursor: pointer"
        @click="emit('advanced', index)"
        @keydown.enter.prevent="emit('advanced', index)"
        @keydown.space.prevent="emit('advanced', index)"
      >
        {{ formatFrequency(band.frequency) }}
      </div>
    </div>
  </section>
</template>

<style scoped>
.sliders-board {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  min-width: 0;
  overflow-x: auto;
  padding: 24px 8px;
  background: transparent;
  border-top: 1px solid var(--te-control-border);
}
.slider-column {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  flex: 1;
  min-width: 48px;
}
.slider-gain {
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 500;
  color: var(--te-neutral-900);
  font-variant-numeric: tabular-nums;
  padding: 4px 0;
}
.slider-freq {
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 600;
  color: var(--te-neutral-500);
}
.slider-track {
  width: 6px;
  height: var(--te-graphic-slider-height, 180px);
  background: rgba(15, 23, 42, 0.06);
  border-radius: 999px;
  position: relative;
}
.slider-fill {
  position: absolute;
  left: 0;
  width: 100%;
  background: var(--te-control-accent);
  border-radius: 999px;
  z-index: 1;
}
.slider-thumb {
  width: 20px;
  height: 20px;
  background: #fff; /* keep-white: slider knob */
  border-radius: 50%;
  position: absolute;
  left: 50%;
  transform: translate(-50%, -50%);
  box-shadow: none;
  border: 2px solid var(--te-primary-500);
  cursor: grab;
  transition: transform 0.1s;
  z-index: 2;
}
.slider-thumb:hover {
  transform: translate(-50%, -50%) scale(1.2);
}

.invisible-range {
  position: absolute;
  width: var(--te-graphic-slider-height, 180px);
  height: 24px;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) rotate(-90deg);
  opacity: 0;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
  margin: 0;
  z-index: 3;
}

.slider-track:has(.invisible-range:focus-visible) {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 6px;
}

.master-column {
  padding-right: 20px;
  margin-right: 10px;
  border-right: 1px solid var(--te-control-border);
}
.master-column .slider-gain {
  color: var(--te-neutral-900);
}
.master-column .slider-fill {
  background: var(--te-control-accent);
}
.master-column .slider-thumb {
  border-color: var(--te-control-accent);
}

:global(html[data-te-equalizer-slider] .slider-track) {
  background: var(--te-equalizer-slider-track);
}

:global(html[data-te-equalizer-slider] .slider-fill),
:global(html[data-te-equalizer-slider] .master-column .slider-fill) {
  background: var(--te-equalizer-slider-fill);
}

:global(html[data-te-equalizer-slider] .slider-thumb) {
  width: var(--te-equalizer-slider-thumb-size);
  height: var(--te-equalizer-slider-thumb-size);
  background: var(--te-equalizer-slider-thumb);
}

:global(html[data-te-equalizer-slider='ring'] .slider-thumb) {
  border: 2px solid var(--te-primary-500);
}

:global(html[data-te-equalizer-slider='solid'] .slider-thumb) {
  border: 0;
  background: var(--te-primary-500);
}

:global(html[data-te-equalizer-panel] .sliders-board) {
  border-color: var(--te-equalizer-panel-border);
  border-radius: var(--te-equalizer-panel-radius);
  background: var(--te-equalizer-panel-bg);
}

:global(html[data-te-equalizer-panel='tinted'] .sliders-board) {
  background: color-mix(in srgb, var(--te-equalizer-panel-bg) 82%, var(--te-primary-500));
}

:global(html[data-te-equalizer-panel='glass'] .sliders-board) {
  background: color-mix(in srgb, var(--te-equalizer-panel-bg) 68%, transparent);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
}
</style>
