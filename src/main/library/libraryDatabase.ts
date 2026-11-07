import type { MusicExplorationDatabaseApi } from '../../shared/musicExploration.ts'
import { LibraryDatabaseExploration, EXPLORATION_SCHEMA_SQL, EXPLORATION_SCHEMA_OBJECTS } from './libraryDatabaseExploration.ts'
import { LibraryDatabaseIdentificationSchedule, IDENTIFICATION_SCHEDULE_SCHEMA_SQL } from './libraryDatabaseIdentificationSchedule.ts'
import type { LibraryPlaybackQueueReference } from '../../shared/playbackSession.ts'
import { LibraryDatabaseEntityMetadata, ENTITY_METADATA_SCHEMA_SQL, ENTITY_METADATA_DETAILS_SCHEMA_SQL, ENTITY_METADATA_PERSONAL_SCHEMA_SQL } from './libraryDatabaseEntityMetadata.ts'
import { LibraryDatabaseLegacyMusic, LEGACY_MUSIC_METADATA_SCHEMA_SQL } from './libraryDatabaseLegacyMusic.ts'
import { LEGACY_MUSIC_TASK_SCHEMA_SQL } from './libraryDatabaseLegacyTasks.ts'
import type { LegacyMusicTaskDatabaseApi } from '../../shared/legacyMusicTasks.ts'
import type { LegacyMusicMetadataDatabaseApi } from '../../shared/legacyMusicMetadata.ts'
import type { EntityMetadataDatabaseApi } from '../../shared/entityMetadata.ts'
import { metadataTasks, metadataTaskDemands } from './libraryDatabaseMetadataTasks.ts'
import type { IdentificationDatabaseApi } from '../../shared/musicIdentification.ts'
import type { CatalogUnifiedPlaybackDatabaseApi } from '../../shared/musicUnifiedPlayback.ts'
import { readCatalogPlaybackSources } from './libraryDatabasePlaybackSources.ts'
import type { AlbumBrowseDatabaseApi } from '../../shared/musicAlbumBrowse.ts'
import { LibraryDatabaseAlbumBrowse } from './libraryDatabaseAlbumBrowse.ts'
import type { MusicRatingsDatabaseApi } from '../../shared/musicRatings.ts'
import { LibraryDatabaseRatings, RATING_SCHEMA_SQL, RATING_SCHEMA_OBJECTS } from './libraryDatabaseRatings.ts'
import type { MusicPreferencesDatabaseApi } from '../../shared/musicPreferences.ts'
import { LibraryDatabasePreferences, PREFERENCE_SCHEMA_SQL, PREFERENCE_SCHEMA_OBJECTS, PREFERENCE_WORK_MIGRATION_SQL } from './libraryDatabasePreferences.ts'
import type { MusicTagsDatabaseApi } from '../../shared/musicTags.ts'
import type { MusicFocusDatabaseApi } from '../../shared/musicFocus.ts'
import { LibraryDatabaseFocus, FOCUS_SCHEMA_SQL, FOCUS_SCHEMA_OBJECTS } from './libraryDatabaseFocus.ts'
import { LibraryDatabaseTags, TAG_SCHEMA_SQL, TAG_SCHEMA_OBJECTS } from './libraryDatabaseTags.ts'
import { IDENTIFICATION_SCHEMA_SQL, IDENTIFICATION_INPUT_FENCE_SCHEMA_SQL, IDENTIFICATION_SOURCE_FENCE_SCHEMA_SQL, IDENTIFICATION_ALBUM_FENCE_SCHEMA_SQL } from './libraryDatabaseIdentification.ts'
import { DatabaseSync, backup, type SQLInputValue } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { LibraryDatabasePersonalMusic } from './libraryDatabasePersonalMusic.ts'
import { validateMusicPersonalBackup, validMusicPersonalBackupRevision, type MusicPersonalBackupDatabaseApi } from '../../shared/musicPersonalBackup.ts'
import { existsSync, mkdirSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  LocalMusicLibraryDocument,
  LocalLibraryRemovalMode,
  LocalLibraryTrackSelection
} from '../../shared/localLibrary.ts'
import type { LocalLibraryFileIdentity } from '../../shared/localLibraryScan.ts'
import { LOCAL_LIBRARY_METADATA_VERSION } from '../../shared/localLibraryScan.ts'
import { normalizeReleaseDate } from '../../shared/releaseDate.ts'
import { observedTrackTags, type LocalLibraryTagObservations } from '../../shared/localLibraryObservations.ts'
import {
  LIBRARY_MAX_PAGE_SIZE,
  LIBRARY_PAGE_SIZE,
  type LibraryQuery,
  type LibraryPage,
  type LibraryTrackRecord,
  type LibraryMetadata,
  type LibraryTrackPatch,
  type LibraryCollectionKind,
  type LibraryCollectionPage,
  type LibraryQueueSnapshot,
  type LibraryQueuePage,
  type LibraryQueueEdit,
  type LibraryQueueInsertItem,
  type LibraryScanCommit,
  type LibraryScanJob,
  type LibraryScanStartRequest,
  type LibraryScanDirectoryResult,
  type LibraryScanDirectoryPage,
  type LibraryScanWorkPage,
  type LibraryScanFinishResult,
  type LibraryScanProgressSnapshot,
  type LibraryCueDefinitionRecord,
  type LibraryScanDependency
} from '../../shared/libraryDatabase.ts'
import { normalizeLibraryFilePath } from './libraryRepository.ts'
import { stringifyJsonWithNestingLimit } from '../security/jsonSafety.ts'
import { streamLibraryJson } from './libraryJsonStream.ts'
import { externalizeLibraryCover } from './libraryCoverMigration.ts'
import { getPinyinInitials } from '../../shared/pinyinInitials.ts'
import {
  getAlbumIdentity,
  getAlbumCoverIdentity,
  albumOrderIndex,
  normalizeLibraryPath
} from '../../shared/libraryIdentity.ts'
import { getCollectionDirectory, isLibraryArtistMember, libraryArtistNames } from '../../shared/libraryCollections.ts'
import { normalizeTrackIdentityTags } from '../../shared/trackIdentification.ts'
import {
  LibraryDatabaseCollections,
  normalizeCollectionSearch
} from './libraryDatabaseCollections.ts'
import { splitGenreValues } from '../../shared/genreSeparators.ts'
import { sameLocalLibraryFileIdentity } from './fileIndex.ts'
import {
  personalBackupJsonReplacer,
  mergePersonalDomain,
  previewPersonalBackup,
  validatePersonalDomain
} from '../../shared/personalBackup.ts'
import type {
  LibraryDocumentExportOptions,
  LibraryDuplicateCandidatePage
} from './libraryDatabaseProtocol.ts'
import { toDuplicateCandidate } from './duplicateDetection.ts'
import { normalizePortableLibraryPath, reversePlaylistPath } from '../../shared/playlistPaths.ts'
import { LibraryDatabaseRemoval } from './libraryDatabaseRemoval.ts'
import { LibraryDatabaseRepair } from './libraryDatabaseRepair.ts'
import { LibraryDatabaseQueues, type LibraryQueueBuild } from './libraryDatabaseQueues.ts'
import { LibraryDatabasePlaylistViews } from './libraryDatabasePlaylistViews.ts'
import {
  LibraryDatabaseSelections,
  type LibrarySelectionBuild
} from './libraryDatabaseSelections.ts'
import type { LibrarySelectionRequest } from '../../shared/librarySelection.ts'
import { validateLibrarySelection } from './libraryDatabaseSelections.ts'
import { LibraryDatabaseHistory, LIBRARY_HISTORY_SCHEMA_SQL } from './libraryDatabaseHistory.ts'
import { LibraryDatabaseCatalog, CATALOG_SCHEMA_SQL, CATALOG_PROJECT_SCHEMA_SQL } from './libraryDatabaseCatalog.ts'
import { LibraryDatabaseCatalogReferences } from './libraryDatabaseCatalogReferences.ts'
import { LibraryDatabaseGenres, GENRE_SCHEMA_SQL } from './libraryDatabaseGenres.ts'
import { LibraryDatabaseGenreLegacy, GENRE_LEGACY_SCHEMA_SQL } from './libraryDatabaseGenreLegacy.ts'
import type { GenreDatabaseApi } from '../../shared/musicGenres.ts'
import type { GenreBrowseDatabaseApi } from '../../shared/musicGenreBrowse.ts'
import { LibraryDatabaseGenreBrowse, GENRE_PLATFORM_ALBUM_TARGET_SQL } from './libraryDatabaseGenreBrowse.ts'
import { BROWSE_REVISION_OBJECTS, BROWSE_REVISION_SCHEMA_SQL, PERSONAL_METADATA_TABLES, PERSONAL_METADATA_REVISION_OBJECTS, PERSONAL_METADATA_REVISION_SCHEMA_SQL } from './libraryDatabaseBrowseRevision.ts'
import { LEGACY_MUSIC_PROVENANCE_SCHEMA_SQL } from './legacyMusicProvenance.ts'
import type { CatalogQuery, CatalogSourceQuery, CatalogSync } from '../../shared/musicCatalog.ts'
import type { MusicVersionsDocument } from '../../shared/musicVersions.ts'
import {
  LIBRARY_RECORDING_INDEX_EXPRESSION,
  lookupPlaylistTrackIds,
  registerLibraryRecordingFunctions
} from './libraryDatabasePlaylist.ts'
import type { LibraryPlaylistLookupRequest } from '../../shared/libraryDatabase.ts'
import { unifiedLibraryOrder } from './libraryDatabaseSearch.ts'
import { SymSpellIndex, prepareSearchQuery, getMaxSymSpellTolerance } from '../../shared/searchRelevance.ts'
import type { LibraryHistorySyncRequest } from '../../shared/libraryDatabase.ts'
import {
  libraryPageBounds,
  validateLibraryQuery,
  validateLibraryIds,
  validateLibraryPlaylistLookup
} from './libraryDatabaseValidation.ts'

