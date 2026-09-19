<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import PuzzleIcon from './icons/PuzzleIcon.vue'
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

type TwilightPluginDescriptor = Awaited<ReturnType<typeof window.api.plugins.list>>[number]
type TwilightPluginIndexEntry = Awaited<ReturnType<typeof window.api.plugins.listIndex>>[number]
type TwilightPluginIndexStatus = Awaited<ReturnType<typeof window.api.plugins.getIndexStatus>>

const activeTab = ref('installed')
const emit = defineEmits<{ openThemeWorkshop: [] }>()
const { settings, updateSettings } = useSettingsStore()
// 开发者模式是持久化设置：这里的开关与「设置 → 常规 → 开发者选项」是同一个值。
const devMode = computed(() => settings.value.developerMode === true)
const searchText = ref('')

const installedPlugins = ref<TwilightPluginDescriptor[]>([])
const indexEntries = ref<TwilightPluginIndexEntry[]>([])
const indexStatus = ref<TwilightPluginIndexStatus | null>(null)
const loading = ref(false)
const errorMsg = ref('')
const warningMsg = ref('')
const busyIds = ref(new Set<string>())
const trustEvaluationTimeMs = ref(Date.now())
let trustRefreshController: PluginTrustRefreshController | null = null
let indexRequestGeneration = 0

function switchTab(tabId: string) {
  activeTab.value = tabId
}

/* ---------- helpers ---------- */

function getIconInfo(id: string, type: string[]): { cls: string; icon: string; style?: string } {
  if (id.includes('ncm')) return { cls: 'ncm', icon: 'pi pi-cloud' }
  if (type.includes('provider')) return { cls: 'provider', icon: 'pi pi-music' }
  if (type.includes('dsp')) return { cls: 'dsp', icon: 'pi pi-wave-pulse' }
  return {
    cls: '',
    icon: 'pi pi-puzzle',
    style: 'background: linear-gradient(135deg, #e0e7ff, #c7d2fe); color: #4f46e5;'
  }
}

function getTags(type: string[]): Array<{ label: string; cls: string; style?: string }> {
  const tags: Array<{ label: string; cls: string; style?: string }> = []
  for (const t of type) {
    if (t === 'provider') tags.push({ label: 'PROVIDER', cls: 'provider' })
    else if (t === 'ui') tags.push({ label: 'UI', cls: 'ui' })
    else if (t === 'dsp') tags.push({ label: 'DSP NATIVE', cls: 'dsp' })
    else if (t === 'tool') tags.push({ label: 'TOOL', cls: 'tool' })
    else if (t === 'theme')
      tags.push({
        label: 'THEME',
        cls: '',
        style: 'background: rgba(168, 85, 247, 0.1); color: #a855f7;'
      })
  }
  return tags
}

/* ---------- computed ---------- */

const filteredInstalled = computed(() => {
  const list = installedPlugins.value
  if (!searchText.value.trim()) return list
  const q = searchText.value.toLowerCase()
  return list.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.author.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q)
  )
})

const filteredIndex = computed(() => {
  const list = indexEntries.value.filter((e) => e.installState !== 'built-in-blocked')
  if (!searchText.value.trim()) return list
  const q = searchText.value.toLowerCase()
  return list.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.author.toLowerCase().includes(q) ||
      e.id.toLowerCase().includes(q)
  )
})

const updateEntries = computed(() => {
  return indexEntries.value.filter((e) => e.installState === 'update-available')
})

const marketRepoUrl = computed(() => {
  const entry = indexEntries.value.find((e) => e.repository || e.homepage)
  return entry?.repository || entry?.homepage || ''
})

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

async function togglePlugin(plugin: TwilightPluginDescriptor) {
  if (busyIds.value.has(plugin.id)) return
  busyIds.value.add(plugin.id)
  try {
    if (plugin.enabled) {
      await window.api.plugins.disable(plugin.id)
    } else {
      await window.api.plugins.enable(plugin.id)
    }
    await refreshInstalled()
  } catch (e) {
    errorMsg.value = `${plugin.enabled ? '停用' : '启用'}失败：${e instanceof Error ? e.message : String(e)}`
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
      '请切换到「已安装」→「从本地安装包 (.tep)」，或配置可访问 GitHub raw 的代理/镜像后重试。'
    )
  }
  return `安装失败：${message}`
}

