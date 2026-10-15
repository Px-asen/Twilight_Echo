<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppearanceThemePreview from './AppearanceThemePreview.vue'
import { useThemeStore } from '../stores/useThemeStore'
import { syncExtensions, useExtensionRegistry } from '../extensions/registry'
import { getPluginThemeKey } from '../extensions/themeSelection'
import {
  BUILT_IN_THEME_PRESETS,
  TWILIGHT_DEFAULT_THEME_ID,
  resolveThemeProfileTokens,
  type ThemeTone
} from '../../../shared/theme'
import type { WorkshopProjectSummary } from '../../../shared/themeWorkshop'
import type {
  TwilightPluginDescriptor,
  TwilightPluginIndexEntry,
  TwilightPluginIndexStatus
} from '../../../preload/types'
const props = defineProps<{
  selected: string
  disabled?: boolean
  projects?: WorkshopProjectSummary[]
  workshopEnabled?: boolean
}>()
const emit = defineEmits<{ select: [key: string]; customize: []; create: []; delete: [] }>()
const store = useThemeStore()
const { themeContributions } = useExtensionRegistry()
const installed = ref<TwilightPluginDescriptor[]>([])
const catalog = ref<TwilightPluginIndexEntry[]>([])
const status = ref<TwilightPluginIndexStatus | null>(null)
const loading = ref(false)
const error = ref('')
const warning = ref('')
const busyId = ref('')
const query = ref('')
const readTone = (): ThemeTone =>
  document.documentElement.dataset.theme === 'dark' ? 'dark' : 'pureWhite'
const tone = ref<ThemeTone>(readTone())
const previews = computed(
  () =>
    new Map(
      [...BUILT_IN_THEME_PRESETS, ...store.profiles.value].map((theme) => [
        theme.id,
        resolveThemeProfileTokens(theme, tone.value)
      ])
    )
)
const filter = (name: string) =>
  name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())
