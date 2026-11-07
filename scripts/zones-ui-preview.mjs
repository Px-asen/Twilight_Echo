// Isolated UI fixture for the 声区 page: the real Vue page against a simulated
// Core. No native audio, devices or network IO.
// Run `node scripts/zones-ui-preview.mjs`, then open the printed loopback URL.
// Query: ?theme=dark|pureWhite  ?scene=live|setup|offline
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const port = Number(process.env.ZONES_PREVIEW_PORT || 5188)

const fixture = String.raw`
import { createApp, h, shallowRef } from 'vue'
import '/src/renderer/src/assets/main.css'
import '/src/renderer/src/assets/icon-fonts.ts'
import ZonesPage from '/src/renderer/src/components/zones/ZonesPage.vue'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'pureWhite'
if (params.get('motion')) document.documentElement.dataset.teMotion = params.get('motion')
const scene = params.get('scene') || 'live'

// -- Fixture artwork: flat geometric sleeves drawn on a canvas -------------------------
function sleeve(kind) {
  const c = document.createElement('canvas'); c.width = c.height = 600
  const g = c.getContext('2d')
  const rect = (x, y, w, h, color) => { g.fillStyle = color; g.fillRect(x, y, w, h) }
  const circle = (x, y, r, color) => { g.fillStyle = color; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill() }
  if (kind === 'lighthouse') {
    rect(0, 0, 600, 600, '#1f4e5a'); circle(410, 230, 120, '#f2a65a')
    rect(0, 380, 600, 220, '#173c45')
    for (let i = 0; i < 6; i++) rect(0, 400 + i * 32, 600, 6, '#e9dcc4')
    rect(120, 170, 46, 210, '#e9dcc4'); rect(112, 150, 62, 26, '#d1495b')
  } else if (kind === 'rooms') {
    rect(0, 0, 600, 600, '#e7b53c')
    for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) rect(90 + col * 150, 90 + r * 150, 110, 110, (r + col) % 3 === 1 ? '#fbf3dc' : '#22324a')
  } else if (kind === 'tide') {
    rect(0, 0, 600, 600, '#efe8dc')
    for (let i = 0; i < 9; i++) {
      g.strokeStyle = i % 2 ? '#3a7ca5' : '#2f6690'; g.lineWidth = 18; g.beginPath()
      for (let x = -20; x <= 620; x += 10) g.lineTo(x, 120 + i * 46 + Math.sin(x / 60 + i) * 16)
      g.stroke()
    }
    circle(450, 110, 52, '#d1495b')
  } else {
    rect(0, 0, 600, 600, '#b5523b')
    g.fillStyle = '#f3e9d2'; g.beginPath(); g.moveTo(0, 600); g.lineTo(600, 120); g.lineTo(600, 260); g.lineTo(160, 600); g.fill()
    circle(180, 180, 70, '#1d1d1d'); rect(380, 440, 140, 18, '#1d1d1d')
  }
  return c.toDataURL('image/png')
}
const ART = { 'track-lighthouse': 'lighthouse', 'track-rooms': 'rooms', 'track-tide': 'tide', 'track-highway': 'highway',
  'track-rooms-2': 'rooms', 'track-tide-2': 'tide', 'track-lighthouse-2': 'lighthouse', 'track-highway-2': 'highway' }
const artCache = new Map()
const artwork = (id) => { const kind = ART[id]; if (!kind) return null; if (!artCache.has(kind)) artCache.set(kind, sleeve(kind)); return artCache.get(kind) }

// -- Simulated Core ---------------------------------------------------------------------
const uuid = (n) => 'zone-' + String(n).repeat(8) + '-' + String(n).repeat(4) + '-4' + String(n).repeat(3) + '-8' + String(n).repeat(3) + '-' + String(n).repeat(12)
const IDS = { a: uuid(1), b: uuid(2), c: uuid(3) }
const GROUP = 'group-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const tracks = {
  lighthouse: { id: 'track-lighthouse', title: '夜航', artist: '沈默', album: '远方的灯塔', duration: 263, format: 'flac', sampleRate: 44100, bitDepth: 16 },
  rooms: { id: 'track-rooms', title: 'Blue Hour', artist: 'The Lamplighters', album: 'Small Rooms', duration: 241, format: 'flac', sampleRate: 96000, bitDepth: 24 },
  tide: { id: 'track-tide', title: '潮汐与月', artist: '林晚', album: '潮汐', duration: 318, format: 'alac', sampleRate: 48000, bitDepth: 24 },
  highway: { id: 'track-highway', title: 'Morning Drive', artist: 'Copper Lane', album: 'Highway Notes', duration: 205, format: 'mp3', sampleRate: 44100, bitDepth: 0 }
}
const upcoming = [
  { id: 'track-rooms-2', title: 'Paper Lanterns', artist: 'The Lamplighters', album: 'Small Rooms', duration: 198 },
  { id: 'track-tide-2', title: '退潮', artist: '林晚', album: '潮汐', duration: 276 },
  { id: 'track-lighthouse-2', title: '雾中的岸', artist: '沈默', album: '远方的灯塔', duration: 301 },
  { id: 'track-highway-2', title: 'Service Road', artist: 'Copper Lane', album: 'Highway Notes', duration: 222 },
  { id: 'track-x-5', title: '晚安，城市', artist: '沈默', album: '远方的灯塔', duration: 245 },
  { id: 'track-x-6', title: 'Last Ferry', artist: 'The Lamplighters', album: 'Small Rooms', duration: 233 }
]
const receiver = (device, extra = {}) => ({ sampleRate: 48000, channels: 2, bufferedFrames: 3840, capacityFrames: 12000, prebufferFrames: 1920,
  consumedFrames: 9_412_800, underruns: 0, started: true, failed: false, backend: 'wasapi', deviceName: device,
  actualSampleRate: 48000, actualBitDepth: 24, actualChannels: 2, actualOutputFormat: 'int24-in32', exclusive: true,
  adaptiveSupported: true, adaptive: { requestedPpm: 12.6, effectivePpm: 12.4, inputFrames: 9_400_000, pendingInputFrames: 120,
  resamplerDelayFrames: 134, sourceConsumedFrames: 9_412_000, inputCreditFrames: 8000 }, timedStart: { state: 'running', presentedMediaFrames: 9_398_211.5 }, ...extra })
const timing = () => ({ network: { state: 'ready', samples: 64, offsetMs: 3.1, roundTripMs: 2.4, uncertaintyMs: 0.6 },
  output: { state: 'ready', source: 'wasapi-audio-clock', streamGeneration: 1, epoch: 1, sampleRate: 48000, positionFrames: 9_398_000,
  sampledAtCoreMs: 10000, ageMs: 14, callbackRequestedFrames: 9_400_000, driftPpm: 12.5, windowMs: 60000, samples: 241, residualFrames: 0.2 } })
const output = (peerName, connected, device) => ({ supported: true, hosting: false, receiving: false, selected: true, connected,
  peerName, error: connected ? null : '输出桥连接已关闭；未切换到本机输出', receiver: connected ? receiver(device) : null, timing: connected ? timing() : null })
const playback = (state, position, duration, volume, extra = {}) => ({ state, position, duration, volume, playbackRate: 1,
  codec: '', sourceSampleRate: 0, sourceBitDepth: 0, outputBackend: '', actualSampleRate: 0, actualBitDepth: 0, upcomingTrack: null, ...extra })
const queue = (id, index, total) => ({ id, revision: 1, total, index, occurrenceId: id + '-entry-' + index })

let topology = 3
const zones = []
const groups = []
let localOutput = { selectedOutputId: 'local', connected: false, hosting: false, revision: 4 }
function localBridgeState() {
  const bridge = localOutput.selectedOutputId === 'bridge'
  return { supported: true, hosting: localOutput.hosting, receiving: false, selected: bridge, connected: bridge && localOutput.connected,
    peerName: bridge ? '工作室电脑' : null, error: null, receiver: bridge && localOutput.connected ? receiver('RME ADI-2') : null, timing: null }
}
function build() {
  zones.length = 0; groups.length = 0
  zones.push({ id: 'local', name: '此电脑主会话', revision: 7, track: tracks.lighthouse, queue: queue('q-local', 3, 42),
    playback: playback('playing', 74, 263, 0.62, { codec: 'flac', sourceSampleRate: 44100, sourceBitDepth: 16, outputBackend: 'wasapi-exclusive', actualSampleRate: 44100, actualBitDepth: 24 }),
    output: localBridgeState(), error: null, groupId: null })
  if (scene === 'setup') {
    zones.push({ id: IDS.a, name: '客厅', revision: 1, track: null, queue: null, playback: playback('stopped', 0, 0, 0.5), output: output('客厅音箱', true, 'Topping E30'), error: null, groupId: null })
    return
  }
  zones.push({ id: IDS.a, name: '客厅', revision: 12, track: tracks.rooms, queue: queue('q-a', 0, 18), playback: playback('paused', 0, 241, 0.5),
    output: output('客厅音箱', true, 'Topping E30'), error: null, groupId: scene === 'offline' ? null : GROUP })
  zones.push({ id: IDS.b, name: '书房', revision: 9, track: tracks.tide, queue: queue('q-b', 2, 11), playback: playback(scene === 'offline' ? 'playing' : 'paused', 141, 318, 0.44,
    { codec: 'alac', sourceSampleRate: 48000, sourceBitDepth: 24 }), output: output('书房音箱', true, 'FiiO K7'), error: null, groupId: scene === 'offline' ? null : GROUP })
  zones.push({ id: IDS.c, name: '卧室', revision: 4, track: tracks.highway, queue: queue('q-c', 5, 20), playback: playback('paused', 88, 205, 0.35),
    output: output('卧室音箱', false, ''), error: null, groupId: null })
  if (scene !== 'offline') groups.push({ id: GROUP, name: '客厅 + 书房', revision: 21, autoMixMode: 'off', autoMixAvailable: true,
    members: [{ zoneId: IDS.a, downstreamDelayMs: 12 }, { zoneId: IDS.b, downstreamDelayMs: 0 }],
    track: tracks.rooms, queue: queue('q-group', 1, 24),
    playback: playback('playing', 96, 241, 0.7, { codec: 'flac', sourceSampleRate: 96000, sourceBitDepth: 24 }),
    coordination: { phase: 'playing', error: null, epoch: 3, audibleAtCoreMs: 1000, estimatedSkewMs: 0.42, observationRangeMs: 0.3,
      members: [{ id: IDS.a, dspDelayMs: 0, downstreamDelayMs: 12, startAtCoreMs: 1000 }, { id: IDS.b, dspDelayMs: 1.3, downstreamDelayMs: 0, startAtCoreMs: 1000 }] },
    error: null })
}
build()
const startedAt = performance.now()
const advance = (p) => p && p.state === 'playing' ? { ...p, position: Math.min(p.duration, p.position + (performance.now() - startedAt) / 1000) } : p
const zoneById = (id) => zones.find((z) => z.id === id)
const groupById = (id) => groups.find((g) => g.id === id)

const dspStates = new Map()
function dspState(zoneId) {
  if (!dspStates.has(zoneId)) dspStates.set(zoneId, { revision: 1,
    processing: { dspEnabled: zoneId !== IDS.a, directMode: false, eqEnabled: zoneId === 'local', eqMode: 'parametric', eqPreamp: zoneId === 'local' ? -3.5 : 0,
      eqBands: [{ frequency: 60, gain: 2, q: 0.7, filterType: 'lowShelf' }, { frequency: 3200, gain: -1.5, q: 1.2, filterType: 'peak' }, { frequency: 9000, gain: 1, q: 0.8, filterType: 'highShelf' }],
      crossfeedEnabled: zoneId === 'local', crossfeedStrength: 0.3, convolverEnabled: false },
    scenes: { scenes: [{ id: 's-night', name: '夜间小音量', enabled: true }, { id: 's-speaker', name: '书架音箱', enabled: true }, { id: 's-old', name: '旧耳机', enabled: false }],
      activeSceneId: zoneId === 'local' ? 's-night' : null, pinnedSceneId: zoneId === 'local' ? 's-night' : null } })
  return dspStates.get(zoneId)
}
function dspNodes(zoneId) {
  const p = dspState(zoneId).processing
  if (!p.dspEnabled || p.directMode) return []
  const nodes = []
  if (p.eqEnabled) nodes.push({ id: 'eq', type: 'parametricEq', enabled: true, active: true, bypassed: false, latencyFrames: 0, format: null })
  if (p.crossfeedEnabled) nodes.push({ id: 'cf', type: 'crossfeed', enabled: true, active: true, bypassed: false, latencyFrames: 0, format: null })
  return nodes
}
function signalPath(zoneId, sourcePlayback, sourceTrack) {
  const zone = zoneById(zoneId)
  const out = zone.id === 'local' ? localBridgeState() : zone.output
  const remote = out.selected
  const facts = remote && out.connected ? out.receiver : null
  const playing = Boolean(sourceTrack)
  const rate = sourceTrack?.sampleRate || 0
  const resampled = remote && rate && rate !== 48000
  return { zoneId,
    source: { sampleRate: playing ? rate : 0, bitDepth: playing ? sourceTrack.bitDepth : 0, channels: 2, codec: playing ? sourceTrack.format : '' },
    decoded: { sampleRate: playing ? rate : 0, bitDepth: 32, channels: 2, format: playing ? 'f32' : '' },
    dsp: { revision: 1, requestedRevision: 1, appliedRevision: 1, applyState: 'applied', activeSceneId: null, compileState: 'ready',
      totalLatencyFrames: 0, latencySampleRate: rate, totalTailFrames: 0, nodes: dspNodes(zoneId),
      outputStage: { actualSampleRate: resampled ? 48000 : rate, effectiveResampler: resampled ? 'SoX VHQ' : null, resampled: Boolean(resampled), headroomGainDb: 0, active: true } },
    transport: { kind: remote ? 'tls-pcm' : 'local', sampleRate: remote ? 48000 : rate, channels: 2, format: remote ? 'float32-le' : '', connected: !remote || out.connected },
    receiver: facts, timing: facts ? timing() : null,
    output: { backend: remote ? facts?.backend ?? '' : 'wasapi-exclusive', sampleRate: remote ? facts?.actualSampleRate ?? 0 : rate,
      bitDepth: remote ? facts?.actualBitDepth ?? 0 : 24, channels: 2, deviceName: remote ? facts?.deviceName ?? null : 'Realtek USB Audio' },
    hardware: null }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = (message) => { throw new Error(message) }

window.zonesFixtureCore = {
  state: shallowRef({ phase: 'ready', epoch: 'fixture-epoch', libraryRevision: 1 }),
  attach: async () => {},
  async query(name, payload = {}) {
    await delay(25)
    switch (name) {
      case 'zones.list':
        return { revision: topology, limit: 4, error: null, zones: zones.map((z) => ({ ...structuredClone(z), playback: advance(z.playback),
          output: z.id === 'local' ? localBridgeState() : structuredClone(z.output) })) }
      case 'groups.list':
        return { revision: topology, error: null, groups: groups.map((g) => ({ ...structuredClone(g), playback: advance(g.playback) })) }
      case 'zones.signalPath': { const z = zoneById(payload.zoneId); return signalPath(z.id, z.playback, z.track) }
      case 'groups.signalPath': { const g = groupById(payload.groupId); return signalPath(payload.zoneId, g.playback, g.track) }
      case 'zones.dsp': return structuredClone(dspState(payload.zoneId))
      case 'queue.page': {
        const owner = zones.find((z) => z.queue?.id === payload.id) ?? groups.find((g) => g.queue?.id === payload.id)
        const current = owner?.track
        const items = [current, ...upcoming].slice(0, payload.limit ?? 6).map((track, i) => ({ queueEntryId: payload.id + '-' + i, position: payload.offset + i, track }))
        return { items, total: owner?.queue?.total ?? items.length, revision: payload.revision, libraryRevision: 1, offset: payload.offset }
      }
      case 'library.artwork': return { items: payload.ids.map((id) => ({ id, cover: artwork(id) })) }
      case 'zones.state': {
        const s = localBridgeState()
        return { ...s, revision: localOutput.revision, zoneId: 'local', groupId: null, selectedOutputId: localOutput.selectedOutputId,
          outputs: [{ id: 'local', name: '此电脑', available: true }, { id: 'bridge', name: '工作室电脑 · RME ADI-2', available: true }] }
      }
      case 'bridge.invitation': return { invitation: localOutput.hosting ? 'twilight-bridge://192.168.1.20:47321?token=' + 'ab'.repeat(24) + '&fingerprint=' + 'cd'.repeat(32) : null }
      default: fail('fixture: unknown query ' + name)
    }
  },
  async command(name, payload) {
    await delay(120)
    const bump = () => { topology += 1 }
    switch (name) {
      case 'zones.transport': {
        const z = zoneById(payload.zoneId); if (payload.revision !== null && payload.revision !== z.revision) fail('会话状态已变化，请刷新后重试')
        z.revision += 1; const a = payload.action
        if (a.kind === 'play') { await delay(700); z.playback.state = 'playing' }
        else if (a.kind === 'pause' || a.kind === 'stop') z.playback.state = a.kind === 'pause' ? 'paused' : 'stopped'
        else if (a.kind === 'volume') z.playback.volume = a.volume
        else if (a.kind === 'seek') z.playback.position = a.position
        else if (a.kind === 'next' || a.kind === 'previous') { z.queue.index = Math.max(0, z.queue.index + (a.kind === 'next' ? 1 : -1)); z.queue.revision += 1; z.playback.position = 0 }
        return
      }
      case 'groups.transport': {
        const g = groupById(payload.groupId); g.revision += 1; const a = payload.action
        if (a.kind === 'play') { g.coordination.phase = 'preparing'; await delay(500); g.coordination.phase = 'armed'; await delay(400); g.coordination.phase = 'playing'; g.playback.state = 'playing' }
        else if (a.kind === 'pause' || a.kind === 'stop') { g.playback.state = 'paused'; g.coordination.phase = 'paused' }
        else if (a.kind === 'volume') g.playback.volume = a.volume
        else if (a.kind === 'seek') g.playback.position = a.position
        return
      }
      case 'groups.settings.edit': {
        const g = groupById(payload.groupId)
        if (g.revision !== payload.revision) fail('同步组已变化，请刷新')
        g.revision += 1; g.autoMixMode = payload.autoMixMode
        g.playback.autoMixMode = payload.autoMixMode; g.playback.state = 'paused'; g.coordination.phase = 'paused'
        return
      }
      case 'zones.dsp.edit': {
        const s = dspState(payload.zoneId); if (s.revision !== payload.revision) fail('处理设置已变化，请刷新')
        if (payload.edit.kind === 'processing') Object.assign(s.processing, payload.edit.settings)
        else s.scenes.activeSceneId = payload.edit.id
        s.revision += 1; return
      }
      case 'zones.queueFromQuery': { const z = zoneById(payload.zoneId); z.revision += 1; z.track = tracks.tide; z.queue = queue('q-new-' + Date.now(), 0, 14); z.playback = playback('paused', 0, 318, z.playback.volume); return }
      case 'groups.queueFromQuery': { const g = groupById(payload.groupId); g.revision += 1; g.track = tracks.tide; g.queue = queue('q-gnew-' + Date.now(), 0, 14); g.playback.state = 'paused'; g.coordination.phase = 'paused'; return }
      case 'zones.create': {
        if (payload.revision !== topology) fail('声区列表已变化，请刷新')
        if (zones.length >= 4) fail('最多 4 个声区')
        const id = 'zone-' + crypto.randomUUID()
        zones.push({ id, name: payload.name, revision: 0, track: null, queue: null, playback: playback('stopped', 0, 0, 0.5), output: { ...output(null, false, ''), selected: false, error: null }, error: null, groupId: null })
        bump(); return { id }
      }
      case 'zones.connect': {
        // Documentation addresses (203.0.113.0/24) never answer, to exercise the failure path.
        if (payload.peer.host.startsWith('203.0.113.')) fail('输出桥 ' + payload.peer.host + ':' + payload.peer.port + ' 没有响应，请确认那台电脑已开启输出桥')
        const z = zoneById(payload.zoneId); z.output = output(z.name + '音箱', true, 'USB DAC'); z.revision += 1; return
      }
      case 'zones.remove': { zones.splice(zones.findIndex((z) => z.id === payload.zoneId), 1); bump(); return }
      case 'zones.handoff': {
        const s = zoneById(payload.source.zoneId), t = zoneById(payload.target.zoneId)
        if (t.queue && !payload.replace) fail('请明确确认替换目标会话的队列')
        s.playback.state = 'paused'; s.revision += 1; t.revision += 1
        t.track = s.track; t.queue = { ...s.queue, id: 'q-copy-' + Date.now() }; t.playback = { ...t.playback, state: payload.resume ? 'playing' : 'paused', position: s.playback.position, duration: s.playback.duration }
        return
      }
      case 'groups.create': {
        const source = zoneById(payload.source.zoneId), id = 'group-' + crypto.randomUUID()
        groups.push({ id, name: payload.name, revision: 0, autoMixMode: 'off', autoMixAvailable: true, members: payload.members.map(({ zoneId, downstreamDelayMs }) => ({ zoneId, downstreamDelayMs })),
          track: source.track, queue: { ...source.queue, id: 'q-group-' + Date.now() }, playback: playback('paused', 0, source.track?.duration ?? 0, 0.6),
          coordination: { phase: 'paused', error: null, epoch: 0, audibleAtCoreMs: null, estimatedSkewMs: null, observationRangeMs: null, members: [] }, error: null })
        for (const m of payload.members) { const z = zoneById(m.zoneId); z.groupId = id; z.playback.state = 'paused'; z.revision += 1 }
        bump(); return { id }
      }
      case 'groups.remove': {
        for (const z of zones) if (z.groupId === payload.groupId) { z.groupId = null; z.playback.state = 'paused' }
        groups.splice(groups.findIndex((g) => g.id === payload.groupId), 1); bump(); return
      }
      case 'zones.select': localOutput = { ...localOutput, selectedOutputId: payload.outputId, connected: payload.outputId === 'bridge', revision: localOutput.revision + 1 }; return
      case 'bridge.connect': localOutput = { ...localOutput, selectedOutputId: 'bridge', connected: true, revision: localOutput.revision + 1 }; return
      case 'bridge.host': localOutput = { ...localOutput, hosting: payload.enabled, revision: localOutput.revision + 1 }; return
      default: fail('fixture: unknown command ' + name)
    }
  }
}
window.zonesFixture = { zones, groups, build, topology: () => topology }

createApp({ render: () => h(ZonesPage) }).mount('#app')
`

