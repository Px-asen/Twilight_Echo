import type { InjectionKey, Ref } from 'vue'

export interface SoundFieldPlayback {
  sidebarVisible: Ref<boolean>
  favoriteAvailable: Readonly<Ref<boolean>>
  favoriteLiked: Readonly<Ref<boolean>>
  favoriteLoading: Readonly<Ref<boolean>>
  toggleFavorite: () => void
  openQueue: () => void
  openAudio: () => void
  openLyrics: () => void
  openMiniPlayer: () => void
}

export const soundFieldPlaybackKey: InjectionKey<SoundFieldPlayback> = Symbol('soundFieldPlayback')

export function usesSoundFieldSidebar(
  sidebarVisible: boolean,
  localViewVisible: boolean,
  category: string,
  streaming: boolean,
  playing: boolean
): boolean {
  return sidebarVisible && localViewVisible && category === 'dashboard' && !streaming && !playing
}
