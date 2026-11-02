import { FileAnalysisCache } from './fileAnalysisCache.ts'
import type { BpmAnalysisResult, BpmTempoSegment } from '../../shared/audioEngineTypes.ts'

export type { BpmAnalysisResult, BpmTempoSegment }

export const BPM_ANALYSIS_ALGORITHM_VERSION = 1
/** Soft cap on cached BPM entries; oldest analyzedAt entries are evicted first. */
export const BPM_ANALYSIS_CACHE_MAX_ENTRIES = 2048

export interface BpmAnalysisCacheIdentity {
  filePath: string
  size: number
  mtimeMs: number
  algorithmVersion?: number
}

export function buildBpmAnalysisCacheKey(identity: BpmAnalysisCacheIdentity): string {
  const algorithmVersion = identity.algorithmVersion ?? BPM_ANALYSIS_ALGORITHM_VERSION
  return [
    identity.filePath.toLowerCase(),
    Math.floor(identity.size),
    Math.floor(identity.mtimeMs),
    algorithmVersion
  ].join('|')
}

export class BpmAnalysisCache extends FileAnalysisCache<
  BpmAnalysisCacheIdentity,
  BpmAnalysisResult
> {
  constructor(cachePath: string, maxEntries = BPM_ANALYSIS_CACHE_MAX_ENTRIES) {
    const limit = Math.max(1, maxEntries)
    super(cachePath, {
      key: buildBpmAnalysisCacheKey,
      isAnalysis: isBpmAnalysisResult,
      prune: (entries) => pruneBpmCacheEntries(entries, limit)
    })
  }
}

export function pruneBpmCacheEntries(
  entries: Record<string, BpmAnalysisResult>,
  maxEntries: number
): void {
  const keys = Object.keys(entries)
  if (keys.length <= maxEntries) return
  const ordered = keys.sort((a, b) => {
    const aAt = Date.parse(entries[a]?.analyzedAt ?? '') || 0
    const bAt = Date.parse(entries[b]?.analyzedAt ?? '') || 0
    return aAt - bAt
  })
  const removeCount = keys.length - maxEntries
  for (let i = 0; i < removeCount; i += 1) {
    delete entries[ordered[i]!]
  }
}

export function isBpmAnalysisResult(value: unknown): value is BpmAnalysisResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<BpmAnalysisResult>
  return (
    result.source === 'analyzed' &&
    typeof result.bpm === 'number' &&
    Number.isFinite(result.bpm) &&
    typeof result.confidence === 'number' &&
    Number.isFinite(result.confidence) &&
    typeof result.analyzedAt === 'string' &&
    typeof result.algorithmVersion === 'number'
  )
}
