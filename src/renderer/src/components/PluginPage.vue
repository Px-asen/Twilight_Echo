<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useSettingsStore } from '../stores/useSettingsStore'
import {
  pluginIndexLoadedFromLabel,
  pluginIndexSourceLabel,
  presentPluginTrust
} from '@renderer/utils/pluginTrustPresentation'
import {
  createPluginTrustRefreshController,
  type PluginTrustRefreshController
} from '@renderer/utils/pluginTrustRefresh'
import { createPluginMarketIndex, searchPluginMarket } from '@renderer/utils/pluginMarketSearch'
import { usePageDock } from '../app/pageDock'
import ThemeIcon from './ThemeIcon.vue'
import AppBackgroundLayer from './AppBackgroundLayer.vue'
import type { ThemeIconSlot } from '../../../shared/theme.ts'

type TwilightPluginDescriptor = Awaited<ReturnType<typeof window.api.plugins.list>>[number]
type TwilightPluginIndexEntry = Awaited<ReturnType<typeof window.api.plugins.listIndex>>[number]
type TwilightPluginIndexStatus = Awaited<ReturnType<typeof window.api.plugins.getIndexStatus>>

const props = defineProps<{ initialTab?: 'installed' | 'discover' }>()
const activeTab = ref<'installed' | 'discover' | 'updates'>(props.initialTab ?? 'installed')
const emit = defineEmits<{ openThemeWorkshop: [] }>()
const { settings, updateSettings } = useSettingsStore()
// 开发者模式是持久化设置：这里的开关与「设置 → 常规 → 开发者选项」是同一个值。
const devMode = computed(() => settings.value.developerMode === true)
const searchText = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const marketFiltersRef = ref<HTMLDetailsElement | null>(null)
const selectedType = ref('')
const selectedAuthor = ref('')
const selectedTag = ref('')
const visibleCount = ref(40)
const marketTypes = [
  { value: '', label: '全部类型' },
  { value: 'provider', label: '音源' },
  { value: 'tool', label: '工具' },
  { value: 'ui', label: '界面' },
  { value: 'theme', label: '主题' },
  { value: 'dsp', label: '音效' }
]

const installedPlugins = ref<TwilightPluginDescriptor[]>([])
const indexEntries = ref<TwilightPluginIndexEntry[]>([])
const indexStatus = ref<TwilightPluginIndexStatus | null>(null)
const loading = ref(false)
const errorMsg = ref('')
const warningMsg = ref('')
const busyIds = ref(new Set<string>())
const localInstallKind = ref<'package' | 'directory' | null>(null)
const changingDevMode = ref(false)
const updatingAll = ref(false)
const trustEvaluationTimeMs = ref(Date.now())
let trustRefreshController: PluginTrustRefreshController | null = null
let indexRequestGeneration = 0

function switchTab(tabId: 'installed' | 'discover' | 'updates') {
  activeTab.value = tabId
  if (marketFiltersRef.value) marketFiltersRef.value.open = false
}
usePageDock('plugins', () => [
  {
    id: 'refresh-plugins',
    label: loading.value ? '刷新中…' : '刷新插件',
    icon: 'navigation.refresh',
    disabled: loading.value || !!localInstallKind.value || updatingAll.value,
    run: () => (activeTab.value === 'discover' ? refreshMarket() : loadAll())
  }
])

/* ---------- helpers ---------- */

function getIconInfo(id: string, type: string[]): { cls: string; slot: ThemeIconSlot } {
  if (id.includes('ncm')) return { cls: 'ncm', slot: 'navigation.cloud' }
  if (type.includes('provider')) return { cls: 'provider', slot: 'navigation.streaming' }
  if (type.includes('theme')) return { cls: 'theme', slot: 'navigation.appearance' }
  if (type.includes('dsp')) return { cls: 'dsp', slot: 'library.empty' }
  return { cls: 'tool', slot: 'navigation.plugin' }
}

function getTags(type: string[]): Array<{ label: string; cls: string; style?: string }> {
  const tags: Array<{ label: string; cls: string; style?: string }> = []
  for (const t of type) {
    if (t === 'provider') tags.push({ label: '音源', cls: 'provider' })
    else if (t === 'ui') tags.push({ label: '界面', cls: 'ui' })
    else if (t === 'dsp') tags.push({ label: '音效', cls: 'dsp' })
    else if (t === 'tool') tags.push({ label: '工具', cls: 'tool' })
    else if (t === 'theme')
      tags.push({
        label: '主题',
        cls: 'theme'
      })
  }
  return tags
}

/* ---------- computed ---------- */

const filteredInstalled = computed(() => {
  const list = installedPlugins.value
  if (!searchText.value.trim()) return list
  const q = searchText.value.trim().toLocaleLowerCase()
  return list.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.author.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q)
  )
})

const marketIndex = computed(() =>
  createPluginMarketIndex(
    indexEntries.value.filter((entry) => entry.installState !== 'built-in-blocked')
  )
)
const filteredIndex = computed(() =>
  searchPluginMarket(
    marketIndex.value,
    searchText.value,
    selectedType.value,
    selectedAuthor.value,
    selectedTag.value
  )
)
const visibleIndex = computed(() => filteredIndex.value.slice(0, visibleCount.value))
const marketAuthors = computed(() => marketIndex.value.authors)
const marketClassifications = marketTypes.map((item) => ({
  key: 'type:' + item.value,
  label: item.value ? item.label : '全部',
  type: item.value
}))
const marketFilterCount = computed(
  () => Number(Boolean(selectedAuthor.value)) + Number(Boolean(selectedTag.value))
)
function selectClassification(item: { type: string }): void {
  selectedType.value = item.type
}

function closeMarketFilters(event: KeyboardEvent): void {
  const details = event.currentTarget as HTMLDetailsElement
  details.open = false
  details.querySelector('summary')?.focus()
}

function closeMarketFiltersOnPointer(event: PointerEvent): void {
  const details = marketFiltersRef.value
  if (details?.open && event.target instanceof Node && !details.contains(event.target)) {
    details.open = false
  }
}

function clearSearch(): void {
  searchText.value = ''
  searchInput.value?.focus()
}

