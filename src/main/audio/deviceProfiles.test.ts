import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { AudioEngineManager } from '../audioEngineManager.ts'
import { createDefaultPlaybackInfo } from './audioEngineHelpers.ts'
import { normalizeOutputConfig } from '../../shared/audioOutputConfig.ts'
import {
  normalizeAudioDeviceProfile,
  normalizeAudioDeviceProfileSettings
} from '../../shared/audioDeviceProfiles.ts'
import type {
  AudioDeviceOption,
  NativeAudioBinding,
  AudioEngineServiceNativeBinding
} from './audioEngineTypes.ts'
import type { DspGraphStatus } from '../../shared/dspGraph.ts'
import type { DeviceProfileCommit } from './deviceProfiles.ts'

function harness(serviceMode = false) {
  const calls: string[] = []
  let devices: AudioDeviceOption[] = [
    { id: 'a', label: 'DAC', isDefault: false },
    { id: 'b', label: 'DAC', isDefault: false },
    { id: 'c', label: 'Speakers', isDefault: false }
  ]
  const info = createDefaultPlaybackInfo('wasapi', 'a', false, normalizeOutputConfig())
  info.volume = 0.7
  let status: DspGraphStatus = {
    revision: 0,
    activeSceneId: null,
    nodes: [],
    totalLatencyFrames: 0,
    totalTailFrames: 0
  }
  let rejectGraph = 0
  let rejectRollback = false
  let rejectUnmute = false
  let rejectCommit = false
  let lastCommit: DeviceProfileCommit | null = null
  const native: NativeAudioBinding = {
    Play: () => {
      info.state = 'playing'
    },
    Pause: () => {
      info.state = 'paused'
    },
    Stop: () => {
      calls.push('stop')
      info.state = 'stopped'
    },
    Seek: () => {},
    SetPlaybackRate: () => {},
    SetVolume: (volume) => {
      calls.push(`volume:${volume}`)
      if (volume > 0 && rejectUnmute) {
        rejectUnmute = false
        throw new Error('unmute rejected')
      }
      info.volume = volume
    },
    SetOutputBackend: (backend) => {
      calls.push(`backend:${backend}`)
      info.outputInfo.actualBackend = backend
      info.actualBackend = backend
    },
    SetOutputDevice: (device) => {
      calls.push(`device:${device}`)
      if (rejectRollback && device === 'a') throw new Error('device lost')
      info.outputInfo.actualDeviceId = device
      info.outputDevice = device
    },
    SetOutputConfig: () => {
      calls.push('config')
    },
    LoadQueue: () => {
      calls.push('queue')
    },
    SetPlayMode: () => {},
    SetDspPluginChain: () => {
      calls.push('chain')
    },
    ApplyDspState: (revision, json) => {
      calls.push('dsp')
      if (rejectGraph > 0) {
        rejectGraph -= 1
        throw new Error('graph rejected')
      }
      const payload = JSON.parse(json)
      status = { ...status, revision, activeSceneId: payload.sceneId, compileState: 'ready' }
    },
    GetDspGraphStatus: () => status,
    GetPlaybackInfo: () => JSON.stringify(info),
    EnumerateDevices: () => devices
  }
  const service = Object.assign(new EventEmitter(), native, {
    callAsync: async (method: string, args: unknown[]) =>
      Reflect.apply(
        native[method as keyof NativeAudioBinding] as (...values: unknown[]) => unknown,
        native,
        args
      ),
    getMetadataAsync: async () => '{}',
    getDspGraphStatusAsync: async () => status,
    applyDspState: async (revision: number, payload: unknown) => {
      native.ApplyDspState(revision, JSON.stringify(payload))
      return status
    },
    applyDspGraph: async () => status,
    destroy: () => {}
  }) as AudioEngineServiceNativeBinding & EventEmitter
  const manager = new AudioEngineManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'a', volume: 0.7 },
    {
      ...(serviceMode ? { audioServiceFactory: () => service } : { nativeBinding: native }),
      deviceOptionsProvider: () => devices,
      persistDeviceProfiles: (commit) => {
        if (rejectCommit && commit.audioDeviceProfiles.activeProfileId) {
          rejectCommit = false
          throw new Error('disk unavailable')
        }
        calls.push(`commit:${commit.audioDeviceProfiles.activeProfileId}`)
        lastCommit = structuredClone(commit)
      },
      scheduler: {
        setInterval: () => ({}) as NodeJS.Timeout,
        clearInterval: () => {},
        setImmediate: (callback) => callback(),
        now: () => 100
      }
    }
  )
  const profile = normalizeAudioDeviceProfile({
    ...manager.getDeviceProfiles().current,
    id: 'headphones',
    name: '耳机',
    stableDeviceId: 'b',
    volumeCeiling: 0.3,
    outputStage: { targetSampleRate: 96000, resamplerQuality: 'high' },
    processing: { dspEnabled: true, dsdOutputMode: 'dop' }
  })!
  return {
    calls,
    manager,
    native,
    service,
    info,
    profile,
    failGraph: (count = 1) => {
      rejectGraph = count
    },
    failRollback: () => {
      rejectRollback = true
    },
    failUnmute: () => {
      rejectUnmute = true
    },
    failCommit: () => {
      rejectCommit = true
    },
    setDevices: (next: AudioDeviceOption[]) => {
      devices = next
    },
    commit: () => lastCommit
  }
}

