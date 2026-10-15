<script setup lang="ts">
import ThemeIcon from './ThemeIcon.vue'

defineProps<{ open: boolean; liquidMaterial?: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    type="button"
    class="sidebar-bookmark no-drag"
    :class="{ 'sidebar-bookmark--open': open, 'sidebar-bookmark-liquid': liquidMaterial }"
    :aria-expanded="open"
    aria-controls="app-sidebar"
    aria-label="侧边栏"
    :title="open ? '收起侧边栏' : '展开侧边栏'"
    @click="emit('toggle')"
  >
    <ThemeIcon icon-slot="navigation.expand" />
  </button>
</template>

<style scoped>
.sidebar-bookmark {
  --te-bookmark-feedback-duration: var(--te-motion-fast, 160ms);
  position: fixed;
  top: calc(var(--te-window-content-top, var(--te-titlebar-inset, 40px)) + 6px);
  left: calc(var(--te-window-surface-inset, 4px) + 4px);
  z-index: var(--te-overlay-panel-layer, 1000);
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--te-control-radius-sm, 8px);
  appearance: none;
  background: transparent;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  color: var(--te-chrome-text, var(--te-navigation-text));
  font-family: var(--te-font-sans);
  font-size: 16px;
  cursor: pointer;
  pointer-events: auto;
  transition: left var(--te-motion-panel, 220ms) var(--te-ease-soft, ease);
}
.sidebar-bookmark--open {
  left: min(
    calc(var(--te-window-surface-inset, 4px) + var(--te-menu-width, 260px) + 4px),
    calc(100vw - 40px)
  );
}
.sidebar-bookmark::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(
    --te-bookmark-surface,
    var(--te-bookmark-default-surface, var(--te-chrome-navigation-surface))
  );
  backdrop-filter: var(--te-bookmark-effective-filter);
  -webkit-backdrop-filter: var(--te-bookmark-effective-filter);
  opacity: 0;
  transition: opacity var(--te-bookmark-feedback-duration) ease;
  pointer-events: none;
}
.sidebar-bookmark-liquid {
  --te-bookmark-default-surface: var(--te-chrome-attached-liquid-surface);
  --te-bookmark-default-filter: var(--te-chrome-attached-liquid-filter);
}
.sidebar-bookmark::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--te-chrome-control-selected);
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--te-bookmark-feedback-duration) ease;
}
.sidebar-bookmark :deep(.theme-icon) {
  position: relative;
  opacity: 0.6;
  font-size: 14px;
}
.sidebar-bookmark--open :deep(.theme-icon) {
  transform: rotate(180deg);
}
.sidebar-bookmark:hover {
  color: var(--te-text);
}
.sidebar-bookmark:hover :deep(.theme-icon),
.sidebar-bookmark:focus-visible :deep(.theme-icon) {
  opacity: 1;
}
.sidebar-bookmark:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 1px;
}
.sidebar-bookmark:is(:hover, :focus-visible)::before,
.sidebar-bookmark:is(:hover, :focus-visible)::after {
  opacity: 1;
}
:global(html[data-te-motion='off'] .sidebar-bookmark),
:global(html[data-te-motion='reduced'] .sidebar-bookmark) {
  --te-bookmark-feedback-duration: 0ms;
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  .sidebar-bookmark {
    --te-bookmark-feedback-duration: 0ms;
    transition: none;
  }
}
:global(html[data-te-effects-mode='reduced'] .sidebar-bookmark),
:global(body.te-no-blur .sidebar-bookmark) {
  --te-bookmark-surface: var(--te-chrome-material-solid);
  --te-bookmark-filter: none;
}
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .sidebar-bookmark {
    --te-bookmark-surface: var(--te-chrome-material-solid);
    --te-bookmark-filter: none;
  }
}
@supports not (backdrop-filter: blur(1px)) {
  .sidebar-bookmark {
    --te-bookmark-surface: var(--te-chrome-material-solid);
    --te-bookmark-filter: none;
  }
}
@media (forced-colors: active) {
  .sidebar-bookmark::before {
    background: Canvas;
    backdrop-filter: none;
  }
  .sidebar-bookmark {
    color: ButtonText;
  }
  .sidebar-bookmark:focus-visible {
    outline-color: Highlight;
  }
}
</style>
