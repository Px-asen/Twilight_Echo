<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useMusicStore } from '../stores/useMusicStore'
import { useCoreConnection } from '../stores/coreConnection.ts'
import { coreQueueTrackInput } from '../stores/player/corePlayerQueue.ts'
import CoverImg from './CoverImg.vue'
import { usePlayerStore } from '../stores/usePlayerStore'
import {
  externalMatchProgress,
  getExternalPlaylistService
} from '../stores/library/externalPlaylistService.ts'
import { useMediaProviders } from '../providers/index.ts'
import { useEscapeToClose, useFocusTrap } from '../app/useDismissLayer.ts'
import {
  IMPORT_PLATFORM_NAMES,
  type ImportResolutionState
} from '../../../shared/externalPlaylist.ts'
import type { CorePlaylistMemberView } from '../../../shared/corePlaylists.ts'
import type { Track } from '../types/music'
import ExternalPlaylistImportDialog from './ExternalPlaylistImportDialog.vue'
type Entry = NonNullable<CorePlaylistMemberView['imported']>
const props = defineProps<{ playlistId: string }>(),
  emit = defineEmits<{ back: []; navigate: [id: string, name: string] }>()
const music = useMusicStore(),
  core = useCoreConnection(),
  player = usePlayerStore(),
  service = getExternalPlaylistService(music),
  providers = useMediaProviders()
const playlist = computed(() => music.playlists.value.find((p) => p.id === props.playlistId)),
  data = computed(() => playlist.value?.imported)
const search = ref(''),
  sort = ref<'playlist' | 'title' | 'artist' | 'album' | 'duration'>('playlist'),
  offset = ref(0),
  total = ref(0),
  rows = shallowRef<Entry[]>([]),
  loading = ref(false),
  error = ref(''),
  refresh = ref(false)
const selected = ref<Entry | null>(null),
  dialog = ref<HTMLElement | null>(null),
  keywords = ref(''),
  results = shallowRef<Track[]>([]),
  searching = ref(false),
  matchError = ref('')
const labels: Record<ImportResolutionState, string> = {
  pending: '等待匹配',
  local: '本地音乐',
  streaming: '流媒体',
  missing: '无可用音源',
  ambiguous: '版本待确认',
  login: '待登录 / 授权',
  network: '网络错误',
  'rate-limit': '请求限流',
  cancelled: '已取消'
}
const counts = computed(() => {
  const c = data.value?.counts ?? {}
  return {
    all: playlist.value?.count ?? 0,
    local: c.local ?? 0,
    streaming: c.streaming ?? 0,
    pending: ['pending', 'login', 'network', 'rate-limit', 'cancelled'].reduce(
      (n, k) => n + (c[k as ImportResolutionState] ?? 0),
      0
    )
  }
})
const progress = computed(() => externalMatchProgress.value[props.playlistId]),
  playable = computed(() => counts.value.local + counts.value.streaming)
const canPlay = (entry: Entry) =>
  entry.resolution.track && ['local', 'streaming'].includes(entry.resolution.state)
function sourceLabel(entry: Entry) {
  const source = entry.resolution.track?.source
  return entry.resolution.state === 'streaming'
    ? providers.get(source || '')?.name ||
        IMPORT_PLATFORM_NAMES[source as keyof typeof IMPORT_PLATFORM_NAMES] ||
        source ||
        '流媒体'
    : labels[entry.resolution.state]
}
async function play(entry?: Entry) {
  try {
    const result = await core.query('playlists.view', {
      id: props.playlistId,
      revision: music.playlistsRevision.value,
      versionsRevision: core.state.value!.versionsRevision!,
      preserveSources: true,
      limit: 1
    })
    await player.playLibraryQuery(
      {
        playlistView: result.viewId,
        sort: 'playlist',
        contentRevision: result.page.revision,
        ...(entry ? { playlistEntryId: entry.entryId } : {})
      },
      entry?.resolution.track?.id ?? result.page.tracks[0]?.id
    )
  } catch (e) {
    error.value = String(e)
  }
}
let request = 0,
  searchController: AbortController | undefined
