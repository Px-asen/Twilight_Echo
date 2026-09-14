<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { Track } from '@renderer/types/music'
import type { Playlist } from '@renderer/stores/useMusicStore.ts'
import type { UnifiedMusicSearchState } from '@renderer/app/useUnifiedMusicSearch.ts'
import {
  filterCommandPaletteActions,
  type CommandPaletteAction
} from '@renderer/app/commandPaletteActions.ts'
import { searchLocalStreamingPlaylists } from '@renderer/components/streaming-page/localStreamingSearch.ts'

const props = defineProps<{
  actions: CommandPaletteAction[]
  search: UnifiedMusicSearchState
  playlists: Ref<Playlist[]>
  tracks: Ref<Track[]>
  playTrack: (track: Track, tracks?: Track[]) => unknown
  openPlaylist: (playlist: Playlist) => unknown
}>()
const emit = defineEmits<{ close: [] }>()
type Row = {
  id: string
  title: string
  description: string
  group: string
  disabledReason?: string
  run: () => unknown
}
const PAGE_SIZE = 20
const ROW_HEIGHT = 64
const dialog = ref<HTMLDialogElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const results = ref<HTMLElement | null>(null)
const query = ref('')
const composing = ref(false)
const offset = ref(0)
const selected = ref(0)
const scrollTop = ref(0)
const viewportHeight = ref(420)
const pending = ref(false)
const busy = ref(false)
const error = ref('')
let timer: number | undefined
let previousFocus: HTMLElement | null = null
let observer: ResizeObserver | undefined
let actionSequence = 0
let pageSequence = 0
let failedActionId = ''
const commandsOnly = computed(() => /^\s*>/.test(query.value))
const loading = computed(() => pending.value || props.search.loading.value)
const playlistPage = computed(() =>
  commandsOnly.value
    ? { playlists: [], total: 0 }
    : searchLocalStreamingPlaylists(props.playlists.value, query.value, PAGE_SIZE, offset.value)
)
const playlistById = computed(
  () => new Map(props.playlists.value.map((playlist) => [playlist.id, playlist]))
)
const rows = computed<Row[]>(() => {
  const actions = filterCommandPaletteActions(props.actions, query.value)
  const rows: Row[] = actions.filter((action) => action.group === '操作')
  if (!commandsOnly.value) {
    for (const item of props.search.logicalItems.value) {
      const track = item.preferredTrack
      const preferred =
        item.variants.find(
          (variant) => variant.track.id === track.id && variant.source === track.source
        ) ?? item.variants[0]
      rows.push({
        id: `song:${track.source}:${track.id}`,
        title: track.title,
        description: `${track.artist} · ${track.album} · ${preferred?.sourceName ?? track.source ?? '本地音乐'}`,
        group: '歌曲',
        disabledReason: preferred?.providerAvailable === false ? '当前音源不可用' : undefined,
        run: () => props.playTrack(track, [track])
      })
    }
    for (const summary of playlistPage.value.playlists) {
      const playlist = playlistById.value.get(String(summary.id))
      if (!playlist) continue
      rows.push({
        id: `playlist:${playlist.id}`,
        title: playlist.name,
        description: `${playlist.trackIds.length} 首 · ${playlist.kind === 'aggregate' ? '聚合歌单' : '本地歌单'}`,
        group: '歌单',
        run: () => props.openPlaylist(playlist)
      })
    }
  }
  rows.push(...actions.filter((action) => action.group === '设置'))
  return rows
})
const hasMore = computed(
  () =>
    !commandsOnly.value &&
    (props.search.hasMore.value || playlistPage.value.total > offset.value + PAGE_SIZE)
)
const start = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - 3))
const visibleRows = computed(() =>
  rows.value.slice(start.value, start.value + Math.ceil(viewportHeight.value / ROW_HEIGHT) + 7)
)
const activeId = computed(() =>
  rows.value[selected.value] ? `command-result-${selected.value}` : undefined
)
const providerErrors = computed(() =>
  Object.values(props.search.providerHealth.value).filter(
    (health) => health.searchable && !health.available
  )
)

function clearTimer(): void {
  window.clearTimeout(timer)
  timer = undefined
  pending.value = false
}

function scheduleSearch(): void {
  pageSequence += 1
  clearTimer()
  props.search.clear()
  error.value = ''
  failedActionId = ''
  offset.value = 0
  selected.value = 0
  if (results.value) results.value.scrollTop = 0
  scrollTop.value = 0
  if (composing.value || !query.value.trim() || commandsOnly.value) return
  pending.value = true
  timer = window.setTimeout(() => {
    pending.value = false
    void props.search.search(query.value, { limit: PAGE_SIZE, offset: 0 })
  }, 250)
}

function onInput(event: Event): void {
  query.value = (event.target as HTMLInputElement).value
  scheduleSearch()
}

