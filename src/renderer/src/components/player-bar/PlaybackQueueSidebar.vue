<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  toRef,
  watch,
  type ComponentPublicInstance
} from 'vue'
import type { Track, QueuePlaybackOrigin } from '../../types/music'
import {
  MAX_PLAYBACK_ORDER_ENTRIES,
  type PlaybackOrderEntry
} from '../../../../shared/queueWorkspace.ts'
import { useEscapeToClose } from '../../app/useDismissLayer.ts'
import { resolveQueuePlaybackOrigin } from '../../utils/queuePlaybackOrigin.ts'
import { formatTime } from '../../utils/playerTime.ts'
import CoverImg from '../CoverImg.vue'
import ThemeIcon from '../ThemeIcon.vue'
import NativeContextMenu from '../NativeContextMenu.vue'
import { usePlaybackQueueVirtualScroll } from './usePlaybackQueueVirtualScroll'

const props = defineProps<{
  open: boolean
  queue: Track[]
  queueIndex: number
  isPlaying: boolean
  summary: string
  canUndo: boolean
  undoLabel: string
  draggedEntryId: string | null
  liquidMaterial?: boolean
  history?: readonly PlaybackOrderEntry[]
  historyLoading?: boolean
}>()
const emit = defineEmits<{
  close: []
  play: [entryId: string]
  next: [entryId: string]
  tail: [entryId: string]
  remove: [entryId: string]
  addPlaylist: [entryId: string]
  move: [entryId: string, direction: -1 | 1]
  clear: []
  undo: []
  sessions: []
  replayHistory: [entryId: string]
  openSource: [origin: QueuePlaybackOrigin]
  dragStart: [event: DragEvent, entryId: string]
  dragOver: [event: DragEvent, entryId: string]
  drop: [event: DragEvent, entryId: string]
  dragEnd: []
}>()
type Selection = { kind: 'queue' | 'history'; id: string }
type MenuTarget = Selection | { kind: 'global' }
type QueueAction = 'next' | 'tail' | 'addPlaylist' | 'remove' | 'up' | 'down'
const panelRef = ref<HTMLElement | null>(null)
const prefixRef = ref<HTMLElement | null>(null)
const fontSize = ref(14)
const rowHeight = computed(() => Math.max(72, Math.ceil(fontSize.value * (36 / 7))))
const listOffset = ref(0)
const historyExpanded = ref(false)
const showFullQueue = ref(false)
const selected = ref<Selection | null>(null)
const menuTarget = ref<MenuTarget | null>(null)
const menuOpen = computed(() => menuTarget.value !== null)
// Derive fallback identities before slicing so a legacy queue keeps the same identity in either view.
const queueTracks = computed(() =>
  props.queue.map((track, index) =>
    track.queueEntryId
      ? (track as Track & { queueEntryId: string })
      : { ...track, queueEntryId: `queue:${track.id}:${index}` }
  )
)
const queueById = computed(
  () => new Map(queueTracks.value.map((track) => [track.queueEntryId, track]))
)
const currentTrack = computed(() => queueTracks.value[props.queueIndex] ?? null)
const viewTracks = computed(() =>
  showFullQueue.value
    ? queueTracks.value
    : queueTracks.value.slice(props.queueIndex >= 0 ? props.queueIndex + 1 : 0)
)
// Selection does not scroll. Only keyboard navigation and the locate command reveal a row.
const passiveRevealIndex = ref(-1)
const { containerRef, visibleItems, totalHeight, translateY, onScroll, scrollToIndex } =
  usePlaybackQueueVirtualScroll(
    viewTracks,
    passiveRevealIndex,
    toRef(props, 'open'),
    rowHeight,
    listOffset
  )
