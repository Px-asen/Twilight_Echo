import type { MediaProviderCapability, MediaProviderSearchResult } from '../providers/mediaProvider'
import type { Track, TrackSource } from '../types/music'
import type { NetworkEntry } from '../../../shared/networkSources.ts'
import {
  buildLogicalTracks,
  clampReliability,
  getTrackSource,
  type LogicalTrack,
  type SourceVariant
} from './logicalTrackModel.ts'
import {
  compareSearchItems,
  searchUnifiedLocalPage,
  searchUnifiedNetworkPage,
  toSearchItem
} from '@renderer/utils/unifiedSearchSources.ts'

export interface UnifiedSearchProvider {
  id: string
  name: string
  capabilities: string[] | MediaProviderCapability[]
  available?: boolean
  health?: UnifiedSearchProviderReliabilityInput
}

export interface UnifiedSearchProviderReliabilityInput {
  available?: boolean
  pluginStatus?: string
  successRate?: number
  methodStats?: Record<string, { successRate?: number; lastError?: string | null } | undefined>
  lastError?: string | null
  lastCheckedAt?: string | null
}

export interface UnifiedSearchProviderHealth {
  providerId: string
  providerName: string
  available: boolean
  searchable: boolean
  resultCount: number
  lastError: string | null
  pluginStatus: string | null
  successRate: number | null
  playbackUrlSuccessRate: number | null
  playbackUrlLastError: string | null
  lastCheckedAt: string | null
}

export interface UnifiedSearchTrackItem {
  kind: 'track'
  track: Track
  source: TrackSource
  sourceName: string
  local: boolean
  lossless: boolean
  providerAvailable: boolean
  providerReliability: number
}

export type LogicalMusicVariant = SourceVariant
export type LogicalMusicItem = LogicalTrack

export interface UnifiedSearchOptions {
  query: string
  localTracks: Track[]
  networkEntries?: Array<{ profileName: string; entry: NetworkEntry }>
  providers: UnifiedSearchProvider[]
  limit?: number
  offset?: number
  searchProviderSongs: (
    providerId: string,
    keywords: string,
    limit?: number,
    offset?: number
  ) => Promise<MediaProviderSearchResult<Track>>
}

export interface UnifiedSearchResult {
  items: UnifiedSearchTrackItem[]
  logicalItems: LogicalMusicItem[]
  health: Record<string, UnifiedSearchProviderHealth>
  total: number
  hasMore?: boolean
}

export async function unifiedSearchSongs(
  options: UnifiedSearchOptions
): Promise<UnifiedSearchResult> {
  const query = options.query.trim()
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 30) || 30))
  const offset = Math.max(0, Math.trunc(options.offset ?? 0) || 0)
  if (!query) return { items: [], logicalItems: [], health: {}, total: 0, hasMore: false }
  const local = searchUnifiedLocalPage(options.localTracks, query, limit, offset)
  const network = searchUnifiedNetworkPage(options.networkEntries ?? [], query, limit, offset)
  const health: Record<string, UnifiedSearchProviderHealth> = {}
  let total = local.total + network.total
  let hasMore = local.total > offset + limit || network.total > offset + limit

  const providerItems = (
    await Promise.all(
      options.providers.map(async (provider) => {
        const providerAvailable =
          provider.available !== false && provider.health?.available !== false
        const providerReliability = getProviderReliability(provider)
        const searchable = provider.capabilities.includes('search')
        const playbackUrlHealth = provider.health?.methodStats?.getPlaybackUrl
        const baseHealth: UnifiedSearchProviderHealth = {
          providerId: provider.id,
          providerName: provider.name,
          available: providerAvailable,
          searchable,
          resultCount: 0,
          lastError: provider.health?.lastError ?? null,
          pluginStatus: provider.health?.pluginStatus ?? null,
          successRate:
            typeof provider.health?.successRate === 'number' ? provider.health.successRate : null,
          playbackUrlSuccessRate:
            typeof playbackUrlHealth?.successRate === 'number'
              ? playbackUrlHealth.successRate
              : null,
          playbackUrlLastError: playbackUrlHealth?.lastError ?? null,
          lastCheckedAt: provider.health?.lastCheckedAt ?? null
        }
        health[provider.id] = baseHealth
        if (!query || !searchable || !providerAvailable) return []

        try {
          const result = await options.searchProviderSongs(provider.id, query, limit, offset)
          baseHealth.resultCount = result.items.length
          total += result.total
          hasMore ||= result.total > offset + limit
          return result.items.slice(0, limit).map((track) =>
            toSearchItem(track, {
              sourceName: provider.name,
              providerAvailable: true,
              providerReliability,
              source: provider.id
            })
          )
        } catch (error) {
          baseHealth.available = false
          baseHealth.lastError = error instanceof Error ? error.message : String(error)
          return []
        }
      })
    )
  ).flat()

  const items = [...local.items, ...network.items, ...providerItems].sort(compareSearchItems)
  return {
    items,
    logicalItems: buildLogicalMusicItemsFromSearchItems(items),
    health,
    total,
    hasMore
  }
}

export function buildLogicalMusicItems(tracks: Track[]): LogicalMusicItem[] {
  return buildLogicalMusicItemsFromSearchItems(
    tracks.map((track) =>
      toSearchItem(track, {
        sourceName: getTrackSource(track) === 'local' ? '本地音乐' : getTrackSource(track),
        providerAvailable: true
      })
    )
  )
}

function buildLogicalMusicItemsFromSearchItems(
  searchItems: UnifiedSearchTrackItem[]
): LogicalMusicItem[] {
  return buildLogicalTracks(searchItems)
}

function getProviderReliability(provider: UnifiedSearchProvider): number {
  const playbackUrlSuccessRate = provider.health?.methodStats?.getPlaybackUrl?.successRate
  if (typeof playbackUrlSuccessRate === 'number') return clampReliability(playbackUrlSuccessRate)
  if (typeof provider.health?.successRate === 'number')
    return clampReliability(provider.health.successRate)
  return provider.available === false || provider.health?.available === false ? 0 : 1
}
