<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  tokens?: Record<string, string>
  variables?: Record<string, string>
  kind?: 'theme' | 'plugin' | 'project'
}>()
const palette = computed(() => {
  const colors: Record<string, string> = {}
  const roles = {
    background: ['surface.app', '--te-app-bg'],
    surface: ['surface.card', '--te-card-bg'],
    sidebar: ['navigation.surface', '--te-navigation-bg'],
    player: ['surface.player', '--te-player-bg'],
    accent: ['color.primary.500', '--te-primary-500'],
    text: ['settings.text.primary', '--te-settings-text'],
    muted: ['settings.text.muted', '--te-settings-text-muted']
  }
  for (const [role, [token, variable]] of Object.entries(roles)) {
    const value = props.tokens?.[token] ?? props.variables?.[variable]
    if (value && CSS.supports('color', value)) colors['--theme-preview-' + role] = value
  }
  return colors
})
</script>

<template>
  <span
    class="theme-preview"
    :style="palette"
    :data-preview-kind="kind ?? 'theme'"
    aria-hidden="true"
  >
    <template v-if="!kind || kind === 'theme'">
      <span class="theme-preview-window">
        <span class="theme-preview-titlebar"><i /><i /><i /><b /></span>
        <span class="theme-preview-sidebar"><b /><i /><i /><i /></span>
        <span class="theme-preview-content">
          <span class="theme-preview-heading"><b /><i /></span>
          <span class="theme-preview-albums"><i /><i /><i /></span>
          <span class="theme-preview-tracks"><i /><i /></span>
        </span>
        <span class="theme-preview-player"><i /><b /><span /><i /><i /></span>
      </span>
    </template>
    <template v-else>
      <span class="theme-preview-symbol"
        ><i :class="kind === 'project' ? 'pi pi-folder' : 'pi pi-palette'"
      /></span>
      <span class="theme-preview-dots"><i /><i /><i /></span>
    </template>
  </span>
</template>

<style scoped>
.theme-preview {
  --theme-preview-background: var(--te-app-bg);
  --theme-preview-surface: var(--appearance-edit-field);
  --theme-preview-sidebar: var(--theme-preview-surface);
  --theme-preview-player: var(--theme-preview-surface);
  --theme-preview-accent: var(--te-control-accent);
  --theme-preview-text: var(--appearance-edit-text);
  --theme-preview-muted: var(--appearance-edit-muted);
  display: flex;
  position: relative;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 2.15;
  max-height: 160px;
  min-height: 108px;
  overflow: hidden;
  border-radius: var(--te-control-radius-md, 10px);
  background: var(--theme-preview-background);
  color: var(--theme-preview-text);
  pointer-events: none;
}
.theme-preview::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--theme-preview-accent);
  opacity: 0.12;
}
.theme-preview-window {
  position: relative;
  display: grid;
  grid-template-columns: 21% 1fr;
  grid-template-rows: 12px 1fr 19px;
  width: 82%;
  height: 78%;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--theme-preview-text) 12%, transparent);
  border-radius: 6px;
  background: var(--theme-preview-background);
  box-shadow: var(--te-settings-shadow-soft);
}
.theme-preview-titlebar {
  display: flex;
  align-items: center;
  gap: 3px;
  grid-column: 1 / -1;
  padding: 0 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--theme-preview-text) 6%, transparent);
}
.theme-preview-titlebar i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--theme-preview-text);
  opacity: 0.26;
}
.theme-preview-titlebar b {
  width: 24px;
  height: 2px;
  margin: 0 auto;
  background: var(--theme-preview-text);
  opacity: 0.14;
}
.theme-preview-sidebar {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 6px;
  background: var(--theme-preview-sidebar);
}
.theme-preview-sidebar b,
.theme-preview-sidebar i {
  display: block;
  height: 3px;
  border-radius: 2px;
  background: var(--theme-preview-muted);
  opacity: 0.24;
}
.theme-preview-sidebar b {
  height: 5px;
  background: var(--theme-preview-accent);
  opacity: 1;
}
.theme-preview-content {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 7px;
  padding: 9px 11px;
}
.theme-preview-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.theme-preview-heading b {
  width: 32%;
  height: 4px;
  border-radius: 2px;
  background: var(--theme-preview-text);
  opacity: 0.65;
}
.theme-preview-heading i {
  width: 14%;
  height: 3px;
  border-radius: 2px;
  background: var(--theme-preview-muted);
  opacity: 0.3;
}
.theme-preview-albums {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  min-height: 0;
  flex: 1;
}
.theme-preview-albums i {
  min-height: 16px;
  border-radius: 3px;
  background: var(--theme-preview-accent);
}
.theme-preview-albums i:nth-child(2) {
  opacity: 0.65;
}
.theme-preview-albums i:nth-child(3) {
  opacity: 0.4;
}
.theme-preview-tracks {
  display: grid;
  gap: 4px;
}
.theme-preview-tracks i {
  height: 2px;
  border-radius: 2px;
  background: var(--theme-preview-muted);
  opacity: 0.18;
}
.theme-preview-tracks i:last-child {
  width: 75%;
}
.theme-preview-player {
  display: flex;
  align-items: center;
  gap: 4px;
  grid-column: 1 / -1;
  padding: 0 7px;
  background: var(--theme-preview-player);
}
.theme-preview-player > i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--theme-preview-text);
  opacity: 0.3;
}
.theme-preview-player > i:first-child {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  background: var(--theme-preview-accent);
  opacity: 1;
}
.theme-preview-player > b {
  width: 18%;
  height: 3px;
  border-radius: 2px;
  background: var(--theme-preview-text);
  opacity: 0.4;
}
.theme-preview-player > span {
  flex: 1;
  height: 2px;
  margin: 0 6px;
  background: var(--theme-preview-accent);
  opacity: 0.5;
}
.theme-preview-symbol {
  position: relative;
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border-radius: 16px;
  color: var(--theme-preview-accent);
  background: var(--theme-preview-surface);
  font-size: 24px;
}
.theme-preview-dots {
  display: flex;
  position: absolute;
  bottom: 14px;
  gap: 5px;
}
.theme-preview-dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--theme-preview-accent);
  opacity: 0.38;
}
</style>