const rows = computed(() =>
  visibleItems.value.map((item) => ({
    ...item,
    duration: viewTracks.value[item.index]?.duration ?? 0,
    origin: resolveQueuePlaybackOrigin(viewTracks.value[item.index])
  }))
)
const currentOrigin = computed(() => resolveQueuePlaybackOrigin(currentTrack.value))
const historyRows = computed(() =>
  (props.history ?? []).slice(-MAX_PLAYBACK_ORDER_ENTRIES).map((entry) => ({
    ...entry,
    origin: resolveQueuePlaybackOrigin(entry.track)
  }))
)
const menuQueueTrack = computed(() =>
  menuTarget.value?.kind === 'queue' ? queueById.value.get(menuTarget.value.id) : undefined
)
const menuQueueIndex = computed(() =>
  menuTarget.value?.kind === 'queue'
    ? queueTracks.value.findIndex(
        (track) => track.queueEntryId === (menuTarget.value as Selection).id
      )
    : -1
)
const menuHistoryEntry = computed(() =>
  menuTarget.value?.kind === 'history'
    ? historyRows.value.find((entry) => entry.id === (menuTarget.value as Selection).id)
    : undefined
)
const menuOrigin = computed(() =>
  resolveQueuePlaybackOrigin(menuQueueTrack.value ?? menuHistoryEntry.value?.track)
)
const rowRefs = new Map<string, HTMLElement>()
let opener: HTMLElement | null = null
let menuOpener: HTMLElement | null = null
let menuRestoreFocus = true
let fontObserver: MutationObserver | null = null
let prefixObserver: ResizeObserver | null = null

