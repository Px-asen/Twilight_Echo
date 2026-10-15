import {
  computed,
  getCurrentInstance,
  onMounted,
  onUnmounted,
  ref,
  watch,
  type ComputedRef,
  type Ref
} from 'vue'
import type { Track } from '../../types/music'
import { hasDismissLayer } from '../../app/useDismissLayer.ts'

export type MultiSelectClickResult = 'select' | 'play'

type TrackListSource = ComputedRef<Track[]> | Ref<Track[]> | (() => Track[])

export type UseTrackMultiSelectOptions = {
  /** Current visible/ordered track list used for range and select-all. */
  tracks: TrackListSource
  /**
   * Extra reactive sources that should clear selection when they change
   * (e.g. category, filter, search query).
   */
  resetSources?: Array<Ref<unknown> | ComputedRef<unknown> | (() => unknown)>
  /** When false, keyboard shortcuts are ignored (e.g. grid view). Default true. */
  enabled?: Ref<boolean> | ComputedRef<boolean> | (() => boolean)
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
  resetSources = [],
  enabled,
  root
}: UseTrackMultiSelectOptions): {
  selectedIds: Ref<Set<string>>
  selectedCount: ComputedRef<number>
  hasSelection: ComputedRef<boolean>
  isSelected: (trackId: string) => boolean
  clearSelection: () => void
  selectAll: () => void
  selectOnly: (trackId: string, index: number) => void
  toggle: (trackId: string, index: number) => void
  selectRange: (toIndex: number) => void
  onRowClick: (track: Track, index: number, event: MouseEvent) => MultiSelectClickResult
  shouldSuppressRowDoubleClick: (event: MouseEvent) => boolean
  getSelectedTracks: () => Track[]
  getSelectedTrackIds: () => string[]
} {
  const instance = getCurrentInstance()
  const selectedIds = ref<Set<string>>(new Set())
  const anchorIndex = ref<number | null>(null)
  let suppressNextRowDoubleClick = false
  let suppressDoubleClickTimer: ReturnType<typeof setTimeout> | null = null

  const selectedCount = computed(() => selectedIds.value.size)
  const hasSelection = computed(() => selectedIds.value.size > 0)

  function isSelected(trackId: string): boolean {
    return selectedIds.value.has(trackId)
  }

  function clearSelection(): void {
    if (selectedIds.value.size === 0 && anchorIndex.value == null) return
    selectedIds.value = new Set()
    anchorIndex.value = null
  }

  function clearDoubleClickSuppression(): void {
    suppressNextRowDoubleClick = false
    if (suppressDoubleClickTimer != null) clearTimeout(suppressDoubleClickTimer)
    suppressDoubleClickTimer = null
  }

  function selectOnly(trackId: string, index: number): void {
    selectedIds.value = new Set([trackId])
    anchorIndex.value = index
  }

  function toggle(trackId: string, index: number): void {
    const next = new Set(selectedIds.value)
    if (next.has(trackId)) next.delete(trackId)
    else next.add(trackId)
    selectedIds.value = next
    anchorIndex.value = index
  }

  function selectRange(toIndex: number): void {
    const list = resolveTracks(tracks)
    if (list.length === 0) return
    const from = anchorIndex.value ?? toIndex
    const start = Math.max(0, Math.min(from, toIndex))
    const end = Math.min(list.length - 1, Math.max(from, toIndex))
    const next = new Set<string>()
    for (let i = start; i <= end; i++) {
      const track = list[i]
      if (track) next.add(track.id)
    }
    selectedIds.value = next
    // Keep original anchor for continued shift-select
    if (anchorIndex.value == null) anchorIndex.value = toIndex
  }

  function selectAll(): void {
    const list = resolveTracks(tracks)
    selectedIds.value = new Set(list.map((track) => track.id))
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
    if (event.shiftKey && anchorIndex.value != null && selectedIds.value.size > 0) {
      selectRange(index)
      rememberSelectionClickForDoubleClick()
      return 'select'
    }
    if (event.ctrlKey || event.metaKey) {
      toggle(track.id, index)
      rememberSelectionClickForDoubleClick()
      return 'select'
    }
    if (hasSelection.value) {
      toggle(track.id, index)
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
    const list = resolveTracks(tracks)
    const ids = selectedIds.value
    if (ids.size === 0) return []
    return list.filter((track) => ids.has(track.id))
  }

  function getSelectedTrackIds(): string[] {
    return Array.from(selectedIds.value)
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!resolveEnabled(enabled)) return
    const element = instance?.subTree.el
    const surface =
      typeof root === 'function'
        ? root()
        : (root?.value ??
          (typeof HTMLElement !== 'undefined' && element instanceof HTMLElement ? element : null))
    if (!isTrackListShortcutTarget(event, surface)) return

    const key = event.key
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

  if (instance) {
    for (const source of resetSources) {
      watch(typeof source === 'function' ? source : () => source.value, () => clearSelection())
    }

    // Drop ids that disappeared from the list (e.g. after delete)
    watch(
      () =>
        resolveTracks(tracks)
          .map((track) => track.id)
          .join('\0'),
      () => {
        if (selectedIds.value.size === 0) return
        const valid = new Set(resolveTracks(tracks).map((track) => track.id))
        let changed = false
        const next = new Set<string>()
        for (const id of selectedIds.value) {
          if (valid.has(id)) next.add(id)
          else changed = true
        }
        if (changed) selectedIds.value = next
      }
    )

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
    getSelectedTrackIds
  }
}
