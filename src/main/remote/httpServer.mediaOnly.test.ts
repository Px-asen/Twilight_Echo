import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { ref, watch } from 'vue'

const httpServerSource = readFileSync(new URL('./httpServer.ts', import.meta.url), 'utf8')
const remoteIpcSource = readFileSync(new URL('./remoteIpc.ts', import.meta.url), 'utf8')
const playerStoreSource = readFileSync(
  new URL('../../renderer/src/stores/usePlayerStore.ts', import.meta.url),
  'utf8'
)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function castIpcFixture(holdNewLoad = false) {
  const events: string[] = []
  const stopEntered = deferred()
  const stopRelease = deferred()
  const loadEntered = deferred()
  const loadRelease = deferred()
  type Handler = (...args: unknown[]) => Promise<unknown>
  const handlers = new Map<string, Handler>()
  const devices = ['old', 'new'].map((usn) => ({
    usn,
    friendlyName: usn,
    avTransportUrl: usn,
    renderingControlUrl: usn
  }))
  class Server {
    async start() {}
    async stop() {}
    isMediaOnly() {
      return false
    }
    issueMediaUrl() {
      return 'http://media.invalid/token'
    }
  }
  const dependencies: Record<string, unknown> = {
    electron: {
      ipcMain: { handle: (name: string, callback: Handler) => handlers.set(name, callback) }
    },
    'node:crypto': {},
    '../security/electronSecurity.ts': { assertTrustedIpcSender() {} },
    '../security/ipcValidation.ts': { normalizeIpcString: (value: string) => value },
    '../security/localPaths.ts': { resolveAuthorizedAudioFile: async (path: string) => path },
    '../security/remoteMediaGrants.ts': {},
    '../core/runtime.ts': {
      runtime: {
        appSettings: { remoteControlEnabled: true },
        mainWindow: { isDestroyed: () => false, webContents: { once() {}, send() {}, id: 1 } }
      }
    },
    '../../shared/remoteControl.ts': {},
    '../app/AfterglowModeService.ts': { isAfterglowModeActive: () => false },
    '../../shared/afterglowMode.ts': {},
    './httpServer.ts': { RemoteHttpServer: Server },
    './dlnaClient.ts': {
      discoverDlnaDevices: async () => devices,
      dlnaSetAvTransportUri: async (device: string) => {
        events.push(`load:${device}`)
        if (holdNewLoad && device === 'new') {
          loadEntered.resolve()
          await loadRelease.promise
        }
      },
      dlnaPlay: async (device: string) => {
        events.push(`play:${device}`)
      },
      dlnaPause: async (device: string) => {
        events.push(`pause:${device}`)
      },
      dlnaSeek: async (device: string, seconds: number) => {
        events.push(`seek:${device}:${seconds}`)
      },
      dlnaSetVolume: async () => {},
      dlnaStop: async (device: string) => {
        events.push(`stop:${device}:start`)
        stopEntered.resolve()
        await stopRelease.promise
        events.push(`stop:${device}:commit`)
      }
    },
    './chromecastClient.ts': { discoverChromecastDevices: async () => [] },
    './didl.ts': { buildDidlLiteMetadata: () => '' },
    '../app/settingsRuntime.ts': {}
  }
  const exports: { setupRemoteIpc?: () => void } = {}
  runInNewContext(
    ts.transpileModule(remoteIpcSource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      exports,
      require: (id: string) => {
        assert.ok(id in dependencies, id)
        return dependencies[id]
      },
      console,
      process
    }
  )
  exports.setupRemoteIpc!()
  const call = <T = unknown>(name: string, payload?: unknown): Promise<T> =>
    handlers.get(`remote:${name}`)!({}, payload) as Promise<T>
  function newRendererModule() {
    const rendererExports: {
      createCastController?: (options: unknown) => {
        castCurrentTrackToDevice: (usn: string) => Promise<void>
        stopCastSession: () => Promise<void>
        dispose: () => void
      }
    } = {}
    runInNewContext(
      ts.transpileModule(
        readFileSync(
          new URL('../../renderer/src/stores/player/castController.ts', import.meta.url),
          'utf8'
        ),
        {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }
      ).outputText,
      { exports: rendererExports, require: () => ({ watch }), console }
    )
    return rendererExports.createCastController!({
      currentTrack: ref({ id: 'track', queueEntryId: 'entry', filePath: 'D:/Music/one.flac' }),
      currentTime: ref(0),
      castTargetUsn: ref(null),
      castTargetName: ref(null),
      getRemoteApi: () => ({
        castToDevice: (payload: unknown) => call('castToDevice', payload),
        stopCast: () => call('stopCast')
      }),
      resolvePlayTarget: async () => 'D:/Music/one.flac',
      isCurrentTrackLiveStream: () => false,
      recordPlaybackStart() {}
    })
  }
  return { events, stopEntered, stopRelease, loadEntered, loadRelease, call, newRendererModule }
}

test('main transport preserves cast ownership across independently loaded renderer modules', async () => {
  const state = castIpcFixture()
  await state.call('discoverDlna')
  const oldRenderer = state.newRendererModule()
  await oldRenderer.castCurrentTrackToDevice('old')
  const stopped = oldRenderer.stopCastSession()
  await state.stopEntered.promise
  oldRenderer.dispose()
  const newRenderer = state.newRendererModule()
  const cast = newRenderer.castCurrentTrackToDevice('new')
  await new Promise<void>((resolve) => setImmediate(resolve))
  state.stopRelease.resolve()
  await Promise.all([stopped, cast])
  assert.ok(state.events.indexOf('stop:old:commit') < state.events.indexOf('load:new'))
  assert.equal((await state.call<{ usn: string } | null>('getCastTarget'))?.usn, 'new')
  await state.call('controlCast', { pause: true, seek: 12 })
  assert.deepEqual(state.events.slice(-2), ['seek:new:12', 'pause:new'])
  newRenderer.dispose()
})

