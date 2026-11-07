import assert from 'node:assert/strict'
import test from 'node:test'
import type { BridgeReceiverFacts, BridgeRuntimeState } from '../../../../../shared/audioBridge.ts'
import type { CoreQueueReference } from '../../../../../shared/coreProtocol.ts'
import type { ZoneView } from '../../../../../shared/coreZones.ts'
import {
  DOWNSTREAM_DELAY_MAX_MS,
  GROUP_MAX_MEMBERS,
  INVALID_INVITATION,
  NAME_MAX_LENGTH,
  adoptableQueue,
  buildHandoff,
  clampDelay,
  defaultGroupName,
  formatDelay,
  handoffNeedsReplace,
  handoffResume,
  handoffSourceIssue,
  handoffTargets,
  memberIssue,
  memberReadiness,
  memberReady,
  peerAddress,
  queueIssue,
  queuePosition,
  readBridgeInvitation,
  shortFingerprint,
  validateGroupComposer,
  validateZoneName,
  zoneConnectBlockedReason,
  zoneCreateBlockedReason,
  zoneOutputChip,
  zoneOutputLabel,
  zoneOutputState,
  zoneRemoveBlockedReason,
  zoneThumb,
  zoneTrackLine,
  type GroupComposerDraft
} from './zoneDialogRules.ts'

const STUDY = 'zone-11111111-1111-4111-8111-111111111111'
const LIVING = 'zone-22222222-2222-4222-8222-222222222222'
const KITCHEN = 'zone-33333333-3333-4333-8333-333333333333'
const NAMES: Record<string, string> = { local: '本机', [STUDY]: '书房', [LIVING]: '客厅', [KITCHEN]: '厨房' }

const queue = (patch: Partial<CoreQueueReference> = {}): CoreQueueReference => ({
  id: 'queue-a',
  revision: 7,
  total: 12,
  index: 2,
  occurrenceId: 'occurrence-a',
  canUndo: true,
  ...patch
})

const receiver = (adaptiveSupported: boolean): BridgeReceiverFacts =>
  ({ deviceName: 'DAC', sampleRate: 48000, adaptiveSupported }) as BridgeReceiverFacts

const output = (patch: Partial<BridgeRuntimeState> = {}): BridgeRuntimeState => ({
  supported: true,
  hosting: false,
  receiving: false,
  selected: true,
  connected: true,
  peerName: 'STUDY-PC',
  error: null,
  receiver: receiver(true),
  ...patch
})

function zone(id: string, patch: Partial<ZoneView> = {}): ZoneView {
  return {
    id,
    name: NAMES[id] ?? id,
    groupId: null,
    revision: 4,
    playback: null,
    track: null,
    queue: null,
    output: id === 'local' ? output({ selected: false, connected: false, peerName: null, receiver: null }) : null,
    error: null,
    ...patch
  }
}

const TOKEN = 'a'.repeat(48)
const FINGERPRINT = 'c47e19b05a3d82f6e1c09b7a4d58e3f2071b6ac9d4e5f38a2b19c70d6e4a5f31'
const INVITATION = `twilight-bridge://192.168.1.47:47321?token=${TOKEN}&fp=${FINGERPRINT}`

test('a queue is adoptable only with tracks and a current occurrence', () => {
  assert.equal(queueIssue(null), '队列为空')
  assert.equal(queueIssue(queue({ total: 0, occurrenceId: null })), '队列为空')
  assert.equal(queueIssue(queue({ occurrenceId: null })), '队列没有当前曲目')
  assert.equal(queueIssue(queue()), null)
  assert.equal(adoptableQueue(zone(STUDY)), null)
  assert.equal(adoptableQueue(zone(STUDY, { queue: queue({ occurrenceId: null }) })), null)
  // The fence carries identity only, never position or undo state.
  assert.deepEqual(adoptableQueue(zone(STUDY, { queue: queue() })), {
    id: 'queue-a',
    revision: 7,
    occurrenceId: 'occurrence-a'
  })
})

