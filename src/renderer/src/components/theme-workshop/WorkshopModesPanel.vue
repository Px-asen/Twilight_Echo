<script setup lang="ts">
import {
  THEME_MODE_DEFINITIONS,
  type ThemeShellLayout,
  resolveThemeModes,
  type ThemeModes
} from '../../../../shared/theme'
import { copyWorkshopDraft, type WorkshopProject } from '../../../../shared/themeWorkshop'
const layouts: { id: string; name: string; layout: ThemeShellLayout }[] = [
  {
    id: 'left',
    name: '左侧导航',
    layout: {
      navigation: 'persistent',
      desktop: {
        columns: ['standard', 'fill'],
        rows: ['content', 'fill', 'content'],
        areas: [
          ['titleBar', 'titleBar'],
          ['navigation', 'content'],
          ['playerBar', 'playerBar']
        ]
      }
    }
  },
  {
    id: 'right',
    name: '右侧导航',
    layout: {
      navigation: 'persistent',
      desktop: {
        columns: ['fill', 'standard'],
        rows: ['content', 'fill', 'content'],
        areas: [
          ['titleBar', 'titleBar'],
          ['content', 'navigation'],
          ['playerBar', 'playerBar']
        ]
      }
    }
  },
  {
    id: 'focus',
    name: '专注内容',
    layout: {
      navigation: 'hidden',
      desktop: {
        columns: ['fill'],
        rows: ['content', 'fill', 'content'],
        areas: [['titleBar'], ['content'], ['playerBar']]
      }
    }
  }
]
const props = defineProps<{ project: WorkshopProject }>()
const emit = defineEmits<{ change: [project: WorkshopProject] }>()
function read(id: string): string {
  const base = props.project.base.structured
  const modes = resolveThemeModes(
    props.project.modes ?? (base && base.schemaVersion !== 1 ? base.modes : undefined)
  )
  const [domain, key] = id.split('.')
  return String((modes[domain as keyof ThemeModes] as Record<string, unknown>)?.[key] ?? '')
}
function set(id: string, value: string): void {
  const next = copyWorkshopDraft(props.project)
  const base = next.base.structured
  next.modes ??= JSON.parse(
    JSON.stringify(base && base.schemaVersion !== 1 ? (base.modes ?? {}) : {})
  )
  const [domain, key] = id.split('.')
  Object.assign(next.modes!, {
    [domain]: { ...next.modes![domain as keyof ThemeModes], [key]: value }
  })
  emit('change', next)
}
function layout(id: string): void {
  const next = copyWorkshopDraft(props.project)
  const preset = layouts.find((p) => p.id === id)
  next.layout = preset?.layout ?? (id === 'default' ? null : undefined)
  emit('change', next)
}
</script>
<template>
  <label
    >窗口布局<select @change="layout(($event.target as HTMLSelectElement).value)">
      <option value="">继承来源</option>
      <option value="default">默认布局</option>
      <option v-for="preset in layouts" :key="preset.id" :value="preset.id">
        {{ preset.name }}
      </option>
    </select></label
  >
  <p>列表密度使用宿主原生模式，行高与虚拟列表测量保持一致。</p>
  <label v-for="mode in THEME_MODE_DEFINITIONS" :key="mode.id"
    >{{ mode.label
    }}<select
      :value="read(mode.id)"
      @change="set(mode.id, ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="option in mode.options" :key="option" :value="option">{{ option }}</option>
    </select></label
  >
  <button @click="emit('change', { ...project, modes: undefined, layout: undefined })">
    恢复来源布局与模式
  </button>
</template>
