/**
 * Embedded (QuickJS) host surface for the real portable Music Core.
 *
 * The platform shell talks to this module through a pull-based outbox: every
 * entry point accepts JSON (string or object) and returns JSON, and
 * `drain()` hands back everything the Core produced since the last drain —
 * port calls the shell must execute, wire responses, coalesced state events,
 * boot results and logs. No Kotlin/Swift callback ever re-enters the engine.
 *
 * Wire requests are translated into Core requests from the embedded system
 * client; this module owns no playback, queue, library, lyrics, bookmark or
 * playlist rules of its own.
 */
import {
  CORE_PROTOCOL_VERSION,
  PORTABLE_EQ_PRESETS,
  aggregateLibraryCollections,
  applyEqConfigPatch,
  createDefaultEqConfig,
  createPortableMusicCoreHost,
  ensurePortableRuntimeGlobals,
  type CoreEqConfigView,
  type CoreLibraryCollectionsView,
  type CorePlaylistView,
  type PortableAudioEnginePort,
  type PortableAudioNativeEvent,
  type PortableMusicCoreHost,
  type PortableResourceAccessPort,
  type PortableSessionStorePort
} from './portableSlice.ts'
import { createDefaultPlaybackInfo, normalizeOutputConfig } from './audio/audioEngineHelpers.ts'
import type { AppSettings } from '../shared/appSettings.ts'
import type { AudioEngineQueueItem, PlayMode, PlaybackInfo } from '../shared/audioEngineTypes.ts'
import type { CoreRequestEnvelope, CoreSnapshot } from '../shared/coreProtocol.ts'
import type { CoreBookmarksState } from '../shared/coreBookmarks.ts'
import { DEFAULT_LYRICS_MANAGEMENT, type LyricsManagementDocument } from '../shared/lyricsManagement.ts'
import {
  DEFAULT_PLAYBACK_BOOKMARKS,
  type PlaybackBookmarksDocument
} from '../shared/playbackBookmarks.ts'
import type { Playlist } from '../shared/playlists.ts'
import type { TrackData } from '../shared/track.ts'
import { LIBRARY_PAGE_SIZE } from '../shared/libraryDatabase.ts'
import { normalizeCueRange, type CueRange } from '../shared/cue.ts'
import { pickOnlineLyricsText, rankOnlineLyricsCandidates } from './lyrics/onlineLyricsSearch.ts'

ensurePortableRuntimeGlobals()

type Json = Record<string, unknown>

const HOST_API_VERSION = 2
const MAX_IN_FLIGHT = 16
const SEEN_LIMIT = 1024
const DRAIN_PASSES = 64
const MAX_WIRE_COVER_LENGTH = 4096
const MAX_ONLINE_LYRICS_BYTES = 1024 * 1024
const ONLINE_LYRICS_TIMEOUT_MS = 8000
const LYRICS_ONLINE_MARKER = '[by:lrclib.net]'
const FAVORITES_PLAYLIST_NAME = '我收藏的音乐'
const SNAPSHOT_QUERIES = new Set(['core.getSnapshot', 'state.snapshot'])
const QUEUE_GUARDED = new Set([
  'playback.selectQueueIndex',
  'playback.replaceQueue',
  'queue.select',
  'queue.edit'
])
const KNOWN_CODES = new Set([
  'NOT_READY',
  'STALE_EPOCH',
  'STALE_REVISION',
  'FORBIDDEN',
  'INVALID_REQUEST',
  'BUSY',
  'CANCELLED',
  'OUTCOME_UNKNOWN',
  'FAILED',
  'NOT_FOUND',
  'PERMISSION_EXPIRED',
  'SOURCE_CHANGED',
  'UNSUPPORTED_CAPABILITY'
])
const RETRYABLE_CODES = new Set(['NOT_READY', 'STALE_EPOCH', 'STALE_REVISION', 'BUSY'])

const APP_TO_WIRE_MODE: Record<PlayMode, string> = {
  sequential: 'sequence',
  listLoop: 'loop',
  repeat: 'single',
  shuffle: 'shuffle',
  heart: 'heart'
}
const WIRE_TO_APP_MODE: Record<string, PlayMode> = {
  sequence: 'sequential',
  loop: 'listLoop',
  single: 'repeat',
  shuffle: 'shuffle',
  heart: 'heart'
}

// ============================================================================
// Runtime state
// ============================================================================

interface WireError {
  code: string
  message: string
  retryable: boolean
}

interface Pending {
  resolve(value: unknown): void
  reject(error: unknown): void
}

interface WireRequest {
  requestId: string
  cancelled: boolean
  responded: boolean
  coreRequestId: string | null
}

interface Runtime {
  generation: number
  epoch: string
  host: PortableMusicCoreHost
  retired: boolean
  shuttingDown: boolean
  booted: boolean
  bootError: string | null
  raw: Json | null
  route: Json | null
  restoreError: string | null
  lastAuthFailure: { code: string; message: string } | null
  ports: Map<string, Pending>
  nextCallId: number
  coreRequests: Map<string, Pending>
  nextCoreId: number
  wire: Map<string, WireRequest>
  seen: Set<string>
  audioListeners: Set<(event: PortableAudioNativeEvent) => void>
  queueGeneration: number
  queueGenerations: Array<{ generation: number; items: AudioEngineQueueItem[] }>
  queueRevision: { key: string; wire: number }
  eqRevision: number
  dirty: boolean
  collections: { revision: number; view: CoreLibraryCollectionsView; count: number } | null
  lyrics: { key: string; view: Json } | null
  unsubscribe: () => void
}

const outbox: Json[] = []
let current: Runtime | null = null
let generationCounter = 0
let wireSequence = 0

// ============================================================================
// Small value helpers (the Kotlin decoder rejects nulls and non-integral ints)
// ============================================================================

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseInput(input: unknown): Json {
  const value = typeof input === 'string' ? (input.trim() ? JSON.parse(input) : {}) : input
  if (value === undefined || value === null) return {}
  if (!isObject(value)) throw new TypeError('Expected a JSON object')
  return value
}

function out(value: unknown): string {
  return JSON.stringify(value)
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return typeof value !== 'boolean' && value !== null && value !== '' && Number.isFinite(n)
    ? n
    : fallback
}

function int(value: unknown, fallback: number): number {
  return Math.round(num(value, fallback))
}

