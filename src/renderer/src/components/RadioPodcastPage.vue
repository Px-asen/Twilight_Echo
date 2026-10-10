<script setup lang="ts">
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRadioStore, radioStationToTrack } from '../stores/useRadioStore'
import { usePodcastStore, podcastEpisodeToTrack } from '../stores/usePodcastStore'
import { usePlayerStore } from '../stores/usePlayerStore'
import { isInsecureHttpUrl } from '../../../shared/radioStations.ts'
import type { PodcastSubscription } from '../../../shared/podcastSubscriptions.ts'
import { useAppNoticeStore } from '../stores/useAppNoticeStore'

const radio = useRadioStore()
const podcast = usePodcastStore()
const { playTrack, playTrackFromPosition } = usePlayerStore()
const { pushNotice } = useAppNoticeStore()
const removingSubscriptions = ref(new Set<string>())

const tab = ref<'radio' | 'podcast'>('radio')
const stationName = ref('')
const stationUrl = ref('')
const allowHttp = ref(false)
const formError = ref('')
const formBusy = ref(false)
const playlistText = ref('')
const directoryQuery = ref('')
const directoryResults = ref<
  Array<{
    stationuuid: string
    name: string
    url: string
    urlResolved: string
    homepage?: string
    favicon?: string
    tags: string[]
    countryCode?: string
    bitrate?: number
    codec?: string
  }>
>([])
const directoryBusy = ref(false)
const directoryError = ref('')
let directoryRequest = 0
function invalidateDirectorySearch(): void {
  directoryRequest++
  directoryBusy.value = false
}
watch([directoryQuery, tab], invalidateDirectorySearch, { flush: 'sync' })
watch(tab, () => {
  formError.value = ''
})
watch(
  directoryQuery,
  () => {
    directoryResults.value = []
    directoryError.value = ''
  },
  { flush: 'sync' }
)
const feedUrl = ref('')
const selectedPodcastId = ref<string | null>(null)
const pageError = computed(
  () =>
    formError.value ||
    (tab.value === 'radio' ? directoryError.value || radio.error.value : podcast.error.value)
)

const selectedPodcast = computed<PodcastSubscription | null>(() => {
  if (!selectedPodcastId.value) return null
  return podcast.subscriptions.value.find((sub) => sub.id === selectedPodcastId.value) ?? null
})

onMounted(() => {
  window.addEventListener('pagehide', invalidateDirectorySearch)
  void radio.ensureLoaded()
  void podcast.ensureLoaded()
})
onBeforeUnmount(() => {
  invalidateDirectorySearch()
  window.removeEventListener('pagehide', invalidateDirectorySearch)
})

