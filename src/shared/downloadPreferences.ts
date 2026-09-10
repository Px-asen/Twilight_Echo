export type DownloadNaming = 'provider' | 'artist-title' | 'title-artist' | 'title'

export interface DownloadPreferences {
  naming: DownloadNaming
  embedMetadata: boolean
  saveLyrics: boolean
}

export const DEFAULT_DOWNLOAD_PREFERENCES: DownloadPreferences = {
  naming: 'provider',
  embedMetadata: false,
  saveLyrics: false
}

export function normalizeDownloadPreferences(raw: unknown): DownloadPreferences {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    naming: ['provider', 'artist-title', 'title-artist', 'title'].includes(String(value.naming))
      ? (value.naming as DownloadNaming)
      : 'provider',
    embedMetadata: value.embedMetadata === true,
    saveLyrics: value.saveLyrics === true
  }
}

export function downloadTrackName(
  track: { title: string; artist: string },
  naming: DownloadNaming
): string | null {
  switch (naming) {
    case 'artist-title':
      return `${track.artist} - ${track.title}`
    case 'title-artist':
      return `${track.title} - ${track.artist}`
    case 'title':
      return track.title
    default:
      return null
  }
}
