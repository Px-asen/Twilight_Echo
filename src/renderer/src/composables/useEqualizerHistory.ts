import { computed, ref, shallowRef } from 'vue'
import type { AudioProcessingSettings } from '../../../shared/audioEngineTypes.ts'

export type EqSnapshot = Pick<
  AudioProcessingSettings,
  'eqEnabled' | 'eqMode' | 'eqPreamp' | 'eqBands'
>
export type EqSlot = 'A' | 'B'
type Timeline = { past: EqSnapshot[]; present: EqSnapshot; future: EqSnapshot[] }

export function snapshotEqualizer(settings: EqSnapshot): EqSnapshot {
  return {
    eqEnabled: settings.eqEnabled,
    eqMode: settings.eqMode,
    eqPreamp: settings.eqPreamp,
    eqBands: settings.eqBands.map((band) => ({ ...band }))
  }
}

function timeline(settings: EqSnapshot): Timeline {
  return { past: [], present: snapshotEqualizer(settings), future: [] }
}

export function useEqualizerHistory(
  initial: EqSnapshot,
  apply: (snapshot: EqSnapshot) => Promise<void>
) {
  const slots = shallowRef({ A: timeline(initial), B: timeline(initial) })
  const activeSlot = ref<EqSlot>('A')
  const busy = ref(false)
  const current = computed(() => slots.value[activeSlot.value])
  const canUndo = computed(() => current.value.past.length > 0)
  const canRedo = computed(() => current.value.future.length > 0)
  let queue: Promise<void> = Promise.resolve()
  let pending = 0

  function enqueue(action: () => Promise<void>): Promise<void> {
    pending += 1
    busy.value = true
    const result = queue.then(action)
    queue = result.catch(() => undefined)
    return result.finally(() => {
      pending -= 1
      busy.value = pending > 0
    })
  }

  function reset(settings: EqSnapshot): void {
    slots.value = { A: timeline(settings), B: timeline(settings) }
    activeSlot.value = 'A'
  }

  function replaceCurrent(next: Timeline): void {
    slots.value = { ...slots.value, [activeSlot.value]: next }
  }

  function commit(settings: EqSnapshot): Promise<void> {
    const next = snapshotEqualizer(settings)
    return enqueue(async () => {
      const previous = current.value
      await apply(snapshotEqualizer(next))
      if (JSON.stringify(previous.present) === JSON.stringify(next)) return
      replaceCurrent({
        past: [...previous.past, previous.present].slice(-100),
        present: next,
        future: []
      })
    })
  }

  function travel(direction: 'undo' | 'redo'): Promise<void> {
    return enqueue(async () => {
      const previous = current.value
      const source = direction === 'undo' ? previous.past : previous.future
      const target = source.at(-1)
      if (!target) return
      await apply(snapshotEqualizer(target))
      replaceCurrent(
        direction === 'undo'
          ? {
              past: source.slice(0, -1),
              present: target,
              future: [...previous.future, previous.present]
            }
          : {
              past: [...previous.past, previous.present],
              present: target,
              future: source.slice(0, -1)
            }
      )
    })
  }

  function switchSlot(slot: EqSlot): Promise<void> {
    return enqueue(async () => {
      if (slot === activeSlot.value) return
      await apply(snapshotEqualizer(slots.value[slot].present))
      activeSlot.value = slot
    })
  }

  function copyToOther(): Promise<void> {
    return enqueue(async () => {
      const other = activeSlot.value === 'A' ? 'B' : 'A'
      slots.value = { ...slots.value, [other]: timeline(current.value.present) }
    })
  }

  function snapshot() {
    return JSON.parse(JSON.stringify({ slots: slots.value, activeSlot: activeSlot.value })) as {
      slots: { A: Timeline; B: Timeline }
      activeSlot: EqSlot
    }
  }
  function restore(saved: ReturnType<typeof snapshot>, current: EqSnapshot): boolean {
    if (
      JSON.stringify(saved.slots[saved.activeSlot].present) !==
      JSON.stringify(snapshotEqualizer(current))
    )
      return false
    slots.value = saved.slots
    activeSlot.value = saved.activeSlot
    return true
  }
  return {
    activeSlot,
    busy,
    canUndo,
    canRedo,
    reset,
    commit,
    travel,
    switchSlot,
    copyToOther,
    snapshot,
    restore
  }
}