test('profile applies output then DSP ACK then commits before restoring capped volume', async (t) => {
  const h = harness()
  t.after(() => h.manager.destroy())
  await h.manager.saveDeviceProfile(h.profile)
  h.calls.length = 0
  await h.manager.applyDeviceProfile(h.profile.id)
  assert.deepEqual(
    h.calls.filter((call) => !call.startsWith('volume:')),
    ['backend:wasapi', 'device:b', 'config', 'chain', 'dsp', 'commit:headphones']
  )
  assert.equal(h.calls[0], 'volume:0')
  assert.equal(h.calls.at(-1), 'volume:0.3')
  assert.equal(h.manager.getDeviceProfiles().activeProfileId, 'headphones')
  assert.equal(h.manager.getOutputStage().targetSampleRate, 96000)
  assert.equal(h.manager.getDspSceneState().scenes[0].graph.outputStage.targetSampleRate, 'device')
  await h.manager.setVolume(1)
  assert.equal(h.info.volume, 0.3)
  assert.equal(h.commit()?.softwareVolume, 0.3)
})

test('DSP failure restores old output, scene, ceiling and persisted selection', async (t) => {
  const h = harness()
  t.after(() => h.manager.destroy())
  await h.manager.saveDeviceProfile(h.profile)
  h.failGraph()
  await assert.rejects(h.manager.applyDeviceProfile(h.profile.id), /graph rejected/)
  assert.equal((await h.manager.getAudioOutputState()).device, 'a')
  assert.equal(h.manager.getDeviceProfiles().activeProfileId, null)
  assert.equal(h.manager.getDeviceProfiles().volumeCeiling, 1)
  assert.equal(h.manager.getOutputStage().targetSampleRate, 'device')
  assert.equal(h.info.volume, 0.7)
  assert.equal(h.commit()?.audioDevice, 'a')
})

test('failed rollback stops playback and preserves previous profile authority', async (t) => {
  const h = harness()
  t.after(() => h.manager.destroy())
  await h.manager.saveDeviceProfile(h.profile)
  h.failGraph()
  h.failRollback()
  await assert.rejects(h.manager.applyDeviceProfile(h.profile.id), /播放已停止/)
  assert.ok(h.calls.includes('stop'))
  assert.equal(h.manager.getDeviceProfiles().activeProfileId, null)
  assert.equal(h.commit()?.audioDevice, 'a')
})

test('newer profile requests supersede delayed results without committing the old profile', async (t) => {
  const h = harness()
  t.after(() => h.manager.destroy())
  await h.manager.saveDeviceProfile(h.profile)
  const next = { ...h.profile, id: 'speakers', stableDeviceId: 'c' }
  await h.manager.saveDeviceProfile(next)
  let unblock!: () => void
  let entered!: () => void
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve
  })
  h.native.callAsync = async (method, args) => {
    if (method === 'SetOutputDevice' && args[0] === 'b') {
      entered()
      await blocked
    }
    return (h.native[method as keyof NativeAudioBinding] as (...values: unknown[]) => unknown)(
      ...args
    )
  }
  const first = h.manager.applyDeviceProfile('headphones')
  const firstRejected = assert.rejects(first, /更新的选择/)
  await enteredPromise
  const second = h.manager.applyDeviceProfile('speakers')
  unblock()
  await firstRejected
  await second
  assert.equal(h.calls.includes('commit:headphones'), false)
  assert.equal(h.manager.getDeviceProfiles().activeProfileId, 'speakers')
  assert.equal((await h.manager.getAudioOutputState()).device, 'c')
})

