import { tryParseJsonWithNestingLimit } from '../../shared/jsonSafety.ts'
import { PortableBuffer } from '../../shared/portableBytes.ts'
import { createHash } from '../../shared/portableCrypto.ts'
import { isAutoMixAnalysisResult, type AutoMixFeatures } from '../../shared/twilightAutoMix.ts'

const SHA256 = /^[a-f0-9]{64}$/
const MODEL_VERSION = /^twilight-automix-native-1:[a-f0-9]{64}:[a-f0-9]{64}$/
const MAX_CACHE_BYTES = 16 * 1024 * 1024
const COVERAGE_EPSILON = 1 / 16000 + 1e-9
const TRAILING_FRAME_BUDGET = 1 / 50 + COVERAGE_EPSILON

/** Host supplies the actual content/resolution identity, including online quality.
 * Song IDs and URLs alone are never analysis cache identities. */
export interface TwilightAutoMixWindowIdentity {
  sourceIdentity: string
  sourceStartSeconds: number
  sourceEndSeconds: number
  modelVersion: string
  parametersSha256: string
  windowStartSeconds: number
  windowEndSeconds: number
}

type Entry = {
  identity: TwilightAutoMixWindowIdentity
  features: AutoMixFeatures
  writtenAt: number
}
type CacheFile = { version: 1; entries: Record<string, Entry> }
export interface AutoMixWindowStorage {
  read(): Promise<string | null>
  write(text: string | null): Promise<void>
}

const finite = (v: number) => typeof v === 'number' && Number.isFinite(v)
function validIdentity(i: TwilightAutoMixWindowIdentity): boolean {
  return (
    !!i &&
    SHA256.test(i.sourceIdentity) &&
    SHA256.test(i.parametersSha256) &&
    MODEL_VERSION.test(i.modelVersion) &&
    finite(i.sourceStartSeconds) &&
    finite(i.sourceEndSeconds) &&
    finite(i.windowStartSeconds) &&
    finite(i.windowEndSeconds) &&
    i.sourceStartSeconds >= 0 &&
    i.sourceEndSeconds > i.sourceStartSeconds &&
    i.sourceEndSeconds <= 604800 &&
    i.windowStartSeconds >= 0 &&
    i.windowEndSeconds > i.windowStartSeconds &&
    i.windowEndSeconds <= i.sourceEndSeconds - i.sourceStartSeconds + COVERAGE_EPSILON &&
    i.windowEndSeconds - i.windowStartSeconds <= 30.001
  )
}

export function twilightAutoMixWindowKey(i: TwilightAutoMixWindowIdentity): string {
  if (!validIdentity(i)) throw new Error('Invalid AutoMix window identity')
  return createHash('sha256')
    .update(
      JSON.stringify([
        i.sourceIdentity,
        i.sourceStartSeconds,
        i.sourceEndSeconds,
        i.modelVersion,
        i.parametersSha256,
        i.windowStartSeconds,
        i.windowEndSeconds
      ])
    )
    .digest('hex')
}

function matches(i: TwilightAutoMixWindowIdentity, f: unknown): f is AutoMixFeatures {
  if (!isAutoMixAnalysisResult(f) || !f.ok) return false
  const c = f.coverage
  return (
    f.sourceIdentity === i.sourceIdentity &&
    f.modelVersion === i.modelVersion &&
    Math.abs(c.durationSeconds - (i.sourceEndSeconds - i.sourceStartSeconds)) <= COVERAGE_EPSILON &&
    Math.abs(c.startSeconds - i.windowStartSeconds) <= COVERAGE_EPSILON &&
    Math.abs(c.endSeconds - i.windowEndSeconds) <= COVERAGE_EPSILON
  )
}
function matchesDecodedTail(i: TwilightAutoMixWindowIdentity, f: unknown): f is AutoMixFeatures {
  if (!isAutoMixAnalysisResult(f) || !f.ok) return false
  const duration = i.sourceEndSeconds - i.sourceStartSeconds
  const deficit = i.windowEndSeconds - f.coverage.endSeconds
  return (
    Math.abs(i.windowEndSeconds - duration) <= COVERAGE_EPSILON &&
    deficit > 0 &&
    deficit <= TRAILING_FRAME_BUDGET &&
    !f.coverage.complete &&
    matches({ ...i, windowEndSeconds: f.coverage.endSeconds }, f)
  )
}

export function isTwilightAutoMixWindowResult(
  identity: TwilightAutoMixWindowIdentity,
  features: unknown
): features is AutoMixFeatures {
  return matches(identity, features) || matchesDecodedTail(identity, features)
}

export class AutoMixWindowCache {
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly limit: number
  private readonly storage: AutoMixWindowStorage

  constructor(storage: AutoMixWindowStorage, limit = 128) {
    this.storage = storage
    this.limit = Math.max(1, Math.min(128, Math.floor(limit) || 128))
  }

