import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { EventEmitter } from 'node:events'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import type { BrowserWindow } from 'electron'
import { installWindowCloseShortcut } from './windowShortcuts.ts'
import test from 'node:test'
import { readWindowState, restoreWindowSize, saveWindowState } from './windowState.ts'
import { getWindowBackgroundColor, syncWindowFrameAppearance } from './windowAppearance.ts'
import { closePersistenceDialogOptions } from './closePersistence.ts'
import { resolveLocale } from '../../shared/i18n/locale.ts'

test('the shared quit failure dialog handles live, absent and destroyed main windows', async () => {
  const source = await readFile(new URL('./window.ts', import.meta.url), 'utf8')
  const calls: unknown[][] = []
  let response = 0
  const context = {
    closePersistenceDialogOptions,
    resolveLocale,
    runtime: { appSettings: { language: 'zh-CN' } },
    app: { getLocale: () => 'en-US' },
    console: { error() {} },
    dialog: {
      showMessageBox: async (...args: unknown[]) => {
        calls.push(args)
        return { response }
      }
    },
    showClosePersistenceFailure: undefined as
      | undefined
      | ((win: unknown, error: Error) => Promise<string>)
  }
  runInNewContext(
    stripTypeScriptTypes(
      source
        .slice(
          source.indexOf('export async function showClosePersistenceFailure'),
          source.indexOf('export function getAppIconPath')
        )
        .replace(/^export /, '')
    ),
    context
  )
  const show = context.showClosePersistenceFailure!
  const win = { isDestroyed: () => false }
  const error = new Error('Core did not confirm final persistence')
  assert.equal(await show(win, error), 'retry')
  assert.equal(calls[0][0], win)
  assert.equal((calls[0][1] as { title: string }).title, '退出前保存失败')
  response = 2
  assert.equal(await show(null, error), 'force')
  assert.equal(calls[1].length, 1)
  response = 1
  assert.equal(await show({ isDestroyed: () => true }, error), 'cancel')
  assert.equal(calls[2].length, 1)
})

test('Ctrl/Cmd+W obeys live preferences while suppressing the default menu close', () => {
  const webContents = new EventEmitter()
  let enabled = true
  let closes = 0
  let prevented = 0
  const win = { webContents, close: () => closes++ } as unknown as BrowserWindow
  installWindowCloseShortcut(win, () => enabled)
  const input = {
    type: 'keyDown',
    key: 'w',
    control: process.platform !== 'darwin',
    meta: process.platform === 'darwin',
    alt: false,
    shift: false,
    isAutoRepeat: false,
    isComposing: false
  }
  const press = (patch = {}) =>
    webContents.emit(
      'before-input-event',
      { preventDefault: () => prevented++ },
      { ...input, ...patch }
    )
  press()
  assert.equal(closes, 1)
  enabled = false
  press()
  assert.equal(closes, 1)
  assert.equal(prevented, 2)
  enabled = true
  press({ type: 'keyUp' })
  press({ isAutoRepeat: true })
  press({ isComposing: true })
  assert.equal(closes, 1)
  const previousPrevented = prevented
  for (const patch of [
    { shift: true },
    { alt: true },
    { key: 'q' },
    { control: false, meta: false }
  ])
    press(patch)
  assert.equal(prevented, previousPrevented)
  assert.equal(closes, 1)
  press({ key: 'W' })
  assert.equal(closes, 2)
})

test('macOS Cmd+W uses the window close policy and leaves Cmd+Q to the application menu', async () => {
  const source = await readFile(new URL('./windowShortcuts.ts', import.meta.url), 'utf8')
  const calls: string[] = []
  const webContents = new EventEmitter()
  const context = {
    process: { platform: 'darwin' },
    installWindowCloseShortcut: undefined as typeof installWindowCloseShortcut | undefined
  }
  runInNewContext(
    stripTypeScriptTypes(source.slice(source.indexOf('export function')).replace(/^export /, '')),
    context
  )
  const win = { webContents, close: () => calls.push('close') } as unknown as BrowserWindow
  context.installWindowCloseShortcut!(win, () => true)
  const press = (key: string, meta = true, control = false) =>
    webContents.emit(
      'before-input-event',
      { preventDefault: () => calls.push('prevent') },
      { type: 'keyDown', key, meta, control, alt: false, shift: false }
    )
  press('w')
  assert.deepEqual(calls, ['prevent', 'close'])
  calls.length = 0
  press('q')
  press('w', false, true)
  assert.deepEqual(calls, [])
})

