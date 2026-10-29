import { CoreApplication } from './application.ts'
import { defaultPortableDspSettings, normalizePortableDspSettings, type PortableDspSettings, type PortableDspScene } from '../shared/portableAudio.ts'
import { CoreBookmarksService } from './bookmarks/service.ts'
import { CoreLyricsService } from './lyrics/service.ts'
import { CorePlayerPresentationService } from './playback/presentationService.ts'
import {
  CorePlaybackSession,
  type CorePlaybackEngine,
  type CoreSessionRepository
} from './playback/session.ts'
import { CoreQueueSubmission } from './playback/queueSubmission.ts'
import { CoreRecordingVersions } from './playlists/recordingVersions.ts'
import { CorePlaylistService } from './playlists/service.ts'
import {
  CorePlaylistSubmission,
  createPlaylistInputResolver
} from './playlists/submission.ts'
import { CoreMusicSearchService } from './search/service.ts'
import { CoreSettingsService } from './settings/service.ts'
import {
  createDefaultSettings,
  normalizeAppSettings,
  type SettingsEnvironment
} from './settings/normalization.ts'
import type { AppSettings } from '../shared/appSettings.ts'
import {
  CORE_PROTOCOL_VERSION,
  type CoreClientIdentity,
  type CoreClientMessage,
  type CoreRequestEnvelope,
  type CoreSnapshot
} from '../shared/coreProtocol.ts'
import { emptyCoreStateCounts, type CoreStateApi } from '../shared/coreState.ts'
import type {
  AudioEnginePlayResult,
  AudioEngineQueueItem,
  CorePlatformId,
  PlaybackInfo,
  PlayMode
} from '../shared/audioEngineTypes.ts'
import {
  LIBRARY_PAGE_SIZE,
  libraryQueueResumeMode,
  type LibraryCollectionKind,
  type LibraryCollectionPage,
  type LibraryCollectionSummary,
  type LibraryMetadata,
  type LibraryPage,
  type LibraryPlaylistViewSync,
  type LibraryPlaylistViewSyncResult,
  type LibraryQuery,
  type LibraryQueueEdit,
  type LibraryQueueEditResult,
  type LibraryQueuePage,
  type LibraryQueuePlayMode,
  type LibraryQueueReadOptions,
  type LibraryQueueSnapshot,
  type LibraryTrackRecord
} from '../shared/libraryDatabase.ts'
import type {
  LibraryQueueBuildCommand,
  LibraryQueueBuildReply,
  LibraryQueueSeedItem
} from '../shared/libraryQueueBuild.ts'
import {
  DEFAULT_LYRICS_MANAGEMENT,
  cloneLyricsManagementDocument,
  type LyricsManagementDocument,
  type OnlineLyricsQuery,
  type OnlineLyricsSearchResult
} from '../shared/lyricsManagement.ts'
import {
  DEFAULT_PLAYBACK_BOOKMARKS,
  clonePlaybackBookmarksDocument,
  type PlaybackBookmarksDocument
} from '../shared/playbackBookmarks.ts'
import type { PlaybackSessionData } from '../shared/playbackSession.ts'
import type { Playlist } from '../shared/playlists.ts'
import type { TrackData } from '../shared/track.ts'
import type {
  NativeQueueCommit,
  NativeQueueRebind,
  NativeQueueSelection
} from '../shared/nativeQueue.ts'

export interface CoreCancelEnvelope {
  kind: 'cancel'
  requestId: string
  epoch: string
}

const PORTABLE_HOST_PERMISSIONS: CoreClientIdentity['permissions'] = [
  'playback:read',
  'playback:write',
  'library:read',
  'library:write',
  'settings:read',
  'settings:write',
  'migration:write',
  'statistics:read',
  'statistics:write',
  'plugins:read',
  'plugins:manage',
  'plugins:resources',
  'providers:call',
  'extensions:execute',
  'downloads:read',
  'downloads:write'
]

// ============================================================================
// 1. Embedded JS Runtime Minimal Environment Shims (QuickJS / JSC / Bare VM)
// ============================================================================

let fallbackUuidCounter = 0

function generateFallbackUuid(): `${string}-${string}-${string}-${string}-${string}` {
  fallbackUuidCounter = (fallbackUuidCounter + 1) >>> 0
  const randHex = (len: number) => {
    let out = ''
    for (let i = 0; i < len; i++) {
      out += Math.floor(Math.random() * 16).toString(16)
    }
    return out
  }
  const prefix = (Date.now() & 0xffffffff).toString(16).padStart(8, '0')
  const seq = (fallbackUuidCounter & 0xffff).toString(16).padStart(4, '0')
  return `${prefix}-${seq}-4${randHex(3)}-8${randHex(3)}-${randHex(12)}`
}

export function ensurePortableRuntimeGlobals(): void {
  const g = globalThis as Record<string, any>

  if (!g.crypto || typeof g.crypto.randomUUID !== 'function') {
    const existingCrypto = g.crypto && typeof g.crypto === 'object' ? g.crypto : {}
    try {
      existingCrypto.randomUUID = generateFallbackUuid
      g.crypto = existingCrypto
    } catch {
      // Ignore if globalThis.crypto is read-only
    }
  }

  if (typeof g.structuredClone !== 'function') {
    g.structuredClone = function portableStructuredClone<T>(value: T): T {
      if (value === undefined || value === null || typeof value !== 'object') return value
      if (value instanceof Date) return new Date(value.getTime()) as unknown as T
      if (value instanceof Uint8Array) return new Uint8Array(value) as unknown as T
      if (Array.isArray(value)) return value.map((item) => portableStructuredClone(item)) as unknown as T
      if (value instanceof Map) {
        const out = new Map()
        for (const [k, v] of value.entries()) out.set(portableStructuredClone(k), portableStructuredClone(v))
        return out as unknown as T
      }
      if (value instanceof Set) {
        const out = new Set()
        for (const v of value.values()) out.add(portableStructuredClone(v))
        return out as unknown as T
      }
      const copy: Record<string, unknown> = {}
      for (const key of Object.keys(value as Record<string, unknown>)) {
        copy[key] = portableStructuredClone((value as Record<string, unknown>)[key])
      }
      return copy as T
    }
  }

  if (typeof g.AbortController !== 'function') {
    class PortableAbortSignal {
      aborted = false
      reason: unknown = undefined
      private readonly listeners = new Set<() => void>()
      addEventListener(_type: string, listener: () => void): void {
        if (this.aborted) {
          listener()
          return
        }
        this.listeners.add(listener)
      }
      removeEventListener(_type: string, listener: () => void): void {
        this.listeners.delete(listener)
      }
      throwIfAborted(): void {
        if (this.aborted) {
          throw this.reason ?? new Error('The operation was aborted')
        }
      }
      _trigger(reason?: unknown): void {
        if (this.aborted) return
        this.aborted = true
        this.reason = reason ?? new Error('The operation was aborted')
        for (const listener of [...this.listeners]) {
          try {
            listener()
          } catch {
            // Ignore listener errors
          }
        }
        this.listeners.clear()
      }
      static abort(reason?: unknown): PortableAbortSignal {
        const sig = new PortableAbortSignal()
        sig._trigger(reason)
        return sig
      }
      static any(signals: Iterable<PortableAbortSignal>): PortableAbortSignal {
        const composite = new PortableAbortSignal()
        for (const sig of signals) {
          if (!sig) continue
          if (sig.aborted) {
            composite._trigger(sig.reason)
            return composite
          }
          sig.addEventListener('abort', () => {
            composite._trigger(sig.reason)
          })
        }
        return composite
      }
    }
    class PortableAbortController {
      readonly signal = new PortableAbortSignal()
      abort(reason?: unknown): void {
        this.signal._trigger(reason)
      }
    }
    g.AbortSignal = PortableAbortSignal
    g.AbortController = PortableAbortController
  }

  if (typeof g.TextEncoder !== 'function') {
    class PortableTextEncoder {
      readonly encoding = 'utf-8'
      encode(input = ''): Uint8Array {
        const str = String(input)
        const bytes: number[] = []
        for (let i = 0; i < str.length; i++) {
          let codePoint = str.charCodeAt(i)
          if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < str.length) {
            const next = str.charCodeAt(i + 1)
            if (next >= 0xdc00 && next <= 0xdfff) {
              codePoint = ((codePoint - 0xd800) << 10) + (next - 0xdc00) + 0x10000
              i++
            }
          }
          if (codePoint <= 0x7f) {
            bytes.push(codePoint)
          } else if (codePoint <= 0x7ff) {
            bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f))
          } else if (codePoint <= 0xffff) {
            bytes.push(
              0xe0 | (codePoint >> 12),
              0x80 | ((codePoint >> 6) & 0x3f),
              0x80 | (codePoint & 0x3f)
            )
          } else {
            bytes.push(
              0xf0 | (codePoint >> 18),
              0x80 | ((codePoint >> 12) & 0x3f),
              0x80 | ((codePoint >> 6) & 0x3f),
              0x80 | (codePoint & 0x3f)
            )
          }
        }
        return new Uint8Array(bytes)
      }
    }
    g.TextEncoder = PortableTextEncoder
  }

  if (typeof g.TextDecoder !== 'function') {
    class PortableTextDecoder {
      readonly encoding = 'utf-8'
      decode(input?: ArrayBuffer | ArrayBufferView): string {
        if (!input) return ''
        const bytes =
          input instanceof Uint8Array
            ? input
            : ArrayBuffer.isView(input)
              ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
              : new Uint8Array(input)
        let out = ''
        for (let i = 0; i < bytes.length; i++) {
          out += String.fromCharCode(bytes[i]!)
        }
        try {
          return decodeURIComponent(escape(out))
        } catch {
          return out
        }
      }
    }
    g.TextDecoder = PortableTextDecoder
  }

  if (typeof g.Intl !== 'object' || g.Intl === null) {
    g.Intl = {}
  }
  if (typeof g.Intl.Collator !== 'function') {
    class PortableCollator {
      private readonly locale: string
      private readonly options: Record<string, unknown>
      readonly compare: (a: string, b: string) => number
      constructor(locales?: string | string[], options?: Record<string, unknown>) {
        this.locale = Array.isArray(locales) ? String(locales[0] ?? 'en') : String(locales ?? 'en')
        this.options = options ?? {}
        this.compare = (a: string, b: string): number => {
          const sa = String(a ?? '')
          const sb = String(b ?? '')
          if (sa === sb) return 0
          return sa < sb ? -1 : 1
        }
      }
      resolvedOptions() {
        return { locale: this.locale, ...this.options }
      }
    }
    g.Intl.Collator = PortableCollator
  }

  if (typeof g.URL !== 'function') {
    class PortableURL {
      href: string
      protocol: string
      username = ''
      password = ''
      host: string
      hostname: string
      port: string
      pathname: string
      search: string
      hash: string
      constructor(url: string) {
        const raw = String(url ?? '').trim()
        const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^/:?#]+)(?::([0-9]+))?(\/[^?#]*)?(\?[^#]*)?(#.*)?$/.exec(
          raw
        )
        if (!match) {
          throw new TypeError(`Invalid URL: ${raw}`)
        }
        this.href = raw
        this.protocol = match[1]!.toLowerCase()
        this.username = match[2] ?? ''
        this.password = match[3] ?? ''
        this.hostname = match[4]!
        this.port = match[5] ?? ''
        this.host = this.port ? `${this.hostname}:${this.port}` : this.hostname
        this.pathname = match[6] || '/'
        this.search = match[7] ?? ''
        this.hash = match[8] ?? ''
      }
      toString(): string {
        return this.href
      }
    }
    g.URL = PortableURL
  }

  if (typeof g.console !== 'object' || g.console === null) {
    const noop = () => {}
    g.console = { log: noop, info: noop, warn: noop, error: noop, debug: noop }
  }
}

