import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { TrackData } from '../../shared/track.ts'
import type {
  CoreMetadataCandidates,
  LibraryMetadataEnrichmentStatus
} from '../../shared/coreMetadata.ts'
import {
  buildMetadataMatchCandidates,
  enrichLocalTrackMetadata,
  type MetadataEnrichmentPolicy,
  type MetadataMatchCandidate
} from '../../shared/musicMetadataMatching.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'
import { projectCoreTrack } from '../projections.ts'
import {
  LibraryMetadataEnrichmentQueue,
  type LibraryMetadataEnrichmentProvider,
  type LibraryMetadataEnrichmentTrackUpdate
} from './metadataEnrichment.ts'
import { searchMetadataTracks } from './metadataSearch.ts'
import { patchLibraryMetadataBatch } from './metadataPatch.ts'
import { deferMacrotask } from '../../shared/portableAsync.ts'
import { CoreEntityMetadataService, type EntityMetadataOptions } from './entityMetadataService.ts'

interface Options {
  entities?: EntityMetadataOptions
  database: Pick<LibraryDatabaseApi, 'queryTracks' | 'getTracksByIds' | 'patchTracks'>
  provider: LibraryMetadataEnrichmentProvider
  available(): boolean
  policy(): MetadataEnrichmentPolicy
  now(): number
  newId(): string
  changed(): void
  libraryChanged(): void
  failed(error: unknown): void
}
interface Candidates {
  source: TrackData
  version: number
  items: MetadataMatchCandidate[]
}

type PendingUpdate = {
  update: LibraryMetadataEnrichmentTrackUpdate
  generation: number
  resolve(): void
  reject(error: unknown): void
}

const WRITE_BATCH_SIZE = 25
const WRITE_DELAY_MS = 100