function clearMarketFilters(): void {
  selectedTag.value = ''
  selectedAuthor.value = ''
  const details = marketFiltersRef.value
  if (details?.contains(document.activeElement)) details.querySelector('summary')?.focus()
}

function resetMarketSearch(): void {
  selectedType.value = ''
  clearMarketFilters()
  clearSearch()
}

watch([searchText, selectedType, selectedAuthor, selectedTag, indexEntries], () => {
  visibleCount.value = 40
})

const updateEntries = computed(() => {
  return indexEntries.value.filter((e) => e.installState === 'update-available')
})
const filteredUpdates = computed(() => {
  const query = searchText.value.trim().toLocaleLowerCase()
  return updateEntries.value.filter(
    (entry) =>
      !query ||
      [entry.name, entry.author, entry.id, entry.description].some((text) =>
        text.toLocaleLowerCase().includes(query)
      )
  )
})

const marketRepoUrl = 'https://github.com/Px-asen/Twilight-Echo-plugins'

const indexSourceLabel = computed(() => {
  return pluginIndexSourceLabel(indexStatus.value)
})

const indexLoadedFromLabel = computed(() => {
  return pluginIndexLoadedFromLabel(indexStatus.value?.loadedFrom)
})

function pluginTrust(entry: TwilightPluginIndexEntry) {
  return presentPluginTrust(entry, indexStatus.value, trustEvaluationTimeMs.value)
}

/* ---------- API ---------- */

async function refreshInstalled() {
  try {
    installedPlugins.value = await window.api.plugins.list()
  } catch (e) {
    errorMsg.value = `加载已安装插件失败：${e instanceof Error ? e.message : String(e)}`
  }
}

async function refreshIndex(force = false) {
  const generation = ++indexRequestGeneration
  trustEvaluationTimeMs.value = Date.now()
  try {
    const entries = force
      ? await window.api.plugins.refreshIndex()
      : await window.api.plugins.listIndex()
    const status = await window.api.plugins.getIndexStatus()
    if (generation !== indexRequestGeneration) return
    indexEntries.value = entries
    indexStatus.value = status
  } catch (e) {
    if (generation !== indexRequestGeneration) return
    errorMsg.value = `加载插件市场失败：${e instanceof Error ? e.message : String(e)}`
    indexStatus.value = await window.api.plugins.getIndexStatus().catch(() => null)
  } finally {
    if (generation === indexRequestGeneration) {
      trustEvaluationTimeMs.value = Date.now()
      trustRefreshController?.schedule()
    }
  }
}

async function loadAll() {
  loading.value = true
  errorMsg.value = ''
  await Promise.all([refreshInstalled(), refreshIndex()])
  loading.value = false
}

function isPluginRequestedEnabled(plugin: TwilightPluginDescriptor): boolean {
  return plugin.requestedEnabled ?? plugin.enabled
}

async function togglePlugin(plugin: TwilightPluginDescriptor) {
  if (busyIds.value.has(plugin.id)) return
  const requestedEnabled = isPluginRequestedEnabled(plugin)
  busyIds.value.add(plugin.id)
  try {
    if (requestedEnabled) {
      await window.api.plugins.disable(plugin.id)
    } else {
      await window.api.plugins.enable(plugin.id)
    }
    await refreshInstalled()
  } catch (e) {
    errorMsg.value = `${requestedEnabled ? '停用' : '启用'}失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busyIds.value.delete(plugin.id)
  }
}

async function uninstallPlugin(plugin: TwilightPluginDescriptor) {
  if (busyIds.value.has(plugin.id)) return
  busyIds.value.add(plugin.id)
  try {
    await window.api.plugins.uninstall(plugin.id)
    await loadAll()
  } catch (e) {
    errorMsg.value = `卸载失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busyIds.value.delete(plugin.id)
  }
}

async function openLog(plugin: TwilightPluginDescriptor) {
  try {
    await window.api.plugins.openLog(plugin.id)
  } catch (e) {
    errorMsg.value = `打开日志失败：${e instanceof Error ? e.message : String(e)}`
  }
}

function formatPluginInstallError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|aborted/i.test(message)) {
    return (
      `安装失败：无法下载插件包（${message}）。` +
      '离线发现快照只能浏览元数据；.tep 仍需从网络获取。' +
      '请切换到「已安装」→「安装本地插件」，或配置可访问 GitHub raw 的代理/镜像后重试。'
    )
  }
  return `安装失败：${message}`
}

async function installFromLocal(kind: 'package' | 'directory' = 'package') {
  if (localInstallKind.value) return
  localInstallKind.value = kind
  errorMsg.value = ''
  warningMsg.value = ''
  try {
    const result = await window.api.plugins.chooseAndInstall(kind)
    if (result) {
      await loadAll()
      if (result.warning) warningMsg.value = result.warning
    }
  } catch (e) {
    errorMsg.value = formatPluginInstallError(e)
  } finally {
    localInstallKind.value = null
  }
}

async function toggleDevMode() {
  if (changingDevMode.value) return
  changingDevMode.value = true
  errorMsg.value = ''
  try {
    await updateSettings({ developerMode: !devMode.value })
  } catch (e) {
    errorMsg.value = `切换开发者模式失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    changingDevMode.value = false
  }
}

async function installFromIndex(entry: TwilightPluginIndexEntry) {
  if (busyIds.value.has(entry.id)) return
  busyIds.value.add(entry.id)
  errorMsg.value = ''
  warningMsg.value = ''
  try {
    const result = await window.api.plugins.installFromIndex(entry.id)
    await loadAll()
    if (result?.warning) warningMsg.value = result.warning
  } catch (e) {
    errorMsg.value = formatPluginInstallError(e)
  } finally {
    busyIds.value.delete(entry.id)
  }
}

async function updateAll() {
  if (updatingAll.value) return
  updatingAll.value = true
  try {
    for (const entry of updateEntries.value) {
      await installFromIndex(entry)
    }
  } finally {
    updatingAll.value = false
  }
}

async function refreshMarket() {
  loading.value = true
  errorMsg.value = ''
  try {
    await refreshIndex(true)
  } catch (e) {
    errorMsg.value = `刷新市场失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    loading.value = false
  }
}

