import type { CueRange } from '../../shared/cue.ts'

export interface PreparedCastSegment {
  path: string
  release(): Promise<void>
}

export interface CastPcmSegments {
  prepare(source: string, range: CueRange, signal: AbortSignal): Promise<PreparedCastSegment>
}