/** Provider work and version-fenced commits survive UI detachment, never a second library writer. */
export class CoreMetadataService {
  readonly entities: CoreEntityMetadataService | undefined
  private readonly options: Options
  private readonly queue: LibraryMetadataEnrichmentQueue
  private activated = false
  private stopped = false
  private suspended = false
  private requested = false
  private generation = 0
  private task: Promise<void> | null = null
  private readonly lifetime = new AbortController()
  private readonly requests = new Set<Promise<unknown>>()
  private seen = new Map<string, string>()
  private readonly candidates = new Map<string, Candidates>()
  private status: LibraryMetadataEnrichmentStatus | null = null
  private totals = { total: 0, completed: 0, failed: 0, skipped: 0, error: '' }
  private readonly updates: PendingUpdate[] = []
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private writeTask: Promise<void> | null = null
  constructor(options: Options) {
    this.options = options
    this.entities = options.entities ? new CoreEntityMetadataService(options.entities) : undefined
    this.queue = new LibraryMetadataEnrichmentQueue({
      provider: options.provider,
      // Foreground searches and playback use these providers too.
      concurrency: 2,
      now: options.now,
      onStatus: (status) => {
        const totals = this.totals
        this.status = {
          ...status,
          total: totals.total + status.total,
          completed: totals.completed + status.completed,
          failed: totals.failed + status.failed,
          skipped: totals.skipped + status.skipped,
          error: status.error || totals.error
        }
        if (status.state === 'completed' && this.status.completed === 0 && this.status.failed > 0)
          this.status.state = 'failed'
        options.changed()
      },
      onTracksEnriched: (updates) => this.saveUpdates(updates)
    })
  }
  private async saveUpdates(updates: LibraryMetadataEnrichmentTrackUpdate[]): Promise<void> {
    const results = await Promise.allSettled(
      updates.map(
        (update) =>
          new Promise<void>((resolve, reject) => {
            this.updates.push({ update, generation: this.generation, resolve, reject })
            this.scheduleWrites()
          })
      )
    )
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
  private scheduleWrites(): void {
    if (this.writeTimer || this.writeTask || !this.updates.length) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.writeTask = this.flushUpdates().finally(() => {
        this.writeTask = null
        this.scheduleWrites()
      })
    }, WRITE_DELAY_MS)
  }
  private async flushUpdates(): Promise<void> {
    while (this.updates.length) {
      const batch = this.updates.splice(0, WRITE_BATCH_SIZE)
      const generation = batch[0].generation
      try {
        const saved = await patchLibraryMetadataBatch(
          this.options.database,
          batch.map((item) => item.update),
          () => !this.stopped && !this.suspended && generation === this.generation
        )
        if (saved) {
          for (const record of saved.tracks)
            this.seen.set(record.id, signature(libraryTrack(record)))
          this.options.changed()
          this.options.libraryChanged()
        }
        for (const item of batch) item.resolve()
      } catch (error) {
        for (const item of batch) item.reject(error)
      }
      // A fast/cache-hit provider must not turn a whole page into one long turn.
      if (this.updates.length) await new Promise<void>((done) => deferMacrotask(done))
    }
  }
  activate(): void {
    if (this.activated || this.stopped) return
    this.activated = true
    this.entities?.activate()
    this.refresh()
  }
  snapshot() {
    return { ...(this.status ?? this.queue.getStatus()) }
  }
  /** Called at scan completion/provider inventory changes, never on renderer attachment. */
  refresh(force = false): void {
    if (!this.activated || this.stopped || this.suspended || !this.options.available()) return
    if (force) this.seen.clear()
    this.requested = true
    if (this.task) return
    this.task = (async () => {
      while (this.requested && !this.stopped && !this.suspended) {
        this.requested = false
        const generation = this.generation
        this.totals = { total: 0, completed: 0, failed: 0, skipped: 0, error: '' }
        const policy = this.options.policy()
        if (!policy.cover && !policy.lyrics && !policy.metadata) continue
        const present = new Set<string>()
        for (let offset = 0; ; offset += 200) {
          const page = await this.options.database.queryTracks({
            sort: 'insertion',
            offset,
            limit: 200
          })
          if (this.stopped || this.suspended || generation !== this.generation) break
          const tracks = page.tracks.map(libraryTrack)
          const selected = tracks.filter((track) => {
            present.add(track.id)
            const key = signature(track)
            if (this.seen.get(track.id) === key) return false
            this.seen.set(track.id, key)
            return true
          })
          await this.queue.enqueue(selected, policy)
          await this.queue.join()
          const status = this.snapshot()
          this.totals = {
            total: status.total,
            completed: status.completed,
            failed: status.failed,
            skipped: status.skipped,
            error: status.error
          }
          if (this.stopped || this.suspended || generation !== this.generation) break
          if (offset + page.tracks.length >= page.total) {
            for (const id of this.seen.keys()) if (!present.has(id)) this.seen.delete(id)
            break
          }
        }
      }
    })()
      .catch(this.options.failed)
      .finally(() => {
        this.task = null
      })
  }
  start(): void {
    this.suspended = false
    this.seen.clear()
    this.refresh()
  }
  cancel(): boolean {
    const active = this.task !== null
    this.suspended = true
    this.requested = false
    this.generation++
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = null
    for (const item of this.updates.splice(0)) item.resolve()
    return this.queue.cancel() || active
  }
  private request<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const current = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])])
    const work = operation(current)
    this.requests.add(work)
    void work.then(
      () => this.requests.delete(work),
      () => this.requests.delete(work)
    )
    return work
  }
  find(id: string, version: number, signal?: AbortSignal): Promise<CoreMetadataCandidates> {
    return this.request(async (current) => {
      current.throwIfAborted()
      const source = await this.read(id, version)
      const tracks = await searchMetadataTracks(
        [source],
        (query, limit, offset, signal) =>
          this.options.provider.searchSongs(query, limit, offset, signal),
        { signal: current }
      )
      current.throwIfAborted()
      await this.read(id, version)
      const items = buildMetadataMatchCandidates(source, tracks).slice(0, 100)
      const token = this.options.newId()
      // A bounded window of authority-owned candidates, not client-provided snapshots/URLs.
      if (this.candidates.size >= 16) this.candidates.delete(this.candidates.keys().next().value!)
      this.candidates.set(token, { source, version, items })
      return {
        token,
        id,
        version,
        items: items.map((item) => ({
          track: projectCoreTrack(item.track)!,
          confidence: item.confidence,
          score: item.score,
          fills: item.fills
        }))
      }
    }, signal)
  }
  async apply(token: string, index: number, signal?: AbortSignal): Promise<void> {
    return this.request(async (current) => {
      current.throwIfAborted()
      const selection = this.candidates.get(token)
      const match = selection?.items[index]
      if (!selection || !match) throw new Error('元数据候选已失效，请重新搜索')
      const source = await this.read(selection.source.id, selection.version)
      current.throwIfAborted()
      const enriched = enrichLocalTrackMetadata(source, match, this.options.policy())
      await this.options.database.patchTracks([
        {
          id: source.id,
          expectedVersion: selection.version,
          patch: metadataFields(enriched)
        }
      ])
      this.candidates.delete(token)
      this.seen.set(source.id, signature(enriched))
      this.options.changed()
      this.options.libraryChanged()
    }, signal)
  }
  async clear(id: string, version: number, signal?: AbortSignal): Promise<void> {
    return this.request(async (current) => {
      current.throwIfAborted()
      await this.read(id, version)
      current.throwIfAborted()
      await this.options.database.patchTracks([
        { id, expectedVersion: version, patch: { metadataMatch: null } }
      ])
      this.options.changed()
      this.options.libraryChanged()
    }, signal)
  }
  private async read(id: string, version: number): Promise<TrackData> {
    const page = await this.options.database.getTracksByIds([id])
    const record = page.tracks.find((track) => track.id === id)
    if (!record || page.versions[id] !== version)
      throw Object.assign(new Error('曲目已变化，请重新打开元数据匹配'), { code: 'STALE_REVISION' })
    const track = libraryTrack(record)
    if (track.source !== 'local') throw new Error('只能匹配本地曲目的元数据')
    return track
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    this.cancel()
    this.lifetime.abort(new Error('Core metadata service stopped'))
    await Promise.all([
      this.entities?.shutdown(),
      this.task,
      this.queue.join(),
      this.writeTask,
      Promise.allSettled([...this.requests])
    ])
    this.candidates.clear()
  }
}

function signature(track: TrackData): string {
  return JSON.stringify([
    track.filePath,
    track.title,
    track.artist,
    track.album,
    track.duration,
    track.cueRange,
    track.genre,
    !!track.cover,
    !!track.lyrics,
    !!track.translatedLyrics,
    track.metadataMatch
  ])
}
function metadataFields(track: TrackData): Record<string, unknown> {
  return Object.fromEntries(
    [
      'artist',
      'album',
      'genre',
      'cover',
      'lyrics',
      'translatedLyrics',
      'lyricsSource',
      'translatedLyricsSource',
      'metadataMatch'
    ].flatMap((field) =>
      track[field as keyof TrackData] === undefined
        ? []
        : [[field, track[field as keyof TrackData]]]
    )
  )
}
