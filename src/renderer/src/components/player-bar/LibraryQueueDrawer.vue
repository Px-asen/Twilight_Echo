<script setup lang="ts">
import { computed, onScopeDispose, ref, toRef, watch, type ComponentPublicInstance } from 'vue'
import type {
  LibraryQueueSnapshot,
  LibraryQueueEdit
} from '../../../../shared/libraryDatabase.ts'
import { LIBRARY_PAGE_SIZE } from '../../../../shared/libraryDatabase.ts'
import type { CoreQueuePage } from '../../../../shared/coreViews.ts'
import type { QueuePlaylistEntry } from './useQueueAddToPlaylist.ts'
import CoverImg from '../CoverImg.vue'
import PlaybackIcon from '../icons/PlaybackIcon.vue'
import { useLibraryQueueViewport, type LibraryQueueRow } from './useLibraryQueueViewport.ts'

type QueueVersion = Pick<LibraryQueueSnapshot, 'id' | 'revision'>
const props = defineProps<{
  snapshot: LibraryQueueSnapshot | null
  contentRevision: number
  busy: boolean
  isPlaying: boolean
  glass?: boolean
  resolveCoreArtwork?: boolean
  readPage: (page: number) => Promise<CoreQueuePage | null>
  playEntry: (entryId: string, expected: QueueVersion) => Promise<void>
  editQueue: (
    edit: Extract<LibraryQueueEdit, { kind: 'remove' | 'move' | 'clear' }>,
    expected: QueueVersion
  ) => Promise<void>
  duplicateEntry: (entryId: string, next: boolean, expected: QueueVersion) => Promise<void>
  refreshQueue: () => Promise<void>
}>()
const emit = defineEmits<{
  addToPlaylist: [track: QueuePlaylistEntry]
  savePlaylist: []
  openSessions: []
}>()
const viewport = useLibraryQueueViewport({
  snapshot: toRef(props, 'snapshot'),
  contentRevision: toRef(props, 'contentRevision'),
  readPage: (page) => props.readPage(page)
})
const {
  containerRef,
  visibleItems,
  loading,
  error,
  totalHeight,
  translateY,
  onScroll,
  scrollToCurrent
} = viewport
const actionError = ref(''),
  pending = ref(false),
  announcement = ref('')
const dragged = ref<{ entryId: string; expected: QueueVersion } | null>(null)
let disposed = false
onScopeDispose(() => {
  disposed = true
})
watch(
  () => [props.snapshot?.id, props.snapshot?.revision],
  () => {
    dragged.value = null
  }
)
watch(
  () => props.snapshot?.id,
  () => {
    actionError.value = ''
    announcement.value = ''
  }
)
const total = computed(() => props.snapshot?.total ?? 0)
const disabled = computed(() => props.busy || pending.value)
const message = computed(() => actionError.value || error.value)
const selectedEntryId = computed(() => props.snapshot?.selectedEntryId)

function setContainerRef(element: Element | ComponentPublicInstance | null): void {
  containerRef.value = element instanceof HTMLElement ? element : null
}

function version(row?: LibraryQueueRow): QueueVersion {
  const snapshot = props.snapshot
  if (!snapshot || (row && (row.queueId !== snapshot.id || row.revision !== snapshot.revision)))
    throw new Error('播放队列已变化，请刷新后重试')
  return { id: snapshot.id, revision: snapshot.revision }
}

function action(work: () => Promise<void>): void {
  if (disabled.value) return
  pending.value = true
  actionError.value = ''
  void Promise.resolve()
    .then(work)
    .catch((reason) => {
      if (!disposed) actionError.value = reason instanceof Error ? reason.message : String(reason)
    })
    .finally(() => {
      pending.value = false
    })
}

function play(row: LibraryQueueRow): void {
  if (row.state !== 'ready') return
  action(() => props.playEntry(row.queueEntryId, version(row)))
}

function remove(row: LibraryQueueRow): void {
  action(() => props.editQueue({ kind: 'remove', entryIds: [row.queueEntryId] }, version(row)))
}

function insert(row: LibraryQueueRow, next: boolean): void {
  if (row.state !== 'ready') return
  action(() => props.duplicateEntry(row.queueEntryId, next, version(row)))
}

function clear(): void {
  action(() => props.editQueue({ kind: 'clear' }, version()))
}

function retry(): void {
  action(async () => {
    await props.refreshQueue()
    if (!disposed) viewport.retry()
  })
}

