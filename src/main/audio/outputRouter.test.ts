import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { AudioEngineManager } from '../audioEngineManager.ts'
import { createDefaultPlaybackInfo, getAudioOutputOptions } from './audioEngineHelpers.ts'
import type {
  AudioDeviceOption,
  AudioEngineConfig,
  NativeAudioBinding,
  OutputConfig
} from './audioEngineTypes.ts'

function createHarness(config: AudioEngineConfig, devices?: AudioDeviceOption[]) {
  let info = createDefaultPlaybackInfo('wasapi', 'auto', config.exclusiveMode, {
    preferredBufferSize: 0,
    routingMode: 'auto'
  })
  const calls: Array<{ method: string; value: unknown }> = []
  let failConfig = false
  let dspRevision = 0
  const native = {
    GetPlaybackInfo: () => JSON.stringify(info),
    SetOutputBackend: (backend: string) => {
      calls.push({ method: 'backend', value: backend })
      info = { ...info, outputBackend: backend }
      if (!info.outputInfo.outputReleased) {
        info.actualBackend = backend
        info.outputInfo = { ...info.outputInfo, backend, actualBackend: backend }
      }
    },
    SetOutputDevice: (device: string) => {
      calls.push({ method: 'device', value: device })
      info = { ...info, outputDevice: device }
    },
    SetOutputConfig: (json: string) => {
      if (failConfig) throw new Error('configuration rejected')
      calls.push({ method: 'config', value: JSON.parse(json) })
    },
    SetVolume: () => {},
    SetDspConfig: () => {},
    ApplyDspState: (revision: number) => {
      dspRevision = revision
    },
    GetDspGraphStatus: () =>
      JSON.stringify({ revision: dspRevision, nodes: [], compileState: 'ready' }),
    GetLastError: () => ''
  } as unknown as NativeAudioBinding
  const manager = new AudioEngineManager(config, {
    nativeBinding: native, deviceOptionsProvider: devices ? () => devices : undefined
  })
  const effective = () =>
    manager.getEffectiveOutputConfig() as OutputConfig & { releaseExclusiveOnPause: boolean }
  return {
    manager,
    calls,
    effective,
    rejectConfig: () => (failConfig = true),
    releasePausedOutput: () => {
      info = { ...info, state: 'paused', source: 'track.flac', position: 12 }
      info.outputInfo = {
        ...info.outputInfo,
        actualBackend: 'wasapi-exclusive',
        outputReleased: true,
        exclusive: false,
        outputPerfect: false,
        accessMode: 'released'
      }
    }
  }
}

test('exclusive automatic release defaults off and requires the exclusive preference', () => {
  const manual = createHarness({ exclusiveMode: true })
  assert.equal(manual.effective().releaseExclusiveOnPause, false)
  const shared = createHarness({ exclusiveMode: false, exclusiveAutoRelease: true })
  assert.equal(shared.effective().releaseExclusiveOnPause, false)
  const exclusive = createHarness({ exclusiveMode: true, exclusiveAutoRelease: true })
  assert.equal(exclusive.effective().releaseExclusiveOnPause, true)
})

test('runtime release policy follows the transaction target and survives output configuration edits', async () => {
  const harness = createHarness({ exclusiveMode: true, exclusiveAutoRelease: true })
  await harness.manager.setExclusiveMode(false)
  assert.equal(
    (harness.calls.find((call) => call.method === 'config')?.value as Record<string, unknown>)
      .releaseExclusiveOnPause,
    false
  )
  await harness.manager.setExclusiveMode(true)
  await harness.manager.setOutputConfig({ preferredBufferSize: 512 })
  assert.equal(harness.effective().releaseExclusiveOnPause, true)
  assert.equal(harness.manager.getOutputConfig().preferredBufferSize, 512)
  assert.equal('releaseExclusiveOnPause' in harness.manager.getOutputConfig(), false)
})

test('release policy respects the platform backend capabilities', () => {
  for (const option of getAudioOutputOptions()) {
    const harness = createHarness({
      exclusiveMode: true,
      exclusiveAutoRelease: true,
      audioOutput: option.id
    })
    assert.equal(harness.effective().releaseExclusiveOnPause, option.supportsExclusive)
  }
})