function formatIndexTime(value: string | null | undefined): string {
  if (!value) return '未记录'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function openExternal(url: string) {
  if (/^https:\/\//i.test(url)) window.open(url, '_blank')
}

let unsubChanged: (() => void) | null = null

function refreshTrustOnResume(): void {
  trustEvaluationTimeMs.value = Date.now()
  void trustRefreshController?.refreshNow().catch(() => undefined)
}

function handleTrustVisibilityChange(): void {
  if (document.visibilityState === 'visible') refreshTrustOnResume()
}

onMounted(() => {
  trustRefreshController = createPluginTrustRefreshController({
    getSnapshot: () => ({ entries: indexEntries.value, status: indexStatus.value }),
    refresh: () => refreshIndex(false)
  })
  window.addEventListener('focus', refreshTrustOnResume)
  document.addEventListener('visibilitychange', handleTrustVisibilityChange)
  document.addEventListener('pointerdown', closeMarketFiltersOnPointer)
  void loadAll()
  unsubChanged = window.api.plugins.onChanged(() => {
    void refreshInstalled()
    refreshTrustOnResume()
  })
})

onUnmounted(() => {
  unsubChanged?.()
  window.removeEventListener('focus', refreshTrustOnResume)
  document.removeEventListener('visibilitychange', handleTrustVisibilityChange)
  document.removeEventListener('pointerdown', closeMarketFiltersOnPointer)
  trustRefreshController?.stop()
  trustRefreshController = null
})
</script>

<template>
  <div class="plugin-page" role="region" aria-labelledby="plugin-page-title">
    <AppBackgroundLayer page="settings" embedded reading />
    <div class="plugin-window">
      <header class="plugin-page-header">
        <div class="plugin-heading">
          <h1 id="plugin-page-title">插件市场</h1>
        </div>
        <div class="plugin-page-controls">
          <nav class="nav-menu" aria-label="插件管理视图">
            <button
              type="button"
              class="nav-item"
              :aria-pressed="activeTab === 'installed'"
              :class="{ active: activeTab === 'installed' }"
              @click="switchTab('installed')"
            >
              <span>已安装</span>
            </button>
            <button
              type="button"
              class="nav-item"
              :aria-pressed="activeTab === 'discover'"
              :class="{ active: activeTab === 'discover' }"
              @click="switchTab('discover')"
            >
              <span>发现</span>
            </button>
            <button
              type="button"
              class="nav-item"
              :aria-pressed="activeTab === 'updates'"
              :class="{ active: activeTab === 'updates' }"
              @click="switchTab('updates')"
            >
              <span
                >更新
                <span v-if="updateEntries.length > 0" class="update-count">{{
                  updateEntries.length
                }}</span></span
              >
            </button>
          </nav>

          <div v-if="activeTab === 'installed'" class="dev-mode-toggle">
            <span>{{ changingDevMode ? '正在切换…' : '开发者模式' }}</span>
            <button
              type="button"
              class="switch"
              role="switch"
              aria-label="开发者模式"
              :aria-checked="devMode"
              :aria-busy="changingDevMode"
              :disabled="changingDevMode || !!localInstallKind"
              :class="{ on: devMode }"
              @click="toggleDevMode"
            ></button>
          </div>
        </div>
      </header>

      <!-- Main Content -->
      <main class="plugin-main">
        <!-- Topbar -->
        <header class="topbar">
          <div class="search-box" role="search" aria-label="插件搜索">
            <i class="pi pi-search" aria-hidden="true"></i>
            <input
              ref="searchInput"
              type="search"
              aria-label="搜索插件"
              v-model="searchText"
              :placeholder="
                activeTab === 'installed'
                  ? '搜索已安装插件'
                  : activeTab === 'discover'
                    ? '搜索插件'
                    : '搜索更新'
              "
            />
            <button
              v-if="searchText"
              type="button"
              class="search-clear"
              aria-label="清除插件搜索"
              @click="clearSearch"
            >
              <i class="pi pi-times" aria-hidden="true"></i>
            </button>
          </div>
          <details
            v-if="activeTab === 'discover'"
            ref="marketFiltersRef"
            class="market-filters"
            @keydown.esc.stop.prevent="closeMarketFilters"
          >
            <summary>
              筛选<span v-if="marketFilterCount">（{{ marketFilterCount }}）</span>
            </summary>
            <div class="market-filter-content" data-te-material="popover">
              <label>
                <span>标签</span>
                <select v-model="selectedTag" aria-label="插件标签">
                  <option value="">全部标签</option>
                  <option v-for="tag in marketIndex.tags" :key="tag" :value="tag">{{ tag }}</option>
                </select>
              </label>
              <label>
                <span>开发者</span>
                <select v-model="selectedAuthor" aria-label="插件开发者">
                  <option value="">全部开发者</option>
                  <option v-for="author in marketAuthors" :key="author" :value="author">
                    {{ author }}
                  </option>
                </select>
              </label>
              <button
                v-if="marketFilterCount"
                type="button"
                class="market-filter-reset"
                @click="clearMarketFilters"
              >
                清除筛选
              </button>
            </div>
          </details>
          <div class="top-actions">
            <button
              v-if="activeTab === 'installed'"
              type="button"
              class="btn btn-outline"
              :disabled="loading || !!localInstallKind || updatingAll"
              :aria-busy="localInstallKind === 'package'"
              @click="installFromLocal('package')"
            >
              <i class="pi pi-folder-open" aria-hidden="true"></i>
              {{ localInstallKind === 'package' ? '安装中…' : '安装本地插件' }}
            </button>
            <button
              v-if="activeTab === 'installed' && devMode"
              type="button"
              class="btn btn-outline"
              title="选择包含 plugin.json 的未打包插件目录（开发者模式）"
              :disabled="loading || !!localInstallKind || updatingAll"
              :aria-busy="localInstallKind === 'directory'"
              @click="installFromLocal('directory')"
            >
              <i class="pi pi-folder" aria-hidden="true"></i>
              {{ localInstallKind === 'directory' ? '安装中…' : '从文件夹安装（开发）' }}
            </button>
          </div>
        </header>

        <div
          v-if="activeTab === 'discover'"
          class="market-classifications"
          role="group"
          aria-label="插件类型"
        >
          <button
            v-for="item in marketClassifications"
            :key="item.key"
            type="button"
            class="market-classification"
            :aria-pressed="selectedType === item.type"
            @click="selectClassification(item)"
          >
            {{ item.label }}
          </button>
        </div>

        <!-- Error / warning banners -->
        <div v-if="errorMsg" class="page-notice page-notice--error" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ errorMsg }}</span>
          <button
            type="button"
            class="btn btn-outline"
            :disabled="loading"
            @click="activeTab === 'discover' ? refreshMarket() : loadAll()"
          >
            重试
          </button>
        </div>
        <div v-if="warningMsg" class="page-notice page-notice--warning" role="status">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          {{ warningMsg }}
        </div>
        <div v-if="loading" class="page-status" role="status">
          <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> 正在加载插件…
        </div>

        <!-- Scroll Area: Installed -->
        <div class="scroll-area" v-if="activeTab === 'installed'">
          <h2 class="page-title">
            已安装扩展 <span class="badge">{{ filteredInstalled.length }}</span>
          </h2>

          <!-- Empty state -->
          <div
            v-if="!loading && !errorMsg && filteredInstalled.length === 0"
            class="empty-state"
            role="status"
          >
            <i class="pi pi-inbox" aria-hidden="true"></i>
            <p>{{ searchText ? '没有匹配的插件' : '暂无已安装插件' }}</p>
            <button
              v-if="!searchText"
              type="button"
              class="btn btn-outline"
              @click="switchTab('discover')"
            >
              去发现插件
            </button>
            <button v-else type="button" class="btn btn-outline" @click="clearSearch">
              清除搜索
            </button>
          </div>

          <div
            v-if="filteredInstalled.length"
            class="plugin-grid"
            :style="{ '--plugin-card-count': filteredInstalled.length }"
          >
            <div
              v-for="plugin in filteredInstalled"
              :key="plugin.id"
              class="plugin-card plugin-card--installed"
              :aria-busy="busyIds.has(plugin.id)"
            >
              <div class="plugin-card-header">
                <div class="plugin-icon" :class="getIconInfo(plugin.id, plugin.type).cls">
                  <ThemeIcon :icon-slot="getIconInfo(plugin.id, plugin.type).slot" />
                </div>
                <div class="plugin-info">
                  <div class="plugin-title-row">
                    <h3 class="plugin-name" :title="plugin.name">{{ plugin.name }}</h3>
                    <div class="plugin-version">v{{ plugin.version }}</div>
                  </div>
                  <div class="plugin-author" :title="plugin.author">
                    <i class="pi pi-user" aria-hidden="true"></i>
                    {{ plugin.author }}
                  </div>
                  <div class="plugin-tags">
                    <span v-if="plugin.builtIn" class="tag">内置</span>
                    <span
                      v-for="(tag, idx) in getTags(plugin.type)"
                      :key="idx"
                      class="tag"
                      :class="tag.cls"
                      :style="tag.style"
                      >{{ tag.label }}</span
                    >
                  </div>
                </div>
              </div>
              <div class="plugin-desc">
                {{ plugin.description }}
                <div v-if="plugin.error" class="plugin-error" role="alert">
                  <i class="pi pi-exclamation-circle"></i> {{ plugin.error }}
                </div>
              </div>
              <div class="plugin-footer">
                <button
                  type="button"
                  class="switch-wrap"
                  data-te-interactive
                  role="switch"
                  :aria-label="`启用 ${plugin.name}`"
                  :aria-checked="isPluginRequestedEnabled(plugin)"
                  :disabled="busyIds.has(plugin.id) || loading || updatingAll || !!localInstallKind"
                  @click="togglePlugin(plugin)"
                >
                  <div class="switch" :class="{ on: isPluginRequestedEnabled(plugin) }"></div>
                  <span class="switch-label">{{
                    busyIds.has(plugin.id)
                      ? '正在处理…'
                      : isPluginRequestedEnabled(plugin)
                        ? plugin.status === 'failed'
                          ? '启动失败'
                          : '已启用'
                        : '已停用'
                  }}</span>
                </button>
                <div class="plugin-actions">
                  <button
                    v-if="plugin.id === 'com.twilightecho.tool.theme-workshop' && plugin.enabled"
                    type="button"
                    class="btn btn-outline"
                    @click="emit('openThemeWorkshop')"
                  >
                    打开工坊
                  </button>
                  <button
                    v-if="!plugin.builtIn"
                    type="button"
                    class="icon-btn"
                    title="查看日志"
                    :aria-label="`查看 ${plugin.name} 的日志`"
                    :disabled="
                      busyIds.has(plugin.id) || loading || updatingAll || !!localInstallKind
                    "
                    @click="openLog(plugin)"
                  >
                    <i class="pi pi-align-left"></i>
                  </button>
                  <button
                    v-if="!plugin.builtIn"
                    type="button"
                    class="icon-btn danger"
                    title="卸载"
                    :aria-label="`卸载 ${plugin.name}`"
                    :disabled="
                      busyIds.has(plugin.id) || loading || updatingAll || !!localInstallKind
                    "
                    @click="uninstallPlugin(plugin)"
                  >
                    <i class="pi pi-trash"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Scroll Area: Discover -->
        <div class="scroll-area" v-else-if="activeTab === 'discover'">
          <div class="catalog-toolbar">
            <h2 class="page-title">
              可用插件 <span class="badge">{{ filteredIndex.length }}</span>
            </h2>
            <details class="market-source">
              <summary>
                目录信息
                <span v-if="indexStatus?.expired" class="source-state source-state--warning"
                  >已过期</span
                >
                <span
                  v-else-if="indexStatus?.trustStoreError"
                  class="source-state source-state--warning"
                  >签名校验不可用</span
                >
                <span
                  v-else-if="indexStatus && !indexStatus.originVerified"
                  class="source-state source-state--warning"
                  >来源待验证</span
                >
                <span
                  v-else-if="indexStatus && indexStatus.loadedFrom !== 'remote'"
                  class="source-state"
                  >离线缓存</span
                >
              </summary>
              <div class="market-source-content">
                <p>{{ indexSourceLabel }}</p>
                <div v-if="indexStatus" class="market-status">
                  <span>{{ indexLoadedFromLabel }}</span>
                  <span>获取：{{ formatIndexTime(indexStatus.lastFetchedAt) }}</span>
                  <span>过期：{{ formatIndexTime(indexStatus.expiresAt) }}</span>
                  <span v-if="indexStatus.stale" class="warn">使用回退索引</span>
                  <span v-if="indexStatus.expired" class="warn">索引已过期</span>
                  <span v-if="!indexStatus.originVerified" class="warn">来源未验证</span>
                  <span v-if="indexStatus.trustStoreError" class="warn">签名信任库不可用</span>
                  <span v-if="indexStatus.error" class="warn"
                    >最近错误：{{ indexStatus.error }}</span
                  >
                  <span class="source-url">{{ indexStatus.sourceUrl }}</span>
                  <span
                    v-if="indexStatus.configuredSourceUrl !== indexStatus.sourceUrl"
                    class="source-url warn"
                  >
                    配置：{{ indexStatus.configuredSourceUrl }}
                  </span>
                </div>
                <button
                  type="button"
                  class="plugin-repository-link"
                  @click="openExternal(marketRepoUrl)"
                >
                  浏览插件目录 <i class="pi pi-external-link" aria-hidden="true"></i>
                </button>
              </div>
            </details>
          </div>

          <!-- Empty state -->
          <div
            v-if="!loading && !errorMsg && filteredIndex.length === 0"
            class="empty-state"
            role="status"
          >
            <i class="pi pi-search" aria-hidden="true"></i>
            <p>
              {{
                searchText || selectedType || selectedAuthor || selectedTag
                  ? '没有匹配的插件'
                  : '插件市场暂无可用插件'
              }}
            </p>
            <button
              v-if="searchText || selectedType || selectedAuthor || selectedTag"
              type="button"
              class="btn btn-outline"
              @click="resetMarketSearch"
            >
              清除搜索和筛选
            </button>
          </div>

          <div
            v-if="visibleIndex.length"
            class="plugin-grid"
            :style="{ '--plugin-card-count': visibleIndex.length }"
          >
            <div
              v-for="entry in visibleIndex"
              :key="entry.id"
              class="plugin-card plugin-card--catalog"
              :aria-busy="busyIds.has(entry.id)"
            >
              <div class="plugin-card-header">
                <div class="plugin-icon" :class="getIconInfo(entry.id, entry.type).cls">
                  <ThemeIcon :icon-slot="getIconInfo(entry.id, entry.type).slot" />
                </div>
                <div class="plugin-info">
                  <div class="plugin-title-row">
                    <h3 class="plugin-name" :title="entry.name">{{ entry.name }}</h3>
                    <div class="plugin-version">v{{ entry.version }}</div>
                  </div>
                  <div class="plugin-author" :title="entry.author">
                    <span>{{
                      getTags(entry.type)
                        .map((tag) => tag.label)
                        .join(' · ')
                    }}</span>
                    <span>{{ entry.author }}</span>
                  </div>
                </div>
              </div>
              <div class="plugin-desc">
                {{ entry.description }}
              </div>
              <div class="plugin-footer">
                <!-- Install states -->
                <button
                  v-if="entry.installState === 'not-installed'"
                  type="button"
                  class="btn btn-primary"
                  :disabled="busyIds.has(entry.id) || loading || updatingAll || !!localInstallKind"
                  @click="installFromIndex(entry)"
                >
                  <i v-if="busyIds.has(entry.id)" class="pi pi-spin pi-spinner"></i>
                  {{ busyIds.has(entry.id) ? '安装中…' : '安装' }}
                </button>
                <span v-else-if="entry.installState === 'installed'" class="plugin-install-state">
                  <i class="pi pi-check"></i> 已安装
                </span>
                <button
                  v-else-if="entry.installState === 'update-available'"
                  type="button"
                  class="btn btn-primary"
                  :disabled="busyIds.has(entry.id) || loading || updatingAll || !!localInstallKind"
                  @click="installFromIndex(entry)"
                >
                  <i v-if="busyIds.has(entry.id)" class="pi pi-spin pi-spinner"></i>
                  {{ busyIds.has(entry.id) ? '更新中…' : '更新' }}
                </button>
                <span
                  v-else-if="entry.installState === 'incompatible'"
                  class="plugin-install-state"
                >
                  不兼容
                </span>
              </div>
              <details class="plugin-details">
                <summary>详情</summary>
                <div class="plugin-detail-content">
                  <p class="plugin-full-description">{{ entry.description }}</p>
                  <div class="plugin-trust" :class="`trust-${pluginTrust(entry).tone}`">
                    <i :class="pluginTrust(entry).icon" aria-hidden="true"></i>
                    {{ pluginTrust(entry).label }}
                  </div>
                  <p class="signature-evidence">{{ pluginTrust(entry).detail }}</p>
                  <button
                    v-if="entry.repository"
                    type="button"
                    class="plugin-repository-link"
                    @click="openExternal(entry.repository)"
                  >
                    开发者仓库 <i class="pi pi-external-link" aria-hidden="true"></i>
                  </button>
                </div>
              </details>
            </div>
          </div>
          <button
            v-if="visibleIndex.length < filteredIndex.length"
            type="button"
            class="btn btn-outline market-load-more"
            @click="visibleCount += 40"
          >
            加载更多（{{ visibleIndex.length }}/{{ filteredIndex.length }}）
          </button>
        </div>

        <!-- Scroll Area: Updates -->
        <div class="scroll-area" v-else-if="activeTab === 'updates'">
          <h2 class="page-title">
            可用更新
            <span v-if="filteredUpdates.length > 0" class="badge">{{
              filteredUpdates.length
            }}</span>
          </h2>

          <!-- Empty state -->
          <div
            v-if="!loading && !errorMsg && filteredUpdates.length === 0"
            class="empty-state"
            role="status"
          >
            <i class="pi pi-check-circle" aria-hidden="true"></i>
            <p>{{ updateEntries.length ? '没有匹配的更新' : '所有插件均为最新版本' }}</p>
            <button v-if="searchText" type="button" class="btn btn-outline" @click="clearSearch">
              清除搜索
            </button>
          </div>

          <template v-if="filteredUpdates.length">
            <div class="updates-summary">
              <span>
                {{ updateEntries.length }} 个插件可更新<span v-if="searchText"
                  >，找到 {{ filteredUpdates.length }} 个</span
                >
              </span>
              <button
                type="button"
                class="btn btn-primary"
                :disabled="loading || updatingAll || busyIds.size > 0 || !!localInstallKind"
                :aria-busy="updatingAll"
                @click="updateAll"
              >
                {{ updatingAll ? '正在更新…' : '全部更新' }}
              </button>
            </div>

            <div class="plugin-grid" :style="{ '--plugin-card-count': filteredUpdates.length }">
              <div
                v-for="entry in filteredUpdates"
                :key="entry.id"
                class="plugin-card plugin-card--update"
                :aria-busy="busyIds.has(entry.id)"
              >
                <div class="plugin-card-header">
                  <div class="plugin-icon" :class="getIconInfo(entry.id, entry.type).cls">
                    <ThemeIcon :icon-slot="getIconInfo(entry.id, entry.type).slot" />
                  </div>
                  <div class="plugin-info">
                    <div class="plugin-title-row">
                      <h3 class="plugin-name" :title="entry.name">
                        {{ entry.name }}
                      </h3>
                    </div>
                    <div class="plugin-author">
                      {{ entry.installedVersion ? `v${entry.installedVersion}` : '未知版本' }}
                      <i
                        class="pi pi-arrow-right"
                        style="font-size: var(--te-type-caption); margin: 0 4px"
                      ></i>
                      <span>v{{ entry.version }}</span>
                    </div>
                  </div>
                </div>
                <div class="plugin-desc">
                  {{ entry.description }}
                </div>
                <div class="plugin-footer">
                  <button
                    type="button"
                    class="btn btn-primary"
                    :disabled="
                      busyIds.has(entry.id) || loading || updatingAll || !!localInstallKind
                    "
                    @click="installFromIndex(entry)"
                  >
                    <i v-if="busyIds.has(entry.id)" class="pi pi-spin pi-spinner"></i>
                    {{ busyIds.has(entry.id) ? '更新中…' : '更新' }}
                  </button>
                </div>
              </div>
            </div>
          </template>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.plugin-page {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: var(--te-settings-text);
  font-family: var(--te-font-sans);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

.plugin-window {
  width: 100%;
  height: 100%;
  background: transparent;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
  z-index: 1;
  box-sizing: border-box;
  padding: var(--te-page-top, 32px) var(--te-page-inset, 32px) var(--te-page-bottom);
  scroll-padding-block: 16px var(--te-page-bottom);
  container: te-plugin-market / inline-size;
}

.plugin-page > .app-background-layer {
  display: block;
  z-index: 0;
}

.plugin-page-header {
  flex-shrink: 0;
}

.plugin-heading h1 {
  font-size: var(--te-type-page-title);
  font-weight: var(--te-type-weight-strong);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--te-settings-text);
  line-height: var(--te-type-line-title);
}