ensurePortableRuntimeGlobals()

// ============================================================================
// 2. Capability Port Contracts (Section 8.1 of Architecture & Migration Plan)
// ============================================================================

export type PortableResourceId = string
export type PortableUnsubscribe = () => void

export interface PortableCancelHandle {
  cancel(): void
}

export interface PortableClockPort {
  nowUnixMs(): number
  nowMonotonicMs(): number
}

export interface PortableSchedulerPort {
  schedule(delayMs: number, task: () => void): PortableCancelHandle
}

export interface PortableStoredSession {
  revision: string
  payloadJson: string
}

export type PortableSaveSessionResult =
  | { ok: true; revision: string }
  | { ok: false; reason: 'conflict' }

export interface PortableSessionStorePort {
  load(): Promise<PortableStoredSession | null>
  save(
    payloadJson: string,
    expectedRevision: string | null
  ): Promise<PortableSaveSessionResult>
}

export type PortableAudioNativeEvent =
  | { type: 'playback-info'; info: PlaybackInfo }
  | { type: 'end-file'; reason?: string }
  | { type: 'error'; message: string; code?: string; recoverable?: boolean }
  | { type: 'crashed'; reason?: string }

export interface PortableAudioEnginePort {
  start?(): Promise<void>
  loadQueue(items: AudioEngineQueueItem[], startIndex?: number): Promise<void>
  play(
    source: PortableResourceId,
    positionSeconds?: number
  ): Promise<AudioEnginePlayResult>
  pause(): Promise<void>
  stop(): Promise<void>
  seek(positionSeconds: number): Promise<void>
  setVolume(volume: number): Promise<void>
  setPlaybackRate(rate: number): Promise<void>
  setPlayMode(mode: PlayMode): Promise<void>
  selectQueueIndex?(index: number): Promise<boolean>
  next?(): Promise<boolean>
  previous?(): Promise<boolean>
  setDspConfig?(config: CoreEqConfigView): Promise<void> | void
  getSnapshot(): Promise<PlaybackInfo>
  subscribe(listener: (event: PortableAudioNativeEvent) => void): PortableUnsubscribe
}

export interface CorePlaylistView {
  id: string
  name: string
  trackIds: string[]
  trackCount: number
  updatedAtMs: number
}

export interface CoreAlbumCollectionView {
  id: string
  title: string
  name: string
  artist: string
  trackCount: number
  totalDurationSec: number
  trackIds: string[]
}

export interface CoreArtistCollectionView {
  id: string
  name: string
  albumCount: number
  trackCount: number
  trackIds: string[]
}

export interface CoreLibraryCollectionsView {
  albums: CoreAlbumCollectionView[]
  artists: CoreArtistCollectionView[]
}

export interface CoreEqConfigView {
  enabled: boolean
  preset: string
  preampDb: number
  bandsDb: number[]
  bitPerfect: boolean
  gapless: boolean
  dsp?: PortableDspSettings
  scenes?: PortableDspScene[]
}

export const PORTABLE_EQ_PRESETS: Record<string, readonly number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass Boost': [5.5, 4.5, 3.0, 1.0, 0, 0, 0, 0, 0, 0],
  Rock: [4.0, 3.0, 1.5, -1.0, -1.5, 0, 2.0, 3.5, 4.0, 4.0],
  Vocal: [-1.5, -1.0, 0, 2.0, 4.0, 4.0, 2.5, 1.0, 0, -0.5],
  Electronic: [4.5, 4.0, 1.5, 0, -1.5, 1.0, 0.5, 2.0, 4.0, 4.5],
  Classical: [3.5, 2.5, 1.5, 1.0, -0.5, -0.5, 0, 1.5, 2.5, 3.0]
}

export function createDefaultEqConfig(): CoreEqConfigView {
  return {
    enabled: false,
    preset: 'Flat',
    preampDb: 0,
    bandsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bitPerfect: false,
    gapless: true,
    dsp: defaultPortableDspSettings(),
    scenes: []
  }
}

export function applyEqConfigPatch(
  current: CoreEqConfigView,
  patch: Partial<CoreEqConfigView> | null | undefined
): CoreEqConfigView {
  if (!patch || typeof patch !== 'object') {
    return structuredClone(current)
  }
  const clampDb = (val: number) => Math.max(-12, Math.min(12, Number(val) || 0))
  const nextPreset = typeof patch.preset === 'string' && patch.preset.trim().length > 0
    ? patch.preset.trim()
    : current.preset
  let nextBands = [...current.bandsDb]
  if (Array.isArray(patch.bandsDb) && patch.bandsDb.length > 0) {
    nextBands = Array.from({ length: 10 }, (_, idx) => clampDb(Number(patch.bandsDb![idx] ?? 0)))
  } else if (typeof patch.preset === 'string' && PORTABLE_EQ_PRESETS[nextPreset]) {
    nextBands = [...PORTABLE_EQ_PRESETS[nextPreset]!]
  }
  const next = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    preset: nextPreset,
    preampDb: typeof patch.preampDb === 'number' ? clampDb(patch.preampDb) : current.preampDb,
    bandsDb: nextBands,
    bitPerfect: typeof patch.bitPerfect === 'boolean' ? patch.bitPerfect : current.bitPerfect,
    gapless: typeof patch.gapless === 'boolean' ? patch.gapless : current.gapless,
    dsp: patch.dsp ? normalizePortableDspSettings(patch.dsp) : structuredClone(current.dsp ?? defaultPortableDspSettings()),
    scenes: Array.isArray(patch.scenes) ? structuredClone(patch.scenes.slice(0, 32)) : structuredClone(current.scenes ?? [])
  }
  if (next.dsp.sampleRateFamilySync && !next.bitPerfect) throw new Error('Family sync requires source-first playback')
  if (next.bitPerfect && next.dsp.outputStage.targetSampleRate > 0 && next.dsp.allowedSampleRates.length > 0 &&
    !next.dsp.allowedSampleRates.includes(next.dsp.outputStage.targetSampleRate))
    throw new Error('Fixed sample rate is not in the allowed set')
  return next
}

export function aggregateLibraryCollections(
  tracks: ReadonlyArray<{
    id: string
    title?: string
    artist?: string
    album?: string
    duration?: number
    durationSec?: number
  }>
): CoreLibraryCollectionsView {
  const albumMap = new Map<
    string,
    {
      id: string
      title: string
      name: string
      artist: string
      trackCount: number
      totalDurationSec: number
      trackIds: string[]
    }
  >()
  const artistMap = new Map<
    string,
    {
      id: string
      name: string
      albums: Set<string>
      trackCount: number
      trackIds: string[]
    }
  >()

  const slugify = (text: string, fallbackPrefix: string, index: number) => {
    const slug = text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    return slug ? `${fallbackPrefix}-${slug}` : `${fallbackPrefix}-${index}`
  }

  let idx = 0
  for (const track of tracks) {
    idx += 1
    const albumTitle = String(track.album || 'Unknown Album').trim() || 'Unknown Album'
    const artistName = String(track.artist || 'Unknown Artist').trim() || 'Unknown Artist'
    const durationSec =
      typeof track.durationSec === 'number'
        ? Math.round(track.durationSec)
        : Math.round(Number(track.duration) || 0)

    const albumKey = albumTitle.toLowerCase()
    const existingAlbum = albumMap.get(albumKey)
    if (existingAlbum) {
      existingAlbum.trackCount += 1
      existingAlbum.totalDurationSec += durationSec
      existingAlbum.trackIds.push(String(track.id))
    } else {
      albumMap.set(albumKey, {
        id: slugify(albumTitle, 'alb', idx),
        title: albumTitle,
        name: albumTitle,
        artist: artistName,
        trackCount: 1,
        totalDurationSec: durationSec,
        trackIds: [String(track.id)]
      })
    }

    const artistKey = artistName.toLowerCase()
    const existingArtist = artistMap.get(artistKey)
    if (existingArtist) {
      existingArtist.albums.add(albumKey)
      existingArtist.trackCount += 1
      existingArtist.trackIds.push(String(track.id))
    } else {
      artistMap.set(artistKey, {
        id: slugify(artistName, 'art', idx),
        name: artistName,
        albums: new Set([albumKey]),
        trackCount: 1,
        trackIds: [String(track.id)]
      })
    }
  }

  return {
    albums: [...albumMap.values()],
    artists: [...artistMap.values()].map((a) => ({
      id: a.id,
      name: a.name,
      albumCount: a.albums.size,
      trackCount: a.trackCount,
      trackIds: a.trackIds
    }))
  }
}

export interface PortableResourceAccessPort {
  authorize(resourceId: PortableResourceId): Promise<string>
  resolveTrackSource?(
    track: TrackData
  ): Promise<{ source: PortableResourceId; expiresAt: number | null }>
}

export interface PortableLyricsPort {
  loadLocalLyrics?(
    track: TrackData,
    kind: 'original' | 'translated' | 'romanized',
    signal: AbortSignal
  ): Promise<string | null>
  loadOnlineLyrics?(query: OnlineLyricsQuery, signal: AbortSignal): Promise<string | null>
  searchOnlineLyrics?(track: TrackData, signal?: AbortSignal): Promise<OnlineLyricsSearchResult>
}

export interface PortableHostOptions {
  epoch?: string
  platform?: CorePlatformId
  clock?: PortableClockPort
  scheduler?: PortableSchedulerPort
  sessionStore: PortableSessionStorePort
  audioEngine: PortableAudioEnginePort
  resourceAccess?: PortableResourceAccessPort
  lyrics?: PortableLyricsPort
  initialTracks?: TrackData[]
  initialSettings?: Partial<AppSettings>
  onFatalError?: (error: Error) => void
}

// ============================================================================
// 3. Portable In-Memory Queue & Library Store (Durable via SessionStorePort)
// ============================================================================

interface StoredQueueRow {
  queueEntryId: string
  originalOrder: number
  trackId: string
  snapshot: LibraryTrackRecord | null
}

interface StoredQueueRecord {
  id: string
  revision: number
  index: number
  selectedEntryId: string | null
  order: 'original' | 'shuffle'
  playMode?: LibraryQueuePlayMode
  rows: StoredQueueRow[]
  undoStack: Array<{
    label: string
    rows: StoredQueueRow[]
    index: number
    selectedEntryId: string | null
    order: 'original' | 'shuffle'
    playMode?: LibraryQueuePlayMode
  }>
}

