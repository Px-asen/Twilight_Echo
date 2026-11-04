/**
 * Pure rules behind the 声区 dialogs. The dialogs stay presentational: they ask
 * these helpers what may be chosen and why not, then emit a payload Core will
 * accept. Every refusal is a short Chinese sentence a dialog can show as is.
 *
 * Core stays authoritative — it re-checks every rule against fresh revisions —
 * so these helpers only keep the user from composing a request that is
 * certain to fail.
 */
import { parseBridgeInvitation, type BridgePeer } from '../../../../../shared/audioBridge.ts'
import {
  MAX_CORE_ZONES,
  zoneQueueFence,
  type ZoneHandoff,
  type ZoneQueueFence,
  type ZoneView
} from '../../../../../shared/coreZones.ts'
import type { SyncGroupCreate } from '../../../../../shared/coreSyncGroups.ts'

export const GROUP_MIN_MEMBERS = 2
export const GROUP_MAX_MEMBERS = MAX_CORE_ZONES
export const DOWNSTREAM_DELAY_MIN_MS = 0
export const DOWNSTREAM_DELAY_MAX_MS = 250
/** Core limit for zone and group names, in UTF-16 code units. */
export const NAME_MAX_LENGTH = 80

export type RuleResult<T> = { ok: true; payload: T } | { ok: false; reason: string }

type ZoneQueue = ZoneView['queue']

export const isLocalZone = (zone: Pick<ZoneView, 'id'>): boolean => zone.id === 'local'

// ---------------------------------------------------------------------------
// Queues

/**
 * Why a queue cannot be handed over or adopted, as a short phrase without the
 * zone name; null when it can. Core fences a moving queue by its current
 * occurrence, so a queue without one is as unusable as no queue at all.
 */
export function queueIssue(queue: ZoneQueue): string | null {
  if (!queue || queue.total <= 0) return '队列为空'
  if (!queue.occurrenceId) return '队列没有当前曲目'
  return null
}

/** The fence Core accepts for a queue that is handed over or adopted. */
export function adoptableQueue(zone: Pick<ZoneView, 'queue'>): ZoneQueueFence | null {
  return queueIssue(zone.queue) ? null : zoneQueueFence(zone.queue)
}

/** "第 3 / 12 首" or "队列为空". */
export function queuePosition(queue: ZoneQueue): string {
  if (!queue || queue.total <= 0) return '队列为空'
  const index = Math.min(Math.max(queue.index, 0), queue.total - 1)
  return `第 ${index + 1} / ${queue.total} 首`
}

/** The title a zone is on, or a quiet fallback when it has nothing queued. */
export function zoneTrackLine(zone: Pick<ZoneView, 'track' | 'queue'>): string {
  const track = zone.track
  if (!track || !zone.queue || zone.queue.total <= 0) return '队列为空'
  const artist = track.artist?.trim()
  const title = track.title?.trim() || '未知曲目'
  return artist ? `${title} — ${artist}` : title
}

export function playbackLabel(zone: Pick<ZoneView, 'playback'>): string {
  const state = zone.playback?.state
  if (state === 'playing') return '播放中'
  if (state === 'paused') return '已暂停'
  return '已停止'
}

// ---------------------------------------------------------------------------
// Outputs

export type ZoneOutputState = 'local' | 'connected' | 'offline' | 'unpaired'

/**
 * Where a zone's sound goes. A bridge zone never falls back to local speakers,
 * so a bridge that is not connected is a real, silent state.
 */
export function zoneOutputState(zone: Pick<ZoneView, 'id' | 'output'>): ZoneOutputState {
  const output = zone.output
  if (isLocalZone(zone) && !output?.selected) return 'local'
  if (output?.connected) return 'connected'
  if (output?.selected || output?.peerName) return 'offline'
  return 'unpaired'
}

/** "本机输出" / "输出桥 · {peerName}" / "未配对输出桥" — the wording of the zone wall. */
export function zoneOutputLabel(zone: Pick<ZoneView, 'id' | 'output'>): string {
  const output = zone.output
  if (isLocalZone(zone)) {
    return output?.selected ? `输出桥 · ${output.peerName ?? '未命名设备'}` : '本机输出'
  }
  return output?.peerName ? `输出桥 · ${output.peerName}` : '未配对输出桥'
}

