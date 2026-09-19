import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { restoreWindowSize } from './windowState.ts'

test('main-process startup creates the window before deferred runtime work', async () => {
  const source = await readFile(new URL('./lifecycle.ts', import.meta.url), 'utf8')
  const createWindowCall = source.indexOf('createMainWindowAndScheduleDeferredStartup()')
  const deferredStartup = source.indexOf("mainWindow.once('ready-to-show'")
  const desktopLyrics = source.indexOf(
    'if (runtime.appSettings.desktopLyrics.enabled) showDesktopLyrics()'
  )
  const engineStartup = source.indexOf('void ensureAudioEngineRuntime().catch')
  const runtimeSettings = source.indexOf('applyRuntimeSettings()')

  assert.notEqual(createWindowCall, -1)
  assert.notEqual(deferredStartup, -1)
  assert.ok(deferredStartup > createWindowCall)
  assert.ok(desktopLyrics > deferredStartup)
  assert.ok(engineStartup > deferredStartup)
  assert.ok(runtimeSettings > deferredStartup)
  assert.doesNotMatch(source, /setupNcmApi\(\)/)
})
test('main window keeps the responsive layout minimum size', async () => {
  const source = await readFile(new URL('./window.ts', import.meta.url), 'utf8')
  assert.match(
    source,
    /restoreWindowSize\(windowState, screen\.getPrimaryDisplay\(\)\.workAreaSize\)/
  )
  assert.deepEqual(restoreWindowSize(undefined, { width: 1920, height: 1080 }), {
    width: 1495,
    height: 883
  })
  assert.deepEqual(
    restoreWindowSize(
      { width: 1000, height: 750, maximized: false },
      { width: 1920, height: 1080 }
    ),
    { width: 1000, height: 750 }
  )
  assert.deepEqual(
    restoreWindowSize({ width: 1900, height: 1000, maximized: true }, { width: 700, height: 600 }),
    { width: 700, height: 600 }
  )
  assert.match(source, /minWidth:\s*Math\.min\(760, screen\.getPrimaryDisplay\(\)\.workAreaSize\./)
  assert.match(source, /minHeight:\s*Math\.min\(692, screen\.getPrimaryDisplay\(\)\.workAreaSize\./)
})

test('windows main window wires taskbar thumbnail buttons separately from native SMTC', async () => {
  const source = await readFile(new URL('./window.ts', import.meta.url), 'utf8')
  assert.match(source, /createTaskbarThumbarButtons/)
  assert.match(source, /destroyTaskbarThumbarButtons/)
  assert.match(source, /integrations\/taskbarThumbar/)
  assert.match(source, /initializeWindowsSmtc/)
  assert.match(source, /destroyWindowsSmtc/)
})
