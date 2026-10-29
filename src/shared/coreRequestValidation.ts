import { validCoreDspPayload } from './coreDsp.ts'
import { EXPERIENCE_MUSIC_OPERATIONS } from './pluginExperience.ts'
import { validCatalogPayload } from './musicCatalog.ts'
import { validLibraryHealthPayload } from './libraryHealth.ts'
import { validGenresPayload } from './musicGenres.ts'
import { validGenreBrowsePayload } from './musicGenreBrowse.ts'
import { validAlbumBrowsePayload } from './musicAlbumBrowse.ts'
import { validUnifiedPlaybackPayload } from './musicUnifiedPlayback.ts'
import { validEntityMetadataPayload } from './entityMetadata.ts'
import { validMetadataTasksPayload } from './entityMetadataTasks.ts'
import { validIdentificationPayload } from './musicIdentification.ts'
import { validMusicRatingsPayload } from './musicRatings.ts'
import { validMusicPreferencesPayload } from './musicPreferences.ts'
import { validMusicTagsPayload } from './musicTags.ts'
import { validMusicFocusPayload } from './musicFocus.ts'
import { validMusicExplorationPayload } from './musicExploration.ts'
import { validCoreRemotePayload } from './coreRemote.ts'
import { validCoreAudioDiagnosticsPayload } from './coreAudioDiagnostics.ts'
import { validCoreLibraryReadPayload } from './coreLibrary.ts'
import { validCorePlaylistProjectionPayload, validCorePlaylistSubmitPayload } from './corePlaylists.ts'
import { isAuthorizedProviderQueueCover } from './coreQueueSubmission.ts'
import { trackCueRangePropertyIsValid } from './cue.ts'
import { validCoreSettingsBackupPayload } from './coreSettingsBackup.ts'
import { validCoreThemePayload } from './coreThemes.ts'
import { CORE_SPECIALIZED_SETTINGS } from './coreSettings.ts'
import { PERSONAL_DOMAINS, validPersonalExportOptions } from './personalBackup.ts'
import { LIBRARY_PAGE_SIZE, LIBRARY_MAX_PAGE_SIZE } from './libraryDatabase.ts'
import { validCoreAudioPayload } from './coreAudio.ts'
import { validAudioRecoveryPayload } from './audioRecovery.ts'
import {
  CORE_STATE_DOMAINS,
  CORE_STATE_LARGE_ROW_BYTES,
  coreStateBatchByteLimit,
  type CoreStateDomain
} from './coreState.ts'
import type { CoreOperation } from './coreProtocol.ts'
import { isListeningStatsClearRange } from './listeningStatsHistory.ts'
import type { ListeningStatsClearRange } from './listeningStatsHistory.ts'
import { isTwilightMediaProviderMethod } from './mediaProviderMethods.ts'
import { CORE_HOST_PROVIDER_METHODS } from './corePlugins.ts'
import { EXTERNAL_PLAYLIST_MAX_ENTRIES } from './externalPlaylist.ts'
import { isHttpOrHttpsUrl } from './httpUrl.ts'
import { MAX_QUEUE_OCCURRENCE_ID_LENGTH } from './nativeQueue.ts'
import {
  DEFAULT_LYRICS_MANAGEMENT,
  isLyricsManagementDocument,
  MAX_MANAGED_LYRIC_BYTES
} from './lyricsManagement.ts'

type RecordValue = Record<string, unknown>
const record = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max = 32_768): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0')
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const oneOf = (v: unknown, values: readonly unknown[]) => values.includes(v)
const keys = (v: RecordValue, allowed: string[]) =>
  Object.keys(v).every((key) => allowed.includes(key))
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v)
const strings = (v: unknown, count = LIBRARY_MAX_PAGE_SIZE, length = 32_768) =>
  Array.isArray(v) && v.length <= count && v.every((s) => text(s, length))
const modes = ['sequential', 'listLoop', 'repeat', 'shuffle', 'heart']

function queueInput(v: unknown): boolean {
  if (!record(v)) return false
  const display = (track: RecordValue) =>
    ['title', 'artist', 'album'].every(
      (key) => typeof track[key] === 'string' && track[key].length <= 8192
    ) && positive(track.duration)
  switch (v.kind) {
    case 'occurrence':
      return (
        keys(v, ['kind', 'queueId', 'revision', 'occurrenceId']) &&
        text(v.queueId, 128) &&
        uint(v.revision) &&
        text(v.occurrenceId, MAX_QUEUE_OCCURRENCE_ID_LENGTH)
      )
    case 'local':
      return (
        keys(v, ['kind', 'id', 'fallback']) &&
        text(v.id) &&
        optional(
          v.fallback,
          (fallback) =>
            record(fallback) &&
            keys(fallback, [
              'filePath',
              'title',
              'artist',
              'album',
              'duration',
              'subTrack',
              'cueRange'
            ]) &&
            text(fallback.filePath) &&
            display(fallback) &&
            optional(fallback.subTrack, text) &&
            trackCueRangePropertyIsValid(fallback)
        )
      )
    case 'provider':
      return (
        keys(v, ['kind', 'track']) &&
        record(v.track) &&
        keys(v.track, ['id', 'source', 'title', 'artist', 'album', 'duration', 'ncmSongId', 'cover']) &&
        text(v.track.id) &&
        text(v.track.source, 128) &&
        !['local', 'network', 'radio', 'podcast'].includes(v.track.source) &&
        display(v.track) &&
        optional(v.track.ncmSongId, (id) => uint(id) && id > 0) &&
        optional(v.track.cover, (cover) => cover === null || isAuthorizedProviderQueueCover(cover))
      )
    case 'network':
      return (
        keys(v, ['kind', 'revision', 'profileId', 'entryId']) &&
        uint(v.revision) &&
        text(v.profileId, 512) &&
        text(v.entryId)
      )
    case 'stream':
      return (
        keys(v, ['kind', 'source', 'id']) && oneOf(v.source, ['radio', 'podcast']) && text(v.id)
      )
    default:
      return false
  }
}

/** Bound before serializing or forwarding. Only plain, finite JSON data crosses
 * this public seam; cycles, accessors, prototype objects and binary blobs do not. */
export function isBoundedCoreJson(value: unknown, maxBytes: number): boolean {
  let remaining = maxBytes
  const ancestors = new Set<object>()
  const encoder = new TextEncoder()
  function reserve(bytes: number): boolean {
    remaining -= bytes
    return remaining >= 0
  }
  function string(value: string): boolean {
    if (value.length > remaining) return false
    return reserve(encoder.encode(JSON.stringify(value)).length)
  }
  function visit(value: unknown, depth: number): boolean {
    if (value === null) return reserve(4)
    switch (typeof value) {
      case 'string':
        return string(value)
      case 'boolean':
        return reserve(value ? 4 : 5)
      case 'number':
        return Number.isFinite(value) && reserve(String(value).length)
      case 'object': {
        if (depth > 32 || ancestors.has(value!)) return false
        const array = Array.isArray(value)
        if (
          !array &&
          Object.getPrototypeOf(value) !== Object.prototype &&
          Object.getPrototypeOf(value) !== null
        )
          return false
        if (!reserve(2)) return false
        ancestors.add(value!)
        try {
          const allKeys = Object.keys(value!)
          if (
            array &&
            (allKeys.length !== (value as unknown[]).length ||
              allKeys.some((key, index) => key !== String(index)))
          )
            return false
          for (const key of allKeys) {
            const property = Object.getOwnPropertyDescriptor(value, key)!
            if (!('value' in property)) return false
            if (property.value === undefined && !array) continue
            if (
              !reserve(1) ||
              (!array && (!string(key) || !reserve(1))) ||
              !visit(property.value, depth + 1)
            )
              return false
          }
          // Sparse arrays and custom properties are not JSON sequences.
          return true
        } finally {
          ancestors.delete(value!)
        }
      }
      default:
        return false
    }
  }
  return visit(value, 0)
}

