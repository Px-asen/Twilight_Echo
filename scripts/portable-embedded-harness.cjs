// Drives dist/portable-core/music-core.js through its embedded outbox
// protocol (bootHost / handleRequest / drain / completePortCall) inside a
// zero-Node vm sandbox, the way the Android QuickJS host does.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const BUNDLE_PATH = path.resolve(__dirname, '..', 'dist', 'portable-core', 'music-core.js')

class PortError extends Error {
  constructor(code, message, retryable = false) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

function createFakePlatform(overrides = {}) {
  const platform = {
    stored: null,
    revision: 0,
    audio: {
      engineSessionId: 'fake-engine',
      state: 'idle',
      positionMs: 0,
      durationMs: 0,
      volume: 1,
      playbackRate: 1,
      playMode: 'sequence',
      queueIndex: -1,
      queueGeneration: 0,
      codec: 'flac',
      sampleRate: 44100,
      bitDepth: 16,
      channels: 2,
      outputBackend: 'aaudio',
      actualSampleRate: 48000,
      actualBitDepth: 16,
      actualChannels: 2,
      outputPerfect: false,
      dspActive: false,
      eqActive: false,
      latencyMs: 20,
      bufferSizeFrames: 960,
      gaplessActive: false,
      preloadReady: false
    },
    queue: [],
    route: {
      deviceId: 'speaker',
      deviceName: 'Phone speaker',
      routeType: 'speaker',
      outputBackend: 'aaudio',
      supportedSampleRates: [48000],
      activeSampleRate: 48000,
      maxBitDepth: 16,
      isUsbHiResCapable: false
    },
    revoked: new Set(),
    calls: [],
    appliedDsp: null,
    network: () => ({ statusCode: 404, headers: {}, bodyUtf8: '' })
  }
  const handlers = {
    'sessionStore.load': () =>
      platform.stored ? { revision: String(platform.revision), payloadJson: platform.stored } : null,
    'sessionStore.save': ({ payloadJson, expectedRevision }) => {
      const current = platform.stored ? String(platform.revision) : null
      if (expectedRevision !== current) return { ok: false, reason: 'conflict' }
      platform.revision += 1
      platform.stored = payloadJson
      return { ok: true, revision: String(platform.revision) }
    },
    'resourceAccess.resolveNativeUri': ({ resourceId }) => {
      if (platform.revoked.has(resourceId)) {
        throw new PortError('PERMISSION_EXPIRED', `Access to ${resourceId} expired`)
      }
      return { uri: resourceId }
    },
    'audioEngine.loadQueue': ({ tracks, startIndex, queueGeneration }) => {
      // Like NativeAudioEngineAdapter: re-sending the current entry (a preload window)
      // keeps it playing; only a different selected entry resets the engine.
      const previous = platform.queue[platform.audio.queueIndex]
      const selected = tracks[startIndex]
      const changed =
        previous?.id !== selected?.id ||
        previous?.source !== selected?.source ||
        previous?.queueEntryId !== selected?.queueEntryId
      platform.queue = tracks
      platform.audio.queueGeneration = queueGeneration
      platform.audio.queueIndex = tracks.length === 0 ? -1 : startIndex
      if (changed) {
        platform.audio.state = 'paused'
        platform.audio.positionMs = 0
        platform.audio.durationMs = Math.round((selected?.duration ?? 0) * 1000)
      }
      return true
    },
    'audioEngine.play': ({ position, source }) => {
      // Same contract as Android's CorePortBridge: play starts the loaded queue position.
      if (platform.queue[platform.audio.queueIndex]?.source !== source) {
        throw new PortError('SOURCE_CHANGED', `Engine does not hold ${source} at ${platform.audio.queueIndex}`)
      }
      platform.audio.positionMs = Math.round((position ?? 0) * 1000)
      platform.audio.state = 'playing'
      return true
    },
    'audioEngine.pause': () => {
      if (platform.audio.state === 'playing' || platform.audio.state === 'buffering') platform.audio.state = 'paused'
      return true
    },
    'audioEngine.stop': () => {
      platform.audio.state = 'idle'
      platform.audio.positionMs = 0
      return true
    },
    'audioEngine.seek': ({ positionMs }) => {
      platform.audio.positionMs = positionMs
      return true
    },
    'audioEngine.setVolume': ({ volume }) => {
      platform.audio.volume = volume
      return true
    },
    'audioEngine.setPlayMode': ({ mode }) => {
      platform.audio.playMode = mode
      return true
    },
    'audioEngine.setDspConfig': ({ configJson }) => {
      platform.appliedDsp = JSON.parse(configJson)
      return true
    },
    'audioEngine.getSnapshot': () => ({ ...platform.audio }),
    'audioDevice.getActiveRoute': () => ({ ...platform.route }),
    'audioDevice.listOutputDevices': () => [{ ...platform.route }],
    'network.request': (args) => platform.network(args)
  }
  Object.assign(handlers, overrides)
  platform.handlers = handlers
  return platform
}

function loadSandbox({ eventLoop }) {
  const noop = () => {}
  const sandbox = { console: { log: noop, info: noop, warn: noop, error: noop, debug: noop } }
  if (eventLoop) sandbox.__TWILIGHT_HOST_EVENT_LOOP__ = true
  else Object.assign(sandbox, { setTimeout, clearTimeout })
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox, {
    name: 'QuickJS-Simulated-Sandbox',
    codeGeneration: { strings: false, wasm: false }
  })
  vm.runInContext(
    'delete globalThis.Intl; delete globalThis.structuredClone; delete globalThis.crypto; delete globalThis.TextEncoder; delete globalThis.TextDecoder; delete globalThis.AbortController; delete globalThis.AbortSignal; delete globalThis.URL; delete globalThis.DOMException;',
    context
  )
  vm.runInContext(fs.readFileSync(BUNDLE_PATH, 'utf8'), context, {
    filename: 'music-core.js',
    timeout: 10000
  })
  return sandbox
}