export type ChipTone = 'success' | 'warning' | 'info' | 'danger' | 'neutral'

/**
 * A chip only where the output line alone would mislead: "输出桥 · STUDY-PC"
 * reads as working, so an offline bridge says so. "未配对输出桥" already does.
 */
export function zoneOutputChip(
  zone: Pick<ZoneView, 'id' | 'output'>
): { label: string; tone: ChipTone } | null {
  return zoneOutputState(zone) === 'offline' ? { label: '离线', tone: 'danger' } : null
}

export interface ZoneThumb {
  /** Core track whose cover lights the thumbnail; null shows the glyph. */
  trackId: string | null
  /** Phosphor glyph class for the unlit thumbnail. */
  glyph: string
}

/**
 * A small window of the zone, as on the wall: the cover while the output can
 * sound, a plug for an offline bridge, a broken link for one never connected.
 */
export function zoneThumb(zone: Pick<ZoneView, 'id' | 'output' | 'track'>): ZoneThumb {
  const state = zoneOutputState(zone)
  if (state === 'offline') return { trackId: null, glyph: 'ph-plugs' }
  if (state === 'unpaired') return { trackId: null, glyph: 'ph-link-simple-break' }
  return { trackId: zone.track?.id ?? null, glyph: 'ph-music-notes-simple' }
}

// ---------------------------------------------------------------------------
// Handoff

/** Why the source cannot hand over its queue; null when it can. */
export function handoffSourceIssue(source: ZoneView | null | undefined): string | null {
  if (!source) return '源声区已不存在，请刷新后重试'
  if (source.groupId) return `「${source.name}」在同步组中，请先解除编组`
  if (!source.queue || source.queue.total <= 0) return `「${source.name}」的队列为空，没有可接力的内容`
  if (!source.queue.occurrenceId) return `「${source.name}」的队列没有当前曲目，无法接力`
  return null
}

/** Why a zone cannot receive a handoff; null when it can. */
export function handoffTargetIssue(target: Pick<ZoneView, 'groupId'>): string | null {
  return target.groupId ? '已加入同步组，请先解除编组' : null
}

export interface HandoffTarget {
  zone: ZoneView
  /** Why this zone cannot be chosen; null when it can. */
  reason: string | null
}

/** Every zone except the source, in list order, each with its eligibility. */
export function handoffTargets(zones: readonly ZoneView[], sourceId: string): HandoffTarget[] {
  return zones
    .filter((zone) => zone.id !== sourceId)
    .map((zone) => ({ zone, reason: handoffTargetIssue(zone) }))
}

/**
 * Whether the user must confirm `replace`: the target holds tracks it would
 * lose. An empty queue loses nothing, so it is replaced without asking.
 */
export function handoffNeedsReplace(target: Pick<ZoneView, 'queue'>): boolean {
  return Boolean(target.queue && target.queue.total > 0)
}

export interface HandoffResume {
  available: boolean
  /** Why the target cannot resume after the handoff; null when it can. */
  reason: string | null
}

/**
 * Resume needs a target that can actually sound. Core refuses a selected but
 * disconnected bridge; a bridge zone that was never connected has no output at
 * all, so "continue playing" would be a silent promise.
 */
export function handoffResume(target: Pick<ZoneView, 'id' | 'output'>): HandoffResume {
  const output = target.output
  if (output?.selected && !output.connected) {
    return { available: false, reason: '目标输出桥未连接，接力后保持暂停' }
  }
  if (!isLocalZone(target) && !output?.connected) {
    return { available: false, reason: '目标声区尚未连接输出桥，接力后保持暂停' }
  }
  return { available: true, reason: null }
}

export interface HandoffChoice {
  /** The user ticked "替换「{target}」当前的队列". */
  replace: boolean
  /** The user wants the target to keep playing. */
  resume: boolean
}

