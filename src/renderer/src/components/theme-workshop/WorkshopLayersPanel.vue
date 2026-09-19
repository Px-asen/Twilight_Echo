<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  WORKSHOP_SURFACES,
  WORKSHOP_LAYER_LIMIT,
  WORKSHOP_LAYER_STATES,
  createWorkshopLayer,
  type WorkshopLayer,
  type WorkshopSurface
} from '../../../../shared/themeWorkshopLayers'
import { copyWorkshopDraft, type WorkshopProject } from '../../../../shared/themeWorkshop'
import type { ThemeTone } from '../../../../shared/theme'
const props = defineProps<{ project: WorkshopProject; tone: ThemeTone }>()
const emit = defineEmits<{ change: [project: WorkshopProject] }>()
const surface = ref<WorkshopSurface>('app')
const selected = ref('')
const layers = computed(() => props.project.layers?.[props.tone]?.[surface.value] ?? [])
const active = computed(() => layers.value.find((l) => l.id === selected.value))
const numbers = [
  ['x', '横向位置', -100, 200, 1],
  ['y', '纵向位置', -100, 200, 1],
  ['width', '宽度 %', 1, 300, 1],
  ['height', '高度 %', 1, 300, 1],
  ['scale', '缩放', 0.1, 5, 0.05],
  ['opacity', '透明度', 0, 1, 0.01],
  ['blur', '模糊', 0, 40, 1],
  ['rotation', '旋转', -180, 180, 1],
  ['angle', '渐变角度', 0, 360, 1],
  ['maskOpacity', '蒙版强度', 0, 1, 0.01]
] as const
const edges = ['top', 'right', 'bottom', 'left'] as const
const edgeNames = { top: '上', right: '右', bottom: '下', left: '左' }
function edit(action: (list: WorkshopLayer[]) => void): void {
  const next = copyWorkshopDraft(props.project)
  next.layers ??= { pureWhite: {}, dark: {} }
  const list = (next.layers[props.tone][surface.value] ??= [])
  action(list)
  emit('change', next)
}
function add(kind: WorkshopLayer['kind']): void {
  const layer = createWorkshopLayer(crypto.randomUUID(), kind)
  edit((list) => list.push(layer))
  selected.value = layer.id
}
function set(key: string, value: unknown): void {
  edit((list) => Object.assign(list.find((l) => l.id === selected.value)!, { [key]: value }))
}
function move(offset: number): void {
  edit((list) => {
    const index = list.findIndex((l) => l.id === selected.value)
    const target = index + offset
    if (target < 0 || target >= list.length) return
    ;[list[index], list[target]] = [list[target], list[index]]
  })
}
</script>
<template>
  <label
    >页面区域<select v-model="surface">
      <option v-for="s in WORKSHOP_SURFACES" :key="s.id" :value="s.id">{{ s.label }}</option>
    </select></label
  >
  <p>图层从下到上排列。人物放在背景层，内容可独立滚动。</p>
  <button :disabled="layers.length >= WORKSHOP_LAYER_LIMIT" @click="add('image')">＋ 图片</button>
  <button :disabled="layers.length >= WORKSHOP_LAYER_LIMIT" @click="add('gradient')">
    ＋ 渐变
  </button>
  <label v-for="layer in layers" :key="layer.id"
    ><button :class="{ active: selected === layer.id }" @click="selected = layer.id">
      {{ layer.visible ? '◉' : '○' }} {{ layer.name }}
    </button></label
  >
  <template v-if="active">
    <button @click="move(-1)">下移</button><button @click="move(1)">上移</button
    ><button
      @click="
        edit((list) =>
          list.splice(
            list.findIndex((l) => l.id === selected),
            1
          )
        )
      "
    >
      删除图层
    </button>
    <label
      >名称<input
        :value="active.name"
        @change="set('name', ($event.target as HTMLInputElement).value)"
    /></label>
    <label
      >显示<input
        type="checkbox"
        :checked="active.visible"
        @change="set('visible', ($event.target as HTMLInputElement).checked)"
    /></label>
    <label v-if="active.kind === 'image'"
      >图片素材<select
        :value="active.assetId ?? ''"
        @change="set('assetId', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">先到素材库导入图片</option>
        <option
          v-for="asset in project.assets?.filter((a) => a.type === 'image')"
          :key="asset.id"
          :value="asset.id"
        >
          {{ asset.name }}
        </option>
      </select></label
    >
    <label
      >显示条件<select
        :value="active.condition"
        @change="set('condition', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="state in WORKSHOP_LAYER_STATES" :key="state" :value="state">
          {{
            {
              always: '一直显示',
              empty: '空状态',
              loading: '加载中',
              done: '完成',
              listening: '聆听'
            }[state]
          }}
        </option>
      </select></label
    >
    <label
      >滚动方式<select
        :value="active.attachment"
        @change="set('attachment', ($event.target as HTMLSelectElement).value)"
      >
        <option value="fixed">固定背景</option>
        <option value="scroll">随内容滚动</option>
      </select></label
    >
    <label
      >填充方式<select
        :value="active.fit"
        @change="set('fit', ($event.target as HTMLSelectElement).value)"
      >
        <option value="cover">填满</option>
        <option value="contain">完整显示</option>
      </select></label
    >
    <label v-for="[key, label, min, max, step] in numbers" :key="key"
      >{{ label }} · {{ active[key]
      }}<input
        type="range"
        :min="min"
        :max="max"
        :step="step"
        :value="active[key]"
        @input="set(key, Number(($event.target as HTMLInputElement).value))"
    /></label>
    <label
      v-for="[key, label] in [
        ['colorStart', '渐变起点'],
        ['colorEnd', '渐变终点'],
        ['maskColor', '蒙版颜色']
      ] as const"
      :key="key"
      >{{ label
      }}<input
        type="color"
        :value="active[key]"
        @input="set(key, ($event.target as HTMLInputElement).value)"
    /></label>
    <fieldset v-for="kind in ['fade', 'crop'] as const" :key="kind">
      <legend>{{ kind === 'fade' ? '四边淡化' : '非破坏性裁剪' }}</legend>
      <label v-for="edge in edges" :key="edge"
        >{{ edgeNames[edge] }} · {{ active[kind][edge] }}%<input
          type="range"
          min="0"
          max="49"
          :value="active[kind][edge]"
          @input="
            set(kind, {
              ...active[kind],
              [edge]: Number(($event.target as HTMLInputElement).value)
            })
          "
      /></label>
    </fieldset>
  </template>
</template>
