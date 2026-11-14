import type {
  LocalLibraryExclusion,
  LocalLibraryRemovalMode,
  LocalLibraryTrackSelection,
  LocalLibraryMutationFailure
} from './localLibrary.ts'
import type {
  LocalLibraryFileIdentity,
  LocalLibraryScanMode,
  LocalLibraryScanUpdate
} from './localLibraryScan.ts'
import type { CueDefinition } from './cue.ts'
import type { RecordingIdentity, RecordingVersion } from './recordingIdentity.ts'
import type { PlayMode } from './audioEngineTypes.ts'

export const LIBRARY_PAGE_SIZE = 200
export const LIBRARY_MAX_PAGE_SIZE = 1_000
export const LIBRARY_CACHE_PAGES = 4
export const LIBRARY_MAX_PENDING_PAGE_READS = 10
export type LibraryTrackRecord = Record<string, unknown> & { id: string; filePath: string }
export type LibrarySort =
  | 'title'
  | 'artist'
  | 'album'
  | 'format'
  | 'trackNumber'
  | 'duration'
  | 'sampleRate'
  | 'addedAt'
  /** Newest addedAt first; ties use reverse insertion order (homepage activity). */
  | 'recentlyAdded'
  | 'lastPlayed'
  | 'playlist'
  /** Physical insertion order, including descending tail reads. Unlike playlist,
   * direction is honored and ids do not define occurrence order. */
  | 'insertion'
  | 'unifiedSearch'
export interface LibraryQuery {
  /** Freeze against a previously displayed content version, e.g. search playback. */
  contentRevision?: number
  /** Immutable, worker-owned membership snapshot of a configured playlist.
   * Local metadata remains authoritative in tracks; remote members keep compact snapshots. */
  playlistView?: string
  /** Original membership occurrence in playlistView, for anchor/queue selection.
   * Track IDs alone cannot distinguish two entries resolving to the same track. */
  playlistEntryId?: string
  /** Recording rows over a preserveSources playlist view. Search intentionally
   * retains the aggregate page's raw title/artist/album substring semantics. */
  aggregate?: {
    hiddenSources?: string[]
    variantPreferences?: Record<string, string>
    /** Read variants of a displayed recording, instead of recording rows. */
    variantRow?: string
    /** Paginated original source counts, including zero-count hidden sources. */
    sourceCounts?: boolean
  }
  /** Locate a member in this complete query order and return its containing page. */
  anchorId?: string
  search?: string
  /** Literal, case-insensitive per-field substring matching (LAN remote).
   * Keep punctuation/whitespace; do not add pinyin or filename matches. */
  searchLiteral?: boolean
  searchFileName?: boolean
  folder?: string
  recursive?: boolean
  artist?: string
  albumId?: string
  genre?: string
  genreSeparators?: string
  /** Select whole collections with any member in this genre; never trim their members. */
  collectionGenre?: string
  /** Facet suggestions match collection labels, not their member metadata. */
  collectionNamesOnly?: boolean
  /** Streaming catalog search keeps its existing label matching and zh order:
   * album terms may match name/artist/initials; artists match only their name. */
  collectionSearchMode?: 'albumTerms' | 'artistName'
  /** Dashboard shelves rank by size or retain legacy non-numeric zh label order. */
  collectionSort?: 'trackCount' | 'label'
  /** Return only the complete collection count, with no items or letter index. */
  collectionCountOnly?: boolean
  /** Lightweight configured playlist order, not track membership. Catalog
   * definitions stay unchanged when the user reorders cards. */
  collectionOrder?: string[]
  ids?: string[]
  sort?: LibrarySort
  direction?: 'asc' | 'desc'
  /** Fence a last-played query against the renderer's confirmed history projection. */
  historyRevision?: number
  /** Existing version preferences only (20k / 8 MiB config bound), not all library IDs.
   * Used by unifiedSearch ordering before pagination. */
  preferredSources?: string[]
  filters?: {
    lossless?: boolean
    dsd?: boolean
    sampleRate?: number
    bitDepth?: number
    folder?: string
    provider?: string
  }
  offset?: number
  limit?: number
}
export interface LibraryPage {
  /** Parallel to tracks; derived references never enter source tags or snapshots. */
  catalog?: { revision: number; tracks: Array<import('./musicCatalog.ts').CatalogTrackReferences | null> }
  aggregate?: {
    /** Parallel to tracks for recording-row queries; variants use entryIds. */
    rows: Array<{
      rowId: string
      anchorTrackId: string
      variantCount: number
      visibleVariantCount: number
      variantPinned: boolean
      preferenceUnavailable: boolean
    }>
    /** Unsearched visible recording rows and original resolved occurrences. */
    rowCount: number
    memberCount: number
    sources?: Array<{ source: string; count: number; hidden: boolean }>
  }
  /** Parallel to tracks for playlist views; stable across sorting and filtering. */
  entryIds?: string[]
  /** Absolute index of anchorId; -1 means it is outside the query. */
  anchorIndex?: number
  tracks: LibraryTrackRecord[]
  versions: Record<string, number>
  total: number
  revision: number
  offset: number
  /** Duration of the complete track query, not just this page. */
  totalDuration?: number
  historyRevision?: number
}
export type LibraryCollectionKind = 'albums' | 'artists' | 'genres' | 'folders' | 'playlists'
export interface LibraryPlaylistSourceSummary {
  total: number
  local: number
  provider: number
  providers: Array<{ source: string; count: number }>
  /** Labels are bounded; counts still include every provider. */
  additionalProviders?: number
}
export interface LibraryCollectionSummary {
  /** Bounded preview; catalog.query(context) provides the complete paginated set. */
  catalog?: import('./musicCatalog.ts').CatalogReferences
  id: string
  name: string
  trackCount: number
  duration: number
  cover: string | null
  coverSource?: string | null
  releaseDate?: string
  /** Confirmed-release display fallback; never a replacement for the file's date. */
  metadataReleaseDate?: {
    value: string
    attribution: import('./entityMetadata.ts').MetadataAttribution
    usage?: import('./musicMetadata.ts').MetadataUsage
  }
  genre?: string | null
  path?: string
  artist?: string
  addedAt?: number
  isDefault?: boolean
  sourceSummary?: LibraryPlaylistSourceSummary
}
export interface LibraryCollectionPage {
  items: LibraryCollectionSummary[]
  total: number
  revision: number
  offset: number
  /** First absolute position of each A-Z initial in this complete query order. */
  letterOffsets: Record<string, number>
}
export interface LibraryMetadata {
  revision: number
  trackCount: number
  fileCount: number
  folders: string[]
  exclusions: LocalLibraryExclusion[]
}
export interface LibraryTrackPatch {
  id: string
  expectedVersion: number
  patch: Record<string, unknown>
}
export interface LibraryPathLookup {
  /** One exact/unique match per input, including repeated paths and missing entries. */
  ids: Array<string | null>
  revision: number
}
export interface LibraryPlaylistLookupRequest {
  entries: Array<{ id: string; snapshot?: RecordingIdentity; sourceIds?: string[] }>
  versions: RecordingVersion[]
  preserveSources?: boolean
  /** Recent history resolves known source IDs to the preferred recording group,
   * instead of the playlist's exact-ID-first and snapshot-compatibility rules. */
  resolution?: 'recent'
}
export type LibraryPlaylistViewSync =
  | {
      kind: 'begin'
      id: string
      versions: RecordingVersion[]
      preserveSources?: boolean
      catalog?: boolean
    }
  | {
      kind: 'groups'
      id: string
      sequence: number
      groups: Array<{ id: string; name: string; cover?: string | null; isDefault?: boolean }>
    }
  | {
      kind: 'append'
      id: string
      sequence: number
      entries: Array<{ id: string; snapshot?: LibraryTrackRecord; collectionId?: string }>
    }
  | { kind: 'commit'; id: string; sequence: number }
  | { kind: 'drop'; id: string }