type Row = Record<string, string | number | null>
/** One staged projection per legacy file. Publication shares finishScan's file/scope fences. */
const SCAN_RELEASE_DATE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS scan_release_dates(
  job_id TEXT NOT NULL,file_key TEXT NOT NULL,epoch INTEGER NOT NULL,release_date TEXT,
  dependencies TEXT NOT NULL DEFAULT '[]',observations TEXT,PRIMARY KEY(job_id,file_key),
  FOREIGN KEY(job_id,file_key) REFERENCES scan_items(job_id,file_key) ON DELETE CASCADE);`
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const normalizeSearch = (value: string): string =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const collator = new Intl.Collator('zh')
const natural = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' })
const numericSorts: Record<string, string> = {
  duration: 'duration',
  sampleRate: 'sample_rate',
  addedAt: 'added_at',
  recentlyAdded: 'added_at',
  lastPlayed: 'last_played',
  playlist: 'seq',
  insertion: 'seq'
}
const numericIndexes: Record<string, string> = {
  duration: 'tracks_duration',
  sampleRate: 'tracks_sample_rate',
  addedAt: 'tracks_added',
  recentlyAdded: 'tracks_added',
  lastPlayed: 'tracks_played'
}
const textSorts: Record<string, string> = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  format: 'format'
}
const lossless = new Set([
  'flac',
  'alac',
  'wav',
  'wave',
  'aiff',
  'aif',
  'ape',
  'wv',
  'dsf',
  'dff',
  'mqa'
])
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Internal worker continuation; no full Track objects and never renderer IPC. */
export type LibraryQueuePreparation = {
  build: LibraryQueueBuild
  contentRevision: number
  historyRevision?: number
  playlist?: { id: string; token: symbol }
}
export type LibrarySelectionPreparation = {
  build: LibrarySelectionBuild
  playlistToken?: symbol
}
export class LibraryDatabaseDurabilityError extends Error {}

export function getLibraryDatabasePath(libraryFilePath: string): string {
  return join(dirname(libraryFilePath), 'music-library.sqlite')
}

const TRANSIENT_INDEX_IDLE_TTL_MS = 90_000

/** Synchronous SQL is confined to the database utility process. */
export class LibraryDatabase {
  readonly sql: DatabaseSync
  private readonly ordered = new Map<string, string[]>()
  private readonly totals = new Map<string, { total: number; totalDuration: number }>()
  private albumAliases: Map<string, string[]> | null = null
  private symSpellIndex: SymSpellIndex | null = null
  private transientIndexIdleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly collections = new LibraryDatabaseCollections()
  private readonly statements = new Map<string, ReturnType<DatabaseSync['prepare']>>()
  readonly filePath: string
  private readonly removal: LibraryDatabaseRemoval
  private readonly repair: LibraryDatabaseRepair
  private readonly queues: LibraryDatabaseQueues
  private readonly history: LibraryDatabaseHistory
  private readonly playlistViews: LibraryDatabasePlaylistViews
  private readonly selections: LibraryDatabaseSelections
  private readonly catalog: LibraryDatabaseCatalog
  private readonly catalogReferences: LibraryDatabaseCatalogReferences
  private readonly entityMetadata: LibraryDatabaseEntityMetadata
  private readonly genres: LibraryDatabaseGenres
  private readonly genreLegacy: LibraryDatabaseGenreLegacy
  private readonly genreBrowse: LibraryDatabaseGenreBrowse
  private albumBrowseInstance: LibraryDatabaseAlbumBrowse | null = null
  private focusInstance: LibraryDatabaseFocus | null = null

  constructor(filePath: string) {
    this.filePath = filePath
    const hadUncheckpointedWal =
      filePath !== ':memory:' && existsSync(`${filePath}-wal`) && statSync(`${filePath}-wal`).size > 0
    const existing =
      filePath !== ':memory:' &&
      existsSync(filePath) &&
      (statSync(filePath).size > 0 || hadUncheckpointedWal)
    mkdirSync(dirname(filePath), { recursive: true })
    this.sql = new DatabaseSync(filePath)
    this.genres = new LibraryDatabaseGenres({ sql: this.sql, transaction: action => this.transaction(action),
      collectionExists: id => this.getAlbumAliases().has(id) || !!this.sql.prepare(`
        SELECT 1 FROM catalog_sources s WHERE s.provider<>'local' AND s.album_key=?
        AND ${GENRE_PLATFORM_ALBUM_TARGET_SQL}
        AND EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id) LIMIT 1`).get(id) })
    this.genreLegacy = new LibraryDatabaseGenreLegacy({ sql: this.sql,
      transaction: action => this.transaction(action), contentRevision: () => this.getContentRevision(),
      albumCollections: () => [...this.getAlbumAliases().keys()].map(id => ({ id })), genres: this.genres })
    this.genreBrowse = new LibraryDatabaseGenreBrowse({ sql: this.sql,
      albumAliases: () => this.getAlbumAliases(), contentRevision: () => this.getContentRevision(),
      metadataRevision: () => this.getClassificationMetadataRevision() })
    this.catalogReferences = new LibraryDatabaseCatalogReferences(this.sql)
    this.entityMetadata = new LibraryDatabaseEntityMetadata({ sql: this.sql, transaction: action => this.transaction(action),
      contentRevision: () => this.getContentRevision(), albumAliases: id => this.getAlbumAliases().get(id) ?? [id], music: () => this.legacyMusic(),
      exploration: () => this.exploration() })
    this.catalog = new LibraryDatabaseCatalog({
      sql: this.sql,
      transaction: (action) => this.transaction(action),
      collectionSelection: (collection, id) => this.where(collection === 'artists' ? { artist: id } : { albumId: id })
    })
    this.repair = new LibraryDatabaseRepair(this.sql, (action) => this.transaction(action, false))
    registerLibraryRecordingFunctions(this.sql)
    this.removal = new LibraryDatabaseRemoval({
      sql: this.sql,
      transaction: (action) => this.transaction(action),
      meta: (key) => this.meta(key),
      setMeta: (key, value) => this.setMeta(key, value),
      bump: () => this.bump(),
      metadata: () => this.getMetadata()
    })
    this.queues = new LibraryDatabaseQueues({
      sql: this.sql,
      transaction: (action) => this.transaction(action),
      stagingTransaction: (action) => this.transaction(action, false),
      revision: () => Number(this.meta('revision'))
    })
    this.history = new LibraryDatabaseHistory({
      sql: this.sql,
      transaction: (action) => this.transaction(action)
    })
    this.playlistViews = new LibraryDatabasePlaylistViews({
      sql: this.sql,
      statement: (query) => this.statement(query),
      transaction: (action) => this.transaction(action),
      revision: () => Number(this.meta('revision')),
      historyRevision: () => this.history.revision,
      where: (query) => this.where(query)
    })
    this.selections = new LibraryDatabaseSelections({
      sql: this.sql,
      transaction: (action) => this.transaction(action, false),
      // A full numeric selection must not rescan the growing OFFSET on every
      // batch. Reuse the worker's compact ID order; hydrate only this window.
      query: (request, offset, limit) =>
        request.query.playlistView
          ? this.queryTracks({ ...request.query, offset, limit })
          : this.orderedTrackPage(request.query, offset, limit)
    })
    try {
      const version = Number((this.sql.prepare('PRAGMA user_version').get() as Row).user_version)
      if (version > 30) throw new Error(`Unsupported music library database version: ${version}`)
      let legacyV14InputFence = false
      if (existing) {
        const identity = Number(
          (this.sql.prepare('PRAGMA application_id').get() as Row).application_id
        )
        const tables = new Set(
          (
            this.sql.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view','trigger','index')").all() as Row[]
          ).map((row) => text(row.name))
        )
        // Early v14 profiles predate the additive input fence. Both objects
        // were absent there; a partial fence or a newer incomplete schema is
        // still rejected. Install it only inside the backed-up upgrade below.
        legacyV14InputFence = version === 14 &&
          !tables.has('metadata_identification_inputs') &&
          !tables.has('metadata_identification_input_changed')
        if (
          ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30].includes(version) ||
          identity !== 0x54574c42 ||
          [
            'meta',
            'tracks',
            'files',
            'scan_jobs',
            'queue_entries',
            'track_search',
            ...(version >= 4 ? ['library_history'] : []),
            ...(version >= 7 ? ['queue_snapshots'] : []),
            ...(version >= 13 ? ['metadata_entities', 'metadata_subjects', 'metadata_link_history', 'metadata_facts', 'metadata_overrides', 'metadata_jobs', 'metadata_demands'] : []),
            ...(version >= 14 && !legacyV14InputFence ? ['metadata_identification_inputs', 'metadata_identification_input_changed'] : []),
            ...(version >= 14 ? ['metadata_identity_refs', 'metadata_identity_links', 'metadata_identity_candidates', 'metadata_identity_suppressions', 'metadata_identity_history', 'catalog_release_projects'] : []),
            ...(version >= 15 ? ['metadata_identification_source_before', 'metadata_identification_source_after', 'metadata_identification_source_insert', 'metadata_identification_credit_insert', 'metadata_identification_credit_delete'] : []),
            ...(version >= 16 ? ['metadata_identification_album_cohort'] : []),
            ...(version >= 17 ? ['metadata_identification_schedule','metadata_identification_schedule_state','metadata_schedule_input_insert','metadata_schedule_input_update','metadata_schedule_member_insert','metadata_schedule_member_delete'] : []),
            ...(version >= 18 ? ['metadata_credits', 'metadata_credit_sets'] : []),
            ...(version >= 19 ? ['metadata_legacy_documents', 'metadata_legacy_albums', 'metadata_legacy_bindings', 'metadata_legacy_history'] : []),
            ...(version >= 20 ? ['metadata_legacy_inputs', 'metadata_legacy_batches'] : []),
            ...(version >= 21 ? ['music_genre_state', 'music_genres', 'music_genre_aliases',
              'music_genre_evidence', 'music_genre_overrides', 'music_genre_import_overrides',
              'music_genre_import_nodes', 'music_genre_alias_bridges', 'music_genre_pending', 'music_genre_sources_ai',
              'music_genre_sources_au', 'music_genre_members_ai', 'music_genre_members_ad',
              'music_genre_legacy_documents', 'music_genre_legacy_albums', 'music_genre_legacy_targets'] : []),
            ...(version >= 22 ? BROWSE_REVISION_OBJECTS : []),
            ...(version >= 23 ? RATING_SCHEMA_OBJECTS : []),
            ...(version >= 24 ? PREFERENCE_SCHEMA_OBJECTS : []),
            ...(version >= 25 ? TAG_SCHEMA_OBJECTS : []),
            ...(version >= 26 ? FOCUS_SCHEMA_OBJECTS : []),
            ...(version >= 27 ? EXPLORATION_SCHEMA_OBJECTS : []),
            ...(version >= 28 ? [...PERSONAL_METADATA_TABLES, ...PERSONAL_METADATA_REVISION_OBJECTS] : []),
            ...(version >= 29 ? ['scan_release_dates'] : []),
            ...(version >= 12 ? ['catalog_state', 'catalog_entities', 'catalog_aliases',
              'catalog_sources', 'catalog_memberships', 'catalog_source_artists', 'catalog_facts',
              'catalog_pending', 'catalog_imports', 'catalog_import_members', 'catalog_versions',
              'catalog_version_sources', 'catalog_bindings', 'catalog_entity_sources',
              'catalog_tracks_ai', 'catalog_tracks_au', 'catalog_tracks_ad'] : [])
          ].some((name) => !tables.has(name))
        )
          throw new Error(
            'Unrecognized or incomplete music library database; restore a verified backup before opening it'
          )
      }
      if (existing && (hadUncheckpointedWal || version < 30)) {
        let health = this.sql.prepare('PRAGMA quick_check').get() as Row
        if (health.quick_check !== 'ok') {
          try {
            this.sql.exec('REINDEX')
          } catch {
            // Reindex is a best-effort repair for secondary/FTS index corruption.
          }
          health = this.sql.prepare('PRAGMA quick_check').get() as Row
        }
        if (health.quick_check !== 'ok')
          throw new Error(`Music library database integrity check failed: ${health.quick_check}`)
      }
      this.sql.exec(
        'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-16384; PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-8192;'
      )
      this.sql.function(
        'library_has_genre',
        { deterministic: true },
        (source, genre, separators) => {
          const values = splitGenreValues(text(source), text(separators) || undefined)
          return (values.length ? values : ['未知流派']).includes(text(genre)) ? 1 : 0
        }
      )
      this.sql.function(
        'library_has_collection_genre',
        { deterministic: true },
        (source, genre, separators) => {
          const wanted = text(genre).trim().toLocaleLowerCase()
          return splitGenreValues(text(source), text(separators) || undefined).some(
            (value) => value.trim().toLocaleLowerCase() === wanted
          )
            ? 1
            : 0
        }
      )
      this.sql.function('library_normalize_path', { deterministic: true }, (value) =>
        normalizeLibraryPath(text(value))
      )
      this.sql.function('library_playlist_path', { deterministic: true }, (value) =>
        normalizePortableLibraryPath(text(value))
      )
      this.sql.function('library_playlist_reverse', { deterministic: true }, (value) =>
        reversePlaylistPath(text(value))
      )
      this.sql.function('library_search_key', { deterministic: true }, (value) =>
        normalizeCollectionSearch(text(value))
      )
      this.sql.function(
        'library_metadata_contains',
        { deterministic: true },
        (title, artist, album, needle) =>
          [title, artist, album].some((field) =>
            text(field).toLocaleLowerCase('zh-CN').includes(text(needle))
          )
            ? 1
            : 0
      )
      this.sql.function('library_has_artist', { deterministic: true }, (artist, credits, tags, name) => {
        const values: unknown =
          typeof credits === 'string' && credits.startsWith('[') ? JSON.parse(credits) : undefined
        const artists = Array.isArray(values)
          ? values.filter(
              (value): value is { name: string } =>
                isRecord(value) && typeof value.name === 'string'
            )
          : undefined
        const identityTags = normalizeTrackIdentityTags(typeof tags === 'string' ? JSON.parse(tags) : undefined)
        return isLibraryArtistMember({ artist: text(artist), artists, identityTags }, text(name)) ? 1 : 0
      })
      this.sql.function('library_artist_names', { deterministic: true }, (artist, credits, tags) => {
        const values: unknown = typeof credits === 'string' && credits.startsWith('[')
          ? JSON.parse(credits) : undefined
        const artists = Array.isArray(values)
          ? values.filter((value): value is { name: string } =>
              isRecord(value) && typeof value.name === 'string')
          : undefined
        const identityTags = normalizeTrackIdentityTags(typeof tags === 'string' ? JSON.parse(tags) : undefined)
        return JSON.stringify(libraryArtistNames({ artist: text(artist), artists, identityTags }))
      })
      let previousRoots = '',
        roots: string[] = []
      this.sql.function(
        'library_collection_directory',
        { deterministic: true },
        (filePath, dir, configuration) => {
          if (text(configuration) !== previousRoots) {
            previousRoots = text(configuration)
            roots = JSON.parse(previousRoots) as string[]
          }
          return getCollectionDirectory(text(filePath), text(dir), roots)
        }
      )
      if (!existing)
        this.sql.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT OR IGNORE INTO meta VALUES('revision','0'),('folders','[]'),('exclusions','[]');
        CREATE TABLE IF NOT EXISTS files(file_key TEXT PRIMARY KEY, file_path TEXT NOT NULL, identity TEXT, metadata_version INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', last_error TEXT, seen_job TEXT, content_version INTEGER NOT NULL DEFAULT 0, audio_metadata TEXT);
        CREATE TABLE IF NOT EXISTS tracks(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, file_key TEXT NOT NULL REFERENCES files(file_key), version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL,
          title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL, album_key TEXT NOT NULL, folder TEXT NOT NULL, format TEXT NOT NULL, search_text TEXT NOT NULL, search_file TEXT NOT NULL,
          duration REAL NOT NULL, sample_rate REAL NOT NULL, bit_depth REAL NOT NULL, added_at REAL NOT NULL, last_played REAL NOT NULL DEFAULT 0, disc_no REAL NOT NULL, track_no REAL NOT NULL, file_name TEXT NOT NULL, lossless INTEGER NOT NULL, dsd INTEGER NOT NULL,
          playlist_path TEXT NOT NULL DEFAULT '',playlist_path_reverse TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS tracks_file ON tracks(file_key);
        CREATE INDEX IF NOT EXISTS tracks_album ON tracks(album_key);
        CREATE INDEX IF NOT EXISTS tracks_folder ON tracks(folder);
        CREATE INDEX IF NOT EXISTS tracks_duration ON tracks(duration,seq);
        CREATE INDEX IF NOT EXISTS tracks_sample_rate ON tracks(sample_rate,seq);
        CREATE INDEX IF NOT EXISTS tracks_added ON tracks(added_at,seq);
        CREATE INDEX IF NOT EXISTS tracks_played ON tracks(last_played,seq);
        CREATE INDEX IF NOT EXISTS tracks_playlist_path ON tracks(playlist_path,seq);
        CREATE INDEX IF NOT EXISTS tracks_playlist_suffix ON tracks(playlist_path_reverse);
        CREATE VIRTUAL TABLE IF NOT EXISTS track_search USING fts5(search_text, search_file, content='tracks', content_rowid='seq', tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN INSERT INTO track_search(rowid,search_text,search_file) VALUES(new.seq,new.search_text,new.search_file); UPDATE files SET content_version=content_version+1 WHERE file_key=new.file_key; END;
        CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN INSERT INTO track_search(track_search,rowid,search_text,search_file) VALUES('delete',old.seq,old.search_text,old.search_file); UPDATE files SET content_version=content_version+1 WHERE file_key=old.file_key; END;
        CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN INSERT INTO track_search(track_search,rowid,search_text,search_file) VALUES('delete',old.seq,old.search_text,old.search_file); INSERT INTO track_search(rowid,search_text,search_file) VALUES(new.seq,new.search_text,new.search_file); UPDATE files SET content_version=content_version+1 WHERE file_key=new.file_key; END;
        CREATE TABLE IF NOT EXISTS scan_jobs(id TEXT PRIMARY KEY, mode TEXT NOT NULL, roots TEXT NOT NULL, state TEXT NOT NULL, committed_files INTEGER NOT NULL DEFAULT 0, failed_files INTEGER NOT NULL DEFAULT 0, last_batch INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, parsed_files INTEGER NOT NULL DEFAULT 0, checked_files INTEGER, checkpoints_reclaimed INTEGER NOT NULL DEFAULT 0 CHECK(checkpoints_reclaimed IN (0,1)));
        CREATE INDEX IF NOT EXISTS scan_jobs_latest ON scan_jobs(updated_at DESC);
        CREATE INDEX scan_checkpoint_cleanup ON scan_jobs(updated_at) WHERE state='completed' AND checkpoints_reclaimed=0;
        CREATE TABLE IF NOT EXISTS scan_directories(job_id TEXT NOT NULL REFERENCES scan_jobs(id), path TEXT NOT NULL, state TEXT NOT NULL, error TEXT, PRIMARY KEY(job_id,path));
        CREATE TABLE IF NOT EXISTS scan_items(job_id TEXT NOT NULL REFERENCES scan_jobs(id), file_key TEXT NOT NULL, identity TEXT NOT NULL, state TEXT NOT NULL, error TEXT, expected_version INTEGER NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY(job_id,file_key));
        ${SCAN_RELEASE_DATE_SCHEMA_SQL}
        CREATE INDEX IF NOT EXISTS scan_pending_files ON scan_items(job_id,epoch,state,file_key);
        CREATE INDEX IF NOT EXISTS scan_pending_directories ON scan_directories(job_id,state,path);
        CREATE TABLE IF NOT EXISTS cue_definitions(cue_key TEXT PRIMARY KEY, identity TEXT NOT NULL, audio_key TEXT NOT NULL, definition TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS cue_audio ON cue_definitions(audio_key);
        CREATE TABLE IF NOT EXISTS queues(id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, selected_entry TEXT, ordering TEXT NOT NULL DEFAULT 'original', total_count INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('building','ready','abandoned')),
          play_mode TEXT CHECK(play_mode IN ('sequential','listLoop','repeat','shuffle')));
        CREATE INDEX queues_state ON queues(state,id);
        CREATE TABLE IF NOT EXISTS queue_entries(queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE, position INTEGER NOT NULL, entry_id TEXT NOT NULL, track_id TEXT NOT NULL, original_position INTEGER NOT NULL, PRIMARY KEY(queue_id,position), UNIQUE(queue_id,entry_id));
        CREATE INDEX IF NOT EXISTS queue_entries_original ON queue_entries(queue_id,original_position);
        CREATE TABLE queue_snapshots(queue_id TEXT NOT NULL,entry_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(queue_id,entry_id),FOREIGN KEY(queue_id,entry_id) REFERENCES queue_entries(queue_id,entry_id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS queue_history(id INTEGER PRIMARY KEY AUTOINCREMENT,queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,revision INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS queue_history_queue ON queue_history(queue_id,id);
        CREATE TABLE IF NOT EXISTS queue_history_entries(history_id INTEGER NOT NULL REFERENCES queue_history(id) ON DELETE CASCADE,position INTEGER NOT NULL,original_position INTEGER NOT NULL,entry_id TEXT NOT NULL,track_id TEXT NOT NULL,snapshot TEXT,PRIMARY KEY(history_id,entry_id));
        CREATE TABLE IF NOT EXISTS queue_references(owner TEXT NOT NULL,queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,updated_at INTEGER NOT NULL,PRIMARY KEY(owner,queue_id));
        CREATE INDEX IF NOT EXISTS queue_references_queue ON queue_references(queue_id);
        PRAGMA application_id=1415007298;
        ${LIBRARY_HISTORY_SCHEMA_SQL}
        CREATE INDEX tracks_recording ON tracks(${LIBRARY_RECORDING_INDEX_EXPRESSION},seq);
        ${CATALOG_SCHEMA_SQL}
        ${ENTITY_METADATA_SCHEMA_SQL}
        ${CATALOG_PROJECT_SCHEMA_SQL}
        ${IDENTIFICATION_SCHEMA_SQL}
        ${IDENTIFICATION_SOURCE_FENCE_SCHEMA_SQL}
        ${IDENTIFICATION_ALBUM_FENCE_SCHEMA_SQL}
        ${IDENTIFICATION_SCHEDULE_SCHEMA_SQL}
        ${ENTITY_METADATA_DETAILS_SCHEMA_SQL}
        ${LEGACY_MUSIC_METADATA_SCHEMA_SQL}
        ${LEGACY_MUSIC_TASK_SCHEMA_SQL}
        ${GENRE_SCHEMA_SQL}
        ${GENRE_LEGACY_SCHEMA_SQL}
        ${BROWSE_REVISION_SCHEMA_SQL}
        ${RATING_SCHEMA_SQL}
        ${PREFERENCE_SCHEMA_SQL}
        ${TAG_SCHEMA_SQL}
        ${FOCUS_SCHEMA_SQL}
        ${EXPLORATION_SCHEMA_SQL}
        ${ENTITY_METADATA_PERSONAL_SCHEMA_SQL}
        ${LEGACY_MUSIC_PROVENANCE_SCHEMA_SQL}
        ${PERSONAL_METADATA_REVISION_SCHEMA_SQL}
        PRAGMA user_version=30;
        COMMIT;
      `)
      if (existing && version < 30) {
        // VACUUM INTO is a consistent SQLite snapshot, including committed WAL
        // pages. A backup failure must prevent the schema change.
        const destination = `${filePath}.v${version}-backup-${randomUUID()}.sqlite`
        this.sql.prepare('VACUUM INTO ?').run(destination)
        this.sql.exec('BEGIN IMMEDIATE')
        try {
          if (version === 1)
            this.sql.exec(`ALTER TABLE scan_jobs ADD COLUMN parsed_files INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE files ADD COLUMN audio_metadata TEXT;`)
          if (version < 3)
            this.sql.exec(`ALTER TABLE queues ADD COLUMN selected_entry TEXT;
            ALTER TABLE queues ADD COLUMN ordering TEXT NOT NULL DEFAULT 'original';
            ALTER TABLE queues ADD COLUMN total_count INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE queue_entries ADD COLUMN original_position INTEGER NOT NULL DEFAULT 0;
            UPDATE queue_entries SET original_position=position;
            UPDATE queues SET total_count=(SELECT count(*) FROM queue_entries WHERE queue_id=queues.id),
              selected_entry=(SELECT entry_id FROM queue_entries WHERE queue_id=queues.id ORDER BY position LIMIT 1);
            CREATE INDEX queue_entries_original ON queue_entries(queue_id,original_position);
            CREATE INDEX IF NOT EXISTS scan_jobs_latest ON scan_jobs(updated_at DESC);
            `)
          if (version < 4) this.sql.exec(LIBRARY_HISTORY_SCHEMA_SQL)
          if (version < 5)
            this.sql.exec(`ALTER TABLE tracks ADD COLUMN playlist_path TEXT NOT NULL DEFAULT '';
            ALTER TABLE tracks ADD COLUMN playlist_path_reverse TEXT NOT NULL DEFAULT '';
            UPDATE tracks SET playlist_path=library_playlist_path(json_extract(payload,'$.filePath'));
            UPDATE tracks SET playlist_path_reverse=library_playlist_reverse(playlist_path);
            CREATE INDEX tracks_playlist_path ON tracks(playlist_path,seq);
            CREATE INDEX tracks_playlist_suffix ON tracks(playlist_path_reverse);
            `)
          if (version < 6)
            this.sql.exec(
              `CREATE INDEX tracks_recording ON tracks(${LIBRARY_RECORDING_INDEX_EXPRESSION},seq);`
            )
          if (version < 7)
            this.sql.exec(
              `CREATE TABLE queue_snapshots(entry_id TEXT PRIMARY KEY REFERENCES queue_entries(entry_id) ON DELETE CASCADE,payload TEXT NOT NULL);`
            )
          if (version < 8)
            this.sql
              .exec(`ALTER TABLE queues ADD COLUMN state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('building','ready','abandoned'));
            CREATE INDEX queues_state ON queues(state,id);`)
          if (version < 9)
            this.sql.exec(
              "ALTER TABLE queues ADD COLUMN play_mode TEXT CHECK(play_mode IN ('sequential','listLoop','repeat','shuffle'));"
            )
          // Snapshot legacy completion counts lazily, one job at a time, before
          // retiring its rows. Opening must not scan all historical checkpoints.
          if (version < 10)
            this.sql.exec(`ALTER TABLE scan_jobs ADD COLUMN checked_files INTEGER;
            ALTER TABLE scan_jobs ADD COLUMN checkpoints_reclaimed INTEGER NOT NULL DEFAULT 0 CHECK(checkpoints_reclaimed IN (0,1));
            CREATE INDEX scan_checkpoint_cleanup ON scan_jobs(updated_at) WHERE state='completed' AND checkpoints_reclaimed=0;`)
          // Named array sessions may overlap the live queue or each other.
          // Keep their occurrence IDs; identity is scoped by the durable queue.
          if (version < 11) this.sql
            .exec(`CREATE TABLE queue_entries_v11(queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,position INTEGER NOT NULL,entry_id TEXT NOT NULL,track_id TEXT NOT NULL,original_position INTEGER NOT NULL,PRIMARY KEY(queue_id,position),UNIQUE(queue_id,entry_id));
            INSERT INTO queue_entries_v11 SELECT queue_id,position,entry_id,track_id,original_position FROM queue_entries;
            CREATE TABLE queue_snapshots_v11(queue_id TEXT NOT NULL,entry_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(queue_id,entry_id),FOREIGN KEY(queue_id,entry_id) REFERENCES queue_entries_v11(queue_id,entry_id) ON DELETE CASCADE);
            INSERT INTO queue_snapshots_v11 SELECT q.queue_id,s.entry_id,s.payload FROM queue_snapshots s JOIN queue_entries q ON q.entry_id=s.entry_id;
            DROP TABLE queue_snapshots;
            DROP TABLE queue_entries;
            ALTER TABLE queue_entries_v11 RENAME TO queue_entries;
            ALTER TABLE queue_snapshots_v11 RENAME TO queue_snapshots;
            CREATE INDEX queue_entries_original ON queue_entries(queue_id,original_position);
            `)
          if (version < 12) this.sql.exec(CATALOG_SCHEMA_SQL)
          if (version < 13) this.sql.exec(ENTITY_METADATA_SCHEMA_SQL)
          if (version < 14) {
            this.sql.exec(`${CATALOG_PROJECT_SCHEMA_SQL}\n${IDENTIFICATION_SCHEMA_SQL}`)
            this.entityMetadata.identification.migrateLegacyCandidates()
          }
          if (legacyV14InputFence) {
            this.sql.exec(`${IDENTIFICATION_INPUT_FENCE_SCHEMA_SQL}
              INSERT INTO metadata_identification_inputs SELECT id,1 FROM catalog_entities;
              CREATE INDEX IF NOT EXISTS metadata_link_history_identity ON metadata_link_history(entity_id,lower(mbid),seq);`)
          }
          if (version < 15) this.sql.exec(IDENTIFICATION_SOURCE_FENCE_SCHEMA_SQL)
          if (version < 16) this.sql.exec(IDENTIFICATION_ALBUM_FENCE_SCHEMA_SQL)
          if (version < 17) this.sql.exec(IDENTIFICATION_SCHEDULE_SCHEMA_SQL)
          if (version < 18) this.sql.exec(ENTITY_METADATA_DETAILS_SCHEMA_SQL)
          if (version < 19) this.sql.exec(LEGACY_MUSIC_METADATA_SCHEMA_SQL)
          if (version < 20) this.sql.exec(LEGACY_MUSIC_TASK_SCHEMA_SQL)
          if (version < 21) this.sql.exec(`${GENRE_SCHEMA_SQL}\n${GENRE_LEGACY_SCHEMA_SQL}`)
          if (version < 22) this.sql.exec(BROWSE_REVISION_SCHEMA_SQL)
          if (version < 23) this.sql.exec(RATING_SCHEMA_SQL)
          if (version < 24) this.sql.exec(PREFERENCE_SCHEMA_SQL)
          if (version < 25) this.sql.exec(TAG_SCHEMA_SQL)
          if (version < 26) this.sql.exec(FOCUS_SCHEMA_SQL)
          if (version < 27) {
            this.sql.exec(EXPLORATION_SCHEMA_SQL)
            if (version >= 24) this.sql.exec(PREFERENCE_WORK_MIGRATION_SQL)
          }
          if (version < 28) this.sql.exec(`${ENTITY_METADATA_PERSONAL_SCHEMA_SQL}\n${LEGACY_MUSIC_PROVENANCE_SCHEMA_SQL}\n${PERSONAL_METADATA_REVISION_SCHEMA_SQL}`)
          if (version < 29) this.sql.exec(SCAN_RELEASE_DATE_SCHEMA_SQL)
          else if (version < 30) this.sql.exec('ALTER TABLE scan_release_dates ADD COLUMN observations TEXT')
          this.sql.exec('PRAGMA user_version=30; COMMIT;')
        } catch (error) {
          this.sql.exec('ROLLBACK')
          throw error
        }
      }
      // Queue undo history was added without a user_version bump so older
      // profiles can create the tables atomically on their first reopen.
      this.sql
        .exec(`CREATE TABLE IF NOT EXISTS queue_history(id INTEGER PRIMARY KEY AUTOINCREMENT,queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,revision INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS queue_history_queue ON queue_history(queue_id,id);
        CREATE TABLE IF NOT EXISTS queue_history_entries(history_id INTEGER NOT NULL REFERENCES queue_history(id) ON DELETE CASCADE,position INTEGER NOT NULL,original_position INTEGER NOT NULL,entry_id TEXT NOT NULL,track_id TEXT NOT NULL,snapshot TEXT,PRIMARY KEY(history_id,entry_id));`)
      this.sql
        .exec(`CREATE TABLE IF NOT EXISTS queue_references(owner TEXT NOT NULL,queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,updated_at INTEGER NOT NULL,PRIMARY KEY(owner,queue_id));
        CREATE INDEX IF NOT EXISTS queue_references_queue ON queue_references(queue_id);`)
      // Additive indexes keep records and revision unchanged. The constant
      // file index lets COUNT(*) skip wide path keys without caching stale counts.
      this.sql.exec(`CREATE INDEX IF NOT EXISTS tracks_insertion ON tracks(seq);
        CREATE INDEX IF NOT EXISTS files_count ON files(1);
        CREATE INDEX IF NOT EXISTS metadata_fact_expiry ON metadata_facts(json_extract(payload,'$.usage.expiresAt'))
          WHERE json_extract(payload,'$.usage.expiresAt') IS NOT NULL;`)
      // Re-project saved file credits in bounded catalog maintenance, not a re-scan
      // or a synchronous whole-library payload migration during database open.
      // v3 also expands spaced ampersands in display credits and single ARTIST tags.
      this.sql.exec(`INSERT OR IGNORE INTO catalog_state VALUES('file_artist_cursor_v3','0');
        INSERT OR IGNORE INTO catalog_state SELECT 'file_artist_horizon_v3',CAST(coalesce(max(seq),0) AS TEXT) FROM tracks;`)
      // A previous owner's unacknowledged construction is never playable.
      // Recovery only marks it; bounded background maintenance releases rows.
      this.queues.recoverBuilds()
    } catch (error) {
      this.sql.close()
      throw error
    }
  }

  close(): void {
    this.clearTransientIndexes()
    if (this.sql.isOpen) this.sql.close()
  }

  private scheduleTransientIndexRelease(): void {
    if (this.transientIndexIdleTimer) clearTimeout(this.transientIndexIdleTimer)
    this.transientIndexIdleTimer = setTimeout(() => {
      this.transientIndexIdleTimer = null
      this.symSpellIndex = null
      this.albumAliases = null
      this.collections.clearTransientCaches()
    }, TRANSIENT_INDEX_IDLE_TTL_MS)
    this.transientIndexIdleTimer.unref?.()
  }

  private clearTransientIndexes(): void {
    if (this.transientIndexIdleTimer) {
      clearTimeout(this.transientIndexIdleTimer)
      this.transientIndexIdleTimer = null
    }
    this.symSpellIndex = null
    this.albumAliases = null
    this.collections.clearTransientCaches()
  }
  identificationSchedule(...args: Parameters<import('../../shared/musicIdentificationSchedule.ts').IdentificationScheduleDatabaseApi['identificationSchedule']>) {
    return new LibraryDatabaseIdentificationSchedule(this.sql, this.entityMetadata, action => this.transaction(action)).advance(...args)
  }
  identificationScheduleStatus() {
    return new LibraryDatabaseIdentificationSchedule(this.sql, this.entityMetadata, action => this.transaction(action)).status()
  }
  identificationEnqueue(...args: Parameters<IdentificationDatabaseApi['identificationEnqueue']>) { return this.entityMetadata.enqueueIdentification(...args) }
  identificationInput(...args: Parameters<IdentificationDatabaseApi['identificationInput']>) { return this.entityMetadata.identification.input(...args) }
  identificationPublish(...args: Parameters<IdentificationDatabaseApi['identificationPublish']>) { return this.entityMetadata.identification.publish(...args) }
  identificationDetail(...args: Parameters<IdentificationDatabaseApi['identificationDetail']>) { return this.entityMetadata.identification.detail(...args) }
  identificationCandidates(...args: Parameters<IdentificationDatabaseApi['identificationCandidates']>) { return this.entityMetadata.identification.candidates(...args) }
  identificationInbox(...args: Parameters<IdentificationDatabaseApi['identificationInbox']>) { return this.entityMetadata.identification.inbox(...args) }
  identificationHistory(...args: Parameters<IdentificationDatabaseApi['identificationHistory']>) { return this.entityMetadata.identification.history(...args) }
  identificationRestorePreview(...args: Parameters<IdentificationDatabaseApi['identificationRestorePreview']>) { return this.entityMetadata.identification.restorePreview(...args) }
  identificationRestore(...args: Parameters<IdentificationDatabaseApi['identificationRestore']>) { return this.entityMetadata.identification.restore(...args) }
  identificationPreview(...args: Parameters<IdentificationDatabaseApi['identificationPreview']>) { return this.entityMetadata.identification.preview(...args) }
  identificationDecide(...args: Parameters<IdentificationDatabaseApi['identificationDecide']>) { return this.entityMetadata.identification.decide(...args) }
  identificationDetach(...args: Parameters<IdentificationDatabaseApi['identificationDetach']>) { return this.entityMetadata.identification.detach(...args) }
  metadataDetail(...args: Parameters<EntityMetadataDatabaseApi['metadataDetail']>) { return this.entityMetadata.detail(...args) }
  metadataCredits(...args: Parameters<EntityMetadataDatabaseApi['metadataCredits']>) { return this.entityMetadata.credits(...args) }
  metadataArtwork(...args: Parameters<EntityMetadataDatabaseApi['metadataArtwork']>) { return this.entityMetadata.artwork(...args) }
  metadataEnqueue(...args: Parameters<EntityMetadataDatabaseApi['metadataEnqueue']>) { return this.entityMetadata.enqueue(...args) }
  metadataDecide(...args: Parameters<EntityMetadataDatabaseApi['metadataDecide']>) { return this.entityMetadata.decide(...args) }
  metadataDetach(...args: Parameters<EntityMetadataDatabaseApi['metadataDetach']>) { return this.entityMetadata.detach(...args) }
  metadataOverride(...args: Parameters<EntityMetadataDatabaseApi['metadataOverride']>) { return this.entityMetadata.override(...args) }
  metadataSourcePreference(...args: Parameters<EntityMetadataDatabaseApi['metadataSourcePreference']>) { return this.entityMetadata.sourcePreference(...args) }
  metadataArtworkOverride(...args: Parameters<EntityMetadataDatabaseApi['metadataArtworkOverride']>) { return this.entityMetadata.artworkOverride(...args) }
  metadataJobs(...args: Parameters<EntityMetadataDatabaseApi['metadataJobs']>) { return this.entityMetadata.jobs(...args) }
  metadataTasks(...args: Parameters<EntityMetadataDatabaseApi['metadataTasks']>) { return metadataTasks(this.sql, ...args) }
  metadataTaskDemands(...args: Parameters<EntityMetadataDatabaseApi['metadataTaskDemands']>) { return metadataTaskDemands(this.sql, ...args) }
  metadataTaskSources(...args: Parameters<EntityMetadataDatabaseApi['metadataTaskSources']>) { return this.entityMetadata.taskSources(...args) }
  metadataRequery(...args: Parameters<EntityMetadataDatabaseApi['metadataRequery']>) { return this.entityMetadata.requery(...args) }
  metadataCancel(...args: Parameters<EntityMetadataDatabaseApi['metadataCancel']>) { return this.entityMetadata.cancel(...args) }
  metadataRecover(...args: Parameters<EntityMetadataDatabaseApi['metadataRecover']>) { return this.entityMetadata.recover(...args) }
  metadataClaim(...args: Parameters<EntityMetadataDatabaseApi['metadataClaim']>) { return this.entityMetadata.claim(...args) }
  metadataNextAttempt() { return this.entityMetadata.nextAttempt() }
  metadataFinish(...args: Parameters<EntityMetadataDatabaseApi['metadataFinish']>) { return this.entityMetadata.finish(...args) }
  legacyMusicBatchBegin(...args: Parameters<LegacyMusicTaskDatabaseApi['legacyMusicBatchBegin']>) { return this.entityMetadata.legacy.begin(...args) }
  legacyMusicBatchStage(...args: Parameters<LegacyMusicTaskDatabaseApi['legacyMusicBatchStage']>) { return this.entityMetadata.legacy.stage(...args) }
  legacyMusicBatchPublish(...args: Parameters<LegacyMusicTaskDatabaseApi['legacyMusicBatchPublish']>) { return this.entityMetadata.legacy.publish(...args) }
  legacyMusicTaskStatus(...args: Parameters<LegacyMusicTaskDatabaseApi['legacyMusicTaskStatus']>) { return this.entityMetadata.legacy.status(...args) }
  legacyMusicBatchCancel(...args: Parameters<LegacyMusicTaskDatabaseApi['legacyMusicBatchCancel']>) { return this.entityMetadata.legacy.cancel(...args) }
  private legacyMusic() { return new LibraryDatabaseLegacyMusic({ sql: this.sql,
    transaction: action => this.transaction(action), contentRevision: () => this.getContentRevision(),
    albumAliases: id => this.getAlbumAliases().get(id) ?? [id], genres: this.genreLegacy }) }
  genresTree(...args: Parameters<GenreDatabaseApi['genresTree']>) { return this.genres.tree(...args) }
  genresBrowse(...args: Parameters<GenreBrowseDatabaseApi['genresBrowse']>) { return this.genreBrowse.browse(...args) }
  genresMembers(...args: Parameters<GenreBrowseDatabaseApi['genresMembers']>) { return this.genreBrowse.members(...args) }
  genresContainsSources(...args: Parameters<GenreBrowseDatabaseApi['genresContainsSources']>) { return this.genreBrowse.containsSources(...args) }
  genresFacets(...args: Parameters<GenreBrowseDatabaseApi['genresFacets']>) { return this.genreBrowse.facets(...args) }
  getGenresRevision() { return this.genres.revision() }
  getClassificationMetadataRevision() {
    return Number(this.sql.prepare('SELECT metadata_revision FROM music_browse_state WHERE id=1').get()!.metadata_revision)
  }
  genresUnmapped(...args: Parameters<GenreDatabaseApi['genresUnmapped']>) { return this.genres.unmapped(...args) }
  genresEvidence(...args: Parameters<GenreDatabaseApi['genresEvidence']>) { return this.genres.evidence(...args) }
  genresEdit(...args: Parameters<GenreDatabaseApi['genresEdit']>) { return this.genres.edit(...args) }
  genresMap(...args: Parameters<GenreDatabaseApi['genresMap']>) { return this.genres.map(...args) }
  genresOverride(...args: Parameters<GenreDatabaseApi['genresOverride']>) { return this.genres.override(...args) }
  genresAdvance(limit = 200, separators?: string) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid genre maintenance batch')
    const legacy = this.genreLegacy.advance(limit)
    if (legacy.processed === limit)
      return { revision: this.genres.revision(), processed: limit, pending: true }
    const result = this.genres.advance(limit - legacy.processed, separators)
    return { ...result, processed: legacy.processed + result.processed, pending: legacy.pending || result.pending }
  }
  legacyMusicStatus(...args: Parameters<LegacyMusicMetadataDatabaseApi['legacyMusicStatus']>) { return this.legacyMusic().status(...args) }
  legacyMusicBegin(...args: Parameters<LegacyMusicMetadataDatabaseApi['legacyMusicBegin']>) { return this.legacyMusic().begin(...args) }
  legacyMusicStage(...args: Parameters<LegacyMusicMetadataDatabaseApi['legacyMusicStage']>) { return this.legacyMusic().stage(...args) }
  legacyMusicPublish(...args: Parameters<LegacyMusicMetadataDatabaseApi['legacyMusicPublish']>) { return this.legacyMusic().publish(...args) }
  legacyMusicRead(...args: Parameters<LegacyMusicMetadataDatabaseApi['legacyMusicRead']>) { return this.legacyMusic().read(...args) }
  legacyMusicEdit(...args: Parameters<LegacyMusicMetadataDatabaseApi['legacyMusicEdit']>) { return this.legacyMusic().edit(...args) }
  legacyMusicHistory(...args: Parameters<LegacyMusicMetadataDatabaseApi['legacyMusicHistory']>) { return this.legacyMusic().history(...args) }
  legacyMusicHistoryRead(...args: Parameters<LegacyMusicMetadataDatabaseApi['legacyMusicHistoryRead']>) { return this.legacyMusic().historyRead(...args) }
  legacyMusicRestore(...args: Parameters<LegacyMusicMetadataDatabaseApi['legacyMusicRestore']>) { return this.legacyMusic().restore(...args) }
  legacyMusicInventory(...args: Parameters<LegacyMusicMetadataDatabaseApi['legacyMusicInventory']>) { return this.legacyMusic().inventory(...args) }
  legacyMusicProvenanceList(...args: Parameters<LegacyMusicMetadataDatabaseApi['legacyMusicProvenanceList']>) { return this.legacyMusic().provenanceList(...args) }
  legacyMusicProvenanceRead(...args: Parameters<LegacyMusicMetadataDatabaseApi['legacyMusicProvenanceRead']>) { return this.legacyMusic().provenanceRead(...args) }
  legacyMusicProvenanceReview(...args: Parameters<LegacyMusicMetadataDatabaseApi['legacyMusicProvenanceReview']>) { return this.legacyMusic().provenanceReview(...args) }
  catalogStatus() { return this.catalog.status() }
  catalogAdvance(limit?: number) { return this.catalog.advance(limit) }
  catalogQuery(query: CatalogQuery) { return this.catalog.query(query) }
  catalogDetail(id: string, revision?: number) { return this.catalog.detail(id, revision) }
  catalogSources(query: CatalogSourceQuery) { return this.catalog.sources(query) }
  catalogSync(request: CatalogSync) { return this.catalog.sync(request) }
  catalogProjectVersions(document: MusicVersionsDocument, revision: number) {
    return this.catalog.projectVersions(document, revision)
  }
  catalogResolve(sourceId: string, revision: number) { return this.catalog.resolve(sourceId, revision) }
  catalogPlaybackSources(...args: Parameters<CatalogUnifiedPlaybackDatabaseApi['catalogPlaybackSources']>) {
    return readCatalogPlaybackSources(this.sql, (id, revision) => this.catalog.resolve(id, revision), ...args)
  }
  private albumBrowse() { return (this.albumBrowseInstance ??= new LibraryDatabaseAlbumBrowse({ sql: this.sql,
    contentRevision: () => this.getContentRevision(),
    metadataRevision: () => this.getClassificationMetadataRevision() })) }
  albumsBrowse(...args: Parameters<AlbumBrowseDatabaseApi['albumsBrowse']>) { return this.albumBrowse().browse(...args) }
  albumsSources(...args: Parameters<AlbumBrowseDatabaseApi['albumsSources']>) { return this.albumBrowse().sources(...args) }
  albumsContainsSource(...args: Parameters<AlbumBrowseDatabaseApi['albumsContainsSource']>) { return this.albumBrowse().containsSource(...args) }
  private ratings() { return new LibraryDatabaseRatings({ sql: this.sql,
    transaction: action => this.transaction(action) }) }
  ratingsDetail(...args: Parameters<MusicRatingsDatabaseApi['ratingsDetail']>) { return this.ratings().detail(...args) }
  ratingsSet(...args: Parameters<MusicRatingsDatabaseApi['ratingsSet']>) { return this.ratings().set(...args) }
  ratingsHistory(...args: Parameters<MusicRatingsDatabaseApi['ratingsHistory']>) { return this.ratings().history(...args) }
  ratingsTargets(...args: Parameters<MusicRatingsDatabaseApi['ratingsTargets']>) { return this.ratings().targets(...args) }
  getRatingsRevision() { return this.ratings().revision() }
  private preferences() { return new LibraryDatabasePreferences({ sql: this.sql,
    transaction: action => this.transaction(action) }) }
  preferencesTargets(...args: Parameters<MusicPreferencesDatabaseApi['preferencesTargets']>) { return this.preferences().targets(...args) }
  preferencesDetail(...args: Parameters<MusicPreferencesDatabaseApi['preferencesDetail']>) { return this.preferences().detail(...args) }
  preferencesSet(...args: Parameters<MusicPreferencesDatabaseApi['preferencesSet']>) { return this.preferences().set(...args) }
  preferencesHistory(...args: Parameters<MusicPreferencesDatabaseApi['preferencesHistory']>) { return this.preferences().history(...args) }
  preferencesAutomaticEligibility(...args: Parameters<MusicPreferencesDatabaseApi['preferencesAutomaticEligibility']>) { return this.preferences().automaticEligibility(...args) }
  preferencesTrackStates(...args: Parameters<MusicPreferencesDatabaseApi['preferencesTrackStates']>) { return this.preferences().trackStates(...args) }
  preferencesPlaylistsLoad(...args: Parameters<MusicPreferencesDatabaseApi['preferencesPlaylistsLoad']>) { return this.preferences().playlistsLoad(...args) }
  preferencesPlaylistsMigrate(...args: Parameters<MusicPreferencesDatabaseApi['preferencesPlaylistsMigrate']>) { return this.preferences().playlistsMigrate(...args) }
  preferencesPlaylistsMigrationReceipt() { return this.preferences().playlistsMigrationReceipt() }
  preferencesPlaylistsSave(...args: Parameters<MusicPreferencesDatabaseApi['preferencesPlaylistsSave']>) { return this.preferences().playlistsSave(...args) }
  preferencesPlaylistsRestore(...args: Parameters<MusicPreferencesDatabaseApi['preferencesPlaylistsRestore']>) { return this.preferences().playlistsRestore(...args) }
  getPreferencesRevision() { return this.preferences().revision() }
  private personalMusic() { return new LibraryDatabasePersonalMusic({ sql: this.sql, metadata: () => this.getMetadata() }) }
  musicBackupRevision() { return this.personalMusic().revision() }
  musicBackupExport(...args: Parameters<MusicPersonalBackupDatabaseApi['musicBackupExport']>) { return this.personalMusic().export(...args) }
  musicBackupPreview(...args: Parameters<MusicPersonalBackupDatabaseApi['musicBackupPreview']>) { return this.personalMusic().preview(...args) }
  async musicBackupRestore(bundle: Parameters<MusicPersonalBackupDatabaseApi['musicBackupRestore']>[0]) {
    const music = this.personalMusic()
    if (!bundle || !/^[a-zA-Z0-9-]{1,128}$/.test(bundle.restoreId) || !validMusicPersonalBackupRevision(bundle.expectedRevision) ||
      !['keep-local', 'use-backup'].includes(bundle.conflict) || (bundle.music !== undefined && !validateMusicPersonalBackup(bundle.music)) ||
      (bundle.library !== undefined && !validatePersonalDomain('library', bundle.library)) ||
      (bundle.playlists !== undefined && !validatePersonalDomain('playlists', bundle.playlists))) throw new Error('Invalid personal music restore bundle')
    if (music.restored(bundle.restoreId)) return music.result()
    music.assertRevision(bundle.expectedRevision)
    return this.restoreWithSnapshot(bundle.restoreId, bundle.expectedRevision.library,
      () => music.apply(bundle, () => { if (bundle.library) this.restorePersonalLibraryRecords(bundle.library, bundle.conflict) }),
      () => music.result(), snapshot => new LibraryDatabasePersonalMusic({ sql: snapshot, metadata: () => this.getMetadata() }).assertRevision(bundle.expectedRevision))
  }
  private exploration() { return new LibraryDatabaseExploration({ sql: this.sql,
    transaction: action => this.sql.isTransaction ? action() : this.transaction(action),
    contentRevision: () => this.getContentRevision(), metadataRevision: () => this.getClassificationMetadataRevision() }) }
  explorationLookup(...args: Parameters<MusicExplorationDatabaseApi['explorationLookup']>) { return this.exploration().lookupReference(...args) }
  explorationBackfillCredits(...args: Parameters<MusicExplorationDatabaseApi['explorationBackfillCredits']>) { return this.exploration().backfillCredits(...args) }
  explorationState(...args: Parameters<MusicExplorationDatabaseApi['explorationState']>) { return this.exploration().state(...args) }
  explorationQuery(...args: Parameters<MusicExplorationDatabaseApi['explorationQuery']>) { return this.exploration().query(...args) }
  explorationDetail(...args: Parameters<MusicExplorationDatabaseApi['explorationDetail']>) { return this.exploration().detail(...args) }
  explorationRelations(...args: Parameters<MusicExplorationDatabaseApi['explorationRelations']>) { return this.exploration().relations(...args) }
  explorationParticipation(...args: Parameters<MusicExplorationDatabaseApi['explorationParticipation']>) { return this.exploration().participation(...args) }
  explorationPerformanceSave(...args: Parameters<MusicExplorationDatabaseApi['explorationPerformanceSave']>) { return this.exploration().performanceSave(...args) }
  explorationPerformanceDelete(...args: Parameters<MusicExplorationDatabaseApi['explorationPerformanceDelete']>) { return this.exploration().performanceDelete(...args) }
  explorationIngest(...args: Parameters<MusicExplorationDatabaseApi['explorationIngest']>) { return this.exploration().ingest(...args) }
  explorationSyncCredits(...args: Parameters<MusicExplorationDatabaseApi['explorationSyncCredits']>) { return this.exploration().syncCredits(...args) }
  private focus() { return (this.focusInstance ??= new LibraryDatabaseFocus({ sql: this.sql,
    transaction: action => this.transaction(action), contentRevision: () => this.getContentRevision(),
    metadataRevision: () => this.getClassificationMetadataRevision(), albumAliases: () => this.getAlbumAliases(),
    resolve: (sourceId, revision) => this.catalogResolve(sourceId, revision) })) }
  focusState() { return this.focus().state() }
  focusQuery(...args: Parameters<MusicFocusDatabaseApi['focusQuery']>) { return this.focus().query(...args) }
  focusFacets(...args: Parameters<MusicFocusDatabaseApi['focusFacets']>) { return this.focus().facets(...args) }
  focusPlaybackPage(...args: Parameters<MusicFocusDatabaseApi['focusPlaybackPage']>) { return this.focus().playbackPage(...args) }
  focusSavedList(...args: Parameters<MusicFocusDatabaseApi['focusSavedList']>) { return this.focus().savedList(...args) }
  focusSavedCreate(...args: Parameters<MusicFocusDatabaseApi['focusSavedCreate']>) { return this.focus().savedCreate(...args) }
  focusSavedRename(...args: Parameters<MusicFocusDatabaseApi['focusSavedRename']>) { return this.focus().savedRename(...args) }
  focusSavedUpdate(...args: Parameters<MusicFocusDatabaseApi['focusSavedUpdate']>) { return this.focus().savedUpdate(...args) }
  focusSavedDelete(...args: Parameters<MusicFocusDatabaseApi['focusSavedDelete']>) { return this.focus().savedDelete(...args) }
  private tags() { return new LibraryDatabaseTags({ sql: this.sql,
    transaction: action => this.transaction(action), contentRevision: () => this.getContentRevision(),
    resolve: (sourceId, revision) => this.catalog.resolve(sourceId, revision) }) }
  tagsState() { return this.tags().state() }
  tagsList(...args: Parameters<MusicTagsDatabaseApi['tagsList']>) { return this.tags().list(...args) }
  tagsEntity(...args: Parameters<MusicTagsDatabaseApi['tagsEntity']>) { return this.tags().entity(...args) }
  tagsMembers(...args: Parameters<MusicTagsDatabaseApi['tagsMembers']>) { return this.tags().members(...args) }
  tagsRecordings(...args: Parameters<MusicTagsDatabaseApi['tagsRecordings']>) { return this.tags().recordings(...args) }
  tagsCreate(...args: Parameters<MusicTagsDatabaseApi['tagsCreate']>) { return this.tags().create(...args) }
  tagsRename(...args: Parameters<MusicTagsDatabaseApi['tagsRename']>) { return this.tags().rename(...args) }
  tagsDelete(...args: Parameters<MusicTagsDatabaseApi['tagsDelete']>) { return this.tags().delete(...args) }
  tagsMemberSet(...args: Parameters<MusicTagsDatabaseApi['tagsMemberSet']>) { return this.tags().memberSet(...args) }
  tagsPlaybackPage(...args: Parameters<MusicTagsDatabaseApi['tagsPlaybackPage']>) { return this.tags().playbackPage(...args) }
  repairCandidates(
    command: import('../../shared/playlistRepair.ts').LibraryRepairCandidateCommand
  ) {
    return this.repair.execute(command)
  }
  syncListeningHistory(request: LibraryHistorySyncRequest) {
    return this.history.sync(request)
  }
  syncPlaylistView(request: import('../../shared/libraryDatabase.ts').LibraryPlaylistViewSync) {
    return this.playlistViews.sync(request)
  }
  /** Worker-internal scheduling seam; deliberately absent from the IPC allowlist. */
  preparePlaylistQuery(query: LibraryQuery, token?: symbol) {
    validateLibraryQuery(query)
    this.assertContentRevision(query.contentRevision)
    this.assertHistoryRevision(query)
    if (!query.playlistView) return { ready: true as const }
    return {
      ...this.playlistViews.prepareQuery(query, token),
      revision: Number(this.meta('revision')),
      historyRevision: this.history.revision
    }
  }
  get needsQueryMaintenance(): boolean {
    return (
      this.playlistViews.needsMaintenance ||
      this.queues.needsMaintenance ||
      this.selections.needsMaintenance ||
      !!this.statement(
        "SELECT 1 FROM scan_jobs WHERE state='completed' AND checkpoints_reclaimed=0 LIMIT 1"
      ).get()
    )
  }
  maintainQueryState(): void {
    this.playlistViews.maintenance()
    this.queues.maintenance()
    this.selections.maintenance()
    this.maintainScanCheckpoints()
  }
  /** The serial worker yields after at most 256 retired checkpoint rows.
   * Resumable jobs are never selected; terminal counters outlive their rows. */
  private maintainScanCheckpoints(): void {
    const job = this.statement(
      "SELECT id,epoch,checked_files FROM scan_jobs WHERE state='completed' AND checkpoints_reclaimed=0 ORDER BY updated_at,rowid LIMIT 1"
    ).get() as Row | undefined
    if (!job) return
    this.transaction(() => {
      if (job.checked_files === null)
        this.statement(
          'UPDATE scan_jobs SET checked_files=(SELECT count(*) FROM scan_items WHERE job_id=? AND epoch=?) WHERE id=?'
        ).run(job.id, Number(job.epoch), job.id)
      const removed = this.statement(
        'DELETE FROM scan_items WHERE rowid IN (SELECT rowid FROM scan_items WHERE job_id=? LIMIT 256)'
      ).run(job.id)
      if (Number(removed.changes) < 256)
        this.statement(
          'DELETE FROM scan_directories WHERE rowid IN (SELECT rowid FROM scan_directories WHERE job_id=? LIMIT ?)'
        ).run(job.id, 256 - Number(removed.changes))
      this.statement(
        'UPDATE scan_jobs SET checkpoints_reclaimed=1 WHERE id=? AND NOT EXISTS(SELECT 1 FROM scan_items WHERE job_id=?) AND NOT EXISTS(SELECT 1 FROM scan_directories WHERE job_id=?)'
      ).run(job.id, job.id, job.id)
    })
  }
  /** Internal action snapshot. Renderer exposure waits for an async, sender-bound
   * action consumer; the legacy synchronous Track[] selection stays unchanged. */
  createTrackSelection(request: LibrarySelectionRequest) {
    validateLibrarySelection(request)
    let prepared = this.preparePlaylistQuery(request.query)
    while (!prepared.ready) prepared = this.preparePlaylistQuery(request.query, prepared.token)
    const preparation = this.beginTrackSelectionBuild(
      request,
      'token' in prepared ? prepared.token : undefined
    )
    try {
      let result = this.advanceTrackSelectionBuild(preparation)
      while (!result.ready) result = this.advanceTrackSelectionBuild(preparation)
      return result.snapshot
    } catch (error) {
      this.abandonTrackSelectionBuild(preparation)
      throw error
    }
  }
  beginTrackSelectionBuild(
    request: LibrarySelectionRequest,
    playlistToken?: symbol
  ): LibrarySelectionPreparation {
    validateLibrarySelection(request)
    const prepared = this.preparePlaylistQuery(request.query, playlistToken)
    if (!prepared.ready) throw new Error('Prepare the playlist view before freezing selection')
    return {
      build: this.selections.begin(request),
      playlistToken: 'token' in prepared ? prepared.token : undefined
    }
  }
  advanceTrackSelectionBuild(preparation: LibrarySelectionPreparation) {
    const { request } = preparation.build
    if (!this.preparePlaylistQuery(request.query, preparation.playlistToken).ready)
      throw new Error('Playlist view changed during selection construction')
    return this.selections.advance(preparation.build)
  }
  abandonTrackSelectionBuild(preparation: LibrarySelectionPreparation): void {
    this.selections.close(preparation.build.id)
  }
  readTrackSelection(
    id: string,
    cursor = 0,
    projection: 'tracks' | 'files' = 'tracks',
    requireCurrent = false
  ) {
    return this.selections.read(id, cursor, projection, requireCurrent)
  }
  closeTrackSelection(id: string): void {
    this.selections.close(id)
  }
  resetLibrary(expectedRevision?: number) {
    return this.transaction(() => {
      this.assertContentRevision(expectedRevision)
      this.removal.assertIdle()
      const rows = this.statement(
        'SELECT tracks.id,files.file_path FROM tracks JOIN files USING(file_key) ORDER BY tracks.seq'
      ).all() as Row[]
      // Invalidate even previously claimed, still in-flight results. A reset
      // cannot be undone by a late metadata reply with a recycled file version.
      this.sql.exec(
        "UPDATE scan_jobs SET state='cancelled',epoch=epoch+1 WHERE state IN ('running','paused','interrupted'); DELETE FROM scan_release_dates; DELETE FROM tracks; DELETE FROM files;"
      )
      this.bump()
      return {
        metadata: this.getMetadata(),
        removedTrackIds: rows.map((row) => text(row.id)),
        removedFilePaths: rows.map((row) => text(row.file_path))
      }
    })
  }
  beginRemoval(id: string, mode: LocalLibraryRemovalMode, items: LocalLibraryTrackSelection[]) {
    return this.removal.begin(id, mode, items)
  }
  getPendingRemoval() {
    return this.removal.pending()
  }
  markRemovalAttempting(id: string, filePath: string) {
    return this.removal.attempting(id, filePath)
  }
  settleRemovalItem(id: string, filePath: string, succeeded: boolean, error?: string) {
    return this.removal.settle(id, filePath, succeeded, error)
  }
  finishRemoval(id: string) {
    return this.removal.finish(id)
  }
  recoverRemoval() {
    return this.removal.recover()
  }
  recoverRemovalJournal(id: string, items: LocalLibraryTrackSelection[]) {
    return this.removal.recoverLegacyJournal(id, items)
  }
  clearFileExclusions(filePaths: string[], expectedRevision?: number) {
    if (
      !Array.isArray(filePaths) ||
      filePaths.length > 256 ||
      filePaths.some((path) => typeof path !== 'string' || !path.trim())
    )
      throw new Error('Invalid exclusion batch; at most 256 files are allowed')
    return this.transaction(() => {
      this.assertContentRevision(expectedRevision)
      const keys = new Set(filePaths.map(normalizeLibraryFilePath)),
        clearedFilePaths: string[] = []
      const exclusions = this.getMetadata().exclusions.filter((entry) => {
        if (!keys.has(normalizeLibraryFilePath(entry.filePath))) return true
        clearedFilePaths.push(entry.filePath)
        return false
      })
      if (clearedFilePaths.length) {
        this.setMeta('exclusions', exclusions)
        for (const path of clearedFilePaths)
          this.statement('UPDATE files SET content_version=content_version+1 WHERE file_key=?').run(
            normalizeLibraryFilePath(path)
          )
        this.bump()
      }
      return { metadata: this.getMetadata(), clearedFilePaths }
    })
  }
  /** SQLite's online backup includes committed WAL pages, unlike copying the database file. */
  async backupTo(destination: string): Promise<void> {
    if (existsSync(destination)) throw new Error('Database backup destination already exists')
    await backup(this.sql, destination)
  }
  /** The redo token and replacement share one transaction. A lost reply is safe
   * to replay without overwriting later changes or advancing track versions twice. */
  async restoreDocument(
    document: LocalMusicLibraryDocument,
    restoreId: string,
    expectedRevision: number
  ): Promise<LibraryMetadata> {
    return this.restoreWithSnapshot(restoreId, expectedRevision, () =>
      this.replaceDocumentRecords(document, expectedRevision)
    )
  }
  private async restoreWithSnapshot<T = LibraryMetadata>(
    restoreId: string,
    expectedRevision: number,
    restore: () => T,
    replay: () => T = () => this.getMetadata() as T,
    validateSnapshot?: (snapshot: DatabaseSync) => void
  ): Promise<T> {
    if (
      !/^[a-zA-Z0-9-]{1,128}$/.test(restoreId) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    )
      throw new Error('Invalid library restore identity or revision')
    if (this.meta('last_personal_restore') === JSON.stringify(restoreId)) return replay()
    this.removal.assertIdle()
    if (Number(this.meta('revision')) !== expectedRevision)
      throw new Error('Music library changed concurrently; restore was not applied')
    if (this.filePath === ':memory:')
      throw new Error('A persistent restore requires an on-disk recovery snapshot')
    const destination = `${this.filePath}.pre-restore-${restoreId}.sqlite`
    if (!existsSync(destination)) {
      const temporary = `${destination}.${randomUUID()}.pending`
      try {
        await this.backupTo(temporary)
        renameSync(temporary, destination)
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary)
      }
    } else {
      const snapshot = new DatabaseSync(destination, { readOnly: true })
      try {
        registerLibraryRecordingFunctions(snapshot)
        if (
          Number(snapshot.prepare('PRAGMA application_id').get()?.application_id) !== 0x54574c42 ||
          snapshot.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
          Number(snapshot.prepare("SELECT value FROM meta WHERE key='revision'").get()?.value) !==
            expectedRevision
        )
          throw new Error('The existing pre-restore snapshot is not valid for this restore')
        validateSnapshot?.(snapshot)
      } finally {
        snapshot.close()
      }
    }
    return this.transaction(() => {
      if (this.meta('last_personal_restore') === JSON.stringify(restoreId))
        return replay()
      if (Number(this.meta('revision')) !== expectedRevision)
        throw new Error('Music library changed concurrently')
      this.removal.assertIdle()
      const metadata = restore()
      this.setMeta('last_personal_restore', restoreId)
      return metadata
    })
  }
  /** Conflict resolution needs identities, not complete metadata for every song. */
  private personalLibraryIdentities(): LocalMusicLibraryDocument {
    const metadata = this.getMetadata()
    return {
      version: 2,
      revision: metadata.revision,
      folders: metadata.folders,
      exclusions: metadata.exclusions,
      tracks: Array.from(
        this.statement(
          "SELECT id,json_extract(payload,'$.feedUrl') AS feedUrl,json_extract(payload,'$.streamUrl') AS streamUrl FROM tracks ORDER BY seq"
        ).iterate(),
        (row) => ({
          id: row.id,
          ...(typeof row.feedUrl === 'string' ? { feedUrl: row.feedUrl } : {}),
          ...(typeof row.streamUrl === 'string' ? { streamUrl: row.streamUrl } : {})
        })
      )
    }
  }
  previewPersonalLibrary(document: LocalMusicLibraryDocument) {
    if (!validatePersonalDomain('library', document))
      throw new Error('Invalid personal library snapshot')
    const current = this.personalLibraryIdentities()
    const row = previewPersonalBackup(
      {
        format: 'twilight-personal-data',
        version: 1,
        createdAt: new Date().toISOString(),
        data: { library: document }
      },
      { library: current }
    ).rows[0]
    return {
      incoming: row.incoming,
      current: row.current,
      conflicts: row.conflicts,
      revision: current.revision
    }
  }
  async restorePersonalLibrary(
    document: LocalMusicLibraryDocument,
    conflict: 'keep-local' | 'use-backup',
    restoreId: string,
    expectedRevision: number
  ): Promise<LibraryMetadata> {
    if (
      !validatePersonalDomain('library', document) ||
      !['keep-local', 'use-backup'].includes(conflict)
    )
      throw new Error('Invalid personal library snapshot or conflict policy')
    return this.restoreWithSnapshot(restoreId, expectedRevision, () => this.restorePersonalLibraryRecords(document, conflict))
  }
  /** Used by v1 alone and v2's same-connection bundle, never starts a nested transaction. */
  private restorePersonalLibraryRecords(document: LocalMusicLibraryDocument, conflict: 'keep-local' | 'use-backup'): LibraryMetadata {
      const merged = mergePersonalDomain(
        'library',
        this.personalLibraryIdentities(),
        document,
        conflict
      ) as LocalMusicLibraryDocument
      const incoming = new Set(document.tracks)
      const excluded = new Set(
        merged.exclusions.map((item) => normalizeLibraryFilePath(item.filePath))
      )
      this.sql.exec(
        'CREATE TEMP TABLE IF NOT EXISTS replacement_ids(id TEXT PRIMARY KEY); DELETE FROM replacement_ids;'
      )
      this.setMeta('folders', merged.folders)
      this.setMeta('exclusions', merged.exclusions)
      for (const track of merged.tracks) {
        const record = track as LibraryTrackRecord
        // Local identity-only objects refer to unchanged rows. Only selected
        // incoming records are written, preserving versions of unrelated songs.
        if (incoming.has(track)) {
          if (excluded.has(normalizeLibraryFilePath(record.filePath))) continue
          this.putTrack(record)
        }
        this.statement('INSERT INTO replacement_ids VALUES(?)').run(record.id)
      }
      this.sql.exec(
        'DELETE FROM tracks WHERE id NOT IN (SELECT id FROM replacement_ids); DELETE FROM replacement_ids;'
      )
      for (const path of excluded) this.statement('DELETE FROM tracks WHERE file_key=?').run(path)
      this.sql.exec('DELETE FROM files WHERE file_key NOT IN (SELECT file_key FROM tracks);')
      this.bump()
      return this.getMetadata()
  }
  private statement(query: string) {
    let statement = this.statements.get(query)
    if (!statement) {
      statement = this.sql.prepare(query)
      this.statements.set(query, statement)
      while (this.statements.size > 128)
        this.statements.delete(this.statements.keys().next().value!)
    }
    return statement
  }
  private transaction<T>(operation: () => T, durable = true): T {
    const revision = this.meta('revision')
    // Unpublished queue rows and already-retired cleanup may be lost on power
    // failure. Their publication/retirement records, and all library writes,
    // remain FULL: that commit also syncs preceding WAL frames. No yield occurs
    // while NORMAL is set on the shared connection.
    const execute = (): T => {
      this.sql.exec('BEGIN IMMEDIATE')
      try {
        const result = operation()
        this.sql.exec('COMMIT')
        if (this.meta('revision') !== revision) {
          this.ordered.clear()
          this.totals.clear()
          this.albumAliases = null
          this.symSpellIndex = null
          this.collections.clear()
        }
        return result
      } catch (error) {
        if (this.sql.isTransaction) this.sql.exec('ROLLBACK')
        throw error
      }
    }
    if (durable) return execute()
    this.sql.exec('PRAGMA synchronous=NORMAL')
    let outcome: { ok: true; value: T } | { ok: false; error: unknown }
    try {
      outcome = { ok: true, value: execute() }
    } catch (error) {
      outcome = { ok: false, error }
    }
    try {
      this.sql.exec('PRAGMA synchronous=FULL')
    } catch (error) {
      // Fail closed: a later scan/patch must never inherit NORMAL if the
      // connection cannot restore its durability before returning to service.
      try {
        this.sql.close()
      } catch {
        /* The worker exits on this fatal error. */
      }
      throw new LibraryDatabaseDurabilityError(
        `Cannot restore database durability: ${String(error)}`
      )
    }
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }
  private meta(key: string): string {
    return text((this.statement('SELECT value FROM meta WHERE key=?').get(key) as Row)?.value)
  }
  private setMeta(key: string, value: unknown): void {
    this.statement('INSERT OR REPLACE INTO meta VALUES(?,?)').run(
      key,
      stringifyJsonWithNestingLimit(value, 'library metadata')
    )
  }
  private bump(): number {
    const revision = Number(this.meta('revision')) + 1
    this.setMeta('revision', revision)
    return revision
  }
  getMetadata(): LibraryMetadata {
    return {
      revision: Number(this.meta('revision')),
      trackCount: Number((this.statement('SELECT count(*) AS n FROM tracks').get() as Row).n),
      fileCount: Number((this.statement('SELECT count(*) AS n FROM files').get() as Row).n),
      folders: JSON.parse(this.meta('folders')),
      exclusions: JSON.parse(this.meta('exclusions'))
    }
  }
  getContentRevision(): number {
    return Number(this.meta('revision'))
  }
  updateConfiguration(
    configuration: Pick<LibraryMetadata, 'folders' | 'exclusions'>,
    expectedRevision?: number
  ): LibraryMetadata {
    return this.transaction(() => {
      if (expectedRevision !== undefined && expectedRevision !== Number(this.meta('revision')))
        throw new Error('Music library changed concurrently')
      if (
        !Array.isArray(configuration.folders) ||
        configuration.folders.some((folder) => typeof folder !== 'string' || !folder.trim()) ||
        !Array.isArray(configuration.exclusions)
      )
        throw new Error('Invalid library configuration')
      this.setMeta('folders', configuration.folders)
      this.setMeta('exclusions', configuration.exclusions)
      for (const exclusion of configuration.exclusions) {
        if (!exclusion || typeof exclusion.filePath !== 'string' || !exclusion.filePath)
          throw new Error('Invalid library exclusion')
        this.statement('DELETE FROM tracks WHERE file_key=?').run(
          normalizeLibraryFilePath(exclusion.filePath)
        )
      }
      this.bump()
      return this.getMetadata()
    })
  }
  setLibraryRoots(folders: string[]): LibraryMetadata {
    if (
      !Array.isArray(folders) ||
      folders.some((folder) => typeof folder !== 'string' || !folder.trim())
    )
      throw new Error('Invalid library roots')
    return this.transaction(() => {
      if (JSON.stringify(folders) !== this.meta('folders')) {
        this.setMeta('folders', folders)
        this.bump()
      }
      return this.getMetadata()
    })
  }
  exportDocument(options: LibraryDocumentExportOptions = {}): LocalMusicLibraryDocument {
    if (
      options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    )
      throw new Error('Invalid library export capacity')
    const metadata = this.getMetadata()
    const document: LocalMusicLibraryDocument = {
      version: 2,
      revision: metadata.revision,
      tracks: [],
      folders: metadata.folders,
      exclusions: metadata.exclusions
    }
    const replacer = options.redactPrivateData ? personalBackupJsonReplacer : undefined
    let bytes = Buffer.byteLength(JSON.stringify(document, replacer))
    const checkSize = () => {
      if (options.maxBytes !== undefined && bytes > options.maxBytes)
        throw new Error('library 数据超过容量限制，未截断导出')
    }
    checkSize()
    // Stop at the capacity boundary before hydrating the rest of a large library.
    for (const row of this.statement('SELECT payload FROM tracks ORDER BY seq').iterate()) {
      const payload = text(row.payload)
      const track = JSON.parse(payload)
      const serialized = replacer ? JSON.stringify(track, replacer) : payload
      bytes += Buffer.byteLength(serialized) + (document.tracks.length ? 1 : 0)
      checkSize()
      document.tracks.push(replacer ? JSON.parse(serialized) : track)
    }
    return document
  }
  replaceDocument(document: LocalMusicLibraryDocument, expectedRevision?: number): LibraryMetadata {
    return this.transaction(() => this.replaceDocumentRecords(document, expectedRevision))
  }
  private replaceDocumentRecords(
    document: LocalMusicLibraryDocument,
    expectedRevision?: number
  ): LibraryMetadata {
    this.removal.assertIdle()
    if (expectedRevision !== undefined && expectedRevision !== Number(this.meta('revision')))
      throw new Error('Music library changed concurrently')
    this.sql.exec(
      'CREATE TEMP TABLE IF NOT EXISTS replacement_ids(id TEXT PRIMARY KEY); DELETE FROM replacement_ids;'
    )
    this.setMeta('folders', document.folders)
    this.setMeta('exclusions', document.exclusions)
    const excluded = new Set(
      document.exclusions.map((item) => normalizeLibraryFilePath(item.filePath))
    )
    for (const track of document.tracks) {
      if (!isRecord(track) || typeof track.id !== 'string' || typeof track.filePath !== 'string')
        throw new Error('Invalid library track')
      if (!excluded.has(normalizeLibraryFilePath(track.filePath))) {
        this.statement('INSERT INTO replacement_ids VALUES(?)').run(track.id)
        this.putTrack(track as LibraryTrackRecord)
      }
    }
    this.sql.exec(
      'DELETE FROM tracks WHERE id NOT IN (SELECT id FROM replacement_ids); DELETE FROM files WHERE file_key NOT IN (SELECT file_key FROM tracks); DELETE FROM replacement_ids;'
    )
    this.bump()
    return this.getMetadata()
  }
  private putTrack(track: LibraryTrackRecord): boolean {
    if (!track.id || !track.filePath)
      throw new Error('A database track requires its original id and path')
    const key = normalizeLibraryFilePath(track.filePath)
    this.statement('INSERT OR IGNORE INTO files(file_key,file_path) VALUES(?,?)').run(
      key,
      track.filePath
    )
    const name = text(track.title).trim(),
      artist = text(track.artist).trim(),
      album = text(track.album).trim()
    const folder = text(track.dir) || dirname(track.filePath)
    const format = text(track.format).trim()
    // A release's identity is stored independently from its display name.
    const albumKey = getAlbumIdentity({
      filePath: track.filePath,
      album,
      artist,
      albumArtist: text(track.albumArtist),
      albumId: text(track.albumId),
      dir: text(track.dir)
    })
    const fields = [
      ...[name, artist, album].map(normalizeSearch),
      ...[name, artist, album].map(getPinyinInitials)
    ]
    const searchText = fields.join('\u001f')
    const n = (value: unknown, missing = 0) =>
      typeof value === 'number' && Number.isFinite(value) ? value : missing
    const result = this.statement(
      `INSERT INTO tracks(id,file_key,payload,title,artist,album,album_key,folder,format,search_text,search_file,duration,sample_rate,bit_depth,added_at,disc_no,track_no,file_name,lossless,dsd,last_played,playlist_path,playlist_path_reverse)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE((SELECT last_played FROM library_history WHERE id=?),0),?,?) ON CONFLICT(id) DO UPDATE SET file_key=excluded.file_key,version=tracks.version+1,payload=excluded.payload,title=excluded.title,artist=excluded.artist,album=excluded.album,album_key=excluded.album_key,folder=excluded.folder,format=excluded.format,search_text=excluded.search_text,search_file=excluded.search_file,duration=excluded.duration,sample_rate=excluded.sample_rate,bit_depth=excluded.bit_depth,added_at=excluded.added_at,disc_no=excluded.disc_no,track_no=excluded.track_no,file_name=excluded.file_name,lossless=excluded.lossless,dsd=excluded.dsd,playlist_path=excluded.playlist_path,playlist_path_reverse=excluded.playlist_path_reverse WHERE tracks.payload<>excluded.payload OR tracks.file_key<>excluded.file_key`
    ).run(
      track.id,
      key,
      stringifyJsonWithNestingLimit(track, 'library track'),
      name,
      artist,
      album,
      albumKey,
      normalizeLibraryFilePath(folder),
      format,
      searchText,
      normalizeSearch(text(track.fileName)),
      n(track.duration),
      n(track.sampleRate),
      n(track.bitDepth),
      n(track.addedAt),
      albumOrderIndex(typeof track.discNumber === 'number' ? track.discNumber : undefined),
      albumOrderIndex(typeof track.trackNumber === 'number' ? track.trackNumber : undefined),
      text(track.fileName),
      lossless.has(format.toLowerCase()) || n(track.bitDepth) >= 16 ? 1 : 0,
      ['dsf', 'dff', 'dsd', 'sacd iso'].includes(format.toLowerCase()) ? 1 : 0,
      track.id,
      normalizePortableLibraryPath(track.filePath),
      reversePlaylistPath(normalizePortableLibraryPath(track.filePath))
    )
    return Number(result.changes) > 0
  }
  importTrack(track: unknown): void {
    if (!isRecord(track) || typeof track.id !== 'string' || typeof track.filePath !== 'string')
      throw new Error('Invalid legacy library track')
    if (this.statement('SELECT 1 FROM tracks WHERE id=?').get(track.id))
      throw new Error(`Duplicate legacy track identity: ${track.id}`)
    this.putTrack(track as LibraryTrackRecord)
  }
  importHeader(field: string, value: unknown): void {
    if (field === 'revision') {
      if (!Number.isSafeInteger(value) || Number(value) < 0)
        throw new Error('Invalid library revision')
      this.setMeta(field, value)
    } else if (field === 'version' && value !== 1 && value !== 2)
      throw new Error('Unsupported legacy library version')
  }
  importArrays(folders: string[], exclusions: LocalMusicLibraryDocument['exclusions']): void {
    const records = [
      ...new Map(exclusions.map((item) => [normalizeLibraryFilePath(item.filePath), item])).values()
    ]
    this.setMeta('folders', folders)
    this.setMeta('exclusions', records)
    for (const item of records)
      this.statement('DELETE FROM tracks WHERE file_key=?').run(
        normalizeLibraryFilePath(item.filePath)
      )
  }
  importIdentity(identity: LocalLibraryFileIdentity): void {
    const key = normalizeLibraryFilePath(identity.filePath)
    this.statement('UPDATE files SET identity=?,metadata_version=? WHERE file_key=?').run(
      JSON.stringify(identity),
      identity.metadataVersion ?? 0,
      key
    )
  }
  /** Only compact grouping keys are retained; album members remain in SQL. */
  private getAlbumAliases(): Map<string, string[]> {
    this.scheduleTransientIndexRelease()
    if (this.albumAliases) return this.albumAliases
    const rows = this.statement(
      `SELECT album_key,album,min(seq) AS first_seq,
      CASE WHEN tracks.album_key LIKE 'dir:%' THEN (SELECT json_extract(t.payload,'$.cover') FROM tracks t WHERE t.album_key=tracks.album_key AND COALESCE(json_extract(t.payload,'$.cover'),'')<>'' ORDER BY seq LIMIT 1) END AS cover,
      CASE WHEN tracks.album_key LIKE 'dir:%' THEN (SELECT json_extract(t.payload,'$.coverSource') FROM tracks t WHERE t.album_key=tracks.album_key AND COALESCE(json_extract(t.payload,'$.cover'),'')<>'' ORDER BY seq LIMIT 1) END AS cover_source
      FROM tracks GROUP BY album_key ORDER BY first_seq`
    ).all() as Row[]
    const aliases = new Map<string, string[]>(),
      byEvidence = new Map<string, string>()
    for (const row of rows) {
      const base = text(row.album_key)
      const cover = getAlbumCoverIdentity({
        filePath: '',
        cover: text(row.cover),
        coverSource: text(row.cover_source)
      })
      const evidence =
        base.startsWith('dir:') && cover
          ? `${cover}\u001f${base.slice(base.lastIndexOf('\u001f') + 1)}`
          : ''
      const id = evidence ? (byEvidence.get(evidence) ?? base) : base
      if (evidence && !byEvidence.has(evidence)) byEvidence.set(evidence, id)
      const keys = aliases.get(id) ?? []
      keys.push(base)
      aliases.set(id, keys)
    }
    this.albumAliases = aliases
    return aliases
  }
  private getSymSpellIndex(): SymSpellIndex {
    this.scheduleTransientIndexRelease()
    if (this.symSpellIndex) return this.symSpellIndex
    const symSpell = new SymSpellIndex()
    for (const row of this.statement('SELECT title,artist,album FROM tracks ORDER BY seq').iterate()) {
      symSpell.addTrack({
        title: text(row.title),
        artist: text(row.artist),
        album: text(row.album)
      })
    }
    this.symSpellIndex = symSpell
    return symSpell
  }
  private buildSearchPredicate(
    query: LibraryQuery,
    searchStr: string,
    useFts: boolean,
    add: (sql: string, ...values: SQLInputValue[]) => void
  ): void {
    if (query.sort === 'unifiedSearch' && !query.searchLiteral) {
      const pq = prepareSearchQuery(searchStr)
      if (!pq.fullNormalized) return
      for (const token of pq.isMultiToken ? pq.tokens : [pq.fullNormalized]) {
        if (useFts && [...token].length >= 3)
          add(
            query.playlistView
              ? 'uid IN (SELECT rowid FROM playlist_search WHERE playlist_search MATCH ?)'
              : 'seq IN (SELECT rowid FROM track_search WHERE track_search MATCH ?)',
            `${query.searchFileName ? '' : 'search_text:'}"${token}"`
          )
        add(
          query.searchFileName
            ? '(instr(search_text,?)>0 OR instr(search_file,?)>0)'
            : 'instr(search_text,?)>0',
          ...(query.searchFileName ? [token, token] : [token])
        )
      }
      return
    }
    const q = normalizeSearch(searchStr)
    if (q) {
      if (!query.searchLiteral && useFts && [...q].length >= 3)
        add(
          query.playlistView
            ? 'uid IN (SELECT rowid FROM playlist_search WHERE playlist_search MATCH ?)'
            : 'seq IN (SELECT rowid FROM track_search WHERE track_search MATCH ?)',
          `${query.searchFileName ? '' : 'search_text:'}"${q}"`
        )
      if (!query.searchLiteral)
        add(
          query.searchFileName
            ? '(instr(search_text,?)>0 OR instr(search_file,?)>0)'
            : 'instr(search_text,?)>0',
          ...(query.searchFileName ? [q, q] : [q])
        )
    }
    if (query.searchLiteral && searchStr.trim())
      add(
        'library_metadata_contains(title,artist,album,?)=1',
        searchStr.trim().toLocaleLowerCase('zh-CN')
      )
  }
  private resolveUnifiedSearch(query: LibraryQuery): {
    effectiveSearch: string
    typoPenaltyFactor: number
  } {
    if (
      query.sort !== 'unifiedSearch' ||
      query.searchLiteral ||
      !query.search?.trim() ||
      query.playlistView
    ) {
      return { effectiveSearch: query.search ?? '', typoPenaltyFactor: 1 }
    }
    const pq = prepareSearchQuery(query.search)
    if (!pq.fullNormalized) {
      return { effectiveSearch: query.search, typoPenaltyFactor: 1 }
    }
    if (pq.tokens.some((t) => getMaxSymSpellTolerance(t) > 0)) {
      const directWhere = this.whereWithSearch(query, query.search, true)
      const hasDirect = !!this.statement(`SELECT 1 FROM tracks ${directWhere.sql} LIMIT 1`).get(
        ...directWhere.params
      )
      if (!hasDirect) {
        const suggestion = this.getSymSpellIndex().suggestQuery(query.search)
        if (suggestion) {
          return {
            effectiveSearch: suggestion.correctedQuery,
            typoPenaltyFactor: suggestion.penaltyFactor
          }
        }
      }
    }
    return { effectiveSearch: query.search, typoPenaltyFactor: 1 }
  }
  private where(query: LibraryQuery, useFts = true): { sql: string; params: SQLInputValue[] } {
    const searchStr =
      query.sort === 'unifiedSearch'
        ? this.resolveUnifiedSearch(query).effectiveSearch
        : (query.search ?? '')
    return this.whereWithSearch(query, searchStr, useFts)
  }
  private whereWithSearch(
    query: LibraryQuery,
    searchStr: string,
    useFts = true
  ): { sql: string; params: SQLInputValue[] } {
    const conditions: string[] = [],
      params: SQLInputValue[] = []
    const add = (sql: string, ...values: SQLInputValue[]) => {
      conditions.push(sql)
      params.push(...values)
    }
    this.buildSearchPredicate(query, searchStr, useFts, add)
    if (query.folder) {
      const folder = normalizeLibraryPath(query.folder)
      const column =
        "library_normalize_path(library_collection_directory(json_extract(payload,'$.filePath'),json_extract(payload,'$.dir'),?))"
      const roots = this.meta('folders')
      if (query.recursive)
        add(
          `(${column}=? OR substr(${column},1,?)=?)`,
          roots,
          folder,
          roots,
          folder.length + 1,
          `${folder}\\`
        )
      else add(`${column}=?`, roots, folder)
    }
    if (query.artist)
      add(
        "library_has_artist(artist,CASE WHEN json_type(payload,'$.artists')='array' THEN json_extract(payload,'$.artists') ELSE NULL END,json_extract(payload,'$.identityTags'),?)=1",
        query.artist
      )
    if (query.albumId)
      add(
        'album_key IN (SELECT value FROM json_each(?))',
        JSON.stringify(this.getAlbumAliases().get(query.albumId) ?? [query.albumId])
      )
    if (query.genre) {
      // The function shares the exact configurable genre splitting rules with the renderer.
      add(
        "library_has_genre(json_extract(payload,'$.genre'),?,?)=1",
        query.genre,
        query.genreSeparators ?? ''
      )
    }
    if (query.ids) add('id IN (SELECT value FROM json_each(?))', JSON.stringify(query.ids))
    const f = query.filters
    if (f?.lossless) add('lossless=1')
    if (f?.dsd) add('dsd=1')
    if (f?.sampleRate !== undefined) add('sample_rate=?', f.sampleRate)
    if (f?.bitDepth !== undefined) add('bit_depth=?', f.bitDepth)
    if (f?.folder) add('folder=?', normalizeLibraryFilePath(f.folder))
    if (f?.provider) {
      if (query.playlistView) add('provider=?', f.provider)
      else if (f.provider !== 'local') add('0')
    }
    return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params }
  }
  private queryStats(
    where: { sql: string; params: SQLInputValue[] },
    occurrences?: string[]
  ): {
    total: number
    totalDuration: number
  } {
    const key = JSON.stringify([this.meta('revision'), where.sql, where.params, occurrences])
    const cached = this.totals.get(key)
    if (cached !== undefined) return cached
    const source = occurrences
      ? `json_each(?) member JOIN (SELECT id,duration FROM tracks ${where.sql}) t ON t.id=member.value`
      : `tracks ${where.sql}`
    const row = this.statement(
      `SELECT count(*) AS n,sum(CASE WHEN duration>0 THEN duration ELSE 0 END) AS duration FROM ${source}`
    ).get(...(occurrences ? [JSON.stringify(occurrences)] : []), ...where.params) as Row
    const stats = { total: Number(row.n), totalDuration: Number(row.duration) }
    this.totals.set(key, stats)
    while (this.totals.size > 32) this.totals.delete(this.totals.keys().next().value!)
    return stats
  }
  private orderedIds(query: LibraryQuery): string[] {
    const resolvedSearch = query.sort === 'unifiedSearch' ? this.resolveUnifiedSearch(query) : null
    const { sql, params } =
      resolvedSearch !== null
        ? this.whereWithSearch(query, resolvedSearch.effectiveSearch)
        : this.where(query)
    const direction =
      query.sort === 'recentlyAdded' || (query.sort !== 'playlist' && query.direction === 'desc')
        ? -1
        : 1
    const sort = query.sort ?? 'title'
    // Listening ticks must not evict expensive text-sort orders. Only history
    // order keys depend on its separate revision; all orders share the same bound.
    const key = JSON.stringify([
      Number(this.meta('revision')),
      sql,
      params,
      sort,
      direction,
      sort === 'unifiedSearch' ? (query.preferredSources ?? []) : null,
      sort === 'unifiedSearch' ? (query.search ?? '') : null,
      sort === 'lastPlayed' ? this.history.revision : null
    ])
    const cached = this.ordered.get(key)
    if (cached) {
      this.ordered.delete(key)
      this.ordered.set(key, cached)
      return cached
    }
    const numeric = numericSorts[sort]
    let ids: string[]
    if (sort === 'playlist' && query.ids)
      ids = (
        this.statement(
          `SELECT selected.id FROM json_each(?) member JOIN (SELECT id FROM tracks ${sql}) selected ON selected.id=member.value ORDER BY CAST(member.key AS INTEGER)`
        ).all(JSON.stringify(query.ids), ...params) as Row[]
      ).map((row) => text(row.id))
    else if (sort === 'unifiedSearch')
      ids = unifiedLibraryOrder(
        this.sql,
        sql,
        params,
        query.preferredSources ?? [],
        direction,
        {
          search: resolvedSearch!.effectiveSearch,
          typoPenaltyFactor: resolvedSearch!.typoPenaltyFactor,
          searchFileName: Boolean(query.searchFileName)
        }
      )
    else if (numeric)
      ids = (
        this.statement(
          `SELECT id FROM tracks ${sql} ORDER BY ${numeric} ${direction < 0 ? 'DESC' : 'ASC'},seq ${sort === 'recentlyAdded' ? 'DESC' : 'ASC'}`
        ).all(...params) as Row[]
      ).map((row) => text(row.id))
    else {
      const column = textSorts[sort] ?? 'title'
      const rows = this.statement(
        `SELECT id,seq,${column} AS value${sort === 'trackNumber' ? ',disc_no,track_no,file_name,title' : ''} FROM tracks ${sql}`
      ).all(...params) as Row[]
      rows.sort((a, b) => {
        const comparison =
          sort === 'trackNumber'
            ? Number(a.disc_no) - Number(b.disc_no) ||
              Number(a.track_no) - Number(b.track_no) ||
              natural.compare(text(a.file_name), text(b.file_name)) ||
              collator.compare(text(a.title), text(b.title))
            : collator.compare(text(a.value), text(b.value))
        return comparison * direction || Number(a.seq) - Number(b.seq)
      })
      ids = rows.map((row) => text(row.id))
    }
    this.ordered.set(key, ids)
    while (this.ordered.size > 3) this.ordered.delete(this.ordered.keys().next().value!)
    return ids
  }
  queryTracks(query: LibraryQuery = {}): LibraryPage {
    validateLibraryQuery(query)
    this.assertContentRevision(query.contentRevision)
    this.assertHistoryRevision(query)
    if (query.playlistView) return this.catalogReferences.tracks(this.playlistViews.query(query))
    const { offset, limit } = libraryPageBounds(query.offset, query.limit)
    if (query.anchorId !== undefined) {
      const ids = this.orderedIds(query)
      const anchorIndex = ids.indexOf(query.anchorId)
      const start = anchorIndex < 0 ? offset : Math.floor(anchorIndex / limit) * limit
      return {
        ...this.getTracksByIds(ids.slice(start, start + limit)),
        totalDuration: this.queryStats(
          this.where(query),
          query.sort === 'playlist' ? query.ids : undefined
        ).totalDuration,
        total: ids.length,
        offset: start,
        anchorIndex
      }
    }
    const sort = query.sort ?? 'title'
    const numeric = numericSorts[sort]
    if (numeric && !(sort === 'playlist' && query.ids)) {
      const where = this.where(query),
        stats = this.queryStats(where),
        total = stats.total
      // A common trigram (e.g. a shared artist's initials) can match the entire
      // library. Sorting that candidate set on every page defeats numeric indexes.
      // The exact predicate is unchanged; only the candidate strategy differs.
      const broad =
        !!query.search &&
        total >= Math.max(LIBRARY_PAGE_SIZE, this.queryStats({ sql: '', params: [] }).total / 8)
      const { sql, params } = broad ? this.where(query, false) : where
      // The rowid table carries large payloads. For unfiltered insertion pages,
      // skip OFFSET in its compact sequence index and fetch only the page's rows.
      // Filtered queries retain the planner's choice (or the broad-search hint).
      const indexName =
        numeric === 'seq' && !sql ? 'tracks_insertion' : broad ? numericIndexes[sort] : undefined
      const index = indexName ? ` INDEXED BY ${indexName}` : ''
      return {
        ...this.page(
          this.statement(
            `SELECT id,payload,version FROM tracks${index} ${sql} ORDER BY ${numeric} ${sort === 'recentlyAdded' || (sort !== 'playlist' && query.direction === 'desc') ? 'DESC' : 'ASC'},seq ${sort === 'recentlyAdded' ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`
          ).all(...params, limit, offset) as Row[],
          total,
          offset
        ),
        totalDuration: stats.totalDuration
      }
    }
    return this.orderedTrackPage(query, offset, limit)
  }
  private orderedTrackPage(query: LibraryQuery, offset: number, limit: number): LibraryPage {
    const ids = this.orderedIds(query)
    const page = this.getTracksByIds(ids.slice(offset, offset + limit))
    return {
      ...page,
      total: ids.length,
      offset,
      totalDuration: this.queryStats(
        this.where(query),
        query.sort === 'playlist' ? query.ids : undefined
      ).totalDuration
    }
  }
  private page(rows: Row[], total: number, offset = 0): LibraryPage {
    const versions: Record<string, number> = Object.create(null)
    const tracks = rows.map((row) => {
      versions[text(row.id)] = Number(row.version)
      return JSON.parse(text(row.payload)) as LibraryTrackRecord
    })
    return this.catalogReferences.tracks({
      tracks,
      versions,
      total,
      revision: Number(this.meta('revision')),
      offset,
      historyRevision: this.history.revision
    })
  }
  private assertContentRevision(expectedRevision?: number): void {
    if (
      expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    )
      throw new Error('Invalid library content revision')
    if (expectedRevision !== undefined && expectedRevision !== Number(this.meta('revision')))
      throw new Error('曲库在读取期间发生变化，请重新操作')
  }
  lookupPlaylistTracks(request: LibraryPlaylistLookupRequest, expectedRevision?: number) {
    validateLibraryPlaylistLookup(request)
    this.assertContentRevision(expectedRevision)
    return {
      ids: lookupPlaylistTrackIds(this.sql, request),
      revision: Number(this.meta('revision'))
    }
  }
  lookupTracksByPaths(paths: string[], expectedRevision?: number) {
    validateLibraryIds(paths)
    if (paths.some((path) => path.includes('\0'))) throw new Error('Invalid library playlist path')
    this.assertContentRevision(expectedRevision)
    const ids = paths.map((path) => {
      const key = normalizePortableLibraryPath(path)
      const exact = this.statement(
        'SELECT id FROM tracks WHERE playlist_path=? ORDER BY seq DESC LIMIT 1'
      ).get(key) as Row | undefined
      if (exact) return text(exact.id)
      if (!key || /^[a-zA-Z]:\\/.test(key) || key.startsWith('\\')) return null
      const prefix = reversePlaylistPath(`\\${key}`)
      // A reversed relative suffix always ends in a separator, so the next
      // binary prefix is obtained by replacing its final backslash with ']'.
      // Unlike LIKE, '%' and '_' are ordinary filename characters here.
      const rows = this.statement(
        'SELECT id FROM tracks WHERE playlist_path_reverse>=? AND playlist_path_reverse<? LIMIT 2'
      ).all(prefix, prefix.slice(0, -1) + ']') as Row[]
      return rows.length === 1 ? text(rows[0].id) : null
    })
    return { ids, revision: Number(this.meta('revision')) }
  }
  getTracksByIds(ids: string[], expectedRevision?: number): LibraryPage {
    validateLibraryIds(ids)
    this.assertContentRevision(expectedRevision)
    const rows = this.statement(
      'SELECT t.id,t.payload,t.version FROM json_each(?) j JOIN tracks t ON t.id=j.value ORDER BY CAST(j.key AS INTEGER)'
    ).all(JSON.stringify(ids)) as Row[]
    return this.page(rows, rows.length)
  }
  readDuplicateCandidates(
    after = 0,
    limit = LIBRARY_MAX_PAGE_SIZE,
    expectedRevision?: number
  ): LibraryDuplicateCandidatePage {
    libraryPageBounds(after, limit)
    const revision = Number(this.meta('revision'))
    if (expectedRevision !== undefined && expectedRevision !== revision)
      throw new Error('曲库在重复检测读取期间发生变化，请在扫描或编辑完成后重试')
    // SQL extracts only the detector's existing fields. Large embedded covers,
    // lyrics, analysis and extension data never enter the worker IPC response.
    const rows = this.statement(
      `SELECT seq,json_object(
      'id',id,'filePath',json_extract(payload,'$.filePath'),
      'subTrack',json_extract(payload,'$.subTrack'),'cueRange',json_extract(payload,'$.cueRange'),
      'title',json_extract(payload,'$.title'),'artist',json_extract(payload,'$.artist'),
      'album',json_extract(payload,'$.album'),'duration',json_extract(payload,'$.duration'),
      'size',json_extract(payload,'$.size'),'sampleRate',json_extract(payload,'$.sampleRate'),
      'bitrate',json_extract(payload,'$.bitrate'),'format',json_extract(payload,'$.format'),
      'contentHash',json_extract(payload,'$.contentHash'),
      'audioFingerprint',json_extract(payload,'$.audioFingerprint')) AS candidate
      FROM tracks WHERE seq>? ORDER BY seq LIMIT ?`
    ).all(after, limit) as Row[]
    return {
      items: rows.map((row) => toDuplicateCandidate(JSON.parse(text(row.candidate)))),
      revision,
      nextCursor: rows.length === limit ? Number(rows.at(-1)!.seq) : null
    }
  }
  patchTracks(patches: LibraryTrackPatch[]): LibraryPage {
    if (!Array.isArray(patches) || patches.length > LIBRARY_MAX_PAGE_SIZE)
      throw new Error('Too many track patches')
    return this.transaction(() => {
      for (const item of patches) {
        if (
          !item ||
          typeof item.id !== 'string' ||
          !Number.isSafeInteger(item.expectedVersion) ||
          item.expectedVersion < 1 ||
          !isRecord(item.patch)
        )
          throw new Error('Invalid library track patch')
        const row = this.statement('SELECT payload,version,file_key FROM tracks WHERE id=?').get(
          item.id
        ) as Row | undefined
        if (!row || Number(row.version) !== item.expectedVersion)
          throw new Error(`Music library track changed concurrently: ${item.id}`)
        this.removal.assertTrackWritable(text(row.file_key))
        if ('id' in item.patch || 'filePath' in item.patch)
          throw new Error('Track identity cannot be patched')
        this.putTrack({ ...JSON.parse(text(row.payload)), ...item.patch })
      }
      if (patches.length) this.bump()
      return this.getTracksByIds(patches.map((item) => item.id))
    })
  }
  queryCollections(kind: LibraryCollectionKind, query: LibraryQuery = {}, metadata?: import('../../shared/entityMetadata.ts').EntityMetadataReadOptions): LibraryCollectionPage {
    validateLibraryQuery(query)
    this.assertContentRevision(query.contentRevision)
    if (kind === 'playlists') {
      if (!query.playlistView) throw new Error('Playlist summaries require a catalog view')
      return this.playlistViews.collections(query)
    }
    if (query.playlistView)
      throw new Error('Playlist views support track queries, not collection summaries')
    // Search selects collections, not a subset of their members. Counts and
    // album details still describe the complete collection in the requested scope.
    const selection = this.where({ ...query, search: undefined }), aliases = kind === 'albums' ? this.getAlbumAliases() : new Map<string, string[]>()
    const page = this.collections.query(
      kind,
      query,
      Number(this.meta('revision')),
      JSON.parse(this.meta('folders')),
      selection,
      aliases,
      (sql, params) => this.statement(sql).all(...params) as Row[]
    )
    const referenced = kind === 'albums' || kind === 'artists' ? this.catalogReferences.collections(page, kind, selection, aliases) : page
    return kind === 'albums' && metadata ? this.entityMetadata.collectionDates(referenced, metadata) : referenced
  }
  createLibraryQueue(query: LibraryQuery, selectedId?: string): LibraryQueueSnapshot {
    validateLibraryQuery(query)
    this.assertHistoryRevision(query)
    this.assertContentRevision(query.contentRevision)
    if (query.playlistView) {
      const plan = this.playlistViews.queuePlan(query, selectedId)
      return this.transaction(() => this.queues.createPlaylist(plan))
    }
    return this.transaction(() => {
      this.assertContentRevision(query.contentRevision)
      const ids = this.orderedIds(query)
      const index = selectedId ? ids.indexOf(selectedId) : 0
      if (selectedId && index < 0) throw new Error('Selected track is not in the query')
      return this.queues.create(ids, index)
    })
  }
  /** Main/worker-only streaming builder; renderer exposure requires a bounded
   * owner lease and atomic player adoption, not direct calls to this seam. */
  buildLibraryQueue(command: import('../../shared/libraryQueueBuild.ts').LibraryQueueBuildCommand) {
    return this.queues.stream(command)
  }
  importLegacyPlaybackQueue(
    command: import('../../shared/coreQueueImport.ts').CoreQueueImportCommand
  ) {
    return this.queues.importLegacyPlaybackQueue(command)
  }
  restoreNamedPlaybackQueue(
    command: import('../../shared/coreQueueRestore.ts').CoreQueueRestoreCommand
  ) {
    return this.queues.restoreNamedPlaybackQueue(command)
  }
  extendPlaybackQueue(id: string, revision: number, items: LibraryQueueInsertItem[]) {
    return this.queues.extend(id, revision, items)
  }
  insertCorePlaybackQueue(id: string, revision: number, edit: Extract<LibraryQueueEdit, { kind: 'insert' }>) {
    return this.queues.edit(id, revision, edit, false, true)
  }
  clonePlaybackQueue(reference: LibraryPlaybackQueueReference) {
    return this.queues.clonePlaybackQueue(reference)
  }
  restoreHeartBaseQueue(base: LibraryPlaybackQueueReference, selectedTrackId: string) {
    return this.queues.restoreHeartBaseQueue(base, selectedTrackId)
  }
  replacePlaybackQueueSource(
    command: import('../../shared/coreSourceRecovery.ts').CoreQueueSourceReplacement
  ) {
    return this.queues.replaceSource(command)
  }
  get nextQueueBuildExpiry(): number | undefined {
    return this.queues.nextStreamExpiry
  }
  /** Internal cooperative path. The service prepares a view before beginning
   * and owns this continuation until publication or explicit abandonment. */
  beginLibraryQueueBuild(
    query: LibraryQuery,
    selectedId?: string,
    playlistToken?: symbol
  ): LibraryQueuePreparation {
    validateLibraryQuery(query)
    this.assertHistoryRevision(query)
    this.assertContentRevision(query.contentRevision)
    const contentRevision = Number(this.meta('revision')),
      historyRevision = query.sort === 'lastPlayed' ? this.history.revision : undefined
    if (query.playlistView) {
      const view = this.playlistViews.prepareQuery(query, playlistToken)
      if (!view.ready)
        throw new Error('Prepare the complete playlist view before building its queue')
      const plan = this.playlistViews.queuePlan(query, selectedId)
      return {
        build: this.queues.beginBuild({ kind: 'playlist', ...plan }),
        contentRevision,
        historyRevision,
        playlist: { id: query.playlistView, token: view.token }
      }
    }
    const ids = this.orderedIds(query),
      index = selectedId ? ids.indexOf(selectedId) : 0
    if (selectedId && index < 0) throw new Error('Selected track is not in the query')
    return {
      build: this.queues.beginBuild({ kind: 'tracks', ids, index }),
      contentRevision,
      historyRevision
    }
  }
  advanceLibraryQueueBuild(preparation: LibraryQueuePreparation) {
    this.assertContentRevision(preparation.contentRevision)
    this.assertHistoryRevision({ sort: 'lastPlayed', historyRevision: preparation.historyRevision })
    if (
      preparation.playlist &&
      !this.playlistViews.prepare(preparation.playlist.id, preparation.playlist.token).ready
    )
      throw new Error('Playlist view changed during queue construction')
    return this.queues.advanceBuild(preparation.build)
  }
  abandonLibraryQueueBuild(preparation: LibraryQueuePreparation): void {
    this.queues.abandonBuild(preparation.build)
  }
  private assertHistoryRevision(query: LibraryQuery): void {
    if (
      query.sort === 'lastPlayed' &&
      query.historyRevision !== undefined &&
      query.historyRevision !== this.history.revision
    )
      throw Object.assign(
        new Error('Listening history changed; refresh its order before retrying'),
        { code: 'STALE_HISTORY_REVISION' }
      )
  }
  readLibraryQueue(
    id: string,
    offset = 0,
    limit = LIBRARY_PAGE_SIZE,
    options?: import('../../shared/libraryDatabase.ts').LibraryQueueReadOptions
  ): LibraryQueuePage {
    return this.queues.read(id, offset, limit, options)
  }
  getLibraryQueue(id: string): LibraryQueueSnapshot {
    return this.queues.get(id)
  }
  readLibraryQueueNeighbor(
    id: string,
    revision: number,
    index: number,
    direction: 1 | -1,
    wrap: boolean
  ) {
    return this.queues.neighbor(id, revision, index, direction, wrap)
  }
  exportPlaybackQueue(
    reference: import('../../shared/playbackSession.ts').LibraryPlaybackQueueReference,
    maxBytes: number,
    includeOriginalOrder = false
  ) {
    return this.queues.exportPlayback(reference, maxBytes, includeOriginalOrder)
  }
  readLibraryQueuePlaybackWindow(id: string, revision: number, index: number, wrap: boolean) {
    return this.queues.playbackWindow(id, revision, index, wrap)
  }
  editLibraryQueue(id: string, expectedRevision: number, edit: LibraryQueueEdit) {
    return this.queues.edit(id, expectedRevision, edit)
  }
  deleteLibraryQueue(id: string, expectedRevision: number): void {
    this.queues.delete(id, expectedRevision)
  }
  syncLibraryQueueReferences(owner: string, ids: string[]): void {
    this.queues.syncReferences(owner, ids)
  }
  collectLibraryQueueGarbage(olderThanMs?: number): number {
    return this.queues.collectGarbage(olderThanMs)
  }
  startScan(job: LibraryScanStartRequest): LibraryScanJob {
    return this.transaction(() => {
      if (
        this.statement("SELECT 1 FROM scan_jobs WHERE state IN ('running','paused') LIMIT 1").get()
      )
        throw new Error('Another scan is already active')
      if (!job.id || !['startup', 'full', 'watch'].includes(job.mode) || !job.roots.length)
        throw new Error('Invalid scan job')
      const metadata = this.getMetadata(),
        authorized = metadata.folders
      if (
        job.roots.some(
          (root) => !authorized.some((folder) => underRoot(normalizeLibraryFilePath(root), folder))
        )
      )
        throw new Error('Scan scope is not authorized')
      this.statement(
        "INSERT INTO scan_jobs(id,mode,roots,state,updated_at) VALUES(?,?,?,'running',?)"
      ).run(job.id, job.mode, JSON.stringify(job.roots), Date.now())
      for (const path of job.roots)
        this.statement("INSERT OR IGNORE INTO scan_directories VALUES(?,?,'pending',NULL)").run(
          job.id,
          normalizeLibraryFilePath(path)
        )
      if (job.restoreExcluded) {
        // One pass, not repeated 256-file RPCs that copy the remaining exclusion
        // document each time. A failed job insert/clear rolls back both changes.
        const exclusions = metadata.exclusions.filter((entry) => {
          const key = normalizeLibraryFilePath(entry.filePath)
          if (!job.roots.some((root) => underRoot(key, root))) return true
          this.statement('UPDATE files SET content_version=content_version+1 WHERE file_key=?').run(
            key
          )
          return false
        })
        if (exclusions.length !== metadata.exclusions.length) {
          this.setMeta('exclusions', exclusions)
          this.bump()
        }
      }
      return {
        id: job.id,
        mode: job.mode,
        roots: job.roots,
        state: 'running',
        committedFiles: 0,
        failedFiles: 0
      }
    })
  }
  setScanState(id: string, state: LibraryScanJob['state']): void {
    if (!['paused', 'cancelled', 'failed', 'interrupted'].includes(state))
      throw new Error('Use resumeScan or finishScan for this transition')
    const job = this.statement('SELECT state FROM scan_jobs WHERE id=?').get(id) as Row | undefined
    if (!job || job.state === 'completed' || job.state === 'cancelled')
      throw new Error('Scan cannot enter this state')
    this.transaction(() => {
      this.statement('UPDATE scan_jobs SET state=?,updated_at=? WHERE id=?').run(state, Date.now(), id)
      if (state !== 'paused') this.statement('DELETE FROM scan_release_dates WHERE job_id=?').run(id)
    })
  }
  resumeScan(id: string): LibraryScanJob {
    return this.transaction(() => {
      const job = this.listScanJobs().find((job) => job.id === id)
      if (!job || job.state === 'running') throw new Error('Scan is not resumable')
      const authorized = this.getMetadata().folders
      if (
        job.roots.some(
          (root) => !authorized.some((folder) => underRoot(normalizeLibraryFilePath(root), folder))
        )
      )
        throw new Error('Scan scope is no longer authorized; start a new scan for current folders')
      if (
        this.statement(
          "SELECT 1 FROM scan_jobs WHERE id<>? AND state IN ('running','paused') LIMIT 1"
        ).get(id)
      )
        throw new Error('Another scan is already active')
      if (job.state === 'paused') {
        this.statement("UPDATE scan_jobs SET state='running',updated_at=? WHERE id=?").run(
          Date.now(),
          id
        )
      } else {
        this.statement('DELETE FROM scan_release_dates WHERE job_id=?').run(id)
        this.statement(
          "UPDATE scan_jobs SET state='running',epoch=epoch+1,committed_files=0,failed_files=0,updated_at=? WHERE id=?"
        ).run(Date.now(), id)
        // Enumerate the current tree, not stale child-directory tasks from before a crash.
        this.statement('DELETE FROM scan_directories WHERE job_id=?').run(id)
        for (const path of job.roots)
          this.statement("INSERT INTO scan_directories VALUES(?,?,'pending',NULL)").run(
            id,
            normalizeLibraryFilePath(path)
          )
      }
      return {
        ...job,
        state: 'running',
        committedFiles: job.state === 'paused' ? job.committedFiles : 0,
        failedFiles: job.state === 'paused' ? job.failedFiles : 0
      }
    })
  }
  claimScanDirectories(id: string, limit = 1): LibraryScanDirectoryPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new Error('Invalid directory batch')
    return this.transaction(() => {
      const job = this.statement('SELECT state FROM scan_jobs WHERE id=?').get(id) as
        | Row
        | undefined
      if (!job) throw new Error('Scan job does not exist')
      const state = text(job.state) as LibraryScanJob['state']
      if (state !== 'running') return { directories: [], state }
      // A batch can conflict while its directory is still being enumerated;
      // the final directory page must not erase that retry request.
      const stale = this.statement(
        "SELECT file_key FROM scan_items WHERE job_id=? AND epoch=(SELECT epoch FROM scan_jobs WHERE id=?) AND state='stale' LIMIT 256"
      ).all(id, id) as Row[]
      for (const row of stale)
        this.statement(
          "UPDATE scan_directories SET state='pending',error=NULL WHERE job_id=? AND path=? AND state='complete'"
        ).run(id, normalizeLibraryFilePath(dirname(text(row.file_key))))
      const rows = this.statement(
        "SELECT path FROM scan_directories WHERE job_id=? AND state='pending' ORDER BY path LIMIT ?"
      ).all(id, limit) as Row[]
      for (const row of rows) {
        this.assertScanPath(id, text(row.path))
        this.statement("UPDATE scan_directories SET state='working' WHERE job_id=? AND path=?").run(
          id,
          row.path
        )
      }
      return { directories: rows.map((row) => text(row.path)), state }
    })
  }
  recordScanDirectory(id: string, result: LibraryScanDirectoryResult): void {
    if (result.children.length > 256) throw new Error('Directory child batch exceeds 256 entries')
    this.transaction(() => {
      const job = this.statement('SELECT state,roots FROM scan_jobs WHERE id=?').get(id) as
        | Row
        | undefined
      if (!job || !['running', 'paused'].includes(text(job.state)))
        throw new Error('Scan job is not active')
      const scopes = JSON.parse(text(job.roots)) as string[]
      const authorized = JSON.parse(this.meta('folders')) as LibraryMetadata['folders']
      const permitted = (path: string) =>
        scopes.some((root) => underRoot(normalizeLibraryFilePath(path), root)) &&
        authorized.some((root) => underRoot(normalizeLibraryFilePath(path), root))
      if (!permitted(result.path)) throw new Error('Directory is no longer authorized')
      for (const child of result.children) {
        if (
          !underRoot(normalizeLibraryFilePath(child), result.path) ||
          normalizeLibraryFilePath(child) === normalizeLibraryFilePath(result.path) ||
          !permitted(child)
        )
          throw new Error('Invalid scan child directory')
        this.statement("INSERT OR IGNORE INTO scan_directories VALUES(?,?,'pending',NULL)").run(
          id,
          normalizeLibraryFilePath(child)
        )
      }
      const state = result.error ? 'failed' : result.complete === false ? 'working' : 'complete'
      if (state === 'complete') {
        // A rejected result may refer to a file deleted during parsing. A full
        // re-enumeration cannot rediscover it to clear 'stale'; resolve only
        // confirmed ENOENT here so it cannot requeue this directory forever.
        let after = ''
        while (true) {
          const stale = this.statement(
            "SELECT file_key FROM scan_items WHERE job_id=? AND epoch=(SELECT epoch FROM scan_jobs WHERE id=?) AND state='stale' AND file_key>? ORDER BY file_key LIMIT 256"
          ).all(id, id, after) as Row[]
          if (!stale.length) break
          for (const row of stale) {
            const key = text(row.file_key)
            after = key
            if (normalizeLibraryFilePath(dirname(key)) !== normalizeLibraryFilePath(result.path))
              continue
            try {
              statSync(key)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              this.statement(
                "UPDATE scan_items SET state='missing' WHERE job_id=? AND file_key=?"
              ).run(id, key)
              this.statement('UPDATE files SET seen_job=NULL WHERE file_key=?').run(key)
            }
          }
        }
      }
      const changed = this.statement(
        'UPDATE scan_directories SET state=?,error=? WHERE job_id=? AND path=?'
      ).run(state, result.error ?? null, id, normalizeLibraryFilePath(result.path))
      if (!changed.changes) throw new Error('Directory was not registered in the scan job')
    })
  }
  recordScanFiles(id: string, identities: LocalLibraryFileIdentity[]): void {
    if (identities.length > 256) throw new Error('Identity batch exceeds 256 files')
    this.transaction(() => {
      const job = this.statement('SELECT state,mode,roots,epoch FROM scan_jobs WHERE id=?').get(
        id
      ) as Row | undefined
      if (!job || !['running', 'paused'].includes(text(job.state)))
        throw new Error('Scan job is not active')
      // Authorization needs current configuration, not whole-library counts.
      const folders = JSON.parse(this.meta('folders')) as LibraryMetadata['folders'],
        configuredExclusions = JSON.parse(this.meta('exclusions')) as LibraryMetadata['exclusions'],
        scopes = JSON.parse(text(job.roots)) as string[]
      const exclusions = new Set(
        configuredExclusions.map((item) => normalizeLibraryFilePath(item.filePath))
      )
      const removing = this.removal.blockedPaths()
      for (const identity of identities) {
        if (
          !identity.filePath ||
          !Number.isSafeInteger(identity.size) ||
          identity.size < 0 ||
          !Number.isFinite(identity.mtimeMs) ||
          identity.mtimeMs < 0
        )
          throw new Error('Invalid file identity')
        const key = normalizeLibraryFilePath(identity.filePath)
        const existing = this.statement(
          'SELECT identity,state,expected_version,epoch FROM scan_items WHERE job_id=? AND file_key=?'
        ).get(id, key) as Row | undefined
        const file = this.statement(
          'SELECT identity,status,metadata_version,content_version,EXISTS(SELECT 1 FROM tracks WHERE tracks.file_key=files.file_key) AS has_tracks FROM files WHERE file_key=?'
        ).get(key) as Row | undefined
        const permitted =
          !exclusions.has(key) &&
          !removing.has(key) &&
          scopes.some((root) => underRoot(key, root)) &&
          folders.some((root) => underRoot(key, root))
        const sameBytes =
          // Earlier JSON migrations retained trusted v0 identities as pending.
          // They still have playable records; only their date read is missing.
          (file?.status === 'complete' || (file?.status === 'pending' && Number(file.metadata_version) < LOCAL_LIBRARY_METADATA_VERSION)) &&
          Number(file.has_tracks) &&
          file.identity &&
          sameLocalLibraryFileIdentity(JSON.parse(text(file.identity)), identity)
        const unchanged = sameBytes && Number(file.metadata_version) >= LOCAL_LIBRARY_METADATA_VERSION
        const dateOnly = job.mode !== 'full' && sameBytes && !unchanged
        const stagedDate = dateOnly ? this.statement(
          'SELECT epoch,release_date,dependencies,observations FROM scan_release_dates WHERE job_id=? AND file_key=?'
        ).get(id, key) as Row | undefined : undefined
        // A checkpoint describes committed records, not just bytes on disk. A
        // restore, metadata upgrade or later per-file change can invalidate it.
        const sameCheckpoint =
          unchanged &&
          existing?.state === 'complete' &&
          Number(existing.expected_version) === Number(file.content_version) &&
          sameLocalLibraryFileIdentity(JSON.parse(text(existing.identity)), identity)
        const sameDateCheckpoint =
          dateOnly && stagedDate?.epoch === job.epoch && existing?.epoch === job.epoch &&
          existing.state === 'complete' &&
          Number(existing.expected_version) === Number(file.content_version) &&
          sameLocalLibraryFileIdentity(JSON.parse(text(existing.identity)), identity)
        const alreadyWorking =
          existing?.state === 'working' &&
          existing.epoch === job.epoch &&
          sameLocalLibraryFileIdentity(JSON.parse(text(existing.identity)), identity)
        const state = !permitted
          ? 'excluded'
          : sameCheckpoint || sameDateCheckpoint || (job.mode !== 'full' && unchanged)
            ? 'complete'
            : alreadyWorking
              ? 'working'
              : 'pending'
        this.statement('INSERT OR REPLACE INTO scan_items VALUES(?,?,?,?,NULL,?,?)').run(
          id,
          key,
          JSON.stringify(identity),
          state,
          Number(file?.content_version ?? 0),
          Number(job.epoch)
        )
        if (permitted && dateOnly)
          this.statement('INSERT INTO scan_release_dates VALUES(?,?,?,?,?,?)').run(
            id, key, Number(job.epoch), sameDateCheckpoint ? stagedDate!.release_date : null,
            sameDateCheckpoint ? stagedDate!.dependencies : '[]',
            sameDateCheckpoint ? stagedDate!.observations : null
          )
        if (permitted || removing.has(key))
          this.statement('UPDATE files SET seen_job=? WHERE file_key=?').run(
            `${id}:${job.epoch}`,
            key
          )
        const beforeComplete =
            existing?.state === 'complete' && existing.epoch === job.epoch ? 1 : 0,
          beforeFailed = existing?.state === 'failed' && existing.epoch === job.epoch ? 1 : 0
        this.statement(
          'UPDATE scan_jobs SET committed_files=committed_files+?,failed_files=failed_files-? WHERE id=?'
        ).run((state === 'complete' ? 1 : 0) - beforeComplete, beforeFailed, id)
      }
    })
  }
  claimScanFiles(id: string, limit = 256): LibraryScanWorkPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new Error('Invalid scan work page')
    return this.transaction(() => {
      const job = this.statement('SELECT state,last_batch,epoch FROM scan_jobs WHERE id=?').get(
        id
      ) as Row | undefined
      if (!job) throw new Error('Scan job does not exist')
      this.statement(
        "UPDATE scan_items SET state='excluded',error='Removal in progress' WHERE job_id=? AND epoch=? AND state='pending' AND file_key IN (SELECT value FROM json_each(?))"
      ).run(id, Number(job.epoch), JSON.stringify([...this.removal.blockedPaths()]))
      const rows =
        job.state === 'running'
          ? (this.statement(
              "SELECT i.file_key,i.identity,d.file_key AS date_key FROM scan_items i LEFT JOIN scan_release_dates d ON d.job_id=i.job_id AND d.file_key=i.file_key AND d.epoch=i.epoch WHERE i.job_id=? AND i.epoch=? AND i.state='pending' ORDER BY i.file_key LIMIT ?"
            ).all(id, Number(job.epoch), limit) as Row[])
          : []
      for (const row of rows) {
        this.assertScanPath(id, text(row.file_key))
        this.statement("UPDATE scan_items SET state='working' WHERE job_id=? AND file_key=?").run(
          id,
          row.file_key
        )
      }
      return {
        identities: rows.map((row) => JSON.parse(text(row.identity))),
        ...(rows.some((row) => row.date_key !== null)
          ? { releaseDateFilePaths: rows.filter((row) => row.date_key !== null).map((row) => (JSON.parse(text(row.identity)) as LocalLibraryFileIdentity).filePath) }
          : {}),
        lastBatch: Number(job.last_batch),
        state: text(job.state) as LibraryScanJob['state']
      }
    })
  }
  /** Called only inside finishScan's transaction. Validate the entire staged
   * stream before publishing any date, using bounded pages on both passes. */
  private publishScanReleaseDates(
    id: string, epoch: number, scopes: string[], metadata: LibraryMetadata
  ): { ready: boolean; changed: boolean } {
    const excluded = new Set(metadata.exclusions.map((item) => normalizeLibraryFilePath(item.filePath)))
    const removing = this.removal.blockedPaths()
    const page = (after: string) => this.statement(
      `SELECT d.file_key,d.release_date,d.dependencies,d.observations,i.identity,i.expected_version,
        f.identity AS file_identity,f.content_version,f.status,f.audio_metadata
      FROM scan_release_dates d JOIN scan_items i ON i.job_id=d.job_id AND i.file_key=d.file_key AND i.epoch=d.epoch
      LEFT JOIN files f ON f.file_key=d.file_key
      WHERE d.job_id=? AND d.epoch=? AND i.state='complete' AND d.file_key>? ORDER BY d.file_key LIMIT 256`
    ).all(id, epoch, after) as Row[]
    let after = '', invalid = 0
    while (true) {
      const rows = page(after)
      if (!rows.length) break
      for (const row of rows) {
        const key = text(row.file_key), identity = JSON.parse(text(row.identity)) as LocalLibraryFileIdentity
        after = key
        const permitted = !excluded.has(key) && !removing.has(key) &&
          scopes.some((root) => underRoot(key, root)) && metadata.folders.some((root) => underRoot(key, root))
        if (permitted && (row.status === 'complete' || row.status === 'pending') && row.file_identity &&
          Number(row.expected_version) === Number(row.content_version) &&
          sameLocalLibraryFileIdentity(JSON.parse(text(row.file_identity)), identity) &&
          identityStillMatches(identity) &&
          (JSON.parse(text(row.dependencies)) as LibraryScanDependency[]).every(identityStillMatches)) continue
        this.statement('DELETE FROM scan_release_dates WHERE job_id=? AND file_key=?').run(id, key)
        this.statement('UPDATE scan_items SET state=?,error=?,expected_version=? WHERE job_id=? AND file_key=?').run(
          permitted ? 'stale' : 'excluded', permitted ? 'File changed before date publication' : 'Scope is no longer authorized',
          Number(row.content_version ?? 0), id, key
        )
        if (permitted) this.statement("UPDATE scan_directories SET state='pending',error=NULL WHERE job_id=? AND path=?").run(
          id, normalizeLibraryFilePath(dirname(identity.filePath))
        )
        invalid++
      }
    }
    if (invalid) {
      this.statement('UPDATE scan_jobs SET committed_files=committed_files-? WHERE id=?').run(invalid, id)
      return { ready: false, changed: false }
    }
    after = ''
    let changed = false
    while (true) {
      const rows = page(after)
      if (!rows.length) break
      for (const row of rows) {
        const key = text(row.file_key), date = normalizeReleaseDate(row.release_date)
        const observations = row.observations ? JSON.parse(text(row.observations)) as LocalLibraryTagObservations : undefined
        after = key
        const tracks = this.statement('SELECT payload FROM tracks WHERE file_key=? ORDER BY seq').all(key) as Row[]
        for (const record of tracks) {
          const track = JSON.parse(text(record.payload)) as LibraryTrackRecord
          delete track.releaseDate
          if (date) track.releaseDate = date
          const tags = observedTrackTags(track, observations)
          if (tags) track.identityTags = tags
          changed = this.putTrack(track) || changed
        }
        // Keep raw observations aligned for later CUE derivation; display
        // fields and personal choices in the physical cache remain unchanged.
        const audioMetadata = row.audio_metadata ? JSON.parse(text(row.audio_metadata)) as LibraryTrackRecord : undefined
        if (audioMetadata) {
          delete audioMetadata.releaseDate
          if (date) audioMetadata.releaseDate = date
          if (observations) audioMetadata.identityTags = observations.audioTags
        }
        const metadataVersion = LOCAL_LIBRARY_METADATA_VERSION
        const identity = { ...JSON.parse(text(row.file_identity)), metadataVersion }
        this.statement("UPDATE files SET identity=?,metadata_version=?,status='complete',audio_metadata=? WHERE file_key=?").run(
          JSON.stringify(identity), metadataVersion, audioMetadata ? JSON.stringify(audioMetadata) : null, key
        )
        this.statement('UPDATE scan_items SET identity=?,expected_version=(SELECT content_version FROM files WHERE file_key=?) WHERE job_id=? AND file_key=?').run(
          JSON.stringify(identity), key, id, key
        )
      }
    }
    this.statement('DELETE FROM scan_release_dates WHERE job_id=?').run(id)
    return { ready: true, changed }
  }
  finishScan(id: string): LibraryScanFinishResult {
    return this.transaction(() => {
      const job = this.statement('SELECT state,roots,epoch FROM scan_jobs WHERE id=?').get(id) as
        | Row
        | undefined
      if (job?.state === 'paused')
        return { completed: false, metadata: this.getMetadata(), removedFileCount: 0 }
      if (!job || job.state !== 'running') throw new Error('Scan job is not running')
      const incompleteDirectories = Number(
        (
          this.statement(
            "SELECT count(*) AS n FROM scan_directories WHERE job_id=? AND state<>'complete'"
          ).get(id) as Row
        ).n
      )
      const incompleteFiles = Number(
        (
          this.statement(
            "SELECT count(*) AS n FROM scan_items WHERE job_id=? AND epoch=? AND state IN ('pending','working','stale')"
          ).get(id, Number(job.epoch)) as Row
        ).n
      )
      if (incompleteDirectories || incompleteFiles)
        throw new Error('Incomplete scan cannot remove missing files')
      const metadata = this.getMetadata(), scopes = JSON.parse(text(job.roots)) as string[],
        authorized = metadata.folders
      for (const root of scopes) {
        if (
          !authorized.some((folder) => underRoot(normalizeLibraryFilePath(root), folder)) ||
          !statSync(root).isDirectory()
        )
          throw new Error('Scan root is no longer authorized or online')
      }
      const dates = this.publishScanReleaseDates(id, Number(job.epoch), scopes, metadata)
      if (!dates.ready) return { completed: false, metadata: this.getMetadata(), removedFileCount: 0 }
      let removedFileCount = 0,
        after = ''
      const removing = this.removal.blockedPaths()
      while (true) {
        const candidates = this.statement(
          'SELECT file_key FROM files WHERE (seen_job IS NULL OR seen_job<>?) AND file_key>? ORDER BY file_key LIMIT 256'
        ).all(`${id}:${job.epoch}`, after) as Row[]
        if (!candidates.length) break
        for (const row of candidates) {
          const key = text(row.file_key)
          after = key
          if (removing.has(key) || !scopes.some((root) => underRoot(key, root))) continue
          this.statement('DELETE FROM tracks WHERE file_key=?').run(key)
          this.statement('DELETE FROM files WHERE file_key=?').run(key)
          removedFileCount++
        }
      }
      this.statement(
        "UPDATE scan_jobs SET state='completed',checked_files=(SELECT count(*) FROM scan_items WHERE job_id=? AND epoch=?),updated_at=? WHERE id=?"
      ).run(id, Number(job.epoch), Date.now(), id)
      if (removedFileCount || dates.changed) this.bump()
      return { completed: true, metadata: this.getMetadata(), removedFileCount }
    })
  }
  listScanJobs(): LibraryScanJob[] {
    return (
      this.statement(
        "SELECT * FROM scan_jobs WHERE state<>'completed' ORDER BY updated_at DESC"
      ).all() as Row[]
    ).map((row) => ({
      id: text(row.id),
      mode: text(row.mode) as LibraryScanJob['mode'],
      roots: JSON.parse(text(row.roots)),
      state: text(row.state) as LibraryScanJob['state'],
      committedFiles: Number(row.committed_files),
      failedFiles: Number(row.failed_files)
    }))
  }
  /** Includes completion, so an old cancelled task cannot mask a newer success. */
  getLatestScanJob(): LibraryScanJob | null {
    const row = this.statement(
      'SELECT * FROM scan_jobs ORDER BY updated_at DESC,rowid DESC LIMIT 1'
    ).get() as Row | undefined
    return row
      ? {
          id: text(row.id),
          mode: text(row.mode) as LibraryScanJob['mode'],
          roots: JSON.parse(text(row.roots)),
          state: text(row.state) as LibraryScanJob['state'],
          committedFiles: Number(row.committed_files),
          failedFiles: Number(row.failed_files)
        }
      : null
  }
  getScanProgress(id: string): LibraryScanProgressSnapshot {
    const row = this.statement('SELECT * FROM scan_jobs WHERE id=?').get(id) as Row | undefined
    if (!row) throw new Error('Scan job does not exist')
    return {
      jobId: id,
      state: text(row.state) as LibraryScanJob['state'],
      checkedFiles:
        row.state === 'completed' && row.checked_files !== null
          ? Number(row.checked_files)
          : Number(
              (
                this.statement(
                  'SELECT count(*) AS n FROM scan_items WHERE job_id=? AND epoch=?'
                ).get(id, Number(row.epoch)) as Row
              ).n
            ),
      parsedFiles: Number(row.parsed_files),
      committedFiles: Number(row.committed_files),
      failedFiles: Number(row.failed_files),
      trackCount: Number((this.statement('SELECT count(*) AS n FROM tracks').get() as Row).n),
      revision: Number(this.meta('revision'))
    }
  }
  private assertScanPath(id: string, filePath: string): void {
    const job = this.statement('SELECT roots,state FROM scan_jobs WHERE id=?').get(id) as
      | Row
      | undefined
    const key = normalizeLibraryFilePath(filePath)
    if (
      !job ||
      !['running', 'paused'].includes(text(job.state)) ||
      !(JSON.parse(text(job.roots)) as string[]).some((root) => underRoot(key, root)) ||
      !(JSON.parse(this.meta('folders')) as string[]).some((root) => underRoot(key, root))
    )
      throw new Error('Scan path is no longer authorized')
  }
  getScanAudioMetadata(
    id: string,
    identities: LocalLibraryFileIdentity[]
  ): Record<string, LibraryTrackRecord> {
    if (identities.length > 256) throw new Error('Audio metadata page exceeds 256 files')
    const result: Record<string, LibraryTrackRecord> = {}
    for (const identity of identities) {
      this.assertScanPath(id, identity.filePath)
      const row = this.statement(
        'SELECT identity,status,metadata_version,audio_metadata FROM files WHERE file_key=?'
      ).get(normalizeLibraryFilePath(identity.filePath)) as Row | undefined
      if (
        row?.status !== 'complete' ||
        !row.identity ||
        !row.audio_metadata ||
        Number(row.metadata_version) < LOCAL_LIBRARY_METADATA_VERSION
      )
        continue
      const previous = JSON.parse(text(row.identity)) as LocalLibraryFileIdentity
      // A CUE edit changes logical segments, not the audio bytes or their tags.
      if (
        sameLocalLibraryFileIdentity(previous, { ...identity, cueSignature: previous.cueSignature })
      )
        result[normalizeLibraryFilePath(identity.filePath)] = JSON.parse(text(row.audio_metadata))
    }
    return result
  }
  getScanCueDefinition(
    id: string,
    identity: LocalLibraryFileIdentity
  ): LibraryCueDefinitionRecord | null {
    this.assertScanPath(id, identity.filePath)
    const row = this.statement(
      'SELECT identity,definition FROM cue_definitions WHERE cue_key=?'
    ).get(normalizeLibraryFilePath(identity.filePath)) as Row | undefined
    if (!row || !sameLocalLibraryFileIdentity(JSON.parse(text(row.identity)), identity)) return null
    const record = JSON.parse(text(row.definition)) as LibraryCueDefinitionRecord
    return record.parserVersion === 1 ? record : null
  }
  putScanCueDefinition(id: string, record: LibraryCueDefinitionRecord): void {
    this.assertScanPath(id, record.identity.filePath)
    if (record.audioPath) this.assertScanPath(id, record.audioPath)
    if (!identityStillMatches(record.identity)) return
    this.statement('INSERT OR REPLACE INTO cue_definitions VALUES(?,?,?,?)').run(
      normalizeLibraryFilePath(record.identity.filePath),
      JSON.stringify(record.identity),
      record.audioPath ? normalizeLibraryFilePath(record.audioPath) : '',
      stringifyJsonWithNestingLimit(record, 'CUE definition')
    )
  }
  getFileIdentities(offset = 0, limit = LIBRARY_PAGE_SIZE): LocalLibraryFileIdentity[] {
    libraryPageBounds(offset, limit)
    return (
      this.statement(
        'SELECT identity FROM files WHERE identity IS NOT NULL ORDER BY file_key LIMIT ? OFFSET ?'
      ).all(limit, offset) as Row[]
    ).map((row) => JSON.parse(text(row.identity)))
  }
  commitScanBatch(batch: LibraryScanCommit): LibraryMetadata {
    if (batch.files.length > 256 || !Number.isSafeInteger(batch.sequence) || batch.sequence < 1)
      throw new Error('Invalid scan batch')
    return this.transaction(() => {
      const job = this.statement(
        'SELECT state,roots,last_batch,epoch FROM scan_jobs WHERE id=?'
      ).get(batch.jobId) as Row | undefined
      if (!job) throw new Error('Scan job does not exist')
      if (batch.sequence <= Number(job.last_batch)) return this.getMetadata()
      if (job.state !== 'running' && job.state !== 'paused')
        throw new Error('Scan job is not running')
      if (batch.sequence !== Number(job.last_batch) + 1)
        throw new Error('Scan batch arrived out of order')
      const metadata = this.getMetadata()
      const scopes = JSON.parse(text(job.roots)) as string[]
      const excluded = new Set(
        metadata.exclusions.map((item) => normalizeLibraryFilePath(item.filePath))
      )
      const removing = this.removal.blockedPaths()
      let committedDelta = 0,
        failedDelta = 0,
        changed = false
      for (const file of batch.files) {
        const key = normalizeLibraryFilePath(file.identity.filePath)
        const previousItem = this.statement(
          'SELECT state,identity,expected_version,epoch FROM scan_items WHERE job_id=? AND file_key=?'
        ).get(batch.jobId, key) as Row | undefined
        if (
          !previousItem ||
          previousItem.state !== 'working' ||
          previousItem.epoch !== job.epoch ||
          !sameLocalLibraryFileIdentity(JSON.parse(text(previousItem.identity)), file.identity)
        )
          throw new Error('Scan result was not claimed from its durable task')
        const dateOnly = !!this.statement(
          'SELECT 1 FROM scan_release_dates WHERE job_id=? AND file_key=? AND epoch=?'
        ).get(batch.jobId, key, Number(job.epoch))
        if (file.releaseDateOnly && !dateOnly)
          throw new Error('Date-only result was not claimed as a legacy date read')
        if (!dateOnly && file.metadataRead && !file.error && !file.tracks.length)
          throw new Error('Successful metadata must contain a playable logical track')
        const currentVersion = Number(
          (
            this.statement('SELECT content_version FROM files WHERE file_key=?').get(key) as
              | Row
              | undefined
          )?.content_version ?? 0
        )
        const permitted =
          !excluded.has(key) &&
          !removing.has(key) &&
          scopes.some((root) => underRoot(key, root)) &&
          metadata.folders.some((root) => underRoot(key, root))
        if (
          !permitted ||
          Number(previousItem.expected_version) !== currentVersion ||
          !identityStillMatches(file.identity) ||
          !(file.dependencies ?? []).every(identityStillMatches)
        ) {
          this.statement('INSERT OR REPLACE INTO scan_items VALUES(?,?,?,?,?,?,?)').run(
            batch.jobId,
            key,
            JSON.stringify(file.identity),
            permitted ? 'stale' : 'excluded',
            permitted ? 'File changed before commit' : 'Scope is no longer authorized',
            currentVersion,
            Number(job.epoch)
          )
          if (permitted)
            this.statement(
              "UPDATE scan_directories SET state='pending',error=NULL WHERE job_id=? AND path=?"
            ).run(batch.jobId, normalizeLibraryFilePath(dirname(file.identity.filePath)))
          continue
        }
        const error = file.error || (!file.metadataRead ? 'Metadata could not be read' : '')
        if (dateOnly) {
          // Older parse-only callers remain valid, but their replacement Track
          // payloads never gain write authority over a date-only durable task.
          const date = normalizeReleaseDate(file.releaseDateOnly ? file.releaseDate : file.tracks[0]?.releaseDate)
          const observations = file.observations
          if (observations && (!normalizeTrackIdentityTags(observations.audioTags) ||
            !Array.isArray(observations.tracks) || observations.tracks.length > 10000 ||
            observations.tracks.some(row => !normalizeTrackIdentityTags(row.identityTags))))
            throw new Error('Invalid raw tag observations')
          this.statement('UPDATE scan_release_dates SET release_date=?,dependencies=?,observations=? WHERE job_id=? AND file_key=?').run(
            error ? null : date ?? null, JSON.stringify(file.dependencies ?? []),
            !error && observations ? stringifyJsonWithNestingLimit(observations, 'tag observations') : null, batch.jobId, key
          )
          this.statement('UPDATE scan_items SET state=?,error=? WHERE job_id=? AND file_key=?').run(
            error ? 'failed' : 'complete', error || null, batch.jobId, key
          )
          if (error) failedDelta++
          else committedDelta++
          continue
        }
        const previous = this.statement(
          'SELECT id,payload FROM tracks WHERE file_key=? ORDER BY seq'
        ).all(key) as Row[]
        const oldTracks = previous.map((row) => JSON.parse(text(row.payload)) as LibraryTrackRecord)
        const byId = new Map(oldTracks.map((track) => [track.id, track]))
        const bySegment = new Map(oldTracks.map((track) => [segmentKey(track), track]))
        // Failed metadata never replaces a previously playable record. Its identity remains
        // retryable even when a filename-only fallback is admitted for a newly discovered file.
        const retainedIds: string[] = []
        if (!error || !previous.length) {
          for (const track of file.tracks) {
            if (normalizeLibraryFilePath(track.filePath) !== key)
              throw new Error('Scan batch contains a mismatched file path')
            // A stable ID is stronger evidence than legacy segment metadata, which
            // may be absent in an older record or corrected by the new parser.
            const old = byId.get(track.id) ?? bySegment.get(segmentKey(track))
            const next = old
              ? {
                  ...old,
                  ...track,
                  id: old.id,
                  ...(old.addedAt !== undefined ? { addedAt: old.addedAt } : {})
                }
              : track
            const owner = this.statement('SELECT file_key FROM tracks WHERE id=?').get(next.id) as
              | Row
              | undefined
            if (owner && owner.file_key !== key)
              throw new Error('Scan track id belongs to another physical file')
            if (retainedIds.includes(next.id))
              throw new Error('Duplicate logical track in a scan result')
            retainedIds.push(next.id)
            const written = this.putTrack(next)
            changed = written || changed
          }
          const removed = this.statement(
            'DELETE FROM tracks WHERE file_key=? AND id NOT IN (SELECT value FROM json_each(?))'
          ).run(key, JSON.stringify(retainedIds))
          changed = Number(removed.changes) > 0 || changed
        }
        const identity = {
          ...file.identity,
          metadataVersion: error ? 0 : LOCAL_LIBRARY_METADATA_VERSION
        }
        if (file.audioMetadata && normalizeLibraryFilePath(file.audioMetadata.filePath) !== key)
          throw new Error('Audio metadata belongs to another physical file')
        this.statement(
          'INSERT INTO files(file_key,file_path,identity,metadata_version,status,last_error,seen_job,audio_metadata) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(file_key) DO UPDATE SET identity=excluded.identity,metadata_version=excluded.metadata_version,status=excluded.status,last_error=excluded.last_error,seen_job=excluded.seen_job,audio_metadata=COALESCE(excluded.audio_metadata,files.audio_metadata)'
        ).run(
          key,
          file.identity.filePath,
          JSON.stringify(identity),
          identity.metadataVersion,
          error ? 'failed' : 'complete',
          error || null,
          `${batch.jobId}:${job.epoch}`,
          !error && file.audioMetadata
            ? stringifyJsonWithNestingLimit(file.audioMetadata, 'audio metadata')
            : null
        )
        // Track triggers advance the file version during this transaction. Store
        // the post-commit version so resume can validate the complete checkpoint.
        const committedVersion = Number(
          (this.statement('SELECT content_version FROM files WHERE file_key=?').get(key) as Row)
            .content_version
        )
        this.statement('INSERT OR REPLACE INTO scan_items VALUES(?,?,?,?,?,?,?)').run(
          batch.jobId,
          key,
          JSON.stringify(identity),
          error ? 'failed' : 'complete',
          error || null,
          committedVersion,
          Number(job.epoch)
        )
        if (error) failedDelta++
        else committedDelta++
      }
      this.statement(
        'UPDATE scan_jobs SET committed_files=committed_files+?,failed_files=failed_files+?,parsed_files=parsed_files+?,last_batch=?,updated_at=? WHERE id=?'
      ).run(
        committedDelta,
        failedDelta,
        batch.files.filter((file) => !file.metadataReused).length,
        batch.sequence,
        Date.now(),
        batch.jobId
      )
      if (changed) this.bump()
      return this.getMetadata()
    })
  }
}