const PORTABLE_ENVELOPE_SCHEMA = 'portable-core/1'

interface PersistedEnvelope {
  schema?: typeof PORTABLE_ENVELOPE_SCHEMA
  session: PlaybackSessionData<TrackData> | null
  queues: Array<{
    id: string
    revision: number
    index: number
    selectedEntryId: string | null
    order: 'original' | 'shuffle'
    playMode?: LibraryQueuePlayMode
    rows: StoredQueueRow[]
  }>
  tracks: LibraryTrackRecord[]
  settings?: Partial<AppSettings>
  bookmarks?: PlaybackBookmarksDocument
  lyricsManagement?: LyricsManagementDocument
  playlists?: Playlist[]
  /** Read-only input from hosts that kept a parallel playlist list. */
  customPlaylists?: CorePlaylistView[]
  eqConfig?: CoreEqConfigView
}

function toTrackRecord(track: TrackData | LibraryTrackRecord): LibraryTrackRecord {
  return {
    ...track,
    id: String(track.id),
    filePath: typeof track.filePath === 'string' ? track.filePath : ''
  }
}

class PortableQueueAndLibraryStore {
  private libraryRevisionCounter = 1
  private queueIdCounter = 0
  private entryIdCounter = 0
  /** Known records: library rows plus tracks only referenced by a queue. */
  private readonly tracks = new Map<string, LibraryTrackRecord>()
  /** Library membership. Queueing a track never makes it a library row. */
  private readonly libraryIds = new Set<string>()
  private readonly queues = new Map<string, StoredQueueRecord>()
  private readonly buildingQueues = new Map<
    string,
    {
      id: string
      order: 'original' | 'shuffle'
      sequence: number
      rows: StoredQueueRow[]
    }
  >()

  constructor(initialTracks: readonly TrackData[] = []) {
    for (const track of initialTracks) {
      this.tracks.set(track.id, toTrackRecord(track))
      this.libraryIds.add(track.id)
    }
  }

  upsertTracks(items: readonly TrackData[]): void {
    for (const item of items) {
      this.tracks.set(item.id, toTrackRecord(item))
      this.libraryIds.add(item.id)
    }
    this.libraryRevisionCounter++
  }

  /** A platform scan is the whole local library; queue-only records stay
   * reachable through their queue rows and are dropped once unreferenced. */
  replaceLibraryTracks(items: readonly TrackData[]): void {
    this.libraryIds.clear()
    for (const item of items) {
      this.tracks.set(item.id, toTrackRecord(item))
      this.libraryIds.add(item.id)
    }
    this.pruneDetachedTracks()
    this.libraryRevisionCounter++
  }

  /** Remembers queue-only records without changing library membership. */
  rememberTracks(items: readonly TrackData[]): void {
    for (const item of items) this.rememberTrack(item)
  }

  private rememberTrack(track: TrackData | LibraryTrackRecord): void {
    if (!this.libraryIds.has(track.id)) this.tracks.set(track.id, toTrackRecord(track))
  }

  private pruneDetachedTracks(): void {
    const referenced = new Set<string>()
    for (const queue of this.queues.values())
      for (const row of queue.rows) referenced.add(row.trackId)
    for (const id of [...this.tracks.keys()])
      if (!this.libraryIds.has(id) && !referenced.has(id)) this.tracks.delete(id)
  }

  /** Library row, remembered queue record, or a persisted queue snapshot. */
  getTrack(id: string): LibraryTrackRecord | null {
    const known = this.tracks.get(id)
    if (known) return structuredClone(known)
    for (const queue of this.queues.values()) {
      const row = queue.rows.find((candidate) => candidate.trackId === id && candidate.snapshot)
      if (row?.snapshot) return structuredClone(row.snapshot)
    }
    return null
  }

  isLibraryTrack(id: string): boolean {
    return this.libraryIds.has(id)
  }

  getAllTracks(): LibraryTrackRecord[] {
    return this.libraryTracks().map((t) => structuredClone(t))
  }

  private libraryTracks(): LibraryTrackRecord[] {
    const list: LibraryTrackRecord[] = []
    for (const id of this.libraryIds) {
      const track = this.tracks.get(id)
      if (track) list.push(track)
    }
    return list
  }

  getLibraryRevision(): number {
    return this.libraryRevisionCounter
  }

  exportState(): Pick<PersistedEnvelope, 'queues' | 'tracks'> {
    return {
      // Queue rows carry their own snapshots; only library rows are durable here.
      tracks: this.libraryTracks().map((t) => structuredClone(t)),
      queues: [...this.queues.values()].map((q) => ({
        id: q.id,
        revision: q.revision,
        index: q.index,
        selectedEntryId: q.selectedEntryId,
        order: q.order,
        playMode: q.playMode,
        rows: q.rows.map((r) => structuredClone(r))
      }))
    }
  }

  importState(state: Partial<Pick<PersistedEnvelope, 'queues' | 'tracks'>> | null | undefined): void {
    if (!state) return
    if (Array.isArray(state.tracks)) {
      for (const track of state.tracks) {
        if (track && typeof track.id === 'string') {
          this.tracks.set(track.id, structuredClone(track))
          this.libraryIds.add(track.id)
        }
      }
      // Restored rows are new content to anything that read the empty store.
      this.libraryRevisionCounter++
    }
    if (Array.isArray(state.queues)) {
      this.queues.clear()
      for (const q of state.queues) {
        if (!q || typeof q.id !== 'string' || !Array.isArray(q.rows)) continue
        this.queues.set(q.id, {
          id: q.id,
          revision: typeof q.revision === 'number' ? q.revision : 1,
          index: typeof q.index === 'number' ? q.index : 0,
          selectedEntryId: q.selectedEntryId ?? q.rows[0]?.queueEntryId ?? null,
          order: q.order === 'shuffle' ? 'shuffle' : 'original',
          playMode: q.playMode,
          rows: q.rows.map((r) => structuredClone(r)),
          undoStack: []
        })
      }
    }
  }

  private nextQueueId(): string {
    this.queueIdCounter++
    return `portable-queue-${this.queueIdCounter}-${crypto.randomUUID().slice(0, 8)}`
  }

  private nextEntryId(): string {
    this.entryIdCounter++
    return `portable-entry-${this.entryIdCounter}-${crypto.randomUUID().slice(0, 8)}`
  }

  private snapshotOf(record: StoredQueueRecord): LibraryQueueSnapshot {
    const topUndo = record.undoStack[record.undoStack.length - 1]
    return {
      id: record.id,
      total: record.rows.length,
      index: record.index,
      revision: record.revision,
      selectedEntryId: record.selectedEntryId,
      order: record.order,
      ...(record.playMode ? { playMode: record.playMode } : {}),
      canUndo: record.undoStack.length > 0,
      undoLabel: topUndo?.label ?? null
    }
  }

  private resolveRowTrack(row: StoredQueueRow): LibraryTrackRecord | null {
    const fromLibrary = this.tracks.get(row.trackId)
    if (fromLibrary && row.snapshot) {
      return structuredClone({ ...fromLibrary, ...row.snapshot })
    }
    if (row.snapshot) return structuredClone(row.snapshot)
    if (fromLibrary) return structuredClone(fromLibrary)
    return null
  }

  async buildQueue(command: LibraryQueueBuildCommand): Promise<LibraryQueueBuildReply> {
    if (command.kind === 'begin') {
      this.buildingQueues.set(command.id, {
        id: typeof command.id === 'string' && command.id ? command.id : this.nextQueueId(),
        order: command.order,
        sequence: 0,
        rows: []
      })
      return { kind: 'building', id: command.id, sequence: 0, total: 0 }
    }
    if (command.kind === 'abort') {
      this.buildingQueues.delete(command.id)
      return { kind: 'aborted', id: command.id }
    }
    const staging = this.buildingQueues.get(command.id)
    if (!staging) throw new Error(`Unknown queue build session: ${command.id}`)
    if (command.kind === 'append') {
      for (const item of command.items) {
        const snapshot = item.localSnapshot ?? item.snapshot ?? this.tracks.get(item.id) ?? null
        if (snapshot) this.rememberTrack(snapshot)
        staging.rows.push({
          queueEntryId:
            'occurrenceId' in item && typeof item.occurrenceId === 'string' && item.occurrenceId
              ? item.occurrenceId
              : this.nextEntryId(),
          originalOrder:
            typeof item.originalPosition === 'number'
              ? item.originalPosition
              : staging.rows.length,
          trackId: item.id,
          snapshot: snapshot ? toTrackRecord(snapshot) : null
        })
      }
      staging.sequence = command.sequence
      return {
        kind: 'building',
        id: command.id,
        sequence: staging.sequence,
        total: staging.rows.length
      }
    }
    // commit
    this.buildingQueues.delete(command.id)
    const clampedIndex =
      staging.rows.length === 0
        ? 0
        : Math.max(0, Math.min(staging.rows.length - 1, command.selectedIndex))
    const selectedEntryId = staging.rows[clampedIndex]?.queueEntryId ?? null
    const record: StoredQueueRecord = {
      id: staging.id,
      revision: 1,
      index: clampedIndex,
      selectedEntryId,
      order: staging.order,
      playMode: staging.order === 'shuffle' ? 'shuffle' : 'sequential',
      rows: staging.rows,
      undoStack: []
    }
    this.queues.set(record.id, record)
    return {
      kind: 'ready',
      id: command.id,
      queue: this.snapshotOf(record)
    }
  }

  async createQueue(query: LibraryQuery, selectedId?: string): Promise<LibraryQueueSnapshot> {
    const page = await this.queryTracks({ ...query, offset: 0, limit: 10_000 })
    const rows: StoredQueueRow[] = page.tracks.map((track, idx) => ({
      queueEntryId: this.nextEntryId(),
      originalOrder: idx,
      trackId: track.id,
      snapshot: structuredClone(track)
    }))
    let selectedIndex = 0
    if (selectedId) {
      const found = rows.findIndex((r) => r.trackId === selectedId)
      if (found >= 0) selectedIndex = found
    }
    const record: StoredQueueRecord = {
      id: this.nextQueueId(),
      revision: 1,
      index: selectedIndex,
      selectedEntryId: rows[selectedIndex]?.queueEntryId ?? null,
      order: 'original',
      playMode: 'sequential',
      rows,
      undoStack: []
    }
    this.queues.set(record.id, record)
    return this.snapshotOf(record)
  }

  async getQueue(id: string): Promise<LibraryQueueSnapshot> {
    const record = this.queues.get(id)
    if (!record) throw new Error(`Playback queue ${id} was not found`)
    return this.snapshotOf(record)
  }