.plugin-page-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 16px;
  border-bottom: 1px solid var(--te-card-border);
}

.nav-menu {
  padding: 0;
  display: flex;
  gap: 20px;
  min-height: 0;
  min-width: 0;
  max-width: 100%;
  flex-wrap: wrap;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 38px;
  padding: 0 2px;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--te-settings-text-muted);
  cursor: pointer;
  transition:
    background-color 0.2s var(--te-ease-soft),
    color 0.2s var(--te-ease-soft);
  font: inherit;
  font-weight: var(--te-type-weight-medium);
  font-size: var(--te-type-body);
}

.nav-item i {
  font-size: var(--te-type-icon);
  opacity: 0.7;
}

.nav-item:hover {
  background: var(--te-hover-bg);
  color: var(--te-settings-text);
}

.nav-item.active {
  border-bottom-color: currentColor;
  color: var(--te-settings-text);
  font-weight: var(--te-type-weight-strong);
}

.nav-item.active i {
  opacity: 1;
}

.dev-mode-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-medium);
  color: var(--te-settings-text-muted);
}
.dev-mode-toggle .switch {
  height: 28px;
  background: transparent;
}
.dev-mode-toggle .switch::before {
  content: '';
  position: absolute;
  inset: 4px 0;
  border-radius: 20px;
  background: var(--te-border-color);
}
.dev-mode-toggle .switch.on::before {
  background: var(--te-primary-600);
}
.dev-mode-toggle .switch::after {
  top: 6px;
}