const presets = computed(() => BUILT_IN_THEME_PRESETS.filter((theme) => filter(theme.name)))
const profiles = computed(() => store.profiles.value.filter((theme) => filter(theme.name)))
const themes = computed(() =>
  themeContributions.value.filter(
    (theme) =>
      installed.value.some((plugin) => plugin.id === theme.pluginId && plugin.enabled) &&
      filter(theme.name)
  )
)
const disabledThemes = computed(() =>
  installed.value.filter(
    (plugin) => plugin.type.includes('theme') && !plugin.enabled && filter(plugin.name)
  )
)
const remoteThemes = computed(() =>
  catalog.value.filter((plugin) => plugin.type.includes('theme') && filter(plugin.name))
)
const deletable = computed(
  () =>
    props.selected.startsWith('profile:') &&
    store.profiles.value.some((profile) => 'profile:' + profile.id === props.selected)
)
const syncLabel = computed(() =>
  loading.value
    ? '同步主题目录…'
    : error.value
      ? '保留可用主题目录'
      : status.value?.loadedFrom === 'remote'
        ? '已同步云端主题目录'
        : status.value?.loadedFrom === 'cache'
          ? '使用缓存主题目录'
          : status.value?.loadedFrom === 'bundled'
            ? '使用内嵌主题目录'
            : '主题目录'
)
let generation = 0
let disposed = false
let unsub: (() => void) | undefined
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let toneObserver: MutationObserver | undefined
async function refresh(force = false): Promise<void> {
  const request = ++generation
  loading.value = true
  error.value = ''
  try {
    const [plugins, entries] = await Promise.allSettled([
      window.api.plugins.list(),
      force ? window.api.plugins.refreshIndex() : window.api.plugins.listIndex()
    ])
    if (disposed || request !== generation) return
    if (plugins.status === 'fulfilled')
      installed.value = plugins.value.filter((plugin) => plugin.type.includes('theme'))
    if (entries.status === 'fulfilled')
      catalog.value = entries.value.filter((plugin) => plugin.type.includes('theme'))
    else
      error.value =
        '云端同步失败，保留已安装主题与可用目录。' +
        (entries.reason instanceof Error ? entries.reason.message : String(entries.reason))
    if (plugins.status === 'rejected')
      error.value =
        '已安装主题读取失败。' +
        (plugins.reason instanceof Error ? plugins.reason.message : String(plugins.reason))
    const indexStatus = await window.api.plugins.getIndexStatus()
    if (disposed || request !== generation) return
    status.value = indexStatus
    if (indexStatus.error) error.value = '云端同步未完成，保留可用的主题目录。' + indexStatus.error
  } catch (cause) {
    if (!disposed && request === generation)
      error.value = '主题目录同步失败。' + (cause instanceof Error ? cause.message : String(cause))
  } finally {
    if (!disposed && request === generation) loading.value = false
  }
}
async function pluginAction(id: string, action: 'install' | 'enable' | 'remove'): Promise<void> {
  if (props.disabled || busyId.value) return
  // Only a catalog/installed skin can reach the shared plugin API from this page.
  if (
    !installed.value.some((plugin) => plugin.id === id) &&
    !catalog.value.some((plugin) => plugin.id === id)
  )
    return
  const plugin = installed.value.find((entry) => entry.id === id)
  if (
    action === 'remove' &&
    (!plugin || plugin.builtIn || !window.confirm('删除主题插件“' + plugin.name + '”？'))
  )
    return
  busyId.value = id
  error.value = ''
  warning.value = ''
  try {
    if (action === 'install') {
      const result = await window.api.plugins.installFromIndex(id)
      warning.value = result?.warning ?? ''
    } else if (action === 'enable') await window.api.plugins.enable(id)
    else await window.api.plugins.uninstall(id)
    await syncExtensions()
    await refresh()
    if (
      store.activeTheme.value.kind === 'plugin' &&
      action === 'remove' &&
      store.activeTheme.value.pluginId === id
    )
      await store.setActive({ kind: 'builtin', id: TWILIGHT_DEFAULT_THEME_ID })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busyId.value = ''
  }
}
function online(): void {
  void refresh(true)
}
onMounted(() => {
  toneObserver = new MutationObserver(() => (tone.value = readTone()))
  toneObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  })
  void refresh()
  unsub = window.api.plugins.onChanged(() => {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => void refresh(), 80)
  })
  window.addEventListener('online', online)
})
onBeforeUnmount(() => {
  disposed = true
  generation++
  unsub?.()
  toneObserver?.disconnect()
  clearTimeout(refreshTimer)
  window.removeEventListener('online', online)
})
defineExpose({ refresh, busy: computed(() => !!busyId.value) })
</script>
<template>
  <section
    id="appearance-theme-selection"
    data-setting-id="plugin-theme"
    class="appearance-theme-selection"
    role="tabpanel"
    aria-labelledby="appearance-selection-tab"
  >
    <div class="theme-selection-toolbar">
      <label class="theme-selection-search">
        <i class="pi pi-search" aria-hidden="true" />
        <input v-model="query" type="search" aria-label="搜索主题" placeholder="搜索主题名称" />
        <button v-if="query" class="theme-search-clear" aria-label="清除搜索" @click="query = ''">
          <i class="pi pi-times" aria-hidden="true" />
        </button>
      </label>
      <div class="theme-selection-actions">
        <button
          class="theme-action-button theme-action-primary"
          :disabled="disabled || !!busyId"
          @click="emit('create')"
        >
          <i class="pi pi-plus" aria-hidden="true" />新建主题
        </button>
        <button
          class="theme-action-button"
          data-setting-id="theme-studio"
          :disabled="disabled || !!busyId"
          @click="emit('customize')"
        >
          <i class="pi pi-sliders-h" aria-hidden="true" />自定义当前主题
        </button>
        <button
          class="theme-action-button theme-action-delete"
          :disabled="disabled || !!busyId || !deletable"
          :title="deletable ? '删除当前个人主题' : '选择个人主题后可删除'"
          @click="emit('delete')"
        >
          <i class="pi pi-trash" aria-hidden="true" />删除主题
        </button>
      </div>
    </div>

    <section v-if="presets.length || !query" class="theme-selection-group" aria-label="内嵌主题">
      <div class="theme-selection-heading">
        <div class="theme-heading-copy">
          <h2>内嵌主题</h2>
          <span class="theme-section-count">{{ presets.length }}</span>
        </div>
        <p>随应用提供，选择即可使用</p>
      </div>
      <div class="theme-selection-grid">
        <button
          v-for="theme in presets"
          :key="theme.id"
          class="theme-selection-card"
          :data-theme-key="'preset:' + theme.id"
          :disabled="disabled || !!busyId"
          :aria-pressed="selected === 'preset:' + theme.id"
          @click="emit('select', 'preset:' + theme.id)"
        >
          <span class="theme-card-artwork">
            <AppearanceThemePreview :tokens="previews.get(theme.id)" />
            <span v-if="selected === 'preset:' + theme.id" class="theme-card-selected"
              ><i class="pi pi-check" aria-hidden="true" />使用中</span
            >
          </span>
          <span class="theme-card-copy"
            ><strong>{{ theme.name }}</strong
            ><small class="theme-card-description" :title="theme.description">{{
              theme.description
            }}</small></span
          >
        </button>
      </div>
    </section>

    <section v-if="profiles.length" class="theme-selection-group" aria-label="我的主题">
      <div class="theme-selection-heading">
        <div class="theme-heading-copy">
          <h2>我的主题</h2>
          <span class="theme-section-count">{{ profiles.length }}</span>
        </div>
        <p>保存的个人配色与外观</p>
      </div>
      <div class="theme-selection-grid">
        <button
          v-for="theme in profiles"
          :key="theme.id"
          class="theme-selection-card"
          :data-theme-key="'profile:' + theme.id"
          :disabled="disabled || !!busyId"
          :aria-pressed="selected === 'profile:' + theme.id"
          @click="emit('select', 'profile:' + theme.id)"
        >
          <span class="theme-card-artwork">
            <AppearanceThemePreview :tokens="previews.get(theme.id)" />
            <span v-if="selected === 'profile:' + theme.id" class="theme-card-selected"
              ><i class="pi pi-check" aria-hidden="true" />使用中</span
            >
          </span>
          <span class="theme-card-copy"
            ><strong>{{ theme.name }}</strong
            ><small class="theme-card-description" :title="theme.description">{{
              theme.description || '自定义主题'
            }}</small></span
          >
        </button>
      </div>
    </section>

    <section class="theme-selection-group" aria-label="主题插件" :aria-busy="loading">
      <div class="theme-selection-heading">
        <div class="theme-heading-copy">
          <h2>主题插件</h2>
          <span class="theme-section-count">{{
            themes.length + disabledThemes.length + remoteThemes.length
          }}</span>
        </div>
        <div class="theme-catalog-status">
          <span role="status"
            ><i :class="loading ? 'pi pi-spin pi-spinner' : 'pi pi-cloud'" aria-hidden="true" />{{
              syncLabel
            }}</span
          ><button
            class="theme-action-button"
            :disabled="disabled || loading || !!busyId"
            @click="refresh(true)"
          >
            <i class="pi pi-refresh" aria-hidden="true" />刷新
          </button>
        </div>
      </div>
      <p v-if="error" role="alert" class="theme-selection-message theme-selection-error">
        <i class="pi pi-exclamation-circle" aria-hidden="true" />{{ error }}
      </p>
      <p v-if="warning" role="status" class="theme-selection-message">
        <i class="pi pi-info-circle" aria-hidden="true" />{{ warning }}
      </p>
      <div v-if="themes.length || disabledThemes.length" class="theme-selection-grid">
        <article
          v-for="theme in themes"
          :key="getPluginThemeKey(theme)"
          class="theme-plugin-card"
          :data-selected="selected === 'plugin:' + getPluginThemeKey(theme)"
        >
          <button
            class="theme-plugin-choice"
            :data-theme-key="'plugin:' + getPluginThemeKey(theme)"
            :disabled="disabled || !!busyId"
            :aria-pressed="selected === 'plugin:' + getPluginThemeKey(theme)"
            @click="emit('select', 'plugin:' + getPluginThemeKey(theme))"
          >
            <span class="theme-card-artwork">
              <AppearanceThemePreview
                :kind="
                  theme.structured?.variants[tone]?.tokens || theme.variables ? 'theme' : 'plugin'
                "
                :tokens="theme.structured?.variants[tone]?.tokens"
                :variables="theme.variables"
              />
              <span
                v-if="selected === 'plugin:' + getPluginThemeKey(theme)"
                class="theme-card-selected"
                ><i class="pi pi-check" aria-hidden="true" />使用中</span
              >
            </span>
            <span class="theme-card-copy"
              ><strong>{{ theme.name }}</strong
              ><small class="theme-card-description" :title="theme.description">{{
                theme.description || '已安装，选择即可使用'
              }}</small></span
            >
          </button>
          <div class="theme-plugin-footer">
            <span class="theme-item-status"
              ><i class="pi pi-check-circle" aria-hidden="true" />已安装</span
            ><button
              v-if="installed.some((plugin) => plugin.id === theme.pluginId && !plugin.builtIn)"
              class="theme-action-button theme-action-delete"
              :disabled="disabled || !!busyId"
              :aria-label="'删除主题插件 ' + theme.name"
              @click="pluginAction(theme.pluginId, 'remove')"
            >
              <i class="pi pi-trash" aria-hidden="true" />删除
            </button>
          </div>
        </article>
        <article
          v-for="plugin in disabledThemes"
          :key="plugin.id"
          class="theme-plugin-card theme-plugin-unavailable"
        >
          <div class="theme-plugin-summary">
            <span class="theme-plugin-icon"><i class="pi pi-palette" aria-hidden="true" /></span
            ><span class="theme-plugin-copy"
              ><strong>{{ plugin.name }}</strong
              ><small>尚未启用</small></span
            >
          </div>
          <p v-if="plugin.error" class="theme-card-description">{{ plugin.error }}</p>
          <div class="theme-plugin-footer">
            <button
              class="theme-action-button theme-action-primary"
              :disabled="disabled || !!busyId"
              @click="pluginAction(plugin.id, 'enable')"
            >
              {{ busyId === plugin.id ? '处理中…' : '启用' }}</button
            ><button
              v-if="!plugin.builtIn"
              class="theme-action-button theme-action-delete"
              :disabled="disabled || !!busyId"
              :aria-label="'删除主题插件 ' + plugin.name"
              @click="pluginAction(plugin.id, 'remove')"
            >
              删除
            </button>
          </div>
        </article>
      </div>
      <h3 v-if="remoteThemes.length" class="theme-subheading">
        云端主题<span>从主题目录获取更多皮肤</span>
      </h3>
      <div class="theme-selection-grid">
        <article
          v-for="plugin in remoteThemes"
          :key="plugin.id"
          class="theme-plugin-card theme-catalog-card"
          :data-theme-plugin-id="plugin.id"
        >
          <div class="theme-plugin-summary">
            <span class="theme-plugin-icon"><i class="pi pi-palette" aria-hidden="true" /></span
            ><span class="theme-plugin-copy"
              ><strong>{{ plugin.name }}</strong
              ><small>{{ plugin.author }} · {{ plugin.version }}</small></span
            >
          </div>
          <p class="theme-card-description" :title="plugin.description">{{ plugin.description }}</p>
          <div class="theme-plugin-footer">
            <span class="theme-item-status">皮肤主题</span
            ><button
              class="theme-action-button"
              :class="{
                'theme-action-primary':
                  plugin.installState === 'not-installed' ||
                  plugin.installState === 'update-available'
              }"
              :disabled="
                disabled ||
                !!busyId ||
                plugin.installState === 'installed' ||
                plugin.installState === 'incompatible'
              "
              @click="pluginAction(plugin.id, 'install')"
            >
              <i
                :class="
                  busyId === plugin.id
                    ? 'pi pi-spin pi-spinner'
                    : plugin.installState === 'installed'
                      ? 'pi pi-check'
                      : 'pi pi-download'
                "
                aria-hidden="true"
              />{{
                busyId === plugin.id
                  ? '处理中…'
                  : plugin.installState === 'installed'
                    ? '已安装'
                    : plugin.installState === 'incompatible'
                      ? '版本不兼容'
                      : plugin.installState === 'update-available'
                        ? '更新'
                        : '安装'
              }}
            </button>
          </div>
        </article>
      </div>
      <p
        v-if="!loading && !themes.length && !disabledThemes.length && !remoteThemes.length"
        class="theme-selection-empty"
      >
        <i class="pi pi-palette" aria-hidden="true" />{{
          query ? '没有匹配的主题插件。' : '暂无主题插件。连接网络后可刷新目录。'
        }}
      </p>
    </section>

    <details v-if="workshopEnabled && projects?.length" class="theme-selection-projects">
      <summary>
        <i class="pi pi-folder" aria-hidden="true" />主题项目<span class="theme-section-count">{{
          projects.length
        }}</span
        ><i class="pi pi-chevron-down" aria-hidden="true" />
      </summary>
      <div class="theme-selection-grid">
        <button
          v-for="project in projects"
          :key="project.id"
          class="theme-project-choice"
          :data-theme-key="'workshop:' + project.id"
          :disabled="disabled || !!busyId"
          @click="emit('select', 'workshop:' + project.id)"
        >
          <span class="theme-plugin-icon"><i class="pi pi-folder" aria-hidden="true" /></span
          ><span class="theme-plugin-copy"
            ><strong>{{ project.name }}</strong
            ><small>继续制作主题</small></span
          ><i class="pi pi-arrow-right" aria-hidden="true" />
        </button>
      </div>
    </details>
  </section>