function query(v: unknown): boolean {
  if (
    !record(v) ||
    !keys(v, [
      'contentRevision',
      'playlistView',
      'playlistEntryId',
      'aggregate',
      'anchorId',
      'search',
      'searchLiteral',
      'searchFileName',
      'folder',
      'recursive',
      'artist',
      'albumId',
      'genre',
      'genreSeparators',
      'collectionGenre',
      'collectionNamesOnly',
      'collectionSearchMode',
      'collectionSort',
      'collectionCountOnly',
      'collectionOrder',
      'ids',
      'sort',
      'direction',
      'historyRevision',
      'preferredSources',
      'filters',
      'offset',
      'limit'
    ])
  )
    return false
  for (const key of ['contentRevision', 'historyRevision', 'offset'])
    if (!optional(v[key], uint)) return false
  if (!optional(v.limit, (n) => uint(n) && n >= 1 && n <= LIBRARY_MAX_PAGE_SIZE)) return false
  for (const key of [
    'search',
    'folder',
    'artist',
    'albumId',
    'genre',
    'genreSeparators',
    'collectionGenre',
    'anchorId'
  ])
    if (!optional(v[key], (s) => typeof s === 'string' && s.length <= 32_768)) return false
  for (const key of [
    'searchLiteral',
    'searchFileName',
    'recursive',
    'collectionNamesOnly',
    'collectionCountOnly'
  ])
    if (!optional(v[key], (b) => typeof b === 'boolean')) return false
  if (
    !optional(v.playlistView, (s) => text(s, 128)) ||
    !optional(
      v.playlistEntryId,
      (s) => text(v.playlistView, 128) && typeof s === 'string' && /^(0|[1-9]\d{0,6})$/.test(s)
    )
  )
    return false
  if (
    !optional(v.sort, (s) =>
      oneOf(s, [
        'title',
        'artist',
        'album',
        'format',
        'trackNumber',
        'duration',
        'sampleRate',
        'addedAt',
        'recentlyAdded',
        'lastPlayed',
        'playlist',
        'insertion',
        'unifiedSearch'
      ])
    ) ||
    !optional(v.direction, (s) => oneOf(s, ['asc', 'desc']))
  )
    return false
  if (
    !optional(v.collectionSearchMode, (s) => oneOf(s, ['albumTerms', 'artistName'])) ||
    !optional(v.collectionSort, (s) => oneOf(s, ['trackCount', 'label']))
  )
    return false
  if (
    !optional(v.ids, strings) ||
    !optional(v.collectionOrder, (s) => strings(s, 1_000_000)) ||
    !optional(v.preferredSources, (s) => strings(s, 20_000, 8192))
  )
    return false
  if (v.filters !== undefined) {
    const f = v.filters
    if (!record(f) || !keys(f, ['lossless', 'dsd', 'sampleRate', 'bitDepth', 'folder', 'provider']))
      return false
    for (const k of ['lossless', 'dsd'])
      if (!optional(f[k], (b) => typeof b === 'boolean')) return false
    for (const k of ['sampleRate', 'bitDepth'])
      if (!optional(f[k], (n) => positive(n) && n !== 0)) return false
    for (const k of ['folder', 'provider'])
      if (!optional(f[k], (s) => typeof s === 'string' && s.length <= 32_768)) return false
  }
  if (v.aggregate !== undefined) {
    const a = v.aggregate
    if (
      !record(a) ||
      !text(v.playlistView, 128) ||
      !keys(a, ['hiddenSources', 'variantPreferences', 'variantRow', 'sourceCounts'])
    )
      return false
    if (
      !optional(a.hiddenSources, (s) => strings(s, 1_000_000)) ||
      !optional(a.sourceCounts, (b) => typeof b === 'boolean')
    )
      return false
    if (
      !optional(a.variantRow, (s) => typeof s === 'string' && /^(0|[1-9]\d{0,6})$/.test(s)) ||
      (a.sourceCounts === true && a.variantRow !== undefined)
    )
      return false
    if (
      !optional(
        a.variantPreferences,
        (p) => record(p) && Object.entries(p).every(([id, source]) => text(id) && text(source))
      )
    )
      return false
    if (
      !keys(v, [
        'playlistView',
        'playlistEntryId',
        'aggregate',
        'search',
        'searchLiteral',
        'sort',
        'contentRevision',
        'offset',
        'limit',
        'anchorId'
      ]) ||
      (v.sort !== undefined && v.sort !== 'playlist')
    )
      return false
  }
  return true
}

function edit(v: unknown): boolean {
  if (!record(v)) return false
  const entry = (v: unknown) => text(v, MAX_QUEUE_OCCURRENCE_ID_LENGTH)
  switch (v.kind) {
    case 'undo':
    case 'clear':
      return keys(v, ['kind'])
    case 'remove':
      return (
        keys(v, ['kind', 'entryIds']) &&
        strings(v.entryIds, LIBRARY_MAX_PAGE_SIZE, MAX_QUEUE_OCCURRENCE_ID_LENGTH)
      )
    case 'move':
      return (
        keys(v, ['kind', 'entryId', 'beforeEntryId']) &&
        entry(v.entryId) &&
        (v.beforeEntryId === null || entry(v.beforeEntryId))
      )
    case 'order':
      return keys(v, ['kind', 'order']) && oneOf(v.order, ['original', 'shuffle'])
    case 'insert': {
      if (
        !keys(v, ['kind', 'trackIds', 'items', 'beforeEntryId', 'afterEntryId']) ||
        !optional(v.beforeEntryId, entry) ||
        !optional(v.afterEntryId, entry) ||
        (v.beforeEntryId !== undefined && v.afterEntryId !== undefined)
      )
        return false
      if ((v.trackIds === undefined) === (v.items === undefined)) return false
      if (v.trackIds !== undefined) return strings(v.trackIds)
      return (
        Array.isArray(v.items) &&
        v.items.length <= LIBRARY_MAX_PAGE_SIZE &&
        v.items.every(
          (item) =>
            record(item) &&
            keys(item, ['id', 'snapshot']) &&
            text(item.id) &&
            optional(
              item.snapshot,
              (s) =>
                record(s) &&
                s.id === item.id &&
                text(s.filePath) &&
                isBoundedCoreJson(s, 512 * 1024)
            )
        )
      )
    }
    default:
      return false
  }
}