test('queue summaries stay readable for empty and populated queues', () => {
  assert.equal(queuePosition(null), '队列为空')
  assert.equal(queuePosition(queue()), '第 3 / 12 首')
  assert.equal(zoneTrackLine(zone(STUDY)), '队列为空')
  const track = { id: 't1', title: '晚风', artist: '陈绮贞' } as ZoneView['track']
  assert.equal(zoneTrackLine(zone(STUDY, { track, queue: queue() })), '晚风 — 陈绮贞')
})

test('handoff targets exclude the source and explain grouped zones', () => {
  const zones = [
    zone('local'),
    zone(STUDY, { queue: queue() }),
    zone(LIVING, { groupId: 'group-1' }),
    zone(KITCHEN)
  ]
  const targets = handoffTargets(zones, STUDY)
  assert.deepEqual(
    targets.map((target) => [target.zone.id, target.reason]),
    [
      ['local', null],
      [LIVING, '已加入同步组，请先解除编组'],
      [KITCHEN, null]
    ]
  )
})

test('a handoff source needs its own queue with a current track', () => {
  assert.equal(handoffSourceIssue(undefined), '源声区已不存在，请刷新后重试')
  assert.equal(handoffSourceIssue(zone(STUDY)), '「书房」的队列为空，没有可接力的内容')
  assert.equal(
    handoffSourceIssue(zone(STUDY, { queue: queue({ occurrenceId: null }) })),
    '「书房」的队列没有当前曲目，无法接力'
  )
  assert.equal(
    handoffSourceIssue(zone(STUDY, { queue: queue(), groupId: 'group-1' })),
    '「书房」在同步组中，请先解除编组'
  )
  assert.equal(handoffSourceIssue(zone(STUDY, { queue: queue() })), null)
})

test('replacing asks for confirmation only when the target would lose tracks', () => {
  assert.equal(handoffNeedsReplace(zone(LIVING)), false)
  assert.equal(handoffNeedsReplace(zone(LIVING, { queue: queue({ total: 0, occurrenceId: null }) })), false)
  assert.equal(handoffNeedsReplace(zone(LIVING, { queue: queue() })), true)
})

test('resume is unavailable when the target output cannot sound', () => {
  assert.deepEqual(handoffResume(zone(LIVING, { output: output({ connected: false }) })), {
    available: false,
    reason: '目标输出桥未连接，接力后保持暂停'
  })
  assert.deepEqual(handoffResume(zone(KITCHEN)), {
    available: false,
    reason: '目标声区尚未连接输出桥，接力后保持暂停'
  })
  assert.deepEqual(handoffResume(zone('local')), { available: true, reason: null })
  assert.deepEqual(handoffResume(zone('local', { output: output({ connected: false }) })), {
    available: false,
    reason: '目标输出桥未连接，接力后保持暂停'
  })
  assert.deepEqual(handoffResume(zone(LIVING, { output: output() })), { available: true, reason: null })
})

test('a handoff payload is fenced by both zones and requires an explicit replace', () => {
  const source = zone(STUDY, { revision: 9, queue: queue() })
  const target = zone(LIVING, {
    revision: 3,
    output: output(),
    queue: queue({ id: 'queue-b', revision: 2, total: 4, occurrenceId: 'occurrence-b' })
  })
  assert.deepEqual(buildHandoff(source, target, { replace: false, resume: true }), {
    ok: false,
    reason: '请先确认替换「客厅」当前的队列'
  })
  assert.deepEqual(buildHandoff(source, target, { replace: true, resume: true }), {
    ok: true,
    payload: {
      source: {
        zoneId: STUDY,
        revision: 9,
        queue: { id: 'queue-a', revision: 7, occurrenceId: 'occurrence-a' }
      },
      target: {
        zoneId: LIVING,
        revision: 3,
        queue: { id: 'queue-b', revision: 2, occurrenceId: 'occurrence-b' }
      },
      replace: true,
      resume: true
    }
  })
})