function compositionStart(): void {
  pageSequence += 1
  composing.value = true
  clearTimer()
  props.search.clear()
}

function compositionEnd(event: CompositionEvent): void {
  composing.value = false
  onInput(event)
}

async function changePage(delta: number): Promise<void> {
  if (loading.value || busy.value) return
  const sequence = ++pageSequence
  offset.value = Math.max(0, offset.value + delta * PAGE_SIZE)
  selected.value = 0
  error.value = ''
  await props.search.search(query.value, { limit: PAGE_SIZE, offset: offset.value })
  await nextTick()
  if (sequence !== pageSequence) return
  if (results.value) results.value.scrollTop = 0
  scrollTop.value = 0
  input.value?.focus()
}

function revealSelection(): void {
  const element = results.value
  if (!element) return
  const top = selected.value * ROW_HEIGHT
  if (top < element.scrollTop) element.scrollTop = top
  else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
    element.scrollTop = top + ROW_HEIGHT - element.clientHeight
  scrollTop.value = element.scrollTop
}

function move(delta: number): void {
  const count = rows.value.length
  if (!count) return
  for (let step = 0; step < count; step += 1) {
    selected.value = (selected.value + delta + count) % count
    if (!rows.value[selected.value].disabledReason) break
  }
  revealSelection()
}

async function execute(id: string): Promise<void> {
  if (busy.value || composing.value) return
  const row = rows.value.find((candidate) => candidate.id === id)
  if (!row || row.disabledReason) return
  const sequence = ++actionSequence
  busy.value = true
  error.value = ''
  try {
    await row.run()
    if (sequence === actionSequence) emit('close')
  } catch (reason) {
    if (sequence === actionSequence) {
      failedActionId = row.id
      error.value = reason instanceof Error ? reason.message : String(reason)
    }
  } finally {
    if (sequence === actionSequence) busy.value = false
  }
}

function retry(): void {
  if (failedActionId) void execute(failedActionId)
  else void changePage(0)
}

function onKeydown(event: KeyboardEvent): void {
  if (composing.value || event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
  } else if (
    event.target === input.value &&
    ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)
  ) {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Enter') {
      const row = rows.value[selected.value]
      if (row) void execute(row.id)
    } else move(event.key === 'ArrowDown' ? 1 : -1)
  }
}

