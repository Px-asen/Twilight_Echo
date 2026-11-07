import { computed, ref, watch, type Ref } from 'vue'
import type { LibraryQuery } from '../../../../shared/libraryDatabase.ts'
import type { Track } from '@renderer/types/music'
import { useTrackLocator } from '@renderer/composables/useTrackLocator'
import { registerScrollToTopCompanion, type ScrollViewport } from '@renderer/utils/scrollToTopButton'

/** Locate in the filtered, sorted list without changing playback or selection. */
export function useLocatePlayingTrack(options: {
  containerRef: Ref<HTMLElement | null>
  tbodyRef: Ref<HTMLElement | null>
  displayTracks: Readonly<Ref<Track[]>>
  libraryTracks?: Readonly<Ref<Track[]>>
  currentTrack: Readonly<Ref<Pick<Track, 'id'> | null>>
  enabled: Readonly<Ref<boolean>>
  rowHeight: number
  playingRowSelector?: string
  database?: {
    enabled: Readonly<Ref<boolean>>
    query: Readonly<Ref<LibraryQuery | null>>
    read: (query: LibraryQuery) => Promise<{ anchorIndex?: number }>
    locate: (id: string, viewport: ScrollViewport) => void
  }
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
    computed(() => (options.database?.enabled.value ? null : containerRef.value)),
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

  if (options.database) {
    const database = options.database
    const available = ref(false)
    watch([database.query, currentTrack, enabled], async ([query, track, active], _old, cleanup) => {
      let current = true
      cleanup(() => { current = false })
      available.value = false
      if (!active || !query || !track) return
      try {
        const page = await database.read({ ...query, anchorId: track.id, limit: 1 })
        if (current) available.value = page.anchorIndex !== undefined && page.anchorIndex >= 0
      } catch {
        // The list owns query errors and retry; an unconfirmed target cannot be located.
      }
    }, { immediate: true })
    watch(
      [containerRef, database.enabled],
      ([container, active], _previous, onCleanup) => {
        if (!container || !active) return
        const registration = registerScrollToTopCompanion(container, {
          label: '定位正在播放的歌曲',
          icon: 'ph ph-crosshair',
          isVisible: (viewport) => {
            if (!enabled.value || !available.value || !currentTrack.value || !tbodyRef.value) return false
            const body = tbodyRef.value
            const row = body.querySelector<HTMLElement>(
              options.playingRowSelector ?? '.track-playing'
            )
            const rect = row?.getBoundingClientRect()
            const visibleTop = Math.max(
              viewport.top,
              body.previousElementSibling?.getBoundingClientRect().bottom ?? viewport.top
            )
            return !rect || rect.bottom <= visibleTop || rect.top >= viewport.bottom
          },
          activate: (viewport) => {
            if (currentTrack.value) database.locate(currentTrack.value.id, viewport)
          }
        })
        const stop = watch([currentTrack, tbodyRef, enabled, available], registration.refresh, {
          flush: 'post'
        })
        onCleanup(() => {
          stop()
          registration.dispose()
        })
      },
      { immediate: true, flush: 'post' }
    )
  }
}