export interface LibraryPlaylistViewSyncResult {
  id: string
  sequence: number
  count: number
  committed: boolean
}
export type LibraryHistorySyncRequest =
  | { kind: 'begin'; id: string; mode: 'replace' | 'patch'; expectedRevision?: number }
  | {
      kind: 'append'
      id: string
      sequence: number
      entries: Array<{ id: string; lastPlayed: number }>
    }
  | { kind: 'commit'; id: string; sequence: number }
export interface LibraryHistorySyncResult {
  id: string
  sequence: number
  /** Separate from the library/content revision: listening never invalidates scans. */
  revision: number
  committed: boolean
}
/** Application-owner mutations, not direct capabilities of the SQL worker. */
export interface LibraryFileMutationApi {
  /** Incremental, explicit check; only imports restore exclusions in the selected scope. */
  scanDirectories(request: LibraryDirectoryScanRequest): Promise<LocalLibraryScanUpdate>
  removeFiles(request: {
    mode: LocalLibraryRemovalMode
    items: LocalLibraryTrackSelection[]
  }): Promise<{
    mode: LocalLibraryRemovalMode
    metadata: LibraryMetadata
    removedTrackIds: string[]
    removedFilePaths: string[]
    failures: LocalLibraryMutationFailure[]
  }>
}
export interface LibraryDirectoryScanRequest {
  directories: string[]
  reason: 'import' | 'tags'
}
/** Main-process-only preparation, committed atomically with the durable job. */
export type LibraryScanStartRequest = Pick<LibraryScanJob, 'id' | 'mode' | 'roots'> & {
  restoreExcluded?: boolean
}
export type LibraryScanDependency = LocalLibraryFileIdentity & { kind?: 'directory' }
export interface LibraryScanCommit {
  jobId: string
  /** Monotonic, starting at 1. A repeated sequence is an acknowledged replay. */
  sequence: number
  files: Array<{
    identity: LocalLibraryFileIdentity
    tracks: LibraryTrackRecord[]
    metadataRead: boolean
    error?: string
    dependencies?: LibraryScanDependency[]
    audioMetadata?: LibraryTrackRecord
    metadataReused?: boolean
    /** Narrow legacy-date read; never replaces logical tracks. Published only at successful finish. */
    releaseDateOnly?: true
    /** Raw observations from the same upgrade read; no display-field replacement. */
    observations?: import('./localLibraryObservations.ts').LocalLibraryTagObservations
    /** An absent value on a successful date-only read clears an obsolete date. */
    releaseDate?: string
  }>
}
export interface LibraryScanJob {
  id: string
  mode: LocalLibraryScanMode
  roots: string[]
  state: 'running' | 'paused' | 'cancelled' | 'interrupted' | 'completed' | 'failed'
  committedFiles: number
  failedFiles: number
}
export interface LibraryScanDirectoryResult {
  path: string
  children: string[]
  complete?: boolean
  error?: string
}
export interface LibraryScanWorkPage {
  identities: LocalLibraryFileIdentity[]
  /** Subset of identities requiring only the legacy release-date backfill. */
  releaseDateFilePaths?: string[]
  lastBatch: number
  state: LibraryScanJob['state']
}
export interface LibraryScanDirectoryPage {
  directories: string[]
  state: LibraryScanJob['state']
}
export interface LibraryScanFinishResult {
  completed: boolean
  metadata: LibraryMetadata
  removedFileCount: number
}
export interface LibraryScanProgressSnapshot {
  jobId: string
  state: LibraryScanJob['state']
  checkedFiles: number
  /** Metadata attempts acknowledged in committed batches, including failures. */
  parsedFiles: number
  committedFiles: number
  failedFiles: number
  trackCount: number
  revision: number
}