async function load() {
  const token = ++request
  if (!data.value) return
  loading.value = true
  error.value = ''
  try {
    const page = await music.getPlaylistMembers(props.playlistId, {
      offset: offset.value,
      limit: 200,
      search: search.value,
      sort: sort.value
    })
    if (token === request) {
      rows.value = page.items.flatMap((item) => (item.imported ? [item.imported] : []))
      total.value = page.total
      if (offset.value >= page.total && offset.value > 0)
        offset.value = Math.max(0, Math.floor((page.total - 1) / 200) * 200)
    }
  } catch (e) {
    if (token === request) error.value = String(e)
  } finally {
    if (token === request) loading.value = false
  }
}
watch(
  () => [props.playlistId, search.value, sort.value],
  () => {
    offset.value = 0
    void load()
  }
)
watch(
  () => [offset.value, music.playlistsRevision.value],
  () => void load(),
  { immediate: true }
)
function openMatch(entry: Entry) {
  selected.value = entry
  keywords.value = [entry.original.title, entry.original.artist].filter(Boolean).join(' ')
  results.value = []
  matchError.value = ''
}
function closeMatch() {
  selected.value = null
  searchController?.abort()
}
useEscapeToClose(() => !!selected.value, closeMatch)
useFocusTrap(dialog, () => !!selected.value)
async function findCandidates() {
  searchController?.abort()
  searchController = new AbortController()
  const signal = searchController.signal
  searching.value = true
  matchError.value = ''
  results.value = []
  try {
    const page = await core.query(
      'search.songs',
      { query: keywords.value.trim(), limit: 50 },
      signal
    )
    if (!signal.aborted) results.value = page.items.map((item) => item.track)
  } catch (e) {
    if (!signal.aborted) matchError.value = String(e)
  } finally {
    if (!signal.aborted) searching.value = false
  }
}
async function bind(track: Track | null) {
  if (!selected.value) return
  try {
    const entryId = selected.value.entryId
    await core.command('imports.bind', {
      id: props.playlistId,
      revision: music.playlistsRevision.value,
      entryId,
      input: track ? coreQueueTrackInput(track, core.state.value?.network?.revision ?? null) : null
    })
    closeMatch()
    await service.run(props.playlistId, true, [entryId])
  } catch (e) {
    matchError.value = String(e)
  }
}
async function removeEntry() {
  if (!selected.value) return
  await core.command('playlists.edit', {
    revision: music.playlistsRevision.value,
    edit: { kind: 'importRemove', id: props.playlistId, entryIds: [selected.value.entryId] }
  })
  closeMatch()
  await music.loadPlaylists()
}
async function copy(entry: Entry) {
  try {
    await navigator.clipboard.writeText(
      [entry.original.title, entry.original.artist].filter(Boolean).join(' - ')
    )
  } catch (e) {
    error.value = String(e)
  }
}
function duration(value: number | undefined) {
  return value
    ? `${Math.floor(value / 60)}:${String(Math.round(value % 60)).padStart(2, '0')}`
    : '—'
}
onBeforeUnmount(() => {
  request++
  searchController?.abort()
})
</script>