  async readQueue(
    id: string,
    offset = 0,
    limit = LIBRARY_PAGE_SIZE,
    options?: LibraryQueueReadOptions
  ): Promise<LibraryQueuePage> {
    const record = this.queues.get(id)
    if (!record) throw new Error(`Playback queue ${id} was not found`)
    if (
      options?.expectedRevision !== undefined &&
      options.expectedRevision !== record.revision
    ) {
      throw Object.assign(new Error('Playback queue revision changed'), {
        code: 'STALE_REVISION'
      })
    }
    if (options?.occurrenceId) {
      const pos = record.rows.findIndex((r) => r.queueEntryId === options.occurrenceId)
      const items =
        pos >= 0
          ? [
              {
                queueEntryId: record.rows[pos].queueEntryId,
                position: pos,
                track: this.resolveRowTrack(record.rows[pos])
              }
            ]
          : []
      return {
        items,
        lastPlayablePosition: record.rows.length > 0 ? record.rows.length - 1 : undefined,
        total: record.rows.length,
        revision: record.revision,
        libraryRevision: this.libraryRevisionCounter,
        offset: pos >= 0 ? pos : 0
      }
    }

    const start = Math.max(0, offset)
    const slice = record.rows.slice(start, start + Math.max(1, limit))
    return {
      items: slice.map((row, idx) => ({
        queueEntryId: row.queueEntryId,
        position: start + idx,
        track: this.resolveRowTrack(row)
      })),
      lastPlayablePosition: record.rows.length > 0 ? record.rows.length - 1 : undefined,
      total: record.rows.length,
      revision: record.revision,
      libraryRevision: this.libraryRevisionCounter,
      offset: start
    }
  }

  async editQueue(
    id: string,
    expectedRevision: number,
    edit: LibraryQueueEdit
  ): Promise<LibraryQueueEditResult> {
    const record = this.queues.get(id)
    if (!record) throw new Error(`Playback queue ${id} was not found`)
    if (record.revision !== expectedRevision) {
      throw Object.assign(new Error('Playback queue revision mismatch'), {
        code: 'STALE_REVISION'
      })
    }

    let reachedEnd = false

    const pushUndo = (label: string) => {
      record.undoStack.push({
        label,
        rows: record.rows.map((r) => structuredClone(r)),
        index: record.index,
        selectedEntryId: record.selectedEntryId,
        order: record.order,
        playMode: record.playMode
      })
      if (record.undoStack.length > 10) record.undoStack.shift()
    }

    switch (edit.kind) {
      case 'select': {
        const idx = record.rows.findIndex((r) => r.queueEntryId === edit.entryId)
        if (idx < 0) throw new Error(`Queue entry ${edit.entryId} not found`)
        record.index = idx
        record.selectedEntryId = record.rows[idx].queueEntryId
        record.revision++
        break
      }
      case 'step': {
        if (record.rows.length === 0) {
          reachedEnd = true
          break
        }
        const nextIdx = record.index + edit.direction
        if (nextIdx >= 0 && nextIdx < record.rows.length) {
          record.index = nextIdx
          record.selectedEntryId = record.rows[nextIdx].queueEntryId
          record.revision++
        } else if (edit.wrap) {
          record.index = edit.direction > 0 ? 0 : record.rows.length - 1
          record.selectedEntryId = record.rows[record.index].queueEntryId
          record.revision++
        } else {
          reachedEnd = true
        }
        break
      }
      case 'mode': {
        record.playMode = edit.mode
        const targetOrder = edit.mode === 'shuffle' ? 'shuffle' : 'original'
        if (record.order !== targetOrder) {
          this.reorderRows(record, targetOrder)
        }
        record.revision++
        break
      }
      case 'order': {
        if (record.order !== edit.order) {
          this.reorderRows(record, edit.order)
        }
        record.revision++
        break
      }
      case 'insert': {
        pushUndo('insert')
        const newRows: StoredQueueRow[] = []
        if (edit.items) {
          for (const item of edit.items) {
            const snapshot = item.snapshot ?? this.tracks.get(item.id) ?? null
            if (snapshot) this.rememberTrack(snapshot)
            newRows.push({
              queueEntryId: this.nextEntryId(),
              originalOrder: record.rows.length + newRows.length,
              trackId: item.id,
              snapshot: snapshot ? toTrackRecord(snapshot) : null
            })
          }
        } else if (edit.trackIds) {
          for (const trackId of edit.trackIds) {
            const snapshot = this.tracks.get(trackId) ?? null
            newRows.push({
              queueEntryId: this.nextEntryId(),
              originalOrder: record.rows.length + newRows.length,
              trackId,
              snapshot: snapshot ? toTrackRecord(snapshot) : null
            })
          }
        }
        let insertAt = record.rows.length
        if (edit.afterEntryId) {
          const idx = record.rows.findIndex((r) => r.queueEntryId === edit.afterEntryId)
          if (idx >= 0) insertAt = idx + 1
        } else if (edit.beforeEntryId) {
          const idx = record.rows.findIndex((r) => r.queueEntryId === edit.beforeEntryId)
          if (idx >= 0) insertAt = idx
        }
        record.rows.splice(insertAt, 0, ...newRows)
        if (record.selectedEntryId) {
          const selIdx = record.rows.findIndex((r) => r.queueEntryId === record.selectedEntryId)
          record.index = selIdx >= 0 ? selIdx : 0
        } else if (record.rows.length > 0) {
          record.index = 0
          record.selectedEntryId = record.rows[0].queueEntryId
        }
        record.revision++
        break
      }
      case 'remove': {
        pushUndo('remove')
        const removeSet = new Set(edit.entryIds)
        const currentSelected = record.selectedEntryId
        const previousIndex = record.index
        record.rows = record.rows.filter((r) => !removeSet.has(r.queueEntryId))
        if (record.rows.length === 0) {
          record.index = 0
          record.selectedEntryId = null
        } else if (currentSelected && !removeSet.has(currentSelected)) {
          record.index = Math.max(
            0,
            record.rows.findIndex((r) => r.queueEntryId === currentSelected)
          )
        } else {
          record.index = Math.min(previousIndex, record.rows.length - 1)
          record.selectedEntryId = record.rows[record.index].queueEntryId
        }
        record.revision++
        break
      }
      case 'move': {
        pushUndo('move')
        const fromIdx = record.rows.findIndex((r) => r.queueEntryId === edit.entryId)
        if (fromIdx < 0) throw new Error(`Queue entry ${edit.entryId} not found`)
        const [moved] = record.rows.splice(fromIdx, 1)
        let toIdx = record.rows.length
        if (edit.beforeEntryId !== null) {
          const beforeIdx = record.rows.findIndex((r) => r.queueEntryId === edit.beforeEntryId)
          if (beforeIdx >= 0) toIdx = beforeIdx
        }
        record.rows.splice(toIdx, 0, moved)
        if (record.selectedEntryId) {
          const selIdx = record.rows.findIndex((r) => r.queueEntryId === record.selectedEntryId)
          if (selIdx >= 0) record.index = selIdx
        }
        record.revision++
        break
      }
      case 'clear': {
        pushUndo('clear')
        record.rows = []
        record.index = 0
        record.selectedEntryId = null
        record.revision++
        break
      }
      case 'undo': {
        const last = record.undoStack.pop()
        if (!last) throw new Error('Nothing to undo')
        record.rows = last.rows
        record.index = last.index
        record.selectedEntryId = last.selectedEntryId
        record.order = last.order
        record.playMode = last.playMode
        record.revision++
        break
      }
    }

    return {
      queue: this.snapshotOf(record),
      reachedEnd
    }
  }

