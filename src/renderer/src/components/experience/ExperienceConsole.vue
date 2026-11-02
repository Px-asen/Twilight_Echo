<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'
const props = defineProps<{ panel: string; tone: string; managePlugins: boolean }>()
const surface = ref<HTMLElement>()
onMounted(() => surface.value?.focus())
const emit = defineEmits<{ close: []; navigate: [name: string] }>()
const Settings = defineAsyncComponent(() => import('../SettingsPage.vue'))
const Equalizer = defineAsyncComponent(() => import('../EqualizerPage.vue'))
const Dsp = defineAsyncComponent(() => import('../DspRackPage.vue'))
const Plugins = defineAsyncComponent(() => import('../PluginPage.vue'))
const Themes = defineAsyncComponent(() => import('../AppearancePage.vue'))
const sections = computed(() =>
  [
    ['settings', '01', '终端设置'],
    ['equalizer', '02', '均衡器'],
    ['dsp', '03', '信号处理'],
    ['plugins', '04', '扩展管理']
  ].filter(([name]) => name !== 'plugins' || props.managePlugins)
)
</script>
<template>
  <section
    ref="surface"
    tabindex="-1"
    class="rhine-console"
    :data-tone="props.tone"
    role="dialog"
    aria-modal="true"
    aria-label="莱茵生命控制终端"
    @keydown.esc.stop="emit('close')"
  >
    <header class="console-heading">
      <div><strong>RHINE LAB</strong><small>CONTROL TERMINAL / 控制终端</small></div>
      <button title="返回专辑架" aria-label="返回专辑架" @click="emit('close')">
        <i class="pi pi-times" />
      </button>
    </header>
    <nav class="console-navigation" aria-label="控制终端分区">
      <button
        v-for="[name, number, label] in sections"
        :key="name"
        :aria-pressed="panel === name"
        @click="emit('navigate', name)"
      >
        <small>{{ number }}</small
        >{{ label }}
      </button>
    </nav>
    <div class="console-content">
      <Settings
        v-if="panel === 'settings'"
        @open-equalizer="emit('navigate', 'equalizer')"
        @open-dsp-rack="emit('navigate', 'dsp')"
        @open-appearance="emit('navigate', 'theme')"
      />
      <Equalizer v-else-if="panel === 'equalizer'" />
      <Dsp v-else-if="panel === 'dsp'" />
      <Plugins v-else-if="panel === 'plugins' && managePlugins" />
      <Themes
        v-else-if="panel === 'theme' || panel === 'workshop'"
        @back="emit('navigate', 'settings')"
      />
    </div>
  </section>
</template>
<style scoped>
.rhine-console {
  --rh-bg: #e8e5e1;
  --rh-fg: #232722;
  --rh-muted: #74786f;
  --rh-line: #2a312a33;
  --rh-accent: #b56834;
  --te-neutral-50: var(--rh-bg);
  --te-neutral-100: var(--rh-bg);
  --te-neutral-200: var(--rh-line);
  --te-neutral-500: var(--rh-muted);
  --te-neutral-700: var(--rh-fg);
  --te-neutral-900: var(--rh-fg);
  --te-primary-500: var(--rh-accent);
  --te-primary-400: var(--rh-accent);
  --te-primary-rgb: 181, 104, 52;
  --te-card-bg: var(--rh-bg);
  --te-card-border: var(--rh-line);
  --te-subtle-bg: var(--rh-bg);
  --te-settings-bg: var(--rh-bg);
  --te-settings-text-primary: var(--rh-fg);
  --te-settings-text-muted: var(--rh-muted);
  --te-settings-control-surface: var(--rh-bg);
  --te-settings-control-border: var(--rh-line);
  position: absolute;
  inset: 30px 0 0;
  background: var(--rh-bg);
  color: var(--rh-fg);
  display: flex;
  flex-direction: column;
  padding: 28px 36px 0;
  overflow: hidden;
}
.rhine-console[data-tone='night'] {
  --rh-bg: #0a111c;
  --rh-fg: #e8edf2;
  --rh-muted: #9aa8b6;
  --rh-line: #aab6c433;
  --rh-accent: #ddb67d;
  --te-primary-rgb: 221, 182, 125;
}
.console-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 24px;
}
.console-heading strong {
  display: block;
  font-size: 28px;
  font-weight: 800;
}
.console-heading small {
  font-size: 10px;
}
.console-heading button {
  width: 40px;
  height: 40px;
  border: 1px solid var(--rh-line);
  background: none;
  color: inherit;
  cursor: pointer;
}
.console-navigation {
  display: flex;
  gap: 32px;
  border-block: 1px solid var(--rh-line);
  flex-shrink: 0;
}
.console-navigation button {
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--rh-muted);
  padding: 16px 0;
  cursor: pointer;
  font-size: 13px;
}
.console-navigation small {
  margin-right: 12px;
  font-size: 10px;
}
.console-navigation button[aria-pressed='true'] {
  color: var(--rh-fg);
  border-bottom-color: var(--rh-accent);
}
.console-content {
  min-height: 0;
  flex: 1;
  overflow: auto;
  position: relative;
}
.console-content :deep(.settings-preview-page),
.console-content :deep(.plugin-page),
.console-content :deep(.dsp-rack-page),
.console-content :deep(.eq-page) {
  position: relative !important;
  inset: auto !important;
  padding: 24px 0 !important;
  height: 100% !important;
  background: transparent !important;
  color: inherit;
}
.console-content :deep(.settings-preview-layout) {
  max-width: none;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: 36px;
  padding: 0;
}
.console-content :deep(.settings-preview-nav) {
  top: 0;
  background: transparent;
  border: 0;
  box-shadow: none;
  border-right: 1px solid var(--rh-line);
  border-radius: 0;
}
.console-content :deep(.settings-page-title) {
  font-size: 24px;
}
.console-content :deep(.settings-page-description) {
  color: var(--rh-muted);
}
.console-content :deep(.setting-card),
.console-content :deep(.settings-group),
.console-content :deep(.settings-disclosure),
.console-content :deep(.plugin-card) {
  background: transparent !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  border: 0 !important;
  border-bottom: 1px solid var(--rh-line) !important;
}
.console-content :deep(.plugin-window) {
  max-width: none;
  height: 100%;
  background: transparent;
  box-shadow: none;
  border: 0;
}
.console-content :deep(.plugin-grid) {
  grid-template-columns: 1fr;
}
.console-content :deep(.settings-preview-stack) {
  max-width: 1100px;
}
.console-content :deep(button),
.console-content :deep(input),
.console-content :deep(select) {
  border-radius: 2px;
}
@media (max-width: 760px) {
  .rhine-console {
    padding: 20px 16px 0;
  }
  .console-navigation {
    gap: 20px;
    overflow: auto;
  }
  .console-navigation button {
    white-space: nowrap;
  }
  .console-content :deep(.settings-preview-layout) {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .console-content :deep(.settings-preview-nav) {
    border-right: 0;
  }
}
</style>
