import type { Track, TrackSource } from '@renderer/types/music'
import { sourceVersion } from '@renderer/stores/musicVersions.ts'
import { getTrackSource, versionSourceKey } from '@renderer/utils/trackSourceIdentity.ts'
export { getTrackSource } from '@renderer/utils/trackSourceIdentity.ts'
import { getLogicalTrackKey } from '@renderer/utils/logicalTrackIdentity.ts'

export interface SourceVariantInput {
  track: Track
  source?: TrackSource
  sourceName?: string
  providerAvailable?: boolean
  providerReliability?: number
  lossless?: boolean
}

export interface SourceVariant {
  track: Track
  source: TrackSource
  sourceName: string
  local: boolean
  lossless: boolean
  providerAvailable: boolean
  providerReliability: number
}

export interface LogicalTrack {
  id: string
  title: string
  artist: string
  album: string
  preferredTrack: Track
  variants: SourceVariant[]
  preferenceUnavailable?: boolean
}

const LOSSLESS_FORMATS = new Set([
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
const LOGICAL_DURATION_TOLERANCE_SECONDS = 8

export function buildLogicalTracks(inputs: Iterable<SourceVariantInput>): LogicalTrack[] {
  const groups: LogicalTrack[] = []
  const groupsByKey = new Map<string, LogicalTrack[]>()

  for (const input of inputs) {
    const variant = toSourceVariant(input)
    const candidateKey = getRecordingTrackKey(variant.track)
    const candidates = groupsByKey.get(candidateKey)
    const existing = candidates?.find(
      (item) =>
        candidateKey.startsWith('version:') ||
        item.variants.every((member) => canShareTrackIdentity(member.track, variant.track))
    )

    if (existing) {
      existing.variants.push(variant)
      continue
    }

    const nextGroup = {
      id: candidates?.length ? `${candidateKey}:${versionSourceKey(variant.track)}` : candidateKey,
      title: variant.track.title.trim() || '未知歌曲',
      artist: variant.track.artist.trim() || '未知艺术家',
      album: variant.track.album.trim() || '未知专辑',
      preferredTrack: variant.track,
      variants: [variant]
    }
    groups.push(nextGroup)
    if (candidates) {
      candidates.push(nextGroup)
    } else {
      groupsByKey.set(candidateKey, [nextGroup])
    }
  }

  for (const group of groups) {
    group.variants.sort(compareSourceVariants)
    group.preferredTrack = group.variants[0].track
    const preferred = preferredSourceKey(group.preferredTrack)
    group.preferenceUnavailable =
      !!preferred &&
      !group.variants.some(
        (variant) => versionSourceKey(variant.track) === preferred && variant.providerAvailable
      )
  }
  return groups
}

export function toSourceVariant(input: SourceVariantInput): SourceVariant {
  const source = getTrackSource(input.track, input.source)
  const local = source === 'local'
  const track = input.track.source === source ? input.track : { ...input.track, source }
  return {
    track,
    source,
    sourceName: input.sourceName ?? (local ? '本地音乐' : source),
    local,
    lossless: input.lossless ?? isLosslessTrack(input.track),
    providerAvailable: input.providerAvailable !== false,
    providerReliability: local ? 1 : clampReliability(input.providerReliability ?? 1)
  }
}

export function compareSourceVariants(left: SourceVariant, right: SourceVariant): number {
  return (
    compareSourceVariantPriority(left, right) ||
    left.track.title.localeCompare(right.track.title, 'zh') ||
    left.track.id.localeCompare(right.track.id)
  )
}

export function compareSourceVariantPriority(left: SourceVariant, right: SourceVariant): number {
  return (
    compareBoolean(isPreferredSource(right.track), isPreferredSource(left.track)) ||
    compareBoolean(right.local, left.local) ||
    compareBoolean(right.lossless, left.lossless) ||
    compareBoolean(right.providerAvailable, left.providerAvailable) ||
    right.providerReliability - left.providerReliability
  )
}

export function compareSourceVariantsByTitle(left: SourceVariant, right: SourceVariant): number {
  return (
    compareSourceVariantPriority(left, right) ||
    left.track.title.localeCompare(right.track.title, 'zh') ||
    left.track.id.localeCompare(right.track.id)
  )
}

export function canShareLogicalTrack(left: Track, right: Track): boolean {
  if (!left.duration || !right.duration) return true
  return Math.abs(left.duration - right.duration) <= LOGICAL_DURATION_TOLERANCE_SECONDS
}

export function canShareTrackIdentity(left: Track, right: Track): boolean {
  if (versionSourceKey(left) === versionSourceKey(right)) return true
  const leftVersion = sourceVersion('tracks', versionSourceKey(left))
  const rightVersion = sourceVersion('tracks', versionSourceKey(right))
  if (leftVersion || rightVersion) return !!leftVersion && leftVersion.id === rightVersion?.id
  if (getLogicalTrackKey(left) !== getLogicalTrackKey(right)) return false
  const versionHint = (track: Track): string =>
    (track.title + ' ' + track.album)
      .match(
        /\blive\b|现场|\bremaster(?:ed)?\b|重制|\bacoustic\b|\bunplugged\b|不插电|\binstrumental\b|伴奏/gi
      )
      ?.map((hint) => hint.toLowerCase())
      .sort()
      .join(':') ?? ''
  if (versionHint(left) !== versionHint(right)) return false
  const leftRemote = getRemoteSongRef(left)
  const rightRemote = getRemoteSongRef(right)
  if (
    leftRemote &&
    rightRemote &&
    leftRemote.provider === rightRemote.provider &&
    leftRemote.id !== rightRemote.id
  ) {
    return false
  }
  return canShareLogicalTrack(left, right)
}

function getRemoteSongRef(track: Track): { provider: string; id: string } | null {
  const source = getTrackSource(track)
  if (source === 'local') return null
  if (track.ncmSongId != null) return { provider: 'ncm', id: String(track.ncmSongId) }
  const separatorIndex = track.id.indexOf(':')
  const remoteId = separatorIndex > 0 ? track.id.slice(separatorIndex + 1).trim() : ''
  return remoteId ? { provider: source, id: remoteId } : null
}

export function getRecordingTrackKey(
  track: Pick<Track, 'id' | 'title' | 'artist'> & Partial<Track>
): string {
  const version = sourceVersion('tracks', versionSourceKey(track))
  return version ? `version:${version.id}` : getLogicalTrackKey(track)
}

export function preferredSourceKey(track: Track): string | null {
  return sourceVersion('tracks', versionSourceKey(track))?.preferredSource ?? null
}

function isPreferredSource(track: Track): boolean {
  return preferredSourceKey(track) === versionSourceKey(track)
}

export function isLosslessTrack(track: Track): boolean {
  const format = track.format?.trim().toLowerCase()
  if (format && LOSSLESS_FORMATS.has(format)) return true
  if (typeof track.bitDepth === 'number' && track.bitDepth >= 16) return true
  return false
}

export function clampReliability(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function compareBoolean(left: boolean, right: boolean): number {
  if (left === right) return 0
  return left ? 1 : -1
}