async function runFormAction(action: () => Promise<void>): Promise<void> {
  if (formBusy.value) return
  const actionTab = tab.value
  formError.value = ''
  formBusy.value = true
  try {
    await action()
  } catch (error) {
    if (tab.value === actionTab) {
      formError.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    formBusy.value = false
  }
}

function addStation(): Promise<void> {
  return runFormAction(async () => {
    if (!stationName.value.trim() || !stationUrl.value.trim()) {
      throw new Error('请填写电台名称和流地址')
    }
    const url = stationUrl.value.trim()
    if (isInsecureHttpUrl(url) && !allowHttp.value) {
      throw new Error('该电台使用 HTTP 明文流，请勾选“允许 HTTP”后再添加')
    }
    await radio.addStation({
      name: stationName.value,
      streamUrl: url,
      allowInsecureHttp: allowHttp.value
    })
    stationName.value = ''
    stationUrl.value = ''
    allowHttp.value = false
  })
}

function importPlaylist(): Promise<void> {
  return runFormAction(async () => {
    const count = await radio.importPlaylistText(playlistText.value, {
      fileNameHint: 'import.m3u',
      allowInsecureHttp: allowHttp.value
    })
    playlistText.value = ''
    if (count === 0 && tab.value === 'radio') {
      formError.value = '没有新增电台：条目可能已收藏、地址无效或未允许 HTTP'
    }
  })
}

async function searchDirectory(): Promise<void> {
  const query = directoryQuery.value.trim()
  const request = ++directoryRequest
  directoryError.value = ''
  if (!query || tab.value !== 'radio') {
    directoryResults.value = []
    directoryBusy.value = false
    return
  }
  directoryBusy.value = true
  try {
    const results = await radio.searchDirectory(query, { limit: 20 })
    if (request !== directoryRequest) return
    directoryResults.value = results
    if (directoryResults.value.length === 0) {
      directoryError.value = '未找到匹配电台'
    }
  } catch (error) {
    if (request !== directoryRequest) return
    directoryResults.value = []
    directoryError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (request === directoryRequest) directoryBusy.value = false
  }
}

function addDirectoryStation(row: {
  name: string
  urlResolved: string
  homepage?: string
  tags: string[]
}): Promise<void> {
  return runFormAction(async () => {
    const streamUrl = row.urlResolved
    if (isInsecureHttpUrl(streamUrl) && !allowHttp.value) {
      throw new Error('该目录电台使用 HTTP 明文流，请勾选“允许 HTTP”后再添加')
    }
    await radio.addStation({
      name: row.name,
      streamUrl,
      homepage: row.homepage,
      tags: row.tags,
      allowInsecureHttp: allowHttp.value
    })
  })
}

function playStation(id: string): void {
  const station = radio.stations.value.find((item) => item.id === id)
  if (!station) return
  playTrack(radioStationToTrack(station), [radioStationToTrack(station)])
}

function removeStation(id: string): Promise<void> {
  return runFormAction(() => radio.removeStation(id))
}

function subscribeFeed(): Promise<void> {
  return runFormAction(async () => {
    if (!feedUrl.value.trim()) {
      throw new Error('请输入 RSS 或 Atom 订阅地址')
    }
    const sub = await podcast.subscribe(feedUrl.value)
    feedUrl.value = ''
    selectedPodcastId.value = sub.id
  })
}

function refreshSelected(): Promise<void> | undefined {
  if (!selectedPodcastId.value) return
  const id = selectedPodcastId.value
  return runFormAction(() => podcast.refresh(id))
}

async function unsubscribePodcast(id: string): Promise<void> {
  if (removingSubscriptions.value.has(id)) return
  removingSubscriptions.value.add(id)
  try {
    const removed = await podcast.unsubscribe(id)
    if (!removed) return
    if (selectedPodcastId.value === id) selectedPodcastId.value = null
    let restoring = false
    let restored = false
    const dedupeKey = `podcast-unsubscribe:${id}`
    const restore = async (): Promise<void> => {
      if (restoring || restored) return
      restoring = true
      try {
        await podcast.restoreSubscription(removed)
        restored = true
        pushNotice({
          kind: 'success',
          message: `已恢复订阅「${removed.title}」及收听进度`,
          dedupeKey,
          sticky: false
        })
      } catch (error) {
        pushNotice({
          kind: 'error',
          message: `恢复订阅失败：${error instanceof Error ? error.message : String(error)}`,
          action: { label: '重试恢复', run: restore }
        })
      } finally {
        restoring = false
      }
    }
    pushNotice({
      message: `已取消订阅「${removed.title}」，可在本次使用的通知记录中撤销并恢复收听进度。`,
      dedupeKey,
      action: { label: '撤销取消订阅', run: restore }
    })
  } catch (error) {
    pushNotice({
      kind: 'error',
      message: `取消订阅失败：${error instanceof Error ? error.message : String(error)}`
    })
  } finally {
    removingSubscriptions.value.delete(id)
  }
}

function playEpisode(subscription: PodcastSubscription, guid: string): void {
  const episode = subscription.episodes.find((item) => item.guid === guid)
  if (!episode) return
  const track = podcastEpisodeToTrack(subscription, episode)
  const list = subscription.episodes.map((item) => podcastEpisodeToTrack(subscription, item))
  const progress = episode.progressSeconds ?? 0
  const duration = episode.durationSeconds || 0
  // Resume when progress is meaningful and not essentially finished.
  const nearEnd = duration > 0 && progress >= duration * 0.95
  if (progress >= 5 && !nearEnd) {
    playTrackFromPosition(track, progress, list)
    return
  }
  playTrack(track, list)
}

function progressLabel(episode: { durationSeconds: number; progressSeconds?: number }): string {
  const ratio = podcast.podcastEpisodeProgressRatio({
    guid: '',
    title: '',
    mediaUrl: 'https://example.test/a.mp3',
    durationSeconds: episode.durationSeconds,
    progressSeconds: episode.progressSeconds
  })
  if (ratio === null) return ''
  if (ratio <= 0) return ''
  if (ratio >= 0.95) return '已听完'
  return `进度 ${Math.round(ratio * 100)}%`
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
</script>

<template>
  <div class="radio-podcast-page">
    <header class="page-header">
      <div class="page-heading">
        <span class="page-kicker">ONLINE LISTENING</span>
        <h1>电台与播客</h1>
      </div>
      <div class="tabs" role="tablist" aria-label="在线音频类型">
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'radio'"
          :class="{ active: tab === 'radio' }"
          @click="tab = 'radio'"
        >
          <i class="pi pi-broadcast"></i>
          电台
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'podcast'"
          :class="{ active: tab === 'podcast' }"
          @click="tab = 'podcast'"
        >
          <i class="pi pi-microphone"></i>
          播客
        </button>
      </div>
    </header>

    <p v-if="pageError" class="page-error" role="alert">{{ pageError }}</p>

    <section v-if="tab === 'radio'" class="radio-workspace">
      <aside class="radio-tools" aria-label="电台工具">
        <section class="tool-card">
          <div class="card-heading">
            <span class="card-icon"><i class="pi pi-plus"></i></span>
            <div>
              <h2>添加电台</h2>
            </div>
          </div>
          <label>
            电台名称
            <input
              v-model="stationName"
              type="text"
              placeholder="例如：BBC Radio 1"
              maxlength="120"
            />
          </label>
          <label>
            流地址
            <input
              v-model="stationUrl"
              type="url"
              placeholder="https:// 或 http://"
              maxlength="2048"
            />
          </label>
          <label class="checkbox">
            <input v-model="allowHttp" type="checkbox" />
            <span>允许 HTTP 流地址</span>
          </label>
          <button
            type="button"
            class="primary wide-action"
            :disabled="formBusy"
            @click="addStation"
          >
            添加到我的电台
          </button>
        </section>

        <section class="tool-card tool-card-muted">
          <div class="card-heading">
            <span class="card-icon"><i class="pi pi-upload"></i></span>
            <div>
              <h2>导入播放列表</h2>
              <p>粘贴 M3U 或 PLS 内容，批量导入电台。</p>
            </div>
          </div>
          <textarea
            v-model="playlistText"
            rows="4"
            placeholder="#EXTM3U&#10;#EXTINF:-1,Station&#10;https://example/stream"
          ></textarea>
          <button
            type="button"
            :disabled="formBusy || !playlistText.trim()"
            @click="importPlaylist"
          >
            导入列表
          </button>
        </section>

        <section class="tool-card discovery-card">
          <div class="card-heading">
            <span class="card-icon"><i class="pi pi-search"></i></span>
            <div>
              <h2>发现电台</h2>
            </div>
          </div>
          <div class="inline-search">
            <input
              v-model="directoryQuery"
              type="search"
              placeholder="jazz / 中文 / BBC"
              maxlength="120"
              @keydown.enter.prevent="searchDirectory"
            />
            <button
              type="button"
              class="primary"
              :disabled="directoryBusy || !directoryQuery.trim()"
              @click="searchDirectory"
            >
              {{ directoryBusy ? '搜索中…' : '搜索' }}
            </button>
          </div>
          <ul v-if="directoryResults.length > 0" class="directory-results">
            <li v-for="row in directoryResults" :key="row.stationuuid">
              <div>
                <strong>{{ row.name }}</strong>
                <small>
                  <span v-if="row.countryCode">{{ row.countryCode }}</span>
                  <span v-if="row.bitrate">{{ row.bitrate }} kbps</span>
                  <span v-if="row.codec">{{ row.codec }}</span>
                  <span v-if="row.tags?.length">{{ row.tags.slice(0, 3).join(', ') }}</span>
                </small>
              </div>
              <button type="button" :disabled="formBusy" @click="addDirectoryStation(row)">
                收藏
              </button>
            </li>
          </ul>
        </section>
      </aside>

      <section class="station-collection" aria-labelledby="station-library-title">
        <div class="collection-heading">
          <div>
            <span class="section-kicker">MY LIBRARY</span>
            <h2 id="station-library-title">我的电台</h2>
          </div>
          <span class="collection-count">{{ radio.stations.value.length }} 个电台</span>
        </div>
        <div v-if="radio.stations.value.length > 0" class="station-grid">
          <article v-for="station in radio.stations.value" :key="station.id" class="station-card">
            <div class="station-main">
              <span class="station-icon"><i class="pi pi-broadcast"></i></span>
              <div>
                <strong>{{ station.name }}</strong>
                <small>{{ station.streamUrl }}</small>
                <span v-if="station.allowInsecureHttp" class="badge http">HTTP</span>
              </div>
            </div>
            <div class="station-actions">
              <button type="button" class="primary" @click="playStation(station.id)">
                <PlaybackIcon name="play" />
                播放
              </button>
              <button
                type="button"
                class="quiet-button"
                :disabled="formBusy"
                @click="removeStation(station.id)"
              >
                删除
              </button>
            </div>
          </article>
        </div>
        <div v-else class="collection-empty">
          <span class="empty-icon"><i class="pi pi-broadcast"></i></span>
          <h3>还没有收藏的电台</h3>
          <p>添加或导入电台。</p>
        </div>
      </section>
    </section>

    <section v-else class="podcast-workspace">
      <section class="podcast-subscribe-card">
        <div class="card-heading">
          <span class="card-icon"><i class="pi pi-rss"></i></span>
          <div>
            <h2>订阅播客</h2>
          </div>
        </div>
        <div class="podcast-subscribe-form">
          <label class="sr-only" for="podcast-feed-url">RSS / Atom 地址</label>
          <input
            id="podcast-feed-url"
            v-model="feedUrl"
            type="url"
            placeholder="https://example.com/feed.xml"
          />
          <button
            type="button"
            class="primary"
            :disabled="formBusy || podcast.busy.value"
            @click="subscribeFeed"
          >
            订阅
          </button>
          <button
            type="button"
            :disabled="formBusy || podcast.busy.value"
            @click="runFormAction(() => podcast.refreshAll())"
          >
            刷新全部
          </button>
        </div>
      </section>

      <div class="podcast-layout">
        <aside class="podcast-library" aria-labelledby="podcast-library-title">
          <div class="library-heading">
            <div>
              <span class="section-kicker">SUBSCRIPTIONS</span>
              <h2 id="podcast-library-title">我的订阅</h2>
            </div>
            <span>{{ podcast.subscriptions.value.length }}</span>
          </div>
          <ul class="subscription-list">
            <li
              v-for="sub in podcast.subscriptions.value"
              :key="sub.id"
              :class="{ active: selectedPodcastId === sub.id }"
            >
              <button
                type="button"
                class="subscription-open"
                :aria-pressed="selectedPodcastId === sub.id"
                @click="selectedPodcastId = sub.id"
              >
                <strong>{{ sub.title }}</strong>
                <small>{{ sub.episodes.length }} 集</small>
              </button>
              <button
                type="button"
                class="linkish"
                :disabled="removingSubscriptions.has(sub.id)"
                @click.stop="unsubscribePodcast(sub.id)"
              >
                {{ removingSubscriptions.has(sub.id) ? '取消中…' : '取消订阅' }}
              </button>
            </li>
            <li v-if="podcast.subscriptions.value.length === 0" class="empty">暂无订阅</li>
          </ul>
        </aside>

        <section v-if="selectedPodcast" class="episode-panel" aria-label="播客剧集">
          <div class="episode-header">
            <div>
              <span class="section-kicker">EPISODES</span>
              <h2>{{ selectedPodcast.title }}</h2>
              <p v-if="selectedPodcast.author">{{ selectedPodcast.author }}</p>
              <p v-if="selectedPodcast.lastError" class="page-error">
                {{ selectedPodcast.lastError }}
              </p>
            </div>
            <button type="button" :disabled="podcast.busy.value" @click="refreshSelected">
              <i class="pi pi-refresh"></i>
              刷新
            </button>
          </div>
          <ul class="episode-list">
            <li v-for="episode in selectedPodcast.episodes" :key="episode.guid">
              <div>
                <strong>{{ episode.title }}</strong>
                <small>
                  {{ formatDuration(episode.durationSeconds) }}
                  <span v-if="progressLabel(episode)" class="badge progress">{{
                    progressLabel(episode)
                  }}</span>
                </small>
              </div>
              <div class="episode-actions">
                <button
                  type="button"
                  class="primary"
                  @click="playEpisode(selectedPodcast, episode.guid)"
                >
                  <PlaybackIcon name="play" />
                  播放
                </button>
              </div>
            </li>
            <li v-if="selectedPodcast.episodes.length === 0" class="empty">
              这个播客还没有可播放的剧集
            </li>
          </ul>
        </section>
        <div v-else class="episode-empty">
          <span class="empty-icon"><i class="pi pi-microphone"></i></span>
          <h2>选择一个播客</h2>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.radio-podcast-page {
  box-sizing: border-box;
  width: 100%;
  height: 100dvh;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: 52px clamp(24px, 5vw, 72px) 132px;
  color: var(--te-settings-text, #0f172a);
  scrollbar-width: thin;
  scrollbar-color: var(--te-scrollbar-thumb) transparent;
  container: radio-podcast/inline-size;
}

.radio-podcast-page::-webkit-scrollbar {
  width: 8px;
}
.radio-podcast-page::-webkit-scrollbar-track {
  background: transparent;
}
.radio-podcast-page::-webkit-scrollbar-thumb {
  background: var(--te-scrollbar-thumb);
  border-radius: 999px;
}

.radio-podcast-page > * {
  width: min(100%, 1180px);
  margin-inline: auto;
}

.page-header {
  display: grid;
  position: relative;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 20px;
  align-items: center;
  margin-bottom: 28px;
}

.back-btn,
.tabs button,
.tool-card button,
.podcast-subscribe-form button,
.station-actions button,
.episode-header button,
.episode-list button,
.subscription-list .linkish,
.directory-results button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 36px;
  box-sizing: border-box;
  border: 1px solid var(--te-settings-control-border, rgba(15, 23, 42, 0.12));
  border-radius: 10px;
  padding: 0 12px;
  background: var(--te-card-bg, rgba(255, 255, 255, 0.72));
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 650;
  transition:
    border-color 0.18s ease,
    background 0.18s ease,
    transform 0.18s ease;
}

button:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--te-primary-500) 38%, transparent);
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