test('missing or ambiguous device identity and deleted scene fail before mute', async (t) => {
  const h = harness()
  t.after(() => h.manager.destroy())
  await h.manager.saveDeviceProfile({ ...h.profile, stableDeviceId: 'missing' })
  h.calls.length = 0
  await assert.rejects(h.manager.applyDeviceProfile(h.profile.id), /未连接/)
  assert.deepEqual(h.calls, [])
  await h.manager.saveDeviceProfile({ ...h.profile, dspSceneId: 'removed' })
  await assert.rejects(h.manager.applyDeviceProfile(h.profile.id), /已删除/)
  await h.manager.saveDeviceProfile(h.profile)
  h.setDevices([
    { id: 'x', platformStableId: 'b', label: 'DAC', isDefault: false },
    { id: 'y', platformStableId: 'b', label: 'DAC', isDefault: false }
  ])
  await assert.rejects(h.manager.applyDeviceProfile(h.profile.id), /多个设备/)
})

test('restart restores ceiling and output-stage override without storing copied graphs', async (t) => {
  const h = harness()
  t.after(() => h.manager.destroy())
  await h.manager.saveDeviceProfile(h.profile)
  await h.manager.applyDeviceProfile(h.profile.id)
  const settings = normalizeAudioDeviceProfileSettings(
    JSON.parse(JSON.stringify(h.commit()?.audioDeviceProfiles))
  )
  const restored = new AudioEngineManager(
    { exclusiveMode: false, volume: 0.9, audioDeviceProfiles: settings },
    { nativeBinding: null }
  )
  t.after(() => restored.destroy())
  assert.equal(restored.getDeviceProfiles().activeProfileId, h.profile.id)
  assert.equal(restored.getOutputStage().targetSampleRate, 96000)
  assert.equal((await restored.getPlaybackInfo()).volume, 0.3)
  assert.equal((await restored.getPlaybackInfo()).state, 'stopped')
})

test('automatic binding runs only when a unique matching device reconnects', async (t) => {
  const h = harness()
  t.after(() => h.manager.destroy())
  await h.manager.saveDeviceProfile({ ...h.profile, autoApply: true })
  h.setDevices([{ id: 'a', label: 'DAC', isDefault: false }])
  h.manager.notifyAudioDeviceOptionsChanged()
  h.setDevices([
    { id: 'a', label: 'DAC', isDefault: false },
    { id: 'b', label: 'DAC', isDefault: false }
  ])
  h.manager.notifyAudioDeviceOptionsChanged()
  await h.manager.setVolume(0.2)
  assert.equal(h.manager.getDeviceProfiles().activeProfileId, h.profile.id)
  await h.manager.saveDeviceProfile({ ...h.profile, id: 'duplicate', autoApply: true })
  h.setDevices([{ id: 'a', label: 'DAC', isDefault: false }])
  h.manager.notifyAudioDeviceOptionsChanged()
  h.setDevices([{ id: 'b', label: 'DAC', isDefault: false }])
  h.manager.notifyAudioDeviceOptionsChanged()
  assert.match(h.manager.getDeviceProfiles().error, /多个设备档案/)
})

test('failed persistence or unmute restores the previously committed settings', async (t) => {
  for (const failure of ['failCommit', 'failUnmute'] as const) {
    const h = harness()
    t.after(() => h.manager.destroy())
    await h.manager.saveDeviceProfile(h.profile)
    h[failure]()
    await assert.rejects(h.manager.applyDeviceProfile(h.profile.id))
    assert.equal(h.commit()?.audioDeviceProfiles.activeProfileId, null)
    assert.equal(h.commit()?.audioDevice, 'a')
    assert.equal(h.info.volume, 0.7)
  }
})

test('service recovery restores a committed profile and queue in order without resuming', async (t) => {
  const h = harness(true)
  t.after(() => h.manager.destroy())
  h.manager.setNativeDspPluginChain('{"plugins":[]}')
  await h.manager.loadQueue([{ id: 'song', source: 'song.flac' }])
  await h.manager.saveDeviceProfile(h.profile)
  await h.manager.applyDeviceProfile(h.profile.id)
  h.calls.length = 0
  h.service.emit('crash', 'test crash')
  const ready = new Promise<{ manualResumeRequired: boolean; outputRouteSynced: boolean }>(
    (resolve) => h.manager.once('audio-service-ready', resolve)
  )
  h.service.emit('ready')
  const result = await ready
  assert.equal(result.manualResumeRequired, true)
  assert.equal(result.outputRouteSynced, true)
  assert.deepEqual(h.calls.slice(0, 6), [
    'backend:wasapi',
    'device:b',
    'config',
    'chain',
    'dsp',
    'queue'
  ])
  assert.equal(h.manager.getDeviceProfiles().activeProfileId, h.profile.id)
  assert.equal(h.manager.getOutputStage().targetSampleRate, 96000)
  assert.equal(h.info.volume, 0.3)
  assert.equal((await h.manager.getPlaybackInfo()).state, 'stopped')
})

