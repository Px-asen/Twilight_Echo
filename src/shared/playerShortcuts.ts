export type PlayerShortcutAction =
  | 'previous'
  | 'next'
  | 'playPause'
  | 'play'
  | 'pause'
  | 'volumeUp'
  | 'volumeDown'
  | 'toggleDesktopLyrics'
  | 'toggleDesktopLyricsLock'
  | { action: 'seek'; positionSeconds: number }
  | { action: 'setVolume'; volume: number }
  | { action: 'jumpQueue'; index: number }

export function shortcutVolume(volume: number, direction: 'volumeUp' | 'volumeDown'): number {
  return Math.min(
    1,
    Math.max(0, Math.round((volume + (direction === 'volumeUp' ? 0.05 : -0.05)) * 100) / 100)
  )
}
