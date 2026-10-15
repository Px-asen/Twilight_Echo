<script setup lang="ts">
import type { PageDockAction } from '../app/pageDock'
import ThemeIcon from './ThemeIcon.vue'

defineProps<{ actions: readonly PageDockAction[] }>()
</script>

<template>
  <div v-if="actions.length" class="page-dock no-drag" role="toolbar" aria-label="页面 Dock">
    <div class="page-dock-actions">
      <button
        v-for="action in actions"
        :key="action.id"
        type="button"
        class="page-dock-action"
        :data-dock-action="action.id"
        :aria-label="action.label"
        :title="action.label"
        :aria-pressed="action.pressed"
        :disabled="action.disabled"
        @click="action.run()"
      >
        <ThemeIcon :icon-slot="action.icon" />
        <span class="page-dock-action-label">{{ action.label }}</span>
      </button>
    </div>
    <span class="page-dock-divider" aria-hidden="true" />
  </div>
</template>

<style scoped>
.page-dock {
  translate: 0 1px;
  display: flex;
  align-items: center;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 440px;
  height: 32px;
  gap: 10px;
  margin-inline: 12px 4px;
  color: var(--te-shell-control-text);
  background: transparent;
  font-family: var(--te-font-sans);
  line-height: 1;
}

.page-dock-divider {
  flex: 0 0 1px;
  height: 16px;
  background: color-mix(in srgb, currentColor 18%, transparent);
}

.page-dock-actions {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 2px;
  overflow-x: auto;
  scrollbar-width: none;
}

.page-dock-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  gap: 6px;
  min-width: 28px;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}

.page-dock-action :deep(.theme-icon) {
  font-size: 16px;
  align-self: center;
}

.page-dock-action-label {
  display: block;
  line-height: 16px;
}

.page-dock-action:not(:disabled):hover {
  background: var(--te-chrome-control-hover);
}

.page-dock-action[aria-pressed='true'] {
  background: var(--te-chrome-control-selected);
}

.page-dock-action[aria-pressed='true']:not(:disabled):hover {
  background: var(--te-chrome-control-selected-hover);
}

.page-dock-action:not(:disabled):active {
  opacity: 0.75;
}

.page-dock-action:disabled {
  opacity: 0.4;
  cursor: default;
}

.page-dock-action:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: -2px;
}

@media (max-width: 1020px) {
  .page-dock-action-label {
    display: none;
  }
}

@media (max-width: 640px) {
  .page-dock {
    margin-inline: 4px 6px;
  }
}

@media (forced-colors: active) {
  .page-dock-action:focus-visible {
    outline-color: Highlight;
  }
}
</style>
