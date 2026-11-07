<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatClock, volumeIcon } from './zonesPresentation.ts'

/**
 * Progress, transport and volume of one zone or sync group. Commands leave
 * through events; the page owns revisions and pending state.
 */
const props = withDefaults(
  defineProps<{
    /** Accessible owner name, e.g. "书房" or "同步组 客厅 + 书房". */
    owner: string
    state: string | null | undefined
    position: number
    duration: number
    volume: number
    /** Transport is possible at all (a queue exists and the output is usable). */
    playable: boolean
    /** Why play is unavailable, shown as the button title. */
    reason?: string
    /** Action kind currently waiting on Core, if any. */
    pending?: string | null
    size?: 'md' | 'lg'
  }>(),
  { reason: '', pending: null, size: 'md' }
)

const emit = defineEmits<{
  play: []
  pause: []
  previous: []
  next: []
  seek: [position: number]
  volume: [volume: number]
}>()

const playing = computed(() => props.state === 'playing')
const busy = computed(() => Boolean(props.pending))
const seekDraft = ref<number | null>(null)
const volumeDraft = ref<number | null>(null)
const shownPosition = computed(() => seekDraft.value ?? props.position)
const shownVolume = computed(() => volumeDraft.value ?? props.volume)
const seekable = computed(() => props.playable && props.duration > 0 && !busy.value)
const progress = computed(() =>
  props.duration > 0 ? Math.min(1, Math.max(0, shownPosition.value / props.duration)) : 0
)

function readRange(event: Event): number {
  return Number((event.target as HTMLInputElement).value)
}
function onSeekInput(event: Event): void {
  seekDraft.value = readRange(event)
}
function onSeekChange(event: Event): void {
  const value = readRange(event)
  seekDraft.value = null
  emit('seek', value)
}
function onVolumeInput(event: Event): void {
  volumeDraft.value = readRange(event) / 100
}
function onVolumeChange(event: Event): void {
  const value = readRange(event) / 100
  volumeDraft.value = null
  emit('volume', value)
}
function toggle(): void {
  if (playing.value) emit('pause')
  else emit('play')
}
</script>

<template>
  <div class="zone-deck" :class="[`is-${size}`, { 'is-playing': playing, 'is-idle': !playable }]">
    <div class="zone-progress">
      <span
        class="zone-progress-track"
        :style="{ '--zone-progress': `${(progress * 100).toFixed(3)}%` }"
      >
        <input
          type="range"
          min="0"
          :max="Math.max(1, Math.floor(duration))"
          step="1"
          :value="Math.floor(shownPosition)"
          :disabled="!seekable"
          :aria-label="`${owner}的播放进度`"
          :aria-valuetext="`${formatClock(shownPosition)} / ${formatClock(duration)}`"
          @input="onSeekInput"
          @change="onSeekChange"
        />
      </span>
      <span class="zone-progress-times">
        <span>{{ formatClock(shownPosition) }}</span>
        <span>{{ duration > 0 ? formatClock(duration) : '--:--' }}</span>
      </span>
    </div>
    <div class="zone-deck-row">
      <div class="zone-transport" role="group" :aria-label="`${owner}的播放控制`">
        <button
          type="button"
          class="zone-icon-button"
          :disabled="!playable || busy"
          title="上一首"
          aria-label="上一首"
          @click="emit('previous')"
        >
          <i class="ph-fill ph-skip-back" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="zone-play-button"
          :class="{ 'is-busy': busy }"
          :disabled="busy || (!playing && !playable)"
          :title="!playing && !playable ? reason || '无法播放' : playing ? '暂停' : '播放'"
          :aria-label="playing ? `暂停${owner}` : `播放${owner}`"
          :aria-busy="busy || undefined"
          @click="toggle"
        >
          <i
            class="ph-fill"
            :class="busy ? 'ph-circle-notch' : playing ? 'ph-pause' : 'ph-play'"
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          class="zone-icon-button"
          :disabled="!playable || busy"
          title="下一首"
          aria-label="下一首"
          @click="emit('next')"
        >
          <i class="ph-fill ph-skip-forward" aria-hidden="true" />
        </button>
      </div>
      <label class="zone-volume" :class="{ 'is-muted': shownVolume <= 0.001 }">
        <i class="ph" :class="volumeIcon(shownVolume)" aria-hidden="true" />
        <span
          class="zone-volume-track"
          :style="{ '--zone-volume': `${Math.round(shownVolume * 100)}%` }"
        >
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            :value="Math.round(shownVolume * 100)"
            :aria-label="`${owner}的音量`"
            :aria-valuetext="`${Math.round(shownVolume * 100)}%`"
            @input="onVolumeInput"
            @change="onVolumeChange"
          />
        </span>
        <span class="zone-volume-value" aria-hidden="true">{{ Math.round(shownVolume * 100) }}</span>
      </label>
    </div>
  </div>
</template>
