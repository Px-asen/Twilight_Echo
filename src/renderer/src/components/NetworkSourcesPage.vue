<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useBackHandler } from '../app/useBackStack.ts'
import { usePlayerStore } from '../stores/usePlayerStore'
import type { Track } from '../types/music'
import type {
  NetworkEntry,
  NetworkPlaybackPlan,
  NetworkSourceProfileSummary
} from '../../../shared/networkSources.ts'
import NetworkCoverThumb from './network-sources/NetworkCoverThumb.vue'

const networkSourcesApi = window.api?.networkSources

const profiles = ref<NetworkSourceProfileSummary[]>([])
const loading = ref(false)
const error = ref('')
const notice = ref('')
const showCreateForm = ref(false)

const creating = ref(false)
const form = ref({
  protocol: 'webdav' as 'webdav' | 'ftp' | 'ftps',
  name: '',
  host: '',
  port: '',
  rootPath: '/',
  username: '',
  authKind: 'anonymous' as 'anonymous' | 'password' | 'privateKey',
  password: '',
  keyPath: '',
  passphrase: ''
})

const browsingProfile = ref<NetworkSourceProfileSummary | null>(null)
const currentPath = ref('/')
const entries = ref<NetworkEntry[]>([])
const browsing = ref(false)
const scanning = ref(false)
const browsingError = ref('')

const viewMode = ref<'profiles' | 'library'>('profiles')
const libraryQuery = ref('')
const libraryEntries = ref<Array<{ profileName: string; entry: NetworkEntry }>>([])
const libraryLoading = ref(false)
const enriching = ref(false)
const cacheSizeBytes = ref(0)

const breadcrumbs = computed(() => {
  const parts = currentPath.value.split('/').filter(Boolean)
  const crumbs: Array<{ label: string; path: string }> = [{ label: '根目录', path: '/' }]
  let acc = ''
  for (const part of parts) {
    acc += `/${part}`
    crumbs.push({ label: part, path: acc })
  }
  return crumbs
})

const audioEntries = computed(() => entries.value.filter((entry) => entry.kind === 'audio'))
const currentPathBookmarked = computed(
  () => browsingProfile.value?.bookmarks.includes(currentPath.value) ?? false
)

function setError(message: string): void {
  error.value = message
}

function setNotice(message: string): void {
  notice.value = message
  window.setTimeout(() => {
    if (notice.value === message) notice.value = ''
  }, 4000)
}