function usable(element: HTMLElement | null): element is HTMLElement {
  return (
    !!element?.isConnected &&
    !element.closest('[inert]') &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === 'visible'
  )
}
function restoreOpener(): void {
  if (usable(opener)) {
    opener.focus({ preventScroll: true })
    return
  }
  const currentToggle = document.querySelector<HTMLButtonElement>(
    '.player-bar-shell button[aria-controls="playback-queue-sidebar"]'
  )
  if (usable(currentToggle)) {
    currentToggle.focus({ preventScroll: true })
    return
  }
  const titleControl = [...document.querySelectorAll<HTMLButtonElement>('.title-bar button')].find(
    usable
  )
  titleControl?.focus({ preventScroll: true })
}
function setContainer(element: Element | ComponentPublicInstance | null): void {
  containerRef.value = element instanceof HTMLElement ? element : null
}
function registerQueueRow(id: string, element: Element | ComponentPublicInstance | null): void {
  if (element instanceof HTMLElement) rowRefs.set(id, element)
  else rowRefs.delete(id)
}
function measureFont(): void {
  if (panelRef.value) fontSize.value = parseFloat(getComputedStyle(panelRef.value).fontSize) || 14
}
function measurePrefix(): void {
  listOffset.value = prefixRef.value?.getBoundingClientRect().height ?? 0
}
function isSelected(kind: Selection['kind'], id: string): boolean {
  return selected.value?.kind === kind && selected.value.id === id
}
function durationLabel(duration: number): string {
  return Number.isFinite(duration) && duration > 0 ? formatTime(duration) : '–:–'
}
async function selectQueueEntry(id: string, focus = false): Promise<void> {
  if (!queueById.value.has(id)) return
  selected.value = { kind: 'queue', id }
  if (!focus) return
  const index = viewTracks.value.findIndex((track) => track.queueEntryId === id)
  await nextTick()
  if (index >= 0) scrollToIndex(index)
  await nextTick()
  const row = rowRefs.get(id)
  if (usable(row ?? null)) {
    row!.focus({ preventScroll: true })
    if (index < 0) row!.scrollIntoView({ block: 'nearest' })
  }
}
function playEntry(id: string): void {
  if (queueById.value.has(id)) emit('play', id)
}
function replayHistory(id: string): void {
  if (historyRows.value.some((entry) => entry.id === id)) emit('replayHistory', id)
}
function openMenu(target: MenuTarget, event: Event): void {
  if (menuOpen.value) return
  if (target.kind !== 'global') selected.value = target
  menuRestoreFocus = true
  const control = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  menuOpener = control?.matches('.queue-item')
    ? control.querySelector<HTMLElement>('.queue-track')
    : control
  menuTarget.value = target
}
async function closeMenu(restoreFocus = true): Promise<void> {
  const shouldRestoreFocus = restoreFocus && menuRestoreFocus
  const previousOpener = menuOpener
  menuTarget.value = null
  menuOpener = null
  if (!shouldRestoreFocus) {
    void nextTick(() => {
      menuRestoreFocus = true
    })
    return
  }
  await nextTick()
  if (usable(previousOpener)) {
    previousOpener.focus({ preventScroll: true })
  } else {
    const selectedRow = selected.value?.kind === 'queue' ? rowRefs.get(selected.value.id) : null
    if (usable(selectedRow ?? null)) selectedRow!.focus({ preventScroll: true })
    else containerRef.value?.focus({ preventScroll: true })
  }
}
useEscapeToClose(menuOpen, () => void closeMenu())
function queueMenuAction(action: QueueAction): void {
  const track = menuQueueTrack.value
  if (!track) return
  const id = track.queueEntryId
  if (action === 'up' || action === 'down') emit('move', id, action === 'up' ? -1 : 1)
  else if (action === 'next') emit('next', id)
  else if (action === 'tail') emit('tail', id)
  else if (action === 'addPlaylist') {
    menuRestoreFocus = false
    emit('addPlaylist', id)
  } else emit('remove', id)
}
function openMenuSource(): void {
  if (menuOrigin.value) {
    menuRestoreFocus = false
    emit('openSource', menuOrigin.value.target)
  }
}
function openSessions(): void {
  menuRestoreFocus = false
  emit('sessions')
}
function locateCurrent(): void {
  menuRestoreFocus = false
  if (currentTrack.value) void selectQueueEntry(currentTrack.value.queueEntryId, true)
}
async function toggleFullQueue(): Promise<void> {
  showFullQueue.value = !showFullQueue.value
  await nextTick()
  if (containerRef.value) {
    containerRef.value.scrollTop = 0
    containerRef.value.dispatchEvent(new Event('scroll'))
  }
}
function onQueueKey(event: KeyboardEvent, id: string): void {
  if (event.target !== event.currentTarget || menuOpen.value) return
  if (event.key === 'Enter') {
    event.preventDefault()
    playEntry(id)
    return
  }
  if (event.key === 'Delete') {
    event.preventDefault()
    if (queueById.value.has(id)) emit('remove', id)
    return
  }
  if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
    event.preventDefault()
    openMenu({ kind: 'queue', id }, event)
    return
  }
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const ids = [
    ...(!showFullQueue.value && currentTrack.value ? [currentTrack.value.queueEntryId] : []),
    ...viewTracks.value.map((track) => track.queueEntryId)
  ]
  const index = ids.indexOf(id)
  const nextIndex =
    event.key === 'Home'
      ? !showFullQueue.value && currentTrack.value && id !== currentTrack.value.queueEntryId
        ? 1
        : 0
      : event.key === 'End'
        ? ids.length - 1
        : Math.min(ids.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))
  if (ids[nextIndex]) void selectQueueEntry(ids[nextIndex], true)
}
function onHistoryKey(event: KeyboardEvent, id: string): void {
  if (event.target !== event.currentTarget || menuOpen.value) return
  if (event.key === 'Enter') {
    event.preventDefault()
    replayHistory(id)
    return
  }
  if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
    event.preventDefault()
    openMenu({ kind: 'history', id }, event)
    return
  }
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = historyRows.value.findIndex((entry) => entry.id === id)
  const nextIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? historyRows.value.length - 1
        : Math.min(
            historyRows.value.length - 1,
            Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1))
          )
  const next = historyRows.value[nextIndex]
  if (!next) return
  selected.value = { kind: 'history', id: next.id }
  const button = panelRef.value?.querySelector<HTMLElement>(
    `[data-history-entry-id="${CSS.escape(next.id)}"] .history-track`
  )
  button?.focus({ preventScroll: true })
  button?.scrollIntoView({ block: 'nearest' })
}
watch(
  () => props.open,
  async (open) => {
    if (open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const initial = currentTrack.value ?? viewTracks.value[0]
      selected.value = initial ? { kind: 'queue', id: initial.queueEntryId } : null
      await nextTick()
      measureFont()
      measurePrefix()
      if (containerRef.value) {
        containerRef.value.scrollTop = 0
        containerRef.value.dispatchEvent(new Event('scroll'))
        if (showFullQueue.value && currentTrack.value) scrollToIndex(props.queueIndex)
      }
      panelRef.value
        ?.querySelector<HTMLButtonElement>('.queue-close')
        ?.focus({ preventScroll: true })
    } else {
      void closeMenu(false)
      if (menuRestoreFocus && panelRef.value?.contains(document.activeElement)) restoreOpener()
    }
  },
  { flush: 'pre', immediate: true }
)
watch(queueById, (queue, previousQueue) => {
  if (selected.value?.kind === 'queue' && !queueById.value.has(selected.value.id)) {
    const removedId = selected.value.id
    const restoreRowFocus = rowRefs.get(removedId)?.contains(document.activeElement) ?? false
    const previousIds = [...previousQueue.keys()]
    const removedIndex = previousIds.indexOf(removedId)
    const selectableIds = new Set([
      ...viewTracks.value.map((track) => track.queueEntryId),
      ...(currentTrack.value ? [currentTrack.value.queueEntryId] : [])
    ])
    const nextId = [
      ...previousIds.slice(removedIndex + 1),
      ...previousIds.slice(0, removedIndex).reverse()
    ].find((id) => queue.has(id) && selectableIds.has(id))
    const fallback =
      (nextId ? queue.get(nextId) : null) ?? currentTrack.value ?? viewTracks.value[0]
    selected.value = fallback ? { kind: 'queue', id: fallback.queueEntryId } : null
    if (restoreRowFocus) {
      if (fallback) void selectQueueEntry(fallback.queueEntryId, true)
      else void nextTick(() => containerRef.value?.focus({ preventScroll: true }))
    }
  }
  if (menuTarget.value?.kind === 'queue' && !queueById.value.has(menuTarget.value.id)) {
    void closeMenu()
  }
})
watch(historyRows, () => {
  if (
    menuTarget.value?.kind === 'history' &&
    !historyRows.value.some((entry) => entry.id === (menuTarget.value as Selection).id)
  ) {
    void closeMenu()
  }
})
watch(
  prefixRef,
  (element) => {
    prefixObserver?.disconnect()
    if (element) prefixObserver?.observe(element)
    measurePrefix()
  },
  { flush: 'post' }
)
onMounted(() => {
  measureFont()
  measurePrefix()
  fontObserver = new MutationObserver(measureFont)
  fontObserver.observe(document.documentElement, { attributes: true })
  prefixObserver = new ResizeObserver(measurePrefix)
  if (prefixRef.value) prefixObserver.observe(prefixRef.value)
})
onBeforeUnmount(() => {
  fontObserver?.disconnect()
  prefixObserver?.disconnect()
})
</script>

