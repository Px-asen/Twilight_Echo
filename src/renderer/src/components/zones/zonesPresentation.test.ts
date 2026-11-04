import assert from 'node:assert/strict'
import test from 'node:test'
import type { BridgeReceiverFacts, BridgeRuntimeState } from '../../../../shared/audioBridge.ts'
import type { SyncGroupView } from '../../../../shared/coreSyncGroups.ts'
import type { ZoneView } from '../../../../shared/coreZones.ts'
import type { CoreSignalPath } from '../../../../shared/remoteDsp.ts'
import {
  GROUP_STEPS,
  groupReady,
  groupSkew,
  groupStepIndex,
  memberLight,
  memberReadiness,
  signalPathFocus,
  signalPathStages,
  signalPathVerdict,
  volumeIcon,
  wallItems,
  zoneFormatLine,
  zoneLight,
  zoneOutputLabel,
  zoneStatus
} from './zonesPresentation.ts'

const A = 'zone-11111111-1111-4111-8111-111111111111'
const B = 'zone-22222222-2222-4222-8222-222222222222'
const C = 'zone-33333333-3333-4333-8333-333333333333'
const GROUP = 'group-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const receiver = (extra: Partial<BridgeReceiverFacts> = {}): BridgeReceiverFacts =>
  ({
    sampleRate: 48000,
    channels: 2,
    bufferedFrames: 3840,
    capacityFrames: 12000,
    prebufferFrames: 1920,
    consumedFrames: 96000,
    underruns: 0,
    started: true,
    failed: false,
    backend: 'wasapi',
    deviceName: 'Topping E30',
    actualSampleRate: 48000,
    actualBitDepth: 24,
    actualChannels: 2,
    actualOutputFormat: 'int24-in32',
    exclusive: true,
    adaptiveSupported: true,
    ...extra
  }) as BridgeReceiverFacts

const output = (extra: Partial<BridgeRuntimeState> = {}): BridgeRuntimeState =>
  ({
    supported: true,
    hosting: false,
    receiving: false,
    selected: true,
    connected: true,
    peerName: '客厅音箱',
    error: null,
    receiver: receiver(),
    ...extra
  }) as BridgeRuntimeState

const track = { id: 'track-1', title: '夜航', artist: '沈默', album: '远方的灯塔', format: 'flac', sampleRate: 96000, bitDepth: 24 }
const queue = { id: 'queue-1', revision: 1, total: 12, index: 0, occurrenceId: 'entry-1' }

function zone(id: string, extra: Partial<ZoneView> = {}): ZoneView {
  return {
    id,
    name: id === 'local' ? '此电脑主会话' : id.slice(5, 9),
    revision: 1,
    groupId: null,
    track,
    queue,
    playback: { state: 'paused', position: 0, duration: 240, volume: 0.5 },
    output: id === 'local' ? output({ selected: false, connected: false, peerName: null, receiver: null }) : output(),
    error: null,
    ...extra
  } as ZoneView
}

function group(extra: Partial<SyncGroupView> = {}): SyncGroupView {
  return {
    id: GROUP,
    name: '客厅 + 书房',
    revision: 1,
    members: [
      { zoneId: A, downstreamDelayMs: 12 },
      { zoneId: B, downstreamDelayMs: 0 }
    ],
    track,
    queue,
    playback: { state: 'playing', position: 10, duration: 240, volume: 0.6 },
    coordination: null,
    error: null,
    ...extra
  } as SyncGroupView
}

test('a zone window is lit by its music and switched off only by its own output', () => {
  assert.equal(zoneLight(zone('local')), 'paused')
  assert.equal(zoneLight(zone('local', { playback: { state: 'playing' } as ZoneView['playback'] })), 'playing')
  assert.equal(zoneLight(zone(A, { queue: null })), 'empty')
  // A bridge zone never falls back to local speakers.
  assert.equal(zoneLight(zone(A, { output: output({ connected: false }) })), 'offline')
  assert.equal(zoneLight(zone(A, { output: output({ connected: false, peerName: null }) })), 'unpaired')
  // The main session is only dark when it chose a bridge that dropped.
  assert.equal(zoneLight(zone('local', { output: output({ connected: false, peerName: '工作室' }) })), 'offline')
})

