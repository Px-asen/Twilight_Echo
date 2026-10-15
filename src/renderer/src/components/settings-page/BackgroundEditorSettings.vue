<script setup lang="ts">
import { computed } from 'vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { openAppearanceEditor } from '../../composables/appearanceEditorState.ts'
const { settings } = useSettingsStore()
const material = computed(() =>
  settings.value.surfaceMaterial === 'transparent'
    ? '透明'
    : settings.value.surfaceMaterial === 'liquidGlass'
      ? '液态玻璃'
      : settings.value.cardAppearance.enabled
        ? '自定义卡片'
        : '跟随主题'
)
const image = computed(() =>
  settings.value.appBackground.global.kind === 'image'
    ? settings.value.appBackground.global.image
    : ''
)
</script>
<template>
  <div class="setting-item top-align">
    <div class="setting-copy">
      <strong>背景与界面材质</strong><span>在同一处搭配背景、文字和透明材质，预览满意后保存。</span>
    </div>
    <button type="button" class="appearance-entry" @click="openAppearanceEditor()">
      <span
        class="appearance-entry-thumbnail"
        :style="{
          backgroundColor: settings.appBackground.global.dark,
          backgroundImage: image ? `url('${image}')` : 'none'
        }"
        aria-hidden="true"
        ><i v-if="!image" class="pi pi-image"
      /></span>
      <span
        ><strong>{{ image ? '图片背景' : '纯色背景' }}</strong
        ><small>{{ material }}</small></span
      >
      <span class="appearance-entry-action">编辑 <i class="pi pi-arrow-right" /></span>
    </button>
  </div>
</template>
<style scoped>
.appearance-entry {
  display: flex;
  align-items: center;
  gap: 14px;
  width: min(100%, 370px);
  padding: 12px;
  text-align: left;
  color: inherit;
  border: 1px solid var(--te-card-border);
  border-radius: 14px;
  background: var(--te-subtle-bg);
  cursor: pointer;
}
.appearance-entry-thumbnail {
  width: 66px;
  height: 48px;
  flex-shrink: 0;
  border-radius: 8px;
  background-size: cover;
  background-position: center;
  display: grid;
  place-items: center;
  color: var(--te-neutral-300);
}
.appearance-entry strong,
.appearance-entry small {
  display: block;
}
.appearance-entry small {
  margin-top: 4px;
  opacity: 0.65;
}
.appearance-entry-action {
  margin-left: auto;
  font-size: var(--te-type-caption);
  white-space: nowrap;
}
.appearance-entry:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 3px;
}
</style>
