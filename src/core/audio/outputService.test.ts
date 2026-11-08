import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CoreSettingsRepository } from '../persistence/settingsRepository.ts'
import { AudioEngineManager } from '../../main/audioEngineManager.ts'
import { CoreAudioOutputService } from './outputService.ts'
import { createDefaultPlaybackInfo, normalizeOutputConfig } from './audioEngineHelpers.ts'
import { coreAudioConfiguration, createCoreAudioPersistence } from './settings.ts'
import type { NativeAudioBinding } from './audioEngineTypes.ts'

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'core-output-'))
  let changed = 0
  const settings = new CoreSettingsRepository({
    filePath: join(root, 'settings.json'),
    environment: { platform: 'win32', defaultCachePath: join(root, 'cache'), resolvePath: resolve },
    initial: { audioDevice: 'a', softwareVolume: 0.5 },
    changed: () => output?.changed()
  })
  const persistence = createCoreAudioPersistence(settings)
  const events: string[] = []
  let nativeConfig: { releaseExclusiveOnPause?: boolean } = {}
  const info = createDefaultPlaybackInfo('wasapi', 'a', false, normalizeOutputConfig())
  info.volume = 0.5
  let revision = 0
  let failUnmute = false
  let failPersistence = false
  let failRollback = false
  let inspectUnmute: (() => void) | undefined
  const native = {
    GetPlaybackInfo: () => JSON.stringify(info),
    GetLastError: () => '',
    SetOutputBackend: (backend: string) => {
      info.outputBackend = backend
      events.push(`backend:${backend}`)
    },
    SetOutputDevice: (device: string) => {
      events.push(`device:${device}`)
      if (failRollback && device === 'a') throw new Error('old device disappeared')
      info.outputDevice = device
    },
    SetOutputConfig: (json: string) => {
      nativeConfig = JSON.parse(json)
      events.push('config')
    },
    SetVolume: (volume: number) => {
      events.push(`volume:${volume}`)
      if (volume > 0) {
        inspectUnmute?.()
        if (failUnmute) {
          failUnmute = false
          throw new Error('unmute failed')
        }
      }
    },
    Stop: () => {
      info.state = 'stopped'
      events.push('stop')
    },
    SetDspConfig: () => {},
    ApplyDspState: (value: number) => {
      revision = value
    },
    GetDspGraphStatus: () => JSON.stringify({ revision, nodes: [], compileState: 'ready' })
  } as unknown as NativeAudioBinding
  const manager = new AudioEngineManager(coreAudioConfiguration(settings.read()), {
    platform: 'win32',
    nativeBinding: native,
    persistAudioOutput: (commit) => {
      events.push(`persist:${commit.audioDevice}`)
      if (failPersistence && commit.audioDevice !== 'a') throw new Error('disk full')
      persistence.output(commit)
    },
    persistDeviceProfiles: persistence.profile,
    deviceOptionsProvider: () => [
      { id: 'a', label: 'DAC A', isDefault: false, backend: 'wasapi' },
      { id: 'b', label: 'DAC B', isDefault: false, backend: 'wasapi' }
    ]
  })
  const output: CoreAudioOutputService = new CoreAudioOutputService({
    engine: manager,
    settings,
    changed: () => changed++
  })
  t.after(() => {
    manager.destroy()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    manager,
    output,
    settings,
    root,
    events,
    nativeConfig: () => nativeConfig,
    changed: () => changed,
    persisted: () => JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')),
    failPersistence: () => {
      failPersistence = true
    },
    failUnmute: () => {
      failUnmute = true
    },
    failRollback: () => {
      failRollback = true
    },
    inspectUnmute: (inspect: () => void) => {
      inspectUnmute = inspect
    }
  }
}
const signal = () => new AbortController().signal

test('output ACK persists synchronously before unmute without any renderer', async (t) => {
  const f = fixture(t)
  f.inspectUnmute(() => assert.equal(f.persisted().audioDevice, 'b'))
  await f.output.edit({ revision: 0, edit: { kind: 'device', device: 'b' } }, signal())
  assert.equal((await f.output.state()).output.device, 'b')
  assert.equal(f.settings.read().audioDevice, 'b')
  assert.equal(f.events.includes('stop'), false)
  assert(f.events.indexOf('persist:b') < f.events.indexOf('volume:0.5'))
})

