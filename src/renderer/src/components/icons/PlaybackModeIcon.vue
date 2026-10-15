<script setup lang="ts">
import ThemeIcon from '../ThemeIcon.vue'
import repeatIcon from '../../assets/icons/single-song-repeat.svg'
import listLoopIcon from '../../assets/icons/list-loop-repeat.svg'
import sequentialIcon from '../../assets/icons/sequential-playback.svg'
import shuffleIcon from '../../assets/icons/shuffle.svg'
import heartModeIcon from '../../assets/icons/heart-mode.svg'

const images = {
  sequential: sequentialIcon,
  listLoop: listLoopIcon,
  repeat: repeatIcon,
  shuffle: shuffleIcon,
  heart: heartModeIcon
}
const glyphs = {
  sequential: 'ph ph-arrow-right',
  listLoop: 'ph ph-repeat',
  repeat: 'ph ph-repeat-once',
  shuffle: 'ph ph-shuffle',
  heart: 'ph ph-heart-half'
}
const slots = {
  sequential: 'playback.sequential',
  listLoop: 'playback.listLoop',
  repeat: 'playback.repeat',
  shuffle: 'playback.shuffle',
  heart: 'playback.heart'
} as const
withDefaults(
  defineProps<{ mode: keyof typeof slots; variant?: 'image' | 'font'; defaultOnly?: boolean }>(),
  {
    variant: 'image'
  }
)
</script>

<template>
  <ThemeIcon
    class="playback-mode-icon"
    :class="{ 'is-font': variant === 'font' }"
    :icon-slot="slots[mode]"
    :default-only="defaultOnly"
  >
    <i v-if="variant === 'font'" :class="glyphs[mode]" class="playback-mode-glyph"></i>
    <img v-else :src="images[mode]" class="playback-mode-default-image" alt="" draggable="false" />
  </ThemeIcon>
</template>

<style scoped>
.playback-mode-icon {
  width: 19px;
  height: 19px;
}
.playback-mode-default-image {
  grid-area: 1 / 1;
  width: 100%;
  height: 100%;
  object-fit: contain;
  opacity: 0.58;
}
.player-bar-glass .playback-mode-default-image {
  filter: brightness(0) invert(1);
  opacity: 0.55;
}
.heart-mode-active .playback-mode-default-image {
  opacity: 0.95;
}
html[data-te-player-layout='standard'] .player-bar-transport-grouped .playback-mode-icon {
  width: 20px;
  height: 20px;
}
html[data-te-player-layout='standard'] .player-bar-transport-grouped .playback-mode-default-image {
  opacity: 0.75;
}
.playback-mode-icon.is-font {
  width: 1em;
  height: 1em;
}
.playback-mode-glyph {
  grid-area: 1 / 1;
  font-size: 1em;
  line-height: 1;
}
</style>