/** A ready `zones.handoff` payload fenced by the zones' current revisions. */
export function buildHandoff(
  source: ZoneView | null | undefined,
  target: ZoneView | null | undefined,
  choice: HandoffChoice
): RuleResult<ZoneHandoff> {
  const sourceIssue = handoffSourceIssue(source)
  if (sourceIssue) return { ok: false, reason: sourceIssue }
  const queue = source ? adoptableQueue(source) : null
  if (!source || !queue) return { ok: false, reason: '源声区没有可接力的队列' }
  if (!target) return { ok: false, reason: '请选择接力的目标声区' }
  if (target.id === source.id) return { ok: false, reason: '请选择另一个声区作为目标' }
  const targetIssue = handoffTargetIssue(target)
  if (targetIssue) return { ok: false, reason: `「${target.name}」${targetIssue}` }
  if (handoffNeedsReplace(target) && !choice.replace) {
    return { ok: false, reason: `请先确认替换「${target.name}」当前的队列` }
  }
  return {
    ok: true,
    payload: {
      source: { zoneId: source.id, revision: source.revision, queue },
      target: { zoneId: target.id, revision: target.revision, queue: zoneQueueFence(target.queue) },
      // Core demands the flag for any queue object, empty ones included.
      replace: target.queue !== null,
      resume: choice.resume && handoffResume(target).available
    }
  }
}

// ---------------------------------------------------------------------------
// Sync groups

/** Synchronised playback needs every member on an adaptive-clock bridge. */
export function memberReady(zone: Pick<ZoneView, 'output'>): boolean {
  return Boolean(zone.output?.connected && zone.output.receiver?.adaptiveSupported)
}

export interface MemberReadiness {
  ready: boolean
  /** "可同步", or what stands between the zone and synchronised playback. */
  label: string
}

/** Readiness in the wording of the group alignment card. */
export function memberReadiness(zone: Pick<ZoneView, 'id' | 'output'>): MemberReadiness {
  if (memberReady(zone)) return { ready: true, label: '可同步' }
  const state = zoneOutputState(zone)
  if (state === 'local') return { ready: false, label: '需要输出桥' }
  if (state === 'offline') return { ready: false, label: '输出桥离线' }
  if (state === 'unpaired') return { ready: false, label: '未配对输出桥' }
  return { ready: false, label: '不支持时钟自适应' }
}

/** Why a zone cannot join a new group; null when it can. */
export function memberIssue(zone: Pick<ZoneView, 'groupId'>): string | null {
  return zone.groupId ? '已在同步组中' : null
}

export function clampDelay(value: number): number {
  if (!Number.isFinite(value)) return DOWNSTREAM_DELAY_MIN_MS
  return Math.min(DOWNSTREAM_DELAY_MAX_MS, Math.max(DOWNSTREAM_DELAY_MIN_MS, Math.round(value)))
}

export function validDelay(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= DOWNSTREAM_DELAY_MIN_MS &&
    value <= DOWNSTREAM_DELAY_MAX_MS
  )
}

/** "未校准" for 0 ms, otherwise "{n} ms". */
export function formatDelay(value: number): string {
  return value === 0 ? '未校准' : `${value} ms`
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  let cut = max - 1
  const code = value.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return `${value.slice(0, cut)}…`
}

/** "书房 + 客厅" — the name a group gets when the user leaves the field blank. */
export function defaultGroupName(names: readonly string[]): string {
  const joined = names
    .map((name) => name.trim())
    .filter(Boolean)
    .join(' + ')
  return truncate(joined, NAME_MAX_LENGTH)
}

function nameIssue(name: string, subject: string): string | null {
  const value = name.trim()
  if (!value) return `请输入${subject}`
  if (value.length > NAME_MAX_LENGTH) return `${subject}最多 ${NAME_MAX_LENGTH} 个字符`
  if (value.includes('\0')) return `${subject}包含无效字符`
  return null
}

export interface GroupComposerDraft {
  zones: readonly ZoneView[]
  /** Zone registry revision (`ZonesView.revision`). */
  revision: number
  name: string
  memberIds: readonly string[]
  sourceId: string | null
  /** Per-member downstream delay in ms; a missing entry means 0 (未校准). */
  delays: Readonly<Record<string, number | undefined>>
}