test('cast pause and seek wait for the pending target change', async () => {
  const state = castIpcFixture(true)
  await state.call('discoverDlna')
  await state.call('castToDevice', { usn: 'old', filePath: 'D:/Music/one.flac' })
  const cast = state.call('castToDevice', { usn: 'new', filePath: 'D:/Music/two.flac' })
  await state.loadEntered.promise
  const controls = state.call('controlCast', { pause: true, seek: 25 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  state.loadRelease.resolve()
  await Promise.all([cast, controls])
  assert.deepEqual(state.events.slice(-2), ['seek:new:25', 'pause:new'])
  assert.equal((await state.call<{ usn: string } | null>('getCastTarget'))?.usn, 'new')
})

test('a rejected cast releases the main transport queue for the next request', async () => {
  const state = castIpcFixture()
  await state.call('discoverDlna')
  const rejected = state.call('castToDevice', { usn: 'missing', filePath: 'D:/Music/one.flac' })
  const next = state.call('castToDevice', { usn: 'new', filePath: 'D:/Music/two.flac' })
  await assert.rejects(rejected, /Cast device not found/)
  await next
  assert.equal((await state.call<{ usn: string } | null>('getCastTarget'))?.usn, 'new')
})

test('remote HTTP server supports mediaOnly bind without full remote surface', () => {
  assert.match(httpServerSource, /mode\?: RemoteServerMode/)
  assert.match(httpServerSource, /mode === 'mediaOnly'/)
  assert.match(httpServerSource, /media_only/)
  // mediaOnly must not advertise PIN / remote URLs as "enabled".
  assert.match(httpServerSource, /enabled: this\.enabled && !mediaOnly/)
  assert.match(
    httpServerSource,
    /pin: this\.enabled && !mediaOnly \? this\.auth\.getPin\(\) : null/
  )
  // mediaOnly request path only serves /media/ tokens.
  assert.match(
    httpServerSource,
    /if \(this\.mode === 'mediaOnly'\) \{[\s\S]*\/media\/[\s\S]*media_only/
  )
  // Mode switches keep media grants (no stop/clear on applyMode).
  assert.match(httpServerSource, /applyMode\(desiredMode\)/)
  assert.match(httpServerSource, /applyMode\(desiredMode: RemoteServerMode\)/)
  assert.match(httpServerSource, /keep cast media grants|Keep cast media grants/i)
})

test('cast binds media-only when remote control is off and tears it down on stopCast', () => {
  assert.match(remoteIpcSource, /ensureCastMediaServer/)
  assert.match(remoteIpcSource, /remoteEnabled[\s\S]*mode: 'full'[\s\S]*mode: 'mediaOnly'/)
  assert.match(remoteIpcSource, /await ensureCastMediaServer\(\)/)
  assert.match(
    remoteIpcSource,
    /remote:stopCast[\s\S]*isMediaOnly\(\)[\s\S]*remoteControlEnabled !== true[\s\S]*server\.stop\(\)/
  )
  // Disabling remote keeps mediaOnly only while a cast session is active.
  assert.match(
    remoteIpcSource,
    /if \(activeCastUsn\) \{\s*await server\.start\(preferredPort, \{ mode: 'mediaOnly' \}\)/
  )
  // Failed cast releases orphan mediaOnly binds.
  assert.match(remoteIpcSource, /releaseOrphanMediaOnlyServer/)
  assert.match(remoteIpcSource, /if \(!castSucceeded\)[\s\S]*releaseOrphanMediaOnlyServer/)
  // Bare cast upstreams cannot target private/loopback hosts.
  assert.match(remoteIpcSource, /isPrivateOrLoopbackHost/)
  assert.match(remoteIpcSource, /Cast media URL host is not authorized/)
})

test('player queue skip re-casts while a cast session is active', () => {
  assert.match(playerStoreSource, /castTargetUsn/)
  assert.match(playerStoreSource, /function playQueueTrack/)
  assert.match(playerStoreSource, /if \(castTargetUsn\.value\) \{[\s\S]*castCurrentTrackToDevice/)
  assert.match(
    playerStoreSource,
    /else if \(castTargetName\.value\) \{[\s\S]*controlCast\?\.\(\{ seek: 0 \}\)/
  )
  assert.match(playerStoreSource, /!castTargetUsn\.value && nativePlaybackActive/)
})

test('remote HTTP server exposes only authenticated bounded browse and explicit command failures', () => {
  assert.match(httpServerSource, /url\.pathname === '\/api\/browse'/)
  assert.match(httpServerSource, /parseRemoteBrowseRequest\(url\.searchParams\)/)
  assert.match(httpServerSource, /browse_handler_missing/)
  assert.match(httpServerSource, /error instanceof RemoteCommandError/)
  assert.match(httpServerSource, /this\.sendJson\(res, error\.status/)
  assert.match(remoteIpcSource, /RENDERER_REQUEST_TIMEOUT_MS = 5_000/)
  assert.match(remoteIpcSource, /message === 'queue_changed' \? 409 : 503/)
})

test('remote HTTP server no longer uses CORS wildcard and caps SSE clients', () => {
  // S2: CORS 只回显同源/回环 Origin，不再无条件 `*`。
  assert.match(httpServerSource, /teCorsOrigin/)
  assert.match(httpServerSource, /resolveAllowedOrigin\(/)
  assert.doesNotMatch(httpServerSource, /'access-control-allow-origin': '\*'/)
  // S3: SSE 长连接上限。
  assert.match(httpServerSource, /sseMaxClients/)
  assert.match(httpServerSource, /too_many_event_connections/)
})
