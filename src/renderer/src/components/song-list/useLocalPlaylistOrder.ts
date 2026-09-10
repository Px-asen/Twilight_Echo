import { computed, shallowRef, watch, type Ref } from 'vue'
import {
  orderPlaylistEntries,
  movePlaylistEntry
} from '@renderer/components/streaming-page/playlistLibraryView'

export function useLocalPlaylistOrder<T extends { id: string }>(
  source: Readonly<Ref<T[]>>,
  scope: () => string,
  report: (message: string) => void
) {
  const order = shallowRef<string[]>([])
  watch(
    scope,
    (key) => {
      order.value = []
      try {
        const saved: unknown = JSON.parse(
          localStorage.getItem(`te-local-playlist-order:${key}`) ?? '[]'
        )
        if (Array.isArray(saved))
          order.value = saved.filter((id): id is string => typeof id === 'string')
      } catch {
        report('无法读取歌单顺序，已使用默认顺序')
      }
    },
    { immediate: true }
  )
  const playlists = computed(() =>
    order.value.length ? orderPlaylistEntries(source.value, order.value) : source.value
  )
  function move(from: string, to: string, visible: readonly { id: string }[]): void {
    const ids = movePlaylistEntry(
      visible.map((playlist) => playlist.id),
      from,
      to
    )
    const shown = new Set(ids)
    let index = 0
    order.value = playlists.value.map((playlist) =>
      shown.has(playlist.id) ? ids[index++] : playlist.id
    )
    try {
      localStorage.setItem(`te-local-playlist-order:${scope()}`, JSON.stringify(order.value))
      report('已保存歌单顺序')
    } catch {
      report('顺序已调整，但保存失败；重启后将恢复原顺序')
    }
  }
  return { playlists, move }
}