watch(rows, (next, previous) => {
  const id = previous?.[selected.value]?.id
  const index = next.findIndex((row) => row.id === id && !row.disabledReason)
  selected.value =
    index >= 0
      ? index
      : Math.max(
          0,
          next.findIndex((row) => !row.disabledReason)
        )
  void nextTick(revealSelection)
})
watch([props.tracks, props.playlists], scheduleSearch)
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.value?.showModal()
  input.value?.focus()
  selected.value = Math.max(
    0,
    rows.value.findIndex((row) => !row.disabledReason)
  )
  observer = new ResizeObserver(() => {
    viewportHeight.value = results.value?.clientHeight ?? 420
  })
  if (results.value) observer.observe(results.value)
})
onBeforeUnmount(() => {
  actionSequence += 1
  pageSequence += 1
  clearTimer()
  props.search.clear()
  observer?.disconnect()
  dialog.value?.close()
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
</script>

<template>
  <dialog
    ref="dialog"
    class="command-palette"
    aria-labelledby="command-palette-title"
    @keydown="onKeydown"
    @cancel.prevent="!composing && emit('close')"
    @click.self="emit('close')"
  >
    <div class="palette-content">
      <header>
        <h2 id="command-palette-title">命令面板</h2>
        <button type="button" aria-label="关闭命令面板" @click="emit('close')">Esc</button>
      </header>
      <div class="palette-input">
        <i class="pi pi-search" aria-hidden="true"></i>
        <input
          ref="input"
          :value="query"
          :disabled="busy"
          role="combobox"
          aria-label="搜索歌曲、歌单、操作或设置"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="command-results"
          :aria-activedescendant="activeId"
          placeholder="歌曲、歌单、操作或设置…"
          autocomplete="off"
          spellcheck="false"
          @input="onInput"
          @compositionstart="compositionStart"
          @compositionend="compositionEnd"
        />
      </div>
      <p class="palette-hint">↑ ↓ 选择 · Enter 执行／播放 · 输入 &gt; 只查找操作与设置</p>
      <p v-if="error || search.error.value" class="palette-error" role="alert">
        {{ error || search.error.value }}
        <button type="button" :disabled="busy || loading" @click="retry">重试</button>
      </p>
      <p
        v-if="providerErrors.length"
        class="palette-error"
        role="status"
        :title="
          providerErrors
            .map((health) => `${health.providerName}：${health.lastError ?? '不可用'}`)
            .join('；')
        "
      >
        部分音源不可用：{{
          providerErrors.map((health) => health.providerName).join('、')
        }}。其余结果仍可使用。
      </p>
      <p v-if="loading || busy" class="palette-status" role="status">
        {{ busy ? '正在执行…' : '正在搜索…' }}
      </p>
      <div
        id="command-results"
        ref="results"
        class="palette-results"
        role="listbox"
        aria-label="命令与搜索结果"
        :aria-busy="loading || busy"
        @scroll="scrollTop = ($event.target as HTMLElement).scrollTop"
      >
        <div class="palette-result-space" :style="{ height: `${rows.length * ROW_HEIGHT}px` }">
          <button
            v-for="(row, index) in visibleRows"
            :id="`command-result-${start + index}`"
            :key="row.id"
            type="button"
            role="option"
            tabindex="-1"
            class="palette-row"
            :class="{ selected: selected === start + index }"
            :style="{ transform: `translateY(${(start + index) * ROW_HEIGHT}px)` }"
            :aria-selected="selected === start + index"
            :aria-disabled="busy || !!row.disabledReason"
            :aria-posinset="start + index + 1"
            :aria-setsize="rows.length"
            @pointerdown.prevent
            @pointermove="selected = start + index"
            @click="execute(row.id)"
          >
            <span class="palette-group">{{ row.group }}</span>
            <span class="palette-row-copy"
              ><strong>{{ row.title }}</strong
              ><small>{{ row.disabledReason || row.description }}</small></span
            >
            <span v-if="selected === start + index && !row.disabledReason" aria-hidden="true"
              >↵</span
            >
          </button>
        </div>
        <p v-if="!rows.length && !loading" class="palette-empty">
          {{ composing ? '正在输入…' : '没有匹配的结果，试试歌曲名、歌单名或设置关键词。' }}
        </p>
      </div>
      <footer>
        <span>{{ offset ? `第 ${offset / PAGE_SIZE + 1} 页` : '歌曲与歌单按来源分页' }}</span>
        <div>
          <button type="button" :disabled="!offset || loading || busy" @click="changePage(-1)">
            上一页</button
          ><button type="button" :disabled="!hasMore || loading || busy" @click="changePage(1)">
            下一页
          </button>
        </div>
      </footer>
    </div>
  </dialog>
</template>

<style scoped>
.command-palette {
  width: min(680px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  margin: min(12vh, 100px) auto auto;
  padding: 0;
  border: 1px solid var(--border-color, #8884);
  border-radius: 16px;
  color: var(--text-primary, #202026);
  background: var(--bg-primary, #fafafa);
  box-shadow: 0 18px 70px #0003;
  overflow: hidden;
}
.command-palette::backdrop {
  background: #0006;
}
.palette-content {
  padding: 16px 0 0;
}
header,
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 20px;
}
h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
button,
input {
  font: inherit;
  color: inherit;
}
header button,
footer button,
.palette-error button {
  border: 1px solid var(--border-color, #8884);
  border-radius: 6px;
  padding: 4px 8px;
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
.palette-input {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 16px 20px 0;
  padding: 10px 12px;
  border: 1px solid var(--border-color, #8884);
  border-radius: 9px;
}
.palette-input:focus-within {
  border-color: var(--accent-color, #6b5cff);
  box-shadow: 0 0 0 1px var(--accent-color, #6b5cff);
}
.palette-input input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  font-size: 15px;
}
.palette-hint,
.palette-status,
.palette-error {
  margin: 10px 20px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary, #666);
}
.palette-error {
  color: var(--danger-color, #b83a3a);
}
.palette-results {
  height: min(420px, 50vh);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 8px;
}
.palette-result-space {
  position: relative;
}
.palette-row {
  position: absolute;
  inset: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  height: 64px;
  padding: 8px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.palette-row.selected {
  background: color-mix(in srgb, var(--accent-color, #6b5cff) 12%, transparent);
}
.palette-row[aria-disabled='true'] {
  opacity: 0.55;
  cursor: default;
}
.palette-group {
  width: 32px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-secondary, #777);
}
.palette-row-copy {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 5px;
}
.palette-row-copy strong,
.palette-row-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.palette-row-copy strong {
  font-size: 14px;
  font-weight: 500;
}
.palette-row-copy small {
  font-size: 12px;
  color: var(--text-secondary, #777);
}
.palette-empty {
  padding: 24px 12px;
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary, #777);
  text-align: center;
}
footer {
  border-top: 1px solid var(--border-color, #8883);
  padding: 12px 20px;
  font-size: 11px;
  color: var(--text-secondary, #777);
}
footer div {
  display: flex;
  gap: 8px;
}
button:focus-visible {
  outline: 2px solid var(--accent-color, #6b5cff);
  outline-offset: 2px;
}
</style>
