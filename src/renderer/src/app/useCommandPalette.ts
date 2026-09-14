import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useMusicStore } from '@renderer/stores/useMusicStore.ts'
import { usePlayerStore } from '@renderer/stores/usePlayerStore.ts'
import { useSettingsStore } from '@renderer/stores/useSettingsStore.ts'
import { useUnifiedMusicSearch } from '@renderer/app/useUnifiedMusicSearch.ts'
import { createCommandPaletteActions } from '@renderer/app/commandPaletteActions.ts'
import type { useAppNavigation } from '@renderer/app/useAppNavigation.ts'
import { isCommandPaletteKey } from '../../../shared/commandPaletteShortcut.ts'

export function useCommandPalette(navigation: ReturnType<typeof useAppNavigation>) {
  const isOpen = ref(false)
  const music = useMusicStore()
  const player = usePlayerStore()
  const settings = useSettingsStore()
  const search = useUnifiedMusicSearch()
  const actions = computed(() =>
    createCommandPaletteActions({
      navigation,
      currentTrack: player.currentTrack.value,
      playing: player.isPlaying.value,
      loading: player.isLoading.value,
      lyricsVisible: settings.settings.value.desktopLyrics.enabled,
      togglePlay: player.togglePlay,
      showLyrics: async () => {
        const enabled = await window.api.desktopLyrics.setEnabled(true)
        await settings.updateSettings({
          desktopLyrics: { ...settings.settings.value.desktopLyrics, enabled }
        })
      }
    })
  )
  function close(): void {
    isOpen.value = false
    search.clear()
  }
  function open(): void {
    search.clear()
    isOpen.value = true
  }
  function onKeydown(event: KeyboardEvent): void {
    if (!isCommandPaletteKey(event)) return
    if (
      !isOpen.value &&
      event.target instanceof Element &&
      event.target.closest('dialog, [role="dialog"], [role="menu"]')
    )
      return
    event.preventDefault()
    if (isOpen.value) close()
    else open()
  }
  onMounted(() => {
    window.addEventListener('keydown', onKeydown)
    window.addEventListener('pagehide', close)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown)
    window.removeEventListener('pagehide', close)
    close()
  })
  return {
    isOpen,
    open,
    close,
    search,
    actions,
    playlists: music.playlists,
    tracks: music.tracks,
    playTrack: player.playTrack,
    openPlaylist: navigation.openLibraryPlaylist
  }
}
