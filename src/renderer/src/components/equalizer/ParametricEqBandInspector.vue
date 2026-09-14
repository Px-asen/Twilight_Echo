<script setup lang="ts">
import { ref } from 'vue'
import EqParameterKnob from '@renderer/components/equalizer/EqParameterKnob.vue'
import { filterUsesGain } from '@renderer/utils/parametricEqInteraction'
import type { EqParameter } from '@renderer/utils/parametricEqKnob'
import type { EqualizerBand, EqualizerFilterType } from '@renderer/types/settings'

const props = defineProps<{
  band: EqualizerBand
  index: number
  filterTypes: { value: EqualizerFilterType; label: string; usesGain: boolean }[]
}>()
const emit = defineEmits<{
  preview: [index: number, patch: Partial<EqualizerBand>]
  commit: []
  toggle: [index: number]
  delete: [index: number]
  filter: [index: number, filterType: EqualizerFilterType]
  close: []
  interaction: [active: boolean]
}>()
const knobs = ref<InstanceType<typeof EqParameterKnob>[]>([])
const parameters: EqParameter[] = ['frequency', 'gain', 'q']
const glyphs: Record<EqualizerFilterType, string> = {
  peak: 'M2 17H7C12 17 10 5 16 5S20 17 25 17H30',
  lowShelf: 'M2 7H10C17 7 15 18 22 18H30',
  highShelf: 'M2 18H10C17 18 15 7 22 7H30',
  bandPass: 'M2 22C9 22 9 6 16 6S23 22 30 22',
  lowPass: 'M2 7H12C22 7 21 19 30 22',
  highPass: 'M2 22C11 19 10 7 20 7H30',
  allPass: 'M2 14H30',
  notch: 'M2 7H9C14 7 12 23 16 23S18 7 23 7H30'
}

function finishInteraction(): void {
  for (const knob of knobs.value) knob.finishInteraction()
}

function act(action: 'toggle' | 'delete' | 'close'): void {
  finishInteraction()
  if (action === 'close') emit('close')
  else if (action === 'delete') emit('delete', props.index)
  else emit('toggle', props.index)
}

function changeFilter(event: Event): void {
  finishInteraction()
  emit('filter', props.index, (event.target as HTMLSelectElement).value as EqualizerFilterType)
}

defineExpose({ finishInteraction })
</script>

<template>
  <section class="band-inspector" aria-label="所选频段参数" @keydown.esc.stop="act('close')">
    <div class="inspector-identity">
      <div class="band-identity-row">
        <button
          type="button"
          class="inspector-icon band-power"
          :class="{ bypassed: band.enabled === false }"
          :aria-label="band.enabled === false ? '启用频段' : '旁路频段'"
          :aria-pressed="band.enabled !== false"
          @click="act('toggle')"
        >
          <i class="pi pi-power-off"></i>
        </button>
        <span class="band-number">BAND {{ String(index + 1).padStart(2, '0') }}</span>
      </div>
      <label class="filter-select">
        <svg viewBox="0 0 32 28" aria-hidden="true"><path :d="glyphs[band.filterType]" /></svg>
        <select aria-label="滤波器类型" :value="band.filterType" @change="changeFilter">
          <option v-for="filter in filterTypes" :key="filter.value" :value="filter.value">
            {{ filter.label }}
          </option>
        </select>
      </label>
      <span class="band-state">{{ band.enabled === false ? '频段已旁路' : 'Shift 精细调节' }}</span>
    </div>
    <div class="precision-controls">
      <EqParameterKnob
        v-for="field in parameters"
        :key="`${band.filterType}-${field}`"
        ref="knobs"
        :field="field"
        :value="band[field]"
        :disabled="field === 'gain' && !filterUsesGain(band.filterType)"
        @preview="emit('preview', index, { [field]: $event })"
        @commit="emit('commit')"
        @interaction="emit('interaction', $event)"
      />
    </div>
    <div class="inspector-actions">
      <button
        type="button"
        class="inspector-icon"
        aria-label="收起频段面板"
        title="收起面板"
        @click="act('close')"
      >
        <i class="pi pi-times"></i>
      </button>
      <button
        type="button"
        class="inspector-icon delete-band"
        aria-label="删除所选频段"
        title="删除频段"
        @click="act('delete')"
      >
        <i class="pi pi-trash"></i>
      </button>
    </div>
  </section>
</template>

<style scoped>
.band-inspector {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 16px;
  width: 100%;
  box-sizing: border-box;
  padding: 14px 34px 9px 14px;
  border: 1px solid var(--eq-border);
  border-radius: 14px;
  color: var(--eq-text);
  background: linear-gradient(165deg, var(--eq-panel-raised), var(--eq-panel));
  box-shadow:
    0 12px 32px var(--eq-shadow),
    inset 0 1px color-mix(in srgb, var(--eq-highlight) 18%, transparent);
  cursor: default;
  color-scheme: var(--eq-color-scheme);
}
.inspector-identity {
  width: 110px;
  flex-shrink: 0;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 12px;
}
.band-identity-row {
  display: flex;
  align-items: center;
  gap: 5px;
}
.band-number {
  font-family: var(--eq-mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  color: var(--band-color);
}
.inspector-icon {
  display: grid;
  place-items: center;
  width: 25px;
  height: 25px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--eq-text-muted);
  cursor: pointer;
  font-size: 11px;
}
.band-power {
  color: var(--band-color);
}
.band-power.bypassed {
  color: var(--eq-text-subtle);
}
.filter-select {
  display: flex;
  align-items: center;
  gap: 5px;
  border-bottom: 1px solid var(--eq-border-soft);
  padding-bottom: 5px;
}
.filter-select svg {
  width: 25px;
  height: 22px;
  flex-shrink: 0;
  fill: none;
  stroke: var(--band-color);
  stroke-width: 1.5;
}
.filter-select select {
  min-width: 0;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--eq-text);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.filter-select option {
  background: var(--eq-panel);
  color: var(--eq-text);
}
.band-state {
  font-size: 9px;
  color: var(--eq-text-subtle);
}
.precision-controls {
  display: grid;
  grid-template-columns: 72px 92px 64px;
  align-items: end;
  gap: 6px;
}
.inspector-actions {
  position: absolute;
  right: 6px;
  top: 6px;
  bottom: 9px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.inspector-icon:focus-visible,
select:focus-visible {
  outline: 2px solid var(--eq-response);
  outline-offset: 2px;
}
@media (hover: hover) and (pointer: fine) {
  .inspector-icon:hover {
    color: var(--eq-text);
    background: var(--eq-control-bg);
  }
  .delete-band:hover {
    color: var(--te-danger-soft-fg);
  }
}
@container eq-workspace (max-width: 520px) {
  .band-inspector {
    flex-wrap: wrap;
    gap: 9px;
    padding: 9px 30px 8px 10px;
  }
  .inspector-identity {
    width: 100%;
    flex-direction: row;
    justify-content: flex-start;
    align-items: center;
    gap: 12px;
  }
  .filter-select {
    padding: 0;
    border: 0;
  }
  .band-state {
    display: none;
  }
  .precision-controls {
    width: 100%;
    grid-template-columns: 1fr 1.1fr 1fr;
  }
}
</style>