test('a handoff never asks Core for an impossible replace or resume', () => {
  const source = zone(STUDY, { queue: queue() })
  const empty = buildHandoff(source, zone(KITCHEN), { replace: true, resume: true })
  assert.equal(empty.ok, true)
  if (empty.ok) {
    assert.equal(empty.payload.replace, false)
    assert.equal(empty.payload.resume, false, 'a never-connected bridge zone cannot resume')
    assert.equal(empty.payload.target.queue, null)
  }
  const cleared = buildHandoff(
    source,
    zone('local', { queue: queue({ id: 'queue-l', total: 0, occurrenceId: null }) }),
    { replace: false, resume: true }
  )
  assert.equal(cleared.ok, true)
  if (cleared.ok) {
    assert.equal(cleared.payload.replace, true, 'an empty queue object is replaced without asking')
    assert.equal(cleared.payload.resume, true)
    assert.deepEqual(cleared.payload.target.queue, { id: 'queue-l', revision: 7, occurrenceId: null })
  }
})

test('a handoff refuses grouped, missing and identical endpoints', () => {
  const source = zone(STUDY, { queue: queue() })
  assert.deepEqual(buildHandoff(source, null, { replace: false, resume: false }), {
    ok: false,
    reason: '请选择接力的目标声区'
  })
  assert.deepEqual(buildHandoff(source, source, { replace: true, resume: false }), {
    ok: false,
    reason: '请选择另一个声区作为目标'
  })
  assert.deepEqual(
    buildHandoff(source, zone(LIVING, { groupId: 'group-1' }), { replace: true, resume: false }),
    { ok: false, reason: '「客厅」已加入同步组，请先解除编组' }
  )
  assert.deepEqual(buildHandoff(zone(STUDY), zone(LIVING), { replace: true, resume: false }), {
    ok: false,
    reason: '「书房」的队列为空，没有可接力的内容'
  })
})

test('member readiness needs a connected adaptive-clock bridge', () => {
  const ready = zone(STUDY, { output: output() })
  const fixed = zone(LIVING, { output: output({ receiver: receiver(false) }) })
  const offline = zone(KITCHEN, { output: output({ connected: false }) })
  assert.equal(memberReady(ready), true)
  assert.equal(memberReady(fixed), false)
  assert.equal(memberReady(offline), false)
  assert.equal(memberReady(zone('local')), false)
  assert.deepEqual(memberReadiness(ready), { ready: true, label: '可同步' })
  assert.deepEqual(memberReadiness(fixed), { ready: false, label: '不支持时钟自适应' })
  assert.deepEqual(memberReadiness(offline), { ready: false, label: '输出桥离线' })
  assert.deepEqual(memberReadiness(zone(KITCHEN)), { ready: false, label: '未配对输出桥' })
  assert.deepEqual(memberReadiness(zone('local')), { ready: false, label: '需要输出桥' })
  assert.equal(memberIssue(zone(STUDY, { groupId: 'group-1' })), '已在同步组中')
  assert.equal(memberIssue(ready), null)
})

function draft(patch: Partial<GroupComposerDraft> = {}): GroupComposerDraft {
  return {
    zones: [
      zone('local', { revision: 11 }),
      zone(STUDY, { revision: 5, queue: queue() }),
      zone(LIVING, { revision: 6 }),
      zone(KITCHEN, { revision: 2, groupId: 'group-1' })
    ],
    revision: 21,
    name: '  书房 + 客厅  ',
    memberIds: [LIVING, STUDY],
    sourceId: STUDY,
    delays: { [STUDY]: 12 },
    ...patch
  }
}

test('the composer builds a fenced group in zone list order', () => {
  assert.deepEqual(validateGroupComposer(draft()), {
    ok: true,
    payload: {
      revision: 21,
      name: '书房 + 客厅',
      source: { zoneId: STUDY, queue: { id: 'queue-a', revision: 7, occurrenceId: 'occurrence-a' } },
      members: [
        { zoneId: STUDY, revision: 5, downstreamDelayMs: 12 },
        { zoneId: LIVING, revision: 6, downstreamDelayMs: 0 }
      ]
    }
  })
})

test('the composer enforces member count, eligibility and uniqueness', () => {
  const reason = (patch: Partial<GroupComposerDraft>): string | null => {
    const result = validateGroupComposer(draft(patch))
    return result.ok ? null : result.reason
  }
  assert.equal(reason({ memberIds: [STUDY] }), '至少选择 2 个声区')
  assert.equal(reason({ memberIds: [STUDY, STUDY] }), '同一个声区只能选择一次')
  assert.equal(reason({ memberIds: [STUDY, KITCHEN] }), '「厨房」已在同步组中')
  assert.equal(reason({ memberIds: [STUDY, 'zone-gone'] }), '所选声区已不存在，请刷新后重试')
  const crowd = ['local', STUDY, LIVING, KITCHEN, 'zone-extra']
  assert.equal(reason({ memberIds: crowd }), `最多选择 ${GROUP_MAX_MEMBERS} 个声区`)
})

