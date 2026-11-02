import type { BridgeRuntimeState } from './audioBridge.ts'
import type { CoreQueueReference } from './coreProtocol.ts'
import type { CorePlaybackView, CoreTrackView } from './coreViews.ts'

/** One local session plus three independently supervised Bridge sessions. */
export const MAX_CORE_ZONES = 4
export const validZoneId = (v: unknown): v is string =>
  typeof v === 'string' && (v === 'local' || /^zone-[a-f0-9-]{36}$/.test(v))
export interface ZoneDescriptor { id: string; name: string }
export interface ZoneView extends ZoneDescriptor {
  revision: number
  playback: CorePlaybackView | null
  track: CoreTrackView | null
  queue: CoreQueueReference | null
  output: BridgeRuntimeState | null
  error: string | null
}
export interface ZonesView { revision: number; limit: number; zones: ZoneView[]; error: string | null }
export type ZoneTransport =
  | { kind: 'play' | 'pause' | 'stop' | 'next' | 'previous' }
  | { kind: 'seek'; position: number }
  | { kind: 'volume'; volume: number }