const dialogStub = `
import { defineComponent, h } from 'vue'
export default defineComponent({
  emits: ['close', 'submit'],
  setup(_props, { emit, attrs }) {
    return () => h('dialog', { open: true, class: 'zones-fixture-dialog-stub', onClick: () => emit('close') }, 'dialog stub: ' + (attrs['data-name'] || ''))
  }
})
`

const server = await createServer({
  configFile: false,
  root,
  logLevel: 'warn',
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    watch: { ignored: ['**/out/**', '**/resources/audio-engine/**', '**/.artifacts/**', '**/tmp/**', '**/.cache/**', '**/dist/**', '**/outputs/**'] }
  },
  resolve: { alias: { '@renderer': resolve(root, 'src/renderer/src') } },
  plugins: [
    {
      name: 'zones-isolated-preview',
      enforce: 'pre',
      resolveId(source, importer) {
        if (source === 'zones-fixture') return '\0zones-fixture'
        if (/(?:^|\/)coreConnection(?:\.ts)?$/.test(source)) return '\0zones-fixture-core'
        // Dialogs land separately; until they exist the page renders with inert stubs.
        if (importer && source.startsWith('./dialogs/') && source.endsWith('.vue')) {
          const file = resolve(dirname(importer.split('?')[0]), source)
          if (!existsSync(file)) return '\0zones-dialog-stub'
        }
        return null
      },
      load(id) {
        if (id === '\0zones-fixture') return fixture
        if (id === '\0zones-fixture-core') return 'export const useCoreConnection=()=>window.zonesFixtureCore'
        if (id === '\0zones-dialog-stub') return dialogStub
        return null
      },
      configureServer(server) {
        server.middlewares.use('/zones-preview', async (_req, res) => {
          const html = await server.transformIndexHtml(
            '/zones-preview',
            `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Twilight Echo · 声区 UI Fixture</title><style>
html,body{margin:0;height:100%;overflow:hidden!important;background:var(--te-app-bg);font-family:var(--te-font-sans,'Segoe UI','Microsoft YaHei',sans-serif)}
#app{height:100%}
</style></head><body><div id="app"></div><script type="module" src="/@id/__x00__zones-fixture"></script></body></html>`
          )
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(html)
        })
      }
    },
    vue()
  ]
})
await server.listen()
console.log(`Zones UI fixture: http://127.0.0.1:${port}/zones-preview (simulated Core; no device IO)`)
