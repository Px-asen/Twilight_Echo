import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { cloneAppearance, type AppearanceDraft } from '../../../shared/appAppearance'

// A slider gesture is one history step. Keep memory bounded and never retain image pixels.
export function useAppearanceHistory(
  read: () => AppearanceDraft,
  write: (draft: AppearanceDraft) => void
) {
  const snapshot = computed(() => JSON.stringify(read()))
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
    read,
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
    write(cloneAppearance(JSON.parse(entries.value[index])))
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
  return { canUndo, canRedo, undo, redo, reset }
}