test('automatic release policy update rolls back on native rejection', async () => {
  const harness = createHarness({ exclusiveMode: true })
  await harness.manager.setExclusiveAutoRelease(true)
  assert.equal(harness.effective().releaseExclusiveOnPause, true)
  harness.rejectConfig()
  await assert.rejects(harness.manager.setExclusiveAutoRelease(false), /configuration rejected/)
  assert.equal(harness.effective().releaseExclusiveOnPause, true)
})

test('released pause accepts pending route edits without requiring a newly opened output', async () => {
  const harness = createHarness({ exclusiveMode: true })
  harness.releasePausedOutput()
  await harness.manager.setExclusiveAutoRelease(true)
  assert.equal((await harness.manager.getPlaybackInfo()).state, 'paused')
  await harness.manager.setExclusiveMode(false)
  const pending = await harness.manager.getPlaybackInfo()
  assert.equal(pending.state, 'paused')
  assert.equal(pending.position, 12)
  assert.equal(pending.outputInfo.outputReleased, true)
  assert.equal(pending.outputInfo.exclusive, false)
  assert.equal(pending.outputInfo.actualBackend, 'wasapi-exclusive')
  assert.equal(pending.outputBackend, 'wasapi')
  assert.equal(harness.effective().releaseExclusiveOnPause, false)
})

const previousAsioDevice = 'asio:{11111111-1111-1111-1111-111111111111}'
const targetAsioDevice = 'asio:{895E25BB-F2E2-4E94-BE88-9D1DCD1C6793}'

function createReleasedAsioHarness(
  context: TestContext,
  service: boolean,
  ignoreDeviceChange = false
) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  context.after(() => Object.defineProperty(process, 'platform', platform))
  const devices: AudioDeviceOption[] = [previousAsioDevice, targetAsioDevice].map((id) => ({
    id,
    label: 'FiiO ASIO Driver',
    name: 'FiiO ASIO Driver',
    backend: 'asio',
    isDefault: false
  }))
  const info = createDefaultPlaybackInfo('asio', previousAsioDevice, true, {
    preferredBufferSize: 0,
    routingMode: 'auto'
  })
  Object.assign(info, { state: 'paused', source: 'track.flac', position: 33, volume: 0.45 })
  Object.assign(info.outputInfo, {
    deviceName: 'FiiO ASIO Driver',
    actualDeviceName: 'FiiO ASIO Driver',
    actualDeviceId: service ? previousAsioDevice : '',
    outputReleased: true,
    exclusive: false,
    accessMode: 'released'
  })
  let revision = 0
  let playbackCalls = 0
  const native = {
    GetPlaybackInfo: () => JSON.stringify(info),
    SetOutputBackend: (backend: string) => {
      info.outputBackend = backend
      info.outputInfo.backend = backend
    },
    SetOutputDevice: (device: string) => {
      if (!ignoreDeviceChange) info.outputDevice = device
    },
    SetOutputConfig: () => {},
    SetVolume: (volume: number) => {
      info.volume = volume
    },
    Play: () => playbackCalls++,
    Pause: () => playbackCalls++,
    Stop: () => playbackCalls++,
    ApplyDspState: (next: number) => {
      revision = next
    },
    GetDspGraphStatus: () => JSON.stringify({ revision, nodes: [], compileState: 'ready' }),
    GetLastError: () => ''
  } as unknown as NativeAudioBinding
  if (service) {
    native.callAsync = async (method, args) =>
      (native[method as keyof NativeAudioBinding] as (...args: unknown[]) => unknown)(...args)
  }
  const manager = new AudioEngineManager(
    { audioOutput: 'asio', audioDevice: previousAsioDevice, exclusiveMode: true, volume: 0.45 },
    {
      nativeBinding: native,
      deviceOptionsProvider: () => devices,
      scheduler: {
        now: () => 1000,
        setInterval: () => ({}) as NodeJS.Timeout,
        clearInterval: () => {},
        setImmediate: (callback) => callback()
      }
    }
  )
  return { manager, playbackCalls: () => playbackCalls }
}

