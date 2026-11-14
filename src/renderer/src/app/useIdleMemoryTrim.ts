import { nextTick, onBeforeUnmount, onMounted, readonly, ref, type DeepReadonly, type Ref } from 'vue'
import { clearCoverCache, clearRemoteCoverGrantCache } from '../utils/coverLoader.ts'

/**
 * Delay before trimming decoded bitmaps and heavy decorative DOM subtrees while
 * the main window stays minimized or occluded in the background without being
 * unloaded to the tray.
 */
export const IDLE_MINIMIZED_TRIM_DELAY_MS = 90_000

export interface IdleMemoryTrimmerOptions {
  delayMs?: number
  isHidden?: () => boolean
  subscribeVisibility?: (onChange: () => void) => () => void
  /**
   * Runs `fn` after Vue flushes the DOM unmount triggered by `trimmed.value = true`,
   * ensuring Blink unlocks detached `<img>` / `<svg>` resources before `webFrame.clearCache()`.
   */
  scheduleFlush?: (fn: () => void) => void
  onTrim?: () => void
  onRestore?: () => void
  stateRef?: Ref<boolean>
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

export interface IdleMemoryTrimmer {
  trimmed: DeepReadonly<Ref<boolean>>
  syncVisibility: () => void
  dispose: () => void
}

export function createIdleMemoryTrimmer(options: IdleMemoryTrimmerOptions = {}): IdleMemoryTrimmer {
  const delayMs = options.delayMs ?? IDLE_MINIMIZED_TRIM_DELAY_MS
  const isHidden =
    options.isHidden ??
    (() => typeof document !== 'undefined' && document.visibilityState === 'hidden')
  const subscribeVisibility =
    options.subscribeVisibility ??
    ((onChange: () => void) => {
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
        return () => {}
      }
      document.addEventListener('visibilitychange', onChange)
      return () => document.removeEventListener('visibilitychange', onChange)
    })
  const scheduleFlush = options.scheduleFlush ?? ((fn: () => void) => void nextTick(fn))
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))

  const trimmed = options.stateRef ?? ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  function cancelPendingTimer(): void {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  function syncVisibility(): void {
    if (disposed) return
    if (isHidden()) {
      if (trimmed.value || timer !== null) return
      timer = setTimer(() => {
        timer = null
        if (disposed || !isHidden()) return
        trimmed.value = true
        scheduleFlush(() => {
          if (disposed || !trimmed.value || !isHidden()) return
          options.onTrim?.()
        })
      }, delayMs)
      return
    }

    cancelPendingTimer()
    if (trimmed.value) {
      trimmed.value = false
      options.onRestore?.()
    }
  }

  const unsubscribe = subscribeVisibility(syncVisibility)
  syncVisibility()

  function dispose(): void {
    if (disposed) return
    disposed = true
    cancelPendingTimer()
    unsubscribe()
  }

  return {
    trimmed: readonly(trimmed),
    syncVisibility,
    dispose
  }
}

export function trimRendererIdleCaches(): void {
  clearCoverCache()
  clearRemoteCoverGrantCache()
  if (typeof window !== 'undefined') {
    window.api?.window?.clearMemoryCache?.()
  }
}

export function useIdleMemoryTrim(delayMs = IDLE_MINIMIZED_TRIM_DELAY_MS): DeepReadonly<Ref<boolean>> {
  const state = ref(false)
  let trimmer: IdleMemoryTrimmer | null = null

  onMounted(() => {
    trimmer = createIdleMemoryTrimmer({
      delayMs,
      stateRef: state,
      onTrim: trimRendererIdleCaches
    })
  })

  onBeforeUnmount(() => {
    trimmer?.dispose()
    trimmer = null
    state.value = false
  })

  return readonly(state)
}
