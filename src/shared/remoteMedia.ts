/** Durable source reference; URLs and access tickets are deliberately not part of it. */
export interface RemoteMediaReference {
  libraryId: string
  sourceId: string
  sourceVersion?: string
}

export const REMOTE_STREAM_CONTENT_TYPES = [
  'audio/flac',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/ogg',
  'audio/opus',
  'audio/aiff',
  'audio/x-ape',
  'audio/x-wavpack'
] as const

export type RemoteStreamContentType = (typeof REMOTE_STREAM_CONTENT_TYPES)[number]

export const REMOTE_STREAM_EXTENSIONS = [
  '.flac',
  '.mp3',
  '.m4a',
  '.mp4',
  '.alac',
  '.aac',
  '.wav',
  '.wave',
  '.ogg',
  '.oga',
  '.opus',
  '.aiff',
  '.aif',
  '.ape',
  '.wv'
] as const

export const REMOTE_STREAM_FORMATS = [
  'flac',
  'mp3',
  'm4a',
  'alac',
  'aac',
  'wav',
  'ogg',
  'opus',
  'aiff',
  'ape',
  'wv'
] as const

export interface RemoteMediaPlan extends Required<RemoteMediaReference> {
  contentPath: string
  contentType: RemoteStreamContentType
  size: number
  expiresAt: number
  maxRangeBytes: number
}

export const REMOTE_STREAM_TTL_MS = 15 * 60_000
export const REMOTE_STREAM_RANGE_BYTES = 256 * 1024
