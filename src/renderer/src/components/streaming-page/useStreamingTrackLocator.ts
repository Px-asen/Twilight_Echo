import { computed } from 'vue'
import { useTrackLocator } from '@renderer/composables/useTrackLocator'
import type { Track } from '@renderer/types/music'
import type { useProgressiveList } from './useProgressiveList.ts'

export function useStreamingTrackLocator(
  list: Pick<ReturnType<typeof useProgressiveList>, 'scrollContainer' | 'itemBounds'>,
  props: { tracks: Track[]; currentTrackId?: string | null; loading: boolean }
): void {
  const currentIndex = computed(() =>
    props.loading || !props.currentTrackId
      ? -1
      : props.tracks.findIndex((track) => track.id === props.currentTrackId)
  )
  useTrackLocator(
    list.scrollContainer,
    {
      bounds: () => {
        const bounds = list.itemBounds(currentIndex.value)
        return bounds ? [bounds] : []
      }
    },
    [currentIndex, () => props.tracks]
  )
}