function bool(value: unknown): boolean {
  return value === true
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function optStr(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' && value.trim() ? value : undefined
}

function optPositiveInt(value: unknown): number | undefined {
  const n = num(value, 0)
  return n > 0 ? Math.round(n) : undefined
}

function optPositiveNum(value: unknown): number | undefined {
  const n = num(value, 0)
  return n > 0 ? n : undefined
}

function optNonNegativeInt(value: unknown): number | undefined {
  const n = num(value, -1)
  return n >= 0 ? Math.round(n) : undefined
}

function setOpt(target: Json, key: string, value: unknown): void {
  if (value !== undefined && value !== null) target[key] = value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codeOf(error: unknown): string | undefined {
  const code = isObject(error) || error instanceof Error ? (error as Json).code : undefined
  return typeof code === 'string' ? code : undefined
}

function wireFailure(code: string, message: string, retryable?: boolean): Error {
  const error = new Error(message) as Error & { code: string; retryable?: boolean }
  error.code = code
  if (retryable !== undefined) error.retryable = retryable
  return error
}

function toWireError(rt: Runtime | null, error: unknown, wire?: WireRequest): WireError {
  if (wire?.cancelled) return { code: 'CANCELLED', message: 'Request cancelled', retryable: false }
  const message = errorMessage(error) || 'Core request failed'
  let code = codeOf(error)
  let text = message
  if (code === 'SOURCE_ACCESS_DENIED') {
    code = rt?.lastAuthFailure?.code ?? 'PERMISSION_EXPIRED'
    text = rt?.lastAuthFailure?.message ?? message
  } else if (error instanceof Error && error.name === 'AbortError') {
    code = 'CANCELLED'
  } else if (!code || !KNOWN_CODES.has(code)) {
    code = 'FAILED'
  }
  const explicit = (error as { retryable?: unknown } | null)?.retryable
  return {
    code,
    message: text,
    retryable: typeof explicit === 'boolean' ? explicit : RETRYABLE_CODES.has(code)
  }
}

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  outbox.push({ type: 'log', level, message })
}

function push(rt: Runtime | null, message: Json): void {
  if (rt?.retired) return
  outbox.push(message)
}

function markDirty(rt: Runtime): void {
  if (!rt.retired) rt.dirty = true
}

// ============================================================================
// Port calls and Core requests
// ============================================================================

function callPort<T = unknown>(rt: Runtime, port: string, method: string, args: Json = {}): Promise<T> {
  if (rt.retired) return Promise.reject(wireFailure('CANCELLED', 'Core host was restarted', false))
  const callId = `${rt.generation}-${++rt.nextCallId}`
  return new Promise<T>((resolve, reject) => {
    rt.ports.set(callId, { resolve: resolve as (value: unknown) => void, reject })
    outbox.push({ type: 'port', callId, port, method, args })
  })
}

function coreRequest<T = unknown>(
  rt: Runtime,
  kind: 'query' | 'command',
  name: string,
  payload: unknown,
  wire?: WireRequest
): Promise<T> {
  if (rt.retired) return Promise.reject(wireFailure('CANCELLED', 'Core host was restarted', false))
  if (wire?.cancelled) return Promise.reject(wireFailure('CANCELLED', 'Request cancelled', false))
  const requestId = `embedded-${rt.generation}-${++rt.nextCoreId}`
  return new Promise<T>((resolve, reject) => {
    rt.coreRequests.set(requestId, { resolve: resolve as (value: unknown) => void, reject })
    if (wire) wire.coreRequestId = requestId
    try {
      rt.host.dispatchRequest({
        kind,
        name,
        payload: payload ?? {},
        requestId,
        epoch: rt.host.epoch
      } as unknown as CoreRequestEnvelope)
    } catch (error) {
      rt.coreRequests.delete(requestId)
      reject(error)
    }
  }).finally(() => {
    if (wire?.coreRequestId === requestId) wire.coreRequestId = null
  })
}

function rejectAll(map: Map<string, Pending>, message: string): void {
  const pending = [...map.values()]
  map.clear()
  for (const entry of pending) entry.reject(wireFailure('CANCELLED', message, false))
}

// ============================================================================
// Session store port (with legacy payload migration)
// ============================================================================

function emptyEnvelopeJson(): string {
  return JSON.stringify({ schema: 'portable-core/1', session: null, queues: [], tracks: [] })
}

function isLegacyPayload(value: Json): boolean {
  return (
    value.schema === undefined &&
    (Array.isArray(value.favoriteTrackIds) ||
      typeof value.queueRevision === 'number' ||
      Array.isArray(value.libraryTracks) ||
      typeof value.currentQueueIndex === 'number' ||
      Array.isArray(value.bookmarks))
  )
}

function rebuildLrc(view: Json): string | null {
  const lines = Array.isArray(view.lines) ? view.lines.filter(isObject) : []
  if (lines.length === 0) return null
  const stamp = (ms: number) => {
    const total = Math.max(0, Math.round(ms))
    const minutes = Math.floor(total / 60_000)
    const seconds = Math.floor((total % 60_000) / 1000)
    const centis = Math.floor((total % 1000) / 10)
    return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}]`
  }
  const synced = view.synced !== false
  const rows: string[] = []
  for (const line of lines) {
    const text = str(line.text)
    if (!text) continue
    const translation = optStr(line.translation)
    if (!synced) {
      rows.push(text)
      continue
    }
    const at = stamp(num(line.timeMs, 0))
    rows.push(`${at}${text}`)
    // The parser folds a repeated timestamp into the line's translation.
    if (translation) rows.push(`${at}${translation}`)
  }
  return rows.length ? rows.join('\n') : null
}

function migrateLegacyPayload(legacy: Json): Json {
  const now = new Date().toISOString()
  const records = new Map<string, TrackData>()
  for (const raw of Array.isArray(legacy.libraryTracks) ? legacy.libraryTracks : []) {
    const track = trackFromWire(raw)
    if (track) records.set(track.id, track)
  }
  const tracks = [...records.values()]
  const queueTracks = (Array.isArray(legacy.queueTracks) ? legacy.queueTracks : [])
    .map((raw) => trackFromWire(raw))
    .filter((track): track is TrackData => track !== null)
  const playMode = WIRE_TO_APP_MODE[str(legacy.playMode)] ?? 'sequential'
  const envelope: Json = { schema: 'portable-core/1', session: null, queues: [], tracks }
  if (queueTracks.length > 0) {
    const index = Math.min(Math.max(0, int(legacy.currentQueueIndex, 0)), queueTracks.length - 1)
    const rows = queueTracks.map((track, i) => ({
      queueEntryId: `legacy-entry-${i}`,
      originalOrder: i,
      trackId: track.id,
      snapshot: { ...track }
    }))
    envelope.queues = [
      {
        id: 'legacy-queue',
        revision: 1,
        index,
        selectedEntryId: rows[index].queueEntryId,
        order: 'original',
        playMode,
        rows
      }
    ]
    envelope.session = {
      version: 1,
      savedAt: Date.now(),
      mode: 'track',
      playMode,
      track: { ...queueTracks[index], queueEntryId: rows[index].queueEntryId },
      position: 0,
      libraryQueue: { id: 'legacy-queue', revision: 1, entryId: rows[index].queueEntryId, index }
    }
  }
  const favoriteIds = Array.isArray(legacy.favoriteTrackIds)
    ? legacy.favoriteTrackIds.map(String)
    : []
  const playlists: Playlist[] = [
    {
      id: 'legacy-favorites',
      name: FAVORITES_PLAYLIST_NAME,
      isDefault: true,
      trackIds: favoriteIds,
      createdAt: now,
      updatedAt: now
    } as Playlist
  ]
  envelope.playlists = playlists
  if (Array.isArray(legacy.playlists)) {
    // The Core folds this parallel list into its playlist document once.
    envelope.customPlaylists = legacy.playlists.filter(isObject) as unknown as CorePlaylistView[]
  }
  if (Array.isArray(legacy.bookmarks)) {
    const bookmarks = legacy.bookmarks.filter(isObject).map((bookmark) => {
      const trackId = str(bookmark.trackId)
      const record = records.get(trackId) ?? queueTracks.find((track) => track.id === trackId)
      const at = new Date(num(bookmark.createdAtMs, Date.now())).toISOString()
      return {
        id: str(bookmark.id) || `legacy-bookmark-${trackId}-${int(bookmark.positionSec, 0)}`,
        trackKey: `local:${record?.filePath || trackId}${record?.cueRange ? `#cue:${record.cueRange.startSeconds}` : ''}`,
        trackId,
        ...(record?.title ? { title: record.title } : {}),
        ...(record?.artist ? { artist: record.artist } : {}),
        positionSeconds: Math.max(0, num(bookmark.positionSec, 0)),
        label: str(bookmark.label),
        createdAt: at,
        updatedAt: at,
        kind: 'manual' as const
      }
    })
    envelope.bookmarks = {
      schemaVersion: 1,
      longTrackResumeSeconds: DEFAULT_PLAYBACK_BOOKMARKS.longTrackResumeSeconds,
      bookmarks
    } as unknown as PlaybackBookmarksDocument
  }
  if (isObject(legacy.customLyrics)) {
    const lyrics: LyricsManagementDocument = structuredClone(DEFAULT_LYRICS_MANAGEMENT)
    for (const [trackId, view] of Object.entries(legacy.customLyrics)) {
      if (!isObject(view)) continue
      const lrc = rebuildLrc(view)
      if (!lrc) continue
      lyrics.tracks[trackId] = {
        offsetMs: 0,
        source: 'manual',
        originalSelection: 'manual',
        original: view.source === 'online' ? `${LYRICS_ONLINE_MARKER}\n${lrc}` : lrc,
        translation: null,
        romanization: null,
        updatedAt: now
      } as LyricsManagementDocument['tracks'][string]
    }
    envelope.lyricsManagement = lyrics
  }
  if (isObject(legacy.eqConfig)) envelope.eqConfig = legacy.eqConfig
  return envelope
}

function createSessionStore(rt: Runtime): PortableSessionStorePort {
  return {
    async load() {
      const stored = await callPort<Json | null>(rt, 'sessionStore', 'load')
      if (!isObject(stored)) return null
      const revision = str(stored.revision) || '0'
      const payloadJson = str(stored.payloadJson)
      let parsed: unknown
      try {
        parsed = JSON.parse(payloadJson)
      } catch (error) {
        log('error', `Stored Core session is not valid JSON and was ignored: ${errorMessage(error)}`)
        return { revision, payloadJson: emptyEnvelopeJson() }
      }
      if (!isObject(parsed)) {
        log('error', 'Stored Core session is not an object and was ignored')
        return { revision, payloadJson: emptyEnvelopeJson() }
      }
      if (isLegacyPayload(parsed)) {
        log('info', 'Migrating legacy Android Core session payload')
        return { revision, payloadJson: JSON.stringify(migrateLegacyPayload(parsed)) }
      }
      migrateCueSources(parsed)
      return { revision, payloadJson: JSON.stringify(parsed) }
    },
    async save(payloadJson, expectedRevision) {
      const result = await callPort<Json>(rt, 'sessionStore', 'save', {
        payloadJson,
        expectedRevision
      })
      if (isObject(result) && result.ok === true && result.revision != null) {
        return { ok: true, revision: str(result.revision) }
      }
      if (isObject(result) && result.ok === false) return { ok: false, reason: 'conflict' }
      throw wireFailure('FAILED', 'Session store returned an invalid save result')
    }
  }
}

// ============================================================================
// Resource access and audio engine ports
// ============================================================================

function createResourceAccess(rt: Runtime): PortableResourceAccessPort {
  return {
    async authorize(source) {
      try {
        await callPort(rt, 'resourceAccess', 'resolveNativeUri', { resourceId: source })
        rt.lastAuthFailure = null
        return source
      } catch (error) {
        const wire = toWireError(rt, error)
        rt.lastAuthFailure = { code: wire.code, message: wire.message }
        throw error
      }
    }
  }
}

function fileNameOf(source: string): string {
  const tail = source.split(/[\\/]/).pop() ?? ''
  try {
    return decodeURIComponent(tail)
  } catch {
    return tail
  }
}

function wireQueueItem(item: AudioEngineQueueItem): Json {
  const row: Json = {
    id: item.id,
    title: item.title || fileNameOf(item.source) || item.id,
    artist: item.artist ?? '',
    album: item.album ?? '',
    duration: num(item.duration, 0),
    source: item.source
  }
  setOpt(row, 'queueEntryId', optStr(item.queueEntryId))
  setOpt(row, 'cueRange', item.cueRange)
  return row
}

function itemsForGeneration(rt: Runtime, generation: unknown): AudioEngineQueueItem[] {
  const wanted = int(generation, -1)
  const match = rt.queueGenerations.find((entry) => entry.generation === wanted)
  return (match ?? rt.queueGenerations[rt.queueGenerations.length - 1])?.items ?? []
}

function toPlaybackInfo(rt: Runtime, raw: Json): PlaybackInfo {
  const info = createDefaultPlaybackInfo('alsa', '', false, normalizeOutputConfig())
  const state = str(raw.state)
  info.state =
    state === 'playing' ? 'playing' : state === 'paused' || state === 'loading' ? 'paused' : 'stopped'
  info.position = Math.max(0, num(raw.positionMs, 0)) / 1000
  info.duration = Math.max(0, num(raw.durationMs, 0)) / 1000
  info.volume = num(raw.volume, 1)
  info.playbackRate = num(raw.playbackRate, 1)
  info.queueIndex = int(raw.queueIndex, -1)
  info.source = itemsForGeneration(rt, raw.queueGeneration)[info.queueIndex]?.source ?? ''
  info.playMode = WIRE_TO_APP_MODE[str(raw.playMode)] ?? 'sequential'
  info.nativePlaybackActive = state === 'playing' || state === 'paused' || state === 'loading'
  info.codec = str(raw.codec)
  info.sourceSampleRate = Math.max(0, num(raw.sampleRate, 0))
  info.sourceBitDepth = Math.max(0, num(raw.bitDepth, 0))
  info.sourceChannels = Math.max(0, num(raw.channels, 0))
  info.outputBackend = str(raw.outputBackend)
  info.actualBackend = str(raw.outputBackend)
  info.actualSampleRate = Math.max(0, num(raw.actualSampleRate, 0))
  info.actualBitDepth = Math.max(0, num(raw.actualBitDepth, 0))
  info.actualChannels = Math.max(0, num(raw.actualChannels, 0))
  info.outputPerfect = bool(raw.outputPerfect)
  info.dspActive = bool(raw.dspActive)
  info.eqActive = bool(raw.eqActive)
  info.latencyMs = Math.max(0, num(raw.latencyMs, 0))
  info.bufferSizeFrames = Math.max(0, int(raw.bufferSizeFrames, 0))
  info.gaplessActive = bool(raw.gaplessActive)
  info.preloadReady = bool(raw.preloadReady)
  info.gaplessBlockedReason = str(raw.gaplessBlockedReason)
  info.perfectReason = str(raw.perfectReason)
  info.perfectReasonCode = str(raw.perfectReasonCode)
  info.crossfadeActive = bool(raw.crossfadeActive)
  info.crossfadeSeconds = Math.max(0, num(raw.crossfadeSeconds, 0))
  info.upcomingTrack = null
  if (state === 'error') {
    info.diagnostics.lastError = str(raw.errorMessage) || str(raw.message) || 'Audio engine error'
  }
  return info
}

function createAudioEngine(rt: Runtime): PortableAudioEnginePort {
  return {
    async loadQueue(items, startIndex = 0) {
      const generation = ++rt.queueGeneration
      rt.queueGenerations.push({ generation, items: items.map((item) => ({ ...item })) })
      while (rt.queueGenerations.length > 4) rt.queueGenerations.shift()
      await callPort(rt, 'audioEngine', 'loadQueue', {
        tracks: items.map(wireQueueItem),
        startIndex: Math.max(0, Math.round(startIndex)),
        queueGeneration: generation
      })
    },
    async play(source, positionSeconds) {
      await callPort(rt, 'audioEngine', 'play', { position: positionSeconds ?? 0, source })
      return { nativeStarted: true, fallbackReason: '' }
    },
    async pause() {
      await callPort(rt, 'audioEngine', 'pause')
    },
    async stop() {
      await callPort(rt, 'audioEngine', 'stop')
    },
    async seek(positionSeconds) {
      await callPort(rt, 'audioEngine', 'seek', {
        positionMs: Math.max(0, Math.round(positionSeconds * 1000))
      })
    },
    async setVolume(volume) {
      await callPort(rt, 'audioEngine', 'setVolume', { volume })
    },
    async setPlaybackRate(rate) {
      if (rate === 1) return
      throw wireFailure('UNSUPPORTED_CAPABILITY', 'Playback rate is not supported on this device', false)
    },
    async setPlayMode(mode) {
      const wire = mode === 'repeat' ? 'single' : mode === 'listLoop' ? 'loop' : 'sequence'
      await callPort(rt, 'audioEngine', 'setPlayMode', { mode: wire })
    },
    async setDspConfig(config) {
      await callPort(rt, 'audioEngine', 'setDspConfig', { configJson: JSON.stringify(config) })
    },
    async getSnapshot() {
      const raw = await callPort<Json>(rt, 'audioEngine', 'getSnapshot')
      if (!isObject(raw)) throw wireFailure('FAILED', 'Audio engine returned an invalid snapshot')
      rt.raw = raw
      return toPlaybackInfo(rt, raw)
    },
    subscribe(listener) {
      rt.audioListeners.add(listener)
      return () => {
        rt.audioListeners.delete(listener)
      }
    }
  }
}

function emitAudio(rt: Runtime, event: PortableAudioNativeEvent): void {
  for (const listener of [...rt.audioListeners]) {
    try {
      listener(event)
    } catch (error) {
      log('error', `Audio event listener failed: ${errorMessage(error)}`)
    }
  }
}

function refreshRoute(rt: Runtime): void {
  void callPort<Json>(rt, 'audioDevice', 'getActiveRoute')
    .then((route) => {
      if (isObject(route)) rt.route = route
      markDirty(rt)
    })
    .catch((error) => log('warn', `Audio route refresh failed: ${errorMessage(error)}`))
}

// ============================================================================
// Wire projections
// ============================================================================

function artistNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((artist) => (typeof artist === 'string' ? artist : isObject(artist) ? str(artist.name) : ''))
    .filter((name) => name.length > 0)
}

/** Core views carry display identity only; the wire also needs the playable
 * URI and integral metadata from the Core's own track record. */
function wireTrack(rt: Runtime, view: Json): Json {
  const id = str(view.id)
  const record = (rt.host.queueStore.getTrack(id) ?? {}) as Json
  const merged: Json = { ...record, ...view }
  const title =
    optStr(merged.title) ?? optStr(record.fileName) ?? (optStr(record.filePath) ? fileNameOf(str(record.filePath)) : id)
  const track: Json = {
    id,
    title,
    artist: str(merged.artist),
    artists: artistNames(merged.artists),
    album: str(merged.album),
    duration: Math.max(0, num(merged.duration, 0))
  }
  setOpt(track, 'queueEntryId', optStr(view.queueEntryId))
  setOpt(track, 'albumId', optStr(merged.albumId))
  setOpt(track, 'source', optStr(record.filePath) ?? optStr(record.streamUrl))
  if (merged.ncmSongId !== undefined && merged.ncmSongId !== null && merged.ncmSongId !== '') {
    track.ncmSongId = String(merged.ncmSongId)
  }
  const cover = merged.cover
  if (typeof cover === 'string' && cover && cover.length <= MAX_WIRE_COVER_LENGTH) track.cover = cover
  setOpt(track, 'unavailableReason', optStr(merged.unavailableReason))
  setOpt(track, 'size', optNonNegativeInt(merged.size))
  setOpt(track, 'format', optStr(merged.format))
  setOpt(track, 'sampleRate', optPositiveInt(merged.sampleRate))
  setOpt(track, 'bitrate', optPositiveNum(merged.bitrate))
  setOpt(track, 'bitDepth', optPositiveInt(merged.bitDepth))
  setOpt(track, 'discNumber', optPositiveInt(merged.discNumber))
  setOpt(track, 'trackNumber', optPositiveInt(merged.trackNumber))
  setOpt(track, 'releaseDate', optStr(merged.releaseDate))
  setOpt(
    track,
    'genre',
    Array.isArray(merged.genre) ? optStr(merged.genre.map(String).join(', ')) : optStr(merged.genre)
  )
  setOpt(track, 'albumArtist', optStr(merged.albumArtist))
  setOpt(track, 'addedAt', optNonNegativeInt(merged.addedAt))
  setOpt(track, 'bpm', optPositiveNum(merged.bpm))
  setOpt(track, 'isrc', optStr(merged.isrc))
  setOpt(track, 'catalog', optStr(merged.catalog))
  setOpt(track, 'cueRange', normalizeCueRange(merged.cueRange) ?? undefined)
  return track
}

/** Read P1 Android sessions without leaving a segment encoded in a file URI. */
function legacyCueSource(source: string | undefined): { source: string | undefined; range?: CueRange } {
  if (!source) return { source }
  const at = source.lastIndexOf('#cue=')
  if (at <= 0) return { source }
  const parts = source.slice(at + 5).split(',')
  if (![2, 4].includes(parts.length) || parts.some((part) => !/^\d+(?:\.\d+)?(?:E-?\d+)?$/.test(part)))
    return { source }
  const [startSeconds, endSeconds, virtualPregapSeconds = 0, sourcePregapSeconds = 0] = parts.map(Number)
  const range = normalizeCueRange({ startSeconds, endSeconds, virtualPregapSeconds, sourcePregapSeconds,
    pregapSeconds: virtualPregapSeconds || sourcePregapSeconds })
  return range ? { source: source.slice(0, at), range } : { source }
}

function migrateCueSources(envelope: Json): void {
  const bookmarkKeys = new Map<string, string>()
  const migrateTrack = (record: unknown) => {
    if (!isObject(record)) return
    const previous = optStr(record.filePath)
    const legacy = legacyCueSource(previous)
    if (!legacy.range || record.cueRange !== undefined) return
    record.filePath = legacy.source
    record.cueRange = legacy.range
    bookmarkKeys.set(`local:${previous}`, `local:${legacy.source}#cue:${legacy.range.startSeconds}`)
  }
  if (Array.isArray(envelope.tracks)) envelope.tracks.forEach(migrateTrack)
  if (isObject(envelope.session)) {
    migrateTrack(envelope.session.track)
    if (Array.isArray(envelope.session.queue)) envelope.session.queue.forEach(migrateTrack)
  }
  if (Array.isArray(envelope.queues)) for (const queue of envelope.queues) {
    if (isObject(queue) && Array.isArray(queue.rows))
      for (const row of queue.rows) if (isObject(row)) migrateTrack(row.snapshot)
  }
  if (isObject(envelope.bookmarks) && Array.isArray(envelope.bookmarks.bookmarks)) {
    for (const bookmark of envelope.bookmarks.bookmarks) {
      if (isObject(bookmark)) {
        const key = bookmarkKeys.get(str(bookmark.trackKey))
        if (key) bookmark.trackKey = key
      }
    }
  }
}

