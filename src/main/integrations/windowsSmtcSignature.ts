import type { MiniPlayerStateSnapshot } from '../../shared/miniPlayer.ts'

/**
 * Signature of everything the native Windows media session actually renders.
 * The mini player republishes its snapshot on every progress step; the SMTC
 * timeline only moves in whole seconds, so ticks that change nothing else must
 * not cross into the native binding at all.
 */
export function windowsSmtcUpdateSignature(
  state: MiniPlayerStateSnapshot | null,
  enabled: boolean
): string {
  if (!state) return `off:${enabled ? 1 : 0}`
  const track = state.track
  const position = Number.isFinite(state.currentTime)
    ? Math.floor(Math.max(0, state.currentTime))
    : 0
  const duration = Number.isFinite(state.duration) ? Math.floor(Math.max(0, state.duration)) : 0
  return [
    enabled ? 1 : 0,
    track?.id ?? '',
    track?.title ?? '',
    track?.artist ?? '',
    track?.album ?? '',
    track?.albumArtist ?? '',
    track?.trackNumber ?? 0,
    track?.cover ?? '',
    track?.coverSource ?? '',
    state.isPlaying ? 1 : 0,
    state.isLoading ? 1 : 0,
    state.playMode,
    state.playbackRate,
    state.queueLength,
    position,
    duration
  ].join('\u0001')
}