.switch {
  flex-shrink: 0;
  border: 0;
  padding: 0;
  width: 36px;
  height: 20px;
  background: var(--te-border-color, #e5e7eb);
  border-radius: 20px;
  position: relative;
  cursor: pointer;
  transition: background 0.2s;
}

.switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: #fff; /* keep-white: toggle knob */
  border-radius: 50%;
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: none;
}

.switch.on {
  background: var(--te-primary-600, #6366f1);
}

.switch.on::after {
  transform: translateX(16px);
}

/* Main Content */
.plugin-main {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  background: transparent;
  min-height: 0;
  min-width: 0;
}

.topbar {
  min-height: 64px;
  padding: 16px 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 0;
  background: transparent;
  z-index: 10;
  flex-shrink: 0;
  gap: 12px;
  flex-wrap: wrap;
}

.search-box {
  color: var(--te-control-fg);
  display: flex;
  align-items: center;
  background: var(--te-control-bg);
  border: 1px solid var(--te-control-border);
  border-radius: var(--te-control-radius-sm);
  padding: 8px 12px;
  width: min(420px, 100%);
  max-width: 420px;
  flex: 1 1 280px;
  transition: background-color 0.2s var(--te-ease-soft);
  min-width: 0;
}

.search-box:focus-within {
  background: var(--te-control-bg);
  outline: var(--te-control-focus-width) solid var(--te-control-focus-color);
  outline-offset: var(--te-control-focus-offset);
  box-shadow: none;
}

.search-box i {
  color: var(--te-control-fg-muted);
  margin-right: 8px;
}

.search-box input {
  border: none;
  background: transparent;
  outline: none;
  font-size: var(--te-type-body);
  width: 100%;
  color: var(--te-control-fg);
  font-family: var(--te-font-sans);
  font-weight: var(--te-type-weight-regular);
  min-width: 0;
  line-height: var(--te-type-line-body);
}

.search-box input::-webkit-search-cancel-button {
  -webkit-appearance: none;
}

.search-clear {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 32px;
  min-height: 32px;
  margin: -4px -8px -4px 4px;
  padding: 0;
  border: 0;
  border-radius: var(--te-control-radius-sm);
  background: transparent;
  color: var(--te-settings-text-muted);
  cursor: pointer;
}
.search-clear i {
  margin: 0;
}
.search-clear:hover {
  background: var(--te-hover-bg);
}

.search-box input::placeholder {
  color: var(--te-control-fg-muted);
}

.market-filters {
  position: relative;
  margin-inline-start: auto;
  flex-shrink: 0;
  color: var(--te-settings-text);
  font-size: var(--te-type-caption);
}

.market-filters > summary {
  min-height: var(--te-control-height-md);
  padding: 6px var(--te-control-pad-x-sm);
  border-radius: var(--te-control-radius-sm);
  cursor: pointer;
}
.market-filters > summary:hover {
  background: var(--te-hover-bg);
}

.market-filter-content {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 12;
  width: min(320px, calc(100vw - 48px));
  max-height: min(480px, calc(100vh - 160px));
  overflow-y: auto;
  padding: 16px;
  border: 1px solid var(--te-material-border, var(--te-card-border));
  border-radius: var(--te-control-radius-sm);
  background: var(--te-material-background, var(--te-card-bg));
  box-shadow: var(--te-material-shadow, none);
  color: var(--te-material-ink, var(--te-settings-text));
  backdrop-filter: var(--te-material-filter, none);
  -webkit-backdrop-filter: var(--te-material-filter, none);
  display: grid;
  gap: 12px;
}

.market-filter-reset {
  justify-self: end;
  border: 0;
  padding: 4px 0;
  background: transparent;
  color: var(--te-settings-text);
  font: inherit;
  cursor: pointer;
}

.market-classifications {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
  padding: 0 0 12px;
  overflow-x: auto;
}

.market-classification {
  flex-shrink: 0;
  min-height: 32px;
  padding: 5px 12px;
  border: 0;
  border-radius: var(--te-control-radius-sm);
  background: transparent;
  color: var(--te-settings-text-muted);
  font: inherit;
  font-size: var(--te-type-caption);
  cursor: pointer;
}

.market-classification:hover,
.market-classification[aria-pressed='true'] {
  background: var(--te-active-bg);
  color: var(--te-settings-text);
}

.market-filters label {
  display: grid;
  gap: 8px;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
}

.market-filters select {
  width: 100%;
  max-width: 100%;
  padding: 7px 12px;
  border: 1px solid var(--te-control-border);
  border-radius: var(--te-control-radius-sm);
  background: var(--te-control-bg);
  color: var(--te-settings-text);
  min-height: 34px;
  font: inherit;
  font-weight: var(--te-type-weight-regular);
}

.plugin-repository-link {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--te-settings-text);
  cursor: pointer;
  min-height: 28px;
  font: inherit;
  font-size: var(--te-type-caption);
}

