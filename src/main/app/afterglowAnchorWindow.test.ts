import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { CoreAfterglow } from './coreAfterglow.ts'

test('anchor defers native restore and ignores callbacks after replacement', async () => {
  const source = await readFile(new URL('./afterglowAnchorWindow.ts', import.meta.url), 'utf8')
  class Anchor extends EventEmitter {
    destroyed = false
    minimized = false
    setSkipTaskbar() {}
    showInactive() {}
    minimize() {
      this.minimized = true
    }
    isMinimized() {
      return this.minimized
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
  }
  const runtime = { afterglowAnchorWindow: null as Anchor | null }
  const context = {
    runtime,
    BaseWindow: Anchor,
    process: { platform: 'win32' },
    app: { getAppPath: () => '.' },
    is: { dev: true },
    join: (...parts: string[]) => parts.join('/'),
    setImmediate,
    createAfterglowAnchorWindow: undefined as
      | undefined
      | ((options: { showInTaskbar: boolean; onRestore: () => void }) => Anchor),
    destroyAfterglowAnchorWindow: undefined as undefined | (() => void)
  }
  const body = source.slice(source.indexOf('export interface AfterglowAnchorOptions'))
  runInNewContext(stripTypeScriptTypes(body.replace(/^export /gm, '')), context)
  let restored = 0
  const anchor = context.createAfterglowAnchorWindow!({
    showInTaskbar: true,
    onRestore: () => restored++
  })
  anchor.emit('restore')
  assert.equal(restored, 0)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(restored, 1)
  anchor.emit('restore')
  context.destroyAfterglowAnchorWindow!()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(restored, 1)
})

test('Core restore retains the anchor and media session until the new window is ready, including failure and retry', async () => {
  const source = await readFile(new URL('./coreAfterglowRuntime.ts', import.meta.url), 'utf8')
  const events: string[] = []
  const savedWindows: unknown[] = []
  const window = new EventEmitter() as EventEmitter & {
    isDestroyed(): boolean
    destroy(): void
    isMinimized(): boolean
    getNativeWindowHandle(): Buffer
    show(): void
    focus(): void
  }
  let destroyed = false
  Object.assign(window, {
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
      events.push('destroy-window')
      window.emit('closed')
    },
    isMinimized: () => false,
    getNormalBounds: () => ({ width: 1100, height: 800 }),
    isMaximized: () => false,
    isFullScreen: () => true,
    getNativeWindowHandle: () => Buffer.from([1]),
    show: () => events.push('show'),
    focus: () => events.push('focus')
  })
  const runtime = {
    mainWindow: window as typeof window | null,
    appSettings: { desktopLyrics: { enabled: false } },
    forceQuit: false,
    miniPlayerWindow: null,
    desktopLyricsWindow: null,
    refreshTrayMenu: () => {}
  }
  const core = { snapshot: () => ({ phase: 'ready' }) }
  const context = {
    CoreAfterglow,
    runtime,
    getCoreApplication: () => core,
    AFTERGLOW_RESTORE_ACCELERATORS: ['Ctrl+Alt+R'],
    globalShortcut: { isRegistered: () => false, register: () => true, unregister: () => {} },
    requestApplicationPersistence: async () => {},
    createAfterglowAnchorWindow: () => events.push('create-anchor'),
    getAfterglowAnchorHandle: () => null,
    destroyAfterglowAnchorWindow: () => events.push('destroy-anchor'),
    minimizeAfterglowAnchorWindow: () => events.push('minimize-anchor'),
    rebindWindowsSmtc: () => events.push('rebind'),
    createTaskbarThumbarButtons: () => events.push('thumbar'),
    destroyDesktopLyrics: () => {},
    destroyDynamicIsland: () => {},
    destroyTrayPlayerWindow: () => {},
    destroyMiniPlayerWindow: () => {},
    showDesktopLyrics: () => {},
    showMiniPlayer: () => {},
    setMainWindowAfterglowUnloading: () => {},
    createWindow: (options: unknown) => {
      events.push('create-window')
      assert.equal(
        (options as { deferAfterglowAnchorHandoff: boolean }).deferAfterglowAnchorHandoff,
        true
      )
      destroyed = false
      runtime.mainWindow = window
      return window
    },
    windowReady: () =>
      new Promise<void>((resolve, reject) => {
        window.once('ready-to-show', resolve)
        window.once('closed', () => reject(Error('closed')))
      }),
    app: { getPath: () => 'test-profile' },
    join: () => '',
    saveWindowState: (_path: string, state: unknown) => savedWindows.push(state),
    console,
    getCoreAfterglowMode: undefined as undefined | (() => CoreAfterglow)
  }
  const body = source.slice(source.indexOf('let service:'), source.indexOf('function windowReady'))
  runInNewContext(stripTypeScriptTypes(body.replace(/^export /gm, '')), context)
  const mode = context.getCoreAfterglowMode!()
  await mode.enter('minimize')
  assert.deepEqual(savedWindows.map((state) => JSON.parse(JSON.stringify(state))), [
    { width: 1100, height: 800, maximized: false, fullScreen: true }
  ])
  events.length = 0
  const first = mode.restore()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['create-window'])
  window.emit('closed')
  assert.equal((await first).phase, 'active')
  assert.deepEqual(events, ['create-window', 'destroy-window', 'minimize-anchor'])
  runtime.mainWindow = null
  events.length = 0
  const second = mode.restore()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['create-window'])
  window.emit('ready-to-show')
  assert.equal((await second).phase, 'inactive')
  assert.deepEqual(events, [
    'create-window',
    'rebind',
    'thumbar',
    'show',
    'focus',
    'destroy-anchor'
  ])
})
