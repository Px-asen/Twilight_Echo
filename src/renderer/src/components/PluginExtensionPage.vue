<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import PuzzleIcon from './icons/PuzzleIcon.vue'
import type { UiContribution } from '../extensions/registry'

const props = defineProps<{
  page: UiContribution
}>()

const loading = ref(false)
const error = ref('')
const textResult = ref('')

const subtitle = computed(() => props.page.description || props.page.pluginId)
const shouldAutoLoad = computed(() => props.page.autoLoad === true)

async function loadContent(): Promise<void> {
  if (!props.page.command || loading.value) return
  loading.value = true
  error.value = ''
  textResult.value = ''
  try {
    const result = await window.api.extensions.executeCommand(props.page.command, [
      {
        source: props.page.kind,
        pageId: props.page.id
      }
    ])
    textResult.value = formatCommandResult(result)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function formatCommandResult(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  try {
    return typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result)
  } catch {
    return String(result)
  }
}

function runPageCommand(): Promise<void> {
  return loadContent()
}

onMounted(() => {
  if (shouldAutoLoad.value) {
    void loadContent()
  }
})

// Reload when page changes
watch(
  () => props.page.id,
  () => {
    if (shouldAutoLoad.value) {
      void loadContent()
    }
  }
)
</script>

<template>
  <section class="plugin-extension-page">
    <header class="plugin-extension-header">
      <div class="plugin-extension-icon">
        <i v-if="page.icon" :class="page.icon"></i>
        <PuzzleIcon v-else />
      </div>
      <div class="plugin-extension-heading">
        <span>{{ page.pluginId }}</span>
        <h1>{{ page.title }}</h1>
        <p>{{ subtitle }}</p>
      </div>
      <button
        v-if="page.command"
        class="plugin-extension-action"
        type="button"
        :disabled="loading"
        @click="runPageCommand"
      >
        <i :class="loading ? 'pi pi-spin pi-spinner' : 'pi pi-refresh'"></i>
        {{ loading ? '加载中' : '刷新' }}
      </button>
    </header>

    <div class="plugin-extension-body">
      <!-- Loading state -->
      <div v-if="loading" class="plugin-extension-loading">
        <i
          class="pi pi-spin pi-spinner"
          style="font-size: calc(var(--te-font-size-body, 14px) * 32 / 14); color: #999"
        ></i>
        <p>正在加载...</p>
      </div>

      <!-- Error state -->
      <div v-else-if="error" class="plugin-extension-error-state">
        <i
          class="pi pi-exclamation-triangle"
          style="font-size: calc(var(--te-font-size-body, 14px) * 32 / 14); color: #e74c3c"
        ></i>
        <p class="error-text">{{ error }}</p>
        <button class="plugin-extension-retry-btn" @click="runPageCommand">重试</button>
      </div>

      <!-- Text/data result -->
      <div v-else-if="textResult" class="plugin-extension-text-result">
        <pre>{{ textResult }}</pre>
      </div>

      <!-- Empty state (command mode without autoLoad) -->
      <div v-else class="plugin-extension-card">
        <span class="plugin-extension-kicker">受控插件页面</span>
        <h2>{{ page.title }}</h2>
        <p>{{ page.description || '该页面由插件注册，点击刷新按钮执行命令。' }}</p>
        <button v-if="page.command" class="plugin-extension-run-btn" @click="runPageCommand">
          <i class="pi pi-play"></i>
          执行
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.plugin-extension-page {
  min-height: 100vh;
  padding: calc(32px + 46px) clamp(24px, 5vw, 76px) 120px;
  background: var(--te-subtle-bg);
}

.plugin-extension-header {
  display: grid;
  position: relative;
  grid-template-columns: 54px minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  max-width: 960px;
  margin: 0 auto 20px;
}

.plugin-extension-icon {
  width: 54px;
  height: 54px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: #111827;
  color: #fff;
  font-size: calc(var(--te-font-size-body, 14px) * 22 / 14);
}

.plugin-extension-heading {
  min-width: 0;
}

.plugin-extension-heading span {
  display: block;
  color: var(--te-neutral-500);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 800;
}

.plugin-extension-heading h1 {
  margin: 3px 0;
  color: var(--te-neutral-900);
  font-size: calc(var(--te-font-size-body, 14px) * 28 / 14);
  line-height: 1.15;
}

.plugin-extension-heading p {
  margin: 0;
  color: var(--te-neutral-600);
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 700;
}

.plugin-extension-action {
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 13px;
  border: 0;
  border-radius: 7px;
  background: #2563eb;
  color: #fff;
  cursor: pointer;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 800;
}

.plugin-extension-action:disabled {
  cursor: not-allowed;
  opacity: 0.56;
}

.plugin-extension-body {
  max-width: 960px;
  margin: 0 auto;
}

.plugin-extension-loading,
.plugin-extension-error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 60px 20px;
  text-align: center;
}

.plugin-extension-loading p,
.plugin-extension-error-state p {
  margin: 0;
  color: #666;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
}

.error-text {
  color: #e74c3c !important;
}

.plugin-extension-retry-btn {
  padding: 8px 20px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 8px;
  background: var(--te-card-bg);
  color: #333;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  cursor: pointer;
}

.plugin-extension-retry-btn:hover {
  background: #f5f5f5;
}

.plugin-extension-text-result {
  padding: 18px;
  border: 1px solid rgba(17, 24, 39, 0.08);
  border-radius: 8px;
  background: var(--te-card-bg);
  overflow-x: auto;
}

.plugin-extension-text-result pre {
  margin: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  line-height: 1.6;
  color: #333;
  white-space: pre-wrap;
  word-break: break-all;
}

.plugin-extension-card {
  display: grid;
  gap: 8px;
  padding: 18px;
  border: 1px solid rgba(17, 24, 39, 0.08);
  border-radius: 8px;
  background: var(--te-card-bg);
}

.plugin-extension-kicker {
  color: var(--te-neutral-500);
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  font-weight: 900;
}

.plugin-extension-card h2 {
  margin: 0;
  color: var(--te-neutral-900);
  font-size: calc(var(--te-font-size-body, 14px) * 17 / 14);
}

.plugin-extension-card p {
  margin: 0;
  color: var(--te-neutral-600);
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 700;
  line-height: 1.5;
}

.plugin-extension-run-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: 0;
  border-radius: 7px;
  background: #2563eb;
  color: #fff;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 800;
  cursor: pointer;
  width: fit-content;
}
</style>