/** Validates the composer and builds a ready `groups.create` payload. */
export function validateGroupComposer(draft: GroupComposerDraft): RuleResult<SyncGroupCreate> {
  const ids = new Set(draft.memberIds)
  if (ids.size !== draft.memberIds.length) return { ok: false, reason: '同一个声区只能选择一次' }
  if (ids.size < GROUP_MIN_MEMBERS) {
    return { ok: false, reason: `至少选择 ${GROUP_MIN_MEMBERS} 个声区` }
  }
  if (ids.size > GROUP_MAX_MEMBERS) {
    return { ok: false, reason: `最多选择 ${GROUP_MAX_MEMBERS} 个声区` }
  }
  // Members follow the zone list order so the group frame reads like the wall.
  const members = draft.zones.filter((zone) => ids.has(zone.id))
  if (members.length !== ids.size) return { ok: false, reason: '所选声区已不存在，请刷新后重试' }
  for (const zone of members) {
    const issue = memberIssue(zone)
    if (issue) return { ok: false, reason: `「${zone.name}」${issue}` }
    const delay = draft.delays[zone.id] ?? 0
    if (!validDelay(delay)) {
      return {
        ok: false,
        reason: `「${zone.name}」的下游延迟需在 ${DOWNSTREAM_DELAY_MIN_MS}–${DOWNSTREAM_DELAY_MAX_MS} ms 之间`
      }
    }
  }
  const source = members.find((zone) => zone.id === draft.sourceId)
  if (!source) return { ok: false, reason: '请选择要采用哪个声区的队列' }
  const queue = adoptableQueue(source)
  if (!queue) return { ok: false, reason: `「${source.name}」的${queueIssue(source.queue)}，不能采用` }
  const issue = nameIssue(draft.name, '组名')
  if (issue) return { ok: false, reason: issue }
  return {
    ok: true,
    payload: {
      revision: draft.revision,
      name: draft.name.trim(),
      source: { zoneId: source.id, queue },
      members: members.map((zone) => ({
        zoneId: zone.id,
        revision: zone.revision,
        downstreamDelayMs: draft.delays[zone.id] ?? 0
      }))
    }
  }
}

// ---------------------------------------------------------------------------
// Zone lifecycle

/** Why a new zone cannot be created; null when it can. */
export function zoneCreateBlockedReason(count: number, limit: number): string | null {
  return count >= limit ? `已达到 ${limit} 个声区的上限，请先移除一个声区` : null
}

/** Why a zone name cannot be used; null when it can. */
export function validateZoneName(name: string, taken: readonly string[] = []): string | null {
  const issue = nameIssue(name, '声区名称')
  if (issue) return issue
  const value = name.trim()
  if (taken.some((existing) => existing.trim() === value)) return '已有同名声区，换一个名字以便区分'
  return null
}

/** Why a zone cannot be removed; null when it can. */
export function zoneRemoveBlockedReason(zone: Pick<ZoneView, 'id' | 'groupId'>): string | null {
  if (isLocalZone(zone)) return '本机声区不能移除'
  if (zone.groupId) return '该声区在同步组中，请先解除编组'
  return null
}

/** Why a zone cannot be pointed at a new output bridge here; null when it can. */
export function zoneConnectBlockedReason(zone: Pick<ZoneView, 'id'>): string | null {
  return isLocalZone(zone) ? '本机声区的输出在「本机输出与输出桥」中设置' : null
}

// ---------------------------------------------------------------------------
// Bridge invitations

export const INVALID_INVITATION = '输出桥邀请无效，请复制完整邀请'

export interface InvitationReading {
  peer: BridgePeer | null
  /** Null for a valid invitation and for an empty field. */
  error: string | null
}

export function readBridgeInvitation(value: string): InvitationReading {
  const text = value.trim()
  if (!text) return { peer: null, error: null }
  try {
    const peer = parseBridgeInvitation(text) as BridgePeer | null
    return peer ? { peer, error: null } : { peer: null, error: INVALID_INVITATION }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.trim() : ''
    return { peer: null, error: message || INVALID_INVITATION }
  }
}

/** "192.168.1.47:47321" — the address only; the token stays out of sight. */
export function peerAddress(peer: Pick<BridgePeer, 'host' | 'port'>): string {
  const host = peer.host.includes(':') ? `[${peer.host}]` : peer.host
  return `${host}:${peer.port}`
}

/** "c47e 19b0 … 5f31" — enough of the certificate fingerprint to compare by eye. */
export function shortFingerprint(fingerprint: string): string {
  const value = fingerprint.trim().toLowerCase()
  if (value.length <= 12) return value
  return `${value.slice(0, 4)} ${value.slice(4, 8)} … ${value.slice(-4)}`
}
