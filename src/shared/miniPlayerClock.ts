import type { MiniPlayerStateSnapshot } from './miniPlayer.ts'

export function estimateMiniPlayerTime(
  snapshot: MiniPlayerStateSnapshot,
  nowMs: number,
  receivedAtMs: number
): number {
  const elapsed =
    snapshot.isPlaying && !snapshot.isLoading
      ? Math.min(2000, Math.max(0, nowMs - (snapshot.capturedAtMs ?? receivedAtMs))) / 1000
      : 0
  const position = snapshot.currentTime + elapsed * snapshot.playbackRate
  return Math.max(0, snapshot.duration > 0 ? Math.min(snapshot.duration, position) : position)
}
