import { computed, ref, shallowRef, watch } from 'vue'
import type { MediaProviderPlaylistSummary } from '@renderer/providers/mediaProvider'
import {
  orderPlaylistEntries,
  movePlaylistEntry
} from '@renderer/components/streaming-page/playlistLibraryView'

export function usePlaylistLibraryView(
  source: () => MediaProviderPlaylistSummary[],
  scope: () => string,
  pinnedIds: () => ReadonlySet<string> = () => new Set()
) {
  const order = shallowRef<string[]>([])
  const category = ref<'all' | 'owned' | 'saved'>('all')
  const limit = ref(48)
  const storageError = ref('')
  const ordered = computed(() => orderPlaylistEntries(source(), order.value, pinnedIds()))
  const filtered = computed(() =>
    ordered.value.filter(
      (entry) =>
        category.value === 'all' ||
        (category.value === 'owned' ? entry.owned === true : entry.owned === false)
    )
  )
  const visible = computed(() => filtered.value.slice(0, limit.value))
  const counts = computed(() => {
    let owned = 0
    let saved = 0
    for (const entry of source()) {
      if (entry.owned === true) owned++
      if (entry.owned === false) saved++
    }
    return { all: source().length, owned, saved }
  })
  watch(
    scope,
    (key) => {
      order.value = []
      category.value = 'all'
      storageError.value = ''
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(`te-playlist-order:${key}`) ?? '[]')
        if (Array.isArray(saved))
          order.value = saved.filter((id): id is string => typeof id === 'string')
      } catch {
        storageError.value = '无法读取已保存的顺序，当前使用默认顺序'
      }
    },
    { immediate: true }
  )
  watch(category, () => {
    limit.value = 48
  })
  function move(from: string, to: string): void {
    order.value = movePlaylistEntry(
      ordered.value.map((entry) => String(entry.id)),
      from,
      to
    )
    try {
      localStorage.setItem(`te-playlist-order:${scope()}`, JSON.stringify(order.value))
      storageError.value = ''
    } catch {
      storageError.value = '顺序已调整，但无法保存；重启后将恢复原顺序'
    }
  }
  function step(id: string, offset: number): void {
    const index = filtered.value.findIndex((entry) => String(entry.id) === id)
    const target = filtered.value[index + offset]
    if (target) move(id, String(target.id))
  }
  return {
    category,
    limit,
    storageError,
    filtered,
    visible,
    counts,
    move,
    step
  }
}