.page-heading {
  min-width: 0;
}
.page-kicker,
.section-kicker {
  display: block;
  color: var(--te-primary-500);
  font-size: calc(var(--te-font-size-body, 14px) * 10 / 14);
  font-weight: 800;
  letter-spacing: 0.14em;
  line-height: 1.2;
}
.page-heading h1 {
  margin: 5px 0 4px;
  font-size: clamp(25px, 3vw, 34px);
  letter-spacing: -0.045em;
  line-height: 1.04;
}
.page-heading p,
.card-heading p,
.collection-heading p,
.episode-empty p {
  margin: 0;
  color: var(--te-settings-text-muted);
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  line-height: 1.55;
}

.tabs {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 4px;
  border: 1px solid var(--te-settings-control-border, rgba(15, 23, 42, 0.1));
  border-radius: 13px;
  background: color-mix(in srgb, var(--te-card-bg) 74%, transparent);
}
.tabs button {
  min-height: 34px;
  border-color: transparent;
  background: transparent;
}
.tabs button.active,
button.primary {
  border-color: transparent;
  background: var(--te-primary-500);
  color: var(--te-primary-on-primary, #fff);
  box-shadow: 0 7px 18px color-mix(in srgb, var(--te-primary-500) 20%, transparent);
}

.page-error {
  margin: 0 auto 18px;
  padding: 10px 13px;
  border: 1px solid color-mix(in srgb, var(--te-danger-soft-fg) 25%, transparent);
  border-radius: 12px;
  background: var(--te-danger-soft-bg);
  color: var(--te-danger-soft-fg);
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 600;
}

.radio-workspace {
  display: grid;
  grid-template-columns: minmax(276px, 340px) minmax(0, 1fr);
  gap: clamp(18px, 3vw, 34px);
  align-items: start;
}
.radio-tools {
  display: grid;
  gap: 14px;
}
.tool-card,
.podcast-subscribe-card,
.podcast-library,
.episode-panel,
.station-collection {
  box-sizing: border-box;
  border: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.08));
  border-radius: 20px;
  background: color-mix(in srgb, var(--te-card-bg) 90%, transparent);
  box-shadow: 0 14px 36px color-mix(in srgb, var(--te-settings-text) 5%, transparent);
}
.tool-card {
  display: grid;
  gap: 12px;
  padding: 18px;
}
.tool-card-muted {
  background: color-mix(in srgb, var(--te-card-bg) 78%, transparent);
}
.card-heading {
  display: flex;
  gap: 11px;
  align-items: flex-start;
}
.card-heading h2,
.collection-heading h2,
.library-heading h2,
.episode-header h2,
.episode-empty h2,
.collection-empty h3 {
  margin: 0;
  letter-spacing: -0.025em;
  line-height: 1.18;
}
.card-heading h2 {
  font-size: calc(var(--te-font-size-body, 14px) * 15 / 14);
}
.card-icon,
.station-icon,
.empty-icon {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--te-primary-500) 13%, transparent);
  color: var(--te-primary-500);
}