function trackFromWire(raw: unknown): TrackData | null {
  if (!isObject(raw)) return null
  const id = optStr(raw.id)
  if (!id) return null
  const legacy = legacyCueSource(optStr(raw.source))
  const source = legacy.source
  const cueRange = raw.cueRange === undefined ? legacy.range : normalizeCueRange(raw.cueRange)
  if (raw.cueRange !== undefined && !cueRange)
    throw wireFailure('INVALID_REQUEST', `CUE range is invalid: ${id}`, false)
  if (legacy.range && cueRange && JSON.stringify(legacy.range) !== JSON.stringify(cueRange))
    throw wireFailure('INVALID_REQUEST', `CUE range conflicts with its source: ${id}`, false)
  const fileName = source ? fileNameOf(source) : id
  const track: Json = {
    id,
    title: optStr(raw.title) ?? fileName,
    artist: str(raw.artist),
    album: str(raw.album),
    filePath: source ?? id,
    fileName,
    duration: Math.max(0, num(raw.duration, 0)),
    size: Math.max(0, int(raw.size, 0)),
    cover: typeof raw.cover === 'string' ? raw.cover : null,
    lyrics: null,
    source: 'local',
    artists: artistNames(raw.artists).map((name) => ({ name }))
  }
  const ncm = Number(raw.ncmSongId)
  if (raw.ncmSongId != null && raw.ncmSongId !== '' && Number.isFinite(ncm)) track.ncmSongId = ncm
  for (const key of [
    'albumId',
    'format',
    'releaseDate',
    'genre',
    'albumArtist',
    'isrc'
  ] as const) {
    setOpt(track, key, optStr(raw[key]))
  }
  for (const key of ['sampleRate', 'bitDepth', 'discNumber', 'trackNumber'] as const) {
    setOpt(track, key, optPositiveInt(raw[key]))
  }
  setOpt(track, 'bitrate', optPositiveNum(raw.bitrate))
  setOpt(track, 'bpm', optPositiveNum(raw.bpm))
  setOpt(track, 'addedAt', optNonNegativeInt(raw.addedAt))
  setOpt(track, 'cueRange', cueRange)
  return track as unknown as TrackData
}

function collections(rt: Runtime): { view: CoreLibraryCollectionsView; count: number } {
  const revision = rt.host.queueStore.getLibraryRevision()
  if (rt.collections?.revision !== revision) {
    const tracks = rt.host.queueStore.getAllTracks()
    rt.collections = { revision, view: aggregateLibraryCollections(tracks), count: tracks.length }
  }
  return rt.collections
}