test('status chip, output line and cover never repeat the same words', () => {
  assert.deepEqual(zoneStatus(zone(A, { output: output({ connected: false }) })), { label: '输出桥离线', tone: 'danger' })
  assert.deepEqual(zoneStatus(zone(A, { output: output({ connected: false, peerName: null }) })), { label: '待配对', tone: 'neutral' })
  assert.deepEqual(zoneStatus(zone(A, { error: 'boom' })), { label: '需要处理', tone: 'danger' })
  assert.equal(zoneOutputLabel(zone(A)), '客厅音箱 · Topping E30')
  assert.equal(zoneOutputLabel(zone(A, { output: output({ connected: false }) })), '客厅音箱')
  assert.equal(zoneOutputLabel(zone(A, { output: output({ connected: false, peerName: null }) })), '未配对输出桥')
  assert.equal(zoneOutputLabel(zone('local')), '本机输出')
})

test('the format line reports only what Core and the receiver reported', () => {
  assert.equal(zoneFormatLine(zone(A)), 'FLAC · 96 kHz / 24 bit → WASAPI 独占 · 48 kHz / 24 bit')
  assert.equal(
    zoneFormatLine(
      zone('local', {
        playback: {
          state: 'playing',
          codec: 'flac',
          sourceSampleRate: 44100,
          sourceBitDepth: 16,
          outputBackend: 'wasapi-shared',
          actualSampleRate: 48000,
          actualBitDepth: 0
        } as ZoneView['playback']
      })
    ),
    'FLAC · 44.1 kHz / 16 bit → WASAPI 共享 · 48 kHz'
  )
})

test('the wall puts a sync group where its first member stood', () => {
  const zones = [zone('local'), zone(A, { groupId: GROUP }), zone(C), zone(B, { groupId: GROUP })]
  const items = wallItems(zones, [group()])
  assert.deepEqual(
    items.map((item) => item.key),
    ['local', GROUP, C]
  )
  const framed = items[1]
  assert.equal(framed.kind, 'group')
  assert.deepEqual(
    framed.kind === 'group' ? framed.members.map((member) => member.id) : [],
    [A, B]
  )
  // A group Core no longer lists leaves its zones as plain windows.
  assert.deepEqual(
    wallItems(zones, []).map((item) => item.key),
    ['local', A, C, B]
  )
})

test('members share the group music but keep their own output state', () => {
  const offline = zone(B, { groupId: GROUP, output: output({ connected: false, peerName: '书房音箱' }) })
  assert.equal(memberLight(zone(A, { groupId: GROUP, queue: null }), group()), 'playing')
  assert.equal(memberLight(offline, group()), 'offline')
  assert.equal(memberLight(zone(A), group({ queue: null })), 'empty')
})

test('member readiness explains why synchronized playback is unavailable', () => {
  assert.deepEqual(memberReadiness(undefined), { ready: false, label: '声区已移除', tone: 'danger' })
  assert.deepEqual(memberReadiness(zone(A)), { ready: true, label: '可同步', tone: 'success' })
  assert.equal(memberReadiness(zone(A, { output: output({ connected: false }) })).label, '输出桥离线')
  assert.equal(memberReadiness(zone(A, { output: output({ connected: false, peerName: null }) })).label, '未配对输出桥')
  assert.equal(memberReadiness(zone('local')).label, '需要输出桥')
  assert.equal(
    memberReadiness(zone(A, { output: output({ receiver: receiver({ adaptiveSupported: false }) }) })).label,
    '不支持时钟自适应'
  )
  const zones = [zone(A), zone(B)]
  assert.equal(groupReady(group(), zones), true)
  assert.equal(groupReady(group(), [zone(A), zone(B, { output: output({ connected: false }) })]), false)
  assert.equal(groupReady(group(), [zone(A)]), false)
})

test('skew is a spread: drift starts only when its lower bound leaves the 1 ms tolerance', () => {
  const coordination = (estimatedSkewMs: number | null, observationRangeMs: number | null) =>
    group({
      coordination: {
        phase: 'playing',
        error: null,
        epoch: 1,
        audibleAtCoreMs: 0,
        estimatedSkewMs,
        observationRangeMs,
        members: []
      }
    })
  assert.deepEqual(groupSkew(coordination(null, null)), {
    measured: false,
    skewMs: 0,
    rangeMs: 0,
    aligned: true,
    label: '正在测量',
    scaleMs: 2
  })
  const good = groupSkew(coordination(0.42, 0.3))
  assert.equal(good.aligned, true)
  assert.equal(good.label, '对齐良好')
  assert.equal(good.scaleMs, 2)
  // 1.6 ms spread with 0.8 ms uncertainty still may be within tolerance.
  assert.equal(groupSkew(coordination(1.6, 0.8)).aligned, true)
  const drifting = groupSkew(coordination(2.4, 0.3))
  assert.equal(drifting.aligned, false)
  assert.equal(drifting.label, '超出 1 ms 容差')
  assert.ok(drifting.scaleMs >= 2.7, 'the axis grows to keep the band on the meter')
  assert.equal(groupSkew(group({ playback: null, coordination: null })).label, '播放后测量')
})