async function loadProfiles(): Promise<void> {
  if (!networkSourcesApi) return
  loading.value = true
  error.value = ''
  try {
    profiles.value = await networkSourcesApi.listProfiles()
  } catch (err) {
    setError(`读取网络源列表失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    loading.value = false
  }
}

async function createProfile(): Promise<void> {
  if (!networkSourcesApi) return
  creating.value = true
  error.value = ''
  try {
    const port = form.value.port.trim() ? Number(form.value.port) : null
    await networkSourcesApi.createProfile({
      protocol: form.value.protocol,
      name: form.value.name.trim(),
      host: form.value.host.trim(),
      port,
      rootPath: form.value.rootPath.trim() || '/',
      username: form.value.username.trim() || undefined,
      auth:
        form.value.authKind === 'password'
          ? { kind: 'password', password: form.value.password }
          : form.value.authKind === 'privateKey'
            ? {
                kind: 'privateKey',
                keyPath: form.value.keyPath.trim(),
                passphrase: form.value.passphrase || undefined
              }
            : { kind: 'anonymous' },
      keyPath: form.value.authKind === 'privateKey' ? form.value.keyPath.trim() : undefined
    })
    showCreateForm.value = false
    form.value = {
      protocol: 'webdav',
      name: '',
      host: '',
      port: '',
      rootPath: '/',
      username: '',
      authKind: 'anonymous',
      password: '',
      keyPath: '',
      passphrase: ''
    }
    await loadProfiles()
    setNotice('网络源已添加')
  } catch (err) {
    setError(`添加失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    creating.value = false
  }
}

async function deleteProfile(id: string): Promise<void> {
  if (!networkSourcesApi) return
  if (!window.confirm('确定删除该网络源吗？（不会删除远程文件）')) return
  try {
    await networkSourcesApi.deleteProfile(id)
    await loadProfiles()
    setNotice('已删除')
  } catch (err) {
    setError(`删除失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

async function testConnection(id: string): Promise<void> {
  if (!networkSourcesApi) return
  try {
    const result = await networkSourcesApi.testConnection(id)
    if (result.ok) {
      setNotice('连接成功')
    } else {
      setError(`连接失败：${result.errorCode ?? 'unknown'}`)
    }
  } catch (err) {
    setError(`连接测试失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

async function enterBrowse(profile: NetworkSourceProfileSummary): Promise<void> {
  browsingProfile.value = profile
  currentPath.value = profile.rootPath
  entries.value = []
  browsingError.value = ''
  await navigateTo(profile.rootPath)
}

async function navigateTo(path: string): Promise<void> {
  if (!networkSourcesApi || !browsingProfile.value) return
  browsing.value = true
  browsingError.value = ''
  try {
    currentPath.value = path
    entries.value = await networkSourcesApi.listDirectory(browsingProfile.value.id, path)
  } catch (err) {
    browsingError.value = `读取目录失败：${err instanceof Error ? err.message : String(err)}`
    entries.value = []
  } finally {
    browsing.value = false
  }
}

function leaveBrowse(): void {
  browsingProfile.value = null
  currentPath.value = '/'
  entries.value = []
  browsingError.value = ''
}

// 目录浏览是页面内部的一层：标题栏返回键先沿目录树逐级上行（和面包屑同一
// 规则），回到根路径后再返回才退出来源列表；页面层由 App.vue 注册。
function browseBack(): void {
  const profile = browsingProfile.value
  if (!profile) return
  const normalize = (path: string): string => {
    const trimmed = path.replace(/\/+$/, '')
    return trimmed === '' ? '/' : trimmed
  }
  const root = normalize(profile.rootPath || '/')
  const path = normalize(currentPath.value)
  if (path === root) {
    leaveBrowse()
    return
  }
  const parent = normalize(path.split('/').slice(0, -1).join('/'))
  // 不越过该来源的挂载根。
  const target = root !== '/' && parent !== root && !parent.startsWith(`${root}/`) ? root : parent
  void navigateTo(target)
}

useBackHandler(
  computed(() => browsingProfile.value !== null),
  browseBack,
  '返回来源列表'
)

function formatBytes(bytes: number | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value.toFixed(1)} ${unit}`
}

function formatSeconds(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return ''
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const remainder = total % 60
  return `${minutes}:${remainder.toString().padStart(2, '0')}`
}

function buildTrack(profileId: string, entry: NetworkEntry, plan: NetworkPlaybackPlan): Track {
  const extension = entry.name.includes('.') ? (entry.name.split('.').pop() ?? '') : ''
  return {
    id: entry.id,
    title: entry.name.replace(/\.[^.]+$/, ''),
    artist: browsingProfile.value?.name ?? '网络源',
    album: browsingProfile.value?.name ?? '网络源',
    filePath: plan.kind === 'direct-url' ? (plan.url ?? '') : (plan.cacheFilePath ?? ''),
    fileName: entry.name,
    duration: 0,
    size: entry.sizeBytes ?? 0,
    cover: null,
    lyrics: null,
    source: 'network',
    networkSource: { profileId, entry },
    format: extension
  }
}

async function resolvePlan(
  profileId: string,
  entry: NetworkEntry
): Promise<NetworkPlaybackPlan | null> {
  if (!networkSourcesApi) return null
  return networkSourcesApi.resolvePlayback(profileId, entry)
}

async function playEntry(entry: NetworkEntry): Promise<void> {
  const { playTrack } = usePlayerStore()
  const profileId = browsingProfile.value?.id ?? entry.profileId
  const plan = await resolvePlan(profileId, entry)
  if (!plan) return
  const track = buildTrack(profileId, entry, plan)
  playTrack(track, [track])
}

async function enqueueEntry(entry: NetworkEntry): Promise<void> {
  const { enqueueTrack } = usePlayerStore()
  const profileId = browsingProfile.value?.id ?? entry.profileId
  const plan = await resolvePlan(profileId, entry)
  if (!plan) return
  enqueueTrack(buildTrack(profileId, entry, plan))
}

async function playAllInDirectory(): Promise<void> {
  const { playTrack } = usePlayerStore()
  const profileId = browsingProfile.value?.id
  if (!profileId) return
  const tracks: Track[] = []
  browsing.value = true
  try {
    for (const entry of audioEntries.value) {
      const plan = await resolvePlan(profileId, entry)
      if (plan) tracks.push(buildTrack(profileId, entry, plan))
    }
  } catch (err) {
    setError(`解析播放失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    browsing.value = false
  }
  if (tracks.length > 0) {
    playTrack(tracks[0], tracks)
    setNotice(`开始播放 ${tracks.length} 首`)
  }
}

async function importCurrentDirectory(): Promise<void> {
  if (!networkSourcesApi || !browsingProfile.value) return
  scanning.value = true
  browsingError.value = ''
  try {
    const result = await networkSourcesApi.scanDirectory(
      browsingProfile.value.id,
      currentPath.value
    )
    setNotice(`入库完成：新增 ${result.added} 首，当前共 ${result.total} 首`)
  } catch (err) {
    browsingError.value = `入库失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    scanning.value = false
  }
}

async function loadLibrary(): Promise<void> {
  if (!networkSourcesApi) return
  libraryLoading.value = true
  error.value = ''
  try {
    const items: Array<{ profileName: string; entry: NetworkEntry }> = []
    for (const profile of profiles.value) {
      const entriesForProfile = await networkSourcesApi.listLibrary(profile.id, libraryQuery.value)
      for (const entry of entriesForProfile) {
        items.push({ profileName: profile.name, entry })
      }
    }
    libraryEntries.value = items
  } catch (err) {
    setError(`读取媒体库失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    libraryLoading.value = false
  }
}

async function removeLibraryEntry(entry: NetworkEntry): Promise<void> {
  if (!networkSourcesApi) return
  try {
    await networkSourcesApi.removeLibraryEntry(entry.profileId, entry.id)
    libraryEntries.value = libraryEntries.value.filter((item) => item.entry.id !== entry.id)
    setNotice('已从媒体库移除')
  } catch (err) {
    setError(`移除失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

async function enrichLibraryAll(): Promise<void> {
  if (!networkSourcesApi) return
  enriching.value = true
  error.value = ''
  try {
    let enriched = 0
    let failed = 0
    for (const profile of profiles.value) {
      const result = await networkSourcesApi.enrichLibrary(profile.id)
      enriched += result.enriched
      failed += result.failed
    }
    await loadLibrary()
    setNotice(`元数据解析完成：成功 ${enriched} 首，失败 ${failed} 首`)
  } catch (err) {
    setError(`元数据解析失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    enriching.value = false
  }
}

async function switchView(mode: 'profiles' | 'library'): Promise<void> {
  viewMode.value = mode
  if (mode === 'library') {
    if (profiles.value.length === 0) await loadProfiles()
    await loadLibrary()
  }
}

async function toggleBookmark(): Promise<void> {
  if (!networkSourcesApi || !browsingProfile.value) return
  const bookmarks = new Set(browsingProfile.value.bookmarks)
  if (bookmarks.has(currentPath.value)) {
    bookmarks.delete(currentPath.value)
  } else {
    bookmarks.add(currentPath.value)
  }
  try {
    const updated = await networkSourcesApi.updateProfile(browsingProfile.value.id, {
      bookmarks: [...bookmarks]
    })
    browsingProfile.value = updated
    setNotice(bookmarks.has(currentPath.value) ? '已收藏此目录' : '已取消收藏')
  } catch (err) {
    setError(`书签操作失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

async function removeBookmark(path: string): Promise<void> {
  if (!networkSourcesApi || !browsingProfile.value) return
  const bookmarks = browsingProfile.value.bookmarks.filter((item) => item !== path)
  try {
    browsingProfile.value = await networkSourcesApi.updateProfile(browsingProfile.value.id, {
      bookmarks
    })
  } catch (err) {
    setError(`移除书签失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

async function loadCacheInfo(): Promise<void> {
  if (!networkSourcesApi) return
  try {
    const info = await networkSourcesApi.cacheInfo()
    cacheSizeBytes.value = info.sizeBytes
  } catch {
    cacheSizeBytes.value = 0
  }
}

async function clearNetworkCache(): Promise<void> {
  if (!networkSourcesApi) return
  if (!window.confirm('确定清空网络源下载缓存吗？已入库条目不受影响，下次播放会重新下载。')) return
  try {
    await networkSourcesApi.clearCache()
    await loadCacheInfo()
    setNotice('网络源缓存已清空')
  } catch (err) {
    setError(`清理缓存失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

onMounted(() => {
  void loadProfiles()
  void loadCacheInfo()
})
</script>

<template>
  <div class="network-sources-page">
    <header class="network-page-heading">
      <div class="network-heading-copy">
        <span class="network-kicker">REMOTE MUSIC</span>
        <h1>网络源</h1>
        <p>连接 NAS 或远程服务器，将重点放在可播放的音乐和已连接来源上。</p>
      </div>
      <div class="network-view-toggle" role="tablist" aria-label="网络源视图">
        <button
          type="button"
          role="tab"
          :aria-selected="viewMode === 'profiles'"
          :class="{ active: viewMode === 'profiles' }"
          @click="switchView('profiles')"
        >
          <i class="pi pi-server"></i>网络源
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="viewMode === 'library'"
          :class="{ active: viewMode === 'library' }"
          @click="switchView('library')"
        >
          <i class="pi pi-book"></i>媒体库
        </button>
      </div>
    </header>

    <div v-if="error" class="network-inline-error" role="alert">{{ error }}</div>
    <div v-if="notice" class="network-inline-notice" role="status">{{ notice }}</div>

    <section
      v-if="browsingProfile"
      class="network-browser network-surface"
      aria-labelledby="network-browser-title"
    >
      <div class="network-browser-context">
        <div>
          <span class="network-kicker">CONNECTED SOURCE</span>
          <h2 id="network-browser-title">{{ browsingProfile.name }}</h2>
          <p>
            {{ browsingProfile.protocol.toUpperCase() }} · {{ browsingProfile.host
            }}{{ browsingProfile.port ? `:${browsingProfile.port}` : '' }}
          </p>
        </div>
        <button type="button" class="soft-button" @click="leaveBrowse">
          <i class="pi pi-arrow-left"></i>返回来源列表
        </button>
      </div>

      <nav class="network-breadcrumbs" aria-label="目录">
        <span class="network-subheading">当前位置</span>
        <div class="network-crumb-list">
          <button
            v-for="crumb in breadcrumbs"
            :key="crumb.path"
            type="button"
            class="network-crumb"
            :class="{ active: crumb.path === currentPath }"
            @click="navigateTo(crumb.path)"
          >
            {{ crumb.label }}
          </button>
        </div>
      </nav>

      <div class="network-bookmarks">
        <div class="bookmark-heading">
          <span class="network-subheading">收藏目录</span>
          <button type="button" class="soft-button" @click="toggleBookmark">
            <i :class="currentPathBookmarked ? 'pi pi-bookmark-fill' : 'pi pi-bookmark'"></i
            >{{ currentPathBookmarked ? '取消收藏' : '收藏此目录' }}
          </button>
        </div>
        <div v-if="browsingProfile.bookmarks.length > 0" class="network-bookmark-list">
          <button
            v-for="bookmark in browsingProfile.bookmarks"
            :key="bookmark"
            type="button"
            class="network-bookmark-chip"
            @click="navigateTo(bookmark)"
          >
            <span>{{ bookmark }}</span
            ><i
              class="pi pi-times"
              role="button"
              aria-label="移除书签"
              data-te-interactive
              @click.stop="removeBookmark(bookmark)"
            ></i>
          </button>
        </div>
      </div>

      <div class="network-directory-actions">
        <div>
          <span class="network-subheading">目录操作</span>
          <p>{{ audioEntries.length }} 首可播放音频</p>
        </div>
        <div class="network-browser-toolbar">
          <button
            type="button"
            class="brand-soft-button"
            :disabled="audioEntries.length === 0 || browsing"
            @click="playAllInDirectory"
          >
            <i class="pi pi-play"></i>播放全部（{{ audioEntries.length }}）
          </button>
          <button
            type="button"
            class="soft-button"
            :disabled="scanning"
            @click="importCurrentDirectory"
          >
            <i class="pi pi-database"></i>{{ scanning ? '入库中…' : '入库此目录' }}
          </button>
        </div>
      </div>
      <p v-if="browsing" class="network-browsing" aria-live="polite">正在读取目录…</p>
      <div v-if="browsingError" class="network-inline-error" role="alert">{{ browsingError }}</div>
      <ul v-if="entries.length > 0" class="network-entry-list network-entry-surface">
        <li v-for="entry in entries" :key="entry.id" class="network-entry">
          <span class="network-entry-kind"
            ><i
              class="pi"
              :class="
                entry.kind === 'directory'
                  ? 'pi-folder'
                  : entry.kind === 'audio'
                    ? 'pi-music'
                    : 'pi-file'
              "
            ></i
          ></span>
          <button
            type="button"
            class="network-entry-name"
            :class="{ directory: entry.kind === 'directory' }"
            @click="entry.kind === 'directory' ? navigateTo(entry.path) : playEntry(entry)"
          >
            {{ entry.name }}
          </button>
          <span class="network-entry-meta">{{ formatBytes(entry.sizeBytes) }}</span>
          <span v-if="entry.kind === 'audio'" class="network-entry-actions"
            ><button type="button" class="pill-action" @click="playEntry(entry)">播放</button
            ><button type="button" class="pill-action" @click="enqueueEntry(entry)">
              加队列
            </button></span
          >
        </li>
      </ul>
      <p v-else-if="!browsing && !browsingError" class="network-empty">该目录为空</p>
    </section>

    <section
      v-else-if="viewMode === 'library'"
      class="network-library network-surface"
      aria-labelledby="network-library-title"
    >
      <div class="network-section-heading network-library-heading">
        <div>
          <span class="network-kicker">NETWORK LIBRARY</span>
          <h2 id="network-library-title">网络媒体库</h2>
          <p>从已入库的远程音乐中搜索并直接播放。</p>
        </div>
        <button
          type="button"
          class="soft-button"
          :disabled="enriching || libraryLoading"
          @click="enrichLibraryAll"
        >
          <i class="pi pi-sparkles"></i>{{ enriching ? '解析中…' : '解析元数据' }}
        </button>
      </div>
      <label class="network-library-search"
        ><i class="pi pi-search"></i
        ><input
          v-model="libraryQuery"
          type="search"
          class="network-search-input"
          placeholder="搜索歌曲、艺人或来源…"
          @input="loadLibrary"
        /><span v-if="libraryLoading" class="network-browsing" aria-live="polite"
          >加载中…</span
        ></label
      >
      <ul v-if="libraryEntries.length > 0" class="network-entry-list network-entry-surface">
        <li
          v-for="item in libraryEntries"
          :key="item.entry.id"
          class="network-entry network-entry-cover"
        >
          <NetworkCoverThumb :profile-id="item.entry.profileId" :entry-id="item.entry.id" />
          <button type="button" class="network-entry-name" @click="playEntry(item.entry)">
            {{ item.entry.metadata?.title ?? item.entry.name }}
          </button>
          <span class="network-entry-meta">{{
            [
              item.entry.metadata?.artist,
              formatSeconds(item.entry.metadata?.duration),
              item.profileName
            ]
              .filter(Boolean)
              .join(' · ')
          }}</span>
          <span class="network-entry-actions"
            ><button type="button" class="pill-action" @click="playEntry(item.entry)">播放</button
            ><button type="button" class="pill-action" @click="enqueueEntry(item.entry)">
              加队列</button
            ><button
              type="button"
              class="pill-action pill-action-danger"
              @click="removeLibraryEntry(item.entry)"
            >
              移除
            </button></span
          >
        </li>
      </ul>
      <div v-else-if="!libraryLoading" class="network-empty network-library-empty">
        <span class="network-empty-icon"><i class="pi pi-book"></i></span>
        <h3>媒体库还是空的</h3>
        <p>在“网络源”中浏览一个目录，再使用“入库此目录”把音乐带到这里。</p>
      </div>
    </section>

    <section v-else class="network-profiles" aria-labelledby="network-profiles-title">
      <div class="network-section-heading network-profiles-heading">
        <div>
          <span class="network-kicker">CONNECTED SOURCES</span>
          <h2 id="network-profiles-title">已连接的来源</h2>
          <p>选择一个来源浏览音乐；连接与缓存维护被收纳为次要操作。</p>
        </div>
        <button type="button" class="brand-soft-button" @click="showCreateForm = !showCreateForm">
          <i :class="showCreateForm ? 'pi pi-minus' : 'pi pi-plus'"></i
          >{{ showCreateForm ? '收起表单' : '添加网络源' }}
        </button>
      </div>
      <div class="network-cache-row">
        <span><i class="pi pi-database"></i>网络源缓存 {{ formatBytes(cacheSizeBytes) }}</span
        ><button type="button" class="text-button" @click="clearNetworkCache">清理缓存</button>
      </div>

      <Transition name="network-form">
        <form v-if="showCreateForm" class="network-create-form" @submit.prevent="createProfile">
          <div class="network-form-heading">
            <span class="network-subheading">添加网络源</span>
            <p>填写连接信息后保存并测试；凭据仅用于该来源连接。</p>
          </div>
          <div class="network-form-grid">
            <label
              >名称<input
                v-model.trim="form.name"
                type="text"
                required
                maxlength="64"
                placeholder="我的 NAS"
            /></label>
            <label
              >协议<select v-model="form.protocol">
                <option value="webdav">WebDAV</option>
                <option value="ftp">FTP</option>
                <option value="ftps">FTPS（显式 TLS）</option>
                <option value="sftp">SFTP</option>
                <option value="scp">SCP（SFTP 传输）</option>
                <option value="smb">SMB（系统挂载）</option>
                <option value="dlna">DLNA（媒体服务器浏览）</option>
                <option value="nfs">NFS（Linux，需 root）</option>
              </select></label
            >
            <label
              >地址<input
                v-model.trim="form.host"
                type="text"
                required
                maxlength="253"
                placeholder="nas.local 或 192.168.1.10"
            /></label>
            <label
              >端口（可选）<input
                v-model.trim="form.port"
                type="number"
                min="1"
                max="65535"
                placeholder="默认 80/443"
            /></label>
            <label
              >根路径<input v-model.trim="form.rootPath" type="text" required placeholder="/music"
            /></label>
            <label
              >认证方式<select v-model="form.authKind">
                <option value="anonymous">匿名</option>
                <option value="password">用户名 + 密码</option>
                <option value="privateKey">SSH 私钥</option>
              </select></label
            >
            <label v-if="form.authKind === 'password'"
              >用户名<input v-model.trim="form.username" type="text" autocomplete="username"
            /></label>
            <label v-if="form.authKind === 'password'"
              >密码<input v-model="form.password" type="password" autocomplete="current-password"
            /></label>
            <label v-if="form.authKind === 'privateKey'"
              >私钥路径<input
                v-model.trim="form.keyPath"
                type="text"
                placeholder="C:\Users\me\.ssh\id_ed25519"
            /></label>
            <label v-if="form.authKind === 'privateKey'"
              >私钥口令（可选，仅支持 ssh-agent / 无口令密钥）<input
                v-model="form.passphrase"
                type="password"
                autocomplete="off"
            /></label>
          </div>
          <div class="network-form-actions">
            <button type="submit" class="brand-soft-button" :disabled="creating || loading">
              <i class="pi pi-check"></i>{{ creating ? '保存中…' : '保存并测试' }}
            </button>
          </div>
        </form>
      </Transition>

      <div v-if="loading" class="network-loading">加载中…</div>
      <div v-else-if="profiles.length > 0" class="network-profile-list">
        <article v-for="profile in profiles" :key="profile.id" class="network-profile-card">
          <div class="network-profile-icon"><i class="pi pi-server"></i></div>
          <div class="network-profile-info">
            <div class="network-profile-title-row">
              <strong>{{ profile.name }}</strong
              ><span class="network-protocol">{{ profile.protocol.toUpperCase() }}</span>
            </div>
            <span>{{ profile.host }}{{ profile.port ? `:${profile.port}` : '' }}</span
            ><small
              >{{ profile.rootPath }} ·
              {{ profile.credentialKind === 'anonymous' ? '匿名' : '需认证' }}</small
            >
          </div>
          <div class="network-profile-actions">
            <button type="button" class="brand-soft-button" @click="enterBrowse(profile)">
              <i class="pi pi-folder-open"></i>浏览</button
            ><button type="button" class="soft-button" @click="testConnection(profile.id)">
              测试</button
            ><button type="button" class="text-button danger" @click="deleteProfile(profile.id)">
              删除
            </button>
          </div>
        </article>
      </div>
      <div v-else class="network-empty network-profiles-empty">
        <span class="network-empty-icon"><i class="pi pi-server"></i></span>
        <h3>还没有网络源</h3>
        <p>添加你的 NAS、WebDAV 或其他远程音乐服务，然后开始浏览。</p>
        <button type="button" class="brand-soft-button" @click="showCreateForm = true">
          <i class="pi pi-plus"></i>添加网络源
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.network-form-enter-active,
.network-form-leave-active {
  transition:
    opacity var(--te-motion-hover) var(--te-ease-soft),
    transform var(--te-motion-hover) var(--te-ease-soft);
}

.network-form-enter-from,
.network-form-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.network-form-leave-active {
  pointer-events: none;
}

html[data-te-motion='reduced'] .network-create-form {
  transform: none !important;
  transition: opacity 120ms var(--te-ease-soft) !important;
}

html[data-te-motion='off'] .network-create-form {
  opacity: 1 !important;
  transform: none !important;
}

.network-sources-page {
  box-sizing: border-box;
  width: 100%;
  min-height: 100vh;
  padding: 52px clamp(24px, 5vw, 72px) 132px;
  color: var(--te-text, #0f172a);
}
.network-page-heading,
.network-sources-page > section,
.network-inline-error,
.network-inline-notice {
  width: min(100%, 1180px);
  margin-inline: auto;
}
.network-page-heading {
  display: grid;
  position: relative;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 20px;
  align-items: center;
  margin-bottom: 28px;
}
.network-heading-copy h1,
.network-section-heading h2,
.network-browser-context h2,
.network-empty h3 {
  margin: 0;
  color: inherit;
  letter-spacing: -0.025em;
}
.network-heading-copy h1 {
  font-size: clamp(25px, 3vw, 33px);
}
.network-heading-copy p,
.network-section-heading p,
.network-browser-context p,
.network-directory-actions p,
.network-form-heading p,
.network-empty p {
  margin: 5px 0 0;
  color: var(--te-settings-text-muted);
  font-size: 13px;
  line-height: 1.55;
}
.network-kicker,
.network-subheading {
  display: block;
  color: var(--te-primary-500, var(--brand-600));
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.12em;
}
.network-view-toggle button,
.network-browser button,
.network-profiles button,
.network-library button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
}
.network-view-toggle {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.09));
  border-radius: 12px;
  background: color-mix(in srgb, var(--te-card-bg, #fff) 74%, transparent);
}
.network-view-toggle button {
  min-height: 34px;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 0 11px;
  background: transparent;
  color: var(--te-settings-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
}
.network-view-toggle button.active {
  border-color: color-mix(in srgb, var(--te-primary-500) 24%, transparent);
  background: color-mix(in srgb, var(--te-primary-500) 12%, transparent);
  color: var(--te-primary-500, var(--brand-600));
}
.network-inline-error,
.network-inline-notice {
  box-sizing: border-box;
  margin-bottom: 14px;
  border-radius: 12px;
  padding: 10px 13px;
  font-size: 13px;
  font-weight: 650;
}
.network-inline-error {
  border: 1px solid color-mix(in srgb, var(--te-danger-soft-fg) 28%, transparent);
  background: var(--te-danger-soft-bg);
  color: var(--te-danger-soft-fg);
}
.network-inline-notice {
  border: 1px solid color-mix(in srgb, var(--te-success-soft-fg) 28%, transparent);
  background: var(--te-success-soft-bg);
  color: var(--te-success-soft-fg);
}
.network-browser,
.network-library,
.network-profiles {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.network-surface {
  min-height: 500px;
  border: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.09));
  border-radius: 20px;
  padding: clamp(18px, 3vw, 30px);
  background: color-mix(in srgb, var(--te-card-bg, #fff) 76%, transparent);
}
.network-browser-context,
.network-section-heading,
.network-directory-actions,
.network-cache-row,
.network-profile-card,
.network-profile-actions,
.network-browser-toolbar,
.bookmark-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
.network-browser-context {
  align-items: flex-start;
}
.network-browser-context h2,
.network-section-heading h2 {
  margin-top: 5px;
  font-size: 22px;
}
.network-breadcrumbs,
.network-bookmarks {
  display: grid;
  gap: 8px;
  padding: 13px 0;
  border-top: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.08));
}
.network-crumb-list,
.network-bookmark-list {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.network-crumb,
.network-bookmark-chip {
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 5px 10px;
  background: color-mix(in srgb, var(--te-settings-control-bg, #fff) 74%, transparent);
  color: var(--te-settings-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 650;
}
.network-crumb:hover,
.network-crumb.active,
.network-bookmark-chip:hover {
  border-color: color-mix(in srgb, var(--te-primary-500) 30%, transparent);
  color: var(--te-primary-500, var(--brand-600));
}
.network-bookmark-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
}
.network-bookmark-chip span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.network-bookmark-chip i {
  font-size: 10px;
}
.network-directory-actions {
  align-items: flex-end;
  padding: 15px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--te-primary-500) 7%, transparent);
}
.network-directory-actions p {
  margin-top: 3px;
}
.network-browser-toolbar {
  flex-wrap: wrap;
}
.network-browsing {
  margin: -8px 0 0;
  color: var(--te-settings-text-muted);
  font-size: 12px;
}
.network-entry-surface {
  border: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.09));
  border-radius: 14px;
  overflow: hidden;
}
.network-entry-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.network-entry {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) minmax(92px, auto) auto;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 5px 12px;
  border-bottom: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.07));
}
.network-entry:last-child {
  border-bottom: 0;
}
.network-entry:hover {
  background: color-mix(in srgb, var(--te-primary-500) 5%, transparent);
}
.network-entry-cover {
  grid-template-columns: 36px minmax(0, 1fr) minmax(120px, auto) auto;
}
.network-entry-kind {
  color: var(--te-primary-500, var(--brand-600));
  text-align: center;
}
.network-entry-name {
  overflow: hidden;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-weight: 600;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.network-entry-name.directory {
  font-weight: 750;
}
.network-entry-meta {
  overflow: hidden;
  color: var(--te-settings-text-muted);
  font-size: 12px;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.network-entry-actions {
  display: flex;
  gap: 6px;
}
.pill-action {
  min-height: 30px;
  border: 1px solid var(--te-settings-control-border);
  border-radius: 8px;
  padding: 0 9px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.pill-action:hover {
  border-color: color-mix(in srgb, var(--te-primary-500) 36%, transparent);
  color: var(--te-primary-500, var(--brand-600));
}
.pill-action-danger:hover {
  border-color: color-mix(in srgb, var(--te-danger-soft-fg) 36%, transparent);
  color: var(--te-danger-soft-fg);
}
.network-library-heading {
  margin-bottom: 3px;
}
.network-library-search {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--te-settings-control-border);
  border-radius: 12px;
  padding: 0 12px;
  background: var(--te-settings-control-bg, rgba(255, 255, 255, 0.8));
}
.network-library-search > i {
  color: var(--te-settings-text-muted);
}
.network-search-input {
  min-width: 0;
  width: 100%;
  min-height: 44px;
  border: 0;
  outline: 0;
  background: transparent;
  color: inherit;
  font: inherit;
}
.network-profiles-heading {
  margin-bottom: -2px;
}
.network-cache-row {
  min-height: 38px;
  border-radius: 11px;
  padding: 0 12px;
  background: color-mix(in srgb, var(--te-card-bg, #fff) 64%, transparent);
  color: var(--te-settings-text-muted);
  font-size: 12px;
}
.network-cache-row span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.text-button {
  border: 0;
  padding: 4px;
  background: transparent;
  color: var(--te-settings-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
}
.text-button:hover {
  color: var(--te-primary-500, var(--brand-600));
}
.text-button.danger:hover {
  color: var(--te-danger-soft-fg);
}
.network-create-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  border: 1px solid
    color-mix(in srgb, var(--te-primary-500) 22%, var(--te-card-border, transparent));
  border-radius: 16px;
  padding: clamp(16px, 2vw, 22px);
  background: color-mix(in srgb, var(--te-primary-500) 5%, var(--te-card-bg, #fff));
}
.network-form-heading p {
  margin-top: 3px;
}
.network-form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(205px, 1fr));
  gap: 12px;
}
.network-form-grid label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--te-settings-text-muted);
  font-size: 12px;
  font-weight: 700;
}
.network-form-grid input,
.network-form-grid select {
  min-height: 38px;
  box-sizing: border-box;
  border: 1px solid var(--te-settings-control-border);
  border-radius: 9px;
  padding: 0 10px;
  background: var(--te-settings-control-bg, transparent);
  color: inherit;
  font: inherit;
}
.network-form-grid input:focus,
.network-form-grid select:focus {
  border-color: color-mix(in srgb, var(--te-primary-500) 56%, transparent);
  outline: 3px solid color-mix(in srgb, var(--te-primary-500) 12%, transparent);
}
.network-form-actions {
  display: flex;
  justify-content: flex-end;
}
.network-profile-list {
  display: grid;
  gap: 10px;
}
.network-profile-card {
  min-height: 82px;
  border: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.09));
  border-radius: 15px;
  padding: 13px 15px;
  background: color-mix(in srgb, var(--te-card-bg, #fff) 75%, transparent);
  transition:
    transform 0.18s var(--te-ease-soft),
    border-color 0.18s ease;
}
.network-profile-card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--te-primary-500) 30%, transparent);
}
.network-profile-icon {
  display: grid;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 10px;
  background: color-mix(in srgb, var(--te-primary-500) 11%, transparent);
  color: var(--te-primary-500, var(--brand-600));
}
.network-profile-info {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}
.network-profile-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.network-profile-info strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.network-profile-info > span,
.network-profile-info small {
  overflow: hidden;
  color: var(--te-settings-text-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.network-protocol {
  border-radius: 999px;
  padding: 2px 6px;
  background: color-mix(in srgb, var(--te-primary-500) 9%, transparent);
  color: var(--te-primary-500, var(--brand-600));
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.04em;
}
.network-profile-actions {
  flex: 0 0 auto;
}
.network-empty {
  display: grid;
  min-height: 212px;
  place-items: center;
  align-content: center;
  gap: 8px;
  padding: 22px;
  color: var(--te-settings-text-muted);
  text-align: center;
}
.network-empty h3 {
  color: inherit;
  font-size: 16px;
}
.network-empty p {
  max-width: 430px;
  margin: 0;
}
.network-empty-icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 13px;
  background: color-mix(in srgb, var(--te-primary-500) 10%, transparent);
  color: var(--te-primary-500, var(--brand-600));
  font-size: 18px;
}
.network-profiles-empty {
  min-height: 260px;
  border: 1px dashed
    color-mix(in srgb, var(--te-primary-500) 28%, var(--te-card-border, transparent));
  border-radius: 18px;
}
.network-loading {
  padding: 30px;
  color: var(--te-settings-text-muted);
  text-align: center;
}
@media (max-width: 760px) {
  .network-sources-page {
    padding: 30px 16px 118px;
  }
  .network-page-heading {
    grid-template-columns: auto minmax(0, 1fr);
    gap: 12px;
    padding: 52px 0 0;
  }
  .network-heading-copy {
    grid-column: 1 / -1;
    grid-row: 2;
  }
  .network-view-toggle {
    grid-column: 1 / -1;
    width: fit-content;
  }
  .network-browser-context,
  .network-section-heading,
  .network-directory-actions,
  .network-profile-card {
    align-items: flex-start;
    flex-direction: column;
  }
  .network-profile-card {
    gap: 10px;
  }
  .network-profile-actions {
    width: 100%;
    justify-content: flex-start;
  }
  .network-entry,
  .network-entry-cover {
    grid-template-columns: 24px minmax(0, 1fr) auto;
  }
  .network-entry-meta {
    display: none;
  }
  .network-entry-actions {
    grid-column: 2 / -1;
    margin-bottom: 5px;
  }
}
@media (max-width: 460px) {
  .network-heading-copy h1 {
    font-size: 25px;
  }
  .network-view-toggle {
    width: 100%;
  }
  .network-view-toggle button {
    flex: 1;
  }
  .network-surface {
    padding: 16px;
    border-radius: 16px;
  }
  .network-browser-toolbar,
  .network-profile-actions {
    width: 100%;
  }
  .network-browser-toolbar > button,
  .network-profile-actions > button {
    flex: 1;
  }
}
</style>