function favoritesPlaylist(playlists: readonly Playlist[]): Playlist | undefined {
  return (
    playlists.find((playlist) => playlist.isDefault) ??
    playlists.find(
      (playlist) => playlist.name === FAVORITES_PLAYLIST_NAME && (playlist as { kind?: unknown }).kind !== 'aggregate'
    )
  )
}

function wirePlaylists(playlists: readonly Playlist[]): Json[] {
  return playlists
    .filter(
      (playlist) =>
        !playlist.isDefault &&
        !playlist.transient &&
        !playlist.imported &&
        (playlist as { kind?: unknown }).kind !== 'aggregate'
    )
    .map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      trackIds: [...playlist.trackIds],
      trackCount: playlist.trackIds.length,
      updatedAtMs: Date.parse(playlist.updatedAt ?? playlist.createdAt) || 0
    }))
}

function mergeTranslation(
  lines: EmbeddedLyricLine[],
  translation: string | null | undefined,
  synced = true
): EmbeddedLyricLine[] {
  if (!translation || !translation.trim()) return lines
  const parsed = parseEmbeddedLrcLines(translation)
  if (!synced) {
    if (parsed.synced) return lines
    return lines.map((line, index) =>
      line.translation ? line : { ...line, translation: parsed.lines[index]?.text ?? null }
    )
  }
  if (!parsed.synced || parsed.lines.length === 0) return lines
  const used = new Set<number>()
  const byTime = new Map<number, { index: number; text: string }>()
  parsed.lines.forEach((line, index) => {
    if (!byTime.has(line.timeMs)) byTime.set(line.timeMs, { index, text: line.text })
  })
  const exactMerged = lines.map((line) => {
    if (line.translation) return line
    const exact = byTime.get(line.timeMs)
    if (!exact) return line
    used.add(exact.index)
    return { ...line, translation: exact.text }
  })
  return exactMerged.map((line) => {
    if (line.translation) return line
    let bestIndex = -1
    let bestDelta = 1501
    for (let i = 0; i < parsed.lines.length; i++) {
      if (used.has(i)) continue
      const delta = Math.abs(parsed.lines[i]!.timeMs - line.timeMs)
      if (delta <= 1500 && delta < bestDelta) {
        bestDelta = delta
        bestIndex = i
      }
    }
    if (bestIndex < 0) return line
    used.add(bestIndex)
    return { ...line, translation: parsed.lines[bestIndex]!.text }
  })
}

function lyricsView(rt: Runtime, requestedTrackId?: string | null): Json {
  const content = rt.host.lyrics.content()
  const currentId = content.current?.trackId ?? null
  const trackId = requestedTrackId || currentId
  if (!trackId) return { trackId: '', source: 'none', synced: false, lines: [] }
  let original: string | null | undefined
  let translation: string | null | undefined
  let override: Json | null
  if (trackId === currentId) {
    override = content.override as Json | null
    original = content.effective?.original
    translation = content.effective?.translation
  } else {
    override = rt.host.lyrics.entry(trackId).override as Json | null
    const record = rt.host.queueStore.getTrack(trackId) as Json | null
    original = override?.originalSelection === 'manual'
      ? (override.original as string | null)
      : (record?.lyrics as string | null | undefined)
    translation = override?.translationSelection === 'manual'
      ? (override.translation as string | null)
      : (record?.translatedLyrics as string | null | undefined)
  }
  if (typeof original !== 'string' || !original.trim()) {
    return { trackId, source: 'none', synced: false, lines: [] }
  }
  const source = original.trimStart().startsWith(LYRICS_ONLINE_MARKER)
    ? 'online'
    : override?.originalSelection === 'manual'
      ? 'imported'
      : 'embedded'
  const parsed = parseEmbeddedLrcLines(original)
  const lines = mergeTranslation(parsed.lines, translation, parsed.synced)
  return {
    trackId,
    source,
    synced: parsed.synced,
    lines: lines.map((line) => {
      const row: Json = { timeMs: Math.round(line.timeMs), text: line.text }
      setOpt(row, 'translation', optStr(line.translation))
      return row
    })
  }
}

function currentLyrics(rt: Runtime, core: CoreSnapshot): Json | undefined {
  const trackId = core.track?.id
  if (!trackId) return undefined
  const key = `${trackId}|${core.lyricsRevision ?? 0}|${core.lyricsContentRevision ?? 0}`
  if (rt.lyrics?.key !== key) rt.lyrics = { key, view: lyricsView(rt, trackId) }
  return rt.lyrics.view.source === 'none' ? undefined : rt.lyrics.view
}

function wireState(coreState: unknown, raw: Json | null): string {
  const rawState = str(raw?.state)
  if (coreState !== 'stopped' && (rawState === 'loading' || rawState === 'error')) return rawState
  return coreState === 'playing' || coreState === 'paused' ? coreState : 'stopped'
}

function projectPlayback(rt: Runtime, core: CoreSnapshot): Json | undefined {
  const p = core.playback as unknown as Json | null
  if (!p) return undefined
  const raw = rt.raw ?? {}
  const actualSampleRate = optPositiveInt(raw.actualSampleRate ?? p.actualSampleRate)
  const actualBitDepth = optPositiveInt(raw.actualBitDepth ?? p.actualBitDepth)
  const view: Json = {
    dspActive: bool(raw.dspActive ?? p.dspActive),
    eqActive: bool(raw.eqActive),
    exclusive: bool(raw.exclusive),
    latencyMs: Math.max(0, num(raw.latencyMs, 0)),
    bufferSizeFrames: Math.max(0, int(raw.bufferSizeFrames, 0)),
    state: wireState(p.state, rt.raw),
    position: Math.max(0, num(p.position, 0)),
    duration: Math.max(0, num(p.duration, 0)),
    volume: num(p.volume, 1),
    playbackRate: num(p.playbackRate, 1),
    playMode: APP_TO_WIRE_MODE[p.playMode as PlayMode] ?? 'sequence',
    queueIndex: core.queue ? int(core.queue.index, -1) : -1,
    queueRevision: wireQueueRevision(rt, core.queue),
    requestedConfigRevision: int(p.requestedConfigRevision, 0),
    appliedConfigRevision: int(p.appliedConfigRevision, 0),
    nativePlaybackActive: bool(p.nativePlaybackActive),
    outputPerfect: bool(raw.outputPerfect) && actualSampleRate !== undefined && actualBitDepth !== undefined,
    sourceExact: bool(p.sourceExact),
    pcmPassthrough: bool(p.pcmPassthrough),
    isDsd: bool(p.isDsd),
    gaplessActive: bool(raw.gaplessActive ?? p.gaplessActive),
    preloadReady: bool(raw.preloadReady ?? p.preloadReady),
    crossfadeActive: bool(raw.crossfadeActive ?? p.crossfadeActive),
    crossfadeSeconds: Math.max(0, num(raw.crossfadeSeconds ?? p.crossfadeSeconds, 0)),
    crossfadeMixActive: bool(raw.crossfadeMixActive ?? p.crossfadeMixActive),
    crossfadeEffectiveSeconds: Math.max(
      0,
      num(raw.crossfadeEffectiveSeconds ?? p.crossfadeEffectiveSeconds, 0)
    ),
    autoMixMode: 'off',
    autoMixState: 'idle',
    clipCount: 0
  }
  setOpt(view, 'streamTitle', optStr(p.streamTitle))
  setOpt(view, 'perfectReason', optStr(raw.perfectReason))
  setOpt(view, 'perfectReasonCode', optStr(raw.perfectReasonCode))
  setOpt(view, 'actualDeviceId', optStr(raw.actualDeviceId))
  // The engine only knows its stream handle ("AAudio Device #2"); when the host route is the
  // device that stream landed on, its product name is what the listener recognises.
  const route = rt.route
  const routeIsStreamDevice = raw.actualDeviceId != null && route?.deviceId != null && String(route.deviceId) === String(raw.actualDeviceId)
  setOpt(view, 'actualDeviceName', (routeIsStreamDevice ? optStr(route?.deviceName) : undefined) ?? optStr(raw.actualDeviceName))
  setOpt(view, 'gaplessBlockedReason', optStr(raw.gaplessBlockedReason ?? p.gaplessBlockedReason))
  setOpt(view, 'codec', optStr(raw.codec ?? p.codec))
  setOpt(view, 'bitrate', optPositiveNum(p.bitrate))
  setOpt(view, 'sourceSampleRate', optPositiveInt(raw.sampleRate ?? p.sourceSampleRate))
  setOpt(view, 'sourceChannels', optPositiveInt(raw.channels ?? p.sourceChannels))
  setOpt(view, 'sourceBitDepth', optPositiveInt(raw.bitDepth ?? p.sourceBitDepth))
  setOpt(view, 'decodedSampleRate', optPositiveInt(p.decodedSampleRate))
  setOpt(view, 'decodedBitDepth', optPositiveInt(p.decodedBitDepth))
  setOpt(view, 'decodedChannels', optPositiveInt(p.decodedChannels))
  setOpt(view, 'decodedSampleFormat', optStr(p.decodedSampleFormat))
  const backend = optStr(raw.outputBackend) ?? optStr(p.outputBackend)
  if (backend) {
    const routeType = optStr(rt.route?.routeType)
    view.outputBackend = routeType && routeType !== 'speaker' ? `${backend}:${routeType}` : backend
  }
  setOpt(view, 'actualSampleRate', actualSampleRate)
  setOpt(view, 'actualBitDepth', actualBitDepth)
  setOpt(view, 'actualChannels', optPositiveInt(raw.actualChannels ?? p.actualChannels))
  // Android engines also report the negotiated stream format and what the device offers.
  setOpt(view, 'actualSampleFormat', optStr(raw.actualSampleFormat))
  setOpt(view, 'requestedSampleRate', optPositiveInt(raw.requestedSampleRate))
  setOpt(view, 'requestedSampleFormat', optStr(raw.requestedSampleFormat))
  setOpt(view, 'hardwareSampleRate', optPositiveInt(raw.hardwareSampleRate))
  setOpt(view, 'hardwareBitDepth', optPositiveInt(raw.hardwareBitDepth))
  setOpt(view, 'hardwareChannels', optPositiveInt(raw.hardwareChannels))
  setOpt(view, 'hardwareSampleFormat', optStr(raw.hardwareSampleFormat))
  setOpt(view, 'dsdMode', optStr(p.dsdMode))
  setOpt(view, 'dsdRate', optPositiveInt(p.dsdRate))
  setOpt(view, 'crossfadeCurve', optStr(p.crossfadeCurve))
  setOpt(view, 'crossfadeBlockedReason', optStr(p.crossfadeBlockedReason))
  const upcoming = p.upcomingTrack as Json | null
  if (isObject(upcoming) && optStr(upcoming.id)) {
    const row: Json = {
      id: str(upcoming.id),
      title: optStr(upcoming.title) ?? str(upcoming.id),
      artist: str(upcoming.artist),
      album: str(upcoming.album),
      duration: Math.max(0, num(upcoming.duration, 0))
    }
    setOpt(row, 'queueEntryId', optStr(upcoming.queueEntryId))
    setOpt(row, 'cueRange', normalizeCueRange(upcoming.cueRange) ?? undefined)
    view.upcomingTrack = row
  }
  return view
}

