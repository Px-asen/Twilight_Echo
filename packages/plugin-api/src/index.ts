export const TWILIGHT_PLUGIN_API_VERSION = 4 as const
export const TAE_DSP_PLUGIN_ABI_VERSION = 1 as const
export const TAE_DSP_PLUGIN_ABI_VERSION_V2 = 2 as const

export type NativeDspChannelLayout = 'mono' | 'stereo' | '5.1' | '7.1'

export type TwilightPluginType = 'provider' | 'tool' | 'ui' | 'theme' | 'dsp'

export type TwilightPluginPermission =
  | 'network'
  | 'filesystem:read'
  | 'filesystem:write'
  | 'player:control'
  | 'player:observe'
  | 'library:read'
  | 'library:write'
  | 'settings'
  | 'clipboard'
  | 'ui:inject'
  | 'app:settings'
  | 'plugins:manage'
  | 'dsp:native'

export interface TwilightAndroidPluginRuntime {
  apiVersion: 1
  entry: string
  permissions: ('network' | 'settings')[]
  networkHosts: string[]
}

export interface TwilightPluginManifest {
  id: string
  name: string
  version: string
  description: string
  author: string
  license: string
  type: TwilightPluginType[]
  main?: string
  binary?: Record<string, string>
  dependencies?: Record<string, string>
  engines: {
    twilightEcho: string
  }
  apiVersion: number
  permissions: TwilightPluginPermission[]
  contributes?: unknown
  homepage?: string
  repository?: string
  icon?: string
  signature?: unknown
  /** Optional serial Android provider entry. Desktop continues to use main/binary. */
  androidRuntime?: TwilightAndroidPluginRuntime
}

/** API v4: isolated, packaged page, panel or sidebar interface. No preload or Node access. */
export interface PluginExperience {
  id: string
  name: string
  /** HTML file relative to the installed version root, e.g. dist/index.html. */
  entry: string
  bridgeVersion: 1 | 2
  /**
   * `page` (default) lists the experience in sidebar navigation; `panel` keeps
   * it out of navigation so the plugin's `titleBarButton` opens it in the
   * host-owned right-side flyout instead. `sidebar` embeds a widget below
   * navigation and above the import/edit tools, without adding a page.
   */
  launch?: 'page' | 'panel' | 'sidebar'
  /** Only for launch: sidebar. Iframe height in CSS px, default 144 (integer, 64–480). */
  sidebar?: { height?: number }
}

export interface PluginExperienceContribution {
  experiences: PluginExperience[]
}

export interface PluginExperienceRequest {
  id: number
  method: string
  args?: Record<string, unknown>
}

/** Host appearance supplied to embedded (sidebar/flyout) experiences on connect and changes. */
export interface PluginExperienceAppearance {
  theme: 'dark' | 'pureWhite'
  colors: { text: string; muted: string; accent: string; surface: string; border: string }
  fontFamily: string
  fontSize: string
  reducedMotion: boolean
}

export type PluginExperienceMessage =
  | { id: number; value: unknown }
  | { id: number; error: string }
  | { event: 'player' | 'queue' | 'lyrics' | 'library'; value: unknown }
  | { event: 'appearance'; value: PluginExperienceAppearance }
  /** Live event pushed by this plugin's own background code (requires the `network` permission). */
  | { event: 'plugin'; value: { event: string; value: unknown } }

export type TwilightPluginStatus = 'installed' | 'enabled' | 'disabled' | 'invalid' | 'failed'
export type TwilightPluginSource = 'directory' | 'tep' | 'bundled' | 'index'

export interface TwilightPluginDescriptor extends TwilightPluginManifest {
  status: TwilightPluginStatus
  enabled: boolean
  builtIn: boolean
  error: string | null
  isDsp: boolean
  source: TwilightPluginSource | 'scan'
  installedAt: string | null
  updatedAt: string | null
  paths: {
    root: string
    versionRoot: string
    manifestPath: string
    dataDir: string
    logPath: string
  }
}

export interface TwilightPluginInstallResult {
  plugin: TwilightPluginDescriptor
  warning: string
}

export interface TwilightPluginPublisherSignature {
  schemaVersion: 1
  algorithm: 'ed25519'
  keyId: string
  value: string
}

export type TwilightPluginSignatureStatus =
  | 'missing'
  | 'malformed'
  | 'unsupported'
  | 'unknown-key'
  | 'revoked-key'
  | 'key-not-yet-valid'
  | 'key-expired'
  | 'invalid-key'
  | 'invalid'
  | 'valid'
  | 'trust-store-error'

export type TwilightPluginVerificationLevel =
  | 'official'
  | 'publisher-signed'
  | 'index-declared'
  | 'unverified'

export interface TwilightPluginVerification {
  level: TwilightPluginVerificationLevel
  official: boolean
  officialSource: boolean
  indexClaimed: boolean
  signatureStatus: TwilightPluginSignatureStatus
  keyId: string | null
  publisher: string | null
  keyFingerprintSha256: string | null
  revalidateAt: string | null
  reason: string
}

export interface TwilightPluginIndexEntry extends TwilightPluginManifest {
  sourceUrl: string
  checksumSha256: string
  repository?: string
  homepage?: string
  tags?: string[]
  publisherSignature?: TwilightPluginPublisherSignature
  /** Publisher/index metadata only. Never use this field as an official trust decision. */
  verified?: boolean
  verification: TwilightPluginVerification
  installState?: TwilightPluginIndexInstallState
  installedVersion?: string
}