/**
 * `eventLoop: true` mirrors Cash QuickJS: no native job queue, every Promise
 * and timer runs only when the host drains.
 */
function createEmbeddedHarness({ eventLoop = true, platform = createFakePlatform() } = {}) {
  const sandbox = loadSandbox({ eventLoop })
  const core = sandbox.__TWILIGHT_PORTABLE_CORE__
  const responses = new Map()
  const events = []
  const boots = []
  const shutdowns = []
  const logs = []
  let epoch = null
  let nextRequest = 0
  let lastTimerDelay = null

  function completePort(message) {
    const key = `${message.port}.${message.method}`
    platform.calls.push({ key, args: message.args })
    const handler = platform.handlers[key]
    let result
    try {
      if (!handler) throw new PortError('UNSUPPORTED_CAPABILITY', `No fake port for ${key}`)
      const value = handler(message.args ?? {})
      result = { callId: message.callId, ok: true, value: value === undefined ? null : value }
    } catch (error) {
      result = {
        callId: message.callId,
        ok: false,
        error: { code: error.code ?? 'FAILED', message: error.message, retryable: !!error.retryable }
      }
    }
    // Kotlin hands results back as JSON text.
    const accepted = JSON.parse(core.completePortCall(JSON.stringify(result)))
    if (!accepted.accepted) logs.push({ level: 'test', message: `port result dropped: ${key}` })
  }

  function drainOnce() {
    const { messages, nextTimerDelayMs } = JSON.parse(core.drain())
    lastTimerDelay = nextTimerDelayMs
    for (const message of messages) {
      switch (message.type) {
        case 'port':
          completePort(message)
          break
        case 'response':
          responses.set(message.response.requestId, message.response)
          break
        case 'event':
          events.push(message.event)
          break
        case 'boot':
          boots.push(message)
          break
        case 'shutdown':
          shutdowns.push(message)
          break
        case 'log':
          logs.push(message)
          break
        default:
          throw new Error(`Unknown outbox message ${JSON.stringify(message)}`)
      }
    }
    return messages.length
  }

  const tick = () => new Promise((resolve) => setImmediate(resolve))

  /** Drains until quiet; optionally waits for short Core timers to fire. */
  async function settle({ timersUpToMs = 0, rounds = 2000 } = {}) {
    let idle = 0
    for (let round = 0; round < rounds; round++) {
      if (!eventLoop) await tick()
      const count = drainOnce()
      if (count > 0) {
        idle = 0
        continue
      }
      if (lastTimerDelay !== null && lastTimerDelay <= timersUpToMs) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, lastTimerDelay)))
        continue
      }
      if (eventLoop || ++idle >= 3) return
    }
    throw new Error('Embedded Core did not settle')
  }

  async function boot(config = {}) {
    const result = JSON.parse(core.bootHost(JSON.stringify(config)))
    if (!result.ok) throw new Error(`bootHost failed: ${result.error}`)
    epoch = result.epoch
    const before = boots.length
    for (let attempt = 0; attempt < 50 && boots.length === before; attempt++) await settle()
    const booted = boots[boots.length - 1]
    if (boots.length === before) throw new Error('Core never reported boot')
    return { ...result, boot: booted }
  }

  /** Stops the Core the way a host does before it closes the runtime. */
  async function shutdown() {
    const accepted = JSON.parse(core.shutdownHost('{}'))
    if (!accepted.accepted) throw new Error('shutdownHost was not accepted')
    for (let attempt = 0; attempt < 50 && shutdowns.length === 0; attempt++) await settle()
    if (shutdowns.length === 0) throw new Error('Core never reported shutdown')
    return shutdowns[0]
  }

  function send(name, payload = {}, kind = 'command', extra = {}) {
    const requestId = extra.requestId ?? `req-${++nextRequest}`
    const envelope = { kind, requestId, epoch: extra.epoch ?? epoch, name, payload, ...extra }
    const accepted = JSON.parse(core.handleRequest(JSON.stringify(envelope)))
    return { requestId, accepted }
  }

  async function request(name, payload = {}, kind = 'command', extra = {}) {
    const { requestId, accepted } = send(name, payload, kind, extra)
    if (!accepted.accepted) throw new Error(`Request ${name} was not accepted: ${accepted.error}`)
    for (let attempt = 0; attempt < 50 && !responses.has(requestId); attempt++) await settle()
    const response = responses.get(requestId)
    if (!response) throw new Error(`No response for ${name}`)
    return response
  }

  async function value(name, payload = {}, kind = 'command', extra = {}) {
    const response = await request(name, payload, kind, extra)
    if (!response.ok) {
      throw new Error(`${name} failed: ${response.error.code} ${response.error.message}`)
    }
    return response.value
  }

  async function audioEvent(event) {
    const accepted = JSON.parse(core.onAudioEngineEvent(JSON.stringify(event)))
    await settle()
    return accepted
  }

  return {
    core,
    sandbox,
    platform,
    responses,
    events,
    boots,
    logs,
    get epoch() {
      return epoch
    },
    get lastTimerDelay() {
      return lastTimerDelay
    },
    boot,
    shutdown,
    send,
    request,
    value,
    settle,
    audioEvent,
    snapshot: () => value('core.getSnapshot', {}, 'query'),
    lastState: () => events.filter((event) => event.kind === 'state').at(-1)?.snapshot ?? null
  }
}

function wireTrack(id, extra = {}) {
  return {
    id,
    title: `Title ${id}`,
    artist: 'Echo Ensemble',
    artists: ['Echo Ensemble'],
    album: 'Phase One',
    source: `content://media/external/audio/media/${id}`,
    duration: 200,
    ...extra
  }
}

module.exports = { BUNDLE_PATH, PortError, createEmbeddedHarness, createFakePlatform, wireTrack }
