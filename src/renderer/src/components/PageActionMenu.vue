<script setup lang="ts">
import { computed, ref, useId } from 'vue'

const props = defineProps<{ label: string; busy?: boolean }>()
const id = useId()
const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const expanded = ref(false)
const position = ref({ left: 8, top: 8 })
const style = computed(() => ({ left: `${position.value.left}px`, top: `${position.value.top}px` }))
function place(): void {
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect) return
  const width = Math.min(300, window.innerWidth - 16)
  position.value = {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    top: Math.max(8, rect.bottom + 8)
  }
}
function toggled(event: Event): void {
  expanded.value = (event as ToggleEvent).newState === 'open'
  if (!expanded.value || !panel.value) return
  const height = panel.value.getBoundingClientRect().height
  position.value.top = Math.max(8, Math.min(position.value.top, window.innerHeight - height - 8))
}
function acted(event: MouseEvent): void {
  if ((event.target as Element).closest('button')) panel.value?.hidePopover()
}
</script>

<template>
  <span class="page-action-menu">
    <button
      ref="trigger"
      type="button"
      class="page-action-trigger"
      :popovertarget="id"
      :aria-expanded="expanded"
      :aria-controls="id"
      :aria-busy="busy"
      @click="place"
    >
      <i :class="busy ? 'pi pi-spin pi-spinner' : 'pi pi-ellipsis-h'" aria-hidden="true" />
      {{ props.label }}
    </button>
    <div
      :id="id"
      ref="panel"
      popover="auto"
      class="page-action-panel"
      data-te-material="popover"
      role="group"
      :aria-label="label"
      :style="style"
      @toggle="toggled"
      @click="acted"
    >
      <slot />
    </div>
  </span>
</template>

<style scoped>
.page-action-menu {
  display: inline-flex;
  min-width: 0;
}
.page-action-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 6px 12px;
  border: 1px solid var(--te-card-border);
  border-radius: 10px;
  background: var(--te-subtle-bg);
  color: var(--te-neutral-700);
  font: inherit;
  cursor: pointer;
}
.page-action-trigger:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 3px;
}
.page-action-panel {
  position: fixed;
  inset: auto;
  margin: 0;
  box-sizing: border-box;
  width: min(300px, calc(100vw - 16px));
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--te-material-border);
  border-radius: 14px;
  background: var(--te-material-background);
  color: var(--te-material-ink);
  box-shadow: var(--te-material-shadow);
  backdrop-filter: var(--te-material-filter);
  -webkit-backdrop-filter: var(--te-material-filter);
}
.page-action-panel :deep(button) {
  width: 100%;
  justify-content: flex-start;
  gap: 10px;
  min-height: 38px;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.page-action-panel :deep(button:hover:not(:disabled)) {
  background: var(--te-hover-bg);
}
.page-action-panel :deep(button:disabled) {
  opacity: 0.5;
  cursor: default;
}
.page-action-panel :deep(button:focus-visible),
.page-action-panel :deep(select:focus-visible) {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: -2px;
}
</style>