<template>
  <section class="external-detail">
    <button class="back" @click="emit('back')">← 返回歌单</button>
    <header class="detail-header">
      <div class="cover" aria-hidden="true"><span>≋</span><small>IMPORTED</small></div>
      <div class="identity">
        <span class="eyebrow">外部歌单 · {{ data?.source.label }}</span>
        <h1>{{ playlist?.name || '歌单已删除' }}</h1>
        <p class="summary">
          {{ counts.all }} 首 <span>本地 {{ counts.local }}</span
          ><span>流媒体 {{ counts.streaming }}</span
          ><span>待处理 {{ counts.pending }}</span>
        </p>
        <div class="actions">
          <button class="primary" :disabled="!playable" @click="play()">▶ 播放可用歌曲</button
          ><button @click="refresh = true">手动更新</button
          ><button v-if="progress?.running" @click="service.stop(playlistId)">取消补全</button
          ><button v-else @click="service.run(playlistId, true)">重新匹配</button>
        </div>
      </div>
    </header>
    <div v-if="!data?.complete" class="incomplete" role="status">
      <strong>歌单尚未完整读取</strong
      ><span
        >已读取 {{ counts.all }} / {{ data?.expectedTotal ?? '…' }} 条。{{
          data?.readError || '正在读取后续页面…'
        }}</span
      >
    </div>
    <div v-if="progress?.running" class="matching" role="status">
      <span class="pulse" />正在补全音源 {{ progress.done }} / {{ progress.total
      }}<span>仅关联播放来源，不下载音乐</span>
    </div>
    <div class="list-tools">
      <label
        ><span class="sr-only">搜索歌单</span
        ><input
          v-model="search"
          placeholder="搜索歌名、艺术家或专辑"
          @keydown.escape="search = ''" /></label
      ><label
        ><span class="sr-only">歌曲排序</span
        ><select v-model="sort">
          <option value="playlist">原始顺序</option>
          <option value="title">按歌名</option>
          <option value="artist">按艺术家</option>
          <option value="album">按专辑</option>
          <option value="duration">按时长</option>
        </select></label
      >
    </div>
    <p v-if="error" class="error" role="alert">{{ error }} <button @click="load()">重试</button></p>
    <div class="song-table" role="table" aria-label="导入的歌单歌曲" :aria-busy="loading">
      <div class="song-row table-heading" role="row">
        <span>#</span><span>歌曲 / 艺术家</span><span class="album">专辑</span
        ><span>来源 / 状态</span><span>时长</span><span>操作</span>
      </div>
      <div
        v-for="entry in rows"
        :key="entry.entryId"
        class="song-row"
        :class="{ unavailable: !canPlay(entry) }"
        role="row"
        @dblclick="play(entry)"
        @contextmenu.prevent="openMatch(entry)"
      >
        <span class="position" role="cell">{{ entry.position + 1 }}</span>
        <div class="song-name" role="cell">
          <CoverImg
            v-if="entry.resolution.track"
            :core-track-id="entry.resolution.track.id"
            :identity="entry.resolution.track.id"
            size="sm"
            class="entry-cover"
            alt=""
            loading="lazy"
          />
          <div class="song-identity">
            <button class="title-button" :disabled="!canPlay(entry)" @click="play(entry)">
              {{ entry.original.title || '信息缺失' }}</button
            ><span>{{ entry.original.artist || '艺术家未提供' }}</span>
          </div>
        </div>
        <span class="album" role="cell" :title="entry.original.album">{{
          entry.original.album || '—'
        }}</span
        ><span class="state" role="cell" :title="entry.resolution.message"
          ><i :class="entry.resolution.state" />{{ sourceLabel(entry) }}</span
        ><span class="duration" role="cell">{{ duration(entry.original.duration) }}</span>
        <div class="row-actions" role="cell">
          <button
            :aria-label="`查看 ${entry.original.title || '歌曲'} 信息及手动选源`"
            @click="openMatch(entry)"
          >
            选源</button
          ><button :aria-label="`复制 ${entry.original.title || '歌名'}`" @click="copy(entry)">
            复制
          </button>
        </div>
      </div>
    </div>
    <p v-if="!rows.length && !loading" class="empty">
      {{ search ? '没有找到符合条件的条目' : '歌单中暂无条目' }}
    </p>
    <footer class="pagination">
      <span>{{ total }} 条结果 · 每页 200 条</span>
      <div>
        <button :disabled="offset === 0 || loading" @click="offset = Math.max(0, offset - 200)">
          上一页</button
        ><span>{{ Math.floor(offset / 200) + 1 }} / {{ Math.max(1, Math.ceil(total / 200)) }}</span
        ><button :disabled="offset + 200 >= total || loading" @click="offset += 200">下一页</button>
      </div>
    </footer>
    <ExternalPlaylistImportDialog
      :show="refresh"
      :playlist-id="playlistId"
      @close="refresh = false"
      @imported="(id, name) => emit('navigate', id, name)"
    />
    <Teleport to="body"
      ><div v-if="selected" class="match-overlay" @click.self="closeMatch">
        <section
          ref="dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="match-title"
          class="match-dialog"
        >
          <header>
            <h2 id="match-title">歌曲信息与手动选源</h2>
            <button aria-label="关闭选源" @click="closeMatch">×</button>
          </header>
          <h3>{{ selected.original.title || '信息缺失' }}</h3>
          <p>
            {{ selected.original.artist || '艺术家未提供' }} ·
            {{ selected.original.album || '专辑未提供' }} ·
            {{ duration(selected.original.duration) }}
          </p>
          <p class="metadata">
            {{ selected.original.platform }} {{ selected.original.platformId }}
            {{ selected.original.isrc }}
          </p>
          <p class="status-message">{{ selected.resolution.message || sourceLabel(selected) }}</p>
          <div class="search-action">
            <input
              v-model="keywords"
              aria-label="手动搜索歌曲"
              placeholder="输入歌名或艺术家"
              @keydown.enter="findCandidates"
            /><button
              class="primary"
              :disabled="searching || !keywords.trim()"
              @click="findCandidates"
            >
              {{ searching ? '搜索中…' : '搜索音源' }}
            </button>
          </div>
          <p v-if="matchError" role="alert" class="error">{{ matchError }}</p>
          <ul class="candidates">
            <li v-for="(track, i) in results" :key="`${track.id}:${i}`">
              <div>
                <strong>{{ track.title }}</strong
                ><span
                  >{{ track.artist }} · {{ track.album }} · {{ duration(track.duration) }} ·
                  {{ track.source || '本地' }}</span
                >
              </div>
              <button @click="bind(track)">绑定</button>
            </li>
          </ul>
          <footer>
            <button @click="copy(selected)">复制歌名</button
            ><button @click="bind(null)">清除绑定并重匹配</button
            ><button
              @click="
                service.run(playlistId, true, [selected.entryId]);
                closeMatch()
              "
            >
              重试此条目</button
            ><button @click="removeEntry()">移除此条目</button>
          </footer>
        </section>
      </div></Teleport
    >
  </section>
