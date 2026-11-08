import {
  computed,
  getCurrentInstance,
  getCurrentScope,
  onMounted,
  onScopeDispose,
  onUnmounted,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref
} from 'vue'
import type { Track } from '../../types/music'
import { hasDismissLayer } from '../../app/useDismissLayer.ts'
import {
  addSelectionRange,
  selectionContains,
  toggleSelectionPosition
} from '../../../../shared/librarySelectionRanges.ts'
import type { LibrarySelectionRange } from '../../../../shared/librarySelection.ts'

export type MultiSelectClickResult = 'select' | 'play'

type TrackListSource = ComputedRef<Track[]> | Ref<Track[]> | (() => Track[])

export type UseTrackMultiSelectOptions = {
  /** Current visible/ordered track list used for range and select-all. */
  tracks: TrackListSource
  /** Complete-query mode: no selected Track cache or synchronous materialization. */
  querySelection?: () => {
    total: number
    positionForKey(key: string): number | null
    prepareAll?: () => Promise<void>
    onError?: (error: unknown) => void
  } | null
  /** Occurrence identity for lists where one Track may appear more than once. */
  keyForTrack?: (track: Track) => string
  /**
   * Extra reactive sources that should clear selection when they change
   * (e.g. category, filter, search query).
   */
  resetSources?: Array<Ref<unknown> | ComputedRef<unknown> | (() => unknown)>
  /** When false, keyboard shortcuts are ignored (e.g. grid view). Default true. */
  enabled?: Ref<boolean> | ComputedRef<boolean> | (() => boolean)
  /** Keep explicitly selected rows while a bounded page changes. */
  preserveSelectedTracks?: Ref<boolean> | ComputedRef<boolean> | (() => boolean)
  /** Detached, compact action record for a selected row; never a whole page. */
  snapshotTrack?: (track: Track) => Track
  /** Absolute query position for stable batch-action order across pages. */
  selectionOrder?: (track: Track, index: number) => number
  /** A page-local range anchor must not survive a page transition. */
  rangeContext?: Ref<unknown> | ComputedRef<unknown> | (() => unknown)
  /** Owning list surface; falls back to this component's root when omitted. */
  root?: Ref<HTMLElement | null> | (() => HTMLElement | null)
}

function resolveTracks(source: TrackListSource): Track[] {
  if (typeof source === 'function') return source()
  return source.value
}