export type TwilightPluginIndexInstallState =
  | 'not-installed'
  | 'installed'
  | 'update-available'
  | 'incompatible'
  | 'built-in-blocked'

export type TwilightPluginIndexSourceKind = 'github' | 'custom' | 'bundled'
export type TwilightPluginIndexLoadedFrom = 'remote' | 'cache' | 'bundled'
export type TwilightPluginIndexCacheFormat = 'envelope-v1' | 'legacy'

export interface TwilightPluginIndexStatus {
  sourceUrl: string
  configuredSourceUrl: string
  sourceKind: TwilightPluginIndexSourceKind
  loadedFrom: TwilightPluginIndexLoadedFrom
  lastFetchedAt: string | null
  expiresAt: string | null
  loadedAt: string
  stale: boolean
  expired: boolean
  originVerified: boolean
  officialSource: boolean
  cacheFormat: TwilightPluginIndexCacheFormat | null
  trustStoreError: string | null
  error: string | null
}

export interface PluginPrivateSettings {
  get(key?: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export interface PluginLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface TwilightPluginContext {
  apiVersion: number
  storagePath: string
  settings: PluginPrivateSettings
  logger: PluginLogger
  twilight: TwilightApi
}

export type TwilightEventName =
  | 'app:ready'
  | 'app:before-quit'
  | 'player:track-change'
  | 'player:play'
  | 'player:pause'
  | 'player:stop'
  | 'player:progress'
  | 'player:queue-change'
  | 'player:playback-info'
  | `audioEngine:${string}`

export interface TwilightEventsApi {
  on(eventName: TwilightEventName | string, callback: (payload: unknown) => void): () => void
}

export interface TwilightPlayerApi {
  getPlaybackInfo(): Promise<unknown>
  play(): Promise<void>
  pause(): Promise<void>
  togglePause(): Promise<void>
  stop(): Promise<void>
  next(): Promise<void>
  previous(): Promise<void>
  /** Replace the queue with local-library track ids and start at `startIndex` (requires `player:control`). */
  playTracks(ids: string[], startIndex?: number): Promise<void>
  setVolume(volume: number): Promise<void>
  seek(position: number): Promise<void>
  setPlayMode(mode: 'sequential' | 'listLoop' | 'repeat' | 'shuffle'): Promise<void>
}

export type TwilightMediaProviderCapability =
  | 'search'
  | 'playbackUrl'
  | 'lyrics'
  | 'cover'
  | 'playlist'
  | 'library'
  | 'login'
  | 'download'

/**
 * A single artist's provider-side identity. Same-named artists are
 * indistinguishable from the `artist` display string, so providers should
 * return this whenever the upstream payload carries stable artist ids.
 * Entry order must match the ' / ' segments of `artist`, and entries with an
 * unknown `id` must still be kept so positions stay aligned.
 */
export interface TrackArtistRef {
  id?: string | number
  name: string
}

export interface Track {
  id: string
  title: string
  /** Optional grouping metadata; each part retains its own playable id and duration. */
  mediaPart?: {
    groupId: string
    groupTitle: string
    title: string
    index: number
    count: number
  }
  artist: string
  /** Structured artist identities behind the `artist` display string. */
  artists?: TrackArtistRef[]
  album: string
  filePath: string
  fileName: string
  duration: number
  size: number
  cover: string | null
  lyrics: string | null
  translatedLyrics?: string | null
  source?: string
  streamUrl?: string | null
  bpm?: number
}

/** nextOffset is a provider cursor; it need not equal the number of returned tracks. */
export interface PlaylistTracksPage {
  tracks: Track[]
  /** Exact playable track count when known, otherwise null (e.g. multi-part videos). */
  total: number | null
  nextOffset: number
  hasMore: boolean
}

export interface PlaylistSummary {
  id: string | number
  name: string
  cover?: string | null
  trackCount?: number
  creatorName?: string
  /** True when the signed-in user owns (created) the playlist. */
  owned?: boolean
}

export interface AlbumSummary {
  id: string | number
  name: string
  artist?: string
  cover?: string | null
  trackCount?: number
  publishTime?: number
  /** Provider-reported release kind; do not infer LP/EP from the track count. */
  releaseType?: string
  /** Provider-reported explicit-content flag; omitted when unavailable. */
  isExplicit?: boolean
}

/** Optional, bounded identity evidence; independent of playback Track[] and text metadata.
 * Keep in sync with src/shared/musicPlatformAlbum.ts. No paths, URLs or credentials. */
/** Field permissions are capped by the host deployment's reviewed policy. */
export interface MetadataUsage {
  display: boolean
  cache: boolean
  crossSource: boolean
  export: boolean
  expiresAt?: number
}
export interface PlatformEntityMetadata {
  schemaVersion: 1
  provider: string
  kind: 'artist' | 'release'
  id: string
  name: string
  texts: Array<{
    field: 'description' | 'introduction'
    value: string
    language: string
    url: string
    revision: string
    attribution: string
    license: string
    licenseUrl: string
    usage?: MetadataUsage
  }>
  /** This platform release's calendar date, not the album work's first release. */
  releaseDate?: {
    value: string
    url: string
    revision: string
    attribution: string
    license: string
    licenseUrl: string
    usage?: MetadataUsage
  }
  /** Private resource URLs; Core projects approved images to session handles. */
  artwork?: Array<{
    resource: string
    url: string
    revision: string
    attribution: string
    license: string
    licenseUrl: string
    usage?: MetadataUsage
  }>
}
export type PlatformMetadataResult =
  | { status: 'ok'; metadata: PlatformEntityMetadata }
  | { status: 'not_found' | 'not_provided' | 'unsupported' }

export interface PlatformAlbumIdentity {
  schemaVersion: 1
  provider: string
  id: string
  title: string
  artists: Array<{ name: string; id?: string }>
  /** Independent service-reported total, null when unknown. Never tracks.length. */
  trackCount: number | null
  /** Entire track set retrieved; does not imply all comparison fields are known. */
  complete: boolean
  tracks: Array<{
    id: string
    title: string
    artists: Array<{ name: string; id?: string }>
    /** Original precision in seconds, null when unavailable. */
    durationSeconds: number | null
    /** Actual ordinals; never inferred from array order or defaulted to 1. */
    disc: number | null
    position: number | null
    isrcs: string[]
  }>
}

export interface PlatformRecordingIdentity {
  id: string
  title: string
  artists: Array<{ id: string | null; name: string; aliases?: string[] }>
  durationSeconds: number | null
  album: { id: string; title: string } | null
}
export interface PlatformRecordingPage { items: PlatformRecordingIdentity[]; total: number | null }
export interface PlatformArtistIdentity { id: string; name: string; aliases: string[] }

/** Public music charts, including the provider's compact song previews. */
export interface ToplistSummary extends PlaylistSummary {
  description?: string
  updateFrequency?: string
  updatedAt?: number
  featured?: boolean
  previewTracks: Array<{ title: string; artist: string }>
}

export interface ArtistSummary {
  id: string | number
  name: string
  cover?: string | null
}

export interface UserSummary {
  id: string | number
  name: string
  avatar?: string | null
  artistId?: string | number
  followed?: boolean
}

export interface NcmCloudSong {
  cloudSongId: string | number
  songId: string | number
  fileName: string
  addTime?: number
  track: Track
}

export interface NcmCloudSongsPage {
  items: NcmCloudSong[]
  total: number
  offset: number
  limit: number
  nextOffset: number
  hasMore: boolean
}

export interface NcmCloudUploadPreparation {
  needUpload: boolean
  songId: string | number
  uploadToken: string
  uploadUrl: string
  resourceId: string
  md5: string
  fileSize: number
  filename: string
}

export interface NcmCloudUploadCompletion {
  songId: string | number
  resourceId: string
  md5: string
  filename: string
  song?: string
  artist?: string
  album?: string
  bitrate?: number
}

export interface ProviderProfile {
  userId?: string | number
  nickname?: string
  avatarUrl?: string | null
  [key: string]: unknown
}

export type ProviderDownloadQuality = 'aac' | 'lossless' | 'hi-res'
export type ProviderDownloadStatus =
  | 'queued'
  | 'preparing'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'expired'

export interface ProviderDownloadRequest {
  track: Track
  quality: ProviderDownloadQuality
}

export interface ProviderDownloadTask {
  jobId: string
  status: ProviderDownloadStatus
  progress: number
  queuePosition?: number | null
  requestedQuality: ProviderDownloadQuality
  actualQuality?: ProviderDownloadQuality | null
  fileName?: string | null
  fileSize?: number | null
  contentType?: string | null
  expiresAt?: string | null
  error?: string | null
}

export interface ProviderDownloadFile {
  url: string
  fileName?: string | null
  fileSize?: number | null
  contentType?: string | null
  actualQuality?: ProviderDownloadQuality | null
}

export interface QrLoginRequest {
  key: string
  qrContent?: string
  imageDataUrl?: string
  expiresInSeconds?: number
}

/**
 * Appended to provider handler arguments by the host. Existing v1 handlers
 * can ignore it; new handlers should stop in-flight work when signal aborts.
 */
export interface TwilightProviderRequestContext {
  signal: AbortSignal
  /** Present for like/follow writes when a caller supplies or reuses a key. */
  idempotencyKey?: string
}

/** Context appended to a registered UI command handler. */
export interface TwilightUiCommandContext {
  signal: AbortSignal
}

export interface TwilightMediaProviderRegistration {
  id: string
  name: string
  capabilities: TwilightMediaProviderCapability[]
  health?: TwilightMediaProviderHealth
  getPlaybackUrl?(
    track: Track,
    options?: PlaybackUrlOptions,
    context?: TwilightProviderRequestContext
  ): Promise<string | null>
  getLyrics?(
    track: Track,
    context?: TwilightProviderRequestContext
  ): Promise<{ lyrics: string | null; translatedLyrics: string | null; wordLyrics?: string | null }>
  searchSongs?(
    keywords: string,
    limit?: number,
    offset?: number,
    context?: TwilightProviderRequestContext
  ): Promise<{ items: Track[]; total: number }>
  searchAlbums?(
    keywords: string,
    limit?: number,
    offset?: number,
    context?: TwilightProviderRequestContext
  ): Promise<{ items: AlbumSummary[]; total: number; incomplete?: boolean }>
  searchPlaylists?(
    keywords: string,
    limit?: number,
    offset?: number,
    context?: TwilightProviderRequestContext
  ): Promise<{ items: PlaylistSummary[]; total: number }>
  searchArtists?(
    keywords: string,
    limit?: number,
    offset?: number,
    context?: TwilightProviderRequestContext
  ): Promise<{ items: ArtistSummary[]; total: number }>
  fetchPlaylistTracks?(
    playlistId: string | number,
    force?: boolean,
    context?: TwilightProviderRequestContext
  ): Promise<Track[]>
  /** Complete occurrence metadata, including unavailable items. Never dedupe
   * or truncate; reject an interrupted page. No playback URLs in this result. */
  readPlaylistImportPage?(
    playlistId: string,
    offset: number,
    limit: number,
    context?: TwilightProviderRequestContext
  ): Promise<{ name?: string; songs: Array<{ title?: string; artist?: string; album?: string; duration?: number; isrc?: string; platformId?: string; cover?: string | null; coverSource?: string | null; coverSmall?: string | null; coverSmallSource?: string | null; unavailableReason?: string }>; total: number; nextOffset: number; hasMore: boolean }>
  fetchPlaylistTracksPage?(
    playlistId: string | number,
    offset?: number,
    limit?: number,
    force?: boolean,
    context?: TwilightProviderRequestContext
  ): Promise<PlaylistTracksPage>
  createDownload?(
    request: ProviderDownloadRequest,
    context?: TwilightProviderRequestContext
  ): Promise<ProviderDownloadTask>
  getDownloadStatus?(
    jobId: string,
    context?: TwilightProviderRequestContext
  ): Promise<ProviderDownloadTask>
  getDownloadFile?(
    jobId: string,
    context?: TwilightProviderRequestContext
  ): Promise<ProviderDownloadFile>
  cancelDownload?(jobId: string, context?: TwilightProviderRequestContext): Promise<void>
  checkLogin?(
    context?: TwilightProviderRequestContext
  ): Promise<{ loggedIn: boolean; profile: ProviderProfile | null }>
  getProfile?(context?: TwilightProviderRequestContext): Promise<ProviderProfile | null>
  logout?(context?: TwilightProviderRequestContext): Promise<void>
  openOfficialLogin?(
    context?: TwilightProviderRequestContext
  ): Promise<{ loggedIn: boolean; profile: ProviderProfile | null }>
  sendCaptcha?(
    phone: string,
    countrycode?: string,
    context?: TwilightProviderRequestContext
  ): Promise<{ code: number; message: string }>
  loginByPhonePassword?(
    phone: string,
    password: string,
    countrycode?: string,
    context?: TwilightProviderRequestContext
  ): Promise<{ loggedIn: boolean; profile: ProviderProfile | null }>
  loginByPhoneCaptcha?(
    phone: string,
    captcha: string,
    countrycode?: string,
    context?: TwilightProviderRequestContext
  ): Promise<{ loggedIn: boolean; profile: ProviderProfile | null }>
  loginByEmailPassword?(
    email: string,
    password: string,
    context?: TwilightProviderRequestContext
  ): Promise<{ loggedIn: boolean; profile: ProviderProfile | null }>
  loginWithServer?(
    serverUrl: string,
    username: string,
    password: string,
    context?: TwilightProviderRequestContext
  ): Promise<{ loggedIn: boolean; profile: ProviderProfile | null }>
  getQrLogin?(context?: TwilightProviderRequestContext): Promise<QrLoginRequest | null>
  getQrKey?(context?: TwilightProviderRequestContext): Promise<string | null>
  getQrImage?(key: string, context?: TwilightProviderRequestContext): Promise<string | null>
  checkQrLogin?(key: string, context?: TwilightProviderRequestContext): Promise<{ code: number }>
  fetchUserLibrary?(
    force?: boolean,
    context?: TwilightProviderRequestContext
  ): Promise<{
    likedPlaylist: PlaylistSummary | null
    playlists: PlaylistSummary[]
  }>
  fetchLikedTracks?(force?: boolean, context?: TwilightProviderRequestContext): Promise<Track[]>
  fetchLikedTracksPage?(
    offset?: number,
    limit?: number,
    force?: boolean,
    context?: TwilightProviderRequestContext
  ): Promise<{
    tracks: Track[]
    total: number
    offset: number
    limit: number
    nextOffset: number
    hasMore: boolean
  }>
  fetchCloudSongsPage?(
    offset?: number,
    limit?: number,
    context?: TwilightProviderRequestContext
  ): Promise<NcmCloudSongsPage>
  prepareCloudUpload?(
    input: { md5: string; fileSize: number; filename: string; bitrate?: number },
    context?: TwilightProviderRequestContext
  ): Promise<NcmCloudUploadPreparation>
  completeCloudUpload?(
    input: NcmCloudUploadCompletion,
    context?: TwilightProviderRequestContext
  ): Promise<{ songId: string | number }>
  getCloudDownloadUrl?(
    cloudSongId: string | number,
    context?: TwilightProviderRequestContext
  ): Promise<string>
  fetchRecommendSongs?(context?: TwilightProviderRequestContext): Promise<Track[]>
  fetchRecommendPlaylists?(context?: TwilightProviderRequestContext): Promise<PlaylistSummary[]>
  fetchToplists?(
    force?: boolean,
    context?: TwilightProviderRequestContext
  ): Promise<ToplistSummary[]>
  fetchPlaylistCategories?(context?: TwilightProviderRequestContext): Promise<{
    hotTags: string[]
    groups: Array<{ id: number; name: string; tags: Array<{ name: string; hot: boolean }> }>
  }>
  fetchDiscoveryPlaylists?(
    cat?: string,
    order?: 'hot' | 'new',
    limit?: number,
    offset?: number,
    context?: TwilightProviderRequestContext
  ): Promise<{
    items: PlaylistSummary[]
    total: number
    hasMore: boolean
    offset: number
    limit: number
  }>
  fetchHighQualityPlaylists?(
    cat?: string,
    limit?: number,
    before?: number,
    context?: TwilightProviderRequestContext
  ): Promise<{ items: PlaylistSummary[]; total: number; hasMore: boolean; lasttime: number }>
  fetchPersonalFm?(context?: TwilightProviderRequestContext): Promise<Track[]>
  fetchPrivateContent?(context?: TwilightProviderRequestContext): Promise<Track[]>
  fetchArtistTopSongs?(
    artistId: string | number,
    context?: TwilightProviderRequestContext
  ): Promise<Track[]>
  fetchSavedAlbums?(context?: TwilightProviderRequestContext): Promise<AlbumSummary[]>
  fetchSavedArtists?(context?: TwilightProviderRequestContext): Promise<ArtistSummary[]>
  fetchArtistAlbums?(
    artistId: string | number,
    context?: TwilightProviderRequestContext
  ): Promise<AlbumSummary[]>
  fetchArtistIntro?(
    artistId: string | number,
    context?: TwilightProviderRequestContext
  ): Promise<string>
  /** Optional native-ID text details; up to 8 texts of 20,000 characters.
   * Use und for unspecified language. Source links contain no credentials.
   * Omitted usage needs host deployment approval, not an inferred license. */
  fetchArtistMetadata?(
    artistId: string | number,
    context?: TwilightProviderRequestContext
  ): Promise<PlatformMetadataResult>
  fetchAlbumMetadata?(
    albumId: string | number,
    context?: TwilightProviderRequestContext
  ): Promise<PlatformMetadataResult>
  fetchArtistFollowState?(
    artistId: string | number,
    context?: TwilightProviderRequestContext
  ): Promise<boolean | null>
  fetchAlbumTracks?(
    albumId: string | number,
    context?: TwilightProviderRequestContext
  ): Promise<Track[]>
  /** Optional identity capability (max 64 tracks/credits). Larger or partial sets
   * must set complete=false. Missing names/credits stay empty; ordinals stay null. */
  searchRecordingIdentities?(
    query: string,
    limit: number,
    offset: number,
    context?: TwilightProviderRequestContext
  ): Promise<PlatformRecordingPage>
  /** Names and aliases must belong to this exact provider artist ID. */
  fetchArtistIdentity?(
    artistId: string | number,
    context?: TwilightProviderRequestContext
  ): Promise<PlatformArtistIdentity>
  fetchAlbumIdentity?(
    albumId: string | number,
    context?: TwilightProviderRequestContext
  ): Promise<PlatformAlbumIdentity>
  fetchArtistPlaylists?(
    artistId: string | number,
    context?: TwilightProviderRequestContext
  ): Promise<PlaylistSummary[]>
  fetchUserPlaylistsByUid?(
    uid: string | number,
    createdOnly?: boolean,
    context?: TwilightProviderRequestContext
  ): Promise<PlaylistSummary[]>
  fetchUserFollows?(
    uid: string | number,
    limit?: number,
    offset?: number,
    context?: TwilightProviderRequestContext
  ): Promise<UserSummary[]>
  fetchUserFolloweds?(
    uid: string | number,
    limit?: number,
    offset?: number,
    context?: TwilightProviderRequestContext
  ): Promise<UserSummary[]>
  fetchPlayRecords?(type?: number, context?: TwilightProviderRequestContext): Promise<Track[]>
  fetchRecentSongs?(limit?: number, context?: TwilightProviderRequestContext): Promise<Track[]>
  fetchIntelligenceList?(
    options: {
      songId: string | number
      playlistId: string | number
      startSongId?: string | number
      count?: number
    },
    context?: TwilightProviderRequestContext
  ): Promise<Track[]>
  followArtist?(
    artistId: string | number,
    follow: boolean,
    context?: TwilightProviderRequestContext
  ): Promise<void>
  followUser?(
    userId: string | number,
    follow: boolean,
    context?: TwilightProviderRequestContext
  ): Promise<void>
  likeTrack?(
    trackId: string | number,
    like: boolean,
    context?: TwilightProviderRequestContext
  ): Promise<void>
  isTrackLiked?(
    trackId: string | number | undefined,
    context?: TwilightProviderRequestContext
  ): Promise<boolean> | boolean
  createPlaylist?(
    name: string,
    options?: { privacy?: 0 | 10 },
    context?: TwilightProviderRequestContext
  ): Promise<PlaylistSummary>
  deletePlaylist?(
    playlistId: string | number,
    context?: TwilightProviderRequestContext
  ): Promise<void>
  addTracksToPlaylist?(
    playlistId: string | number,
    trackIds: Array<string | number>,
    context?: TwilightProviderRequestContext
  ): Promise<void>
  removeTracksFromPlaylist?(
    playlistId: string | number,
    trackIds: Array<string | number>,
    context?: TwilightProviderRequestContext
  ): Promise<void>
}

/**
 * Optional playback URL resolution hints. Providers that do not support a hint must ignore it.
 */
export interface PlaybackUrlOptions {
  force?: boolean
  quality?: string
}

export type TwilightMediaProviderMethod = Exclude<
  keyof TwilightMediaProviderRegistration,
  'id' | 'name' | 'capabilities' | 'health'
>

export interface TwilightMediaProviderHealth {
  providerId: string
  pluginId: string
  pluginStatus: TwilightPluginStatus
  available: boolean
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  successRate: number
  methodStats: Partial<Record<TwilightMediaProviderMethod, TwilightMediaProviderMethodHealth>>
  lastError: string | null
  lastCheckedAt: string | null
}

export interface TwilightMediaProviderMethodHealth {
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  successRate: number
  lastError: string | null
  lastCheckedAt: string | null
}

export interface TwilightProvidersApi {
  register(provider: TwilightMediaProviderRegistration): Promise<void>
}

export type TwilightUiContributionKind =
  | 'sidebarPage'
  | 'playerBarButton'
  | 'settingsPanel'
  | 'localSidebarItem'
  | 'streamingHome'
  /** Titlebar icon button (left of appearance); opens the plugin's panel experience in a host flyout. */
  | 'titleBarButton'

export interface TwilightUiContribution {
  id: string
  kind: TwilightUiContributionKind
  title: string
  description?: string
  icon?: string
  command?: string
  /** @deprecated The host renders command results as text/data and never executes HTML. */
  renderMode?: 'command' | 'html'
  autoLoad?: boolean
}

export interface TwilightPluginExtensionContribution {
  pluginId: string
  ui: TwilightUiContribution[]
  themes: TwilightThemeContribution[]
}

export type TwilightUiNoticeKind = 'info' | 'success' | 'warning' | 'error'

/** A transient host notice (toast) requested by a plugin. */
export interface TwilightUiNotice {
  /** Defaults to `info` when omitted or unrecognized. */
  kind?: TwilightUiNoticeKind
  /** Plain text shown to the user; the host truncates overly long messages. */
  message: string
  /** Suggested auto-dismiss delay in ms; the host clamps it to 2500–30000. */
  durationMs?: number
}

export interface TwilightUiApi {
  register(contribution: TwilightUiContribution): Promise<void>
  onCommand(
    command: string,
    handler: (...args: [...unknown[], TwilightUiCommandContext]) => unknown | Promise<unknown>
  ): void
  /**
   * Ask the host to show a transient notice (toast). Requires the `ui:inject`
   * permission. Hosts predating this method omit it, so detect support with
   * `typeof twilight.ui.notify === 'function'` before calling.
   */
  notify(notice: TwilightUiNotice): Promise<void>
}

export interface TwilightThemeContribution {
  id: string
  name: string
  description?: string
  variables?: Record<string, string>
  stylesheet?: string
  editor?: TwilightThemeEditorDescriptor
  structured?: TwilightStructuredTheme
  compatibilityNotes?: string[]
}

export interface TwilightThemeEditorDescriptor {
  schemaVersion: 1
  controls: Array<{
    id: string
    label: string
    group: string
    type: 'color' | 'number' | 'select' | 'boolean' | 'image' | 'text'
    variable?: string
    token?: string
    slot?: string
    selector?: string
    targets?: { local: string; streaming: string }
    defaults: Record<'pureWhite' | 'dark', string>
    min?: number
    max?: number
    step?: number
    unit?: string
    options?: string[]
    checkedValue?: string
    uncheckedValue?: string
    description?: string
  }>
}

export type TwilightThemeTone = 'pureWhite' | 'dark'
export type TwilightThemeVisibilitySlot =
  | 'playerAlbumArtist'
  | 'playerArtwork'
  | 'playerTrackMenu'
  | 'playerMiscIcons'
  | 'playerDuration'
  | 'playerWaveform'
  | 'playerTrackInfo'
  | 'equalizerGrid'
  | 'equalizerFrequencyGuides'
  | 'equalizerSpectrum'
  | 'previousButton'
  | 'nextButton'
  | 'miniPlayerArtwork'

export interface TwilightThemeModesV2 {
  appearance?: {
    accentSource?: 'fixed' | 'cover'
    backgroundTreatment?: 'solid' | 'gradient' | 'cover-blur' | 'image'
    toneScheduling?: 'manual' | 'system' | 'timed'
    contrastGuard?: 'off' | 'warn' | 'enforce'
  }
  navigation?: {
    style?: 'expanded' | 'compact' | 'rail'
    iconScale?: 'sm' | 'md' | 'lg'
    logo?: 'show' | 'hide'
  }
  library?: {
    density?: 'comfortable' | 'compact'
    selection?: 'fill' | 'stroke'
    titleOverlay?: 'off' | 'on'
  }
  player?: {
    layout?: 'standard' | 'full-cover' | 'lyrics-focus' | 'split' | 'minimal'
    backdrop?: 'follow' | 'cover-blur' | 'fluid' | 'solid' | 'image'
    controls?: 'standard' | 'pro'
    titleAlign?: 'left' | 'center'
    lyricsAlign?: 'follow' | 'left' | 'center' | 'right'
    lyricHighlight?: 'minimal' | 'surface' | 'glow'
    timeStyle?: 'pill' | 'minimal' | 'glass'
    stageAlign?: 'center' | 'top' | 'bottom'
    progress?: 'line' | 'ring' | 'solid' | 'spectrum'
  }
  artwork?: {
    frame?: 'borderless' | 'subtle-ring' | 'glass-frame' | 'vinyl' | 'polaroid'
    spin?: 'off' | 'on'
    transition?: 'fade' | 'slide' | 'none'
    shadow?: 'on' | 'off'
  }
  equalizer?: {
    panel?: 'neutral' | 'tinted' | 'glass'
    slider?: 'ring' | 'solid'
    knob?: 'line' | 'dot'
    spectrum?: 'bars' | 'line' | 'area'
    button?: 'soft' | 'outline' | 'solid'
  }
  icons?: { family?: 'outline' | 'rounded' | 'filled' }
  typography?: {
    titleCase?: 'preserve' | 'uppercase'
    lyricAccent?: 'off' | 'accent'
    titleColor?: 'off' | 'track' | 'artist-album'
  }
  visibility?: Partial<Record<TwilightThemeVisibilitySlot, boolean>>
}

export interface TwilightStructuredThemeV1 {
  schemaVersion: 1
  variants: Partial<Record<TwilightThemeTone, { tokens?: Record<string, string> }>>
  windowDefaults?: {
    miniPlayer?: {
      surfaceColor?: string
      accentColor?: string
      primaryTextColor?: string
      mutedTextColor?: string
      fontFamily?: string
      surfaceOpacity?: number
      glassBlur?: number
      cornerRadius?: number
      borderWidth?: number
      borderColor?: string
      shadowStrength?: number
      shadowColor?: string
    }
    desktopLyrics?: {
      fontFamily?: string
      fontSize?: number
      fontWeight?: number
      color?: string
      highlightColor?: string
      backgroundColor?: string
      backgroundOpacity?: number
      shadow?: boolean
      shadowBlur?: number
      shadowColor?: string
    }
  }
}

export interface TwilightStructuredThemeV2 extends Omit<
  TwilightStructuredThemeV1,
  'schemaVersion'
> {
  schemaVersion: 2
  modes?: TwilightThemeModesV2
}

export type TwilightThemeShellSlot = 'titleBar' | 'navigation' | 'content' | 'playerBar'
export type TwilightThemeShellTrack =
  | 'auto'
  | 'content'
  | 'narrow'
  | 'standard'
  | 'wide'
  | 'fill'
  | 'double'
export type TwilightThemeShellNavigation = 'toggle' | 'persistent' | 'hidden'

export interface TwilightThemeShellGrid {
  columns: TwilightThemeShellTrack[]
  rows: TwilightThemeShellTrack[]
  areas: Array<Array<TwilightThemeShellSlot | '.'>>
}

export interface TwilightThemeShellLayout {
  desktop: TwilightThemeShellGrid
  compact?: TwilightThemeShellGrid
  navigation?: TwilightThemeShellNavigation
}

export interface TwilightStructuredThemeV3 extends Omit<
  TwilightStructuredThemeV2,
  'schemaVersion'
> {
  schemaVersion: 3
  /** Host-owned shell grid. It can rearrange components but cannot inject DOM or script. */
  layout?: TwilightThemeShellLayout
}

export type TwilightStructuredTheme =
  | TwilightStructuredThemeV1
  | TwilightStructuredThemeV2
  | TwilightStructuredThemeV3

export interface TwilightThemesApi {
  /** @deprecated Themes must be declared in plugin.json contributes.themes. This call rejects. */
  register(theme: TwilightThemeContribution): Promise<void>
}

export interface TwilightQishuiAuthApi {
  getQrLogin(): Promise<QrLoginRequest | null>
  checkQrLogin(key: string): Promise<{ json: unknown; cookie?: string }>
  clear(): Promise<void>
}

export interface NativeDspParameterInfo {
  id: string
  name: string
  type: 'bool' | 'int' | 'float' | 'enum' | string
  defaultValue: number
  minValue: number
  maxValue: number
  step: number
  unit: string
  enumValues?: string[] | string | null
  currentValue: number
}

export interface NativeDspPluginStatus {
  id: string
  name?: string
  version?: string
  abiVersion?: 1 | 2
  graphPosition?: 'fixed-post-graph' | 'v2-sortable' | string
  supportedChannelLayouts?: number
  minimumSampleRate?: number
  maximumSampleRate?: number
  latencyFrames?: number
  tailFrames?: number
  enabled?: boolean
  loaded?: boolean
  active?: boolean
  bypassed?: boolean
  bypassReason?: string
  lastError?: string
  processCalls?: number
  overrunCount?: number
  lastProcessMs?: number
  maxProcessMs?: number
  parameters?: NativeDspParameterInfo[]
}

export interface TwilightOverlayAppearanceConfig {
  backgroundColor: string
  /** Surface opacity in percent (host clamps to 30–100). */
  backgroundOpacity: number
  textColor: string
  accentColor: string
  accentSource: 'custom' | 'cover'
  visualizerColor: string
  /** Text scale in percent (host clamps to 80–130). */
  fontScale: number
  collapsedRadius: number
  expandedRadius: number
  audioReactive: boolean
}

export interface TwilightOverlayLayoutConfig {
  collapsedWidth: number
  collapsedHeight: number
  expandedWidth: number
  anchor: 'left' | 'center' | 'right'
  offsetX: number
  offsetY: number
  display: 'main-window' | 'primary'
}

export interface TwilightOverlayComponentsConfig {
  collapsedContent: 'artwork' | 'track' | 'lyric'
  cover: boolean
  visualizer: boolean
  lyric: boolean
  progress: boolean
  time: boolean
  favorite: boolean
  skip: boolean
  volume: boolean
}

export interface TwilightOverlayBehaviorConfig {
  expandTrigger: 'hover' | 'click'
  collapseDelayMs: number
  motion: 'off' | 'fast' | 'normal' | 'slow'
  visibility: 'always' | 'when-track' | 'when-playing'
}

/** Complete, normalized dynamic island config as returned by `overlay.configure`. */
export interface TwilightOverlayConfig {
  appearance: TwilightOverlayAppearanceConfig
  layout: TwilightOverlayLayoutConfig
  components: TwilightOverlayComponentsConfig
  behavior: TwilightOverlayBehaviorConfig
}

/** Partial DIY config submitted by a plugin; the host fills and clamps every field. */
export interface TwilightOverlayConfigInput {
  appearance?: Partial<TwilightOverlayAppearanceConfig>
  layout?: Partial<TwilightOverlayLayoutConfig>
  components?: Partial<TwilightOverlayComponentsConfig>
  behavior?: Partial<TwilightOverlayBehaviorConfig>
}

/**
 * Controls the host-owned dynamic island window. Requires the `ui:inject`
 * permission and exclusive ownership: only one plugin may use it at a time.
 * Older hosts omit this namespace, so probe `typeof twilight.overlay?.configure`
 * before calling.
 */
export interface TwilightOverlayApi {
  show(): Promise<void>
  hide(): Promise<void>
  /** Returns the config the host actually rendered; persist this value. */
  configure(config?: TwilightOverlayConfigInput): Promise<TwilightOverlayConfig>
}

/**
 * Create or extend the user's local playlists.
 *
 * The renderer owns the playlist store, so the call is fire-and-forget: it
 * resolves once the request has been queued in the current application session.
 * Imports wait for the main renderer's library and playlists to finish loading,
 * and the host reports how many entries matched with a single combined toast. Entries are
 * matched by file path, exactly like the built-in `.m3u8` importer, so a plugin
 * never needs to know local track ids.
 *
 * Requests are batched because plugins typically import tens of playlists at
 * once; an empty playlist is skipped, and one with no matching paths still
 * creates the (empty) playlist.
 *
 * Requires the `library:write` permission. Hosts predating this namespace omit
 * `twilight.library`, so probe `typeof twilight.library?.importPlaylists`
 * before calling.
 */
export interface TwilightLibraryApi {
  importPlaylists(request: {
    playlists: Array<{
      /** Playlist to create, or append to by name. Maximum 80 normalized characters; longer names reject the request. */
      name: string
      /** Absolute audio file paths, in playlist order. */
      paths: string[]
    }>
  }): Promise<void>
  /** Paged/filtered local-library query (requires `library:read`). */
  queryTracks(query?: TwilightLibraryQuery): Promise<unknown>
  /** Full track payloads by id, including bpm/replayGain/format metadata (requires `library:read`). */
  getTracksByIds(ids: string[]): Promise<unknown>
  /** Optimistic-lock metadata patches; returns the refreshed page (requires `library:write`). */
  patchTracks(
    patches: Array<{ id: string; expectedVersion: number; patch: Record<string, unknown> }>
  ): Promise<unknown>
  /** Cover art bytes as a data URL, or null (requires `library:read`). */
  getCover(trackId: string): Promise<string | null>
  /** Local playlist summaries (requires `library:read`). */
  listPlaylists(): Promise<unknown>
  createPlaylist(name: string): Promise<unknown>
  addTracksToPlaylist(playlistId: string, trackIds: string[]): Promise<unknown>
  removeTracksFromPlaylist(playlistId: string, trackIds: string[]): Promise<unknown>
}

/** Subset of the host library query surface accepted from plugin code. */
export interface TwilightLibraryQuery {
  search?: string
  searchFileName?: boolean
  artist?: string
  albumId?: string
  genre?: string
  ids?: string[]
  sort?:
    | 'title'
    | 'artist'
    | 'album'
    | 'format'
    | 'trackNumber'
    | 'duration'
    | 'sampleRate'
    | 'addedAt'
    | 'recentlyAdded'
    | 'lastPlayed'
    | 'insertion'
    | 'unifiedSearch'
  direction?: 'asc' | 'desc'
  offset?: number
  limit?: number
  filters?: {
    lossless?: boolean
    dsd?: boolean
    sampleRate?: number
    bitDepth?: number
    folder?: string
    provider?: string
  }
}

/** Application settings read/write (requires `app:settings`). */
export interface TwilightAppSettingsApi {
  get(): Promise<unknown>
  update(patch: Record<string, unknown>): Promise<unknown>
}

/** Host window capabilities (requires `app:settings`). */
export interface TwilightHostApi {
  /** Compressed JPEG data URL of the main window, or null when unavailable. */
  captureScreenshot(): Promise<string | null>
}

export interface TwilightExperienceInvocationContext {
  /** Aborted when the caller times out, the panel unloads a cancellable request, or the plugin stops. */
  signal: AbortSignal
}

/**
 * Relay between this plugin's experience iframe and its background code. The
 * iframe sandbox has no network access; requests arriving here run in the
 * plugin's utility process with proxy-aware fetch and private storage.
 */
export interface TwilightExperienceApi {
  onRequest(
    handler: (request: unknown, context: TwilightExperienceInvocationContext) => unknown
  ): () => void
  /** Push a live event to the mounted experience iframe (dropped while unmounted). */
  emit(event: string, value: unknown): void
}

export interface TwilightApi {
  events: TwilightEventsApi
  player: TwilightPlayerApi
  providers: TwilightProvidersApi
  ui: TwilightUiApi
  themes: TwilightThemesApi
  /** Host-owned dynamic island window (requires `ui:inject`). */
  overlay?: TwilightOverlayApi
  /** Optional host-owned secure QR flow for the Qishui provider. */
  qishuiAuth?: TwilightQishuiAuthApi
  /** Local library read/write and playlist import. */
  library?: TwilightLibraryApi
  /** Application settings read/write (requires `app:settings`). */
  appSettings?: TwilightAppSettingsApi
  /** Host window capabilities such as screenshots (requires `app:settings`). */
  host?: TwilightHostApi
  /** Experience iframe ↔ background code relay. */
  experience?: TwilightExperienceApi
}

export type Activate = (context: TwilightPluginContext) => void | Promise<void>
export type Deactivate = () => void | Promise<void>