.market-load-more {
  display: flex;
  margin: 20px auto 0;
}

.top-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
  max-width: 100%;
  margin-inline-start: auto;
}

.btn {
  min-height: var(--te-control-height-md);
  padding: 6px var(--te-control-pad-x-md);
  border-radius: var(--te-control-radius-sm);
  font-size: var(--te-type-body);
  font-weight: var(--te-control-font-weight-strong);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: var(--te-control-gap);
  transition:
    background-color var(--te-motion-hover) var(--te-ease-soft),
    border-color var(--te-motion-hover) var(--te-ease-soft),
    color var(--te-motion-hover) var(--te-ease-soft);
  border: none;
  font-family: inherit;
  line-height: var(--te-type-line-body);
  max-width: 100%;
  white-space: normal;
}

.btn-outline {
  background: transparent;
  border: 1px solid var(--te-control-border);
  color: var(--te-settings-text);
}

.btn-outline:hover {
  background: var(--te-hover-bg);
}

.btn-primary {
  background: var(--te-control-bg);
  color: var(--te-control-fg);
  font-weight: var(--te-type-weight-medium);
}

.btn-primary:hover {
  background: var(--te-hover-bg);
}

.scroll-area {
  flex: 0 0 auto;
  padding: 8px 0 0;
  min-height: 0;
  min-width: 0;
}