<template>
  <Transition name="queue-side">
    <aside
      v-if="open"
      id="playback-queue-sidebar"
      ref="panelRef"
      class="queue-sidebar overlay-side-panel"
      data-te-material="navigation"
      :class="{ 'overlay-side-panel-liquid': liquidMaterial }"
      aria-label="播放队列"
      :style="{ '--queue-row-height': `${rowHeight}px` }"
      @pointerdown.stop
    >
      <header class="queue-header">
        <h2>播放队列</h2>
        <button
          type="button"
          class="queue-global-more"
          aria-label="播放队列更多操作"
          aria-haspopup="menu"
          :aria-expanded="menuTarget?.kind === 'global'"
          @click="openMenu({ kind: 'global' }, $event)"
        >
          <span aria-hidden="true">⋯</span>
        </button>
        <button type="button" class="queue-close" aria-label="关闭播放队列" @click="emit('close')">
          <ThemeIcon icon-slot="library.clear" />
        </button>
      </header>
      <div
        :ref="setContainer"
        class="queue-list"
        tabindex="-1"
        aria-label="歌曲与播放历史"
        @scroll.passive="onScroll"
      >
        <div ref="prefixRef" class="queue-prefix">
          <section class="queue-history" aria-label="播放历史">
            <button
              type="button"
              class="queue-history-toggle"
              :aria-label="historyExpanded ? '隐藏历史记录' : '显示历史记录'"
              :aria-expanded="historyExpanded"
              aria-controls="queue-history-items"
              @click="historyExpanded = !historyExpanded"
            >
              <span aria-hidden="true">{{ historyExpanded ? '⌄' : '›' }}</span>
              <span>历史记录</span>
              <span class="queue-count">{{ historyRows.length }}</span>
            </button>
            <div v-if="historyExpanded" id="queue-history-items" role="list">
              <p v-if="historyLoading" class="queue-history-empty" role="status">
                正在读取历史记录…
              </p>
              <p v-else-if="!historyRows.length" class="queue-history-empty" role="status">
                还没有播放历史
              </p>
              <div
                v-for="entry in historyRows"
                :key="entry.id"
                class="queue-item queue-history-item"
                :class="{ selected: isSelected('history', entry.id) }"
                :data-history-entry-id="entry.id"
                role="listitem"
                @contextmenu.prevent="openMenu({ kind: 'history', id: entry.id }, $event)"
              >
                <button
                  type="button"
                  class="queue-track history-track"
                  :aria-label="`${entry.track.title} - ${entry.track.artist}`"
                  :aria-pressed="isSelected('history', entry.id)"
                  @click="selected = { kind: 'history', id: entry.id }"
                  @dblclick="replayHistory(entry.id)"
                  @keydown="onHistoryKey($event, entry.id)"
                >
                  <CoverImg :cover="null" :identity="entry.track.id" class="queue-cover" alt="" />
                  <span class="queue-info">
                    <span class="queue-title">{{ entry.track.title }}</span>
                    <span class="queue-artist">{{ entry.track.artist }}</span>
                  </span>
                </button>
                <span class="queue-duration">{{ durationLabel(entry.track.duration) }}</span>
                <button
                  type="button"
                  class="queue-row-more"
                  :aria-label="`${entry.track.title} 更多操作`"
                  aria-haspopup="menu"
                  @click="openMenu({ kind: 'history', id: entry.id }, $event)"
                >
                  <span aria-hidden="true">⋯</span>
                </button>
                <button
                  v-if="entry.origin"
                  type="button"
                  class="queue-source"
                  :title="`查看来源：${entry.origin.label}`"
                  :aria-label="`查看播放来源：${entry.origin.label}`"
                  @click="emit('openSource', entry.origin.target)"
                >
                  {{ entry.origin.label }}
                </button>
              </div>
            </div>
          </section>
          <section
            v-if="currentTrack && !showFullQueue"
            class="queue-current"
            aria-label="正在播放"
          >
            <h3>正在播放 <span v-if="!isPlaying" class="queue-count">已暂停</span></h3>
            <div role="list">
              <div
                v-for="track in [currentTrack]"
                :key="track.queueEntryId"
                class="queue-item active"
                :class="{
                  selected: isSelected('queue', track.queueEntryId),
                  dragging: draggedEntryId === track.queueEntryId
                }"
                :data-queue-entry-id="track.queueEntryId"
                aria-current="true"
                role="listitem"
                draggable="true"
                @contextmenu.prevent="openMenu({ kind: 'queue', id: track.queueEntryId }, $event)"
                @dragstart="emit('dragStart', $event, track.queueEntryId)"
                @dragover="emit('dragOver', $event, track.queueEntryId)"
                @drop="emit('drop', $event, track.queueEntryId)"
                @dragend="emit('dragEnd')"
              >
                <button
                  :ref="(element) => registerQueueRow(track.queueEntryId, element)"
                  type="button"
                  class="queue-track"
                  :aria-label="`${track.title} - ${track.artist}`"
                  :aria-pressed="isSelected('queue', track.queueEntryId)"
                  :tabindex="isSelected('queue', track.queueEntryId) ? 0 : -1"
                  @click="selectQueueEntry(track.queueEntryId)"
                  @dblclick="playEntry(track.queueEntryId)"
                  @keydown="onQueueKey($event, track.queueEntryId)"
                >
                  <CoverImg :cover="track.cover" :identity="track.id" class="queue-cover" alt="" />
                  <span class="queue-info">
                    <span class="queue-title">{{ track.title }}</span>
                    <span class="queue-artist">{{ track.artist }}</span>
                  </span>
                </button>
                <span class="queue-duration">{{ durationLabel(track.duration) }}</span>
                <button
                  type="button"
                  class="queue-row-more"
                  :aria-label="`${track.title} 更多操作`"
                  aria-haspopup="menu"
                  @click="openMenu({ kind: 'queue', id: track.queueEntryId }, $event)"
                >
                  <span aria-hidden="true">⋯</span>
                </button>
                <button
                  v-if="currentOrigin"
                  type="button"
                  class="queue-source"
                  :title="`查看来源：${currentOrigin.label}`"
                  :aria-label="`查看播放来源：${currentOrigin.label}`"
                  @click="emit('openSource', currentOrigin.target)"
                >
                  {{ currentOrigin.label }}
                </button>
              </div>
            </div>
          </section>
          <h3 class="queue-section-title">
            {{ showFullQueue ? '完整队列' : '接下来播放' }}
            <span class="queue-count">{{ viewTracks.length }} 首</span>
          </h3>
          <div v-if="!viewTracks.length" class="queue-empty" role="status">
            <ThemeIcon v-if="!queue.length" icon-slot="library.empty" />
            <span>{{ queue.length ? '没有待播歌曲' : '队列还是空的' }}</span>
            <small v-if="!queue.length">从曲库或流媒体播放歌曲，或在会话中恢复队列</small>
          </div>
        </div>
        <div class="queue-spacer" :style="{ height: `${totalHeight}px` }" role="list">
          <div class="queue-window" :style="{ transform: `translateY(${translateY}px)` }">
            <div
              v-for="item in rows"
              :key="item.queueEntryId"
              class="queue-item"
              :class="{
                active: item.queueEntryId === currentTrack?.queueEntryId,
                selected: isSelected('queue', item.queueEntryId),
                dragging: draggedEntryId === item.queueEntryId
              }"
              :data-queue-entry-id="item.queueEntryId"
              :aria-current="item.queueEntryId === currentTrack?.queueEntryId ? 'true' : undefined"
              role="listitem"
              draggable="true"
              @contextmenu.prevent="openMenu({ kind: 'queue', id: item.queueEntryId }, $event)"
              @dragstart="emit('dragStart', $event, item.queueEntryId)"
              @dragover="emit('dragOver', $event, item.queueEntryId)"
              @drop="emit('drop', $event, item.queueEntryId)"
              @dragend="emit('dragEnd')"
            >
              <button
                :ref="(element) => registerQueueRow(item.queueEntryId, element)"
                type="button"
                class="queue-track"
                :aria-label="`${item.title} - ${item.artist}`"
                :aria-pressed="isSelected('queue', item.queueEntryId)"
                :tabindex="isSelected('queue', item.queueEntryId) ? 0 : -1"
                @click="selectQueueEntry(item.queueEntryId)"
                @dblclick="playEntry(item.queueEntryId)"
                @keydown="onQueueKey($event, item.queueEntryId)"
              >
                <CoverImg :cover="item.cover" :identity="item.id" class="queue-cover" alt="" />
                <span class="queue-info">
                  <span class="queue-title">{{ item.title }}</span>
                  <span class="queue-artist">{{ item.artist }}</span>
                </span>
              </button>
              <span class="queue-duration">{{ durationLabel(item.duration) }}</span>
              <button
                type="button"
                class="queue-row-more"
                :aria-label="`${item.title} 更多操作`"
                aria-haspopup="menu"
                @click="openMenu({ kind: 'queue', id: item.queueEntryId }, $event)"
              >
                <span aria-hidden="true">⋯</span>
              </button>
              <button
                v-if="item.origin"
                type="button"
                class="queue-source"
                :title="`查看来源：${item.origin.label}`"
                :aria-label="`查看播放来源：${item.origin.label}`"
                @click="emit('openSource', item.origin.target)"
              >
                {{ item.origin.label }}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="queue-bottom-clearance" aria-hidden="true"></div>
    </aside>
  </Transition>
  <NativeContextMenu
    v-if="menuTarget"
    :key="menuTarget.kind === 'global' ? 'global' : `${menuTarget.kind}:${menuTarget.id}`"
    @close="closeMenu()"
  >
    <template v-if="menuTarget.kind === 'global'">
      <button class="menu-item" :disabled="!canUndo" @click="emit('undo')">
        撤销{{ undoLabel }}
      </button>
      <button class="menu-item" @click="openSessions">会话</button>
      <button class="menu-item" :disabled="!currentTrack" @click="locateCurrent">
        定位正在播放
      </button>
      <button class="menu-item" @click="toggleFullQueue">
        {{ showFullQueue ? '只看接下来' : '查看完整队列' }}
      </button>
      <button class="menu-item" :disabled="!queue.length" @click="emit('clear')">
        清空播放队列
      </button>
    </template>
    <template v-else-if="menuTarget.kind === 'queue'">
      <button class="menu-item" :disabled="!menuQueueTrack" @click="queueMenuAction('next')">
        下一首播放
      </button>
      <button class="menu-item" :disabled="!menuQueueTrack" @click="queueMenuAction('tail')">
        添加到队尾
      </button>
      <button class="menu-item" :disabled="!menuQueueTrack" @click="queueMenuAction('addPlaylist')">
        添加到歌单
      </button>
      <button v-if="menuOrigin" class="menu-item" @click="openMenuSource">查看来源</button>
      <button class="menu-item" :disabled="menuQueueIndex <= 0" @click="queueMenuAction('up')">
        上移
      </button>
      <button
        class="menu-item"
        :disabled="menuQueueIndex < 0 || menuQueueIndex >= queue.length - 1"
        @click="queueMenuAction('down')"
      >
        下移
      </button>
      <button class="menu-item" :disabled="!menuQueueTrack" @click="queueMenuAction('remove')">
        移除
      </button>
    </template>
    <template v-else>
      <button
        class="menu-item"
        :disabled="!menuHistoryEntry"
        @click="menuHistoryEntry && replayHistory(menuHistoryEntry.id)"
      >
        重新播放
      </button>
      <button v-if="menuOrigin" class="menu-item" @click="openMenuSource">查看来源</button>
    </template>
  </NativeContextMenu>
