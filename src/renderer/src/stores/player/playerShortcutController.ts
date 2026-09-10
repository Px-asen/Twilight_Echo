import type { PlayerShortcutAction } from '../../../../shared/playerShortcuts.ts'
import { shortcutVolume } from '../../../../shared/playerShortcuts.ts'

interface ShortcutControls {
  previous: () => unknown
  next: () => unknown
  isPlaying: () => boolean
  togglePlay: () => Promise<void>
  toggleLyrics: () => Promise<void>
  toggleLyricsLock: () => Promise<void>
  seek: (position: number) => unknown
  getVolume: () => number
  setVolume: (volume: number) => void
  jumpQueue: (index: number) => unknown
}

export async function dispatchPlayerShortcut(
  action: PlayerShortcutAction,
  controls: ShortcutControls
): Promise<void> {
  if (typeof action !== 'string') {
    if (action.action === 'seek') controls.seek(action.positionSeconds)
    if (action.action === 'setVolume') controls.setVolume(Math.min(1, Math.max(0, action.volume)))
    if (action.action === 'jumpQueue') controls.jumpQueue(action.index)
    return
  }
  switch (action) {
    case 'previous':
      controls.previous()
      return
    case 'next':
      controls.next()
      return
    case 'play':
      if (!controls.isPlaying()) await controls.togglePlay()
      return
    case 'pause':
      if (controls.isPlaying()) await controls.togglePlay()
      return
    case 'playPause':
      await controls.togglePlay()
      return
    case 'volumeUp':
    case 'volumeDown':
      controls.setVolume(shortcutVolume(controls.getVolume(), action))
      return
    case 'toggleDesktopLyrics':
      await controls.toggleLyrics()
      return
    case 'toggleDesktopLyricsLock':
      await controls.toggleLyricsLock()
      return
  }
}