.page-notice {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 16px;
  padding: 12px;
  border: 1px solid currentColor;
  border-radius: var(--te-control-radius-sm);
  font-size: var(--te-type-caption);
  line-height: var(--te-type-line-body);
  overflow-wrap: anywhere;
}
.page-notice > span {
  flex: 1;
  min-width: 0;
}
.page-notice--error {
  background: var(--te-danger-soft-bg);
  color: var(--te-danger-soft-fg);
}
.page-notice--warning {
  background: var(--te-warning-soft-bg);
  color: var(--te-warning-soft-fg);
}
.page-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 0;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
}
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 32px 0;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-body);
}
.empty-state > i {
  font-size: var(--te-type-section-title);
}
.empty-state p {
  margin: 0;
}
.plugin-error {
  margin-top: 8px;
  color: var(--te-danger-soft-fg);
  font-size: var(--te-type-caption);
}
.plugin-install-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: var(--te-control-height-md);
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-medium);
}

.page-title {
  font-size: var(--te-type-body);
  font-weight: var(--te-type-weight-strong);
  color: var(--te-settings-text);
  margin: 0 0 12px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.badge {
  font-size: var(--te-badge-font-size);
  font-weight: var(--te-badge-font-weight);
  background: transparent;
  color: var(--te-control-fg-muted);
  padding: 0;
  border-radius: var(--te-badge-radius);
}

.plugin-grid {
  --plugin-card-min: 320px;
  --plugin-card-max: 560px;
  --plugin-card-gap: 24px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--plugin-card-min)), 1fr));
  gap: 16px var(--plugin-card-gap);
  width: 100%;
  max-width: calc(
    var(--plugin-card-count) * var(--plugin-card-max) + (var(--plugin-card-count) - 1) *
      var(--plugin-card-gap)
  );
}
.updates-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--te-card-border);
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  flex-wrap: wrap;
}