async function readEntry(index: number, expected: QueueVersion) {
  const page = await props.readPage(Math.floor(index / LIBRARY_PAGE_SIZE))
  const current = version()
  if (
    current.id !== expected.id ||
    current.revision !== expected.revision ||
    !page ||
    page.revision !== expected.revision ||
    page.libraryRevision < props.contentRevision
  )
    throw new Error('播放队列已变化，请刷新后重试')
  return page.items[index % LIBRARY_PAGE_SIZE]
}

function addToPlaylist(row: LibraryQueueRow): void {
  action(async () => {
    const entry = await readEntry(row.index, version(row))
    if (!entry?.track || entry.queueEntryId !== row.queueEntryId)
      throw new Error('该曲目已不可用，请刷新队列')
    if (!disposed) emit('addToPlaylist', { ...entry.track, queueEntryId: entry.queueEntryId, queue: version(row) })
  })
}

function moveBy(row: LibraryQueueRow, direction: -1 | 1): void {
  if (row.state === 'loading' || row.index + direction < 0 || row.index + direction >= total.value)
    return
  action(async () => {
    const expected = version(row)
    const beforeIndex = direction === -1 ? row.index - 1 : row.index + 2
    const before = beforeIndex < total.value ? await readEntry(beforeIndex, expected) : null
    await props.editQueue(
      { kind: 'move', entryId: row.queueEntryId, beforeEntryId: before?.queueEntryId ?? null },
      expected
    )
    announcement.value = `已${direction === -1 ? '上移' : '下移'} ${row.title}`
  })
}

