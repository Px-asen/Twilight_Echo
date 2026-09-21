import type { Track } from '@renderer/types/music'
import { normalizePortableLibraryPath } from '@renderer/stores/library/musicStoreData.ts'
import { getTrackSource } from '@renderer/utils/logicalTrackModel.ts'
import { duplicateGroupLabel } from '@renderer/utils/localLibraryTagManagement.ts'
import type { DuplicateDetectionResult } from '../../../../shared/duplicateDetection.ts'

export type InboxKind = 'cover' | 'tags' | 'enrichment' | 'duplicate'
export type InboxStatus = 'pending' | 'ignored' | 'done'
export type InboxIssue = {
  key: string
  fingerprint: string
  kind: InboxKind
  track: Track
  reason: string
}
export type InboxDecision = { fingerprint: string; status: 'ignored' | 'done' }
export const INBOX_STORAGE_KEY = 'twilight.library-inbox.v1'
export const INBOX_PAGE_SIZE = 50
export const inboxLabels: Record<InboxKind, string> = {
  cover: '缺封面',
  tags: '必要标签待检查',
  enrichment: '补全结果待确认',
  duplicate: '疑似重复'
}

function missing(value: string): boolean {
  return !value.trim() || /^(unknown( artist| album)?|未知(歌手|艺术家|专辑)?)$/i.test(value.trim())
}

export function inboxTrackIdentity(track: Track): string {
  return JSON.stringify([
    track.id,
    normalizePortableLibraryPath(track.filePath),
    track.subTrack,
    track.cueRange
  ])
}

export function inboxTrackFingerprint(track: Track): string {
  return JSON.stringify([
    inboxTrackIdentity(track),
    track.title,
    track.artist,
    track.album,
    track.albumArtist,
    track.genre,
    track.trackNumber,
    track.discNumber,
    track.size,
    track.duration,
    track.addedAt,
    Boolean(track.cover || track.coverSource),
    track.metadataMatch
  ])
}

export function buildInboxIssues(
  tracks: readonly Track[],
  duplicates: DuplicateDetectionResult | null = null
): InboxIssue[] {
  const issues: InboxIssue[] = []
  const localById = new Map<string, Track>()
  const add = (
    track: Track,
    kind: InboxKind,
    reason: string,
    extra = '',
    evidence = extra
  ): void => {
    issues.push({
      key: JSON.stringify([inboxTrackIdentity(track), kind, extra]),
      fingerprint: inboxTrackFingerprint(track) + evidence,
      kind,
      track,
      reason
    })
  }
  for (const track of tracks) {
    if (getTrackSource(track) !== 'local' || !track.filePath) continue
    localById.set(track.id, track)
    if (!track.cover && !track.coverSource) add(track, 'cover', '当前曲库没有可用封面')
    const fields: string[] = []
    if (missing(track.title)) fields.push('标题缺失')
    else if (track.title === track.fileName.replace(/\.[^.]+$/, '')) {
      fields.push('标题可能来自文件名，请人工核对')
    }
    if (missing(track.artist)) fields.push('歌手缺失或为占位值')
    if (missing(track.album)) fields.push('专辑缺失或为占位值')
    if (fields.length) add(track, 'tags', fields.join('；'))
    if (track.metadataMatch?.confidence === 'medium') {
      add(
        track,
        'enrichment',
        `已有 ${track.metadataMatch.providerId} 中等置信度补全，请核对标签和封面`
      )
    }
  }
  let groupNumber = 0
  for (const group of duplicates?.groups ?? []) {
    groupNumber++
    const evidence = JSON.stringify([
      group.key,
      group.kind,
      group.confidence,
      group.items.length,
      membershipFingerprint(
        group.items
          .map((item) =>
            JSON.stringify([
              item.id,
              item.filePath,
              item.size,
              item.duration,
              item.title,
              item.artist,
              item.album
            ])
          )
          .sort()
          .join('\n')
      )
    ])
    for (const item of group.items) {
      const track = localById.get(item.id)
      if (
        !track ||
        normalizePortableLibraryPath(track.filePath) !== normalizePortableLibraryPath(item.filePath)
      )
        continue
      add(
        track,
        'duplicate',
        `第 ${groupNumber} 组 · ${duplicateGroupLabel(group)} · ${group.items.length} 个候选；仅供复核`,
        `${group.kind}:${group.key}`,
        evidence
      )
    }
  }
  return issues
}

function membershipFingerprint(value: string): string {
  let first = 2166136261
  let second = 5381
  for (let index = 0; index < value.length; index++) {
    first = Math.imul(first ^ value.charCodeAt(index), 16777619)
    second = Math.imul(second, 33) ^ value.charCodeAt(index)
  }
  return `${value.length}:${first >>> 0}:${second >>> 0}`
}

export function inboxStatus(
  issue: InboxIssue,
  decisions: ReadonlyMap<string, InboxDecision>
): InboxStatus {
  const decision = decisions.get(issue.key)
  return decision?.fingerprint === issue.fingerprint ? decision.status : 'pending'
}

export function parseInboxDecisions(raw: string | null): Map<string, InboxDecision> {
  if (!raw) return new Map()
  const data = JSON.parse(raw) as { version?: number; entries?: unknown }
  if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('整理记录格式不受支持')
  const result = new Map<string, InboxDecision>()
  for (const entry of data.entries.slice(-20000)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
    const value = entry[1] as Partial<InboxDecision> | null
    if (
      value &&
      typeof value.fingerprint === 'string' &&
      (value.status === 'ignored' || value.status === 'done')
    ) {
      result.set(entry[0], { fingerprint: value.fingerprint, status: value.status })
    }
  }
  return result
}

export function serializeInboxDecisions(decisions: ReadonlyMap<string, InboxDecision>): string {
  return JSON.stringify({ version: 1, entries: [...decisions].slice(-20000) })
}

export function currentInboxTracks(selected: readonly Track[], current: readonly Track[]): Track[] {
  const records = new Map(current.map((track) => [inboxTrackIdentity(track), track]))
  return selected.filter((track) => records.get(inboxTrackIdentity(track)) === track)
}
