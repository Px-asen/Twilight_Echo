import type { CoreQueueReference } from './coreProtocol.ts'
import type { CorePlaybackView, CoreTrackView } from './coreViews.ts'
import type { ZoneQueueFence, ZoneTransport } from './coreZones.ts'
import type { AutoMixMode } from './twilightAutoMix.ts'

export interface SyncGroupEngineState {
  phase: 'paused' | 'preparing' | 'armed' | 'playing' | 'rebuffering' | 'completed' | 'failed'
  error: string | null
  epoch: number
  audibleAtCoreMs: number | null
  estimatedSkewMs: number | null
  observationRangeMs: number | null
  members: { id: string; dspDelayMs: number; downstreamDelayMs: number; startAtCoreMs: number | null }[]
}

export const validSyncGroupId = (v: unknown): v is string => typeof v === 'string' && /^group-[a-f0-9-]{36}$/.test(v)
export interface SyncGroupMember { zoneId: string; downstreamDelayMs: number }
export interface SyncGroupDescriptor { id: string; name: string; members: SyncGroupMember[]; autoMixMode?: AutoMixMode }
export interface SyncGroupSettingsEdit { groupId: string; revision: number; autoMixMode: AutoMixMode }
export interface SyncGroupView extends SyncGroupDescriptor {
  autoMixAvailable?: boolean
  revision: number
  playback: CorePlaybackView | null
  track: CoreTrackView | null
  queue: CoreQueueReference | null
  coordination: SyncGroupEngineState | null
  error: string | null
}
export interface SyncGroupsView { revision: number; groups: SyncGroupView[]; error: string | null }
export interface SyncGroupCreate {
  revision: number
  name: string
  members: (SyncGroupMember & { revision: number })[]
  source: { zoneId: string; queue: ZoneQueueFence }
}
export type SyncGroupTransport = { groupId: string; revision: number; action: ZoneTransport } |
  { groupId: string; revision: null; action: { kind: 'pause' | 'stop' } }
