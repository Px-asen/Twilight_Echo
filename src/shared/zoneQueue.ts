import type { ZoneQueueFence } from './coreZones.ts'
import type { MusicFocusPlay } from './musicFocus.ts'
import type { MusicTagsPlay } from './musicTags.ts'

/** An explicit session, not a change to the legacy main-player route. */
export interface ZoneQueueTarget { kind: 'zone' | 'group'; id: string; revision: number }
export type ZoneMusicSelection =
  | { kind: 'catalog'; revision: number; sourceIds: string[]; selectedIndex?: number }
  | { kind: 'focus'; input: MusicFocusPlay }
  | { kind: 'tag'; input: MusicTagsPlay }
  | { kind: 'playlist'; id: string; revision: number; versionsRevision: number }
export interface ZoneQueueLoad {
  target: ZoneQueueTarget
  /** A replacement confirmation is tied to the queue the user actually saw. */
  queue: ZoneQueueFence | null
  selection: ZoneMusicSelection
  play: boolean
}
export interface ZoneQueueKey { id: string; revision: number }
export type ZoneQueueEdit =
  | { kind: 'remove'; entryIds: string[] }
  | { kind: 'move'; entryId: string; beforeEntryId: string | null }
  | { kind: 'order'; order: 'original' | 'shuffle' }
  | { kind: 'clear' }
