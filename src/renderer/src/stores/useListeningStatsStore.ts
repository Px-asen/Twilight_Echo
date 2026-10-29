import { computed } from 'vue'
import { useCoreConnection } from './coreConnection.ts'
import { createCoreListeningStats } from './coreListeningStats.ts'
import type { ListeningStats, ListeningTrackStatWithId } from '../../../shared/listeningStats.ts'
import type { CoreStatisticsTrackView } from '../../../shared/coreStatistics.ts'
import type { ListeningStatsClearRange } from '../../../shared/listeningStatsHistory.ts'
export type { ListeningStats, ListeningTrackStat, ListeningTrackSourceId, ListeningArtistStat, ListeningTrackStatWithId } from '../../../shared/listeningStats.ts'
export { LISTENING_STATS_RETENTION_DAYS, LISTENING_STATS_MAX_TRACKS, LISTENING_STATS_FLUSH_DELAY_MS, LISTENING_STATS_RETRY_DELAY_MS, buildLastPlayedByTrackId, compactListeningStatsForPersistence } from '../../../core/listening/model.ts'

let singleton: ReturnType<typeof createCoreListeningStats> | null = null
function projection() {
  const core = useCoreConnection()
  return singleton ??= createCoreListeningStats({
    state: core.state,
    overview: (signal) => core.query('statistics.overview', {}, signal),
    page: (query, signal) => core.query('statistics.tracks', query, signal),
    clear: (range, revision) => core.command('statistics.clear', { range, revision })
  })
}
export type ListeningDisplayStat = Omit<ListeningTrackStatWithId, 'track'> & { displayTrack: (NonNullable<CoreStatisticsTrackView['track']> & { cover: string | null }) | null }
function display(stat: CoreStatisticsTrackView): ListeningDisplayStat {
  const { track, ...metadata } = stat
  return { ...metadata, displayTrack: track ? { ...track, cover: stat.cover } : null }
}
/** Compatibility shape contains only the loaded ranking windows, never an all-history dataset. */
const listeningStats = computed<ListeningStats>(() => {
  const owner = projection()
  return { days: { ...owner.overview.value?.days }, tracks: Object.fromEntries(
    [...owner.windows.value.recent, ...owner.windows.value.plays, ...owner.windows.value.seconds]
      .map((stat) => [stat.id, display(stat)])
  ) }
})
const persistenceStatus = computed(() => {
  const value = projection().overview.value?.persistence
  return { state: value?.error ? 'error' as const : 'idle' as const, dirty: value?.dirty ?? false,
    failureCount: value?.failureCount ?? 0, lastError: value?.error ?? null }
})
export function useListeningStatsStore() {
  const owner = projection()
  return { listeningStats, persistenceStatus, overview: owner.overview, error: owner.error, clearListeningStats }
}
export async function clearListeningStats(range: ListeningStatsClearRange, revision?: number): Promise<boolean> {
  return projection().clear(range, revision)
}
export function getRecentTracks(limit = 100) { return projection().windows.value.recent.slice(0, limit).map(display) }
export function getTopTracks(limit = 100) { return projection().windows.value.plays.slice(0, limit).map(display) }
export function getMostListenedTracks(limit = 100) { return projection().windows.value.seconds.slice(0, limit).map(display) }
export function getTopArtists(limit = 50) { return projection().overview.value?.artists.slice(0, limit) ?? [] }
export async function waitForListeningStatsReady(): Promise<void> { await projection().ensure() }
export const libraryListeningProjection = {
  state: computed(() => projection().overview.value?.history ?? { mode: null, ready: false, pending: true, revision: null, error: projection().error.value }),
  ensure: waitForListeningStatsReady,
  retry: () => projection().refresh()
}
if (import.meta.hot) import.meta.hot.dispose(() => { singleton?.dispose(); singleton = null })
