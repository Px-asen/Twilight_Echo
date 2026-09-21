import type { Track, TrackSource } from '@renderer/types/music'

export function getTrackSource(
  track: Pick<Track, 'id' | 'source'>,
  fallback?: string
): TrackSource {
  if (track.source || fallback) return (track.source || fallback)!.trim().toLowerCase()
  if (/^[a-zA-Z]:[\\/]/.test(track.id) || /^[\\/]/.test(track.id)) return 'local'
  const separator = track.id.indexOf(':')
  return separator > 0 ? track.id.slice(0, separator).trim().toLowerCase() : 'local'
}

export function versionSourceKey(track: Pick<Track, 'id' | 'source'> & Partial<Track>): string {
  const source = getTrackSource(track)
  if (source !== 'local') {
    const id = track.id.startsWith(source + ':') ? track.id.slice(source.length + 1) : track.id
    return JSON.stringify([source, String(source === 'ncm' ? (track.ncmSongId ?? id) : id)])
  }
  let path = (track.filePath || track.id).replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(path)) path = path.toLowerCase()
  return JSON.stringify(['local', path, track.subTrack ?? null, track.cueRange ?? null])
}
