import type { LibraryQueueEditResult, LibraryQueueInsertItem } from './libraryDatabase.ts'

export type PersonalizedStreamKey = 'fm' | 'radar'
export interface CorePersonalizedContext {
  queueId: string
  providerId: string
  key: PersonalizedStreamKey
}
export interface CorePersonalizedState extends CorePersonalizedContext {
  loading: boolean
  remaining: number
  error: string | null
}
export interface CorePersonalizedStart {
  providerId: string
  key: PersonalizedStreamKey
  selectedId?: string
  play?: boolean
}
export function isCorePersonalizedContext(value: unknown): value is CorePersonalizedContext {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.queueId === 'string' &&
    /^[\w-]{1,128}$/.test(v.queueId) &&
    typeof v.providerId === 'string' &&
    /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(v.providerId) &&
    (v.key === 'fm' || v.key === 'radar')
  )
}
/** Private append-only capability. Unlike public queue insertions, provider
 * snapshots resolve lazily. Automatic extensions are deduplicated by default and not undoable. */
export interface CoreQueueExtensionApi {
  extendPlaybackQueue(
    id: string,
    revision: number,
    items: LibraryQueueInsertItem[],
    options?: { preserveDuplicates?: boolean }
  ): Promise<LibraryQueueEditResult>
}