test('the composer keeps every downstream delay inside 0–250 ms', () => {
  for (const delay of [-1, 251, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = validateGroupComposer(draft({ delays: { [LIVING]: delay } }))
    assert.deepEqual(result, { ok: false, reason: '「客厅」的下游延迟需在 0–250 ms 之间' }, `delay ${delay}`)
  }
  const edge = validateGroupComposer(draft({ delays: { [STUDY]: 0, [LIVING]: DOWNSTREAM_DELAY_MAX_MS } }))
  assert.equal(edge.ok, true)
})

test('the composer adopts a member queue that has a current track', () => {
  const reason = (patch: Partial<GroupComposerDraft>): string | null => {
    const result = validateGroupComposer(draft(patch))
    return result.ok ? null : result.reason
  }
  assert.equal(reason({ sourceId: null }), '请选择要采用哪个声区的队列')
  assert.equal(reason({ sourceId: 'local' }), '请选择要采用哪个声区的队列')
  assert.equal(reason({ sourceId: LIVING }), '「客厅」的队列为空，不能采用')
  const zones = draft().zones.map((item) =>
    item.id === STUDY ? { ...item, queue: queue({ occurrenceId: null }) } : item
  )
  assert.equal(reason({ zones }), '「书房」的队列没有当前曲目，不能采用')
})

test('the composer requires a short, non-blank group name', () => {
  assert.deepEqual(validateGroupComposer(draft({ name: '   ' })), { ok: false, reason: '请输入组名' })
  assert.deepEqual(validateGroupComposer(draft({ name: '组'.repeat(NAME_MAX_LENGTH + 1) })), {
    ok: false,
    reason: `组名最多 ${NAME_MAX_LENGTH} 个字符`
  })
  assert.equal(validateGroupComposer(draft({ name: '组'.repeat(NAME_MAX_LENGTH) })).ok, true)
})

test('default group names join members and stay within the name limit', () => {
  assert.equal(defaultGroupName(['书房', ' 客厅 ']), '书房 + 客厅')
  assert.equal(defaultGroupName(['书房', '  ', '厨房']), '书房 + 厨房')
  assert.equal(defaultGroupName([]), '')
  const long = defaultGroupName(['声'.repeat(60), '区'.repeat(60)])
  assert.equal(long.length, NAME_MAX_LENGTH)
  assert.ok(long.endsWith('…'))
  // Never split a surrogate pair when truncating.
  const emoji = defaultGroupName(['a'.repeat(78) + '🎵🎵'])
  assert.ok(emoji.length <= NAME_MAX_LENGTH)
  assert.equal(emoji, `${'a'.repeat(78)}…`)
})

test('delays clamp to whole milliseconds and 0 reads as uncalibrated', () => {
  assert.equal(clampDelay(-4), 0)
  assert.equal(clampDelay(12.6), 13)
  assert.equal(clampDelay(900), 250)
  assert.equal(clampDelay(Number.NaN), 0)
  assert.equal(formatDelay(0), '未校准')
  assert.equal(formatDelay(18), '18 ms')
})

test('zone creation respects the limit and needs a distinct name', () => {
  assert.equal(zoneCreateBlockedReason(3, 4), null)
  assert.equal(zoneCreateBlockedReason(4, 4), '已达到 4 个声区的上限，请先移除一个声区')
  assert.equal(validateZoneName('  '), '请输入声区名称')
  assert.equal(validateZoneName('名'.repeat(NAME_MAX_LENGTH + 1)), `声区名称最多 ${NAME_MAX_LENGTH} 个字符`)
  assert.equal(validateZoneName('书房', ['本机', '书房']), '已有同名声区，换一个名字以便区分')
  assert.equal(validateZoneName(' 阳台 ', ['本机', '书房']), null)
})

test('only bridge zones outside a group can be removed or connected here', () => {
  assert.equal(zoneRemoveBlockedReason(zone('local')), '本机声区不能移除')
  assert.equal(zoneRemoveBlockedReason(zone(STUDY, { groupId: 'group-1' })), '该声区在同步组中，请先解除编组')
  assert.equal(zoneRemoveBlockedReason(zone(STUDY)), null)
  assert.equal(zoneConnectBlockedReason(zone('local')), '本机声区的输出在「本机输出与输出桥」中设置')
  assert.equal(zoneConnectBlockedReason(zone(STUDY, { groupId: 'group-1' })), null)
})

test('output state is honest about silent bridge zones', () => {
  assert.equal(zoneOutputState(zone('local')), 'local')
  assert.equal(zoneOutputLabel(zone('local')), '本机输出')
  assert.equal(zoneOutputState(zone(STUDY, { output: output() })), 'connected')
  assert.equal(zoneOutputLabel(zone(STUDY, { output: output() })), '输出桥 · STUDY-PC')
  assert.equal(zoneOutputState(zone(STUDY, { output: output({ connected: false }) })), 'offline')
  assert.deepEqual(zoneOutputChip(zone(STUDY, { output: output({ connected: false }) })), {
    label: '离线',
    tone: 'danger'
  })
  assert.equal(zoneOutputState(zone(KITCHEN)), 'unpaired')
  assert.equal(zoneOutputLabel(zone(KITCHEN)), '未配对输出桥')
  // "未配对输出桥" already says it; only an offline bridge needs a chip.
  assert.equal(zoneOutputChip(zone(KITCHEN)), null)
  assert.equal(zoneOutputChip(zone(STUDY, { output: output() })), null)
  assert.equal(zoneOutputLabel(zone('local', { output: output({ peerName: 'HALL-PC' }) })), '输出桥 · HALL-PC')
  assert.equal(zoneOutputLabel(zone('local', { output: output({ peerName: null }) })), '输出桥 · 未命名设备')
})

test('thumbnails light up only where the output can sound', () => {
  const track = { id: 'track-1', title: '晚风', artist: '陈绮贞' } as ZoneView['track']
  assert.deepEqual(zoneThumb(zone('local', { track })), { trackId: 'track-1', glyph: 'ph-music-notes-simple' })
  assert.deepEqual(zoneThumb(zone(STUDY, { track, output: output() })), {
    trackId: 'track-1',
    glyph: 'ph-music-notes-simple'
  })
  assert.deepEqual(zoneThumb(zone(STUDY, { track, output: output({ connected: false }) })), {
    trackId: null,
    glyph: 'ph-plugs'
  })
  assert.deepEqual(zoneThumb(zone(KITCHEN, { track })), { trackId: null, glyph: 'ph-link-simple-break' })
  assert.deepEqual(zoneThumb(zone(STUDY, { output: output() })), {
    trackId: null,
    glyph: 'ph-music-notes-simple'
  })
})

test('bridge invitations are parsed without exposing the token', () => {
  assert.deepEqual(readBridgeInvitation('   '), { peer: null, error: null })
  const valid = readBridgeInvitation(`  ${INVITATION}\n`)
  assert.deepEqual(valid, {
    peer: { host: '192.168.1.47', port: 47321, token: TOKEN, fingerprint: FINGERPRINT },
    error: null
  })
  assert.deepEqual(readBridgeInvitation('not a link'), { peer: null, error: INVALID_INVITATION })
  const wrong = readBridgeInvitation(`https://192.168.1.47:47321?token=${TOKEN}&fp=${FINGERPRINT}`)
  assert.equal(wrong.peer, null)
  assert.equal(wrong.error, '输出桥邀请无效')
  const short = readBridgeInvitation('twilight-bridge://192.168.1.47:47321?token=abc&fp=def')
  assert.equal(short.peer, null)
  assert.ok(short.error)
  assert.equal(peerAddress({ host: '192.168.1.47', port: 47321 }), '192.168.1.47:47321')
  assert.equal(peerAddress({ host: 'fe80::1', port: 9 }), '[fe80::1]:9')
  assert.equal(shortFingerprint(FINGERPRINT), 'c47e 19b0 … 5f31')
})
