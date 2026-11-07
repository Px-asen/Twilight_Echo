/** One completed listening attempt, using seconds rather than seek position. */
export interface NcmListeningReport {
  id: number
  accountId: number
  time: number
  total: number
  name: string
  artist: string
  sourceid?: string
  level?: string
  bitrate?: number
}

export interface ListeningSyncStatus {
  enabled: boolean
  available: boolean
  pending: number
  lastSubmitted: { title: string; seconds: number; at: number } | null
  error: string | null
}