.tool-card label {
  display: grid;
  gap: 6px;
  color: var(--te-settings-text-muted);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 700;
}
.tool-card label.checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.tool-card input[type='text'],
.tool-card input[type='url'],
.tool-card input[type='search'],
.tool-card textarea,
.podcast-subscribe-form input {
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--te-settings-control-border, rgba(15, 23, 42, 0.12));
  border-radius: 10px;
  padding: 9px 11px;
  background: var(--te-settings-control-bg, rgba(255, 255, 255, 0.88));
  color: inherit;
  font: inherit;
  outline: none;
}
.tool-card textarea {
  resize: vertical;
}
.tool-card input:focus,
.tool-card textarea:focus,
.podcast-subscribe-form input:focus {
  border-color: color-mix(in srgb, var(--te-primary-500) 58%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--te-primary-500) 12%, transparent);
}
.wide-action {
  width: 100%;
}
.inline-search {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.directory-results,
.subscription-list,
.episode-list {
  display: grid;
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.directory-results {
  max-height: 308px;
  overflow: auto;
  padding-right: 3px;
}
.directory-results li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 0;
  border-top: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.08));
}
.directory-results strong,
.station-main strong,
.subscription-list strong,
.episode-list strong {
  display: block;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  line-height: 1.35;
}
.directory-results small,
.subscription-list small,
.episode-list small {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 8px;
  margin-top: 3px;
  color: var(--te-settings-text-muted);
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
}
.directory-results button {
  min-height: 30px;
  padding-inline: 9px;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
}