export function validCorePayload(name: CoreOperation, payload: unknown): boolean {
  const budget =
    name === 'providers.call' || name === 'extensions.execute' || name === 'settings.edit'
      ? 512 * 1024
      : name === 'audio.dsp.edit'
        ? 4 * 1024 * 1024
        : name.startsWith('audio.')
          ? 128 * 1024
          : name === 'migration.stage'
            ? CORE_STATE_LARGE_ROW_BYTES + 64 * 1024
            : name === 'queue.edit'
              ? 8 * 1024 * 1024 + 64 * 1024
              : 32 * 1024 * 1024
  if (!isBoundedCoreJson(payload, budget) || !record(payload)) return false
  const p = payload
  switch (name) {
    case 'opra.search':
      return keys(p, ['query']) && typeof p.query === 'string' && p.query.length <= 256 && !p.query.includes('\0')
    case 'opra.profile':
      return keys(p, ['id']) && typeof p.id === 'string' && p.id.length <= 128 && !p.id.includes('\0')
    case 'opra.status':
    case 'opra.refresh':
      return keys(p, [])
    case 'audio.diagnostics':
      return validCoreAudioDiagnosticsPayload(p)
    case 'playlists.submit':
      return validCorePlaylistSubmitPayload(p, queueInput)
    case 'player.presentation':
    case 'player.lyrics':
    case 'playback.diagnostics':
      return keys(p, [])
    case 'playback.favorite':
      return (
        keys(p, ['trackId', 'occurrenceId']) &&
        text(p.trackId) &&
        (p.occurrenceId === null || text(p.occurrenceId, MAX_QUEUE_OCCURRENCE_ID_LENGTH))
      )
    case 'playback.control':
      switch (p.type) {
        case 'toggle-play':
        case 'play':
        case 'pause':
        case 'previous':
        case 'next':
        case 'cycle-play-mode':
        case 'toggle-favorite':
        case 'stop':
          return keys(p, ['type'])
        case 'seek':
        case 'set-volume':
          return (
            keys(p, ['type', 'value']) &&
            positive(p.value) &&
            (p.type !== 'set-volume' || p.value <= 1)
          )
        case 'set-play-mode':
          return keys(p, ['type', 'value']) && oneOf(p.value, modes)
        case 'volume-step':
          return keys(p, ['type', 'direction']) && oneOf(p.direction, ['volumeUp', 'volumeDown'])
        case 'queue-jump':
          return (
            keys(p, ['type', 'id', 'revision', 'index', 'occurrenceId']) &&
            text(p.id, 128) &&
            uint(p.revision) &&
            uint(p.index) &&
            text(p.occurrenceId, MAX_QUEUE_OCCURRENCE_ID_LENGTH)
          )
        default:
          return false
      }
    case 'queue.locate':
      return (
        keys(p, ['id', 'revision', 'occurrenceId']) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        text(p.occurrenceId, MAX_QUEUE_OCCURRENCE_ID_LENGTH)
      )
    case 'queue.insert':
      return (
        keys(p, ['id', 'revision', 'items', 'afterEntryId', 'beforeEntryId']) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        Array.isArray(p.items) &&
        p.items.length > 0 &&
        p.items.length <= 200 &&
        p.items.every(queueInput) &&
        optional(p.afterEntryId, (id) => text(id, MAX_QUEUE_OCCURRENCE_ID_LENGTH)) &&
        optional(p.beforeEntryId, (id) => text(id, MAX_QUEUE_OCCURRENCE_ID_LENGTH)) &&
        !(p.afterEntryId !== undefined && p.beforeEntryId !== undefined)
      )
    case 'playlists.saveQueue':
      return (
        keys(p, ['name', 'revision', 'queue']) &&
        text(p.name, 120) &&
        uint(p.revision) &&
        record(p.queue) &&
        keys(p.queue, ['id', 'revision']) &&
        text(p.queue.id, 128) &&
        uint(p.queue.revision)
      )
    case 'playlists.addQueueEntries':
      return (
        keys(p, ['id', 'revision', 'queue', 'occurrenceIds']) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        record(p.queue) &&
        keys(p.queue, ['id', 'revision']) &&
        text(p.queue.id, 128) &&
        uint(p.queue.revision) &&
        Array.isArray(p.occurrenceIds) &&
        p.occurrenceIds.length > 0 &&
        p.occurrenceIds.length <= 200 &&
        p.occurrenceIds.every((id) => text(id, MAX_QUEUE_OCCURRENCE_ID_LENGTH))
      )
    case 'themes.list':
    case 'themes.bootstrap':
    case 'themes.edit':
    case 'themes.import':
    case 'themes.export':
    case 'themes.importAsset':
    case 'themes.validateAssets':
    case 'themes.copyAssets':
    case 'themes.reconcile':
      return isBoundedCoreJson(p, 2 * 1024 * 1024) && validCoreThemePayload(name, p)
    case 'visualization.unsubscribe':
      return keys(p, ['subscriptionId']) && text(p.subscriptionId, 128)
    case 'visualization.subscribe':
      return (
        keys(p, ['subscriptionId', 'options']) &&
        text(p.subscriptionId, 128) &&
        optional(
          p.options,
          (options) =>
            record(options) &&
            keys(options, [
              'spectrumPoints',
              'waveformPoints',
              'spectrogramFrames',
              'oscilloscopePoints',
              'visualizerBarCount'
            ]) &&
            Object.entries(options).every(
              ([key, value]) =>
                uint(value) &&
                value <=
                  (key === 'spectrogramFrames' ? 64 : key === 'visualizerBarCount' ? 256 : 4096)
            )
        )
      )
    case 'automix.install.start':
      return keys(p, ['enableAfterInstall']) && typeof p.enableAfterInstall === 'boolean'
    case 'automix.install.cancel':
    case 'automix.install.status':
      return keys(p, [])
    case 'settings.restore':
    case 'settings.backup':
      return validCoreSettingsBackupPayload(name, p)
    case 'ncm.cloud.chooseUploadFiles':
    case 'ncm.cloud.state':
      return keys(p, [])
    case 'ncm.cloud.upload':
      return keys(p, ['handle']) && text(p.handle, 128)
    case 'ncm.cloud.cancel':
      return keys(p, ['id']) && text(p.id, 128)
    case 'ncm.cloud.download':
      return (
        keys(p, ['cloudSongId', 'fileName']) &&
        text(p.fileName, 255) &&
        ((typeof p.cloudSongId === 'string' && /^[\x21-\x7e]{1,128}$/.test(p.cloudSongId.trim())) ||
          (uint(p.cloudSongId) && p.cloudSongId > 0))
      )
    case 'ncm.cloud.page':
      return (
        keys(p, ['revision', 'offset', 'limit']) &&
        uint(p.revision) &&
        optional(p.offset, uint) &&
        optional(p.limit, (v) => uint(v) && v > 0 && v <= 200)
      )
    case 'library.inbox.refresh':
      return keys(p, ['duplicatesId']) && optional(p.duplicatesId, (v) => text(v, 128))
    case 'library.health.start':
    case 'library.health.status':
    case 'library.health.page':
    case 'library.health.repair':
      return validLibraryHealthPayload(name, p)
    case 'library.inbox.mark':
      return (
        keys(p, ['id', 'revision', 'indexes', 'status']) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        Array.isArray(p.indexes) &&
        p.indexes.length > 0 &&
        p.indexes.length <= 128 &&
        p.indexes.every(uint) &&
        oneOf(p.status, ['pending', 'ignored', 'done'])
      )
    case 'library.inbox.page':
      return (
        keys(p, ['id', 'revision', 'kind', 'status', 'offset', 'limit']) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        optional(p.kind, (v) => oneOf(v, ['cover', 'tags', 'enrichment', 'duplicate'])) &&
        optional(p.status, (v) => oneOf(v, ['pending', 'ignored', 'done'])) &&
        optional(p.offset, uint) &&
        optional(p.limit, (v) => uint(v) && v > 0 && v <= 200)
      )
    case 'library.loudness.prepare':
      return (
        keys(p, ['selection', 'mode']) &&
        oneOf(p.mode, ['track', 'album']) &&
        validCorePayload('library.selection.open', p.selection)
      )
    case 'library.loudness.start':
    case 'library.loudness.cancel':
    case 'library.loudness.clear':
      return keys(p, ['id']) && text(p.id, 128)
    case 'library.loudness.state':
      return Object.keys(p).length === 0
    case 'library.loudness.page':
      return (
        keys(p, ['id', 'offset', 'limit']) &&
        text(p.id, 128) &&
        optional(p.offset, uint) &&
        optional(p.limit, (v) => uint(v) && v > 0 && v <= 200)
      )
    case 'library.loudness.result':
      return keys(p, ['id', 'index']) && text(p.id, 128) && uint(p.index)
    case 'analysis.request':
      return (
        keys(p, ['kind', 'id', 'version']) &&
        oneOf(p.kind, ['bpm', 'loudness']) &&
        text(p.id, 8192) &&
        uint(p.version)
      )
    case 'analysis.cache.clear':
    case 'analysis.cache.size':
      return keys(p, ['kind']) && oneOf(p.kind, ['bpm', 'loudness'])
    case 'analysis.loudness.status':
      return Object.keys(p).length === 0
    case 'backup.export':
      return validPersonalExportOptions(p)
    case 'backup.preview':
    case 'backup.recover':
    case 'backup.chooseFolder':
      return Object.keys(p).length === 0
    case 'backup.repreview':
    case 'backup.stage': {
      const options = p.options
      return (
        keys(p, ['id', 'options']) &&
        text(p.id, 128) &&
        record(options) &&
        keys(options, ['domains', 'conflict', 'mappings']) &&
        oneOf(options.conflict, ['keep-local', 'use-backup']) &&
        Array.isArray(options.domains) &&
        options.domains.length > 0 &&
        options.domains.length <= PERSONAL_DOMAINS.length &&
        new Set(options.domains).size === options.domains.length &&
        options.domains.every((domain) => oneOf(domain, PERSONAL_DOMAINS)) &&
        Array.isArray(options.mappings) &&
        options.mappings.length <= 100 &&
        options.mappings.every(
          (mapping) =>
            record(mapping) &&
            keys(mapping, ['from', 'to']) &&
            text(mapping.from, 4095) &&
            text(mapping.to, 4095)
        )
      )
    }
    case 'library.duplicates.start':
    case 'library.duplicates.status':
      return Object.keys(p).length === 0
    case 'library.duplicates.cancel':
      return keys(p, ['id']) && text(p.id, 128)
    case 'library.duplicates.groups':
    case 'library.duplicates.items':
    case 'library.duplicates.unavailable':
      return (
        keys(p, [
          'id',
          'offset',
          'limit',
          ...(name === 'library.duplicates.items' ? ['group'] : [])
        ]) &&
        text(p.id, 128) &&
        optional(p.offset, uint) &&
        optional(p.limit, (v) => uint(v) && Number(v) > 0 && Number(v) <= 200) &&
        (name !== 'library.duplicates.items' || uint(p.group))
      )
    case 'playlists.repair':
      return (
        keys(p, ['id', 'revision', 'folder']) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        text(p.folder, 32768)
      )
    case 'playlists.repair.status':
      return Object.keys(p).length === 0
    case 'library.selection.open': {
      const scope = p.query,
        total = p.total
      if (
        !keys(p, ['query', 'total', 'ranges']) ||
        !query(scope) ||
        !record(scope) ||
        !uint(scope.contentRevision) ||
        !uint(total) ||
        !Array.isArray(p.ranges) ||
        p.ranges.length > 4096 ||
        ['offset', 'limit', 'anchorId', 'playlistEntryId', 'aggregate'].some(
          (key) => scope[key] !== undefined
        ) ||
        (scope.sort === 'lastPlayed' && !uint(scope.historyRevision))
      )
        return false
      let previous = -1
      return p.ranges.every((range) => {
        if (
          !Array.isArray(range) ||
          range.length !== 2 ||
          !range.every(uint) ||
          range[0] <= previous ||
          range[1] <= range[0] ||
          range[1] > total
        )
          return false
        previous = range[1]
        return true
      })
    }
    case 'library.selection.close':
      return keys(p, ['id']) && text(p.id, 128)
    case 'library.selection.page':
      return (
        keys(p, ['id', 'cursor', 'projection']) &&
        text(p.id, 128) &&
        optional(p.cursor, uint) &&
        optional(p.projection, (v) => oneOf(v, ['tracks', 'files']))
      )
    case 'library.remove':
      return (
        keys(p, ['selectionId', 'mode']) &&
        text(p.selectionId, 128) &&
        oneOf(p.mode, ['library', 'trash'])
      )
    case 'library.reset':
      return keys(p, ['revision']) && uint(p.revision)
    case 'library.exclusions.clear':
      return keys(p, ['revision', 'paths']) && uint(p.revision) && strings(p.paths, 256, 4096)
    case 'library.tags.restore':
      return (
        keys(p, ['selectionId', 'fromJournal']) &&
        (p.fromJournal === true
          ? p.selectionId === undefined
          : text(p.selectionId, 128) && p.fromJournal === undefined)
      )
    case 'library.tags.write':
      return (
        keys(p, ['selectionId', 'patch', 'items']) &&
        text(p.selectionId, 128) &&
        (p.patch !== undefined || p.items !== undefined) &&
        optional(p.patch, tagPatch) &&
        optional(
          p.items,
          (items) =>
            Array.isArray(items) &&
            items.length > 0 &&
            items.length <= 1000 &&
            items.every(
              (item) =>
                record(item) &&
                keys(item, ['id', 'patch']) &&
                text(item.id, 4096) &&
                tagPatch(item.patch)
            )
        )
      )
    case 'automix.capabilities':
      return keys(p, ['refresh']) && optional(p.refresh, (v) => typeof v === 'boolean')
    case 'settings.state':
    case 'sleep.state':
      return keys(p, [])
    case 'sleep.configure':
      return (
        keys(p, ['revision', 'mode', 'minutes']) &&
        uint(p.revision) &&
        oneOf(p.mode, ['minutes', 'trackEnd', 'queueEnd']) &&
        optional(p.minutes, (v) => uint(v) && Number(v) >= 1 && Number(v) <= 720)
      )
    case 'sleep.cancel':
      return keys(p, ['revision']) && uint(p.revision)
    case 'settings.edit':
      return (
        keys(p, ['revision', 'patch']) &&
        uint(p.revision) &&
        record(p.patch) &&
        Object.keys(p.patch).every(
          (key) => !(CORE_SPECIALIZED_SETTINGS as readonly string[]).includes(key)
        )
      )
    case 'remote.status':
    case 'remote.setEnabled':
    case 'remote.decidePairing':
    case 'remote.revokeDevice':
    case 'remote.rotatePin':
      return validCoreRemotePayload(name, p)
    case 'cast.state':
    case 'cast.discover':
      return keys(p, [])
    case 'cast.devices':
      return (
        keys(p, ['offset', 'limit']) &&
        uint(p.offset) &&
        uint(p.limit) &&
        p.limit > 0 &&
        p.limit <= 100
      )
    case 'cast.end':
      return keys(p, ['revision']) && uint(p.revision)
    case 'cast.start':
      return (
        keys(p, ['revision', 'deviceId', 'queue']) &&
        uint(p.revision) &&
        text(p.deviceId, 512) &&
        record(p.queue) &&
        keys(p.queue, ['id', 'revision', 'occurrenceId']) &&
        text(p.queue.id, 512) &&
        uint(p.queue.revision) &&
        text(p.queue.occurrenceId, MAX_QUEUE_OCCURRENCE_ID_LENGTH)
      )

    case 'audio.audition':
    case 'audio.audition.measure':
    case 'audio.audition.select':
    case 'audio.audition.end':
    case 'audio.dsp':
    case 'audio.dsp.status':
    case 'audio.dsp.assets':
    case 'audio.dsp.correction':
    case 'audio.dsp.edit':
    case 'audio.dsp.import':
    case 'audio.dsp.export':
    case 'audio.dsp.assetRemove':
    case 'audio.vst3':
    case 'audio.vst3.parameters':
    case 'audio.vst3.edit':
    case 'audio.vst3.chooseDirectory':
      return validCoreDspPayload(name, p)
    case 'audio.recovery':
    case 'audio.recovery.start':
      return validAudioRecoveryPayload(name, p)
    case 'audio.output':
    case 'audio.outputTest':
    case 'audio.outputTest.play':
    case 'audio.outputTest.stop':
    case 'audio.profiles':
    case 'audio.output.edit':
    case 'audio.profiles.edit':
      return validCoreAudioPayload(name, p)
    case 'liked.play':
      return (
        keys(p, ['selectedId', 'play']) &&
        optional(p.selectedId, text) &&
        optional(p.play, (value) => typeof value === 'boolean')
      )
    case 'personalized.start':
      return (
        keys(p, ['providerId', 'key', 'selectedId', 'play']) &&
        text(p.providerId, 128) &&
        /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(p.providerId) &&
        oneOf(p.key, ['fm', 'radar']) &&
        optional(p.selectedId, text) &&
        optional(p.play, (value) => typeof value === 'boolean')
      )
    case 'heart.refill':
    case 'personalized.refill':
      return keys(p, ['id', 'revision']) && text(p.id, 128) && uint(p.revision)
    case 'downloads.state':
      return keys(p, [])
    case 'downloads.page':
      return (
        keys(p, ['revision', 'offset', 'limit']) &&
        uint(p.revision) &&
        optional(p.offset, uint) &&
        optional(p.limit, (v) => uint(v) && Number(v) > 0 && Number(v) <= 200)
      )
    case 'downloads.cancel':
    case 'downloads.retry':
    case 'downloads.reveal':
    case 'downloads.indexed':
      return keys(p, ['id']) && text(p.id, 128)
    case 'downloads.result':
      return (
        keys(p, ['id', 'addToLibrary']) && text(p.id, 128) && typeof p.addToLibrary === 'boolean'
      )
    case 'downloads.play':
      return (
        keys(p, ['id', 'play']) &&
        text(p.id, 128) &&
        optional(p.play, (v) => typeof v === 'boolean')
      )
    case 'downloads.create':
      return (
        keys(p, ['providerId', 'track', 'quality', 'targetRoot']) &&
        text(p.providerId, 128) &&
        oneOf(p.quality, ['aac', 'lossless', 'hi-res']) &&
        optional(p.targetRoot, text) &&
        record(p.track) &&
        isBoundedCoreJson(p.track, 64 * 1024) &&
        (text(p.track.id, 8192) ||
          (typeof p.track.id === 'number' && Number.isFinite(p.track.id))) &&
        text(p.track.title, 300) &&
        text(p.track.artist, 300) &&
        optional(p.track.album, (v) => typeof v === 'string' && v.length <= 300) &&
        optional(p.track.cover, (v) => typeof v === 'string' && v.length <= 32768)
      )
    case 'network.state':
    case 'cache.info':
    case 'cache.clear':
    case 'network.cacheInfo':
    case 'network.clearCache':
      return keys(p, [])
    case 'network.test':
      return keys(p, ['profileId']) && text(p.profileId, 128)
    case 'network.cover':
      return keys(p, ['profileId', 'entryId']) && text(p.profileId, 128) && text(p.entryId, 128)
    case 'network.profiles':
    case 'network.library':
    case 'network.directory':
      return (
        keys(p, [
          'revision',
          'offset',
          'limit',
          ...(name === 'network.directory'
            ? ['profileId', 'path', 'token']
            : name === 'network.library'
              ? ['profileId', 'query']
              : [])
        ]) &&
        uint(p.revision) &&
        optional(p.offset, uint) &&
        optional(p.limit, (v) => uint(v) && Number(v) > 0 && Number(v) <= 200) &&
        (name !== 'network.directory' ||
          (text(p.profileId, 128) &&
            text(p.path, 4096) &&
            optional(p.token, (v) => text(v, 128)))) &&
        (name !== 'network.library' ||
          (optional(p.profileId, (v) => text(v, 128)) &&
            optional(p.query, (v) => typeof v === 'string' && v.length <= 256)))
      )
    case 'network.profiles.edit':
      if (!uint(p.revision)) return false
      switch (p.kind) {
        case 'create':
          return keys(p, ['revision', 'kind', 'input']) && networkProfile(p.input, false)
        case 'update':
          return (
            keys(p, ['revision', 'kind', 'id', 'patch']) &&
            text(p.id, 128) &&
            networkProfile(p.patch, true)
          )
        case 'delete':
          return keys(p, ['revision', 'kind', 'id']) && text(p.id, 128)
        default:
          return false
      }
    case 'network.job':
      if (!uint(p.revision)) return false
      return p.kind === 'scan'
        ? keys(p, ['revision', 'kind', 'profileId', 'path']) &&
            text(p.profileId, 128) &&
            text(p.path, 4096)
        : p.kind === 'enrich'
          ? keys(p, ['revision', 'kind', 'profileId']) && text(p.profileId, 128)
          : p.kind === 'cancel' && keys(p, ['revision', 'kind', 'id']) && text(p.id, 128)
    case 'network.removeEntry':
    case 'network.play':
      return (
        keys(p, [
          'revision',
          'profileId',
          'entryId',
          ...(name === 'network.play' ? ['play'] : [])
        ]) &&
        uint(p.revision) &&
        text(p.profileId, 128) &&
        text(p.entryId, 128) &&
        optional(p.play, (v) => typeof v === 'boolean')
      )
    case 'streams.state':
      return keys(p, [])
    case 'radio.stations':
    case 'podcasts.subscriptions':
    case 'podcasts.episodes':
      return (
        keys(
          p,
          name === 'podcasts.episodes'
            ? ['revision', 'offset', 'limit', 'id']
            : ['revision', 'offset', 'limit']
        ) &&
        uint(p.revision) &&
        optional(p.offset, uint) &&
        optional(p.limit, (n) => uint(n) && n > 0 && n <= 200) &&
        (name !== 'podcasts.episodes' || text(p.id, 128))
      )
    case 'radio.directory':
      return (
        keys(p, ['query', 'offset', 'limit']) &&
        typeof p.query === 'string' &&
        p.query.length <= 120 &&
        !p.query.includes('\0') &&
        optional(p.offset, (n) => uint(n) && n <= 10_000) &&
        optional(p.limit, (n) => uint(n) && n > 0 && n <= 50)
      )
    case 'radio.edit': {
      if (!keys(p, ['revision', 'edit']) || !uint(p.revision) || !record(p.edit)) return false
      const e = p.edit
      switch (e.kind) {
        case 'remove':
          return keys(e, ['kind', 'id']) && text(e.id, 128)
        case 'add':
          return (
            keys(e, [
              'kind',
              'name',
              'streamUrl',
              'homepage',
              'favicon',
              'tags',
              'allowInsecureHttp'
            ]) &&
            text(e.name, 120) &&
            text(e.streamUrl, 2048) &&
            isHttpOrHttpsUrl(e.streamUrl) &&
            optional(e.homepage, (v) => text(v, 2048) && isHttpOrHttpsUrl(v)) &&
            optional(e.favicon, (v) => text(v, 2048) && isHttpOrHttpsUrl(v)) &&
            optional(e.tags, (v) => strings(v, 16, 40)) &&
            optional(e.allowInsecureHttp, (v) => typeof v === 'boolean')
          )
        case 'import':
          return (
            keys(e, ['kind', 'text', 'fileNameHint', 'allowInsecureHttp']) &&
            text(e.text, 2 * 1024 * 1024) &&
            new TextEncoder().encode(e.text).length <= 2 * 1024 * 1024 &&
            optional(e.fileNameHint, (v) => text(v, 255)) &&
            optional(e.allowInsecureHttp, (v) => typeof v === 'boolean')
          )
        default:
          return false
      }
    }
    case 'podcasts.subscribe':
      return (
        keys(p, ['revision', 'feedUrl']) &&
        uint(p.revision) &&
        text(p.feedUrl, 2048) &&
        isHttpOrHttpsUrl(p.feedUrl)
      )
    case 'podcasts.edit': {
      if (!keys(p, ['revision', 'edit']) || !uint(p.revision) || !record(p.edit)) return false
      const e = p.edit
      return e.kind === 'unsubscribe'
        ? keys(e, ['kind', 'id']) && text(e.id, 128)
        : e.kind === 'restore' && keys(e, ['kind', 'token']) && text(e.token, 128)
    }
    case 'podcasts.refresh':
      return keys(p, ['revision', 'id']) && uint(p.revision) && optional(p.id, (v) => text(v, 128))
    case 'podcasts.defaultRate':
    case 'playback.rate':
      return (
        keys(p, name === 'podcasts.defaultRate' ? ['revision', 'rate'] : ['rate']) &&
        (name !== 'podcasts.defaultRate' || uint(p.revision)) &&
        typeof p.rate === 'number' &&
        Number.isFinite(p.rate) &&
        p.rate >= 0.5 &&
        p.rate <= 2
      )
    case 'streams.play':
      return (
        keys(
          p,
          p.kind === 'podcast'
            ? ['kind', 'id', 'guid', 'revision', 'play', 'resume']
            : ['kind', 'id', 'revision', 'play']
        ) &&
        oneOf(p.kind, ['radio', 'podcast']) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        optional(p.play, (v) => typeof v === 'boolean') &&
        (p.kind !== 'podcast' ||
          (text(p.guid, 512) && optional(p.resume, (v) => typeof v === 'boolean')))
      )
    case 'workspace.state':
      return keys(p, [])
    case 'workspace.sessions':
    case 'workspace.history':
      return (
        keys(p, ['revision', 'contentRevision', 'offset', 'limit']) &&
        uint(p.revision) &&
        uint(p.contentRevision) &&
        optional(p.offset, uint) &&
        optional(p.limit, (n) => uint(n) && n > 0 && n <= LIBRARY_PAGE_SIZE)
      )
    case 'workspace.edit': {
      if (!keys(p, ['revision', 'edit']) || !uint(p.revision) || !record(p.edit)) return false
      const edit = p.edit
      switch (edit.kind) {
        case 'saveCurrent':
          return (
            keys(edit, ['kind', 'name', 'id']) &&
            text(edit.name, 120) &&
            optional(edit.id, (v) => text(v, 128))
          )
        case 'rename':
          return keys(edit, ['kind', 'name', 'id']) && text(edit.name, 120) && text(edit.id, 128)
        case 'remove':
          return keys(edit, ['kind', 'id']) && text(edit.id, 128)
        default:
          return false
      }
    }
    case 'workspace.restore':
      return (
        keys(p, ['revision', 'id', 'play']) &&
        uint(p.revision) &&
        text(p.id, 128) &&
        optional(p.play, (v) => typeof v === 'boolean')
      )
    case 'lyrics.state':
    case 'lyrics.current':
    case 'lyrics.importDraft':
      return keys(p, [])
    case 'lyrics.entry':
      return keys(p, ['trackId']) && text(p.trackId, 1024)
    case 'lyrics.search':
    case 'lyrics.reload':
      return (
        keys(p, ['trackId', 'occurrenceId']) &&
        text(p.trackId, 1024) &&
        (p.occurrenceId === null || text(p.occurrenceId, MAX_QUEUE_OCCURRENCE_ID_LENGTH))
      )
    case 'lyrics.exportDraft':
      return (
        keys(p, ['contents']) &&
        typeof p.contents === 'string' &&
        new TextEncoder().encode(p.contents).length <= MAX_MANAGED_LYRIC_BYTES
      )
    case 'lyrics.edit': {
      if (!keys(p, ['revision', 'edit']) || !uint(p.revision) || !record(p.edit)) return false
      const edit = p.edit
      switch (edit.kind) {
        case 'globalOffset':
          return (
            keys(edit, ['kind', 'offsetMs']) &&
            typeof edit.offsetMs === 'number' &&
            Number.isFinite(edit.offsetMs)
          )
        case 'visibility':
          return (
            keys(edit, ['kind', 'patch']) &&
            record(edit.patch) &&
            keys(edit.patch, ['showOriginal', 'showTranslation', 'showRomanization']) &&
            Object.values(edit.patch).every((value) => typeof value === 'boolean')
          )
        case 'track':
          return (
            keys(edit, ['kind', 'trackId', 'patch']) &&
            text(edit.trackId, 1024) &&
            record(edit.patch) &&
            keys(edit.patch, [
              'offsetMs',
              'source',
              'originalSelection',
              'translationSelection',
              'romanizationSelection',
              'original',
              'translation',
              'romanization'
            ]) &&
            isLyricsManagementDocument({
              ...DEFAULT_LYRICS_MANAGEMENT,
              tracks: {
                [edit.trackId]: {
                  offsetMs: 0,
                  source: 'auto',
                  original: null,
                  translation: null,
                  romanization: null,
                  updatedAt: '',
                  ...edit.patch
                }
              }
            })
          )
        default:
          return false
      }
    }
    case 'bookmarks.state':
      return keys(p, [])
    case 'bookmarks.page':
      return (
        keys(p, ['revision', 'scope', 'offset', 'limit']) &&
        uint(p.revision) &&
        oneOf(p.scope, ['all', 'current']) &&
        optional(p.offset, uint) &&
        optional(p.limit, (n) => uint(n) && n > 0 && n <= LIBRARY_PAGE_SIZE)
      )
    case 'bookmarks.seek':
      return (
        keys(p, ['id', 'revision', 'current']) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        validBookmarkCurrent(p.current)
      )
    case 'bookmarks.edit': {
      if (!keys(p, ['revision', 'edit']) || !uint(p.revision) || !record(p.edit)) return false
      const edit = p.edit
      switch (edit.kind) {
        case 'addCurrent':
          return (
            keys(edit, ['kind', 'current', 'label']) &&
            validBookmarkCurrent(edit.current) &&
            optional(edit.label, (s) => typeof s === 'string' && s.length <= 120)
          )
        case 'remove':
          return keys(edit, ['kind', 'id']) && text(edit.id, 128)
        case 'rename':
          return (
            keys(edit, ['kind', 'id', 'label']) &&
            text(edit.id, 128) &&
            typeof edit.label === 'string' &&
            edit.label.length <= 120
          )
        case 'threshold':
          return keys(edit, ['kind', 'seconds']) && positive(edit.seconds)
        case 'dismissOffer':
          return keys(edit, ['kind', 'current']) && validBookmarkCurrent(edit.current)
        default:
          return false
      }
    }
    case 'imports.previewStart':
      return (
        keys(p, ['link', 'credentials']) &&
        text(p.link, 4096) &&
        optional(
          p.credentials,
          (v) =>
            record(v) &&
            keys(v, ['accessToken', 'developerToken', 'userToken', 'country']) &&
            ['accessToken', 'developerToken', 'userToken'].every((key) =>
              optional(v[key], (s) => text(s, 16384) && !/[\r\n]/.test(s))
            ) &&
            optional(v.country, (s) => typeof s === 'string' && /^[a-zA-Z]{2}$/.test(s))
        )
      )
    case 'imports.previewConfigure':
      return (
        keys(p, ['id', 'revision', 'name', 'playlistIndex', 'columns']) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        optional(p.name, (s) => text(s, 80)) &&
        optional(p.playlistIndex, uint) &&
        optional(
          p.columns,
          (v) =>
            record(v) &&
            keys(v, ['title', 'artist', 'album', 'duration', 'isrc', 'location']) &&
            Object.values(v).every((n) => optional(n, uint))
        )
      )
    case 'imports.previewBind':
    case 'imports.bind':
      return (
        keys(p, ['id', 'revision', 'entryId', 'input']) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        text(p.entryId, 128) && (p.input === null || queueInput(p.input))
      )
    case 'playlists.replaceSource':
      return keys(p, ['revision', 'oldTrackId', 'input']) && uint(p.revision) && text(p.oldTrackId) && queueInput(p.input)
    case 'playlists.rematch':
      return keys(p, ['revision', 'input']) && uint(p.revision) && queueInput(p.input)
    case 'library.reveal':
      return keys(p, ['id', 'version']) && text(p.id) && optional(p.version, uint)
    case 'imports.previewSave':
      return (
        keys(p, ['id', 'revision', 'playlistsRevision', 'target']) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        uint(p.playlistsRevision) &&
        optional(
          p.target,
          (v) =>
            record(v) &&
            keys(v, ['id', 'generation', 'overwrite']) &&
            text(v.id, 128) &&
            text(v.generation, 128) &&
            optional(v.overwrite, (b) => typeof b === 'boolean')
        )
      )
    case 'imports.previewDiscard':
      return keys(p, ['id', 'revision']) && text(p.id, 128) && uint(p.revision)
    case 'imports.previews':
      return (
        keys(p, ['offset', 'limit']) &&
        optional(p.offset, uint) &&
        optional(p.limit, (n) => uint(n) && n > 0 && n <= LIBRARY_PAGE_SIZE)
      )
    case 'imports.previewPage':
      return (
        keys(p, ['id', 'revision', 'offset', 'limit']) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        optional(p.offset, uint) &&
        optional(p.limit, (n) => uint(n) && n > 0 && n <= LIBRARY_PAGE_SIZE)
      )
    case 'imports.previewChoices':
      return (
        keys(p, ['id', 'revision', 'kind', 'offset', 'limit']) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        oneOf(p.kind, ['columns', 'playlists']) &&
        optional(p.offset, uint) &&
        optional(p.limit, (n) => uint(n) && n > 0 && n <= LIBRARY_PAGE_SIZE)
      )
    case 'imports.preview':
      return keys(p, ['id']) && text(p.id, 128)
    case 'imports.retry':
      return (
        keys(p, ['id', 'force', 'entries']) &&
        text(p.id, 128) &&
        optional(p.force, (b) => typeof b === 'boolean') &&
        optional(p.entries, (s) => strings(s, EXTERNAL_PLAYLIST_MAX_ENTRIES, 128))
      )
    case 'imports.cancel':
    case 'imports.status':
      return keys(p, ['id']) && text(p.id, 128)
    case 'playlists.view':
      return (
        keys(p, [
          'id',
          'revision',
          'versionsRevision',
          'contentRevision',
          'offset',
          'limit',
          'search',
          'anchorId',
          'preserveSources',
          'includeHiddenSources',
          'variantRow',
          'sourceCounts'
          ,'query'
        ]) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        uint(p.versionsRevision) &&
        optional(p.contentRevision, uint) &&
        optional(p.includeHiddenSources, (b) => typeof b === 'boolean') &&
        optional(p.query, query) &&
        optional(p.offset, uint) &&
        optional(p.limit, (n) => uint(n) && n > 0 && n <= LIBRARY_PAGE_SIZE) &&
        optional(p.search, (s) => typeof s === 'string' && s.length <= 32768) &&
        optional(p.anchorId, (s) => text(s, 128)) &&
        optional(p.preserveSources, (b) => typeof b === 'boolean') &&
        optional(p.sourceCounts, (b) => typeof b === 'boolean') &&
        optional(p.variantRow, (s) => typeof s === 'string' && /^(0|[1-9]\d{0,6})$/.test(s)) &&
        !(p.sourceCounts === true && p.variantRow !== undefined)
      )
    case 'identification.start':
    case 'identification.status':
    case 'identification.detail':
    case 'identification.candidates':
    case 'identification.history':
    case 'identification.restorePreview':
    case 'identification.restore':
    case 'identification.inbox':
    case 'identification.preview':
    case 'identification.decide':
    case 'identification.detach':
      return validIdentificationPayload(name, p)
    case 'metadata.entity.sources':
    case 'metadata.entity.requery':
    case 'metadata.entity.tasks':
    case 'metadata.entity.demands':
      return validMetadataTasksPayload(name, p)
    case 'metadata.entity.policy':
    case 'metadata.entity.detail':
    case 'metadata.entity.jobs':
    case 'metadata.entity.credits':
    case 'metadata.entity.resolve':
    case 'metadata.entity.enrich':
    case 'metadata.entity.decide':
    case 'metadata.entity.detach':
    case 'metadata.entity.override':
    case 'metadata.entity.sourcePreference':
    case 'metadata.entity.artworkOverride':
    case 'metadata.entity.cancel':
      return validEntityMetadataPayload(name, p)
    case 'genres.browse':
    case 'genres.members':
    case 'genres.facets':
      return validGenreBrowsePayload(name, p)
    case 'genres.tree':
    case 'genres.unmapped':
    case 'genres.evidence':
    case 'genres.edit':
    case 'genres.map':
    case 'genres.override':
      return validGenresPayload(name, p)
    case 'ratings.detail':
    case 'ratings.targets':
    case 'ratings.history':
    case 'ratings.set':
      return validMusicRatingsPayload(name, p)
    case 'preferences.detail':
    case 'preferences.targets':
    case 'preferences.history':
    case 'preferences.set':
      return validMusicPreferencesPayload(name, p)
    case 'exploration.query':
    case 'exploration.lookup':
    case 'exploration.detail':
    case 'exploration.relations':
    case 'exploration.participation':
    case 'exploration.performance.save':
    case 'exploration.performance.delete': return validMusicExplorationPayload(name, p)
    case 'focus.query':
    case 'focus.play.status':
    case 'focus.facets':
    case 'focus.saved.list':
    case 'focus.saved.create':
    case 'focus.saved.rename':
    case 'focus.saved.update':
    case 'focus.saved.delete':
    case 'focus.play': return validMusicFocusPayload(name, p)
    case 'tags.list':
    case 'tags.entity':
    case 'tags.members':
    case 'tags.recordings':
    case 'tags.create':
    case 'tags.rename':
    case 'tags.delete':
    case 'tags.member.set':
    case 'tags.play':
      return validMusicTagsPayload(name, p)
    case 'albums.browse':
    case 'albums.sources':
      return validAlbumBrowsePayload(name, p)
    case 'catalog.playUnified':
      return validUnifiedPlaybackPayload(p)
    case 'catalog.query':
    case 'catalog.detail':
    case 'catalog.sources':
    case 'catalog.status':
    case 'catalog.refresh':
    case 'catalog.cancel':
    case 'catalog.play':
      return validCatalogPayload(name, p)
    case 'versions.catalog':
      return keys(p, ['scope', 'revision', 'contentRevision', 'playlistsRevision', 'offset', 'limit', 'search', 'key', 'trackId']) &&
        optional(p.key, (s) => text(s, 8192)) && optional(p.trackId, text) &&
        optional(p.scope, (s) => oneOf(s, ['tracks', 'albums'])) &&
        optional(p.revision, uint) && optional(p.contentRevision, uint) && optional(p.playlistsRevision, uint) &&
        optional(p.offset, uint) && optional(p.limit, (n) => uint(n) && n > 0 && n <= 200) &&
        optional(p.search, (s) => typeof s === 'string' && s.length <= 4096)
    case 'playlists.favorites':
      return keys(p, ['revision', 'items']) && uint(p.revision) && Array.isArray(p.items) &&
        p.items.length <= 200 && p.items.every(queueInput)
    case 'versions.page':
      return (
        keys(p, ['revision', 'scope', 'kind', 'offset', 'limit']) &&
        uint(p.revision) &&
        oneOf(p.scope, ['tracks', 'albums']) &&
        oneOf(p.kind, ['versions', 'families']) &&
        optional(p.offset, uint) &&
        optional(p.limit, (n) => uint(n) && n > 0 && n <= 128)
      )
    case 'versions.edit':
      return (
        keys(p, ['revision', 'scope', 'operation', 'keys', 'label']) &&
        uint(p.revision) &&
        oneOf(p.scope, ['tracks', 'albums']) &&
        oneOf(p.operation, [
          'sources',
          'family',
          'split',
          'reset',
          'label',
          'prefer-source',
          'prefer-version',
          'clear-preference'
        ]) &&
        strings(p.keys, 40000, 8192) &&
        Array.isArray(p.keys) &&
        p.keys.length > 0 &&
        typeof p.label === 'string' &&
        p.label.length <= 100
      )
    case 'playlists.list':
      return (
        keys(p, ['offset', 'limit', 'revision']) &&
        optional(p.offset, uint) &&
        optional(p.revision, uint) &&
        optional(p.limit, (n) => uint(n) && n > 0 && n <= LIBRARY_PAGE_SIZE)
      )
    case 'playlists.entries':
      return (
        keys(p, ['id', 'offset', 'limit', 'revision']) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        optional(p.offset, uint) &&
        optional(p.limit, (n) => uint(n) && n > 0 && n <= LIBRARY_PAGE_SIZE)
      )
    case 'playlists.edit':
      return keys(p, ['revision', 'edit']) && uint(p.revision) && validPlaylistEdit(p.edit)
    case 'search.collections':
      return (
        keys(p, [
          'kind',
          'query',
          'scope',
          'providerId',
          'limit',
          'offset',
          'contentRevision',
          'playlistsRevision'
        ]) &&
        oneOf(p.kind, ['albums', 'artists', 'playlists']) &&
        typeof p.query === 'string' &&
        p.query.length <= 4096 &&
        optional(p.scope, (v) => oneOf(v, ['all', 'local'])) &&
        optional(p.providerId, (v) => text(v, 128)) &&
        !(p.providerId && p.scope === 'local') &&
        optional(p.limit, (n) => uint(n) && n >= 1 && n <= 100) &&
        optional(p.offset, uint) &&
        optional(p.contentRevision, uint) &&
        optional(p.playlistsRevision, uint)
      )
    case 'search.songs':
      return (
        keys(p, [
          'query',
          'scope',
          'limit',
          'offset',
          'contentRevision',
          'versionsRevision',
          'networkRevision'
        ]) &&
        typeof p.query === 'string' &&
        p.query.length <= 4096 &&
        optional(p.scope, (v) => oneOf(v, ['all', 'local'])) &&
        optional(p.limit, (n) => uint(n) && n >= 1 && n <= 100) &&
        optional(p.offset, uint) &&
        optional(p.contentRevision, uint) &&
        optional(p.versionsRevision, uint) &&
        optional(p.networkRevision, uint)
      )
    case 'providers.call':
      return (
        keys(payload, ['providerId', 'method', 'args', 'idempotencyKey']) &&
        text(payload.providerId, 128) &&
        /^[a-z0-9][a-z0-9._:-]*$/.test(payload.providerId) &&
        typeof payload.method === 'string' &&
        isTwilightMediaProviderMethod(payload.method) &&
        !CORE_HOST_PROVIDER_METHODS.has(payload.method) &&
        Array.isArray(payload.args) &&
        payload.args.length <= 16 &&
        optional(
          payload.idempotencyKey,
          (key) => text(key, 128) && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(key)
        )
      )
    case 'plugins.index.list':
    case 'plugins.index.status':
    case 'plugins.index.refresh':
    case 'plugins.list':
    case 'providers.list':
    case 'extensions.experiences':
    case 'extensions.list':
      return keys(payload, [])
    case 'extensions.preferences':
    case 'extensions.document':
    case 'plugins.index.install':
    case 'plugins.enable':
    case 'plugins.disable':
    case 'plugins.log':
    case 'plugins.showLog':
      return keys(payload, ['id']) && pluginId(payload.id)
    case 'plugins.uninstall':
      return (
        keys(payload, ['id', 'removeData']) &&
        pluginId(payload.id) &&
        optional(payload.removeData, (v) => typeof v === 'boolean')
      )
    case 'plugins.install':
      return keys(payload, ['kind']) && oneOf(payload.kind, ['package', 'directory'])
    case 'plugins.dspParameters':
      return (
        keys(payload, ['id', 'parameters']) &&
        pluginId(payload.id) &&
        record(payload.parameters) &&
        Object.keys(payload.parameters).length <= 128 &&
        Object.entries(payload.parameters).every(
          ([key, value]) =>
            /^[a-zA-Z0-9_.:-]{1,128}$/.test(key) &&
            typeof value === 'number' &&
            Number.isFinite(value)
        )
      )
    case 'plugins.installSource':
      return keys(p, ['path']) && text(p.path, 32768)
    case 'extensions.resource':
      return keys(p, ['url']) && text(p.url, 8192) && p.url.startsWith('plugin-ui://')
    case 'extensions.stylesheet':
      return keys(p, ['pluginId', 'themeId']) && pluginId(p.pluginId) && text(p.themeId, 128)
    case 'extensions.preferences.edit':
      return keys(p, ['id', 'value']) && pluginId(p.id) && record(p.value) && isBoundedCoreJson(p.value, 64 * 1024)
    case 'extensions.document.edit':
      return keys(p, ['id', 'update']) && pluginId(p.id) && record(p.update) && keys(p.update, ['revision', 'value']) && uint(p.update.revision) && record(p.update.value) && isBoundedCoreJson(p.update.value, 16 * 1024 * 1024)
    case 'extensions.music':
      return keys(p, ['id', 'operation', 'args']) && pluginId(p.id) && oneOf(p.operation, EXPERIENCE_MUSIC_OPERATIONS) && record(p.args) && isBoundedCoreJson(p.args, 16 * 1024 * 1024)
    case 'extensions.export':
      return keys(p, ['id', 'name', 'content']) && pluginId(p.id) && typeof p.name === 'string' && /^[a-zA-Z0-9_.-]{1,100}\.(md|json|txt)$/.test(p.name) && typeof p.content === 'string' && new TextEncoder().encode(p.content).length <= 4 * 1024 * 1024
    case 'extensions.execute':
      return (
        keys(payload, ['command', 'args']) &&
        text(payload.command, 256) &&
        Array.isArray(payload.args) &&
        payload.args.length <= 16
      )
    case 'extensions.pluginRequest':
      return keys(p, ['id', 'request']) && pluginId(p.id) && isBoundedCoreJson(p.request, 256 * 1024)
    case 'state.snapshot':
    case 'imports.previewFile':
    case 'statistics.summary':
    case 'statistics.overview':
    case 'library.metadata':
    case 'migration.status':
    case 'scan.status':
    case 'scan.watchers':
    case 'metadata.start':
    case 'metadata.cancel':
    case 'metadata.status':
    case 'playback.pause':
    case 'playback.stop':
    case 'playback.next':
    case 'playback.previous':
    case 'lifecycle.flush':
    case 'queue.refresh':
      return keys(p, [])
    case 'metadata.candidates':
    case 'metadata.clear':
      return keys(p, ['id', 'version']) && text(p.id, 512) && uint(p.version)
    case 'metadata.apply':
      return keys(p, ['token', 'index']) && text(p.token, 128) && uint(p.index) && p.index < 100
    case 'statistics.tracks':
      return (
        keys(p, ['sort', 'offset', 'limit', 'revision']) &&
        optional(p.sort, (sort) => oneOf(sort, ['recent', 'plays', 'seconds'])) &&
        optional(p.offset, uint) &&
        optional(p.revision, uint) &&
        optional(p.limit, (n) => uint(n) && n >= 1 && n <= 128)
      )
    case 'statistics.clear':
    case 'statistics.previewClear':
      return (
        keys(p, ['range', 'revision']) &&
        uint(p.revision) &&
        (p.range === null ||
          (record(p.range) &&
            keys(p.range, ['startDay', 'endDay']) &&
            typeof p.range.startDay === 'string' &&
            typeof p.range.endDay === 'string' &&
            isListeningStatsClearRange(p.range as unknown as ListeningStatsClearRange)))
      )
    case 'playback.play':
      return keys(p, ['position']) && optional(p.position, positive)
    case 'playback.seek':
      return keys(p, ['position']) && positive(p.position)
    case 'playback.volume':
      return keys(p, ['volume']) && positive(p.volume) && p.volume <= 1
    case 'playback.mute':
      return keys(p, ['muted']) && optional(p.muted, (value) => typeof value === 'boolean')
    case 'playback.abLoop':
      return (
        keys(p, ['revision', 'occurrenceId', 'action', 'position']) &&
        uint(p.revision) &&
        text(p.occurrenceId, MAX_QUEUE_OCCURRENCE_ID_LENGTH) &&
        oneOf(p.action, ['a', 'b', 'toggle', 'clear']) &&
        optional(p.position, positive)
      )
    case 'playback.mode':
      return keys(p, ['mode']) && oneOf(p.mode, modes)
    case 'scan.start':
      return (
        keys(p, ['mode', 'roots', 'restoreExcluded']) &&
        oneOf(p.mode, ['startup', 'full', 'watch']) &&
        optional(p.roots, (r) => strings(r, 128) && (r as string[]).length > 0) &&
        optional(p.restoreExcluded, (v) => typeof v === 'boolean')
      )
    case 'scan.pause':
    case 'scan.resume':
    case 'scan.cancel':
      return keys(p, ['jobId']) && text(p.jobId, 128)
    case 'library.tracks':
      return query(p)
    case 'library.recent.resolve':
    case 'library.collections':
    case 'library.byIds':
    case 'library.artwork':
    case 'library.paths.lookup':
      return validCoreLibraryReadPayload(name, p, query)
    case 'playlists.catalog':
    case 'playlists.collection':
    case 'playlists.members':
    case 'playlists.membership':
    case 'playlists.state':
    case 'playlists.export':
    case 'playlists.importDocument':
    case 'playlists.flush':
      return validCorePlaylistProjectionPayload(name, p, query)
    case 'queue.fromQuery':
      return (
        keys(p, ['query', 'selectedId', 'play', 'position', 'randomStart', 'playMode']) &&
        query(p.query) &&
        optional(p.selectedId, text) &&
        optional(p.play, (b) => typeof b === 'boolean') &&
        optional(p.position, positive) &&
        optional(p.randomStart, (b) => typeof b === 'boolean') &&
        optional(p.playMode, (mode) =>
          oneOf(
            mode,
            modes.filter((m) => m !== 'heart')
          )
        )
      )
    case 'queue.submit':
      if (!isBoundedCoreJson(p, 2 * 1024 * 1024)) return false
      switch (p.kind) {
        case 'begin':
          return (
            keys(p, ['kind', 'selectedIndex', 'position', 'play']) &&
            uint(p.selectedIndex) &&
            optional(p.position, positive) &&
            optional(p.play, (v) => typeof v === 'boolean')
          )
        case 'append':
          return (
            keys(p, ['kind', 'id', 'sequence', 'items']) &&
            text(p.id, 128) &&
            uint(p.sequence) &&
            p.sequence > 0 &&
            Array.isArray(p.items) &&
            p.items.length > 0 &&
            p.items.length <= 200 &&
            p.items.every(queueInput)
          )
        case 'commit':
          return (
            keys(p, ['kind', 'id', 'sequence']) &&
            text(p.id, 128) &&
            uint(p.sequence) &&
            p.sequence > 0
          )
        case 'abort':
          return keys(p, ['kind', 'id']) && text(p.id, 128)
        default:
          return false
      }
    case 'queue.page':
      return (
        keys(p, ['id', 'revision', 'offset', 'limit', 'search']) &&
        optional(p.search, (s) => typeof s === 'string' && s.length <= 32768) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        uint(p.offset) &&
        optional(p.limit, (n) => uint(n) && n >= 1 && n <= LIBRARY_MAX_PAGE_SIZE)
      )
    case 'queue.select':
      return (
        keys(p, ['id', 'revision', 'index', 'occurrenceId']) &&
        text(p.id, 128) &&
        uint(p.revision) &&
        uint(p.index) &&
        text(p.occurrenceId, MAX_QUEUE_OCCURRENCE_ID_LENGTH)
      )
    case 'queue.undo':
      return keys(p, ['id', 'revision']) && text(p.id, 128) && uint(p.revision)
    case 'queue.edit':
      return (
        keys(p, ['id', 'revision', 'edit']) && text(p.id, 128) && uint(p.revision) && edit(p.edit)
      )
    case 'migration.abort':
    case 'migration.commit':
      return keys(p, ['id']) && text(p.id, 128)
    case 'migration.begin': {
      const m = p.manifest
      return (
        keys(p, ['id', 'manifest']) &&
        text(p.id, 128) &&
        record(m) &&
        keys(m, ['version', 'counts']) &&
        m.version === 1 &&
        record(m.counts) &&
        keys(m.counts, [...CORE_STATE_DOMAINS]) &&
        CORE_STATE_DOMAINS.every(
          (d) =>
            uint((m.counts as RecordValue)[d]) && Number((m.counts as RecordValue)[d]) <= 100_000
        )
      )
    }
    case 'migration.stage':
      return (
        keys(p, ['id', 'batch', 'domain', 'rows']) &&
        text(p.id, 128) &&
        uint(p.batch) &&
        oneOf(p.domain, CORE_STATE_DOMAINS) &&
        Array.isArray(p.rows) &&
        p.rows.length >= 1 &&
        p.rows.length <= 128 &&
        p.rows.every(
          (r) =>
            record(r) &&
            keys(r, ['key', 'value']) &&
            text(r.key) &&
            Object.hasOwn(r, 'value') &&
            r.value !== undefined
        ) &&
        new Set(p.rows.map((r) => r.key)).size === p.rows.length &&
        new TextEncoder().encode(JSON.stringify(p.rows)).length <=
          coreStateBatchByteLimit(p.domain as CoreStateDomain, p.rows.length)
      )
  }
}