for (const service of [false, true]) {
  test(`released ASIO device switch preserves the requested id with duplicate friendly names (${service ? 'service' : 'direct'})`, async (context) => {
    const harness = createReleasedAsioHarness(context, service)
    await harness.manager.setExclusiveAutoRelease(true)

    const route = await harness.manager.setAudioDevice(targetAsioDevice)
    const info = await harness.manager.getPlaybackInfo()

    assert.equal(route.device, targetAsioDevice)
    assert.equal(info.outputDevice, targetAsioDevice)
    assert.equal(info.outputInfo.deviceName, 'FiiO ASIO Driver')
    assert.equal(info.outputInfo.actualDeviceName, 'FiiO ASIO Driver')
    // Released output retains the old runtime facts until the user resumes.
    assert.equal(info.outputInfo.actualDeviceId, service ? previousAsioDevice : '')
    assert.equal(info.outputInfo.outputReleased, true)
    assert.equal(info.state, 'paused')
    assert.equal(info.source, 'track.flac')
    assert.equal(info.position, 33)
    assert.equal(info.volume, 0.45)
    assert.equal(harness.playbackCalls(), 0)
  })
}

test('released ASIO switch still rejects an unacknowledged device id and rolls back', async (context) => {
  const harness = createReleasedAsioHarness(context, true, true)
  await harness.manager.setExclusiveAutoRelease(true)

  await assert.rejects(harness.manager.setAudioDevice(targetAsioDevice), /did not preserve/)

  const route = await harness.manager.getAudioOutputState()
  const info = await harness.manager.getPlaybackInfo()
  assert.equal(route.device, previousAsioDevice)
  assert.equal(info.outputDevice, previousAsioDevice)
  assert.equal(info.state, 'paused')
  assert.equal(info.source, 'track.flac')
  assert.equal(info.position, 33)
  assert.equal(info.volume, 0.45)
  assert.equal(harness.playbackCalls(), 0)
})

test('failed service resume is returned once without a second toggle through the synchronous binding', async () => {
  const methods: string[] = []
  const native = {
    Pause: () => methods.push('sync Pause'),
    callAsync: async (method: string) => {
      methods.push(method)
      throw new Error('exclusive device busy')
    }
  } as unknown as NativeAudioBinding
  const manager = new AudioEngineManager({ exclusiveMode: true }, { nativeBinding: native })
  await assert.rejects(manager.togglePause(), /exclusive device busy/)
  assert.deepEqual(methods, ['Pause'])
})

test('failed synchronous resume reaches the caller', async () => {
  let pauses = 0
  const native = {
    Pause: () => {
      pauses++
      throw new Error('exclusive device busy')
    }
  } as unknown as NativeAudioBinding
  const manager = new AudioEngineManager({ exclusiveMode: true }, { nativeBinding: native })
  await assert.rejects(manager.togglePause(), /exclusive device busy/)
  assert.equal(pauses, 1)
})


test('dual-architecture ASIO keeps distinct identities, labels and legacy x64 preference', async () => {
  const x64: AudioDeviceOption = { id: 'asio:{DAC}', name: 'DAC', label: 'DAC (ASIO x64)',
    backend: 'asio', driverArchitecture: 'x64', isDefault: false }
  const x86: AudioDeviceOption = { ...x64, id: 'asio:x86:{DAC}', label: 'DAC (ASIO x86)', driverArchitecture: 'x86' }
  for (const [id, devices, expected] of [
    ['auto', [x86, x64], x64.id], ['asio:DAC', [x86, x64], x64.id],
    ['asio:DAC', [x86], x86.id], [x86.id, [x64, x86], x86.id],
    [x86.id, [x64], x86.id]
  ] as Array<[string, AudioDeviceOption[], string]>) {
    const { manager } = createHarness(
      { exclusiveMode: false, audioOutput: 'asio', audioDevice: id }, devices
    )
    const state = await manager.getAudioOutputState()
    assert.equal(state.device, expected)
    for (const device of devices) {
      const exposed = state.deviceOptions.find(candidate => candidate.id === device.id)
      assert.equal(exposed?.driverArchitecture, device.driverArchitecture)
      assert.equal(exposed?.label, device.label)
    }
  }
})