function projectSnapshot(rt: Runtime): Json {
  const core = rt.host.getSnapshot()
  const snapshot: Json = {
    protocolVersion: CORE_PROTOCOL_VERSION,
    epoch: rt.epoch,
    sequence: ++wireSequence,
    phase: core.phase,
    isStreamBuffering: bool(core.isStreamBuffering),
    loading: bool(core.loading),
    migrationRequired: bool(core.migrationRequired)
  }
  setOpt(snapshot, 'error', rt.restoreError ?? rt.bootError ?? core.error ?? undefined)
  setOpt(snapshot, 'playback', projectPlayback(rt, core))
  if (core.track) snapshot.track = wireTrack(rt, core.track as unknown as Json)
  if (core.queue) {
    const queue: Json = {
      id: core.queue.id,
      revision: wireQueueRevision(rt, core.queue),
      total: Math.max(0, int(core.queue.total, 0)),
      index: int(core.queue.index, -1),
      canUndo: bool(core.queue.canUndo)
    }
    setOpt(queue, 'occurrenceId', optStr(core.queue.occurrenceId))
    setOpt(queue, 'undoLabel', optStr(core.queue.undoLabel))
    snapshot.queue = queue
  }
  if (core.mute) {
    snapshot.mute = {
      muted: bool(core.mute.muted),
      userVolume: num(core.mute.userVolume, 1),
      lastAudibleVolume: num(core.mute.lastAudibleVolume, 1)
    }
  }
  const revisions: Array<[string, unknown]> = [
    ['libraryRevision', core.libraryRevision],
    ['catalogRevision', core.catalogRevision],
    ['entityMetadataRevision', core.entityMetadataRevision],
    ['presentationRevision', core.presentationRevision],
    ['playlistsRevision', core.playlistsRevision],
    ['settingsRevision', core.settingsRevision],
    ['lyricsRevision', core.lyricsRevision]
  ]
  for (const [key, value] of revisions) {
    if (typeof value === 'number' && Number.isFinite(value)) snapshot[key] = Math.round(value)
  }
  snapshot.audioRevision = rt.eqRevision
  const playlists = rt.host.getPlaylists()
  snapshot.favoriteTrackIds = [...(favoritesPlaylist(playlists)?.trackIds ?? [])]
  snapshot.bookmarks = rt.host
    .getBookmarksDocument()
    .bookmarks.filter((bookmark) => bookmark.kind !== 'resume')
    .map((bookmark) => ({
      id: bookmark.id,
      trackId: bookmark.trackId ?? '',
      positionSec: Math.max(0, num(bookmark.positionSeconds, 0)),
      label: bookmark.label ?? '',
      createdAtMs: Date.parse(bookmark.createdAt) || 0
    }))
  snapshot.playlists = wirePlaylists(playlists)
  const library = collections(rt)
  snapshot.albums = library.view.albums
  snapshot.artists = library.view.artists
  snapshot.libraryTrackCount = library.count
  snapshot.eqConfig = rt.host.getEqConfig()
  setOpt(snapshot, 'currentLyrics', currentLyrics(rt, core))
  return snapshot
}

// ============================================================================
// Wire request mapping
// ============================================================================

/**
 * The Core restarts its revision for every replaced queue, but wire clients compare revisions
 * alone. The wire revision therefore rises whenever the queue id or revision changes, so a revision
 * from an earlier queue can never match a later one. No queue is revision 0.
 */
function wireQueueRevision(rt: Runtime, queue: { id: string; revision: number } | null | undefined): number {
  if (!queue) return 0
  const key = `${queue.id}:${queue.revision}`
  if (rt.queueRevision.key !== key) rt.queueRevision = { key, wire: rt.queueRevision.wire + 1 }
  return rt.queueRevision.wire
}

/** The Core revision behind a wire revision of the current queue. */
function coreQueueRevision(rt: Runtime, queueId: string, wireRevision: number): number {
  const queue = rt.host.getSnapshot().queue
  if (!queue || queue.id !== queueId || wireQueueRevision(rt, queue) !== wireRevision) {
    throw wireFailure('STALE_REVISION', '队列已变化，请刷新后重试', true)
  }
  return queue.revision
}

function requireQueue(rt: Runtime): NonNullable<CoreSnapshot['queue']> {
  const queue = rt.host.getSnapshot().queue
  if (!queue) throw wireFailure('NOT_FOUND', '当前没有播放队列', false)
  return queue
}

function clampLimit(value: unknown, fallback: number): number {
  return Math.min(1000, Math.max(1, int(value, fallback)))
}

async function queueWindow(rt: Runtime, wire: WireRequest, payload: Json): Promise<Json> {
  const offset = Math.max(0, int(payload.offset, 0))
  const limit = clampLimit(payload.limit, 50)
  const queue = rt.host.getSnapshot().queue
  if (!queue) {
    return { queueId: 'default', revision: 0, total: 0, offset, limit, currentIndex: -1, items: [] }
  }
  const page = await coreRequest<Json>(
    rt,
    'query',
    'queue.page',
    { id: queue.id, revision: queue.revision, offset, limit },
    wire
  )
  const items = (Array.isArray(page.items) ? page.items : []).filter(isObject).map((item) => {
    const row: Json = { occurrenceId: str(item.queueEntryId), index: int(item.position, 0) }
    if (isObject(item.track)) row.track = wireTrack(rt, item.track)
    return row
  })
  const window: Json = {
    queueId: queue.id,
    revision: wireQueueRevision(rt, queue),
    total: Math.max(0, int(page.total ?? queue.total, 0)),
    offset,
    limit,
    currentIndex: int(queue.index, -1),
    items
  }
  setOpt(window, 'currentOccurrenceId', optStr(queue.occurrenceId))
  return window
}

async function searchSongs(rt: Runtime, wire: WireRequest, payload: Json): Promise<Json> {
  const query = str(payload.query).trim()
  const offset = Math.max(0, int(payload.offset, 0))
  const explicitLimit = payload.limit !== undefined && payload.limit !== null
  const limit = clampLimit(payload.limit, 1000)
  const items: Json[] = []
  let total = 0
  let revision: number | undefined
  let cursor = offset
  for (;;) {
    const page = await coreRequest<Json>(
      rt,
      'query',
      'library.tracks',
      { ...(query ? { search: query } : {}), offset: cursor, limit },
      wire
    )
    const tracks = (Array.isArray(page.tracks) ? page.tracks : []).filter(isObject)
    for (const track of tracks) items.push(wireTrack(rt, track))
    total = Math.max(0, int(page.total, 0))
    if (typeof page.revision === 'number') revision = Math.round(page.revision)
    cursor += tracks.length
    if (explicitLimit || tracks.length === 0 || cursor >= total) break
  }
  const result: Json = { query, total, items, offset }
  setOpt(result, 'revision', revision)
  return result
}

function resolveTracks(rt: Runtime, ids: unknown): TrackData[] {
  const list = Array.isArray(ids) ? ids : []
  return list.map((value) => {
    const id = str(value)
    const record = rt.host.queueStore.getTrack(id)
    if (!record) throw wireFailure('NOT_FOUND', `曲目不存在：${id}`, false)
    return record as unknown as TrackData
  })
}

function requirePlaylist(rt: Runtime, id: unknown): Playlist {
  const playlist = rt.host.getPlaylists().find((candidate) => candidate.id === str(id))
  if (!playlist) throw wireFailure('NOT_FOUND', '歌单不存在', false)
  return playlist
}

function playlistEdit(rt: Runtime, wire: WireRequest, edit: Json): Promise<Json> {
  return coreRequest<Json>(
    rt,
    'command',
    'playlists.edit',
    { revision: rt.host.playlists.getRevision(), edit },
    wire
  )
}

async function editTrackLyrics(
  rt: Runtime,
  wire: WireRequest,
  trackId: string,
  original: string,
  translation: string | null = null
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await coreRequest(
        rt,
        'command',
        'lyrics.edit',
        {
          revision: rt.host.lyrics.getRevision(),
          edit: {
            kind: 'track',
            trackId,
            patch: {
              source: 'manual',
              originalSelection: 'manual',
              original,
              ...(translation ? { translationSelection: 'manual' as const } : {}),
              translation: translation ?? null
            }
          }
        },
        wire
      )
      return
    } catch (error) {
      if (attempt === 0 && codeOf(error) === 'STALE_REVISION') continue
      throw error
    }
  }
}

function lyricsTarget(rt: Runtime, payload: Json): string {
  const trackId = optStr(payload.trackId) ?? rt.host.lyrics.content().current?.trackId
  if (!trackId) throw wireFailure('NOT_FOUND', '当前没有可匹配歌词的曲目', false)
  if (!rt.host.queueStore.getTrack(trackId)) throw wireFailure('NOT_FOUND', '曲目不存在', false)
  return trackId
}