function tagPatch(value: unknown): boolean {
  if (
    !record(value) ||
    !Object.keys(value).length ||
    !keys(value, [
      'title',
      'artist',
      'album',
      'albumArtist',
      'track',
      'disc',
      'year',
      'genre',
      'coverBase64'
    ])
  )
    return false
  return Object.entries(value).every(([key, value]) =>
    ['track', 'disc', 'year'].includes(key)
      ? uint(value) && value >= 1 && value <= 9999
      : key === 'coverBase64'
        ? typeof value === 'string' &&
          value.length > 0 &&
          value.length <= 11_184_812 &&
          value.length % 4 === 0 &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(value)
        : typeof value === 'string' && value.length <= 1024
  )
}

function pluginId(value: unknown): value is string {
  return text(value, 128) && /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(value)
}
function validBookmarkCurrent(v: unknown): boolean {
  return (
    record(v) &&
    keys(v, ['trackId', 'occurrenceId']) &&
    text(v.trackId) &&
    (v.occurrenceId === null || text(v.occurrenceId, MAX_QUEUE_OCCURRENCE_ID_LENGTH))
  )
}

function validPlaylistEdit(value: unknown): boolean {
  if (!record(value)) return false
  const v = value
  const id = () => text(v.id, 128)
  const ids = () => strings(v.ids, LIBRARY_PAGE_SIZE, 128)
  const tracks = () =>
    Array.isArray(v.tracks) &&
    v.tracks.length <= LIBRARY_PAGE_SIZE &&
    v.tracks.every(
      (t) =>
        record(t) &&
        text(t.id, 128) &&
        typeof t.title === 'string' &&
        typeof t.artist === 'string' &&
        typeof t.album === 'string' &&
        typeof t.filePath === 'string'
    )
  switch (v.kind) {
    case 'importCreate':
      return keys(v, ['kind', 'document']) && validImportDocument(v.document)
    case 'importRefresh':
      return (
        keys(v, ['kind', 'id', 'document', 'overwrite']) &&
        id() &&
        validImportDocument(v.document) &&
        optional(v.overwrite, (b) => typeof b === 'boolean')
      )
    case 'importBind':
      return (
        keys(v, ['kind', 'id', 'entryId', 'track']) &&
        id() &&
        text(v.entryId, 128) &&
        (v.track === null ||
          (record(v.track) &&
            text(v.track.id, 128) &&
            typeof v.track.title === 'string' &&
            typeof v.track.artist === 'string' &&
            typeof v.track.album === 'string' &&
            typeof v.track.filePath === 'string'))
      )
    case 'importRemove':
      return (
        keys(v, ['kind', 'id', 'entryIds']) && id() && strings(v.entryIds, LIBRARY_PAGE_SIZE, 128)
      )
    case 'create':
      return (
        keys(v, ['kind', 'name', 'aggregate']) &&
        text(v.name, 80) &&
        optional(v.aggregate, (b) => typeof b === 'boolean')
      )
    case 'rename':
    case 'copy':
      return keys(v, ['kind', 'id', 'name']) && id() && text(v.name, 80)
    case 'delete':
      return keys(v, ['kind', 'id']) && id()
    case 'cover':
      return (
        keys(v, ['kind', 'id', 'cover']) &&
        id() &&
        (v.cover === null || text(v.cover, 8 * 1024 * 1024))
      )
    case 'pin':
      return keys(v, ['kind', 'id', 'pinned']) && id() && typeof v.pinned === 'boolean'
    case 'hiddenSources':
      return keys(v, ['kind', 'id', 'sources']) && id() && strings(v.sources, 128, 128)
    case 'variant':
      return (
        keys(v, ['kind', 'id', 'anchorId', 'source']) &&
        id() &&
        text(v.anchorId, 128) &&
        (v.source === null || text(v.source, 128))
      )
    case 'add':
      return keys(v, ['kind', 'id', 'tracks']) && id() && tracks()
    case 'remove':
      return keys(v, ['kind', 'id', 'ids']) && id() && ids()
    case 'reorder':
      return keys(v, ['kind', 'id', 'ids', 'target']) && id() && ids() && uint(v.target)
    case 'move':
      return keys(v, ['kind', 'id', 'ids', 'targetId']) && id() && ids() && text(v.targetId, 128)
    case 'favorite':
      return keys(v, ['kind', 'tracks', 'favorite']) && tracks() && typeof v.favorite === 'boolean'
    default:
      return false
  }
}

