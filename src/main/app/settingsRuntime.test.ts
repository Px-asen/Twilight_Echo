import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

function deferred() {
  let resolve!: (accepted: boolean) => void
  const promise = new Promise<boolean>((done) => (resolve = done))
  return { promise, resolve }
}

function harness(setAutoMixMode: () => Promise<boolean>, engine: Record<string, unknown> = {}) {
  const persisted: Record<string, unknown>[] = []
  const runtime = {
    appSettings: {
      autoMixMode: 'off',
      theme: 'light',
      libraryFolders: [],
      audioOutput: 'wasapi',
      audioDevice: 'working-device',
      audioExclusiveMode: false,
      audioOutputConfig: { bufferFrames: 512 }
    },
    launchSettings: {},
    audioEngineManager: { setAutoMixMode, ...engine }
  }
  const dependencies: Record<string, unknown> = {
    electron: {},
    '../core/runtime': { runtime },
    '../../shared/twilightAutoMix.ts': { effectiveAutoMixMode: (mode: unknown) => mode },
    '../core/settings': {
      normalizeAppSettings: (settings: unknown) => settings,
      writeAppSettings: (settings: Record<string, unknown>) => persisted.push({ ...settings }),
      createSettingsSnapshot: (settings: unknown) => ({ settings })
    },
    '../audio/state.ts': {},
    './windowAppearance.ts': {},
    '../cache/ncmCache': {},
    '../integrations/discord': {},
    '../integrations/miniPlayer': {},
    '../integrations/desktopLyrics': {},
    '../integrations/shortcutsTray': { applyRuntimeSettings() {} },
    './AfterglowModeService.ts': { reassertAfterglowShortcuts() {} },
    '../library/watcher': {}
  }
  const exports: {
    updateAppSettings?: (patch: Record<string, unknown>) => Promise<unknown>
  } = {}
  runInNewContext(
    ts.transpileModule(readFileSync(new URL('./settingsRuntime.ts', import.meta.url), 'utf8'), {
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
  return { runtime, persisted, update: exports.updateAppSettings! }
}

test('overlapping settings updates retain both patches while audio acknowledgement is pending', async () => {
  const audio = deferred()
  const { runtime, persisted, update } = harness(() => audio.promise)
  const first = update({ autoMixMode: 'auto' })
  const second = update({ theme: 'dark' })
  audio.resolve(true)
  await Promise.all([first, second])
  assert.equal(runtime.appSettings.autoMixMode, 'auto')
  assert.equal(runtime.appSettings.theme, 'dark')
  assert.equal(persisted.at(-1)?.theme, 'dark')
  assert.equal(persisted.at(-1)?.autoMixMode, 'auto')
})

test('a rejected settings update releases the next update without applying the rejected patch', async () => {
  const audio = deferred()
  const { runtime, persisted, update } = harness(() => audio.promise)
  const first = update({ autoMixMode: 'auto' })
  const rejected = assert.rejects(first, /AutoMix/)
  const second = update({ theme: 'dark' })
  audio.resolve(false)
  await rejected
  await second
  assert.equal(runtime.appSettings.autoMixMode, 'off')
  assert.equal(runtime.appSettings.theme, 'dark')
  assert.equal(persisted.length, 1)
})

const outputState = {
  output: 'wasapi',
  device: 'working-device',
  exclusiveMode: false,
  exclusiveAvailable: true
}

for (const [name, patch, engine] of [
  [
    'device',
    { audioDevice: 'rejected-device' },
    {
      setAudioDevice: async () => {
        throw new Error('rejected device')
      }
    }
  ],
  [
    'output',
    { audioOutput: 'rejected-output' },
    {
      setAudioOutput: async () => {
        throw new Error('rejected output')
      }
    }
  ],
  [
    'exclusive mode',
    { audioExclusiveMode: true },
    {
      getAudioOutputState: async () => outputState,
      setExclusiveMode: async () => {
        throw new Error('rejected exclusive mode')
      }
    }
  ],
  [
    'output config',
    { audioOutputConfig: { bufferFrames: 1024 } },
    {
      setOutputConfig: async () => {
        throw new Error('rejected output config')
      }
    }
  ]
] as const) {
  test(`a rejected ${name} is not published or persisted by the following queued update`, async () => {
    const { runtime, persisted, update } = harness(async () => true, engine)
    const previous = { ...runtime.appSettings }
    const rejected = assert.rejects(update(patch), /rejected/)
    const following = update({ theme: 'dark' })
    await rejected
    await following
    assert.deepEqual({ ...runtime.appSettings }, { ...previous, theme: 'dark' })
    assert.deepEqual(persisted, [{ ...previous, theme: 'dark' }])
  })
}

test('device preferences remain unpublished until the engine acknowledges its effective selection', async () => {
  let finish!: (state: typeof outputState) => void
  const pending = new Promise<typeof outputState>((resolve) => {
    finish = resolve
  })
  const { runtime, persisted, update } = harness(async () => true, {
    setAudioDevice: () => pending
  })
  const first = update({ audioDevice: 'requested-device' })
  await Promise.resolve()
  assert.equal(runtime.appSettings.audioDevice, 'working-device')
  assert.equal(persisted.length, 0)
  finish({ ...outputState, device: 'effective-device' })
  await first
  assert.equal(runtime.appSettings.audioDevice, 'effective-device')
  assert.equal(persisted[0]?.audioDevice, 'effective-device')
})

test('engine callbacks that customize the active device profile survive the acknowledged patch', async () => {
  const { runtime, persisted, update } = harness(async () => true)
  const settings = runtime.appSettings as typeof runtime.appSettings & {
    audioDeviceProfiles?: { activeProfileId: string | null }
    softwareVolume?: number
    audioProcessing?: { replayGainMode: string }
  }
  settings.audioDeviceProfiles = { activeProfileId: 'saved-profile' }
  runtime.audioEngineManager = {
    ...runtime.audioEngineManager,
    ...{
      setAudioDevice: async () => {
        // AudioEngineManager.customized() persists a profile commit before returning.
        Object.assign(runtime, {
          appSettings: {
            ...runtime.appSettings,
            audioDeviceProfiles: { activeProfileId: null },
            softwareVolume: 0.6,
            audioProcessing: { replayGainMode: 'track' }
          }
        })
        return { ...outputState, device: 'effective-device' }
      }
    }
  }
  await update({ audioDevice: 'requested-device' })
  assert.equal(persisted.at(-1)?.audioDevice, 'effective-device')
  assert.deepEqual(persisted.at(-1)?.audioDeviceProfiles, { activeProfileId: null })
  assert.equal(persisted.at(-1)?.softwareVolume, 0.6)
  assert.deepEqual(persisted.at(-1)?.audioProcessing, { replayGainMode: 'track' })
})
