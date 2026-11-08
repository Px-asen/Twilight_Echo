import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { cloneAppearance, type AppearanceDraft } from '../../../shared/appAppearance.ts'

// A slider gesture is one history step. Keep memory bounded and never retain image pixels.
export function useAppearanceHistory<Context = undefined>(
  read: () => AppearanceDraft,
  write: (draft: AppearanceDraft) => void,
  context?: { read: () => Context; write: (value: Context) => void }
) {
  const snapshot = computed(() => JSON.stringify({ draft: read(), context: context?.read() }))
  const entries = ref([snapshot.value])
  const cursor = ref(0)
  let timer: ReturnType<typeof setTimeout> | undefined
  let restoring = false
  function capture(): void {
    clearTimeout(timer)
    timer = undefined
    const value = snapshot.value
    if (entries.value[cursor.value] === value) return
    entries.value = [...entries.value.slice(0, cursor.value + 1), value].slice(-50)
    cursor.value = entries.value.length - 1
  }
  watch(
    snapshot,
    () => {
      if (restoring) return
      clearTimeout(timer)
      timer = setTimeout(capture, 180)
    },
    { deep: true, flush: 'sync' }
  )
  function restore(index: number): void {
    restoring = true
    cursor.value = index
    const saved = JSON.parse(entries.value[index])
    write(cloneAppearance(saved.draft))
    context?.write(saved.context)
    restoring = false
  }
  function reset(): void {
    clearTimeout(timer)
    timer = undefined
    entries.value = [snapshot.value]
    cursor.value = 0
  }
  const pending = computed(() => snapshot.value !== entries.value[cursor.value])
  const canUndo = computed(() => pending.value || cursor.value > 0)
  const canRedo = computed(() => !pending.value && cursor.value < entries.value.length - 1)
  function undo(): void {
    capture()
    if (cursor.value > 0) restore(cursor.value - 1)
  }
  function redo(): void {
    if (canRedo.value) restore(cursor.value + 1)
  }
  onBeforeUnmount(() => clearTimeout(timer))
  function exportState() {
    capture()
    return { entries: [...entries.value], cursor: cursor.value }
  }
  function resume(saved: ReturnType<typeof exportState>): void {
    clearTimeout(timer)
    timer = undefined
    entries.value = [...saved.entries]
    cursor.value = saved.cursor
  }
  return { canUndo, canRedo, undo, redo, reset, snapshot: exportState, resume }
}
