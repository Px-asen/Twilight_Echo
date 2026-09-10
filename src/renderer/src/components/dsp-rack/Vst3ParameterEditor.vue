<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DspGraphNode, Vst3ParameterDescriptor } from '../../../../shared/dspGraph.ts'
import {
  isReadOnlyVst3Parameter,
  setVst3Parameter,
  vst3ParameterStep,
  vst3ParameterValue
} from '@renderer/utils/vst3Parameters'

const props = defineProps<{
  node: DspGraphNode
  parameters: Vst3ParameterDescriptor[]
}>()
const page = ref(0)
const pageSize = 32
const parameters = computed(() =>
  props.parameters.filter((parameter) => (parameter.flags & 16) === 0)
)
const pageCount = computed(() => Math.max(1, Math.ceil(parameters.value.length / pageSize)))
const visibleParameters = computed(() =>
  parameters.value.slice(page.value * pageSize, (page.value + 1) * pageSize)
)
watch([() => props.node.id, () => props.parameters], () => {
  page.value = 0
})
</script>

<template>
  <div v-if="pageCount > 1" class="parameter-pages">
    <button type="button" :disabled="page === 0" aria-label="上一页参数" @click="page -= 1">
      上一页
    </button>
    <span aria-live="polite"
      >{{ page + 1 }} / {{ pageCount }} · {{ parameters.length }} 个参数</span
    >
    <button
      type="button"
      :disabled="page + 1 >= pageCount"
      aria-label="下一页参数"
      @click="page += 1"
    >
      下一页
    </button>
  </div>
  <div class="vst3-parameter-grid">
    <template v-for="parameter in visibleParameters" :key="parameter.id">
      <label v-if="parameter.stepCount === 1" class="switch-field">
        <input
          type="checkbox"
          :checked="vst3ParameterValue(node, parameter.id, parameter.defaultNormalizedValue) >= 0.5"
          :disabled="isReadOnlyVst3Parameter(parameter.flags)"
          @change="
            setVst3Parameter(
              node,
              parameter.id,
              ($event.target as HTMLInputElement).checked ? 1 : 0
            )
          "
        />
        {{ parameter.title }}
      </label>
      <label v-else class="vst3-parameter-field">
        <span
          >{{ parameter.title }}<small v-if="parameter.unit">{{ parameter.unit }}</small></span
        >
        <input
          type="range"
          min="0"
          max="1"
          :step="vst3ParameterStep(parameter.stepCount)"
          :value="vst3ParameterValue(node, parameter.id, parameter.defaultNormalizedValue)"
          :disabled="isReadOnlyVst3Parameter(parameter.flags)"
          @input="setVst3Parameter(node, parameter.id, ($event.target as HTMLInputElement).value)"
        />
        <output>{{
          vst3ParameterValue(node, parameter.id, parameter.defaultNormalizedValue).toFixed(3)
        }}</output>
      </label>
    </template>
  </div>
</template>

<style scoped>
.parameter-pages {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
}
</style>