  async get(identity: TwilightAutoMixWindowIdentity): Promise<AutoMixFeatures | null> {
    await this.mutationTail
    const key = twilightAutoMixWindowKey(identity)
    const entries = (await this.read()).entries
    const entry = entries[key]
    if (entry && matches(identity, entry.features)) return structuredClone(entry.features)
    // Some codecs expose a metadata tail shorter than one analysis frame.
    // Return that real partial range, preserving its distinct cache key and
    // coverage. Native planning still decides whether it can use the boundary.
    const partial = Object.values(entries)
      .filter(
        (candidate) =>
          candidate.identity.sourceIdentity === identity.sourceIdentity &&
          candidate.identity.sourceStartSeconds === identity.sourceStartSeconds &&
          candidate.identity.sourceEndSeconds === identity.sourceEndSeconds &&
          candidate.identity.parametersSha256 === identity.parametersSha256 &&
          candidate.identity.modelVersion === identity.modelVersion &&
          candidate.identity.windowStartSeconds === identity.windowStartSeconds &&
          matchesDecodedTail(identity, candidate.features)
      )
      .sort((a, b) => b.features.coverage.endSeconds - a.features.coverage.endSeconds)[0]
    return partial ? structuredClone(partial.features) : null
  }

  async set(identity: TwilightAutoMixWindowIdentity, features: AutoMixFeatures): Promise<void> {
    twilightAutoMixWindowKey(identity)
    const actualIdentity = matchesDecodedTail(identity, features)
      ? { ...identity, windowEndSeconds: features.coverage.endSeconds }
      : identity
    if (!matches(actualIdentity, features))
      throw new Error('AutoMix analysis does not cover its cache window')
    const key = twilightAutoMixWindowKey(actualIdentity)
    const entry: Entry = {
      identity: structuredClone(actualIdentity),
      features: structuredClone(features),
      writtenAt: Date.now()
    }
    return this.mutate(async () => {
      const cache = await this.read()
      cache.entries[key] = entry
      const ordered = Object.keys(cache.entries).sort(
        (a, b) => cache.entries[a].writtenAt - cache.entries[b].writtenAt || a.localeCompare(b)
      )
      while (ordered.length > this.limit) delete cache.entries[ordered.shift()!]
      let text = JSON.stringify(cache)
      while (PortableBuffer.byteLength(text) > MAX_CACHE_BYTES && ordered.length > 1) {
        delete cache.entries[ordered.shift()!]
        text = JSON.stringify(cache)
      }
      if (PortableBuffer.byteLength(text) > MAX_CACHE_BYTES)
        throw new Error('AutoMix cache budget exceeded')
      await this.storage.write(text)
    })
  }

  /** Union coverage is reported separately; no single window is relabelled complete. */
  async coverage(
    identity: Omit<TwilightAutoMixWindowIdentity, 'windowStartSeconds' | 'windowEndSeconds'>
  ): Promise<{
    complete: boolean
    ranges: [number, number][]
  }> {
    await this.mutationTail
    const windows = Object.values((await this.read()).entries)
      .filter(
        (e) =>
          e.identity.sourceIdentity === identity.sourceIdentity &&
          e.identity.sourceStartSeconds === identity.sourceStartSeconds &&
          e.identity.sourceEndSeconds === identity.sourceEndSeconds &&
          e.identity.modelVersion === identity.modelVersion &&
          e.identity.parametersSha256 === identity.parametersSha256
      )
      .map((e): [number, number] => [
        e.features.coverage.startSeconds,
        e.features.coverage.endSeconds
      ])
      .sort((a, b) => a[0] - b[0])
    const ranges: [number, number][] = []
    for (const range of windows) {
      const previous = ranges.at(-1)
      if (previous && range[0] <= previous[1] + COVERAGE_EPSILON)
        previous[1] = Math.max(previous[1], range[1])
      else ranges.push([...range])
    }
    const duration = identity.sourceEndSeconds - identity.sourceStartSeconds
    return {
      ranges,
      complete:
        ranges.length === 1 &&
        ranges[0][0] <= COVERAGE_EPSILON &&
        ranges[0][1] >= duration - COVERAGE_EPSILON
    }
  }

  async clear(): Promise<void> {
    return this.mutate(async () => {
      await this.storage.write(null)
    })
  }

  private async read(): Promise<CacheFile> {
    try {
      const text = (await this.storage.read()) ?? ''
      if (PortableBuffer.byteLength(text) > MAX_CACHE_BYTES) return { version: 1, entries: {} }
      const result = tryParseJsonWithNestingLimit(text)
      if (!result.ok || !result.value || typeof result.value !== 'object')
        return { version: 1, entries: {} }
      const parsed = result.value as Partial<CacheFile>
      if (
        parsed.version !== 1 ||
        !parsed.entries ||
        typeof parsed.entries !== 'object' ||
        Array.isArray(parsed.entries)
      )
        return { version: 1, entries: {} }
      const entries: Record<string, Entry> = Object.create(null)
      for (const [key, entry] of Object.entries(parsed.entries).slice(0, 128)) {
        if (
          !entry ||
          typeof entry !== 'object' ||
          !validIdentity(entry.identity) ||
          !finite(entry.writtenAt)
        )
          continue
        if (
          twilightAutoMixWindowKey(entry.identity) === key &&
          matches(entry.identity, entry.features)
        )
          entries[key] = entry
      }
      return { version: 1, entries }
    } catch {
      return { version: 1, entries: {} }
    }
  }

  private mutate(operation: () => Promise<void>): Promise<void> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.catch(() => {})
    return result
  }
}

