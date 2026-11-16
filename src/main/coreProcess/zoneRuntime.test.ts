import '../../adapters-node/index.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { createAudioServiceCapabilities } from '../../shared/audioServiceContract.ts'
import type { BridgePeer, BridgeRuntimeState } from '../../shared/audioBridge.ts'
import type { LibraryDatabaseServiceClient } from '../library/libraryDatabaseServiceClient.ts'
import { CoreServiceLease, type CoreServiceLauncher } from './serviceLauncher.ts'
import { createZoneRuntime, playbackQueueApi } from './zoneRuntime.ts'

interface RecordedRpc {
  requestId: string
  method: string
  args: unknown[]
}

function createFakeZoneAudioLauncher() {
  let launches = 0
  let connected = false
  let dspRevision = 0
  let lastDspPayload: Record<string, unknown> | null = null
  const rpcs: RecordedRpc[] = []

  const launcher = {
    launch(service: 'zone-audio') {
      assert.equal(service, 'zone-audio')
      launches += 1
      const lease = new CoreServiceLease(`zone-audio-${launches}`, () => {
        queueMicrotask(() => lease.confirmExit(0))
      })
      queueMicrotask(() => {
        lease.emit('message', {
          kind: 'ready',
          capabilities: createAudioServiceCapabilities([
            'ApplyDspState',
            'GetDspGraphStatus',
            'RebindQueue',
            'SetLoopRange'
          ])
        })
      })
      const originalPost = lease.postMessage.bind(lease)
      lease.postMessage = (raw: unknown) => {
        const msg = raw as RecordedRpc & { kind?: string }
        if (msg && msg.kind === 'ping') {
          queueMicrotask(() => {
            lease.emit('message', { kind: 'pong', requestId: msg.requestId })
          })
          return
        }
        if (msg && typeof msg.requestId === 'string' && typeof msg.method === 'string') {
          rpcs.push({ requestId: msg.requestId, method: msg.method, args: msg.args })
          queueMicrotask(() => {
            let value: unknown = null
            if (msg.method === 'ApplyDspState') {
              dspRevision = Number(msg.args[0]) || dspRevision + 1
              lastDspPayload = JSON.parse(String(msg.args[1] ?? '{}'))
              value = JSON.stringify({
                revision: dspRevision,
                activeSceneId: 'default',
                totalLatencyFrames: 0,
                totalTailFrames: 0,
                nodes: []
              })
            } else if (msg.method === 'GetDspGraphStatus') {
              value = JSON.stringify({
                revision: dspRevision,
                activeSceneId: 'default',
                totalLatencyFrames: 0,
                totalTailFrames: 0,
                nodes: []
              })
            } else if (msg.method === 'GetPlaybackInfo') {
              value = JSON.stringify({
                state: 'stopped',
                source: '',
                position: 0,
                duration: 0,
                volume: 1,
                outputBackend: 'bridge-pcm',
                actualBackend: 'bridge-pcm',
                outputDevice: '48000/2',
                actualDevice: '48000/2'
              })
            } else if (msg.method === 'BridgeConnect') {
              connected = true
            } else if (msg.method === 'BridgeQuarantine' || msg.method === 'BridgeDisconnect') {
              connected = false
            } else if (msg.method === 'BridgeStatus') {
              value = {
                supported: true,
                hosting: false,
                receiving: false,
                selected: true,
                connected,
                peerName: connected ? 'Study DAC' : null,
                error: null,
                receiver: null,
                timing: null,
                synchronization: null
              } satisfies BridgeRuntimeState
            } else if (msg.method === 'ScanVst3Module') {
              value = JSON.stringify({
                classId: '0123456789ABCDEF0123456789ABCDEF',
                name: 'Fixture EQ',
                vendor: 'Twilight',
                version: '1.0.0'
              })
            }
            lease.emit('message', {
              kind: 'response',
              requestId: msg.requestId,
              ok: true,
              value
            })
          })
          return
        }
        originalPost(raw)
      }
      return lease
    }
  } as unknown as CoreServiceLauncher

  return {
    launcher,
    get launches() {
      return launches
    },
    get rpcs() {
      return rpcs
    },
    get lastDspPayload() {
      return lastDspPayload
    }
  }
}