function segmentKey(track: Record<string, unknown>): string {
  if (track.subTrack !== undefined) return `sub:${String(track.subTrack)}`
  if (track.cueSheetPath && isRecord(track.cueRange))
    return `cue:${normalizeLibraryFilePath(text(track.cueSheetPath))}:${String(track.trackNumber ?? track.cueRange.trackNumber ?? track.id)}`
  return 'file'
}

function underRoot(key: string, root: string): boolean {
  const normalized = normalizeLibraryFilePath(root).replace(/[\\/]+$/, '')
  return (
    key === normalized ||
    key.startsWith(`${normalized}${process.platform === 'win32' ? '\\' : '/'}`)
  )
}

function identityStillMatches(identity: LibraryScanDependency): boolean {
  try {
    const current = statSync(identity.filePath)
    return (
      (identity.kind === 'directory' ? current.isDirectory() : current.isFile()) &&
      current.size === identity.size &&
      current.mtimeMs === identity.mtimeMs
    )
  } catch {
    return false
  }
}

/** Install a validated temporary database. The legacy sources are never modified.
 * An existing SQLite database is always authoritative, including when it fails to open. */
export async function openLibraryDatabase(
  libraryFilePath: string,
  coverCacheDir = join(dirname(libraryFilePath), 'cover-cache')
): Promise<LibraryDatabase> {
  const target = getLibraryDatabasePath(libraryFilePath)
  if (existsSync(target)) return new LibraryDatabase(target)
  if (!existsSync(libraryFilePath)) {
    if (existsSync(`${libraryFilePath}.bak`))
      throw new Error('Legacy library is missing; explicitly restore its backup before migrating')
  }
  const temporary = `${target}.migrating`
  const removeTemporary = () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(temporary + suffix)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  removeTemporary()
  const database = new LibraryDatabase(temporary)
  try {
    database.sql.exec('BEGIN IMMEDIATE')
    const folders: string[] = [],
      exclusions: LocalMusicLibraryDocument['exclusions'] = []
    if (existsSync(libraryFilePath))
      for await (const item of streamLibraryJson(libraryFilePath)) {
        if (item.field === 'tracks' && item.arrayItem) {
          if (
            !isRecord(item.value) ||
            typeof item.value.id !== 'string' ||
            typeof item.value.filePath !== 'string'
          )
            throw new Error('Invalid legacy library track')
          database.importTrack(
            await externalizeLibraryCover(item.value as LibraryTrackRecord, coverCacheDir)
          )
        } else if (item.field === 'folders' && item.arrayItem) {
          if (typeof item.value !== 'string' || !item.value.trim())
            throw new Error('Invalid legacy library folder')
          folders.push(item.value)
        } else if (item.field === 'exclusions' && item.arrayItem) {
          const raw = typeof item.value === 'string' ? { filePath: item.value } : item.value
          if (!isRecord(raw) || typeof raw.filePath !== 'string' || !raw.filePath)
            throw new Error('Invalid legacy library exclusion')
          exclusions.push({
            ...raw,
            filePath: raw.filePath,
            title: text(raw.title) || raw.filePath.split(/[\\/]/).pop() || raw.filePath,
            artist: text(raw.artist),
            excludedAt: text(raw.excludedAt) || new Date(0).toISOString()
          })
        } else if (item.field === '$arrays') {
          if (!(item.value as string[]).includes('tracks'))
            throw new Error('Legacy library requires a tracks array')
        } else database.importHeader(item.field, item.value)
      }
    database.importArrays(folders, exclusions)
    database.sql.exec('COMMIT')
    await importLegacyIndex(
      database,
      join(dirname(libraryFilePath), 'music-library-file-index.json')
    )
    const result = database.sql.prepare('PRAGMA integrity_check').get() as Row
    if (
      result.integrity_check !== 'ok' ||
      database.sql.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('Migrated music library failed its integrity check')
    // FTS is a derivative index, but a broken index must not be installed either.
    database.sql.exec(
      "INSERT INTO track_search(track_search,rank) VALUES('integrity-check',1); PRAGMA wal_checkpoint(TRUNCATE);"
    )
    database.close()
    renameSync(temporary, target)
    return new LibraryDatabase(target)
  } catch (error) {
    try {
      database.close()
    } catch {
      /* Already closed after checkpoint. */
    }
    removeTemporary()
    throw new Error(
      `Music library migration failed; original files were preserved: ${String(error)}`,
      { cause: error }
    )
  }
}

async function importLegacyIndex(database: LibraryDatabase, path: string): Promise<void> {
  if (!existsSync(path)) return
  database.sql.exec(
    'BEGIN IMMEDIATE; CREATE TEMP TABLE legacy_index(file_key TEXT PRIMARY KEY,file_path TEXT NOT NULL,identity TEXT NOT NULL);'
  )
  try {
    let revision: unknown, version: unknown, updatedAt: unknown
    for await (const item of streamLibraryJson(path)) {
      if (item.field === 'libraryRevision' && !item.arrayItem) revision = item.value
      else if (item.field === 'version' && !item.arrayItem) version = item.value
      else if (item.field === 'updatedAt' && !item.arrayItem) updatedAt = item.value
      else if (item.field === 'entries' && item.arrayItem) {
        const value = item.value
        if (
          !isRecord(value) ||
          typeof value.filePath !== 'string' ||
          !value.filePath ||
          !Number.isSafeInteger(value.size) ||
          Number(value.size) < 0 ||
          typeof value.mtimeMs !== 'number' ||
          !Number.isFinite(value.mtimeMs) ||
          value.mtimeMs < 0
        )
          throw new Error('Invalid file index identity')
        const identity = {
          filePath: value.filePath,
          size: Number(value.size),
          mtimeMs: value.mtimeMs,
          ...(typeof value.cueSignature === 'string' ? { cueSignature: value.cueSignature } : {}),
          metadataVersion:
            Number.isSafeInteger(value.metadataVersion) && Number(value.metadataVersion) > 0
              ? Number(value.metadataVersion)
              : 0
        }
        database.sql
          .prepare('INSERT INTO legacy_index VALUES(?,?,?)')
          .run(normalizeLibraryFilePath(value.filePath), value.filePath, JSON.stringify(identity))
      } else if (item.field === '$arrays' && !(item.value as string[]).includes('entries'))
        throw new Error('File index requires an entries array')
    }
    // Even an obsolete index may reveal a file to check, but can never authorize a skip.
    database.sql.exec(
      "INSERT OR IGNORE INTO files(file_key,file_path,status) SELECT file_key,file_path,'pending' FROM legacy_index;"
    )
    if (
      revision === database.getMetadata().revision &&
      version === 1 &&
      typeof updatedAt === 'string'
    ) {
      database.sql
        .exec(`UPDATE files SET identity=(SELECT identity FROM legacy_index WHERE legacy_index.file_key=files.file_key),
        metadata_version=COALESCE((SELECT json_extract(identity,'$.metadataVersion') FROM legacy_index WHERE legacy_index.file_key=files.file_key),0)
        WHERE file_key IN (SELECT file_key FROM tracks) AND file_key IN (SELECT file_key FROM legacy_index);`)
      database.sql.exec(
        `UPDATE files SET status='complete' WHERE metadata_version>=${LOCAL_LIBRARY_METADATA_VERSION} AND identity IS NOT NULL AND file_key IN (SELECT file_key FROM tracks);`
      )
    }
    database.sql.exec('DROP TABLE legacy_index; COMMIT;')
  } catch (error) {
    if (database.sql.isTransaction) database.sql.exec('ROLLBACK')
    const sqliteError = error as { code?: string; errcode?: number }
    if (sqliteError.code?.startsWith('ERR_SQLITE') && (Number(sqliteError.errcode) & 0xff) !== 19)
      throw error
    // This failure invalidates only the acceleration index, not the original songs.
    console.warn(
      '[library-db] Legacy file index was ignored; files will be checked:',
      String(error)
    )
  }
}