/** Restricted bridge used by the scan process; no arbitrary SQL or library replacement. */
export interface LibraryScanDatabaseApi {
  getScanAudioMetadata(
    id: string,
    identities: LocalLibraryFileIdentity[]
  ): Promise<Record<string, LibraryTrackRecord>>
  getScanCueDefinition(
    id: string,
    identity: LocalLibraryFileIdentity
  ): Promise<LibraryCueDefinitionRecord | null>
  putScanCueDefinition(id: string, record: LibraryCueDefinitionRecord): Promise<void>
  claimScanDirectories(id: string, limit?: number): Promise<LibraryScanDirectoryPage>
  recordScanDirectory(id: string, result: LibraryScanDirectoryResult): Promise<void>
  recordScanFiles(id: string, identities: LocalLibraryFileIdentity[]): Promise<void>
  claimScanFiles(id: string, limit?: number): Promise<LibraryScanWorkPage>
  commitScanBatch(batch: LibraryScanCommit): Promise<LibraryMetadata>
  getScanProgress(id: string): Promise<LibraryScanProgressSnapshot>
  finishScan(id: string): Promise<LibraryScanFinishResult>
}
export const LIBRARY_SCAN_DATABASE_METHODS: readonly (keyof LibraryScanDatabaseApi)[] = [
  'getScanAudioMetadata',
  'getScanCueDefinition',
  'putScanCueDefinition',
  'claimScanDirectories',
  'recordScanDirectory',
  'recordScanFiles',
  'claimScanFiles',
  'commitScanBatch',
  'getScanProgress',
  'finishScan'
]
export interface LibraryCueDefinitionRecord {
  identity: LocalLibraryFileIdentity
  parserVersion: 1
  audioPath?: string
  definition?: CueDefinition
  error?: string
}
export type LibraryScanDatabaseCall = {
  [M in keyof LibraryScanDatabaseApi]: { method: M; args: Parameters<LibraryScanDatabaseApi[M]> }
}[keyof LibraryScanDatabaseApi]
export interface LibraryDatabaseScanResult {
  cancelled: boolean
  progress: LibraryScanProgressSnapshot
  removedFileCount: number
}
export interface LibraryQueueSnapshot {
  canUndo?: boolean
  undoLabel?: string | null
  id: string
  total: number
  index: number
  revision: number
  selectedEntryId: string | null
  order: 'original' | 'shuffle'
  /** Durable logical mode, committed with its order/cursor. Absent on legacy
   * queues until a player binds a mode; native window modes are never stored. */
  playMode?: LibraryQueuePlayMode
}
export type LibraryQueuePlayMode = Exclude<PlayMode, 'heart'>

