import { computed, type Ref } from 'vue'
import type { Track } from '@renderer/types/music'
import { useTrackLocator } from '@renderer/composables/useTrackLocator'

/** Locate in the filtered, sorted list without changing playback or selection. */
export function useLocatePlayingTrack(options: {
  containerRef: Ref<HTMLElement | null>
  tbodyRef: Ref<HTMLElement | null>
  displayTracks: Readonly<Ref<Track[]>>
  libraryTracks?: Readonly<Ref<Track[]>>
  currentTrack: Readonly<Ref<Track | null>>
  enabled: Readonly<Ref<boolean>>
  rowHeight: number
  playingRowSelector?: string
}): void {
  const { containerRef, tbodyRef, displayTracks, libraryTracks, currentTrack, enabled, rowHeight } =
    options
  // Searching is cached across scroll events; only list/song changes recompute it.
  const currentIndex = computed(() => {
    const id = currentTrack.value?.id
    if (
      !enabled.value ||
      !id ||
      (libraryTracks && !libraryTracks.value.some((track) => track.id === id))
    )
      return -1
    return displayTracks.value.findIndex((track) => track.id === id)
  })

  useTrackLocator(
    containerRef,
    {
      bounds: () => {
        const body = tbodyRef.value
        if (currentIndex.value < 0 || !body) return []
        const row = body.querySelector<HTMLElement>(options.playingRowSelector ?? '.track-playing')
        const rect = row?.getBoundingClientRect()
        const top = rect?.top ?? body.getBoundingClientRect().top + currentIndex.value * rowHeight
        return [
          {
            top,
            bottom: rect?.bottom ?? top + rowHeight,
            visibleTop: body.previousElementSibling?.getBoundingClientRect().bottom
          }
        ]
      }
    },
    [currentIndex, tbodyRef, displayTracks, enabled]
  )
}