</template>

<style scoped>
.appearance-theme-selection {
  --theme-card-border: color-mix(in srgb, var(--appearance-edit-text) 12%, transparent);
  --theme-card-hover-border: color-mix(in srgb, var(--appearance-edit-text) 24%, transparent);
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--te-space-section, 32px);
  overflow: auto;
  padding: 4px 4px 28px;
  scrollbar-gutter: stable;
}
.appearance-theme-selection > * {
  width: 100%;
  max-width: var(--te-page-content-max, 1280px);
  margin-inline: auto;
}
.theme-selection-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.theme-selection-search {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 240px;
  max-width: 360px;
  min-width: 0;
  margin-right: auto;
  padding: 0 12px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--te-control-radius-md, 10px);
  color: var(--appearance-edit-muted);
  background: var(--appearance-edit-field);
}
.theme-selection-search:focus-within {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
}
.theme-selection-search input {
  flex: 1;
  width: 100%;
  min-width: 0;
  min-height: max(var(--te-control-height-lg, 40px), calc(var(--te-type-body) * 1.5 + 12px));
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--appearance-edit-text);
  font: inherit;
}
.theme-selection-search input::placeholder {
  color: var(--appearance-edit-muted);
}
.theme-selection-search input::-webkit-search-cancel-button {
  display: none;
}
.theme-selection-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.appearance-theme-selection .theme-action-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  gap: 7px;
  min-height: max(var(--te-control-height-md, 34px), calc(var(--te-type-body) * 1.4 + 8px));
  padding: 6px 12px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--te-control-radius-sm, 8px);
  background: var(--appearance-edit-field);
  color: var(--appearance-edit-text);
  font: inherit;
  font-weight: var(--te-control-font-weight, 500);
  line-height: 1.4;
  cursor: pointer;
}
.appearance-theme-selection .theme-action-primary {
  border-color: transparent;
  background: var(--te-control-accent);
  color: var(--te-control-on-accent);
}
.appearance-theme-selection .theme-action-delete {
  border-color: transparent;
  background: transparent;
  color: var(--appearance-edit-muted);
}
.appearance-theme-selection .theme-action-button:not(:disabled):hover {
  border-color: var(--theme-card-hover-border);
  background: var(--appearance-edit-hover);
}
.appearance-theme-selection .theme-action-primary:not(:disabled):hover {
  border-color: transparent;
  background: var(--te-control-accent);
  filter: brightness(0.94);
}
.appearance-theme-selection .theme-action-delete:not(:disabled):hover {
  border-color: transparent;
  background: var(--te-control-danger-soft);
  color: var(--te-control-danger);
}
.appearance-theme-selection .theme-search-clear {
  display: grid;
  place-items: center;
  min-width: 28px;
  min-height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--te-control-radius-sm, 8px);
  color: inherit;
  background: transparent;
  cursor: pointer;
}
.theme-selection-group {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.theme-selection-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}
.theme-heading-copy {
  display: flex;
  align-items: center;
  gap: 10px;
}
.theme-selection-heading h2 {
  margin: 0;
  font-size: var(--te-type-section-title);
  font-weight: var(--te-type-weight-strong, 600);
  line-height: 1.3;
}
.theme-selection-heading p {
  margin: 0 0 0 auto;
  color: var(--appearance-edit-muted);
  font-size: var(--te-type-caption);
}
.theme-section-count {
  display: inline-grid;
  place-items: center;
  min-width: 22px;
  min-height: 22px;
  padding: 0 6px;
  border-radius: var(--te-control-radius-pill, 999px);
  font-size: var(--te-type-caption);
  font-weight: 500;
  color: var(--appearance-edit-muted);
  background: var(--appearance-edit-active);
}
.theme-selection-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr));
  gap: 16px;
}
.appearance-theme-selection .theme-selection-card,
.theme-plugin-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 10px;
  gap: 0;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--te-control-radius-lg, 12px);
  background: var(--appearance-edit-field);
  color: var(--appearance-edit-text);
  text-align: left;
  box-shadow: none;
}
.appearance-theme-selection .theme-selection-card {
  justify-content: flex-start;
  font: inherit;
  cursor: pointer;
  transition:
    border-color 150ms ease,
    box-shadow 150ms ease;
}
.appearance-theme-selection .theme-selection-card:not(:disabled):hover,
.theme-plugin-card:has(.theme-plugin-choice:not(:disabled):hover) {
  background: var(--appearance-edit-field);
  border-color: var(--theme-card-hover-border);
  box-shadow: var(--te-settings-shadow-soft);
}
.appearance-theme-selection .theme-selection-card[aria-pressed='true'],
.theme-plugin-card[data-selected='true'] {
  border-color: var(--te-control-accent);
  background: var(--appearance-edit-field);
  outline: 1px solid var(--te-control-accent);
  outline-offset: 0;
  color: var(--appearance-edit-text);
}
.theme-card-artwork {
  display: block;
  position: relative;
  width: 100%;
}
.theme-card-selected {
  display: inline-flex;
  position: absolute;
  top: 8px;
  right: 8px;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: var(--te-control-radius-pill, 999px);
  font-size: var(--te-type-caption);
  font-weight: 500;
  line-height: 1.3;
  color: var(--te-control-on-accent);
  background: var(--te-control-accent);
}
.theme-card-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
  padding: 14px 4px 6px;
}
.theme-card-copy strong,
.theme-plugin-copy strong {
  font-size: var(--te-type-headline);
  font-weight: var(--te-type-weight-strong, 600);
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.theme-card-description {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  margin: 0;
  overflow: hidden;
  color: var(--appearance-edit-muted);
  font-size: var(--te-type-caption);
  font-weight: 400;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.theme-catalog-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-left: auto;
}
.theme-catalog-status > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--appearance-edit-muted);
  font-size: var(--te-type-caption);
}
.appearance-theme-selection .theme-plugin-choice {
  display: flex;
  flex: 1;
  width: 100%;
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: var(--te-control-radius-md, 10px);
  background: transparent;
  color: inherit;
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.appearance-theme-selection .theme-plugin-choice:not(:disabled):hover,
.appearance-theme-selection .theme-plugin-choice[aria-pressed='true'] {
  background: transparent;
}
.theme-plugin-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.theme-plugin-icon {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--te-control-radius-md, 10px);
  background: var(--appearance-edit-hover);
  color: var(--appearance-edit-muted);
  font-size: var(--te-type-section-title);
}
.theme-plugin-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}
.theme-plugin-copy small {
  color: var(--appearance-edit-muted);
  font-size: var(--te-type-caption);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.theme-plugin-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 4px 0;
  margin-top: auto;
}
.theme-item-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--appearance-edit-muted);
  font-size: var(--te-type-caption);
}
.theme-plugin-unavailable,
.theme-catalog-card {
  padding: 16px;
  gap: 14px;
}
.theme-plugin-unavailable .theme-plugin-footer,
.theme-catalog-card .theme-plugin-footer {
  padding: 0;
}
.theme-subheading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 12px;
  margin: 8px 0 0;
  font-size: var(--te-type-headline);
  font-weight: 500;
}
.theme-subheading span {
  font-size: var(--te-type-caption);
  font-weight: 400;
  color: var(--appearance-edit-muted);
}
.theme-selection-message {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--te-control-radius-sm, 8px);
  font-size: var(--te-type-caption);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.theme-selection-error {
  color: var(--te-error);
}
.theme-selection-empty {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 20px 0;
  color: var(--appearance-edit-muted);
  font-size: var(--te-type-body);
}
.theme-selection-projects {
  border-top: 1px solid var(--theme-card-border);
  padding-top: 20px;
}
.theme-selection-projects summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
  font-size: var(--te-type-headline);
  font-weight: 500;
  list-style: none;
  cursor: pointer;
}
.theme-selection-projects summary::-webkit-details-marker {
  display: none;
}
.theme-selection-projects summary > .pi:last-child {
  margin-left: auto;
  color: var(--appearance-edit-muted);
  font-size: var(--te-type-caption);
}
.theme-selection-projects[open] summary > .pi:last-child {
  transform: rotate(180deg);
}
.theme-selection-projects .theme-selection-grid {
  margin-top: 16px;
}
.appearance-theme-selection .theme-project-choice {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--te-control-radius-lg, 12px);
  background: var(--appearance-edit-field);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.appearance-theme-selection .theme-project-choice:not(:disabled):hover {
  background: var(--appearance-edit-hover);
}
.theme-project-choice > .pi:last-child {
  margin-left: auto;
  color: var(--appearance-edit-muted);
}
.appearance-theme-selection button:disabled {
  opacity: 0.5;
  cursor: default;
}
.appearance-theme-selection :is(button, summary):focus-visible {
  outline: var(--te-control-focus-width, 2px) solid var(--te-control-focus-color);
  outline-offset: 3px;
}
@media (max-width: 700px) {
  .theme-selection-search {
    flex-basis: 100%;
    max-width: none;
  }
  .theme-selection-actions {
    width: 100%;
  }
  .theme-selection-heading p {
    margin-left: 0;
    flex-basis: 100%;
  }
  .theme-catalog-status {
    margin-left: 0;
    flex-basis: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .appearance-theme-selection .theme-selection-card {
    transition: none;
  }
}
:global(html[data-te-motion='reduced'] .theme-selection-card),
:global(html[data-te-motion='off'] .theme-selection-card) {
  transition: none;
}
@media (forced-colors: active) {
  .appearance-theme-selection {
    --te-control-accent: Highlight;
    --te-control-on-accent: HighlightText;
  }
  .appearance-theme-selection .theme-selection-card[aria-pressed='true'],
  .theme-plugin-card[data-selected='true'] {
    border-color: Highlight;
    outline: 1px solid Highlight;
  }
  .theme-card-selected {
    color: var(--te-control-on-accent);
    background: var(--te-control-accent);
  }
}
</style>
