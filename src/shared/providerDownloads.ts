export type ProviderDownloadQuality = 'aac' | 'lossless' | 'hi-res'

export type ProviderDownloadTaskStatus =
  | 'queued'
  | 'preparing'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ProviderDownloadTrackInput {
  id: string | number
  title: string
  artist: string
  album?: string
  cover?: string
  provider?: string
  [key: string]: unknown
}

export interface ProviderDownloadCreateInput {
  providerId: string
  track: ProviderDownloadTrackInput
  quality: ProviderDownloadQuality
  targetRoot?: string
}

export interface ProviderDownloadTaskSnapshot {
  id: string
  providerId: string
  providerJobId: string
  track: ProviderDownloadTrackInput
  requestedQuality: ProviderDownloadQuality
  actualQuality: ProviderDownloadQuality | null
  qualityVerified?: boolean
  warning?: string | null
  status: ProviderDownloadTaskStatus
  progress: number
  queuePosition: number | null
  targetPath: string | null
  fileSize: number | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export const PROVIDER_DOWNLOAD_CHANGED_CHANNEL = 'providerDownloads:changed'