function createMinimalDatabaseStub(): LibraryDatabaseServiceClient {
  return {
    getMetadata: async () => ({ revision: 1 }),
    coreStateRead: async () => ({ revision: 0, rows: [] }),
    syncLibraryQueueReferences: async () => {}
  } as unknown as LibraryDatabaseServiceClient
}

test('extra Zone defers zone-audio process startup until connect and closes cleanly with zero spawns when unused', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-zone-lazy-'))
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  })

  const fake = createFakeZoneAudioLauncher()
  const zone = await createZoneRuntime({
    root,
    zone: { id: `zone-${randomUUID()}`, name: 'Study' },
    database: createMinimalDatabaseStub(),
    launcher: fake.launcher,
    platform: {
      call: async (name) => {
        if (name === 'dsp.environment') {
          return {
            platform: process.platform,
            temporaryDirectory: root,
            searchPaths: [],
            fixedSearchPaths: false,
            helpers: {}
          } as never
        }
        if (name === 'dsp.authorizeVst3Paths' || name === 'dsp.registerVst3Paths') {
          return [] as never
        }
        throw new Error(`Unexpected platform call: ${name}`)
      }
    },
    playback: {
      queues: playbackQueueApi(createMinimalDatabaseStub()),
      resolver: {} as never,
      authorize: async (source) => source
    },
    changed: () => {}
  })
  t.after(async () => {
    await zone.close()
  })

  // Cold boot + status read + offline DSP/volume/pause/stop edits must not spawn zone-audio.
  assert.equal(fake.launches, 0)
  const offlineOutput = await zone.output()
  assert.equal(offlineOutput.selected, true)
  assert.equal(offlineOutput.connected, false)
  assert.equal(offlineOutput.error, null)
  assert.equal(fake.launches, 0)

  const dspBefore = await zone.dsp.state()
  await zone.dsp.edit(
    {
      revision: dspBefore.revision,
      edit: { kind: 'processing', settings: { eqEnabled: true, eqPreamp: -4.5 } }
    },
    new AbortController().signal
  )
  await zone.playback.setVolume(0.35)
  await zone.playback.pause()
  await zone.playback.stop()
  const groupSnapshot = await zone.groupOutput!.read()
  assert.equal(groupSnapshot.bridge.connected, false)
  assert.equal(fake.launches, 0)

  // Closing an unused Zone must still keep launches === 0.
  const unused = await createZoneRuntime({
    root,
    zone: { id: `zone-${randomUUID()}`, name: 'Unused' },
    database: createMinimalDatabaseStub(),
    launcher: fake.launcher,
    platform: {
      call: async (name) => {
        if (name === 'dsp.environment') {
          return {
            platform: process.platform,
            temporaryDirectory: root,
            searchPaths: [],
            fixedSearchPaths: false,
            helpers: {}
          } as never
        }
        return [] as never
      }
    },
    playback: {
      queues: playbackQueueApi(createMinimalDatabaseStub()),
      resolver: {} as never,
      authorize: async (source) => source
    },
    changed: () => {}
  })
  await unused.close()
  assert.equal(fake.launches, 0)

  // Explicit Bridge connection wakes zone-audio once and syncs saved DSP + volume before BridgeConnect.
  const peer: BridgePeer = {
    host: '127.0.0.1',
    port: 41234,
    token: 'a'.repeat(48),
    fingerprint: 'b'.repeat(64)
  }
  await zone.connect(peer, false)
  assert.equal(fake.launches, 1)

  const methods = fake.rpcs.map((rpc) => rpc.method)
  const connectIndex = methods.indexOf('BridgeConnect')
  assert.ok(connectIndex > 0, `expected setup RPCs before BridgeConnect, got ${methods.join(', ')}`)
  assert.ok(methods.slice(0, connectIndex).includes('ApplyDspState'))
  assert.ok(methods.slice(0, connectIndex).includes('SetVolume'))
  assert.equal(
    (fake.lastDspPayload?.processing as { eqPreamp?: number } | undefined)?.eqPreamp,
    -4.5
  )

  const connectedOutput = await zone.output()
  assert.equal(connectedOutput.connected, true)
  assert.equal(connectedOutput.peerName, 'Study DAC')

  await zone.close()
})