async function installFromLocal(kind: 'package' | 'directory' = 'package') {
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
  }
}

async function toggleDevMode() {
  errorMsg.value = ''
  try {
    await updateSettings({ developerMode: !devMode.value })
  } catch (e) {
    errorMsg.value = `切换开发者模式失败：${e instanceof Error ? e.message : String(e)}`
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
  for (const entry of updateEntries.value) {
    await installFromIndex(entry)
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
  if (url) window.open(url, '_blank')
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
  trustRefreshController?.stop()
  trustRefreshController = null
})
</script>

<template>
  <div class="plugin-page">
    <div class="plugin-window">
      <!-- Sidebar -->
      <aside class="sidebar">
        <div class="sidebar-header">
          <h1><PuzzleIcon /> 扩展中心</h1>
        </div>
        <nav class="nav-menu">
          <div
            class="nav-item"
            data-te-interactive
            role="button"
            tabindex="0"
            :aria-pressed="activeTab === 'installed'"
            :class="{ active: activeTab === 'installed' }"
            @click="switchTab('installed')"
            @keydown.enter.prevent="switchTab('installed')"
            @keydown.space.prevent="switchTab('installed')"
          >
            <i class="pi pi-check-circle"></i>
            <span>已安装</span>
          </div>
          <div
            class="nav-item"
            data-te-interactive
            role="button"
            tabindex="0"
            :aria-pressed="activeTab === 'discover'"
            :class="{ active: activeTab === 'discover' }"
            @click="switchTab('discover')"
            @keydown.enter.prevent="switchTab('discover')"
            @keydown.space.prevent="switchTab('discover')"
          >
            <i class="pi pi-compass"></i>
            <span>发现市场</span>
          </div>
          <div
            class="nav-item"
            data-te-interactive
            role="button"
            tabindex="0"
            :aria-pressed="activeTab === 'updates'"
            :class="{ active: activeTab === 'updates' }"
            @click="switchTab('updates')"
            @keydown.enter.prevent="switchTab('updates')"
            @keydown.space.prevent="switchTab('updates')"
          >
            <i class="pi pi-cloud-download"></i>
            <span
              >更新
              <span
                v-if="updateEntries.length > 0"
                style="
                  background: #ef4444;
                  color: #fff;
                  font-size: calc(var(--te-font-size-body, 14px) * 10 / 14);
                  padding: 2px 6px;
                  border-radius: 100px;
                  margin-left: 4px;
                "
                >{{ updateEntries.length }}</span
              ></span
            >
          </div>
        </nav>

        <div class="sidebar-footer">
          <div class="dev-mode-toggle">
            <span>开发者模式</span>
            <div
              class="switch"
              data-te-interactive
              role="switch"
              tabindex="0"
              aria-label="开发者模式"
              :aria-checked="devMode"
              :class="{ on: devMode }"
              @click="toggleDevMode"
              @keydown.enter.prevent="toggleDevMode"
              @keydown.space.prevent="toggleDevMode"
            ></div>
          </div>
        </div>
      </aside>

      <!-- Main Content -->
      <main class="main-content">
        <!-- Topbar -->
        <header class="topbar">
          <div class="search-box">
            <i class="pi pi-search"></i>
            <input
              type="text"
              v-model="searchText"
              :placeholder="
                activeTab === 'installed'
                  ? '搜索已安装插件名称或作者...'
                  : activeTab === 'discover'
                    ? '搜索当前插件索引...'
                    : '在可用更新中搜索...'
              "
            />
          </div>
          <div class="top-actions">
            <button
              v-if="activeTab === 'installed'"
              class="btn btn-outline"
              @click="installFromLocal('package')"
            >
              <i class="pi pi-folder-open"></i> 从本地安装包 (.tep)
            </button>
            <button
              v-if="activeTab === 'installed' && devMode"
              class="btn btn-outline"
              title="选择包含 plugin.json 的未打包插件目录（开发者模式）"
              @click="installFromLocal('directory')"
            >
              <i class="pi pi-folder"></i> 从文件夹安装（开发）
            </button>
            <button
              v-if="activeTab === 'discover'"
              class="btn btn-outline"
              @click="refreshMarket"
              :disabled="loading"
            >
              <i class="pi pi-refresh"></i> {{ loading ? '刷新中...' : '刷新市场' }}
            </button>
          </div>
        </header>

        <!-- Error / warning banners -->
        <div
          v-if="errorMsg"
          style="
            margin: 0 32px 16px;
            padding: 12px 16px;
            background: var(--te-danger-soft-bg);
            border: 1px solid var(--te-danger-soft-fg);
            border-radius: 12px;
            color: var(--te-danger-soft-fg);
            font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
            display: flex;
            align-items: center;
            gap: 8px;
          "
        >
          <i class="pi pi-exclamation-triangle"></i>
          {{ errorMsg }}
        </div>
        <div
          v-if="warningMsg"
          style="
            margin: 0 32px 16px;
            padding: 12px 16px;
            background: var(--te-warning-soft-bg, #fff7ed);
            border: 1px solid var(--te-warning-soft-fg, #c2410c);
            border-radius: 12px;
            color: var(--te-warning-soft-fg, #c2410c);
            font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
            display: flex;
            align-items: center;
            gap: 8px;
          "
        >
          <i class="pi pi-info-circle"></i>
          {{ warningMsg }}
        </div>

        <!-- Scroll Area: Installed -->
        <div class="scroll-area" v-if="activeTab === 'installed'">
          <div class="page-title">
            已安装扩展 <span class="badge">{{ filteredInstalled.length }}</span>
          </div>

          <!-- Empty state -->
          <div
            v-if="filteredInstalled.length === 0"
            style="
              text-align: center;
              padding: 60px 20px;
              color: var(--te-neutral-400, #9ca3af);
              font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
            "
          >
            <i
              class="pi pi-inbox"
              style="
                font-size: calc(var(--te-font-size-body, 14px) * 48 / 14);
                display: block;
                margin-bottom: 16px;
                opacity: 0.3;
              "
            ></i>
            <p>{{ searchText ? '没有匹配的插件' : '暂无已安装插件' }}</p>
            <button
              v-if="!searchText"
              type="button"
              class="btn btn-outline"
              style="margin-top: 16px"
              @click="switchTab('discover')"
            >
              去发现插件
            </button>
          </div>

          <div class="plugin-grid" v-else>
            <div
              v-for="plugin in filteredInstalled"
              :key="plugin.id"
              class="plugin-card"
              :style="{ opacity: plugin.enabled ? 1 : 0.7 }"
            >
              <div v-if="plugin.builtIn" class="builtin-label">系统内置</div>
              <div class="plugin-card-header">
                <div
                  class="plugin-icon"
                  :class="getIconInfo(plugin.id, plugin.type).cls"
                  :style="getIconInfo(plugin.id, plugin.type).style"
                >
                  <i :class="getIconInfo(plugin.id, plugin.type).icon"></i>
                </div>
                <div class="plugin-info">
                  <div class="plugin-title-row">
                    <div class="plugin-name">{{ plugin.name }}</div>
                    <div class="plugin-version">v{{ plugin.version }}</div>
                  </div>
                  <div class="plugin-author">
                    <i class="pi pi-user"></i>
                    {{ plugin.author }}
                  </div>
                  <div class="plugin-tags">
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
                <div
                  v-if="plugin.error"
                  style="
                    margin-top: 8px;
                    color: #ef4444;
                    font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
                  "
                >
                  <i class="pi pi-exclamation-circle"></i> {{ plugin.error }}
                </div>
              </div>
              <div class="plugin-footer">
                <div
                  class="switch-wrap"
                  data-te-interactive
                  role="switch"
                  tabindex="0"
                  :aria-label="`启用 ${plugin.name}`"
                  :aria-checked="plugin.enabled"
                  @click="togglePlugin(plugin)"
                  @keydown.enter.prevent="togglePlugin(plugin)"
                  @keydown.space.prevent="togglePlugin(plugin)"
                >
                  <div class="switch" :class="{ on: plugin.enabled }"></div>
                  <span class="switch-label">{{ plugin.enabled ? '已启用' : '已停用' }}</span>
                </div>
                <div class="plugin-actions">
                  <button
                    v-if="plugin.id === 'com.twilightecho.tool.theme-workshop' && plugin.enabled"
                    @click="emit('openThemeWorkshop')"
                  >
                    打开工坊
                  </button>
                  <button
                    v-if="!plugin.builtIn"
                    class="icon-btn"
                    title="查看日志"
                    @click="openLog(plugin)"
                  >
                    <i class="pi pi-align-left"></i>
                  </button>
                  <button
                    v-if="!plugin.builtIn"
                    class="icon-btn danger"
                    title="卸载"
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
          <div class="discover-banner">
            <div class="banner-text">
              <h2>{{ indexSourceLabel }}</h2>
              <p>
                当前索引用于发现插件；安装前展示来源、有效期、SHA-256、签名、权限与代码执行风险。
              </p>
            </div>
            <div class="banner-art">
              <i class="pi pi-server"></i>
            </div>
            <button
              v-if="marketRepoUrl"
              class="btn btn-outline"
              style="
                position: absolute;
                right: 32px;
                bottom: 32px;
                background: rgba(255, 255, 255, 0.1);
                border-color: rgba(255, 255, 255, 0.2);
                color: #fff;
              "
              @click="openExternal(marketRepoUrl)"
            >
              浏览插件仓库 <i class="pi pi-external-link"></i>
            </button>
          </div>

          <div v-if="indexStatus" class="market-status">
            <span><i class="pi pi-database"></i> {{ indexLoadedFromLabel }}</span>
            <span>获取：{{ formatIndexTime(indexStatus.lastFetchedAt) }}</span>
            <span>过期：{{ formatIndexTime(indexStatus.expiresAt) }}</span>
            <span v-if="indexStatus.stale" class="warn">使用回退索引</span>
            <span v-if="indexStatus.expired" class="warn">索引已过期</span>
            <span v-if="!indexStatus.originVerified" class="warn">来源未验证</span>
            <span v-if="indexStatus.trustStoreError" class="warn">签名信任库不可用</span>
            <span v-if="indexStatus.error" class="warn">最近错误：{{ indexStatus.error }}</span>
            <span class="source-url" :title="indexStatus.sourceUrl">{{
              indexStatus.sourceUrl
            }}</span>
            <span
              v-if="indexStatus.configuredSourceUrl !== indexStatus.sourceUrl"
              class="source-url warn"
              :title="indexStatus.configuredSourceUrl"
            >
              配置：{{ indexStatus.configuredSourceUrl }}
            </span>
          </div>

          <div
            class="page-title"
            style="font-size: calc(var(--te-font-size-body, 14px) * 18 / 14); margin-bottom: 16px"
          >
            可用插件
          </div>

          <!-- Empty state -->
          <div
            v-if="filteredIndex.length === 0"
            style="
              text-align: center;
              padding: 60px 20px;
              color: var(--te-neutral-400, #9ca3af);
              font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
            "
          >
            <i
              class="pi pi-search"
              style="
                font-size: calc(var(--te-font-size-body, 14px) * 48 / 14);
                display: block;
                margin-bottom: 16px;
                opacity: 0.3;
              "
            ></i>
            {{ searchText ? '没有匹配的插件' : '插件市场暂无可用插件' }}
          </div>

          <div class="plugin-grid" v-else>
            <div
              v-for="entry in filteredIndex"
              :key="entry.id"
              class="plugin-card"
              :style="{ opacity: entry.installState === 'incompatible' ? 0.6 : 1 }"
            >
              <div class="plugin-card-header">
                <div
                  class="plugin-icon"
                  :class="getIconInfo(entry.id, entry.type).cls"
                  :style="getIconInfo(entry.id, entry.type).style"
                >
                  <i :class="getIconInfo(entry.id, entry.type).icon"></i>
                </div>
                <div class="plugin-info">
                  <div class="plugin-title-row">
                    <div class="plugin-name">{{ entry.name }}</div>
                    <div class="plugin-version">v{{ entry.version }}</div>
                  </div>
                  <div class="plugin-author" :title="pluginTrust(entry).detail">
                    <i :class="pluginTrust(entry).icon"></i>
                    {{ entry.author }}
                  </div>
                  <div class="plugin-tags">
                    <span
                      v-for="(tag, idx) in getTags(entry.type)"
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
                {{ entry.description }}
              </div>
              <div class="plugin-footer">
                <div class="plugin-trust-stack">
                  <div
                    class="plugin-trust"
                    :class="`trust-${pluginTrust(entry).tone}`"
                    :title="pluginTrust(entry).detail"
                  >
                    <i :class="pluginTrust(entry).icon"></i> {{ pluginTrust(entry).label }}
                  </div>
                  <span
                    class="signature-evidence"
                    :title="entry.verification.keyFingerprintSha256 || entry.verification.reason"
                  >
                    签名 {{ entry.verification.signatureStatus }} · 指纹
                    {{ entry.verification.keyFingerprintSha256?.slice(0, 12) || '无' }}
                  </span>
                </div>

                <!-- Install states -->
                <button
                  v-if="entry.installState === 'not-installed'"
                  class="btn btn-primary"
                  style="padding: 6px 16px"
                  :disabled="busyIds.has(entry.id)"
                  @click="installFromIndex(entry)"
                >
                  <i v-if="busyIds.has(entry.id)" class="pi pi-spin pi-spinner"></i>
                  {{ busyIds.has(entry.id) ? '安装中' : '获取' }}
                </button>
                <span
                  v-else-if="entry.installState === 'installed'"
                  style="
                    font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
                    font-weight: 600;
                    color: var(--te-neutral-400);
                    display: flex;
                    align-items: center;
                    gap: 4px;
                  "
                >
                  <i class="pi pi-check"></i> 已安装
                </span>
                <button
                  v-else-if="entry.installState === 'update-available'"
                  class="btn btn-primary"
                  style="padding: 6px 16px"
                  :disabled="busyIds.has(entry.id)"
                  @click="installFromIndex(entry)"
                >
                  <i v-if="busyIds.has(entry.id)" class="pi pi-spin pi-spinner"></i>
                  {{ busyIds.has(entry.id) ? '更新中' : '更新' }}
                </button>
                <span
                  v-else-if="entry.installState === 'incompatible'"
                  style="
                    font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
                    font-weight: 600;
                    color: var(--te-neutral-400);
                  "
                >
                  不兼容
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Scroll Area: Updates -->
        <div class="scroll-area" v-else-if="activeTab === 'updates'">
          <div class="page-title">
            可用更新
            <span
              v-if="updateEntries.length > 0"
              class="badge"
              style="background: var(--te-danger-soft-bg); color: var(--te-danger-soft-fg)"
              >{{ updateEntries.length }}</span
            >
          </div>

          <!-- Empty state -->
          <div
            v-if="updateEntries.length === 0"
            style="
              text-align: center;
              padding: 60px 20px;
              color: var(--te-neutral-400, #9ca3af);
              font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
            "
          >
            <i
              class="pi pi-check-circle"
              style="
                font-size: calc(var(--te-font-size-body, 14px) * 48 / 14);
                display: block;
                margin-bottom: 16px;
                opacity: 0.3;
              "
            ></i>
            所有插件均为最新版本
          </div>

          <template v-else>
            <div
              style="
                margin-bottom: 24px;
                padding: 16px;
                background: rgba(99, 102, 241, 0.05);
                border: 1px solid rgba(99, 102, 241, 0.1);
                border-radius: 16px;
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <div
                style="
                  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
                  font-weight: 600;
                  color: var(--te-primary-600);
                "
              >
                有 {{ updateEntries.length }} 个插件可以更新。
              </div>
              <button class="btn btn-primary" @click="updateAll">全部更新</button>
            </div>

            <div class="plugin-grid" style="grid-template-columns: 1fr">
              <div
                v-for="entry in updateEntries"
                :key="entry.id"
                class="plugin-card"
                style="
                  flex-direction: row;
                  align-items: center;
                  justify-content: space-between;
                  padding: 20px;
                "
              >
                <div class="plugin-card-header" style="align-items: center; margin-bottom: 0">
                  <div
                    class="plugin-icon"
                    :class="getIconInfo(entry.id, entry.type).cls"
                    :style="getIconInfo(entry.id, entry.type).style"
                    style="
                      width: 48px;
                      height: 48px;
                      font-size: calc(var(--te-font-size-body, 14px) * 20 / 14);
                    "
                  >
                    <i :class="getIconInfo(entry.id, entry.type).icon"></i>
                  </div>
                  <div class="plugin-info" style="margin-left: 16px">
                    <div class="plugin-title-row">
                      <div
                        class="plugin-name"
                        style="font-size: calc(var(--te-font-size-body, 14px) * 16 / 14)"
                      >
                        {{ entry.name }}
                      </div>
                    </div>
                    <div class="plugin-author">
                      {{ entry.installedVersion ? `v${entry.installedVersion}` : '未知版本' }}
                      <i
                        class="pi pi-arrow-right"
                        style="
                          font-size: calc(var(--te-font-size-body, 14px) * 10 / 14);
                          margin: 0 4px;
                        "
                      ></i>
                      <span style="color: var(--te-primary-600); font-weight: 600"
                        >v{{ entry.version }}</span
                      >
                    </div>
                  </div>
                </div>
                <div
                  style="
                    flex: 1;
                    margin: 0 32px;
                    font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
                    color: var(--te-neutral-500);
                  "
                >
                  {{ entry.description }}
                </div>
                <button
                  class="btn btn-primary"
                  style="padding: 6px 16px"
                  :disabled="busyIds.has(entry.id)"
                  @click="installFromIndex(entry)"
                >
                  <i v-if="busyIds.has(entry.id)" class="pi pi-spin pi-spinner"></i>
                  {{ busyIds.has(entry.id) ? '更新中' : '更新' }}
                </button>
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
  position: fixed;
  inset: 0;
  /* Above the sidebar (1000) and player bar (1002); below the title bar (9999). */
  z-index: 2000;
  /* Render the bottom-most global background on this overlay surface. */
  background-color: var(--te-app-bg);
  background-image: var(--te-app-bg-image);
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

.plugin-window {
  width: 100%;
  height: 100%;
  flex: 1;
  background: transparent;
  display: flex;
  overflow: hidden;
  position: relative;
}

/* Sidebar */
.sidebar {
  width: 240px;
  /* Frosted surface: the bottom-most global background shows through. */
  background: transparent;
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  border-right: 1px solid var(--te-border-color, #e5e7eb);
  display: flex;
  flex-direction: column;
}

.sidebar-header {
  padding: 56px 24px 24px 24px;
}

.sidebar-header h1 {
  font-size: calc(var(--te-font-size-body, 14px) * 18 / 14);
  font-weight: 700;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--te-neutral-900, #111827);
}

.sidebar-header h1 i,
.sidebar-header h1 .puzzle-icon {
  color: var(--te-neutral-900, #111827);
  font-size: calc(var(--te-font-size-body, 14px) * 20 / 14);
}

.nav-menu {
  flex: 1;
  padding: 0 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 12px;
  color: var(--te-neutral-600, #4b5563);
  cursor: pointer;
  transition:
    background-color 0.2s var(--te-ease-soft),
    color 0.2s var(--te-ease-soft);
  font-weight: 500;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
}

.nav-item i {
  font-size: calc(var(--te-font-size-body, 14px) * 18 / 14);
  opacity: 0.7;
}

.nav-item:hover {
  background: var(--te-bg-hover, #f3f4f6);
  color: var(--te-neutral-900, #111827);
}

.nav-item.active {
  background: rgba(99, 102, 241, 0.1);
  color: var(--te-primary-600, #6366f1);
}

.nav-item.active i {
  opacity: 1;
}

.sidebar-footer {
  padding: 20px 24px;
  border-top: 1px solid var(--te-border-color, #e5e7eb);
}

.dev-mode-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 500;
  color: var(--te-neutral-600, #4b5563);
}

.switch {
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
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.switch.on {
  background: var(--te-primary-600, #6366f1);
}

.switch.on::after {
  transform: translateX(16px);
}

/* Main Content */
.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #fafaf9; /* 极浅暖灰背景，区分侧边栏 */
}

.topbar {
  height: 104px;
  padding: 32px 32px 0 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 0;
  background: transparent;
  z-index: 10;
}

.search-box {
  display: flex;
  align-items: center;
  background: rgba(0, 0, 0, 0.04);
  border-radius: 100px;
  padding: 8px 16px;
  width: 300px;
  transition: background-color 0.2s var(--te-ease-soft);
}

.search-box:focus-within {
  background: var(--te-card-bg);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);
}

.search-box i {
  color: var(--te-neutral-400, #9ca3af);
  margin-right: 8px;
}

.search-box input {
  border: none;
  background: transparent;
  outline: none;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  width: 100%;
  color: var(--te-neutral-800, #1f2937);
}

.search-box input::placeholder {
  color: var(--te-neutral-400, #9ca3af);
}

.top-actions {
  display: flex;
  gap: 12px;
}

.btn {
  padding: 8px 16px;
  border-radius: 100px;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition:
    background-color 0.2s var(--te-ease-soft),
    border-color 0.2s var(--te-ease-soft),
    color 0.2s var(--te-ease-soft);
  border: none;
}

.btn-outline {
  background: transparent;
  border: 1px solid var(--te-border-color, #e5e7eb);
  color: var(--te-neutral-700, #374151);
}

.btn-outline:hover {
  background: var(--te-bg-hover, #f3f4f6);
}

.btn-primary {
  background: var(--te-primary-600, #6366f1);
  color: #fff;
}

.btn-primary:hover {
  background: var(--te-primary-500, #818cf8);
}

.scroll-area {
  flex: 1;
  overflow-y: auto;
  padding: 32px;
}

.page-title {
  font-size: calc(var(--te-font-size-body, 14px) * 24 / 14);
  font-weight: 700;
  color: var(--te-neutral-900, #111827);
  margin-bottom: 24px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.badge {
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 600;
  background: rgba(0, 0, 0, 0.06);
  color: var(--te-neutral-600, #4b5563);
  padding: 4px 10px;
  border-radius: 100px;
}

.plugin-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 20px;
}

.market-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: -16px 0 24px;
  color: var(--te-neutral-500, #6b7280);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 700;
}

.market-status span {
  max-width: 100%;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.04);
  padding: 6px 10px;
}

.market-status .warn {
  background: var(--te-warning-soft-bg, #fff7ed);
  color: #c2410c;
}

.market-status .source-url {
  min-width: 0;
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Cards */
.plugin-card {
  background: var(--te-bg-card, #fff);
  border-radius: 16px;
  padding: 24px;
  border: 1px solid var(--te-border-color, #e5e7eb);
  display: flex;
  flex-direction: column;
  position: relative;
  transition:
    transform 0.2s var(--te-ease-enter),
    border-color 0.2s var(--te-ease-enter);
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.02);
}

.plugin-card:hover {
  box-shadow: 0 10px 20px -5px rgba(0, 0, 0, 0.05);
  transform: translateY(-2px);
  border-color: rgba(99, 102, 241, 0.3);
}

.builtin-label {
  position: absolute;
  top: 16px;
  right: 16px;
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  font-weight: 600;
  color: var(--te-neutral-400, #9ca3af);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.plugin-card-header {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
}

.plugin-icon {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: calc(var(--te-font-size-body, 14px) * 24 / 14);
  flex-shrink: 0;
}

.plugin-icon.ncm {
  background: linear-gradient(135deg, #fee2e2, #fecaca);
  color: #ef4444;
}

.plugin-icon.provider {
  background: linear-gradient(135deg, #e0f2fe, #ccfbf1);
  color: #0891b2;
}

.plugin-icon.dsp {
  background: linear-gradient(135deg, #e0f2fe, #bae6fd);
  color: #0ea5e9;
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
}

.plugin-name {
  font-size: calc(var(--te-font-size-body, 14px) * 15 / 14);
  font-weight: 700;
  color: var(--te-neutral-900, #111827);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.plugin-version {
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  color: var(--te-neutral-400, #9ca3af);
  background: rgba(0, 0, 0, 0.04);
  padding: 2px 6px;
  border-radius: 6px;
}

.plugin-author {
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  color: var(--te-neutral-500, #6b7280);
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
}

.plugin-trust {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 700;
}

.plugin-trust-stack {
  display: grid;
  gap: 3px;
}

.signature-evidence {
  color: var(--te-neutral-400, #9ca3af);
  font-size: calc(var(--te-font-size-body, 14px) * 10 / 14);
  letter-spacing: 0;
}

.plugin-trust.trust-official {
  color: #4f46e5;
}

.plugin-trust.trust-signed {
  color: #047857;
}

.plugin-trust.trust-declared {
  color: #a16207;
}

.plugin-trust.trust-unverified {
  color: var(--te-neutral-400, #9ca3af);
}

.plugin-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.tag {
  font-size: calc(var(--te-font-size-body, 14px) * 10 / 14);
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
}

.tag.provider {
  background: rgba(99, 102, 241, 0.1);
  color: var(--te-primary-600, #6366f1);
}

.tag.ui {
  background: rgba(245, 158, 11, 0.1);
  color: #d97706;
}

.tag.dsp {
  background: rgba(14, 165, 233, 0.1);
  color: #0ea5e9;
}

.tag.tool {
  background: rgba(16, 185, 129, 0.1);
  color: #059669;
}

.plugin-desc {
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  color: var(--te-neutral-600, #4b5563);
  line-height: 1.5;
  flex: 1;
  margin-bottom: 20px;
}

.plugin-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid rgba(0, 0, 0, 0.04);
  padding-top: 16px;
}

.switch-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.switch-label {
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 600;
  color: var(--te-neutral-500, #6b7280);
}

.plugin-actions {
  display: flex;
  gap: 8px;
}

.icon-btn {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: none;
  background: rgba(0, 0, 0, 0.04);
  color: var(--te-neutral-600, #4b5563);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background-color 0.2s var(--te-ease-soft),
    color 0.2s var(--te-ease-soft);
}

.icon-btn:hover {
  background: rgba(0, 0, 0, 0.08);
  color: var(--te-neutral-900, #111827);
}

.icon-btn.danger:hover {
  background: var(--te-danger-soft-bg);
  color: var(--te-danger-soft-fg);
}

/* Discover Banner */
.discover-banner {
  background: linear-gradient(135deg, #4f46e5, #818cf8);
  border-radius: 20px;
  padding: 32px;
  color: #fff;
  display: flex;
  justify-content: space-between;
  align-items: center;
  position: relative;
  overflow: hidden;
  margin-bottom: 32px;
}

.banner-text h2 {
  margin: 0 0 8px 0;
  font-size: calc(var(--te-font-size-body, 14px) * 28 / 14);
  font-weight: 800;
}

.banner-text p {
  margin: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  opacity: 0.9;
  max-width: 300px;
  line-height: 1.5;
}

.banner-art {
  position: absolute;
  right: -20px;
  bottom: -40px;
  font-size: 180px;
  opacity: 0.1;
  transform: rotate(-15deg);
}
</style>