</template>

<style scoped>
.external-detail {
  height: 100%;
  overflow: auto;
  padding: 24px min(4.4vw, 48px) 110px;
  box-sizing: border-box;
  color: var(--te-neutral-900, #171b23);
}
button,
input,
select {
  font: inherit;
}
button {
  cursor: pointer;
  border: 1px solid var(--te-card-border, #ddd);
  border-radius: 8px;
  padding: 8px 12px;
  color: inherit;
  background: var(--te-subtle-bg, #f4f5f8);
}
button:disabled {
  cursor: default;
  opacity: 0.5;
}
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--te-primary-500, #6664dc);
  outline-offset: 2px;
}
.back {
  border: 0;
  background: none;
  padding: 0;
  margin: 0 0 24px;
  color: var(--te-neutral-500, #656b78);
  font-size: 13px;
}
.detail-header {
  display: flex;
  align-items: center;
  gap: 26px;
  margin-bottom: 26px;
}
.cover {
  width: 148px;
  height: 148px;
  flex-shrink: 0;
  background: linear-gradient(
    145deg,
    color-mix(in srgb, var(--te-primary-500, #6664dc) 20%, var(--te-card-bg, #fff)),
    var(--te-subtle-bg, #f4f5f8)
  );
  border: 1px solid var(--te-card-border, #ddd);
  border-radius: 18px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: var(--te-primary-500, #6664dc);
}
.cover > span {
  font-size: 65px;
  line-height: 1;
}
.cover small {
  font-size: 9px;
  letter-spacing: 0.23em;
  margin-top: 12px;
}
.identity {
  min-width: 0;
}
.eyebrow {
  font-size: 12px;
  color: var(--te-neutral-500, #656b78);
}
h1 {
  font-size: 30px;
  line-height: 1.2;
  margin: 10px 0 14px;
  letter-spacing: -0.035em;
  overflow-wrap: anywhere;
}
.summary {
  font-size: 13px;
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  margin: 0 0 18px;
  color: var(--te-neutral-500, #656b78);
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.primary {
  background: var(--te-primary-500, #6664dc);
  color: white;
  border-color: transparent;
}
.incomplete {
  display: flex;
  flex-direction: column;
  gap: 7px;
  background: var(--te-subtle-bg, #f4f5f8);
  border-left: 3px solid #c99438;
  padding: 16px;
  font-size: 13px;
  margin-bottom: 20px;
  line-height: 1.5;
}
.matching {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--te-primary-500, #6664dc);
  margin: 16px 0;
}
.matching > span:last-child {
  margin-left: auto;
  color: var(--te-neutral-500, #656b78);
}
.pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.list-tools {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin: 24px 0 12px;
}
input,
select {
  box-sizing: border-box;
  background: var(--te-subtle-bg, #f4f5f8);
  border: 1px solid var(--te-card-border, #ddd);
  color: inherit;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
}
.list-tools input {
  width: min(320px, 45vw);
}
.song-row {
  display: grid;
  grid-template-columns: 38px minmax(130px, 2fr) minmax(85px, 1fr) 142px 50px 104px;
  align-items: center;
  gap: 14px;
  min-height: 64px;
  border-bottom: 1px solid var(--te-card-border, #ddd);
  font-size: 13px;
  padding: 0 8px;
}
.table-heading {
  min-height: 38px;
  font-size: 11px;
  color: var(--te-neutral-500, #656b78);
}
.song-row:not(.table-heading):hover {
  background: var(--te-hover-bg, #f3f4f6);
  border-radius: 8px;
}
.song-name {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.song-name > span {
  font-size: 12px;
  color: var(--te-neutral-500, #656b78);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.title-button {
  border: 0;
  background: transparent;
  padding: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 14px;
}
.title-button:disabled {
  opacity: 1;
}
.unavailable .title-button {
  color: var(--te-neutral-500, #656b78);
}
.unavailable .song-name > span {
  color: var(--te-neutral-500, #656b78);
}
.album {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--te-neutral-500, #656b78);
}
.state {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--te-neutral-500, #656b78);
}
.state i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--te-neutral-400, #8c909a);
  flex-shrink: 0;
}
.state i.local {
  background: #4c9b7a;
}
.state i.streaming {
  background: var(--te-primary-500, #6664dc);
}
.state i.login,
.state i.network,
.state i.rate-limit,
.state i.ambiguous {
  background: #c39543;
}
.position,
.duration {
  color: var(--te-neutral-500, #656b78);
  font-variant-numeric: tabular-nums;
}
.row-actions {
  display: flex;
  gap: 4px;
}
.row-actions button {
  font-size: 11px;
  padding: 6px 8px;
  background: transparent;
}
.pagination {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 20px;
  font-size: 12px;
  color: var(--te-neutral-500, #656b78);
}
.pagination > div {
  display: flex;
  align-items: center;
  gap: 16px;
}
.error {
  font-size: 13px;
  color: var(--te-danger-500, #b33a45);
  line-height: 1.6;
}
.empty {
  padding: 40px;
  text-align: center;
  color: var(--te-neutral-500, #656b78);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
.match-overlay {
  position: fixed;
  inset: 0;
  z-index: 1700;
  display: grid;
  place-items: center;
  padding: 28px;
  background: #0007;
  backdrop-filter: blur(8px);
}
.match-dialog {
  width: min(670px, 100%);
  max-height: 80vh;
  overflow: auto;
  background: var(--te-card-bg, #fff);
  color: var(--te-neutral-900, #171b23);
  border: 1px solid var(--te-card-border, #ddd);
  padding: 26px;
  border-radius: 18px;
  box-sizing: border-box;
}
.match-dialog header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.match-dialog h2 {
  font-size: 19px;
  margin: 0;
}
.match-dialog h3 {
  margin-bottom: 8px;
}
.match-dialog p {
  font-size: 13px;
  color: var(--te-neutral-500, #656b78);
  line-height: 1.6;
}
.metadata {
  overflow-wrap: anywhere;
  font-size: 12px !important;
}
.status-message {
  padding: 12px;
  background: var(--te-subtle-bg, #f4f5f8);
  border-radius: 8px;
}
.search-action {
  display: flex;
  gap: 8px;
}
.search-action input {
  flex: 1;
  min-width: 0;
}
.candidates {
  padding: 0;
  list-style: none;
}
.candidates li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--te-card-border, #ddd);
}
.candidates li > div {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.candidates strong {
  font-size: 13px;
}
.candidates span {
  font-size: 12px;
  color: var(--te-neutral-500, #656b78);
}
.match-dialog footer {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 20px;
  font-size: 12px;
}
@media (max-width: 900px) {
  .song-row {
    grid-template-columns: 28px minmax(140px, 2fr) 126px 44px 98px;
    gap: 8px;
  }
  .album {
    display: none;
  }
  .cover {
    width: 115px;
    height: 115px;
  }
  h1 {
    font-size: 25px;
  }
}
.song-name {
  flex-direction: row;
  align-items: center;
  gap: 10px;
}
.song-identity {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.song-identity > span {
  font-size: 12px;
  color: var(--te-neutral-500, #656b78);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entry-cover {
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 6px;
  object-fit: cover;
  background: var(--te-subtle-bg, #f4f5f8);
}
.unavailable .song-identity > span {
  color: var(--te-neutral-500, #656b78);
}
</style>
