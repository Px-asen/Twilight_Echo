<script setup lang="ts">
import {
  THEME_ICON_SLOT_REGISTRY,
  type ThemeIconFamily,
  type ThemeIconSlot
} from '../../../shared/theme.ts'
import { useThemeIconImage } from '../app/themeIconRuntime'

const props = defineProps<{
  iconSlot: ThemeIconSlot
  defaultOnly?: boolean
}>()

const families: readonly ThemeIconFamily[] = ['outline', 'rounded', 'filled']
const { imageUrl, customReady, failed, imageLoaded, imageFailed } = useThemeIconImage(
  () => props.iconSlot,
  () => props.defaultOnly === true
)
</script>

<template>
  <span
    class="theme-icon"
    :class="[
      `theme-icon-${THEME_ICON_SLOT_REGISTRY[props.iconSlot].domain}`,
      { 'has-custom-icon': customReady }
    ]"
    :data-theme-icon-slot="props.iconSlot"
    :data-theme-icon-custom="customReady ? '' : undefined"
    aria-hidden="true"
  >
    <span class="theme-icon-default">
      <slot>
        <i
          v-for="family in families"
          :key="family"
          class="theme-icon-glyph"
          :class="[
            `theme-icon-family-${family}`,
            THEME_ICON_SLOT_REGISTRY[props.iconSlot].classes[family]
          ]"
        ></i>
      </slot>
    </span>
    <img
      v-if="imageUrl && !failed"
      :key="imageUrl"
      class="theme-icon-image"
      :src="imageUrl"
      alt=""
      draggable="false"
      @load="imageLoaded"
      @error="imageFailed"
    />
  </span>
</template>

<style scoped>
.theme-icon {
  display: inline-grid;
  width: 1em;
  height: 1em;
  flex: 0 0 auto;
  place-items: center;
  color: currentColor;
  line-height: 1;
  pointer-events: none;
}

.theme-icon-default {
  display: inline-grid;
  grid-area: 1 / 1;
  width: 100%;
  height: 100%;
  place-items: center;
}

.has-custom-icon .theme-icon-default {
  visibility: hidden;
}

.theme-icon-image {
  grid-area: 1 / 1;
  width: 100%;
  height: 100%;
  object-fit: contain;
  opacity: 0;
}

.has-custom-icon .theme-icon-image {
  opacity: 1;
}

.theme-icon-glyph {
  display: none;
  grid-area: 1 / 1;
  font-size: 1em;
  line-height: 1;
}

.theme-icon-family-outline {
  display: inline-block;
}

:global(html[data-te-icon-family='rounded'] .theme-icon-family-outline),
:global(html[data-te-icon-family='filled'] .theme-icon-family-outline) {
  display: none;
}

:global(html[data-te-icon-family='rounded'] .theme-icon-family-rounded),
:global(html[data-te-icon-family='filled'] .theme-icon-family-filled) {
  display: inline-block;
}
</style>