.station-collection {
  min-height: 470px;
  padding: clamp(18px, 3vw, 30px);
}
.collection-heading,
.library-heading,
.episode-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.collection-heading {
  margin-bottom: 22px;
}
.collection-heading h2 {
  margin-top: 5px;
  font-size: calc(var(--te-font-size-body, 14px) * 22 / 14);
}
.collection-count,
.library-heading > span {
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 6px 9px;
  background: color-mix(in srgb, var(--te-primary-500) 10%, transparent);
  color: var(--te-primary-500);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 750;
}
.station-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(218px, 1fr));
  gap: 12px;
}
.station-card {
  display: flex;
  min-height: 144px;
  flex-direction: column;
  justify-content: space-between;
  gap: 16px;
  padding: 15px;
  border: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.08));
  border-radius: 15px;
  background: color-mix(in srgb, var(--te-card-bg) 75%, transparent);
  transition:
    transform 0.2s var(--te-ease-soft),
    border-color 0.2s ease;
}
.station-card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--te-primary-500) 30%, transparent);
}
.station-main {
  display: flex;
  gap: 10px;
  min-width: 0;
}
.station-icon {
  width: 30px;
  height: 30px;
  border-radius: 9px;
}
.station-main > div {
  min-width: 0;
}
.station-main small {
  display: block;
  overflow: hidden;
  margin-top: 4px;
  color: var(--te-settings-text-muted);
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.station-actions {
  display: flex;
  gap: 7px;
}
.station-actions button {
  min-height: 33px;
}
.quiet-button {
  background: transparent !important;
}
.badge {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  margin-top: 7px;
  border-radius: var(--te-badge-radius);
  padding: var(--te-badge-pad-y) var(--te-badge-pad-x);
  background: color-mix(in srgb, var(--te-primary-500) 11%, transparent);
  color: var(--te-primary-500);
  font-size: var(--te-badge-font-size);
  font-weight: var(--te-badge-font-weight);
}
.badge.http {
  background: color-mix(in srgb, #f59e0b 15%, transparent);
  color: #b45309;
}
.badge.progress {
  margin: 0 0 0 6px;
}

.collection-empty,
.episode-empty {
  display: grid;
  min-height: 260px;
  place-content: center;
  justify-items: center;
  padding: 26px;
  text-align: center;
}
.collection-empty .empty-icon,
.episode-empty .empty-icon {
  width: 42px;
  height: 42px;
  margin-bottom: 12px;
  border-radius: 13px;
}
.collection-empty h3,
.episode-empty h2 {
  margin-bottom: 6px;
  font-size: calc(var(--te-font-size-body, 14px) * 17 / 14);
}

.podcast-workspace {
  display: grid;
  gap: 18px;
}
.podcast-subscribe-card {
  display: grid;
  grid-template-columns: minmax(220px, 0.8fr) minmax(0, 1.2fr);
  gap: 24px;
  align-items: center;
  padding: 20px 22px;
}
.podcast-subscribe-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
.podcast-layout {
  display: grid;
  grid-template-columns: minmax(250px, 310px) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}
.podcast-library {
  padding: 16px;
}
.library-heading {
  align-items: center;
  padding: 2px 2px 14px;
}
.library-heading h2 {
  margin-top: 5px;
  font-size: calc(var(--te-font-size-body, 14px) * 17 / 14);
}
.subscription-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding: 11px;
  border: 1px solid transparent;
  border-radius: 11px;
  cursor: pointer;
  transition:
    background 0.18s ease,
    border-color 0.18s ease;
}
.subscription-list li:hover {
  background: color-mix(in srgb, var(--te-primary-500) 6%, transparent);
}
.subscription-list li.active {
  border-color: color-mix(in srgb, var(--te-primary-500) 32%, transparent);
  background: color-mix(in srgb, var(--te-primary-500) 10%, transparent);
}
.subscription-list .subscription-open {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  flex: 1;
  text-align: left;
  background: transparent;
  border: 0;
  color: inherit;
  padding: 4px;
  min-width: 0;
}
.subscription-list strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.subscription-list .linkish {
  min-height: 28px;
  padding-inline: 8px;
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
}
.empty {
  color: var(--te-settings-text-muted);
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
}
.episode-panel {
  padding: clamp(18px, 3vw, 28px);
  min-height: 390px;
}
.episode-header {
  margin-bottom: 18px;
}
.episode-header h2 {
  margin-top: 5px;
  font-size: calc(var(--te-font-size-body, 14px) * 22 / 14);
}
.episode-header p {
  margin: 4px 0 0;
  color: var(--te-settings-text-muted);
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
}
.episode-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 13px 0;
  border-top: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.08));
}
.episode-list li:first-child {
  border-top: 0;
}
.episode-actions {
  display: flex;
  align-items: center;
}
.episode-list button {
  min-height: 34px;
}
.episode-empty {
  min-height: 390px;
  border: 1px dashed var(--te-card-border, rgba(15, 23, 42, 0.18));
  border-radius: 20px;
}

