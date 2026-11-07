import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

test('changing only motionPreference updates open lyrics and tray windows without restarting them', async () => {
  const sent: Array<[string, string]> = []
  const lyrics: string[] = []
  const mini: string[] = []
  let destroyed = false
  const window = (name: string) => ({
    isDestroyed: () => destroyed,
    webContents: {
      isDestroyed: () => destroyed,
      send: (channel: string, snapshot: { settings: { motionPreference: string } }) => {
        assert.equal(channel, 'settings:changed')
        sent.push([name, snapshot.settings.motionPreference])
      }
    }
  })
  const runtime = {
    appSettings: { motionPreference: 'full' },
    launchSettings: {},
    mainWindow: window('main'),
    desktopLyricsWindow: window('lyrics'),
    trayPlayerWindow: window('tray')
  }
  const dependencies: Record<string, unknown> = {
    '../coreProcess/settingsBridge.ts': { getCoreSettingsBridge: () => null },
    electron: {},
    '../core/runtime': { runtime },
    '../../shared/twilightAutoMix.ts': {},
    '../core/settings': {
      normalizeAppSettings: (settings: unknown) => settings,
      writeAppSettings() {},
      createSettingsSnapshot: (settings: unknown) => ({ settings })
    },
    '../integrations/miniPlayer': {
      applyMiniPlayerMotionPreferenceFromApp: (mode: string) => mini.push(mode)
    },
    '../integrations/desktopLyrics': {
      syncDesktopLyricsSettings: () => lyrics.push(runtime.appSettings.motionPreference)
    },
    '../integrations/shortcutsTray': { applyRuntimeSettings() {} },
    './AfterglowModeService.ts': { reassertAfterglowShortcuts() {} },
    '../audio/state.ts': {},
    './windowAppearance.ts': {},
    '../cache/ncmCache': {},
    '../integrations/discord': {},
    '../library/watcher': {}
  }
  const exports: { updateAppSettings?: (patch: { motionPreference: string }) => Promise<unknown> } =
    {}
  const code = ts.transpileModule(
    readFileSync(new URL('./settingsRuntime.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }
  ).outputText
  runInNewContext(code, {
    exports,
    require: (id: string) => {
      assert.ok(id in dependencies, `unexpected dependency ${id}`)
      return dependencies[id]
    },
    console,
    process
  })
  for (const motionPreference of ['off', 'reduced', 'full']) {
    await exports.updateAppSettings!({ motionPreference })
  }
  assert.deepEqual(lyrics, ['off', 'reduced', 'full'])
  assert.deepEqual(mini, ['off', 'reduced', 'full'])
  assert.deepEqual(
    sent.filter(([window]) => window === 'tray').map(([, mode]) => mode),
    ['off', 'reduced', 'full']
  )
  destroyed = true
  await exports.updateAppSettings!({ motionPreference: 'off' })
  assert.equal(lyrics.length, 3, 'do not send to destroyed lyrics windows')
  assert.equal(
    sent.filter(([window]) => window === 'tray').length,
    3,
    'do not send to destroyed tray windows'
  )
})
