<script setup lang="ts">
import type { EqSlot } from '@renderer/composables/useEqualizerHistory'

defineProps<{ activeSlot: EqSlot; canUndo: boolean; canRedo: boolean }>()
defineEmits<{ command: [action: 'undo' | 'redo' | EqSlot | 'copy'] }>()
</script>

<template>
  <div class="eq-history-controls" role="group" aria-label="编辑历史和 A/B 对比">
    <button
      type="button"
      aria-label="撤销"
      title="撤销 (Ctrl+Z)"
      :disabled="!canUndo"
      @click="$emit('command', 'undo')"
    >
      <i class="pi pi-undo"></i>
    </button>
    <button
      type="button"
      aria-label="重做"
      title="重做 (Ctrl+Shift+Z / Ctrl+Y)"
      :disabled="!canRedo"
      @click="$emit('command', 'redo')"
    >
      <i class="pi pi-refresh"></i>
    </button>
    <button
      v-for="slot in ['A', 'B'] as const"
      :key="slot"
      type="button"
      :class="{ active: activeSlot === slot }"
      :aria-pressed="activeSlot === slot"
      :aria-label="`切换到 ${slot} 组`"
      @click="$emit('command', slot)"
    >
      {{ slot }}
    </button>
    <button
      type="button"
      :title="`将当前参数复制到 ${activeSlot === 'A' ? 'B' : 'A'} 组`"
      @click="$emit('command', 'copy')"
    >
      {{ activeSlot === 'A' ? 'A → B' : 'B → A' }}
    </button>
  </div>
</template>

<style scoped>
.eq-history-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  color: var(--eq-text-muted, var(--te-neutral-700));
}
button {
  min-width: 28px;
  min-height: 30px;
  padding: 0 5px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
button.active,
button:hover:not(:disabled) {
  color: var(--eq-response, var(--te-control-fg));
  background: var(--eq-control-bg, var(--te-control-bg-active));
}
button:disabled {
  opacity: 0.35;
  cursor: default;
}
button:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
}
</style>