:global(html[data-theme='dark'] .tool-card),
:global(html[data-theme='dark'] .podcast-subscribe-card),
:global(html[data-theme='dark'] .podcast-library),
:global(html[data-theme='dark'] .episode-panel),
:global(html[data-theme='dark'] .station-collection),
:global(html[data-theme='dark'] .station-card) {
  background: color-mix(in srgb, var(--te-card-bg) 82%, transparent);
}

@media (max-width: 880px) {
  .page-header {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .tabs {
    grid-column: 1 / -1;
    justify-self: start;
  }
  .radio-workspace {
    grid-template-columns: 1fr;
  }
  .radio-tools {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .discovery-card {
    grid-column: 1 / -1;
  }
  .podcast-subscribe-card {
    grid-template-columns: 1fr;
    gap: 16px;
  }
}

@media (max-width: 680px) {
  .radio-podcast-page {
    padding: 38px 16px 120px;
  }
  .page-header {
    gap: 14px;
    padding: 52px 0 0;
  }
  .back-btn {
    inset-block: 0 auto;
    transform: none;
  }
  .back-btn:hover {
    transform: translateX(-2px);
  }
  .page-heading {
    grid-column: 1 / -1;
    grid-row: 2;
  }
  .tabs {
    grid-row: 3;
  }
  .radio-tools {
    grid-template-columns: 1fr;
  }
  .discovery-card {
    grid-column: auto;
  }
  .station-collection {
    padding: 17px;
  }
  .station-grid {
    grid-template-columns: 1fr;
  }
  .podcast-subscribe-form {
    grid-template-columns: 1fr;
  }
  .podcast-layout {
    grid-template-columns: 1fr;
  }
  .episode-header {
    flex-direction: column;
  }
  .episode-list li {
    grid-template-columns: 1fr;
  }
  .episode-actions {
    justify-content: flex-start;
  }
}

/* Responsive fixes selected from PR #115; desktop styling stays in the rules above. */
@container radio-podcast (max-width: 880px) {
  .page-header {
    grid-template-columns: minmax(0, 1fr);
  }
  .tabs {
    grid-column: 1 / -1;
    justify-self: start;
  }
  .radio-workspace {
    grid-template-columns: 1fr;
  }
  .radio-tools {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .discovery-card {
    grid-column: 1 / -1;
  }
  .podcast-subscribe-card {
    grid-template-columns: 1fr;
    gap: 16px;
  }
}
@container radio-podcast (max-width: 680px) {
  .page-header {
    gap: 14px;
  }
  .radio-tools {
    grid-template-columns: 1fr;
  }
  .discovery-card {
    grid-column: auto;
  }
  .station-collection {
    padding: 17px;
  }
  .station-grid {
    grid-template-columns: 1fr;
  }
  .podcast-subscribe-form {
    grid-template-columns: 1fr;
  }
  .podcast-layout {
    grid-template-columns: 1fr;
  }
  .episode-header {
    flex-direction: column;
  }
  .episode-list li {
    grid-template-columns: 1fr;
  }
  .episode-actions {
    justify-content: flex-start;
  }
}

@media (max-width: 900px) {
  .radio-podcast-page {
    padding-bottom: max(116px, calc(var(--te-playbar-bottom-clearance, 0px) + 16px));
  }
}
</style>