test('a crash during the DSP ACK invalidates the profile before serialized recovery', async (t) => {
  const h = harness(true)
  t.after(() => h.manager.destroy())
  await h.manager.saveDeviceProfile(h.profile)
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const atDsp = new Promise<void>((resolve) => {
    entered = resolve
  })
  const applyDsp = h.service.applyDspState
  h.service.applyDspState = async (...args) => {
    entered()
    await blocked
    return applyDsp(...args)
  }
  const applying = h.manager.applyDeviceProfile(h.profile.id)
  const rejected = assert.rejects(applying, /service restarted/)
  await atDsp
  h.service.emit('crash', 'mid-apply crash')
  const ready = new Promise<void>((resolve) =>
    h.manager.once('audio-service-ready', () => resolve())
  )
  h.service.emit('ready')
  release()
  await rejected
  await ready
  assert.equal(h.manager.getDeviceProfiles().activeProfileId, null)
  assert.equal((await h.manager.getAudioOutputState()).device, 'a')
  assert.equal(h.manager.getOutputStage().targetSampleRate, 'device')
  assert.equal(h.info.volume, 0.7)
  assert.equal(h.calls.includes('commit:headphones'), false)
})

test('selection remains authoritative until unmute completes', async (t) => {
  const h = harness()
  t.after(() => h.manager.destroy())
  await h.manager.saveDeviceProfile(h.profile)
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const atUnmute = new Promise<void>((resolve) => {
    entered = resolve
  })
  h.native.callAsync = async (method, args) => {
    if (method === 'SetVolume' && args[0] === 0.3) {
      entered()
      await blocked
    }
    return Reflect.apply(
      h.native[method as keyof NativeAudioBinding] as (...values: unknown[]) => unknown,
      h.native,
      args
    )
  }
  const applying = h.manager.applyDeviceProfile(h.profile.id)
  await atUnmute
  assert.equal(h.manager.getDeviceProfiles().activeProfileId, null)
  assert.equal(h.manager.getDeviceProfiles().phase, 'applying')
  release()
  await applying
  assert.equal(h.manager.getDeviceProfiles().activeProfileId, h.profile.id)
})

test('DSD route ACK accepts the configured secondary route only with matching native evidence', async (t) => {
  for (const reportedDevice of ['c', 'unexpected']) {
    const h = harness()
    t.after(() => h.manager.destroy())
    h.info.state = 'playing'
    h.info.source = 'song.dsf'
    h.info.outputInfo.isDsd = true
    await h.manager.play('song.dsf')
    const profile = normalizeAudioDeviceProfile({
      ...h.profile,
      processing: {
        ...h.profile.processing,
        dsdRoute: { enabled: true, backend: 'wasapi', device: 'c' }
      }
    })!
    await h.manager.saveDeviceProfile(profile)
    const applyDsp = h.native.ApplyDspState
    h.native.ApplyDspState = (...args) => {
      applyDsp(...args)
      h.info.outputInfo.actualDeviceId = 'c'
      h.info.outputInfo.diagnostics.dsdRouteOverrideActive = true
      h.info.outputInfo.diagnostics.dsdRouteBackend = 'wasapi'
      h.info.outputInfo.diagnostics.dsdRouteDevice = reportedDevice
    }
    if (reportedDevice === 'c') {
      await h.manager.applyDeviceProfile(profile.id)
      assert.equal(h.manager.getDeviceProfiles().activeProfileId, profile.id)
      assert.equal((await h.manager.getAudioOutputState()).device, 'b')
      assert.equal((await h.manager.getPlaybackInfo()).outputInfo.actualDeviceId, 'c')
    } else {
      await assert.rejects(h.manager.applyDeviceProfile(profile.id), /target output route/)
      assert.equal(h.manager.getDeviceProfiles().activeProfileId, null)
    }
  }
})
