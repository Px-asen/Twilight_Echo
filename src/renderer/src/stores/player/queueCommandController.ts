import { computed, ref, shallowRef, watch, type Ref } from 'vue'
import type { Track } from '@renderer/types/music'
import type { PlayMode } from '@renderer/types/settings'
import { toPlaybackQueueSnapshot } from '@renderer/utils/playbackQueueVirtualization.ts'
import { shuffleArray } from '@renderer/utils/playerQueueUtils.ts'

export const MAX_QUEUE_UNDO_COMMANDS = 20
export const MAX_QUEUE_UNDO_ENTRIES = 80_000

type QueueChange =
  | { kind: 'add'; entryIds: Set<string> }
  | { kind: 'remove'; track: Track; index: number; originalIndex: number }
  | { kind: 'move'; entryId: string; index: number; originalIndex: number }
  | { kind: 'replace'; queue: Track[]; original: Track[] }

interface QueueCursor {
  entryId?: string
  position: number
}

interface QueueUndoEntry {
  revision: number
  label: string
  change: QueueChange
  cursor: QueueCursor
  retained: number
}

interface QueueCommandOptions {
  queue: Ref<Track[]>
  originalQueue: Ref<Track[]>
  currentTrack: Ref<Track | null>
  queueIndex: Ref<number>
  playMode: Ref<PlayMode>
  getPosition: () => number
  prepareSelection: (track: Track | null, position: number) => void
  onMutation: () => void
  onNotice?: (label: string, revision: number) => void
  beforeUndo?: () => void
}