test('the stepper rests on 待命 and re-enters preparation while rebuffering', () => {
  assert.deepEqual(
    GROUP_STEPS.map((step) => step.label),
    ['待命', '预缓冲', '调度起播', '同步播放']
  )
  assert.equal(groupStepIndex('paused'), 0)
  assert.equal(groupStepIndex('armed'), 2)
  assert.equal(groupStepIndex('playing'), 3)
  assert.equal(groupStepIndex('rebuffering'), 1)
  assert.equal(groupStepIndex('failed'), 0)
})

const path = (extra: Partial<CoreSignalPath> = {}): CoreSignalPath =>
  ({
    zoneId: A,
    source: { sampleRate: 96000, bitDepth: 24, channels: 2, codec: 'flac' },
    decoded: { sampleRate: 96000, bitDepth: 32, channels: 2, format: 'f32' },
    dsp: {
      revision: 1,
      requestedRevision: 1,
      appliedRevision: 1,
      applyState: 'applied',
      activeSceneId: null,
      compileState: 'ready',
      totalLatencyFrames: 0,
      latencySampleRate: 96000,
      totalTailFrames: 0,
      nodes: [],
      outputStage: { actualSampleRate: 48000, effectiveResampler: 'SoX VHQ', resampled: true, headroomGainDb: 0, active: true }
    },
    transport: { kind: 'tls-pcm', sampleRate: 48000, channels: 2, format: 'float32-le', connected: true },
    receiver: receiver(),
    timing: null,
    output: { backend: 'wasapi', sampleRate: 48000, bitDepth: 24, channels: 2, deviceName: 'Topping E30' },
    hardware: null,
    ...extra
  }) as CoreSignalPath

test('a bridge signal path reads computer → network → bridge, naming the peer', () => {
  const stages = signalPathStages(path(), { peerName: '客厅音箱' })
  assert.deepEqual(
    stages.map((stage) => [stage.label, stage.nodes.map((node) => node.id)]),
    [
      ['此电脑', ['source', 'decode', 'dsp', 'src']],
      ['网络传输', ['transport']],
      ['客厅音箱 · 输出桥', ['buffer', 'device']]
    ]
  )
  const nodes = stages.flatMap((stage) => stage.nodes)
  assert.equal(nodes.find((node) => node.id === 'source')?.value, 'FLAC · 96 kHz / 24 bit')
  assert.equal(nodes.find((node) => node.id === 'src')?.value, '转换至 48 kHz')
  assert.equal(nodes.find((node) => node.id === 'device')?.value, 'Topping E30 · 48 kHz / 24 bit')
  // The first node that changes the sound is the one worth reading first.
  assert.equal(signalPathFocus(stages), 'src')
  assert.deepEqual(signalPathVerdict(stages), { label: '已转换', tone: 'info' })
})

test('a local path ends at the device; a dropped bridge is a fault, not a fallback', () => {
  const local = signalPathStages(
    path({
      transport: { kind: 'local', sampleRate: 96000, channels: 2, format: '', connected: true },
      receiver: null,
      dsp: { ...path().dsp, outputStage: null },
      output: { backend: 'wasapi-exclusive', sampleRate: 96000, bitDepth: 24, channels: 2, deviceName: null }
    })
  )
  assert.deepEqual(
    local.map((stage) => stage.id),
    ['core']
  )
  assert.equal(local[0].nodes.at(-1)?.value, 'WASAPI 独占 · 96 kHz / 24 bit')
  assert.deepEqual(signalPathVerdict(local), { label: '原样输出', tone: 'success' })

  const dropped = signalPathStages(
    path({ transport: { kind: 'tls-pcm', sampleRate: 48000, channels: 2, format: 'float32-le', connected: false }, receiver: null })
  )
  const transport = dropped.flatMap((stage) => stage.nodes).find((node) => node.id === 'transport')
  assert.equal(transport?.value, '未连接')
  assert.equal(signalPathFocus(dropped), 'transport')
  assert.deepEqual(signalPathVerdict(dropped), { label: '链路中断', tone: 'danger' })
})

test('volume icon follows the level', () => {
  assert.equal(volumeIcon(0), 'ph-speaker-simple-x')
  assert.equal(volumeIcon(0.3), 'ph-speaker-simple-low')
  assert.equal(volumeIcon(0.8), 'ph-speaker-simple-high')
})
