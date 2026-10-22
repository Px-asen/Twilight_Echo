import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

test('stem enable and device changes publish new preferences before cancelling old preparation', async () => {
  const cancelled: unknown[] = [],
    persisted: unknown[] = [],
    broadcasts: unknown[] = []
  const runtime = {
    appSettings: { autoMixStemMode: 'auto', autoMixStemDevice: 'auto' },
    launchSettings: {},
    audioEngineManager: {
      invalidateAutoMixSource: () => cancelled.push({ ...runtime.appSettings })
    },
    mainWindow: {
      webContents: { send: (_channel: string, snapshot: unknown) => broadcasts.push(snapshot) }
    }
  }
  const dependencies: Record<string, unknown> = {
    electron: {},
    '../core/runtime': { runtime },
    '../../shared/twilightAutoMix.ts': {},
    '../core/settings': {
      normalizeAppSettings: (settings: unknown) => settings,
      writeAppSettings: (settings: unknown) => persisted.push(settings),
      createSettingsSnapshot: (settings: unknown) => ({ settings })
    },
    '../integrations/miniPlayer': {},
    '../integrations/desktopLyrics': {},
    '../integrations/shortcutsTray': { applyRuntimeSettings() {} },
    './AfterglowModeService.ts': { reassertAfterglowShortcuts() {} },
    '../audio/state.ts': {},
    './windowAppearance.ts': {},
    '../cache/ncmCache': {},
    '../integrations/discord': {},
    '../library/watcher': {}
  }
  const exports: { updateAppSettings?: (patch: Record<string, unknown>) => Promise<unknown> } = {}
  runInNewContext(
    ts.transpileModule(readFileSync(new URL('./settingsRuntime.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      exports,
      require: (id: string) => {
        assert.ok(id in dependencies)
        return dependencies[id]
      },
      console,
      process
    }
  )
  await exports.updateAppSettings!({ autoMixStemDevice: 'cpu' })
  await exports.updateAppSettings!({ autoMixStemMode: 'off' })
  await exports.updateAppSettings!({ autoMixStemDevice: 'gpu', autoMixStemMode: 'auto' })
  assert.deepEqual(JSON.parse(JSON.stringify(cancelled)), [
    { autoMixStemMode: 'auto', autoMixStemDevice: 'cpu' },
    { autoMixStemMode: 'off', autoMixStemDevice: 'cpu' },
    { autoMixStemMode: 'auto', autoMixStemDevice: 'gpu' }
  ])
  assert.equal(persisted.length, 3)
  assert.equal(broadcasts.length, 3)
  await exports.updateAppSettings!({ autoMixStemCacheMiB: 256 })
  assert.equal(cancelled.length, 3, 'cache capacity changes must not cancel an active transition')
})
