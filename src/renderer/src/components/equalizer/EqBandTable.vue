<script setup lang="ts">
import type { EqualizerBand } from '@renderer/types/settings'
import { filterTypes } from '@renderer/utils/equalizerPageLogic'
const props = defineProps<{
  bands: EqualizerBand[]
  selectedIndices: number[]
  caption?: string
  graphic?: boolean
}>()
const emit = defineEmits<{
  select: [index: number]
  patch: [index: number, patch: Partial<EqualizerBand>]
  remove: [index: number]
}>()
function number(index: number, key: 'frequency' | 'gain' | 'q', event: Event): void {
  const input = event.target as HTMLInputElement
  if (!Number.isFinite(input.valueAsNumber)) {
    input.value = String(props.bands[index][key])
    return
  }
  const [min, max] = key === 'frequency' ? [20, 20000] : key === 'gain' ? [-24, 24] : [0.1, 20]
  emit('patch', index, { [key]: Math.min(max, Math.max(min, input.valueAsNumber)) })
}
</script>
<template>
  <div class="eq-band-table-scroll">
    <table class="eq-band-table">
      <caption>
        {{
          caption ?? '频段'
        }}
      </caption>
      <thead>
        <tr>
          <th>#</th>
          <th>启用</th>
          <th>滤波器</th>
          <th>频率 · Hz</th>
          <th>增益 · dB</th>
          <th>Q</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(band, index) in bands"
          :key="index"
          :class="{ selected: selectedIndices.includes(index) }"
          data-te-interactive
          @click="emit('select', index)"
        >
          <th>
            <button
              type="button"
              :aria-label="`选择频段 ${index + 1}`"
              @click.stop="emit('select', index)"
            >
              {{ String(index + 1).padStart(2, '0') }}
            </button>
          </th>
          <td>
            <input
              type="checkbox"
              :checked="band.enabled !== false"
              :aria-label="`启用频段 ${index + 1}`"
              @change="
                emit('patch', index, { enabled: ($event.target as HTMLInputElement).checked })
              "
            />
          </td>
          <td>
            <select
              :disabled="graphic"
              :value="band.filterType || 'peak'"
              :aria-label="`频段 ${index + 1} 滤波器`"
              @change="
                emit('patch', index, {
                  filterType: ($event.target as HTMLSelectElement)
                    .value as EqualizerBand['filterType']
                })
              "
            >
              <option v-for="filter in filterTypes" :key="filter.value" :value="filter.value">
                {{ filter.label }}
              </option>
            </select>
          </td>
          <td>
            <input
              type="number"
              min="20"
              max="20000"
              step="1"
              :value="band.frequency"
              :aria-label="`频段 ${index + 1} 频率`"
              @change="number(index, 'frequency', $event)"
            />
          </td>
          <td>
            <input
              type="number"
              :min="graphic ? -12 : -24"
              :max="graphic ? 12 : 24"
              step="0.1"
              :value="band.gain"
              :aria-label="`频段 ${index + 1} 增益`"
              @change="number(index, 'gain', $event)"
            />
          </td>
          <td>
            <input
              type="number"
              :min="graphic ? 0.25 : 0.1"
              :max="graphic ? 8 : 20"
              step="0.1"
              :value="band.q"
              :aria-label="`频段 ${index + 1} Q`"
              @change="number(index, 'q', $event)"
            />
          </td>
          <td>
            <button
              type="button"
              class="icon-button"
              :disabled="graphic"
              :aria-label="`删除频段 ${index + 1}`"
              @click.stop="emit('remove', index)"
            >
              <i class="pi pi-times"></i>
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
<style scoped>
.eq-band-table-scroll {
  overflow-x: auto;
  max-width: 100%;
}
.eq-band-table {
  width: 100%;
  border-collapse: collapse;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
}
caption {
  text-align: left;
  color: var(--te-settings-text-muted);
  padding: 16px 0;
}
th,
td {
  text-align: left;
  padding: 10px 8px;
  border-bottom: 1px solid var(--te-settings-control-border, var(--te-card-border));
}
th {
  font-weight: 500;
}
thead {
  color: var(--te-settings-text-muted);
}
td input[type='number'] {
  width: 92px;
  min-width: 70px;
  font-variant-numeric: tabular-nums;
}
td select {
  min-width: 100px;
}
tr.selected {
  background: color-mix(in srgb, var(--te-primary-500) 6%, transparent);
}
th button {
  border: 0;
  padding: 4px;
  color: inherit;
  font: inherit;
  background: transparent;
  cursor: pointer;
}
</style>