</template>

<style scoped>
.queue-sidebar {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-size: var(--te-font-size-body, 14px);
}
.queue-header {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--te-navigation-text) 10%, transparent);
}
.queue-header h2 {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: inherit;
  font-weight: var(--te-font-weight-control, 600);
}
.queue-sidebar button {
  font: inherit;
  color: inherit;
  cursor: pointer;
  border: 0;
  background: transparent;
}
.queue-sidebar button:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: -2px;
}
.queue-close,
.queue-global-more,
.queue-row-more {
  display: grid;
  place-items: center;
  width: max(28px, 2em);
  height: max(28px, 2em);
  padding: 4px;
  flex: none;
  border-radius: var(--te-control-radius-sm, 8px);
}
.queue-global-more,
.queue-row-more {
  font-size: 1.3em !important;
  line-height: 1;
}
.queue-close:hover,
.queue-global-more:hover,
.queue-row-more:hover {
  background: var(--te-navigation-hover-bg, var(--te-hover-bg));
}
.queue-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-inline: 8px;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.queue-prefix {
  padding-bottom: 4px;
}
.queue-history-toggle {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 8px;
  padding: 12px 4px;
  text-align: left;
  font-size: 0.857143em !important;
  font-weight: 600 !important;
}
.queue-history-toggle > span:first-child {
  width: 14px;
  text-align: center;
}
.queue-count {
  color: var(--te-neutral-500);
  font-weight: 400;
}
.queue-history-toggle .queue-count {
  margin-left: auto;
}
.queue-current h3,
.queue-section-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  padding: 12px 4px 6px;
  font-size: 0.857143em;
  font-weight: 600;
}
.queue-history-empty {
  margin: 0;
  padding: 8px 6px 16px;
  color: var(--te-neutral-500);
  font-size: 0.857143em;
}
.queue-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 20px 8px;
  text-align: center;
}
.queue-empty small {
  color: var(--te-neutral-500);
  font-size: 0.857143em;
}
.queue-spacer {
  position: relative;
}
.queue-window {
  position: absolute;
  inset: 0 0 auto;
}
.queue-item {
  height: var(--queue-row-height);
  box-sizing: border-box;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto max(28px, 2.6em);
  grid-template-rows: minmax(0, 1fr) auto;
  column-gap: 6px;
  row-gap: 2px;
  padding: 8px 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--te-navigation-text) 6%, transparent);
  border-radius: var(--te-control-radius-sm, 8px);
}
.queue-item.selected {
  background: var(--te-navigation-active-bg);
  color: var(--te-navigation-active-text, var(--te-navigation-text));
}
.queue-item.active .queue-title {
  font-weight: 600;
}
.queue-item.dragging {
  opacity: 0.45;
}
.queue-track {
  display: flex;
  grid-column: 1;
  grid-row: 1;
  gap: 8px;
  align-items: center;
  padding: 0;
  text-align: left;
  min-width: 0;
  width: 100%;
  height: 100%;
}
.queue-cover {
  width: 2.285714em;
  height: 2.285714em;
  border-radius: 5px;
  flex: none;
  object-fit: cover;
}
.queue-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.queue-title,
.queue-artist {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.2;
}
.queue-artist,
.queue-duration {
  color: var(--te-neutral-500);
  font-size: 0.857143em;
}
.queue-duration {
  grid-column: 2;
  grid-row: 1;
  align-self: center;
  max-width: 5ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.queue-row-more {
  grid-column: 3;
  grid-row: 1 / 3;
  align-self: center;
  width: 100%;
}
.queue-source {
  grid-column: 1 / 3;
  grid-row: 2;
  padding: 0 0 0 calc(2.285714em * 7 / 6 + 8px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  line-height: 1.2;
  font-size: 0.857143em !important;
  color: var(--te-primary-500) !important;
}
.queue-source:hover {
  text-decoration: underline;
}
.queue-bottom-clearance {
  height: max(0px, calc(var(--te-playbar-bottom-clearance, 0px) - 4px));
  flex: none;
  pointer-events: none;
}
.queue-side-enter-active,
.queue-side-leave-active {
  transition:
    transform var(--te-motion-panel) var(--te-ease-soft),
    opacity var(--te-motion-panel) var(--te-ease-soft);
}
.queue-side-enter-from,
.queue-side-leave-to {
  transform: translateX(calc(100% + 8px));
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .queue-side-enter-active,
  .queue-side-leave-active {
    transition: none;
  }
}
@media (forced-colors: active) {
  .queue-item.selected {
    background: Highlight;
    color: HighlightText;
  }
  .queue-item.selected .queue-artist,
  .queue-item.selected .queue-duration,
  .queue-item.selected .queue-source {
    color: HighlightText !important;
  }
}
</style>
