<script setup lang="ts">
import {
  copyWorkshopDraft,
  type WorkshopProject,
  type WorkshopAsset
} from '../../../../shared/themeWorkshop'
const props = defineProps<{ project: WorkshopProject; busy: boolean }>()
const emit = defineEmits<{ change: [project: WorkshopProject]; import: [type: 'image' | 'font'] }>()
function update(asset: WorkshopAsset, key: 'license' | 'source', value: string): void {
  const next = copyWorkshopDraft(props.project)
  next.assets!.find((a) => a.id === asset.id)![key] = value
  emit('change', next)
}
function font(family: string, value: string): void {
  const next = copyWorkshopDraft(props.project)
  next.fonts = { ...next.fonts, [family]: value }
  emit('change', next)
}
</script>
<template>
  <button :disabled="busy" @click="emit('import', 'image')">导入图片</button
  ><button :disabled="busy" @click="emit('import', 'font')">导入 WOFF2 字体</button>
  <p>保留原图，裁剪在图层面板调整。素材随项目和成品一起导出。</p>
  <label v-for="family in ['sans', 'display', 'rounded'] as const" :key="family"
    >{{ { sans: '正文字体', display: '标题字体', rounded: '圆体' }[family]
    }}<select
      :value="project.fonts?.[family] ?? ''"
      @change="font(family, ($event.target as HTMLSelectElement).value)"
    >
      <option value="">继承主题</option>
      <option
        v-for="asset in project.assets?.filter((a) => a.type === 'font')"
        :key="asset.id"
        :value="asset.id"
      >
        {{ asset.name }}
      </option>
    </select></label
  >
  <article v-for="asset in project.assets" :key="asset.id">
    <h3>{{ asset.name }}</h3>
    <img
      v-if="asset.type === 'image'"
      :src="asset.dataUrl"
      :alt="asset.name"
      style="width: 100%; max-height: 160px; object-fit: contain"
    />
    <label
      >素材来源<input
        :value="asset.source"
        @change="update(asset, 'source', ($event.target as HTMLInputElement).value)"
    /></label>
    <label
      >许可／署名<input
        :value="asset.license"
        @change="update(asset, 'license', ($event.target as HTMLInputElement).value)"
    /></label>
  </article>
</template>
