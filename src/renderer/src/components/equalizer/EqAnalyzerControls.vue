<script setup lang="ts">
import type { SpectrumRange, SpectrumSpeed } from '@renderer/utils/eqSpectrum'

defineProps<{ frozen: boolean; peakHold: boolean; range: SpectrumRange; speed: SpectrumSpeed }>()
const emit = defineEmits<{
  'update:frozen': [value: boolean]
  'update:peakHold': [value: boolean]
  'update:range': [value: SpectrumRange]
  'update:speed': [value: SpectrumSpeed]
  'reset-peaks': []
}>()

function changeRange(event: Event): void {
  emit('update:range', Number((event.target as HTMLSelectElement).value) as SpectrumRange)
}
function changeSpeed(event: Event): void {
  emit('update:speed', (event.target as HTMLSelectElement).value as SpectrumSpeed)
}
</script>

<template>
  <div class="analyzer-controls" role="group" aria-label="频谱分析器控制">
    <button type="button" :aria-pressed="frozen" @click="emit('update:frozen', !frozen)">
      冻结
    </button>
    <button type="button" :aria-pressed="peakHold" @click="emit('update:peakHold', !peakHold)">
      峰值保持
    </button>
    <button type="button" :disabled="!peakHold" @click="emit('reset-peaks')">清除峰值</button>
    <details>
      <summary>频谱设置</summary>
      <div class="analyzer-settings">
        <label
          >显示窗口<select aria-label="频谱显示窗口" :value="range" @change="changeRange">
            <option v-for="value in [60, 90, 100]" :key="value" :value="value">
              {{ value }} dB
            </option>
          </select></label
        >
        <label
          >回落速度<select aria-label="频谱回落速度" :value="speed" @change="changeSpeed">
            <option value="fast">快</option>
            <option value="medium">中</option>
            <option value="slow">慢</option>
          </select></label
        >
        <p>顶部 +10 dB · 底部 {{ 10 - range }} dB</p>
        <p>虚线为保持峰值，清除后重新累积。</p>
      </div>
    </details>
  </div>
</template>

<style scoped>
.analyzer-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--eq-text-muted);
  font-size: 11px;
}
button,
summary {
  border: 0;
  padding: 4px 0;
  color: inherit;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
button[aria-pressed='true'] {
  color: var(--eq-response);
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
details {
  position: relative;
}
.analyzer-settings {
  position: absolute;
  bottom: calc(100% + 10px);
  right: 0;
  width: 210px;
  padding: 12px;
  border: 1px solid var(--eq-border);
  border-radius: 8px;
  background: var(--eq-panel-raised);
  box-shadow: 0 8px 24px var(--eq-shadow);
  z-index: 50;
}
label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
select {
  color: var(--eq-text);
  background: var(--eq-panel);
  border: 1px solid var(--eq-border);
  border-radius: 4px;
  padding: 4px;
  font: inherit;
}
p {
  margin: 8px 0 0;
  color: var(--eq-text-subtle);
  font-size: 10px;
}
button:focus-visible,
summary:focus-visible,
select:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
}
</style>