function pickLyricsText(body: string): string {
  const text = body.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return text
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  const entry = Array.isArray(parsed) ? parsed.find(isObject) : parsed
  if (!isObject(entry)) return ''
  for (const key of ['syncedLyrics', 'plainLyrics', 'lrc']) {
    const value = entry[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

async function requestOnlineLyricsUrl(rt: Runtime, url: string): Promise<{ status: number; body: string }> {
  const response = await callPort<Json>(rt, 'network', 'request', {
    url,
    method: 'GET',
    timeoutMs: ONLINE_LYRICS_TIMEOUT_MS,
    headers: { Accept: 'application/json, text/plain;q=0.9' }
  })
  const status = int(response?.statusCode, 200)
  const body = str(response?.bodyUtf8 ?? response?.bodyText)
  if (body.length > MAX_ONLINE_LYRICS_BYTES) throw wireFailure('FAILED', '在线歌词过大', false)
  return { status, body }
}

function pickRankedSearchLyrics(
  body: string,
  query: { title: string; artist: string; album?: string; durationSeconds?: number }
): string {
  const trimmed = body.trim()
  if (!trimmed.startsWith('[')) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return ''
  }
  if (!Array.isArray(parsed)) return ''
  const hits = parsed.filter(isObject) as Parameters<typeof rankOnlineLyricsCandidates>[1]
  if (!query.artist) {
    return pickLyricsText(trimmed)
  }
  const candidates = rankOnlineLyricsCandidates(query, hits)
  return (pickOnlineLyricsText(candidates[0]) ?? '').trim()
}

async function fetchOnlineLyrics(rt: Runtime, wire: WireRequest, payload: Json): Promise<Json> {
  const trackId = lyricsTarget(rt, payload)
  const record = rt.host.queueStore.getTrack(trackId) as Json
  const customUrl = optStr(payload.url)
  let lrc = ''
  if (customUrl) {
    if (!/^https:\/\//i.test(customUrl)) {
      throw wireFailure('INVALID_REQUEST', '在线歌词地址必须使用 HTTPS', false)
    }
    const { status, body } = await requestOnlineLyricsUrl(rt, customUrl)
    if (status === 404) throw wireFailure('NOT_FOUND', '未找到在线歌词', false)
    if (status < 200 || status >= 300) {
      throw wireFailure('FAILED', `在线歌词请求失败（HTTP ${status}）`, status === 429 || status >= 500)
    }
    lrc = pickLyricsText(body)
  } else {
    const title = str(record.title).trim()
    if (!title) throw wireFailure('INVALID_REQUEST', '曲目缺少标题，无法匹配在线歌词', false)
    const artist = str(record.artist).trim()
    const album = str(record.album).trim()
    const duration = Math.round(num(record.duration, 0))
    const enc = encodeURIComponent
    let getUrl =
      `https://lrclib.net/api/get?track_name=${enc(title)}` +
      `&artist_name=${enc(artist)}&album_name=${enc(album)}`
    if (duration > 0) getUrl += `&duration=${duration}`
    const primary = await requestOnlineLyricsUrl(rt, getUrl)
    if (primary.status >= 200 && primary.status < 300) {
      lrc = pickLyricsText(primary.body)
    } else if (primary.status === 429 || primary.status >= 500) {
      throw wireFailure('FAILED', `在线歌词请求失败（HTTP ${primary.status}）`, true)
    }
    if (!lrc) {
      const searchUrl = artist
        ? `https://lrclib.net/api/search?track_name=${enc(title)}&artist_name=${enc(artist)}`
        : `https://lrclib.net/api/search?q=${enc(title)}`
      const fallback = await requestOnlineLyricsUrl(rt, searchUrl)
      if (fallback.status === 404) throw wireFailure('NOT_FOUND', '未找到在线歌词', false)
      if (fallback.status < 200 || fallback.status >= 300) {
        throw wireFailure(
          'FAILED',
          `在线歌词请求失败（HTTP ${fallback.status}）`,
          fallback.status === 429 || fallback.status >= 500
        )
      }
      lrc = pickRankedSearchLyrics(fallback.body, {
        title,
        artist,
        ...(album ? { album } : {}),
        ...(duration > 0 ? { durationSeconds: duration } : {})
      })
    }
  }
  if (!lrc) throw wireFailure('NOT_FOUND', '未找到在线歌词', false)
  await editTrackLyrics(rt, wire, trackId, `${LYRICS_ONLINE_MARKER}\n${lrc}`)
  return lyricsView(rt, trackId)
}

async function importLrc(rt: Runtime, wire: WireRequest, payload: Json): Promise<Json> {
  const trackId = lyricsTarget(rt, payload)
  const text = str(payload.lrcText ?? payload.content).trim()
  if (!text) throw wireFailure('INVALID_REQUEST', '歌词内容为空', false)
  const translation = optStr(payload.translation)?.trim() || null
  await editTrackLyrics(rt, wire, trackId, text, translation)
  return lyricsView(rt, trackId)
}

async function selectQueueIndex(rt: Runtime, wire: WireRequest, payload: Json): Promise<void> {
  const queue = requireQueue(rt)
  const index = int(payload.index, -1)
  if (index < 0 || index >= queue.total) {
    throw wireFailure('INVALID_REQUEST', `Queue index ${index} is out of range`, false)
  }
  const page = await coreRequest<Json>(
    rt,
    'query',
    'queue.page',
    { id: queue.id, revision: queue.revision, offset: index, limit: 1 },
    wire
  )
  const row = (Array.isArray(page.items) ? page.items : []).filter(isObject)[0]
  if (!row) throw wireFailure('STALE_REVISION', '队列已变化，请重新选择', true)
  const requested = optStr(payload.occurrenceId)
  if (requested && requested !== `occ-${index}` && requested !== row.queueEntryId) {
    throw wireFailure('STALE_REVISION', '队列已变化，请重新选择', true)
  }
  await coreRequest(
    rt,
    'command',
    'queue.select',
    { id: queue.id, revision: queue.revision, index, occurrenceId: row.queueEntryId },
    wire
  )
}

async function replaceQueue(rt: Runtime, payload: Json): Promise<void> {
  const tracks = Array.isArray(payload.tracks) ? payload.tracks : []
  if (tracks.length === 0) throw wireFailure('INVALID_REQUEST', 'Queue must not be empty', false)
  const store = rt.host.queueStore
  const remember: TrackData[] = []
  const records = tracks.map((raw, index) => {
    const id = isObject(raw) ? optStr(raw.id) : undefined
    if (!id) throw wireFailure('INVALID_REQUEST', `Queue track ${index} has no id`, false)
    if (store.isLibraryTrack(id)) return store.getTrack(id) as unknown as TrackData
    if (isObject(raw) && optStr(raw.source)) {
      const track = trackFromWire(raw)!
      remember.push(track)
      return track
    }
    const known = store.getTrack(id)
    if (known) return known as unknown as TrackData
    // A titled view without a source still describes a queue entry: it publishes its metadata
    // and fails only when played. A bare id must name a track the Core already knows.
    if (!isObject(raw) || !optStr(raw.title)) throw wireFailure('NOT_FOUND', `曲目不存在：${id}`, false)
    const track = trackFromWire(raw)!
    remember.push(track)
    return track
  })
  if (remember.length) store.rememberTracks(remember)
  const selectedIndex = Math.min(Math.max(0, int(payload.startIndex, 0)), records.length - 1)
  await rt.host.playback.fromPages(
    async (append) => {
      for (let offset = 0; offset < records.length; offset += LIBRARY_PAGE_SIZE) {
        await append(
          records.slice(offset, offset + LIBRARY_PAGE_SIZE).map((track) => {
            const record = {
              ...track,
              id: String(track.id),
              filePath: typeof track.filePath === 'string' ? track.filePath : ''
            }
            return { id: record.id, snapshot: record, localSnapshot: record }
          })
        )
      }
    },
    { selectedIndex, play: payload.play !== false }
  )
  await rt.host.playback.flush()
}

function syncLibrary(rt: Runtime, payload: Json): void {
  const raw = Array.isArray(payload.tracks) ? payload.tracks : []
  const tracks = raw.map((entry, index) => {
    const track = trackFromWire(entry)
    if (!track) throw wireFailure('INVALID_REQUEST', `Library track ${index} is invalid`, false)
    return track
  })
  if (payload.merge === true) {
    const merged = new Map<string, TrackData>()
    for (const track of rt.host.queueStore.getAllTracks()) {
      merged.set(track.id, track as unknown as TrackData)
    }
    for (const track of tracks) merged.set(track.id, track)
    rt.host.replaceLibraryTracks([...merged.values()])
  } else {
    rt.host.replaceLibraryTracks(tracks)
  }
}

async function toggleFavorite(rt: Runtime, wire: WireRequest, payload: Json): Promise<void> {
  const [track] = resolveTracks(rt, [payload.trackId])
  const favorite = await rt.host.playlists.isFavorite(track)
  await playlistEdit(rt, wire, { kind: 'favorite', tracks: [track], favorite: !favorite })
}

async function createPlaylist(rt: Runtime, wire: WireRequest, payload: Json): Promise<void> {
  const name = str(payload.name ?? payload.playlistName).trim()
  if (!name) throw wireFailure('INVALID_REQUEST', '歌单名称不能为空', false)
  const tracks = resolveTracks(rt, payload.trackIds)
  const created = await playlistEdit(rt, wire, { kind: 'create', name })
  const id = optStr(created?.result)
  if (id && tracks.length) await playlistEdit(rt, wire, { kind: 'add', id, tracks })
}

async function addBookmark(rt: Runtime, wire: WireRequest, payload: Json): Promise<void> {
  const state = await coreRequest<CoreBookmarksState>(rt, 'query', 'bookmarks.state', {}, wire)
  if (!state.current) throw wireFailure('NOT_FOUND', '当前没有正在播放的曲目', false)
  const trackId = optStr(payload.trackId)
  if (trackId && trackId !== state.current.trackId) {
    throw wireFailure('STALE_REVISION', '当前曲目已变化', true)
  }
  const label = optStr(payload.label)
  await coreRequest(
    rt,
    'command',
    'bookmarks.edit',
    {
      revision: state.revision,
      edit: { kind: 'addCurrent', current: state.current, ...(label ? { label } : {}) }
    },
    wire
  )
}

async function removeBookmark(rt: Runtime, wire: WireRequest, payload: Json): Promise<void> {
  const id = str(payload.bookmarkId ?? payload.id)
  if (!rt.host.getBookmarksDocument().bookmarks.some((bookmark) => bookmark.id === id)) {
    throw wireFailure('NOT_FOUND', '书签不存在', false)
  }
  await coreRequest(
    rt,
    'command',
    'bookmarks.edit',
    { revision: rt.host.bookmarks.getRevision(), edit: { kind: 'remove', id } },
    wire
  )
}

async function setEq(rt: Runtime, payload: Json): Promise<void> {
  const patch = payload as Partial<CoreEqConfigView>
  try {
    applyEqConfigPatch(rt.host.getEqConfig(), patch)
  } catch (error) {
    throw wireFailure('INVALID_REQUEST', errorMessage(error), false)
  }
  await rt.host.setEqConfig(patch)
  rt.restoreError = null
  rt.eqRevision++
  markDirty(rt)
}

async function editSettings(rt: Runtime, wire: WireRequest, payload: Json): Promise<void> {
  let patch: Json | null = isObject(payload.patch) ? payload.patch : null
  if (!patch && typeof payload.key === 'string' && payload.key) {
    try {
      patch = { [payload.key]: JSON.parse(str(payload.valueJson)) }
    } catch {
      throw wireFailure('INVALID_REQUEST', `Setting ${payload.key} has an invalid value`, false)
    }
  }
  if (!patch) throw wireFailure('INVALID_REQUEST', 'Settings patch is missing', false)
  const state = await coreRequest<Json>(rt, 'query', 'settings.state', {}, wire)
  await coreRequest(rt, 'command', 'settings.edit', { revision: state.revision, patch }, wire)
}

/** Returns the wire value; commands are answered with a fresh snapshot. */
async function execute(
  rt: Runtime,
  wire: WireRequest,
  kind: string,
  name: string,
  payload: Json
): Promise<unknown> {
  const command = (coreName: string, corePayload: unknown = {}) =>
    coreRequest(rt, 'command', coreName, corePayload, wire)
  switch (name) {
    case 'core.getSnapshot':
    case 'state.snapshot':
      return projectSnapshot(rt)
    case 'playback.getQueueWindow':
    case 'queue.page':
      return queueWindow(rt, wire, payload)
    case 'search.songs':
      return searchSongs(rt, wire, payload)
    case 'library.collections':
      return collections(rt).view
    case 'playlists.list':
      return wirePlaylists(rt.host.getPlaylists())
    case 'audio.getEq':
      return rt.host.getEqConfig()
    case 'audioDevice.getRoute': {
      const route = await callPort<Json>(rt, 'audioDevice', 'getActiveRoute')
      if (isObject(route)) rt.route = route
      return route
    }
    case 'audioDevice.listDevices':
      return callPort(rt, 'audioDevice', 'listOutputDevices')
    case 'lyrics.current':
      return lyricsView(rt, optStr(payload.trackId))
    case 'lyrics.fetchOnline': {
      const view = await fetchOnlineLyrics(rt, wire, payload)
      return kind === 'command' ? { ...view, snapshot: projectSnapshot(rt) } : view
    }
    case 'lyrics.importLrc': {
      const view = await importLrc(rt, wire, payload)
      return { ...view, snapshot: projectSnapshot(rt) }
    }
  }
  if (kind !== 'command') throw wireFailure('INVALID_REQUEST', `Unsupported request: ${name}`, false)
  switch (name) {
    case 'playback.play':
      await command(
        'playback.play',
        payload.position === undefined || payload.position === null
          ? {}
          : { position: Math.max(0, num(payload.position, 0)) }
      )
      break
    case 'playback.pause':
    case 'playback.stop':
    case 'playback.next':
    case 'playback.previous':
      await command(name)
      break
    case 'playback.seek':
      await command('playback.seek', { position: Math.max(0, num(payload.position, 0)) })
      break
    case 'playback.setVolume':
    case 'playback.volume':
      await command('playback.volume', { volume: num(payload.volume, Number.NaN) })
      break
    case 'playback.setPlayMode':
    case 'playback.mode': {
      const mode = WIRE_TO_APP_MODE[str(payload.mode)] ?? (APP_TO_WIRE_MODE[payload.mode as PlayMode] ? payload.mode : undefined)
      if (!mode) throw wireFailure('INVALID_REQUEST', `Unknown play mode: ${str(payload.mode)}`, false)
      await command('playback.mode', { mode })
      break
    }
    case 'playback.selectQueueIndex':
    case 'queue.select':
      await selectQueueIndex(rt, wire, payload)
      break
    case 'playback.replaceQueue':
      await replaceQueue(rt, payload)
      break
    case 'queue.edit':
      if (!optStr(payload.id) || typeof payload.revision !== 'number' || !isObject(payload.edit)) {
        throw wireFailure('INVALID_REQUEST', 'queue.edit requires id, revision and edit', false)
      }
      await command('queue.edit', {
        id: payload.id,
        revision: coreQueueRevision(rt, str(payload.id), payload.revision),
        edit: payload.edit
      })
      break
    case 'playback.platformInterruption':
      if (payload.shouldPause === true) {
        await rt.host.triggerPlatformSafetyBrake(str(payload.reason) || 'platform')
      }
      break
    case 'library.syncTracks':
      syncLibrary(rt, payload)
      break
    case 'playlists.toggleFavorite':
      await toggleFavorite(rt, wire, payload)
      break
    case 'playlists.create':
      await createPlaylist(rt, wire, payload)
      break
    case 'playlists.rename': {
      const playlist = requirePlaylist(rt, payload.playlistId)
      const nextName = str(payload.name ?? payload.newName).trim()
      if (!nextName) throw wireFailure('INVALID_REQUEST', '歌单名称不能为空', false)
      await playlistEdit(rt, wire, { kind: 'rename', id: playlist.id, name: nextName })
      break
    }
    case 'playlists.delete':
      await playlistEdit(rt, wire, { kind: 'delete', id: requirePlaylist(rt, payload.playlistId).id })
      break
    case 'playlists.addTracks': {
      const playlist = requirePlaylist(rt, payload.playlistId)
      const tracks = resolveTracks(rt, payload.trackIds)
      if (tracks.length) await playlistEdit(rt, wire, { kind: 'add', id: playlist.id, tracks })
      break
    }
    case 'playlists.removeTrack': {
      const playlist = requirePlaylist(rt, payload.playlistId)
      await playlistEdit(rt, wire, { kind: 'remove', id: playlist.id, ids: [str(payload.trackId)] })
      break
    }
    case 'bookmarks.add':
      await addBookmark(rt, wire, payload)
      break
    case 'bookmarks.remove':
      await removeBookmark(rt, wire, payload)
      break
    case 'audio.setEq':
      await setEq(rt, payload)
      break
    case 'settings.edit':
      await editSettings(rt, wire, payload)
      break
    default:
      throw wireFailure('INVALID_REQUEST', `Unsupported request: ${name}`, false)
  }
  markDirty(rt)
  return { snapshot: projectSnapshot(rt) }
}

function respond(
  rt: Runtime | null,
  wire: WireRequest,
  result: { ok: true; value: unknown } | { ok: false; error: WireError }
): void {
  if (wire.responded) return
  wire.responded = true
  rt?.wire.delete(wire.requestId)
  const response: Json = {
    kind: 'response',
    requestId: wire.requestId,
    epoch: rt?.epoch ?? '',
    ok: result.ok
  }
  if (result.ok) {
    if (result.value !== undefined) response.value = result.value
  } else {
    response.error = result.error
  }
  push(rt, { type: 'response', response })
}

// ============================================================================
// Public entry points
// ============================================================================

function retire(rt: Runtime, reason = 'Core host was restarted', shutDownHost = true): void {
  if (rt.retired) return
  for (const wire of [...rt.wire.values()]) {
    respond(rt, wire, {
      ok: false,
      error: { code: 'CANCELLED', message: reason, retryable: true }
    })
  }
  rt.retired = true
  rejectAll(rt.ports, reason)
  rejectAll(rt.coreRequests, reason)
  rt.audioListeners.clear()
  rt.unsubscribe()
  if (shutDownHost) void rt.host.shutdown().catch(() => {})
}

/**
 * Stops the Core for good. Unlike a reboot, the ports stay up until the Core has settled its work
 * and saved the session through `sessionStore`; `{type:'shutdown', ok, error?}` then reports the
 * outcome and the runtime retires.
 */
function shutdownHost(): string {
  const rt = current
  if (!rt || rt.retired) return out({ accepted: false })
  if (!rt.shuttingDown) {
    rt.shuttingDown = true
    const finish = (error?: unknown) => {
      if (rt.retired) return
      push(
        rt,
        error === undefined
          ? { type: 'shutdown', ok: true }
          : { type: 'shutdown', ok: false, error: errorMessage(error) || 'Core shutdown failed' }
      )
      retire(rt, 'Core host was shut down', false)
      if (current === rt) current = null
    }
    rt.host.shutdown().then(
      () => finish(),
      (error: unknown) => finish(error ?? 'Core shutdown failed')
    )
  }
  return out({ accepted: true })
}

function bootHost(input?: unknown): string {
  let config: Json
  try {
    config = parseInput(input)
  } catch (error) {
    return out({ ok: false, error: errorMessage(error) })
  }
  if (current) retire(current)
  const generation = ++generationCounter
  const epoch = optStr(config.epoch) ?? `android-epoch-${crypto.randomUUID().slice(0, 8)}`
  const rt = { generation, epoch } as Runtime
  Object.assign(rt, {
    retired: false,
    shuttingDown: false,
    booted: false,
    bootError: null,
    raw: null,
    route: null,
    restoreError: null,
    lastAuthFailure: null,
    ports: new Map(),
    nextCallId: 0,
    coreRequests: new Map(),
    nextCoreId: 0,
    wire: new Map(),
    seen: new Set(),
    audioListeners: new Set(),
    queueGeneration: 0,
    queueGenerations: [],
    queueRevision: { key: '', wire: 0 },
    eqRevision: 1,
    dirty: true,
    collections: null,
    lyrics: null,
    unsubscribe: () => {}
  })
  try {
    rt.host = createPortableMusicCoreHost({
      epoch,
      platform: 'android',
      sessionStore: createSessionStore(rt),
      audioEngine: createAudioEngine(rt),
      resourceAccess: createResourceAccess(rt),
      initialSettings: {
        // First-boot defaults; stored settings win. A phone reopens where the listener paused and
        // starts at unity volume, as the Android host always has.
        playbackResumeMode: 'trackAndPosition',
        softwareVolume: 1,
        ...(isObject(config.initialSettings) ? (config.initialSettings as Partial<AppSettings>) : {})
      },
      onFatalError: (error) => log('error', `Core: ${errorMessage(error)}`)
    })
  } catch (error) {
    rt.retired = true
    return out({ ok: false, error: errorMessage(error) })
  }
  rt.unsubscribe = rt.host.subscribeMessages((message) => {
    if (rt.retired) return
    const m = message as unknown as Json
    if (m.kind === 'response') {
      const id = str(m.requestId)
      const pending = rt.coreRequests.get(id)
      if (!pending) return
      rt.coreRequests.delete(id)
      if (m.ok === true) {
        pending.resolve(m.value)
      } else {
        const error = isObject(m.error) ? m.error : {}
        pending.reject(
          wireFailure(str(error.code) || 'FAILED', str(error.message) || 'Core request failed')
        )
      }
    } else if (m.kind === 'state') {
      markDirty(rt)
    }
  })
  current = rt
  void (async () => {
    try {
      await rt.host.initialize()
      try {
        const raw = await callPort<Json>(rt, 'audioEngine', 'getSnapshot')
        if (isObject(raw)) rt.raw = raw
      } catch (error) {
        log('warn', `Initial audio snapshot failed: ${errorMessage(error)}`)
      }
      try {
        const route = await callPort<Json>(rt, 'audioDevice', 'getActiveRoute')
        if (isObject(route)) rt.route = route
      } catch (error) {
        log('warn', `Initial audio route failed: ${errorMessage(error)}`)
      }
      try {
        await callPort(rt, 'audioEngine', 'setDspConfig', {
          configJson: JSON.stringify(rt.host.getEqConfig())
        })
      } catch (error) {
        rt.restoreError = errorMessage(error) || 'Audio settings restore failed'
      }
      if (rt.retired) return
      rt.booted = true
      markDirty(rt)
      push(rt, { type: 'boot', ok: true, epoch })
    } catch (error) {
      if (rt.retired) return
      rt.bootError = errorMessage(error) || 'Core boot failed'
      markDirty(rt)
      push(rt, { type: 'boot', ok: false, epoch, error: rt.bootError })
    }
  })()
  return out({ ok: true, epoch, protocolVersion: CORE_PROTOCOL_VERSION, hostApiVersion: HOST_API_VERSION })
}

function handleRequest(input: unknown): string {
  let envelope: Json
  try {
    envelope = parseInput(input)
  } catch (error) {
    return out({ accepted: false, error: errorMessage(error) })
  }
  const requestId = optStr(envelope.requestId)
  if (!requestId || requestId.length > 128) {
    return out({ accepted: false, error: 'Request is missing a valid requestId' })
  }
  const rt = current
  if (rt?.wire.has(requestId)) {
    return out({ accepted: false, error: `Request ${requestId} is already in flight` })
  }
  const wire: WireRequest = { requestId, cancelled: false, responded: false, coreRequestId: null }
  const fail = (code: string, message: string, retryable?: boolean) => {
    respond(rt, wire, {
      ok: false,
      error: { code, message, retryable: retryable ?? RETRYABLE_CODES.has(code) }
    })
    return out({ accepted: true })
  }
  if (!rt) return fail('NOT_READY', 'Core host is not booted')
  if (rt.shuttingDown) return fail('CANCELLED', 'Core host is shutting down', false)
  const kind = str(envelope.kind)
  const name = str(envelope.name)
  const payload = isObject(envelope.payload) ? envelope.payload : {}
  if (kind !== 'query' && kind !== 'command') {
    return fail('INVALID_REQUEST', `Unknown request kind: ${kind}`)
  }
  if (typeof envelope.protocolVersion === 'number' && envelope.protocolVersion > CORE_PROTOCOL_VERSION) {
    return fail('INVALID_REQUEST', `Unsupported protocol version ${envelope.protocolVersion}`)
  }
  if (!SNAPSHOT_QUERIES.has(name) && envelope.epoch !== rt.epoch) {
    return fail('STALE_EPOCH', 'Core epoch changed; refresh the snapshot')
  }
  if (!rt.booted && !SNAPSHOT_QUERIES.has(name)) {
    return fail('NOT_READY', rt.bootError ?? 'Core is starting')
  }
  if (rt.wire.size >= MAX_IN_FLIGHT) return fail('BUSY', 'Too many Core requests in flight')
  if (kind === 'command') {
    const key = optStr(envelope.commandId) ?? requestId
    if (rt.seen.has(key)) return fail('OUTCOME_UNKNOWN', 'Command was already submitted', false)
    rt.seen.add(key)
    if (rt.seen.size > SEEN_LIMIT) rt.seen.delete(rt.seen.values().next().value as string)
  }
  if (QUEUE_GUARDED.has(name) && envelope.expectedRevision !== undefined && envelope.expectedRevision !== null) {
    const authoritative = wireQueueRevision(rt, rt.host.getSnapshot().queue)
    if (envelope.expectedRevision !== authoritative) {
      return fail(
        'STALE_REVISION',
        `Expected queue revision ${String(envelope.expectedRevision)}, but authoritative revision is ${String(authoritative)}`,
        true
      )
    }
  }
  rt.wire.set(requestId, wire)
  void execute(rt, wire, kind, name, payload).then(
    (value) => {
      if (wire.cancelled) return
      respond(rt, wire, { ok: true, value })
    },
    (error) => {
      respond(rt, wire, { ok: false, error: toWireError(rt, error, wire) })
    }
  )
  return out({ accepted: true })
}

function cancelRequest(input: unknown): string {
  let payload: Json
  try {
    payload = parseInput(input)
  } catch (error) {
    return out({ accepted: false, error: errorMessage(error) })
  }
  const rt = current
  const wire = rt?.wire.get(str(payload.requestId))
  if (!rt || !wire) return out({ accepted: false })
  wire.cancelled = true
  if (wire.coreRequestId) {
    rt.host.dispatchRequest({ kind: 'cancel', requestId: wire.coreRequestId, epoch: rt.host.epoch })
  }
  respond(rt, wire, {
    ok: false,
    error: { code: 'CANCELLED', message: 'Request cancelled', retryable: false }
  })
  return out({ accepted: true })
}

function completePortCall(input: unknown, maybeResult?: unknown): string {
  let message: Json
  try {
    message =
      maybeResult === undefined
        ? parseInput(input)
        : { ...parseInput(maybeResult), callId: str(input) }
  } catch (error) {
    return out({ accepted: false, error: errorMessage(error) })
  }
  const rt = current
  const callId = str(message.callId)
  const pending = rt?.ports.get(callId)
  if (!rt || !pending) return out({ accepted: false })
  rt.ports.delete(callId)
  if (message.ok === true) {
    pending.resolve(message.value ?? null)
  } else {
    const error = isObject(message.error) ? message.error : {}
    pending.reject(
      wireFailure(
        str(error.code) || 'FAILED',
        str(error.message) || 'Platform port call failed',
        typeof error.retryable === 'boolean' ? error.retryable : undefined
      )
    )
  }
  return out({ accepted: true })
}

function onAudioEngineEvent(input: unknown): string {
  let event: Json
  try {
    event = parseInput(input)
  } catch (error) {
    return out({ accepted: false, error: errorMessage(error) })
  }
  const rt = current
  if (!rt || rt.retired) return out({ accepted: false })
  switch (event.type) {
    case 'snapshot': {
      if (!isObject(event.snapshot)) return out({ accepted: false })
      const previousDevice = rt.raw?.actualDeviceId
      rt.raw = event.snapshot
      emitAudio(rt, { type: 'playback-info', info: toPlaybackInfo(rt, event.snapshot) })
      if (event.snapshot.actualDeviceId !== previousDevice) refreshRoute(rt)
      break
    }
    case 'track-ended': {
      const reason = optStr(event.reason)
      void callPort<Json>(rt, 'audioEngine', 'getSnapshot')
        .then((raw) => {
          if (!isObject(raw) || rt.retired) return
          rt.raw = raw
          emitAudio(rt, { type: 'playback-info', info: toPlaybackInfo(rt, raw) })
          emitAudio(rt, { type: 'end-file', ...(reason ? { reason } : {}) })
          markDirty(rt)
        })
        .catch((error) => log('error', `Track end handling failed: ${errorMessage(error)}`))
      break
    }
    case 'error':
      emitAudio(rt, {
        type: 'error',
        message: str(event.message) || 'Audio engine error',
        ...(optStr(event.code) ? { code: str(event.code) } : {}),
        recoverable: event.recoverable === true
      })
      break
    case 'route':
      if (isObject(event.route)) rt.route = event.route
      break
    default:
      return out({ accepted: false })
  }
  markDirty(rt)
  return out({ accepted: true })
}

interface HostEventLoop {
  runMicrotasks(): void
  runDueTimers(now: number): number
  nextTimerDelay(now: number): number
  pendingMicrotasks(): number
  takeErrors(): unknown[]
  takeLogs(): Array<{ level?: string; message?: string }>
}

function drain(): string {
  const loop = (globalThis as { __TWILIGHT_EVENT_LOOP__?: HostEventLoop }).__TWILIGHT_EVENT_LOOP__
  if (loop) {
    try {
      for (let pass = 0; pass < DRAIN_PASSES; pass++) {
        loop.runMicrotasks()
        const ran = loop.runDueTimers(Date.now())
        if (ran === 0 && loop.pendingMicrotasks() === 0) break
      }
    } catch (error) {
      log('error', `Core event loop failed: ${errorMessage(error)}`)
    }
    for (const error of loop.takeErrors()) log('error', errorMessage(error))
    for (const entry of loop.takeLogs()) {
      const level = entry?.level
      log(
        level === 'debug' || level === 'info' || level === 'warn' || level === 'error' ? level : 'info',
        str(entry?.message)
      )
    }
  }
  const rt = current
  if (rt && !rt.retired && rt.dirty) {
    rt.dirty = false
    try {
      const snapshot = projectSnapshot(rt)
      outbox.push({
        type: 'event',
        event: { kind: 'state', epoch: rt.epoch, sequence: snapshot.sequence, snapshot }
      })
    } catch (error) {
      log('error', `Snapshot projection failed: ${errorMessage(error)}`)
    }
  }
  let nextTimerDelayMs: number | null = null
  if (loop) {
    const delay = loop.nextTimerDelay(Date.now())
    nextTimerDelayMs = delay >= 0 ? delay : null
  }
  return out({ messages: outbox.splice(0), nextTimerDelayMs })
}

// ============================================================================
// Embedded LRC parsing (wire lyrics view)
// ============================================================================

interface EmbeddedLyricLine {
  timeMs: number
  text: string
  translation?: string | null
}

function parseEmbeddedLrcLines(rawText: string): { synced: boolean; lines: EmbeddedLyricLine[] } {
  const rawLines = String(rawText || '').replace(/\r\n/g, '\n').split('\n')
  const timedMap = new Map<number, EmbeddedLyricLine>()
  const untimed: EmbeddedLyricLine[] = []
  const timeRegex = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g
  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    const matches = [...trimmed.matchAll(timeRegex)]
    if (matches.length === 0) {
      if (!/^\[(ti|ar|al|by|offset):/i.test(trimmed)) {
        untimed.push({ timeMs: untimed.length * 4000, text: trimmed, translation: null })
      }
      continue
    }
    const textContent = trimmed.replace(timeRegex, '').trim()
    if (!textContent) continue
    for (const match of matches) {
      const minutes = Number(match[1] || 0)
      const seconds = Number(match[2] || 0)
      const fracRaw = match[3] || '0'
      const millis = fracRaw.length === 1 ? Number(fracRaw) * 100 : fracRaw.length === 2 ? Number(fracRaw) * 10 : Number(fracRaw.slice(0, 3))
      const timeMs = minutes * 60_000 + seconds * 1000 + millis
      const existing = timedMap.get(timeMs)
      if (existing) { if (!existing.translation) existing.translation = textContent }
      else timedMap.set(timeMs, { timeMs, text: textContent, translation: null })
    }
  }
  if (timedMap.size > 0) return { synced: true, lines: [...timedMap.values()].sort((a, b) => a.timeMs - b.timeMs) }
  return { synced: false, lines: untimed }
}

// ============================================================================
// Global registration
// ============================================================================

export const portableEmbeddedHost = {
  CORE_PROTOCOL_VERSION,
  HOST_API_VERSION,
  PORTABLE_EQ_PRESETS,
  createPortableMusicCoreHost,
  ensurePortableRuntimeGlobals,
  aggregateLibraryCollections,
  applyEqConfigPatch,
  createDefaultEqConfig,
  parseEmbeddedLrcLines,
  bootHost,
  shutdownHost,
  handleRequest,
  cancelRequest,
  completePortCall,
  onAudioEngineEvent,
  drain
}

;(globalThis as { __TWILIGHT_PORTABLE_CORE__?: unknown }).__TWILIGHT_PORTABLE_CORE__ =
  portableEmbeddedHost