/** Resume never rewrites a committed SQL order from an older session/settings.
 * Legacy queues have no mode: their order still decides whether to shuffle. */
export function libraryQueueResumeMode(
  queue: LibraryQueueSnapshot,
  fallback: PlayMode
): LibraryQueuePlayMode {
  return (
    queue.playMode ??
    (queue.order === 'shuffle'
      ? 'shuffle'
      : fallback === 'shuffle' || fallback === 'heart'
        ? 'sequential'
        : fallback)
  )
}
export interface LibraryQueuePage {
  items: Array<{
    queueEntryId: string
    position: number
    track: LibraryTrackRecord | null
    logicalQueueEnd?: boolean
  }>
  /** Last playable occurrence; frozen rows can outlive removed local tracks. */
  lastPlayablePosition?: number
  total: number
  revision: number
  libraryRevision: number
  offset: number
}

export interface LibraryQueueReadOptions {
  /** Exact indexed occurrence lookup; positions in the response remain absolute. */
  occurrenceId?: string
  /** Reject an outdated displayed occurrence order before reading. */
  expectedRevision?: number
  /** Literal metadata substring; nonempty searches count/page matching
   * occurrences while items retain their absolute queue positions. */
  search?: string
}

export interface LibraryQueuePlaybackWindow {
  queue: LibraryQueueSnapshot
  libraryRevision: number
  lastPlayablePosition?: number
  /** Absolute positions and occurrence IDs; never a global Track[] replacement. */
  items: LibraryQueuePage['items']
}

export interface LibraryQueueInsertItem {
  id: string
  /** Required for non-local entries; local entries resolve from tracks. */
  snapshot?: LibraryTrackRecord
}

/** Queue rows are addressed by occurrence, never by the possibly repeated track ID. */
export type LibraryQueueEdit =
  | { kind: 'undo' }
  | { kind: 'select'; entryId: string }
  | { kind: 'step'; direction: 1 | -1; wrap: boolean }
  | {
      kind: 'insert'
      /** Compatibility form for local-only callers. */
      trackIds?: string[]
      /** Mixed local/remote insertions. Each remote item carries a compact snapshot. */
      items?: LibraryQueueInsertItem[]
      afterEntryId?: string
      beforeEntryId?: string
    }
  | { kind: 'remove'; entryIds: string[] }
  | { kind: 'move'; entryId: string; beforeEntryId: string | null }
  | { kind: 'order'; order: 'original' | 'shuffle' }
  /** Atomically persist logical playback mode and the corresponding order. */
  | { kind: 'mode'; mode: LibraryQueuePlayMode }
  | { kind: 'clear' }
export interface LibraryQueueEditResult {
  queue: LibraryQueueSnapshot
  reachedEnd: boolean
}

export interface LibraryDatabaseApi {
  /** Derived membership only; never replaces the existing playlist persistence owner. */
  syncPlaylistView(request: LibraryPlaylistViewSync): Promise<LibraryPlaylistViewSyncResult>
  /** Exact IDs first, then the established local recording/version fallback.
   * Returns only local IDs; null leaves the caller's remote snapshot intact. */
  lookupPlaylistTracks(
    request: LibraryPlaylistLookupRequest,
    expectedRevision?: number
  ): Promise<LibraryPathLookup>
  lookupTracksByPaths(paths: string[], expectedRevision?: number): Promise<LibraryPathLookup>
  syncListeningHistory(request: LibraryHistorySyncRequest): Promise<LibraryHistorySyncResult>
  getMetadata(): Promise<LibraryMetadata>
  queryTracks(query?: LibraryQuery): Promise<LibraryPage>
  queryCollections(
    kind: LibraryCollectionKind,
    query?: LibraryQuery,
    metadata?: import('./entityMetadata.ts').EntityMetadataReadOptions
  ): Promise<LibraryCollectionPage>
  getTracksByIds(ids: string[], expectedRevision?: number): Promise<LibraryPage>
  patchTracks(patches: LibraryTrackPatch[]): Promise<LibraryPage>
  createLibraryQueue(query: LibraryQuery, selectedId?: string): Promise<LibraryQueueSnapshot>
  readLibraryQueue(
    id: string,
    offset?: number,
    limit?: number,
    options?: LibraryQueueReadOptions
  ): Promise<LibraryQueuePage>
  getLibraryQueue(id: string): Promise<LibraryQueueSnapshot>
  editLibraryQueue(
    id: string,
    expectedRevision: number,
    edit: LibraryQueueEdit
  ): Promise<LibraryQueueEditResult>
  deleteLibraryQueue(id: string, expectedRevision: number): Promise<void>
  syncLibraryQueueReferences(owner: string, ids: string[]): Promise<void>
  collectLibraryQueueGarbage(olderThanMs?: number): Promise<number>
}