  private reorderRows(record: StoredQueueRecord, order: 'original' | 'shuffle'): void {
    const selectedId = record.selectedEntryId
    if (order === 'original') {
      record.rows.sort((a, b) => a.originalOrder - b.originalOrder)
    } else if (record.rows.length > 1) {
      const selectedRow = selectedId
        ? record.rows.find((r) => r.queueEntryId === selectedId)
        : undefined
      const rest = selectedRow
        ? record.rows.filter((r) => r.queueEntryId !== selectedId)
        : [...record.rows]
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const tmp = rest[i]
        rest[i] = rest[j]
        rest[j] = tmp
      }
      record.rows = selectedRow ? [selectedRow, ...rest] : rest
    }
    record.order = order
    if (selectedId) {
      const idx = record.rows.findIndex((r) => r.queueEntryId === selectedId)
      if (idx >= 0) record.index = idx
    }
  }

  async deleteQueue(id: string, _expectedRevision: number): Promise<void> {
    this.queues.delete(id)
    this.pruneDetachedTracks()
  }

  async readNeighbor(
    id: string,
    revision: number,
    index: number,
    direction: 1 | -1,
    wrap: boolean
  ) {
    const record = this.queues.get(id)
    if (!record || record.revision !== revision || record.rows.length === 0) return null
    let target = index + direction
    if (target < 0 || target >= record.rows.length) {
      if (!wrap) return null
      target = direction > 0 ? 0 : record.rows.length - 1
    }
    const row = record.rows[target]
    if (!row) return null
    return {
      queueEntryId: row.queueEntryId,
      position: target,
      track: this.resolveRowTrack(row)
    }
  }

  async getMetadata(): Promise<LibraryMetadata> {
    return {
      revision: this.libraryRevisionCounter,
      trackCount: this.libraryIds.size,
      fileCount: this.libraryIds.size,
      folders: [],
      exclusions: []
    }
  }

  async queryTracks(query: LibraryQuery = {}): Promise<LibraryPage> {
    let list = this.libraryTracks()
    if (query.ids) {
      const idSet = new Set(query.ids)
      list = list.filter((t) => idSet.has(t.id))
    }
    if (query.search) {
      const q = query.search.toLowerCase()
      list = list.filter(
        (t) =>
          String(t.title ?? '').toLowerCase().includes(q) ||
          String(t.artist ?? '').toLowerCase().includes(q) ||
          String(t.album ?? '').toLowerCase().includes(q)
      )
    }
    const offset = Math.max(0, query.offset ?? 0)
    const limit = Math.max(1, query.limit ?? LIBRARY_PAGE_SIZE)
    const slice = list.slice(offset, offset + limit).map((t) => structuredClone(t))
    return {
      tracks: slice,
      versions: {},
      total: list.length,
      revision: this.libraryRevisionCounter,
      offset
    }
  }

  async getTracksByIds(ids: string[]): Promise<LibraryPage> {
    const found = ids
      .map((id) => this.getTrack(id))
      .filter((t): t is LibraryTrackRecord => Boolean(t))
    return {
      tracks: found,
      versions: {},
      total: found.length,
      revision: this.libraryRevisionCounter,
      offset: 0
    }
  }

  async queryCollections(
    kind: LibraryCollectionKind,
    query: LibraryQuery = {}
  ): Promise<LibraryCollectionPage> {
    const groups = new Map<string, LibraryCollectionSummary>()
    for (const track of this.libraryTracks()) {
      if (kind === 'albums') {
        const albumName = String(track.album || 'Unknown Album').trim() || 'Unknown Album'
        const key = `album:${albumName.toLowerCase()}`
        const existing = groups.get(key)
        if (existing) {
          existing.trackCount += 1
          existing.duration += Number(track.duration) || 0
        } else {
          groups.set(key, {
            id: key,
            name: albumName,
            artist: String(track.artist || 'Unknown Artist'),
            trackCount: 1,
            duration: Number(track.duration) || 0,
            cover: typeof track.cover === 'string' ? track.cover : null
          })
        }
      } else if (kind === 'artists') {
        const artistName = String(track.artist || 'Unknown Artist').trim() || 'Unknown Artist'
        const key = `artist:${artistName.toLowerCase()}`
        const existing = groups.get(key)
        if (existing) {
          existing.trackCount += 1
          existing.duration += Number(track.duration) || 0
        } else {
          groups.set(key, {
            id: key,
            name: artistName,
            trackCount: 1,
            duration: Number(track.duration) || 0,
            cover: typeof track.cover === 'string' ? track.cover : null
          })
        }
      } else if (kind === 'genres') {
        const genreName = String(track.genre || 'Unknown Genre').trim() || 'Unknown Genre'
        const key = `genre:${genreName.toLowerCase()}`
        const existing = groups.get(key)
        if (existing) {
          existing.trackCount += 1
          existing.duration += Number(track.duration) || 0
        } else {
          groups.set(key, {
            id: key,
            name: genreName,
            trackCount: 1,
            duration: Number(track.duration) || 0,
            cover: null
          })
        }
      }
    }

    let items = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
    if (query.search) {
      const q = query.search.toLowerCase()
      items = items.filter(
        (item) =>
          item.name.toLowerCase().includes(q) ||
          (item.artist && item.artist.toLowerCase().includes(q))
      )
    }
    const offset = Math.max(0, query.offset ?? 0)
    const limit = Math.max(1, query.limit ?? LIBRARY_PAGE_SIZE)
    return {
      revision: this.libraryRevisionCounter,
      total: items.length,
      offset,
      items: items.slice(offset, offset + limit),
      letterOffsets: {}
    }
  }

  private readonly playlistViews = new Map<
    string,
    {
      sequence: number
      committed: boolean
      entries: Array<{ id: string; snapshot?: LibraryTrackRecord; collectionId?: string }>
    }
  >()

  async syncPlaylistView(
    sync: LibraryPlaylistViewSync
  ): Promise<LibraryPlaylistViewSyncResult> {
    if (sync.kind === 'drop') {
      this.playlistViews.delete(sync.id)
      return { id: sync.id, sequence: 0, count: 0, committed: false }
    }
    if (sync.kind === 'begin') {
      this.playlistViews.set(sync.id, { sequence: 0, committed: false, entries: [] })
      return { id: sync.id, sequence: 0, count: 0, committed: false }
    }
    const current = this.playlistViews.get(sync.id) ?? {
      sequence: 0,
      committed: false,
      entries: []
    }
    if (sync.kind === 'groups') {
      current.sequence = sync.sequence
      this.playlistViews.set(sync.id, current)
      return {
        id: sync.id,
        sequence: sync.sequence,
        count: sync.groups.length,
        committed: false
      }
    }
    if (sync.kind === 'append') {
      current.sequence = sync.sequence
      current.entries.push(...sync.entries)
      this.playlistViews.set(sync.id, current)
      return {
        id: sync.id,
        sequence: sync.sequence,
        count: current.entries.length,
        committed: false
      }
    }
    current.sequence = sync.sequence
    current.committed = true
    this.playlistViews.set(sync.id, current)
    return {
      id: sync.id,
      sequence: sync.sequence,
      count: current.entries.length,
      committed: true
    }
  }

  async lookupTracksByPaths(paths: string[]) {
    const byPath = new Map<string, string>()
    for (const track of this.libraryTracks()) {
      if (track.filePath) {
        byPath.set(track.filePath, track.id)
      }
    }
    return {
      revision: this.libraryRevisionCounter,
      ids: paths.map((p) => byPath.get(p) ?? null)
    }
  }

  async lookupPlaylistTracks(request: { entries: Array<{ id?: string; filePath?: string }> }) {
    const byPath = new Map<string, string>()
    for (const track of this.libraryTracks()) {
      if (track.filePath) {
        byPath.set(track.filePath, track.id)
      }
    }
    return {
      revision: this.libraryRevisionCounter,
      ids: request.entries.map((entry) => {
        if (entry.id && this.libraryIds.has(entry.id)) return entry.id
        if (entry.filePath && byPath.has(entry.filePath)) return byPath.get(entry.filePath)!
        return null
      })
    }
  }
}

// ============================================================================
// 4. Adapter from PortableAudioEnginePort to CorePlaybackEngine
// ============================================================================

class PortablePlaybackEngineAdapter implements CorePlaybackEngine {
  private readonly port: PortableAudioEnginePort
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>()
  private queueItems: AudioEngineQueueItem[] = []
  private queueTokenCounter = 0
  /** Empty until a queue load commits; an uncertain native reply revokes it. */
  private currentQueueToken = ''
  private playMode: PlayMode = 'sequential'
  /** Latest native observation; natural-end checks read it, never a guess. */
  private info: PlaybackInfo | null = null
  private transportRevision = 0
  /** Pause, resume and seek do not change the native queue's identity. */
  private queueMutationRevision = 0
  private continuationIntent = 0
  private endEligible = false
  private unsubscribePort: PortableUnsubscribe | null = null

  constructor(port: PortableAudioEnginePort) {
    this.port = port
    this.unsubscribePort = port.subscribe((event) => {
      this.handlePortEvent(event)
    })
  }

  dispose(): void {
    this.unsubscribePort?.()
    this.unsubscribePort = null
    this.listeners.clear()
  }