function sameEntries(left: readonly Track[], right: readonly Track[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every(
    (track, index) =>
      track.queueEntryId === right[index].queueEntryId && track.id === right[index].id
  )
}

function moveEntry(tracks: readonly Track[], from: number, to: number): Track[] {
  const result = [...tracks]
  if (from < 0 || to < 0) return result
  const [track] = result.splice(from, 1)
  result.splice(to, 0, track)
  return result
}

export function createQueueCommandController(options: QueueCommandOptions) {
  const revision = ref(0)
  const undoStack = shallowRef<QueueUndoEntry[]>([])
  const canUndo = computed(() => undoStack.value.length > 0)
  const undoLabel = computed(() => undoStack.value.at(-1)?.label ?? '')
  let applying = false

  function invalidate(): void {
    revision.value++
    undoStack.value = []
  }

  const stops = [
    watch(
      [options.queue, options.originalQueue],
      ([queue, original], [previousQueue, previousOriginal]) => {
        if (applying) return
        if (!sameEntries(queue, previousQueue) || !sameEntries(original, previousOriginal)) {
          invalidate()
        }
      },
      { flush: 'sync' }
    ),
    watch(
      options.playMode,
      () => {
        if (!applying) invalidate()
      },
      { flush: 'sync' }
    )
  ]

  function cursor(): QueueCursor {
    return {
      entryId: options.currentTrack.value?.queueEntryId,
      position: options.getPosition()
    }
  }

  function apply(
    queue: Track[],
    original: Track[],
    index: number,
    restoreCursor?: QueueCursor,
    select = true
  ): void {
    applying = true
    try {
      const activeId = options.currentTrack.value?.queueEntryId
      const activeIndex = activeId
        ? queue.findIndex((track) => track.queueEntryId === activeId)
        : -1
      const savedIndex = restoreCursor?.entryId
        ? queue.findIndex((track) => track.queueEntryId === restoreCursor.entryId)
        : -1
      const nextIndex = !select
        ? index
        : activeIndex >= 0
          ? activeIndex
          : savedIndex >= 0
            ? savedIndex
            : index
      options.queue.value = queue
      options.originalQueue.value = original
      options.queueIndex.value = queue.length
        ? Math.max(0, Math.min(nextIndex, queue.length - 1))
        : -1
      if (select && activeIndex < 0) {
        options.prepareSelection(
          queue[options.queueIndex.value] ?? null,
          savedIndex >= 0 ? restoreCursor!.position : 0
        )
      }
      revision.value++
    } finally {
      applying = false
    }
  }

  function remember(entry: Omit<QueueUndoEntry, 'revision'>): void {
    const stack = [...undoStack.value, { ...entry, revision: revision.value }]
    let retained = stack.reduce((sum, item) => sum + item.retained, 0)
    while (stack.length > MAX_QUEUE_UNDO_COMMANDS || retained > MAX_QUEUE_UNDO_ENTRIES) {
      retained -= stack.shift()!.retained
    }
    undoStack.value = stack
    options.onNotice?.(entry.label, revision.value)
  }

  function add(
    tracks: readonly Track[],
    index: number,
    originalIndex: number,
    settings: { shuffle?: boolean; undoable?: boolean } = {}
  ): Track[] {
    if (!tracks.length) return []
    const additions = tracks.map((track) =>
      toPlaybackQueueSnapshot({ ...track, queueEntryId: `queue:${crypto.randomUUID()}` })
    )
    const before = cursor()
    const queue = [...options.queue.value]
    const original = [...options.originalQueue.value]
    queue.splice(index, 0, ...(settings.shuffle ? shuffleArray(additions) : additions))
    original.splice(originalIndex, 0, ...additions)
    apply(queue, original, options.queueIndex.value)
    if (settings.undoable === false) undoStack.value = []
    else
      remember({
        label: '加入队列',
        change: { kind: 'add', entryIds: new Set(additions.map((track) => track.queueEntryId!)) },
        cursor: before,
        retained: additions.length
      })
    options.onMutation()
    return additions
  }

  function remove(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= options.queue.value.length) return
    const track = options.queue.value[index]
    const before = cursor()
    const originalIndex = options.originalQueue.value.findIndex(
      (item) => item.queueEntryId === track.queueEntryId
    )
    const queue = [...options.queue.value]
    queue.splice(index, 1)
    const original = [...options.originalQueue.value]
    if (originalIndex >= 0) original.splice(originalIndex, 1)
    apply(queue, original, Math.min(index, queue.length - 1))
    remember({
      label: '移除歌曲',
      change: { kind: 'remove', track, index, originalIndex },
      cursor: before,
      retained: 1
    })
    options.onMutation()
  }

  function move(from: number, to: number): void {
    const queue = options.queue.value
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < 0 ||
      from >= queue.length ||
      to >= queue.length ||
      from === to
    )
      return
    const entryId = queue[from].queueEntryId!
    const originalIndex = options.originalQueue.value.findIndex(
      (track) => track.queueEntryId === entryId
    )
    const originalTarget = options.originalQueue.value.findIndex(
      (track) => track.queueEntryId === queue[to].queueEntryId
    )
    const before = cursor()
    apply(
      moveEntry(queue, from, to),
      moveEntry(options.originalQueue.value, originalIndex, originalTarget),
      options.queueIndex.value
    )
    remember({
      label: '调整顺序',
      change: { kind: 'move', entryId, index: from, originalIndex },
      cursor: before,
      retained: 1
    })
    options.onMutation()
  }

  function replace(
    queue: Track[],
    index: number,
    settings: { original?: Track[]; select?: boolean; synchronize?: boolean; label?: string } = {}
  ): void {
    const change: QueueChange = {
      kind: 'replace',
      queue: options.queue.value,
      original: options.originalQueue.value
    }
    const before = cursor()
    apply(queue, settings.original ?? [...queue], index, undefined, settings.select)
    remember({
      label: settings.label ?? (queue.length ? '替换队列' : '清空队列'),
      change,
      cursor: before,
      retained: change.queue.length + change.original.length
    })
    if (settings.synchronize !== false) options.onMutation()
  }

  function undo(expectedRevision = revision.value): boolean {
    const entry = undoStack.value.at(-1)
    if (!entry || expectedRevision !== revision.value || entry.revision !== revision.value)
      return false
    options.beforeUndo?.()
    let queue = options.queue.value
    let original = options.originalQueue.value
    const change = entry.change
    if (change.kind === 'add') {
      queue = queue.filter((track) => !change.entryIds.has(track.queueEntryId!))
      original = original.filter((track) => !change.entryIds.has(track.queueEntryId!))
    } else if (change.kind === 'remove') {
      queue = [...queue]
      original = [...original]
      queue.splice(change.index, 0, change.track)
      if (change.originalIndex >= 0) original.splice(change.originalIndex, 0, change.track)
    } else if (change.kind === 'move') {
      queue = moveEntry(
        queue,
        queue.findIndex((track) => track.queueEntryId === change.entryId),
        change.index
      )
      original = moveEntry(
        original,
        original.findIndex((track) => track.queueEntryId === change.entryId),
        change.originalIndex
      )
    } else {
      queue = change.queue
      original = change.original
    }
    apply(queue, original, options.queueIndex.value, entry.cursor)
    const stack = undoStack.value.slice(0, -1)
    if (stack.length)
      stack[stack.length - 1] = { ...stack[stack.length - 1], revision: revision.value }
    undoStack.value = stack
    options.onMutation()
    return true
  }

  return {
    revision,
    canUndo,
    undoLabel,
    undoStack,
    add,
    remove,
    move,
    replace,
    undo,
    invalidate,
    dispose: () => stops.forEach((stop) => stop())
  }
}