test('unmute failure rolls native route and the same settings repository back', async (t) => {
  const f = fixture(t)
  f.failUnmute()
  await assert.rejects(
    f.output.edit({ revision: 0, edit: { kind: 'device', device: 'b' } }, signal()),
    /unmute failed/
  )
  assert.equal((await f.output.state()).output.device, 'a')
  assert.equal(f.settings.read().audioDevice, 'a')
  assert.equal(f.persisted().audioDevice, 'a')
  assert(f.events.includes('persist:b') && f.events.includes('persist:a'))
})

test('failed publication restores the old route; failed rollback safely stops', async (t) => {
  const f = fixture(t)
  f.failPersistence()
  await assert.rejects(
    f.output.edit({ revision: 0, edit: { kind: 'device', device: 'b' } }, signal()),
    /disk full/
  )
  assert.equal((await f.output.state()).output.device, 'a')
  assert.equal(f.settings.read().audioDevice, 'a')
  assert(!f.events.includes('stop'))
  f.failRollback()
  await assert.rejects(
    f.output.edit(
      { revision: f.output.getRevision(), edit: { kind: 'device', device: 'b' } },
      signal()
    ),
    /旧配置恢复失败/
  )
  assert(f.events.includes('stop'))
})

test('concurrent edits reject stale revisions and cancellation before dispatch never touches native', async (t) => {
  const f = fixture(t)
  const first = f.output.edit({ revision: 0, edit: { kind: 'device', device: 'b' } }, signal())
  const second = f.output.edit(
    { revision: 0, edit: { kind: 'exclusive', enabled: true } },
    signal()
  )
  await first
  await assert.rejects(second, { code: 'STALE_REVISION' })
  const before = f.events.length
  const abort = new AbortController()
  abort.abort(new Error('client left'))
  await assert.rejects(
    f.output.edit(
      { revision: f.output.getRevision(), edit: { kind: 'device', device: 'a' } },
      abort.signal
    ),
    /client left/
  )
  assert.equal(f.events.length, before)
  const view = await f.output.state()
  view.output.device = 'client-owned-draft'
  assert.equal((await f.output.state()).output.device, 'b')
})

test('config, exclusive policy and device profiles share the existing full settings repository', async (t) => {
  const f = fixture(t)
  const edit = (value: Parameters<CoreAudioOutputService['edit']>[0]['edit']) =>
    f.output.edit({ revision: f.output.getRevision(), edit: value }, signal())
  await edit({ kind: 'config', config: { preferredBufferSize: 512, routingMode: 'stereo-to-5.1' } })
  await edit({ kind: 'exclusive', enabled: true })
  await edit({ kind: 'autoRelease', enabled: true })
  const profile = f.manager.getDeviceProfiles().current
  profile.id = 'desk-dac'
  profile.name = 'Desk DAC'
  await f.output.editProfiles(
    { revision: f.output.getRevision(), edit: { kind: 'save', profile } },
    signal()
  )
  assert.equal(f.settings.read().audioOutputConfig.preferredBufferSize, 512)
  assert.equal(f.settings.read().audioExclusiveMode, true)
  assert.equal(f.settings.read().audioExclusiveAutoRelease, true)
  assert.equal(f.persisted().audioExclusiveAutoRelease, true)
  assert.equal((await f.output.state()).exclusiveAutoRelease, true)
  assert.equal(f.nativeConfig().releaseExclusiveOnPause, true)
  assert.equal(f.settings.read().audioDeviceProfiles.profiles[0].id, 'desk-dac')
  assert.equal((await f.output.profiles()).profiles.profiles.length, 1)
  assert(f.changed() > 0)
  await edit({ kind: 'autoRelease', enabled: false })
  assert.equal(f.persisted().audioExclusiveAutoRelease, false)
  assert.equal((await f.output.state()).exclusiveAutoRelease, false)
  assert.equal(f.nativeConfig().releaseExclusiveOnPause, false)
})

test('quit joins native configuration work started outside a client request before final persistence', async (t) => {
  const f = fixture(t)
  let entered!: () => void
  let release!: () => void
  const atDevice = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  // Exercise the manager's real lane, also used by automatic hotplug/profile changes.
  const native = (f.manager as unknown as { native: NativeAudioBinding }).native
  native.callAsync = async (method, args) => {
    if (method === 'SetOutputDevice' && args[0] === 'b') {
      entered()
      await blocked
    }
    return Reflect.apply(
      native[method as keyof NativeAudioBinding] as (...args: unknown[]) => unknown,
      native,
      args
    )
  }
  const changing = f.manager.setAudioDevice('b')
  await atDevice
  let finished = false
  const closing = f.output.shutdown().then(() => {
    finished = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(finished, false)
  release()
  await changing
  await closing
  assert.equal(f.persisted().audioDevice, 'b')
})