  private emitEvent(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of [...set]) {
      listener(...args)
    }
  }

  private nextQueueToken(): string {
    this.queueTokenCounter++
    return `portable-token-${this.queueTokenCounter}`
  }

  private revokePlaybackEnd(): void {
    this.endEligible = false
    this.continuationIntent++
  }

  private handlePortEvent(event: PortableAudioNativeEvent): void {
    if (event.type === 'playback-info') {
      this.info = event.info
      const enriched: PlaybackInfo = {
        ...event.info,
        queueToken: event.info.queueToken ?? this.currentQueueToken
      }
      this.emitEvent('playback-info', enriched)
      return
    }
    if (event.type === 'end-file') {
      this.emitEvent('end-file', { reason: event.reason ?? 'eof' })
      return
    }
    if (event.type === 'crashed') {
      this.revokePlaybackEnd()
      this.emitEvent('crashed', { reason: event.reason ?? 'Native audio engine crashed' })
      return
    }
    if (event.type === 'error') {
      this.emitEvent('error', {
        message: event.message,
        code: event.code,
        recoverable: event.recoverable
      })
    }
  }

  on(event: string, listener: (...args: any[]) => void): unknown {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  off(event: string, listener: (...args: any[]) => void): unknown {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  getQueueToken(): string {
    return this.currentQueueToken
  }

  async getPlaybackInfo(): Promise<PlaybackInfo> {
    const info = await this.port.getSnapshot()
    this.info = info
    return info
  }

  getQueueSnapshot(): readonly AudioEngineQueueItem[] {
    return this.queueItems
  }

  getPlaybackEnd(): {
    selection: NativeQueueSelection
    intent: number
  } | null {
    const info = this.info
    if (!info || !this.endEligible || !this.currentQueueToken) return null
    const item = this.queueItems[info.queueIndex]
    const failure = info.outputInfo?.diagnostics?.lastError || info.diagnostics?.lastError
    if (info.state !== 'stopped' || info.upcomingTrack || failure || !item || item.source !== info.source)
      return null
    return {
      selection: {
        queueToken: this.currentQueueToken,
        index: info.queueIndex,
        id: item.id,
        source: item.source
      },
      intent: this.transportRevision
    }
  }

  /** Opens the next decoder only after a confirmed natural end. Every await is
   * fenced against a later transport command; unknown outcomes escape. */
  async continueAfterPlaybackEnd(request: {
    expected: {
      selection: NativeQueueSelection
      intent: number
    }
    item: AudioEngineQueueItem
    playMode: 'sequential' | 'repeat'
    isCurrent(): boolean
    onSelected(): void
  }): Promise<boolean> {
    await this.getPlaybackInfo()
    const end = this.getPlaybackEnd()
    const expected = request.expected
    if (
      !request.isCurrent() ||
      !end ||
      end.intent !== expected.intent ||
      end.selection.queueToken !== expected.selection.queueToken ||
      end.selection.index !== expected.selection.index ||
      end.selection.id !== expected.selection.id ||
      end.selection.source !== expected.selection.source
    )
      return false
    const loading = this.loadQueue([request.item], 0)
    const loadRevision = this.transportRevision
    const loadIntent = this.continuationIntent
    await loading
    if (
      this.queueItems.length === 1 &&
      this.currentQueueToken &&
      this.queueItems[0].queueEntryId === request.item.queueEntryId &&
      this.queueItems[0].source === request.item.source
    )
      request.onSelected()
    if (
      !request.isCurrent() ||
      loadRevision !== this.transportRevision ||
      loadIntent !== this.continuationIntent
    )
      return false
    const changingMode = this.setPlayMode(request.playMode)
    const modeRevision = this.transportRevision
    const modeIntent = this.continuationIntent
    await changingMode
    if (
      !request.isCurrent() ||
      modeRevision !== this.transportRevision ||
      modeIntent !== this.continuationIntent
    )
      return false
    let playIntent = 0
    const playing = this.play(
      request.item.source,
      0,
      () => request.isCurrent() && playIntent === this.continuationIntent
    )
    playIntent = this.continuationIntent
    const playRevision = this.transportRevision
    try {
      const result = await playing
      if (result.superseded) return false
      if (!result.nativeStarted) throw new Error('afterglow_requires_native_playback')
      return true
    } catch (error) {
      // Never stop a later user action while retiring this automatic attempt.
      if (playRevision === this.transportRevision && playIntent === this.continuationIntent)
        await this.stop()
      throw error
    }
  }

  async start(): Promise<void> {
    await this.port.start?.()
  }

  async loadQueue(items: AudioEngineQueueItem[], startIndex = 0): Promise<void> {
    this.transportRevision++
    const revision = ++this.queueMutationRevision
    this.revokePlaybackEnd()
    const nextQueue = items.map((item) => structuredClone(item))
    const nextIndex =
      nextQueue.length === 0 ? 0 : Math.max(0, Math.min(nextQueue.length - 1, startIndex))
    this.currentQueueToken = ''
    await this.port.loadQueue(nextQueue, nextIndex)
    if (revision !== this.queueMutationRevision) return
    this.queueItems = nextQueue
    this.currentQueueToken = this.nextQueueToken()
  }

  /** Android has no native compare-and-rebind, so the portable adapter checks
   * the decoder before and after a non-interrupting LoadQueue. A race with a
   * natural track change revokes queue authority instead of guessing. */
  async rebindQueue(rebind: NativeQueueRebind): Promise<NativeQueueCommit | null> {
    const { expected, startIndex, playMode } = rebind
    const previousToken = this.currentQueueToken
    const current = this.queueItems[expected.index]
    const selected = rebind.items[startIndex]
    if (
      !previousToken ||
      expected.queueToken !== previousToken ||
      !Number.isInteger(expected.index) ||
      !Number.isInteger(startIndex) ||
      !current ||
      current.id !== expected.id ||
      current.source !== expected.source ||
      !selected ||
      selected.id !== current.id ||
      selected.source !== current.source ||
      selected.cueRange?.startSeconds !== current.cueRange?.startSeconds ||
      selected.cueRange?.endSeconds !== current.cueRange?.endSeconds ||
      (selected.cueRange?.virtualPregapSeconds ?? 0) !==
        (current.cueRange?.virtualPregapSeconds ?? 0)
    )
      return null
    // Lookahead preserves the active decoder and must not cancel an in-flight Play.
    // Only another queue mutation can supersede its confirmed queue assignment.
    const revision = ++this.queueMutationRevision
    this.currentQueueToken = ''
    const superseded = () => new Error('Native queue handoff superseded; queue authority must be refreshed')
    const before = await this.port.getSnapshot()
    if (revision !== this.queueMutationRevision) throw superseded()
    this.info = before
    if (
      before.state === 'stopped' ||
      before.queueIndex !== expected.index ||
      before.source !== expected.source
    ) {
      this.currentQueueToken = previousToken
      return null
    }
    const nextQueue = rebind.items.map((item) => structuredClone(item))
    await this.port.loadQueue(nextQueue, startIndex)
    if (revision !== this.queueMutationRevision) throw superseded()
    if (playMode !== this.playMode) {
      await this.port.setPlayMode(playMode)
      if (revision !== this.queueMutationRevision) throw superseded()
      this.playMode = playMode
    }
    const after = await this.port.getSnapshot()
    if (revision !== this.queueMutationRevision) throw superseded()
    this.info = after
    if (after.source !== selected.source || after.queueIndex !== startIndex)
      throw new Error('Native queue handoff raced a track change; queue authority must be refreshed')
    this.queueItems = nextQueue
    this.currentQueueToken = this.nextQueueToken()
    return { queueToken: this.currentQueueToken }
  }

  async play(
    source: string,
    position = 0,
    requested?: () => boolean
  ): Promise<AudioEnginePlayResult> {
    if (!source) throw new Error('playback source is empty')
    const revision = ++this.transportRevision
    this.revokePlaybackEnd()
    const superseded: AudioEnginePlayResult = {
      nativeStarted: false,
      fallbackReason: '',
      superseded: true
    }
    // Callers capture their intent after this synchronous prologue.
    await undefined
    if (revision !== this.transportRevision || requested?.() === false) return superseded
    const result = await this.port.play(source, position)
    if (revision !== this.transportRevision) return superseded
    this.endEligible = result.nativeStarted
    return result
  }

  async pause(): Promise<void> {
    this.transportRevision++
    this.revokePlaybackEnd()
    await this.port.pause()
  }

  async stop(): Promise<void> {
    this.transportRevision++
    this.revokePlaybackEnd()
    await this.port.stop()
  }

  async seek(position: number): Promise<void> {
    const revision = ++this.transportRevision
    this.revokePlaybackEnd()
    await this.port.seek(position)
    if (revision !== this.transportRevision) return
    const info = await this.port.getSnapshot()
    if (revision !== this.transportRevision) return
    this.info = info
    this.endEligible = info.state === 'playing'
  }

  async seekConfirmed(position: number): Promise<void> {
    await this.seek(position)
  }

  async setVolume(volume: number): Promise<void> {
    await this.port.setVolume(volume)
  }

  async setPlaybackRate(rate: number): Promise<void> {
    await this.port.setPlaybackRate(rate)
  }

  async setPlayMode(mode: PlayMode): Promise<void> {
    if (mode === this.playMode) return
    const revision = this.transportRevision
    const endEligible = this.endEligible && this.info?.state === 'playing'
    this.revokePlaybackEnd()
    const intent = this.continuationIntent
    await this.port.setPlayMode(mode)
    if (revision !== this.transportRevision || intent !== this.continuationIntent) return
    this.playMode = mode
    this.endEligible = endEligible
  }
}

// ============================================================================
// 5. Portable Music Core Host Assembly & JSON Bridge Surface
// ============================================================================

export interface PortableMusicCoreHost {
  readonly epoch: string
  readonly protocolVersion: typeof CORE_PROTOCOL_VERSION
  readonly application: CoreApplication
  readonly playback: CorePlaybackSession
  readonly settings: CoreSettingsService
  readonly bookmarks: CoreBookmarksService
  readonly lyrics: CoreLyricsService
  readonly playlists: CorePlaylistService
  readonly queueStore: PortableQueueAndLibraryStore
  initialize(): Promise<void>
  seedTracks(tracks: readonly TrackData[]): void
  /** A full platform scan replaces library membership; queued tracks stay playable. */
  replaceLibraryTracks(tracks: readonly TrackData[]): void
  playTracks(tracks: readonly TrackData[], startIndex?: number): Promise<void>
  getSnapshot(): CoreSnapshot
  getSnapshotJson(): string
  dispatchRequest(message: CoreRequestEnvelope | CoreCancelEnvelope): void
  dispatchRequestJson(messageJson: string): void
  subscribeMessages(listener: (message: CoreClientMessage) => void): PortableUnsubscribe
  subscribeMessagesJson(listener: (messageJson: string) => void): PortableUnsubscribe
  /** Durable documents last acknowledged by the session store. */
  getBookmarksDocument(): PlaybackBookmarksDocument
  getLyricsDocument(): LyricsManagementDocument
  getPlaylists(): Playlist[]
  /** Phase 3 library collections aggregation */
  getLibraryCollections(): CoreLibraryCollectionsView
  /** Phase 3 EQ & DSP configuration */
  getEqConfig(): CoreEqConfigView
  /** The audio engine applies the patch before it commits; a rejection keeps the old config. */
  setEqConfig(patch: Partial<CoreEqConfigView>): Promise<CoreEqConfigView>
  /** Platform safety brake (Section 5.4: audio focus lost / route noisy / service stopping). */
  triggerPlatformSafetyBrake(reason: string): Promise<void>
  shutdown(): Promise<void>
}

export function createPortableMusicCoreHost(options: PortableHostOptions): PortableMusicCoreHost {
  ensurePortableRuntimeGlobals()

  const epoch = options.epoch ?? `portable-epoch-${crypto.randomUUID().slice(0, 8)}`
  const platform: CorePlatformId = options.platform ?? 'linux'

  const clock: PortableClockPort = options.clock ?? {
    nowUnixMs: () => Date.now(),
    nowMonotonicMs: () =>
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()
  }

  const scheduler: PortableSchedulerPort = options.scheduler ?? {
    schedule(delayMs, task) {
      if (typeof setTimeout === 'function') {
        const handle = setTimeout(task, delayMs)
        return {
          cancel() {
            if (typeof clearTimeout === 'function') clearTimeout(handle)
          }
        }
      }
      return {
        cancel() {
          // No timer was scheduled when the host has no timer API.
        }
      }
    }
  }

  const queueStore = new PortableQueueAndLibraryStore(options.initialTracks ?? [])
  const engineAdapter = new PortablePlaybackEngineAdapter(options.audioEngine)

  let storeRevisionToken: string | null = null
  let currentSettings: AppSettings
  let settingsRevision = 0
  let currentSessionData: PlaybackSessionData<TrackData> | null = null
  let sessionDataRevision = 0
  let bookmarksDoc: PlaybackBookmarksDocument = clonePlaybackBookmarksDocument(
    DEFAULT_PLAYBACK_BOOKMARKS
  )
  let bookmarksRevision = 0
  let lyricsDoc: LyricsManagementDocument = cloneLyricsManagementDocument(
    DEFAULT_LYRICS_MANAGEMENT
  )
  let lyricsRevision = 0
  let playlistsState: Playlist[] = []
  let playlistsRevision = 0
  let eqConfig: CoreEqConfigView = createDefaultEqConfig()
  let eqTail: Promise<unknown> = Promise.resolve()
  let envelopeLoaded = false
  let envelopeLoadPromise: Promise<void> | null = null

  const settingsEnv: SettingsEnvironment = {
    platform,
    defaultCachePath: '/portable/cache',
    resolvePath: (path: string) => path
  }
  currentSettings = normalizeAppSettings(
    {
      ...createDefaultSettings(platform),
      ...options.initialSettings
    },
    settingsEnv
  )

  const ensureEnvelopeLoaded = async (): Promise<void> => {
    if (envelopeLoaded) return
    if (envelopeLoadPromise) return envelopeLoadPromise
    envelopeLoadPromise = (async () => {
      const stored = await options.sessionStore.load()
      if (!stored) {
        storeRevisionToken = null
        sessionDataRevision = 0
        envelopeLoaded = true
        return
      }
      storeRevisionToken = stored.revision
      const parsedNum = Number.parseInt(stored.revision, 10)
      const initialRev = Number.isFinite(parsedNum) && parsedNum > 0 ? parsedNum : 1
      const parsed = JSON.parse(stored.payloadJson) as PersistedEnvelope
      queueStore.importState(parsed)
      currentSessionData = parsed.session ?? null
      sessionDataRevision = currentSessionData ? initialRev : 0
      if (parsed.settings) {
        currentSettings = normalizeAppSettings(
          { ...currentSettings, ...parsed.settings },
          settingsEnv
        )
      }
      if (parsed.bookmarks) {
        bookmarksDoc = clonePlaybackBookmarksDocument(parsed.bookmarks)
        bookmarksRevision = initialRev
      }
      if (parsed.lyricsManagement) {
        lyricsDoc = cloneLyricsManagementDocument(parsed.lyricsManagement)
        lyricsRevision = initialRev
      }
      if (Array.isArray(parsed.playlists)) {
        playlistsState = structuredClone(parsed.playlists)
        playlistsRevision = initialRev
      }
      if (Array.isArray(parsed.customPlaylists)) {
        // Playlists now have one owner; fold the old parallel list into it once.
        const known = new Set(playlistsState.map((playlist) => playlist.id))
        for (const legacy of parsed.customPlaylists) {
          if (!legacy || typeof legacy.id !== 'string' || known.has(legacy.id)) continue
          const at = new Date(Number(legacy.updatedAtMs) || clock.nowUnixMs()).toISOString()
          playlistsState.push({
            id: legacy.id,
            name: String(legacy.name || 'Untitled Playlist'),
            trackIds: Array.isArray(legacy.trackIds) ? legacy.trackIds.map(String) : [],
            createdAt: at,
            updatedAt: at
          })
        }
        playlistsRevision = initialRev
      }
      if (parsed.eqConfig) {
        try {
          eqConfig = applyEqConfigPatch(createDefaultEqConfig(), parsed.eqConfig)
        } catch (error) {
          // A stored DSP graph this build rejects must not keep the library offline.
          eqConfig = createDefaultEqConfig()
          options.onFatalError?.(
            new Error(
              `Stored audio settings were reset: ${error instanceof Error ? error.message : String(error)}`
            )
          )
        }
      }
      envelopeLoaded = true
    })().finally(() => {
      envelopeLoadPromise = null
    })
    return envelopeLoadPromise
  }

  let persistChain: Promise<void> = Promise.resolve()
  const persistEnvelope = async (): Promise<void> => {
    const work = persistChain
      .catch(() => undefined)
      .then(async () => {
        const exported = queueStore.exportState()
        const envelope: PersistedEnvelope = {
          schema: PORTABLE_ENVELOPE_SCHEMA,
          session: currentSessionData,
          queues: exported.queues,
          tracks: exported.tracks,
          settings: currentSettings,
          bookmarks: bookmarksDoc,
          lyricsManagement: lyricsDoc,
          playlists: playlistsState,
          eqConfig
        }
        const res = await options.sessionStore.save(
          JSON.stringify(envelope),
          storeRevisionToken
        )
        if (!res.ok) {
          throw Object.assign(new Error('Session store CAS conflict'), {
            code: 'STALE_REVISION'
          })
        }
        storeRevisionToken = res.revision
      })
    persistChain = work
    return work
  }

  const sessionRepository: CoreSessionRepository = {
    async load() {
      await ensureEnvelopeLoaded()
      if (sessionDataRevision === 0 && !currentSessionData) {
        return null
      }
      return {
        revision: sessionDataRevision,
        data: currentSessionData
      }
    },
    async save(sessionData, expectedRevision) {
      if (expectedRevision !== sessionDataRevision) {
        throw Object.assign(new Error('Session store revision conflict'), {
          code: 'STALE_REVISION'
        })
      }
      currentSessionData = sessionData
      sessionDataRevision++
      await persistEnvelope()
      return { revision: sessionDataRevision }
    },
    async clear(expectedRevision) {
      if (expectedRevision !== sessionDataRevision) {
        throw Object.assign(new Error('Session store revision conflict'), {
          code: 'STALE_REVISION'
        })
      }
      currentSessionData = null
      sessionDataRevision++
      await persistEnvelope()
      return { revision: sessionDataRevision }
    }
  }

  let appInstance: CoreApplication | null = null

  const stateApi: CoreStateApi = {
    coreStateOpen: async () => {},
    coreStateStatus: async () => ({
      complete: true,
      id: null,
      manifest: null,
      nextBatch: 0,
      counts: emptyCoreStateCounts()
    }),
    coreStateRead: async (domain) => ({
      domain,
      revision: 0,
      rows: [],
      next: null
    }),
    coreStateWrite: async () => 1,
    coreMigrationBegin: async (id, manifest) => ({
      complete: false,
      id,
      manifest,
      nextBatch: 0,
      counts: emptyCoreStateCounts()
    }),
    coreMigrationStage: async (id, batch) => ({
      complete: false,
      id,
      manifest: null,
      nextBatch: batch + 1,
      counts: emptyCoreStateCounts()
    }),
    coreMigrationCommit: async (id) => ({
      complete: true,
      id,
      manifest: null,
      nextBatch: 0,
      counts: emptyCoreStateCounts()
    }),
    coreMigrationAbort: async () => {}
  }

  const recordingVersions = new CoreRecordingVersions(
    {
      coreStateRead: stateApi.coreStateRead,
      coreVersionsReplace: async (_doc, expectedRevision) => expectedRevision + 1
    },
    () => appInstance?.changed(),
    () => crypto.randomUUID()
  )

  const bookmarksService = new CoreBookmarksService({
    repository: {
      load: async () => {
        await ensureEnvelopeLoaded()
        return {
          version: 2 as const,
          revision: bookmarksRevision,
          savedAt: new Date(clock.nowUnixMs()).toISOString(),
          data: clonePlaybackBookmarksDocument(bookmarksDoc)
        }
      },
      save: async (document, expectedRevision) => {
        if (expectedRevision !== bookmarksRevision) {
          throw Object.assign(new Error('Bookmarks revision conflict'), {
            code: 'STALE_REVISION'
          })
        }
        bookmarksDoc = clonePlaybackBookmarksDocument(document)
        bookmarksRevision++
        await persistEnvelope()
        return {
          version: 2 as const,
          revision: bookmarksRevision,
          savedAt: new Date(clock.nowUnixMs()).toISOString(),
          data: clonePlaybackBookmarksDocument(bookmarksDoc)
        }
      }
    },
    now: () => clock.nowUnixMs(),
    newId: () => crypto.randomUUID(),
    changed: () => appInstance?.changed(),
    failed: (error) => {
      if (error instanceof Error) options.onFatalError?.(error)
    }
  })

  const portableTimers = {
    setTimeout(callback: () => void, delay: number) {
      return scheduler.schedule(delay, callback)
    },
    clearTimeout(handle: unknown) {
      if (handle && typeof (handle as { cancel?: () => void }).cancel === 'function') {
        ;(handle as { cancel: () => void }).cancel()
      }
    }
  }

  const lyricsService = new CoreLyricsService({
    repository: {
      load: async () => {
        await ensureEnvelopeLoaded()
        return {
          version: 2 as const,
          revision: lyricsRevision,
          savedAt: new Date(clock.nowUnixMs()).toISOString(),
          data: cloneLyricsManagementDocument(lyricsDoc)
        }
      },
      save: async (document, expectedRevision) => {
        if (expectedRevision !== lyricsRevision) {
          throw Object.assign(new Error('Lyrics revision conflict'), {
            code: 'STALE_REVISION'
          })
        }
        lyricsDoc = cloneLyricsManagementDocument(document)
        lyricsRevision++
        await persistEnvelope()
        return {
          version: 2 as const,
          revision: lyricsRevision,
          savedAt: new Date(clock.nowUnixMs()).toISOString(),
          data: cloneLyricsManagementDocument(lyricsDoc)
        }
      }
    },
    now: () => clock.nowUnixMs(),
    changed: () => appInstance?.changed(),
    timers: portableTimers,
    sources: {
      loadLocalLyrics: async (track, kind, signal) => {
        if (options.lyrics?.loadLocalLyrics) {
          return options.lyrics.loadLocalLyrics(track, kind, signal)
        }
        if (kind === 'original') return track.lyrics ?? null
        if (kind === 'translated') return track.translatedLyrics ?? null
        if (kind === 'romanized') return track.romanizedLyrics ?? null
        return null
      },
      resolveProviderLyrics: async (_track, _signal) => ({
        lyrics: null,
        translatedLyrics: null
      }),
      loadAmlTtml: async (_id, _signal) => null,
      loadOnlineLyrics: async (query, signal) => {
        if (options.lyrics?.loadOnlineLyrics) {
          return options.lyrics.loadOnlineLyrics(query, signal)
        }
        return null
      },
      getAppSettings: () => ({ value: currentSettings })
    },
    search: async (track, signal) => {
      if (options.lyrics?.searchOnlineLyrics) {
        return options.lyrics.searchOnlineLyrics(track, signal)
      }
      return {
        query: {
          title: track.title,
          artist: track.artist,
          album: track.album,
          durationSeconds: track.duration
        },
        candidates: [],
        best: null
      }
    },
    importDraft: async () => null,
    exportDraft: async () => null,
    failed: (error) => {
      if (error instanceof Error) options.onFatalError?.(error)
    }
  })

  const playlistsService = new CorePlaylistService({
    runtime: {
      now: () => clock.nowUnixMs(),
      newId: () => crypto.randomUUID(),
      clone: <T>(val: T) => structuredClone(val),
      notify: () => appInstance?.changed(),
      identity: recordingVersions.identity,
      versions: {
        ensure: () => {},
        revision: () => recordingVersions.getRevision()
      },
      repository: {
        load: async () => {
          await ensureEnvelopeLoaded()
          return {
            version: 2 as const,
            revision: playlistsRevision,
            savedAt: new Date(clock.nowUnixMs()).toISOString(),
            data: structuredClone(playlistsState)
          }
        },
        save: async (data, expectedRevision) => {
          if (expectedRevision !== playlistsRevision) {
            throw Object.assign(new Error('Playlists revision conflict'), {
              code: 'STALE_REVISION'
            })
          }
          playlistsState = structuredClone(data)
          playlistsRevision++
          await persistEnvelope()
          return {
            version: 2 as const,
            revision: playlistsRevision,
            savedAt: new Date(clock.nowUnixMs()).toISOString(),
            data: structuredClone(playlistsState)
          }
        }
      }
    },
    database: {
      lookupTracksByPaths: (paths) => queueStore.lookupTracksByPaths(paths),
      getTracksByIds: (ids) => queueStore.getTracksByIds(ids),
      getMetadata: () => queueStore.getMetadata(),
      queryTracks: (query) => queueStore.queryTracks(query),
      queryCollections: (kind, query) => queueStore.queryCollections(kind, query),
      syncPlaylistView: (sync) => queueStore.syncPlaylistView(sync)
    },
    versions: recordingVersions,
    changed: () => appInstance?.changed()
  })

  const resolveSeedItems = async (
    items: readonly import('../shared/coreQueueSubmission.ts').CoreQueueTrackInput[]
  ): Promise<LibraryQueueSeedItem[]> => {
    return items.map((item): LibraryQueueSeedItem => {
      if ('track' in item && item.track) {
        const record = toTrackRecord(item.track as TrackData)
        return {
          id: record.id,
          snapshot: record,
          localSnapshot: record
        }
      }
      const id = String((item as { id?: string }).id ?? '')
      return { id }
    })
  }

  const resolvePlaylistInputs = createPlaylistInputResolver(
    (inputs) => resolveSeedItems(inputs),
    {
      getTracksByIds: (ids) => queueStore.getTracksByIds(ids)
    }
  )

  const playlistSubmission = new CorePlaylistSubmission({
    playlists: playlistsService,
    resolve: resolvePlaylistInputs,
    newId: () => `pl-sub-${crypto.randomUUID().slice(0, 8)}`,
    schedule: (callback, delayMs) => {
      const handle = scheduler.schedule(delayMs, callback)
      return () => handle.cancel()
    }
  })

  const presentationService = new CorePlayerPresentationService({
    artwork: async (track) => ({
      cover: track.cover ?? null,
      coverSource: track.coverSource ?? null
    }),
    playlists: {
      isFavorite: (track) => playlistsService.isFavorite(track),
      toggleFavorite: (track, assertCurrent) =>
        playlistsService.toggleFavorite(track, assertCurrent)
    },
    supportedMethods: () => [],
    callProvider: async () => null,
    changed: () => appInstance?.changed(),
    failed: (error) => {
      if (error instanceof Error) options.onFatalError?.(error)
    }
  })

  const searchService = new CoreMusicSearchService({
    database: {
      queryTracks: (query) => queueStore.queryTracks(query),
      getMetadata: () => queueStore.getMetadata(),
      queryCollections: (kind, query) => queueStore.queryCollections(kind, query)
    },
    versions: recordingVersions,
    providers: () => [],
    playlists: playlistsService,
    searchCollectionProvider: async () => ({ items: [], total: 0 }),
    searchProvider: async () => ({ items: [], total: 0 }),
    network: {
      revision: () => 0,
      search: async () => []
    }
  })

  const settingsRepository = {
    issue: null,
    read: () => structuredClone(currentSettings),
    getRevision: () => settingsRevision,
    normalize: (patch: Partial<AppSettings>) =>
      normalizeAppSettings({ ...currentSettings, ...patch }, settingsEnv),
    update: (patch: Partial<AppSettings>) => {
      currentSettings = normalizeAppSettings({ ...currentSettings, ...patch }, settingsEnv)
      settingsRevision++
      appInstance?.changed()
      void persistEnvelope().catch((error) => {
        options.onFatalError?.(error instanceof Error ? error : new Error(String(error)))
      })
      if (Object.hasOwn(patch, 'playbackResumeMode'))
        void playbackSession.flush().catch(() => {})
      return structuredClone(currentSettings)
    }
  }

  let settingsTail: Promise<unknown> = Promise.resolve()
  const settingsService = new CoreSettingsService({
    repository: settingsRepository as any,
    authorizePaths: async (paths) => paths,
    configureLibrary: async () => {},
    serialize: <T>(action: () => Promise<T>) => {
      const next = settingsTail.then(action, action)
      settingsTail = next.then(
        () => undefined,
        () => undefined
      )
      return next
    },
    schedule: (callback, ms) => {
      const handle = scheduler.schedule(ms, callback)
      return () => handle.cancel()
    },
    failed: (error) => {
      if (error instanceof Error) options.onFatalError?.(error)
    },
    audio: {
      setAutoMixMode: async () => true,
      invalidateAutoMixSource: () => {},
      stop: async () => {
        await engineAdapter.stop()
      }
    }
  })

  const playbackSession = new CorePlaybackSession({
    engine: engineAdapter,
    queues: {
      buildQueue: (cmd) => queueStore.buildQueue(cmd),
      createQueue: (query, selectedId) => queueStore.createQueue(query, selectedId),
      getQueue: (id) => queueStore.getQueue(id),
      readQueue: (id, offset, limit, opts) => queueStore.readQueue(id, offset, limit, opts),
      editQueue: (id, rev, edit) => queueStore.editQueue(id, rev, edit),
      deleteQueue: (id, rev) => queueStore.deleteQueue(id, rev),
      readNeighbor: (id, rev, idx, dir, wrap) =>
        queueStore.readNeighbor(id, rev, idx, dir, wrap),
      libraryRevision: async () => queueStore.getLibraryRevision(),
      importLegacyPlaybackQueue: (cmd) =>
        queueStore.buildQueue(cmd as unknown as LibraryQueueBuildCommand),
      restoreNamedPlaybackQueue: (cmd) =>
        queueStore.buildQueue(cmd as unknown as LibraryQueueBuildCommand),
      restoreHeartBaseQueue: async (base) => {
        const snapshot = await queueStore.getQueue(base.id)
        if (!snapshot) {
          throw new Error(`Heart base queue not found: ${base.id}`)
        }
        return { queue: snapshot, matched: true }
      }
    },
    resolver: {
      resolve: async (rawTrack) => {
        const track = rawTrack as TrackData
        if (options.resourceAccess?.resolveTrackSource) {
          return options.resourceAccess.resolveTrackSource(track)
        }
        return {
          source: track.filePath || track.streamUrl || `resource://${track.id}`,
          expiresAt: null
        }
      }
    },
    authorize: async (source) => {
      if (options.resourceAccess) {
        return options.resourceAccess.authorize(source)
      }
      return source
    },
    repository: sessionRepository,
    resumeMode: () => currentSettings.playbackResumeMode,
    now: () => clock.nowUnixMs(),
    schedule: (callback, delayMs) => {
      const handle = scheduler.schedule(delayMs, callback)
      return () => handle.cancel()
    },
    observePlayback: (track, info) => {
      bookmarksService.observe(track, info)
      lyricsService.observe(track)
      presentationService.observe(track)
    },
    changed: () => {
      appInstance?.changed()
    },
    fatal: (error) => {
      options.onFatalError?.(error)
    }
  })

  const queueSubmission = new CoreQueueSubmission({
    playback: playbackSession,
    resolve: (items) => resolveSeedItems(items),
    newId: () => `sub-${crypto.randomUUID().slice(0, 8)}`,
    schedule: (callback, delayMs) => {
      const handle = scheduler.schedule(delayMs, callback)
      return () => handle.cancel()
    }
  })

  const application = new CoreApplication({
    epoch,
    playback: playbackSession,
    queueSubmission,
    playlistSubmission,
    resolvePlaylistInputs,
    presentation: presentationService,
    settings: settingsService,
    bookmarks: bookmarksService,
    lyrics: lyricsService,
    recordingVersions,
    playlists: playlistsService,
    search: searchService,
    libraryRevision: () => queueStore.getLibraryRevision(),
    library: {
      getMetadata: () => queueStore.getMetadata(),
      queryTracks: (query) => queueStore.queryTracks(query),
      readLibraryQueue: (id, offset, limit, opts) =>
        queueStore.readQueue(id, offset, limit, opts),
      queryCollections: (kind, query) => queueStore.queryCollections(kind, query),
      getTracksByIds: (ids) => queueStore.getTracksByIds(ids),
      lookupTracksByPaths: (paths) => queueStore.lookupTracksByPaths(paths),
      lookupPlaylistTracks: (req) => queueStore.lookupPlaylistTracks(req)
    },
    state: stateApi,
    scan: {
      initialize: async () => {},
      activate: () => {},
      snapshot: () => null,
      start: async () => {
        throw new Error('Local directory scan is managed by the platform scanner adapter')
      },
      pause: async () => false,
      resume: async () => null,
      cancel: async () => false,
      enqueueDirectories: async () => {},
      startup: async () => {},
      poll: async () => undefined,
      shutdown: async () => {}
    },
    statistics: {
      initialize: async () => {},
      getRevision: () => 0,
      historySnapshot: () => new Map(),
      summary: () => ({
        revision: 0,
        trackCount: 0,
        days: {},
        persistence: { dirty: false, failureCount: 0, error: null }
      }),
      page: () => ({ revision: 0, total: 0, offset: 0, items: [] }),
      overview: async () => ({
        revision: 0,
        trackCount: 0,
        days: {},
        persistence: { dirty: false, failureCount: 0, error: null },
        recorded: { seconds: 0, plays: 0, trackCount: 0, formats: [] },
        artists: [],
        history: { mode: 'sqlite', ready: true, pending: false, revision: 0, error: '' }
      }),
      previewClear: (_range, revision) => ({
        revision,
        dayCount: 0,
        seconds: 0,
        trackCount: 0,
        hasUndatedTracks: false
      }),
      observe: () => {},
      clear: async () => {},
      flush: async () => {},
      shutdown: async () => {}
    },
    ready: () => {}
  })

  appInstance = application

  const messageSubscribers = new Set<(message: CoreClientMessage) => void>()
  const hostClientIdentity: CoreClientIdentity = {
    id: 'portable-host-client',
    role: 'system',
    permissions: [...PORTABLE_HOST_PERMISSIONS]
  }
  application.connect(hostClientIdentity, (message) => {
    for (const sub of [...messageSubscribers]) {
      sub(message)
    }
  })

  const dispatchEnvelope = (message: CoreRequestEnvelope | CoreCancelEnvelope) => {
    if (message.kind === 'cancel') {
      application.cancel(hostClientIdentity.id, message.requestId, message.epoch)
    } else {
      void application.request(hostClientIdentity.id, message)
    }
  }

  return {
    epoch,
    protocolVersion: CORE_PROTOCOL_VERSION,
    application,
    playback: playbackSession,
    settings: settingsService,
    bookmarks: bookmarksService,
    lyrics: lyricsService,
    playlists: playlistsService,
    queueStore,
    async initialize() {
      await ensureEnvelopeLoaded()
      // Desktop restores the engine volume before the Core starts; a portable engine boots at
      // its own default, so the remembered volume is applied before playback reads it.
      await options.audioEngine.setVolume(currentSettings.softwareVolume)
      await application.initialize()
    },
    seedTracks(tracks) {
      queueStore.upsertTracks(tracks)
      application.changed()
    },
    replaceLibraryTracks(tracks) {
      queueStore.replaceLibraryTracks(tracks)
      void persistEnvelope().catch((error) => {
        options.onFatalError?.(error instanceof Error ? error : new Error(String(error)))
      })
      application.changed()
    },
    async playTracks(tracks, startIndex = 0) {
      queueStore.upsertTracks(tracks)
      await playbackSession.fromPages(
        async (append) => {
          for (let offset = 0; offset < tracks.length; offset += LIBRARY_PAGE_SIZE) {
            await append(
              tracks.slice(offset, offset + LIBRARY_PAGE_SIZE).map((track) => {
                const record = toTrackRecord(track)
                return {
                  id: record.id,
                  snapshot: record,
                  localSnapshot: record
                }
              })
            )
          }
        },
        {
          selectedIndex: startIndex
        }
      )
      await playbackSession.flush()
    },
    getSnapshot() {
      return application.snapshot(hostClientIdentity)
    },
    getSnapshotJson() {
      return JSON.stringify(application.snapshot(hostClientIdentity))
    },
    dispatchRequest(message) {
      dispatchEnvelope(message)
    },
    dispatchRequestJson(messageJson) {
      const parsed = JSON.parse(messageJson) as CoreRequestEnvelope | CoreCancelEnvelope
      dispatchEnvelope(parsed)
    },
    subscribeMessages(listener) {
      messageSubscribers.add(listener)
      return () => {
        messageSubscribers.delete(listener)
      }
    },
    subscribeMessagesJson(listener) {
      const wrapped = (message: CoreClientMessage) => {
        listener(JSON.stringify(message))
      }
      messageSubscribers.add(wrapped)
      return () => {
        messageSubscribers.delete(wrapped)
      }
    },
    getBookmarksDocument() {
      return clonePlaybackBookmarksDocument(bookmarksDoc)
    },
    getLyricsDocument() {
      return cloneLyricsManagementDocument(lyricsDoc)
    },
    getPlaylists() {
      return structuredClone(playlistsState)
    },
    getLibraryCollections() {
      return aggregateLibraryCollections(queueStore.getAllTracks())
    },
    getEqConfig() {
      return structuredClone(eqConfig)
    },
    setEqConfig(patch) {
      // Serialized so a slow engine apply cannot commit over a later edit.
      const work = eqTail
        .catch(() => undefined)
        .then(async () => {
          const next = applyEqConfigPatch(eqConfig, patch)
          await options.audioEngine.setDspConfig?.(structuredClone(next))
          eqConfig = next
          application.changed()
          await persistEnvelope()
          return structuredClone(eqConfig)
        })
      eqTail = work
      return work
    },
    async triggerPlatformSafetyBrake(_reason) {
      await playbackSession.pause()
      await playbackSession.flush()
    },
    async shutdown() {
      application.disconnect(hostClientIdentity.id)
      messageSubscribers.clear()
      await application.shutdown()
      engineAdapter.dispose()
    }
  }
}

export { CORE_PROTOCOL_VERSION, libraryQueueResumeMode }