test('main-process startup creates the window before deferred runtime work', async () => {
  const source = await readFile(new URL('./lifecycle.ts', import.meta.url), 'utf8')
  const createWindowCall = source.indexOf('createMainWindowAndScheduleDeferredStartup()')
  const deferredStartup = source.indexOf("mainWindow.once('ready-to-show'")
  const desktopLyrics = source.indexOf(
    'if (runtime.appSettings.desktopLyrics.enabled) showDesktopLyrics()'
  )
  const engineStartup = source.indexOf('ensureAudioEngineRuntime()')
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

test('window state preserves fullscreen separately from maximization and accepts older saved bounds', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-fullscreen-state-'))
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  })
  const file = join(directory, 'window-state.json')
  await writeFile(file, JSON.stringify({ width: 1000, height: 750, maximized: true }))
  assert.deepEqual(readWindowState(file), {
    width: 1000,
    height: 750,
    maximized: true,
    fullScreen: false
  })
  const state = { width: 1000, height: 750, maximized: false, fullScreen: true }
  saveWindowState(file, state)
  assert.deepEqual(readWindowState(file), state)
  assert.deepEqual(restoreWindowSize(readWindowState(file), { width: 1920, height: 1080 }), {
    width: 1000,
    height: 750
  })
})

test('recreated windows show before restoring native fullscreen and retain their normal window size', async () => {
  const source = await readFile(new URL('./window.ts', import.meta.url), 'utf8')
  const start = source.indexOf("  runtime.mainWindow.on('ready-to-show'")
  const handler = source.slice(start, source.indexOf('  clearHiddenMainWindowUnloadTimer()', start))
  for (const fullScreen of [false, true]) {
    const calls: unknown[] = []
    const win = Object.assign(new EventEmitter(), {
      maximize: () => calls.push('maximize'),
      show: () => calls.push('show'),
      setFullScreen: (value: boolean) => calls.push(['fullscreen', value])
    })
    const context = {
      runtime: { mainWindow: win },
      awaitingAfterglowHandoff: true,
      windowState: { width: 1000, height: 750, maximized: true, fullScreen }
    }
    runInNewContext(stripTypeScriptTypes(handler), context)
    win.emit('ready-to-show')
    assert.deepEqual(
      calls,
      fullScreen ? ['maximize', 'show', ['fullscreen', true]] : ['maximize', 'show']
    )
    assert.equal(context.awaitingAfterglowHandoff, false)
  }
})

test('windows main window wires taskbar thumbnail buttons separately from native SMTC', async () => {
  const source = await readFile(new URL('./window.ts', import.meta.url), 'utf8')
  assert.match(source, /createTaskbarThumbarButtons/)
  assert.match(source, /destroyTaskbarThumbarButtons/)
  assert.match(source, /integrations\/taskbarThumbar/)
  assert.match(source, /initializeWindowsSmtc/)
  assert.match(source, /destroyWindowsSmtc/)
  const setup = source.slice(
    source.indexOf(
      "if (process.platform === 'win32') {",
      source.indexOf('installAudioDeviceHotplugWatcher(runtime.mainWindow)')
    )
  )
  assert.ok(setup.indexOf('createTaskbarThumbarButtons()') > setup.indexOf('rebindWindowsSmtc()'))
  assert.ok(
    setup.indexOf('createTaskbarThumbarButtons()') > setup.indexOf('initializeWindowsSmtc()')
  )
})

test('explicit light/dark backgrounds are independent of the system theme', () => {
  const backgrounds = { global: { dark: '#111111', light: '#eeeeee' } }
  for (const systemDark of [false, true]) {
    assert.equal(
      getWindowBackgroundColor({ theme: 'dark', appBackground: backgrounds }, systemDark),
      '#111111'
    )
    assert.equal(
      getWindowBackgroundColor({ theme: 'pureWhite', appBackground: backgrounds }, systemDark),
      '#eeeeee'
    )
  }
})

test('system theme follows the current native preference without importing audio runtime', () => {
  const settings: Parameters<typeof getWindowBackgroundColor>[0] = {
    theme: 'system',
    appBackground: { global: { dark: '#111111', light: '#eeeeee' } }
  }
  assert.equal(getWindowBackgroundColor(settings, true), '#111111')
  assert.equal(getWindowBackgroundColor(settings, false), '#eeeeee')
})

test(
  'Windows frame disables forced accents and restores them after leaving high contrast',
  {
    skip: process.platform !== 'win32'
  },
  () => {
    const colors: (string | boolean | null)[] = []
    const win = { setAccentColor: (color: string | boolean | null) => colors.push(color) }
    syncWindowFrameAppearance(win, false)
    syncWindowFrameAppearance(win, true)
    syncWindowFrameAppearance(win, false)
    assert.deepEqual(colors, [false, null, false])
  }
)