function validImportDocument(value: unknown): boolean {
  if (
    !record(value) ||
    !text(value.name, 80) ||
    !Array.isArray(value.songs) ||
    value.songs.length > EXTERNAL_PLAYLIST_MAX_ENTRIES ||
    !record(value.source) ||
    !oneOf(value.source.kind, ['file', 'platform']) ||
    typeof value.source.label !== 'string' ||
    typeof value.complete !== 'boolean'
  )
    return false
  return value.songs.every(
    (song) =>
      record(song) &&
      ['title', 'artist', 'album', 'isrc', 'platformId', 'unavailableReason'].every((k) =>
        optional(song[k], (s) => typeof s === 'string' && s.length <= 32768)
      ) &&
      optional(song.duration, positive) &&
      optional(song.locations, (s) => strings(s, 200))
  )
}

function networkProfile(value: unknown, patch: boolean): boolean {
  if (
    !record(value) ||
    !keys(value, [
      'protocol',
      'name',
      'host',
      'port',
      'rootPath',
      'webdavScheme',
      'username',
      'keyPath',
      'auth',
      'readOnly',
      'bookmarks'
    ]) ||
    !isBoundedCoreJson(value, 16 * 1024)
  )
    return false
  const check = (key: string, valid: (v: unknown) => boolean) =>
    (patch && value[key] === undefined) || valid(value[key])
  if (
    !check('protocol', (v) =>
      oneOf(v, ['webdav', 'ftp', 'ftps', 'sftp', 'scp', 'smb', 'nfs', 'dlna'])
    ) ||
    !check('name', (v) => text(v, 64)) ||
    !check('host', (v) => text(v, 260)) ||
    !check('rootPath', (v) => text(v, 4096))
  )
    return false
  if (
    !optional(value.port, (v) => v === null || (uint(v) && Number(v) > 0 && Number(v) <= 65535)) ||
    !optional(value.webdavScheme, (v) => oneOf(v, ['http', 'https'])) ||
    !optional(value.username, (v) => typeof v === 'string' && v.length <= 128) ||
    !optional(value.keyPath, (v) => text(v, 512)) ||
    !optional(value.readOnly, (v) => typeof v === 'boolean') ||
    !optional(value.bookmarks, (v) => strings(v, 50, 4096))
  )
    return false
  const auth = value.auth
  if (patch && auth === undefined) return true
  if (!record(auth)) return false
  return auth.kind === 'anonymous'
    ? keys(auth, ['kind'])
    : auth.kind === 'password'
      ? keys(auth, ['kind', 'password']) &&
        typeof auth.password === 'string' &&
        auth.password.length <= 512
      : auth.kind === 'privateKey' &&
        keys(auth, ['kind', 'keyPath', 'passphrase']) &&
        text(auth.keyPath, 512) &&
        optional(auth.passphrase, (v) => typeof v === 'string' && v.length <= 512)
}
