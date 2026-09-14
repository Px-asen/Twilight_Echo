import type { Track } from '@renderer/types/music'
import { restoreQueueTrackIdentity } from '@renderer/utils/queueSessionTrack.ts'
import { toPlaybackQueueSnapshot } from '@renderer/utils/playbackQueueVirtualization.ts'
import type { NamedQueueSession, SavedQueueTrack } from '../../../../shared/queueWorkspace.ts'

export interface QueueSessionRestoreSources {
  localTracks: ReadonlyMap<string, Track>
  savedStreams: ReadonlyMap<string, Track>
  availableProviders: ReadonlySet<string>
  networkProfiles: ReadonlySet<string>
  authorizeFiles: (paths: string[]) => Promise<boolean[]>
  isCurrent: () => boolean
}

export interface QueueSessionRestoreResult {
  queue: Track[]
  original: Track[]
  index: number
  position: number
  missing: Array<{ entry: SavedQueueTrack; reason: string }>
  deferred: number
}

export async function resolveQueueSession(
  session: NamedQueueSession,
  sources: QueueSessionRestoreSources
): Promise<QueueSessionRestoreResult> {
  const candidates: Array<{ saved: SavedQueueTrack; track: Track }> = []
  const paths = new Set<string>()
  const missing: QueueSessionRestoreResult['missing'] = []
  let deferred = 0
  for (const entry of session.entries) {
    let track: Track | undefined
    let reason = ''
    if (entry.source === 'local') {
      track = sources.localTracks.get(entry.id)
      if (track) paths.add(track.filePath)
      else reason = '曲目已不在本地库中'
    } else if (entry.source === 'radio' || entry.source === 'podcast') {
      track = sources.savedStreams.get(`${entry.source}:${entry.id}`)
      if (!track) reason = '电台或播客条目已移除'
    } else if (entry.source === 'network') {
      if (!entry.network) reason = '缺少网络来源身份，请从网络源重新加入'
      else if (!sources.networkProfiles.has(entry.network.profileId)) reason = '网络源已移除'
      else {
        track = restoreQueueTrackIdentity(entry)
        deferred++
      }
    } else if (!sources.availableProviders.has(entry.source)) {
      reason = '音源未安装、未启用或不可用'
    } else {
      track = restoreQueueTrackIdentity(entry)
      deferred++
    }
    if (track)
      candidates.push({
        saved: entry,
        track: { ...toPlaybackQueueSnapshot(track), queueEntryId: entry.queueEntryId }
      })
    else missing.push({ entry, reason })
  }
  const pathList = [...paths]
  const authorized = new Set<string>()
  for (let start = 0; start < pathList.length; start += 256) {
    if (!sources.isCurrent()) throw new Error('队列已变化，已取消恢复，请重新选择会话')
    const batch = pathList.slice(start, start + 256)
    const flags = await sources.authorizeFiles(batch)
    for (let index = 0; index < batch.length; index++) {
      if (flags[index]) authorized.add(batch[index])
    }
  }
  if (!sources.isCurrent()) throw new Error('队列已变化，已取消恢复，请重新选择会话')
  const queue: Track[] = []
  const byEntryId = new Map<string, Track>()
  let index = -1
  for (const { saved, track } of candidates) {
    if (saved.source === 'local' && !authorized.has(track.filePath)) {
      missing.push({ entry: saved, reason: '本地文件缺失或未获授权' })
      continue
    }
    if (saved.queueEntryId === session.currentEntryId) index = queue.length
    queue.push(track)
    byEntryId.set(saved.queueEntryId, track)
  }
  const original: Track[] = []
  for (const entryId of session.originalEntryIds) {
    const track = byEntryId.get(entryId)
    if (track) original.push(track)
  }
  return {
    queue,
    original,
    index: Math.max(0, index),
    position: index >= 0 ? session.position : 0,
    missing,
    deferred
  }
}