.market-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 8px 0;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-regular);
}

.market-status span {
  max-width: 100%;
  padding: 0;
}

.market-status .warn {
  background: var(--te-warning-soft-bg, #fff7ed);
  color: var(--te-warning-soft-fg);
}

.market-status .source-url {
  min-width: 0;
  flex-basis: 100%;
  overflow-wrap: anywhere;
}

/* Plugins share one readable list hierarchy across discovery and management. */
.plugin-card {
  background: transparent;
  border-radius: var(--te-card-radius, 12px);
  padding: 16px;
  border: 1px solid var(--te-card-border);
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  width: 100%;
  max-width: var(--plugin-card-max);
  position: relative;
}

.plugin-card-header {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 0;
  min-width: 0;
}

.plugin-icon {
  width: 44px;
  height: 44px;
  border-radius: var(--te-control-radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--te-type-icon);
  flex-shrink: 0;
  background: var(--te-subtle-bg);
  color: var(--te-settings-text-muted);
}

.plugin-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.plugin-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  min-width: 0;
  flex-wrap: wrap;
}

.plugin-name {
  margin: 0;
  font-size: var(--te-type-body);
  font-weight: var(--te-type-weight-strong);
  color: var(--te-settings-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.plugin-version {
  font-size: var(--te-type-caption);
  color: var(--te-settings-text-muted);
  font-weight: var(--te-type-weight-regular);
  flex-shrink: 0;
}

.plugin-author {
  font-size: var(--te-type-caption);
  color: var(--te-settings-text-muted);
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-weight: var(--te-type-weight-regular);
}

.plugin-trust {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-medium);
}

.signature-evidence {
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  letter-spacing: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.6;
}

.plugin-trust.trust-official {
  color: var(--te-info-soft-fg);
}

.plugin-trust.trust-signed {
  color: var(--te-success-soft-fg);
}

.plugin-trust.trust-declared {
  color: var(--te-warning-soft-fg);
}

.plugin-trust.trust-unverified {
  color: var(--te-settings-text-muted);
}

.plugin-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.tag {
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-regular);
  padding: 0;
}
.tag:is(.provider, .ui, .dsp, .tool, .theme, .community) {
  background: transparent;
  color: var(--te-settings-text-muted);
}

.plugin-desc {
  font-size: var(--te-type-caption);
  color: var(--te-settings-text-muted);
  line-height: var(--te-type-line-body);
  margin: 0;
  overflow-wrap: anywhere;
  font-weight: var(--te-type-weight-regular);
}
.plugin-card--catalog .plugin-desc {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.plugin-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: 0;
  padding-top: 4px;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: auto;
}

.switch-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.switch-label {
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-strong);
  color: var(--te-settings-text-muted);
}

.plugin-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.icon-btn {
  width: var(--te-control-height-md);
  height: var(--te-control-height-md);
  border-radius: var(--te-control-radius-sm);
  border: none;
  background: var(--te-control-bg-hover);
  color: var(--te-settings-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background-color var(--te-motion-hover) var(--te-ease-soft),
    color var(--te-motion-hover) var(--te-ease-soft);
}

.icon-btn:hover {
  background: var(--te-hover-bg);
  color: var(--te-settings-text);
}

.icon-btn.danger:hover {
  background: var(--te-danger-soft-bg);
  color: var(--te-danger-soft-fg);
}

.catalog-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 20px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--te-card-border);
}
.catalog-toolbar .page-title {
  margin: 0;
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-medium);
  color: var(--te-settings-text-muted);
}
.market-source,
.plugin-details {
  min-width: 0;
  font-size: var(--te-type-caption);
  color: var(--te-settings-text-muted);
}
.market-source[open] {
  flex-basis: 100%;
}
.market-source-content {
  padding: 4px 0 12px;
}
.market-source-content > p {
  margin: 8px 0;
  color: var(--te-settings-text);
}
.market-source summary,
.plugin-details summary {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  width: fit-content;
  list-style: none;
  cursor: pointer;
}
.market-source summary::-webkit-details-marker,
.plugin-details summary::-webkit-details-marker {
  display: none;
}
.market-source summary::before,
.plugin-details summary::before {
  content: '';
  width: 5px;
  height: 5px;
  flex-shrink: 0;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
}
.market-source[open] summary::before,
.plugin-details[open] summary::before {
  transform: rotate(45deg);
}
.source-state {
  margin-left: 6px;
  color: var(--te-settings-text-muted);
}
.source-state--warning {
  color: var(--te-warning-soft-fg);
}
.plugin-details {
  margin: 0;
}
.plugin-detail-content {
  padding: 4px 0 8px;
}
.plugin-full-description {
  margin: 0 0 12px;
  line-height: 1.5;
  color: var(--te-settings-text-muted);
  font-weight: var(--te-type-weight-regular);
}
.plugin-page :is(.market-source, .plugin-details) summary:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 3px;
  border-radius: 4px;
}

@container te-plugin-market (max-width: 620px) {
  .search-box {
    width: 100%;
    max-width: none;
    flex-basis: 100%;
  }
  .top-actions {
    width: 100%;
    margin-inline-start: 0;
  }
}

.update-count {
  margin-left: 4px;
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-strong);
  color: var(--te-settings-text-muted);
}
.plugin-page :is(button, select):focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 3px;
}
.plugin-page button:disabled {
  cursor: default;
  opacity: 0.5;
}
@media (prefers-reduced-motion: reduce) {
  .plugin-page *,
  .plugin-page *::after {
    transition: none;
  }
}
</style>