function dragStart(event: DragEvent, row: LibraryQueueRow): void {
  if (disabled.value || row.state === 'loading') {
    event.preventDefault()
    return
  }
  dragged.value = { entryId: row.queueEntryId, expected: version(row) }
  event.dataTransfer?.setData('text/plain', row.queueEntryId)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function dragOver(event: DragEvent, row: LibraryQueueRow): void {
  if (
    !dragged.value ||
    disabled.value ||
    row.state === 'loading' ||
    dragged.value.entryId === row.queueEntryId
  )
    return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

function drop(event: DragEvent, row: LibraryQueueRow): void {
  event.preventDefault()
  const source = dragged.value
  dragged.value = null
  if (!source || source.entryId === row.queueEntryId) return
  action(async () => {
    const expected = version(row)
    if (source.expected.id !== expected.id || source.expected.revision !== expected.revision)
      throw new Error('播放队列已变化，请重新拖动')
    await props.editQueue(
      { kind: 'move', entryId: source.entryId, beforeEntryId: row.queueEntryId },
      expected
    )
  })
}
</script>

<template>
  <section
    class="playlist-panel library-queue-drawer"
    :class="{ 'panel-glass': glass }"
    aria-label="播放队列"
  >
    <div class="playlist-header">
      <div class="playlist-heading">
        <div class="playlist-heading-row">
          <span class="playlist-heading-title">播放列表</span>
          <span class="playlist-count">{{ total.toLocaleString() }} 首</span>
        </div>
        <span class="playlist-heading-subtitle">
          <template v-if="snapshot && snapshot.index >= 0"
            >正在播放第 {{ (snapshot.index + 1).toLocaleString() }} 首</template
          >
          <template v-else-if="busy">正在准备队列…</template>
          <template v-else>从曲库播放歌曲，开始新的队列</template>
        </span>
      </div>
      <div class="playlist-tools" aria-label="队列操作">
        <button
          class="playlist-tool-btn"
          type="button"
          :disabled="total === 0"
          @click="emit('savePlaylist')"
        >
          存为歌单
        </button>
        <button
          class="playlist-tool-btn"
          type="button"
          title="保存、恢复会话与查看播放顺序"
          @click="emit('openSessions')"
        >
          会话
        </button>
        <button class="playlist-tool-btn" type="button" :disabled="disabled" @click="retry">
          刷新
        </button>
        <button
          class="playlist-tool-btn"
          type="button"
          aria-label="定位到正在播放"
          :disabled="!selectedEntryId"
          @click="scrollToCurrent"
        >
          定位
        </button>
        <button
          class="playlist-tool-btn playlist-tool-danger"
          type="button"
          :disabled="disabled || total === 0"
          @click="clear"
        >
          清空
        </button>
      </div>
    </div>
    <div v-if="message" class="library-queue-error" role="alert">
      <span>{{ message }}</span>
      <button class="playlist-tool-btn" type="button" :disabled="disabled" @click="retry">
        重试
      </button>
    </div>
    <div v-if="total === 0 && !busy && !message" class="playlist-empty">
      <span class="playlist-empty-title">队列还是空的</span>
      <span class="playlist-empty-hint">播放任意歌曲后，会在这里排队等候</span>
    </div>
    <div
      :ref="setContainerRef"
      class="playlist-list"
      role="list"
      aria-label="队列歌曲"
      :aria-busy="loading"
      @scroll.passive="onScroll"
    >
      <div class="playlist-virtual-spacer" :style="{ height: `${totalHeight}px` }">
        <div class="playlist-virtual-window" :style="{ transform: `translateY(${translateY}px)` }">
          <div
            v-for="item in visibleItems"
            :key="item.queueEntryId"
            class="playlist-item library-queue-row"
            :class="{
              active: item.queueEntryId === selectedEntryId,
              dragging: item.queueEntryId === dragged?.entryId,
              unavailable: item.state !== 'ready'
            }"
            role="listitem"
            :aria-posinset="item.index + 1"
            :aria-setsize="total"
            :data-queue-index="item.index"
            :draggable="!disabled && item.state !== 'loading'"
            @dragstart="dragStart($event, item)"
            @dragover="dragOver($event, item)"
            @drop="drop($event, item)"
            @dragend="dragged = null"
            @keydown.alt.up.prevent.stop="moveBy(item, -1)"
            @keydown.alt.down.prevent.stop="moveBy(item, 1)"
          >
            <button
              class="library-queue-play"
              type="button"
              :disabled="disabled || item.state !== 'ready'"
              :aria-current="item.queueEntryId === selectedEntryId ? 'true' : undefined"
              :aria-label="`播放 ${item.title} - ${item.artist}`"
              title="播放；Alt + ↑/↓ 调整顺序"
              @click="play(item)"
            >
              <span class="playlist-index">
                <span
                  v-if="item.queueEntryId === selectedEntryId"
                  class="playing-bars"
                  :class="{ paused: !isPlaying }"
                  aria-hidden="true"
                  ><i></i><i></i><i></i
                ></span>
                <span v-else class="playlist-index-num">{{ item.index + 1 }}</span>
              </span>
              <CoverImg
                :cover="item.cover"
                :core-track-id="resolveCoreArtwork && !item.cover ? item.id || undefined : undefined"
                :identity="item.id"
                class="playlist-cover"
                alt=""
              />
              <span class="playlist-info"
                ><span class="playlist-title">{{ item.title }}</span
                ><span class="playlist-artist">{{ item.artist }}</span></span
              >
            </button>
            <div v-if="item.state !== 'loading'" class="playlist-row-actions">
              <button
                type="button"
                :disabled="disabled || item.state !== 'ready'"
                :aria-label="`将 ${item.title} 设为下一首`"
                title="下一首播放"
                @click="insert(item, true)"
              >
                <PlaybackIcon name="next" aria-hidden="true" />
              </button>
              <button
                type="button"
                :disabled="disabled || item.state !== 'ready'"
                :aria-label="`将 ${item.title} 添加到队尾`"
                title="添加到队尾"
                @click="insert(item, false)"
              >
                <i class="pi pi-plus" aria-hidden="true"></i>
              </button>
              <button
                type="button"
                :disabled="disabled || item.state !== 'ready'"
                :aria-label="`将 ${item.title} 添加到歌单`"
                title="添加到歌单"
                @click="addToPlaylist(item)"
              >
                <i class="pi pi-list-check" aria-hidden="true"></i>
              </button>
              <button
                class="row-action-danger"
                type="button"
                :disabled="disabled"
                :aria-label="`从队列移除 ${item.title}`"
                title="从队列移除"
                @click="remove(item)"
              >
                <i class="pi pi-times" aria-hidden="true"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <span class="library-queue-announcement" aria-live="polite">{{ announcement }}</span>
  </section>
</template>

<style scoped src="./PlaybackQueueDrawer.css"></style>
<style scoped>
.library-queue-play {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
  flex: 1;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  color: inherit;
  cursor: pointer;
}
.library-queue-play .playlist-info {
  display: flex;
  flex-direction: column;
}
.library-queue-play:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
  border-radius: 8px;
}
.library-queue-play:disabled {
  cursor: default;
}
.unavailable .playlist-info {
  opacity: 0.65;
}
.library-queue-row {
  padding-left: 10px;
}
.playlist-row-actions button:disabled {
  opacity: 0.4;
  cursor: default;
}
.library-queue-error {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 20px;
  font-size: var(--te-font-size-body, 14px);
  color: var(--te-danger-500, #dc2626);
}
.library-queue-error span {
  overflow-wrap: anywhere;
}
.library-queue-announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
@media (hover: none) {
  .playlist-row-actions {
    opacity: 1;
    transform: none;
  }
}
</style>
