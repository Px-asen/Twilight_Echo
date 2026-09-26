import { randomUUID } from 'crypto'
import type { NativeAudioMetadata } from '../../shared/audioEngineTypes.ts'

export type SacdIsoMetadataReader = (filePath: string) => Promise<NativeAudioMetadata | null>

type TrackRecord = Record<string, unknown>

function isTrackRecord(value: unknown): value is TrackRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnexpandedIso(track: unknown): track is TrackRecord & { filePath: string } {
  return (
    isTrackRecord(track) &&
    typeof track.filePath === 'string' &&
    track.filePath.toLowerCase().endsWith('.iso') &&
    (typeof track.subTrack !== 'string' || !track.subTrack)
  )
}

function positiveInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function toIsoTrack(container: TrackRecord, isoTrack: NativeAudioMetadata): TrackRecord {
  const track: TrackRecord = {
    id: randomUUID(),
    title: isoTrack.title || 'Unknown Track',
    artist: isoTrack.artist || 'Unknown Artist',
    album: isoTrack.album || 'Unknown Album',
    filePath: container.filePath,
    fileName: container.fileName,
    dir: container.dir,
    duration: Math.round(isoTrack.duration || 0),
    size: container.size,
    addedAt: container.addedAt,
    cover: container.cover ?? null,
    lyrics: null,
    format: isoTrack.container || 'SACD ISO',
    sampleRate: isoTrack.sampleRate,
    bitDepth: isoTrack.bitDepth || 1,
    subTrack: isoTrack.source
  }
  if (isoTrack.albumArtist) track.albumArtist = isoTrack.albumArtist
  const trackNumber = positiveInteger(isoTrack.trackNumber)
  if (trackNumber !== undefined) track.trackNumber = trackNumber
  const discNumber = positiveInteger(isoTrack.discNumber)
  if (discNumber !== undefined) track.discNumber = discNumber
  return track
}

async function expandIso(
  container: TrackRecord & { filePath: string },
  readMetadata: SacdIsoMetadataReader
): Promise<TrackRecord[]> {
  let metadata: NativeAudioMetadata | null
  try {
    metadata = await readMetadata(container.filePath)
  } catch {
    return [container]
  }
  const playable = (metadata?.isoTracks ?? []).filter(
    (isoTrack) =>
      isoTrack.playable !== false && typeof isoTrack.source === 'string' && isoTrack.source
  )
  if (playable.length === 0) return [container]
  return playable.map((isoTrack) => toIsoTrack(container, isoTrack))
}

/**
 * The scan worker runs music-metadata only, which sees a SACD ISO as one opaque
 * file. The native engine enumerates its programme areas; each playable area
 * track becomes its own library entry keyed by `subTrack`.
 */
export async function expandSacdIsoTracks(
  tracks: unknown[],
  readMetadata: SacdIsoMetadataReader
): Promise<unknown[]> {
  if (!tracks.some(isUnexpandedIso)) return tracks
  const expanded: unknown[] = []
  for (const track of tracks) {
    if (isUnexpandedIso(track)) expanded.push(...(await expandIso(track, readMetadata)))
    else expanded.push(track)
  }
  return expanded
}