function resolveEnabled(enabled: UseTrackMultiSelectOptions['enabled']): boolean {
  if (enabled == null) return true
  if (typeof enabled === 'function') return enabled()
  return enabled.value
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function isTrackListShortcutTarget(
  event: KeyboardEvent,
  root: HTMLElement | null,
  dismissLayerActive = hasDismissLayer()
): boolean {
  if (event.defaultPrevented || dismissLayerActive || !root) return false
  const target = event.target
  const active = root.ownerDocument.activeElement
  if (!(target instanceof HTMLElement) || !(active instanceof HTMLElement)) return false
  if (!root.contains(target) || !root.contains(active)) return false
  if (isEditableTarget(target) || isEditableTarget(active)) return false
  return !root.ownerDocument.querySelector(
    'dialog:modal, [role="dialog"][aria-modal="true"], [role="menu"]:not([hidden]):not([aria-hidden="true"])'
  )
}

/**
 * System-style multi-select for track tables:
 * - Ctrl/Cmd+Click: toggle selection (does not play)
 * - Shift+Click: range from an existing Ctrl/Cmd selection (does not play)
 * - plain click: toggles selection while selection mode is active; otherwise returns play intent
 * - checkbox / explicit selectOnly: manual multi-select
 * - right-click is intentionally not handled here and must not change selection
 * - Ctrl/Cmd+A: select all current list
 * - Escape: clear
 */
export function useTrackMultiSelect({
  tracks,
  querySelection,
  keyForTrack = (track) => track.id,
  resetSources = [],
  enabled,
  preserveSelectedTracks,
  snapshotTrack = (track) => track,
  selectionOrder = (_track, index) => index,
  rangeContext,
  root
}: UseTrackMultiSelectOptions): {
  selectedIds: Ref<Set<string>>
  selectedCount: ComputedRef<number>
  hasSelection: ComputedRef<boolean>
  isSelected: (trackId: string) => boolean
  clearSelection: () => void
  selectAll: () => void
  selectOnly: (trackId: string, index: number, track?: Track) => void
  toggle: (trackId: string, index: number, track?: Track) => void
  selectRange: (toIndex: number) => void
  onRowClick: (track: Track, index: number, event: MouseEvent) => MultiSelectClickResult
  shouldSuppressRowDoubleClick: (event: MouseEvent) => boolean
  getSelectedTracks: () => Track[]
  getSelectedTrackIds: () => string[]
  getSelectedRanges: () => LibrarySelectionRange[] | null
  selectionVersion: Ref<number>
} {
  const instance = getCurrentInstance()
  const selectedIds = ref<Set<string>>(new Set())
  const selectedRanges = shallowRef<LibrarySelectionRange[]>([])
  const selectionVersion = ref(0)
  const query = computed(() => querySelection?.() ?? null)
  let preparingAll = false
  const anchorIndex = ref<number | null>(null)
  const selectedTrackCache = new Map<string, { track: Track; order: number }>()
  let suppressNextRowDoubleClick = false
  let suppressDoubleClickTimer: ReturnType<typeof setTimeout> | null = null

  const selectedCount = computed(() =>
    query.value
      ? selectedRanges.value.reduce((count, [start, end]) => count + end - start, 0)
      : selectedIds.value.size
  )
  const hasSelection = computed(() => selectedCount.value > 0)
  function setRanges(ranges: LibrarySelectionRange[]): void {
    selectedRanges.value = ranges
    selectedIds.value = new Set()
    selectionVersion.value++
  }

  function preservesSelectedTracks(): boolean {
    return preserveSelectedTracks != null && resolveEnabled(preserveSelectedTracks)
  }

  function rememberTrack(track: Track, index: number): void {
    if (preservesSelectedTracks())
      selectedTrackCache.set(keyForTrack(track), {
        track: snapshotTrack(track),
        order: selectionOrder(track, index)
      })
  }

  function resolveRow(trackId: string, index: number, track?: Track): Track | undefined {
    const list = resolveTracks(tracks)
    const candidate = track ?? list[index]
    return candidate && keyForTrack(candidate) === trackId
      ? candidate
      : list.find((row) => keyForTrack(row) === trackId)
  }

  function isSelected(trackId: string): boolean {
    if (query.value) {
      const position = query.value.positionForKey(trackId)
      return position !== null && selectionContains(selectedRanges.value, position)
    }
    return selectedIds.value.has(trackId)
  }

  function clearSelection(): void {
    preparingAll = false
    selectedRanges.value = []
    selectionVersion.value++
    selectedIds.value = new Set()
    anchorIndex.value = null
    selectedTrackCache.clear()
  }

  function clearDoubleClickSuppression(): void {
    suppressNextRowDoubleClick = false
    if (suppressDoubleClickTimer != null) clearTimeout(suppressDoubleClickTimer)
    suppressDoubleClickTimer = null
  }

  function selectOnly(trackId: string, index: number, track?: Track): void {
    const row = resolveRow(trackId, index, track)
    if (preservesSelectedTracks() && !row) return
    if (query.value) {
      if (!row) return
      const position = selectionOrder(row, index)
      if (position < 0 || position >= query.value.total) return
      setRanges([[position, position + 1]])
      anchorIndex.value = position
      return
    }
    selectionVersion.value++
    selectedTrackCache.clear()
    if (row) rememberTrack(row, index)
    selectedIds.value = new Set([trackId])
    anchorIndex.value = index
  }

  function toggle(trackId: string, index: number, track?: Track): void {
    if (query.value) {
      const row = resolveRow(trackId, index, track)
      if (!row) return
      const position = selectionOrder(row, index)
      if (position < 0 || position >= query.value.total) return
      setRanges(toggleSelectionPosition(selectedRanges.value, position))
      anchorIndex.value = position
      return
    }
    selectionVersion.value++
    const next = new Set(selectedIds.value)
    if (next.has(trackId)) {
      next.delete(trackId)
      selectedTrackCache.delete(trackId)
    } else {
      const row = resolveRow(trackId, index, track)
      if (preservesSelectedTracks() && !row) return
      next.add(trackId)
      if (row) rememberTrack(row, index)
    }
    selectedIds.value = next
    anchorIndex.value = index
  }

  function selectRange(toIndex: number): void {
    if (query.value) {
      if (!Number.isSafeInteger(toIndex) || toIndex < 0 || toIndex >= query.value.total) return
      const from = anchorIndex.value ?? toIndex
      setRanges(
        addSelectionRange(
          selectedRanges.value,
          Math.min(from, toIndex),
          Math.max(from, toIndex) + 1
        )
      )
      if (anchorIndex.value === null) anchorIndex.value = toIndex
      return
    }
    const list = resolveTracks(tracks)
    if (list.length === 0) return
    const from = anchorIndex.value ?? toIndex
    const start = Math.max(0, Math.min(from, toIndex))
    const end = Math.min(list.length - 1, Math.max(from, toIndex))
    // In paged mode range/select-all adds this page without discarding other
    // explicitly selected pages. The legacy complete-list contract is unchanged.
    const next = preservesSelectedTracks() ? new Set(selectedIds.value) : new Set<string>()
    if (!preservesSelectedTracks()) selectedTrackCache.clear()
    for (let i = start; i <= end; i++) {
      const track = list[i]
      if (track) {
        next.add(keyForTrack(track))
        rememberTrack(track, i)
      }
    }
    selectedIds.value = next
    selectionVersion.value++
    // Keep original anchor for continued shift-select
    if (anchorIndex.value == null) anchorIndex.value = toIndex
  }

  function selectAll(): void {
    if (query.value) {
      if (query.value.prepareAll) {
        preparingAll = true
        const version = selectionVersion.value
        const current = query.value
        const prepare = current.prepareAll!
        void prepare()
          .then(() => {
            if (selectionVersion.value !== version || !query.value) return
            setRanges(query.value.total > 0 ? [[0, query.value.total]] : [])
            anchorIndex.value = query.value.total > 0 ? 0 : null
          })
          .catch((error) => current.onError?.(error))
          .finally(() => {
            preparingAll = false
          })
        return
      }
      setRanges(query.value.total > 0 ? [[0, query.value.total]] : [])
      anchorIndex.value = query.value.total > 0 ? 0 : null
      return
    }
    const list = resolveTracks(tracks)
    const next = preservesSelectedTracks() ? new Set(selectedIds.value) : new Set<string>()
    if (!preservesSelectedTracks()) selectedTrackCache.clear()
    list.forEach((track, index) => {
      next.add(keyForTrack(track))
      rememberTrack(track, index)
    })
    selectedIds.value = next
    selectionVersion.value++
    anchorIndex.value = list.length > 0 ? 0 : null
  }

  function rememberSelectionClickForDoubleClick(): void {
    if (suppressDoubleClickTimer != null) clearTimeout(suppressDoubleClickTimer)
    suppressNextRowDoubleClick = true
    suppressDoubleClickTimer = setTimeout(() => {
      suppressNextRowDoubleClick = false
      suppressDoubleClickTimer = null
    }, 1000)
  }

  function onRowClick(track: Track, index: number, event: MouseEvent): MultiSelectClickResult {
    if (event.shiftKey && anchorIndex.value != null && hasSelection.value) {
      selectRange(query.value ? selectionOrder(track, index) : index)
      rememberSelectionClickForDoubleClick()
      return 'select'
    }
    if (event.ctrlKey || event.metaKey) {
      toggle(keyForTrack(track), index, track)
      rememberSelectionClickForDoubleClick()
      return 'select'
    }
    if (hasSelection.value) {
      toggle(keyForTrack(track), index, track)
      rememberSelectionClickForDoubleClick()
      return 'select'
    }
    clearDoubleClickSuppression()
    return 'play'
  }

  function shouldSuppressRowDoubleClick(event: MouseEvent): boolean {
    if (event.ctrlKey || event.metaKey || event.shiftKey || hasSelection.value) return true
    if (!suppressNextRowDoubleClick) return false
    suppressNextRowDoubleClick = false
    if (suppressDoubleClickTimer != null) clearTimeout(suppressDoubleClickTimer)
    suppressDoubleClickTimer = null
    return true
  }

  function getSelectedTracks(): Track[] {
    if (query.value && hasSelection.value)
      throw new Error('完整查询选择须通过异步批次读取，不能转换为 Track[]')
    const list = resolveTracks(tracks)
    const ids = selectedIds.value
    if (ids.size === 0) return []
    if (preservesSelectedTracks()) {
      return [...ids]
        .map((id) => selectedTrackCache.get(id))
        .filter((row): row is { track: Track; order: number } => !!row)
        .sort((a, b) => a.order - b.order)
        .map((row) => row.track)
    }
    return list.filter((track) => ids.has(keyForTrack(track)))
  }

  function getSelectedTrackIds(): string[] {
    if (query.value && hasSelection.value) throw new Error('完整查询选择须通过异步批次读取')
    return Array.from(selectedIds.value)
  }
  function getSelectedRanges(): LibrarySelectionRange[] | null {
    return query.value ? selectedRanges.value.map(([start, end]) => [start, end]) : null
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!resolveEnabled(enabled)) return
    const key = event.key
    if (key !== 'Escape' && !((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'a')) return
    if (event.isComposing) return
    const element = instance?.subTree.el
    const surface =
      typeof root === 'function'
        ? root()
        : (root?.value ??
          (typeof HTMLElement !== 'undefined' && element instanceof HTMLElement ? element : null))
    if (!isTrackListShortcutTarget(event, surface)) return

    if (key === 'Escape' && hasSelection.value) {
      event.preventDefault()
      clearSelection()
      return
    }

    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'a') {
      event.preventDefault()
      selectAll()
    }
  }

  if (getCurrentScope()) {
    for (const source of resetSources) {
      watch(typeof source === 'function' ? source : () => source.value, clearSelection, {
        flush: 'sync'
      })
    }
    watch(preservesSelectedTracks, clearSelection, { flush: 'sync' })
    watch(
      () => query.value?.total,
      () => {
        if (!preparingAll) clearSelection()
      },
      { flush: 'sync' }
    )
    if (rangeContext)
      watch(
        typeof rangeContext === 'function' ? rangeContext : () => rangeContext.value,
        () => {
          if (!query.value) anchorIndex.value = null
        },
        { flush: 'sync' }
      )

    // Drop ids that disappeared from the list (e.g. after delete)
    watch(
      () => resolveTracks(tracks).map(keyForTrack),
      () => {
        if (query.value) return
        if (selectedIds.value.size === 0) return
        if (preservesSelectedTracks()) {
          resolveTracks(tracks).forEach((track, index) => {
            const key = keyForTrack(track)
            if (selectedIds.value.has(key)) rememberTrack(track, index)
          })
          return
        }
        const valid = new Set(resolveTracks(tracks).map(keyForTrack))
        let changed = false
        const next = new Set<string>()
        for (const id of selectedIds.value) {
          if (valid.has(id)) next.add(id)
          else changed = true
        }
        if (changed) {
          selectedIds.value = next
          selectionVersion.value++
        }
      },
      { flush: 'sync' }
    )
    onScopeDispose(() => {
      clearSelection()
      clearDoubleClickSuppression()
    })
  }

  if (instance) {
    onMounted(() => {
      window.addEventListener('keydown', onKeyDown)
    })
    onUnmounted(() => {
      window.removeEventListener('keydown', onKeyDown)
      clearDoubleClickSuppression()
    })
  }

  return {
    selectedIds,
    selectedCount,
    hasSelection,
    isSelected,
    clearSelection,
    selectAll,
    selectOnly,
    toggle,
    selectRange,
    onRowClick,
    shouldSuppressRowDoubleClick,
    getSelectedTracks,
    getSelectedTrackIds,
    getSelectedRanges,
    selectionVersion
  }
}
