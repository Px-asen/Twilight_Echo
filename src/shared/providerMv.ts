export const MEDIA_PROVIDER_MV_QUALITIES = ['auto', '1080p', '720p', '480p'] as const
export type MediaProviderMvQuality = (typeof MEDIA_PROVIDER_MV_QUALITIES)[number]

export const MEDIA_PROVIDER_MV_SOURCES = ['auto', 'bili', 'ncm'] as const
export type MediaProviderMvSource = (typeof MEDIA_PROVIDER_MV_SOURCES)[number]

export interface MediaProviderMvOptions {
  quality?: MediaProviderMvQuality
  source?: MediaProviderMvSource
  force?: boolean
}

/**
 * Provider-resolved Music Video stream.
 *
 * Plugins return raw http(s) URLs (and an optional origin `referer` for CDNs
 * such as Bilibili `*.bilivideo.com`); `protectProviderMedia(..., 'getTrackMv')`
 * converts all URLs into opaque `twilight-media://` grants and strips `referer`
 * before the payload reaches Core or the Renderer.
 */
export interface MediaProviderMvStream {
  /** Progressive MP4/WebM video stream (`twilight-media://video/<token>` after grant protection). */
  url: string
  /**
   * Optional separate audio stream (`twilight-media://audio/<token>` after grant protection)
   * for DASH providers such as Bilibili where the video track is silent m4s.
   */
  audioUrl?: string | null
  /** Optional poster/thumbnail handle (`twilight-media://image/<token>` after grant protection). */
  coverUrl?: string | null
  /** Human-readable quality label, e.g. `'1080p'`, `'720p'`, `'480p'`. */
  quality?: string | null
  width?: number | null
  height?: number | null
  durationSeconds?: number | null
  providerId?: string
  mvId?: string | null
  title?: string | null
}

/** Plugin-side return shape before `protectProviderMedia` rewrites remote URLs into grants. */
export interface PluginMediaProviderMvResult extends MediaProviderMvStream {
  /** Optional upstream Referer origin (e.g. `'https://www.bilibili.com/'`), consumed & stripped by main. */
  referer?: string | null
}

const AUTHORIZED_VIDEO_HANDLE_RE = /^twilight-media:\/\/video\/[a-zA-Z0-9_-]{1,256}$/
const AUTHORIZED_AUDIO_HANDLE_RE = /^twilight-media:\/\/audio\/[a-zA-Z0-9_-]{1,256}$/
const AUTHORIZED_IMAGE_HANDLE_RE = /^twilight-media:\/\/image\/[a-zA-Z0-9_-]{1,256}$/

export function isMediaProviderMvQuality(value: unknown): value is MediaProviderMvQuality {
  return (
    typeof value === 'string' &&
    (MEDIA_PROVIDER_MV_QUALITIES as readonly string[]).includes(value)
  )
}

export function isMediaProviderMvSource(value: unknown): value is MediaProviderMvSource {
  return (
    typeof value === 'string' &&
    (MEDIA_PROVIDER_MV_SOURCES as readonly string[]).includes(value)
  )
}

export function isAuthorizedMvVideoHandle(value: unknown): value is string {
  return typeof value === 'string' && AUTHORIZED_VIDEO_HANDLE_RE.test(value)
}

export function isAuthorizedMvAudioHandle(value: unknown): value is string {
  return typeof value === 'string' && AUTHORIZED_AUDIO_HANDLE_RE.test(value)
}

export function isAuthorizedMvImageHandle(value: unknown): value is string {
  return typeof value === 'string' && AUTHORIZED_IMAGE_HANDLE_RE.test(value)
}

function boundedOptionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\0/g, '').trim()
  return trimmed ? trimmed.slice(0, maxLength) : null
}

function boundedPositiveDimension(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const rounded = Math.round(value)
  return rounded > 0 && rounded <= 16_384 ? rounded : null
}

function boundedDurationSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value <= 86_400 ? Math.round(value * 1000) / 1000 : null
}

/**
 * Projects a provider MV payload across the Core -> Renderer boundary.
 * Only opaque `twilight-media://` handles and bounded scalar fields are kept;
 * raw http(s) URLs, filesystem paths, and `referer` hints are never forwarded.
 */
export function normalizeProviderMvStream(
  raw: unknown,
  fallbackProviderId?: string
): MediaProviderMvStream | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (!isAuthorizedMvVideoHandle(record.url)) return null

  const audioUrl = isAuthorizedMvAudioHandle(record.audioUrl) ? record.audioUrl : null
  const coverUrl = isAuthorizedMvImageHandle(record.coverUrl) ? record.coverUrl : null
  const quality = boundedOptionalText(record.quality, 32)
  const width = boundedPositiveDimension(record.width)
  const height = boundedPositiveDimension(record.height)
  const durationSeconds = boundedDurationSeconds(record.durationSeconds)
  const providerId =
    boundedOptionalText(record.providerId, 64)?.toLowerCase() ??
    boundedOptionalText(fallbackProviderId, 64)?.toLowerCase() ??
    undefined
  const mvId =
    typeof record.mvId === 'number' && Number.isFinite(record.mvId) && record.mvId > 0
      ? String(Math.trunc(record.mvId))
      : boundedOptionalText(record.mvId, 128)
  const title = boundedOptionalText(record.title, 512)

  return {
    url: record.url,
    ...(audioUrl ? { audioUrl } : {}),
    ...(coverUrl ? { coverUrl } : {}),
    ...(quality ? { quality } : {}),
    ...(width !== null ? { width } : {}),
    ...(height !== null ? { height } : {}),
    ...(durationSeconds !== null ? { durationSeconds } : {}),
    ...(providerId ? { providerId } : {}),
    ...(mvId ? { mvId } : {}),
    ...(title ? { title } : {})
  }
}
