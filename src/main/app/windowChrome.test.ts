import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import type { BrowserWindow } from 'electron'
import {
  installWindowChromePublisher,
  readWindowChromeState,
  toggleWindowMaximize
} from './windowChrome.ts'
import type { WindowChromeState } from '../../shared/windowChrome.ts'

function fixture() {
  const events = new EventEmitter()
  let maximized = false
  let fullScreen = false
  let destroyed = false
  const sent: unknown[][] = []
  const actions: unknown[] = []
  const win = Object.assign(events, {
    isMaximized: () => maximized,
    isFullScreen: () => fullScreen,
    isDestroyed: () => destroyed,
    maximize: () => actions.push('maximize'),
    unmaximize: () => actions.push('unmaximize'),
    setFullScreen: (value: boolean) => actions.push(['fullscreen', value]),
    webContents: { isDestroyed: () => destroyed, send: (...args: unknown[]) => sent.push(args) }
  }) as unknown as BrowserWindow
  return {
    win,
    sent,
    actions,
    maximize: (value: boolean) => {
      maximized = value
    },
    fullScreen: (value: boolean) => {
      fullScreen = value
    },
    destroy: () => {
      destroyed = true
    }
  }
}

test('native maximize and restore events publish real window state and close releases listeners', () => {
  const { win, sent, maximize } = fixture()
  const base = {
    fullScreen: false,
    maximizeBehavior: process.platform === 'darwin' ? 'fullscreen' : 'maximize'
  }
  assert.deepEqual(readWindowChromeState(win), { maximized: false, ...base })
  installWindowChromePublisher(win)
  maximize(true)
  win.emit('maximize')
  maximize(false)
  win.emit('unmaximize')
  assert.deepEqual(sent, [
    ['window:state-changed', { maximized: true, ...base }],
    ['window:state-changed', { maximized: false, ...base }]
  ])
  win.emit('closed')
  assert.equal(win.listenerCount('maximize'), 0)
  assert.equal(win.listenerCount('unmaximize'), 0)
  assert.equal(win.listenerCount('enter-full-screen'), 0)
  assert.equal(win.listenerCount('leave-full-screen'), 0)
})

test('macOS caption enters native fullscreen even from a maximized window and exits on the next click', () => {
  const f = fixture()
  f.maximize(true)
  assert.deepEqual(readWindowChromeState(f.win, 'darwin'), {
    maximized: true,
    fullScreen: false,
    maximizeBehavior: 'fullscreen'
  })
  toggleWindowMaximize(f.win, 'darwin')
  assert.deepEqual(f.actions, [['fullscreen', true]])
  // Native fullscreen completes asynchronously, independently of isMaximized.
  f.fullScreen(true)
  toggleWindowMaximize(f.win, 'darwin')
  assert.deepEqual(f.actions, [
    ['fullscreen', true],
    ['fullscreen', false]
  ])
})

test('Windows and Linux retain maximize/restore and can exit fullscreen entered through the system menu', () => {
  for (const platform of ['win32', 'linux'] as const) {
    const f = fixture()
    toggleWindowMaximize(f.win, platform)
    f.maximize(true)
    toggleWindowMaximize(f.win, platform)
    f.fullScreen(true)
    toggleWindowMaximize(f.win, platform)
    assert.deepEqual(f.actions, ['maximize', 'unmaximize', ['fullscreen', false]])
  }
})

test('native fullscreen events update the caption only after the transition completes', () => {
  const f = fixture()
  installWindowChromePublisher(f.win)
  toggleWindowMaximize(f.win, 'darwin')
  assert.deepEqual(f.sent, [])
  f.fullScreen(true)
  f.win.emit('enter-full-screen')
  f.fullScreen(false)
  f.win.emit('leave-full-screen')
  assert.deepEqual(
    f.sent.map((entry) => (entry[1] as WindowChromeState).fullScreen),
    [true, false]
  )
})

test('a destroyed window never receives a state publication and disposal is repeatable', () => {
  const { win, sent, actions, destroy } = fixture()
  const dispose = installWindowChromePublisher(win)
  destroy()
  win.emit('maximize')
  win.emit('enter-full-screen')
  toggleWindowMaximize(win, 'darwin')
  assert.equal(sent.length, 0)
  assert.deepEqual(actions, [])
  dispose()
  dispose()
  assert.equal(win.listenerCount('closed'), 0)
})

test('renderer caption retains the latest native fullscreen event over a late initial read', async () => {
  const source = await readFile(
    new URL('../../renderer/src/app/useWindowChrome.ts', import.meta.url),
    'utf8'
  )
  let mount!: () => void
  let unmount!: () => void
  let receive!: (state: WindowChromeState) => void
  let reply!: (state: WindowChromeState) => void
  let unsubscribed = false
  const context = {
    ref: <T>(value: T) => ({ value }),
    onMounted: (callback: () => void) => {
      mount = callback
    },
    onBeforeUnmount: (callback: () => void) => {
      unmount = callback
    },
    window: {
      api: {
        window: {
          onStateChanged: (callback: typeof receive) => {
            receive = callback
            return () => {
              unsubscribed = true
            }
          },
          getState: () =>
            new Promise<WindowChromeState>((resolve) => {
              reply = resolve
            })
        }
      }
    },
    useWindowChrome: undefined as
      | undefined
      | ((preview: () => boolean) => {
          maximized: { value: boolean }
          fullScreen: { value: boolean }
          maximizeBehavior: { value: string }
        })
  }
  runInNewContext(
    stripTypeScriptTypes(source.slice(source.indexOf('export function')).replace(/^export /, '')),
    context
  )
  const state = context.useWindowChrome!(() => false)
  mount()
  receive({ maximized: false, fullScreen: true, maximizeBehavior: 'fullscreen' })
  reply({ maximized: false, fullScreen: false, maximizeBehavior: 'fullscreen' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(state.fullScreen.value, true)
  assert.equal(state.maximized.value, false)
  assert.equal(state.maximizeBehavior.value, 'fullscreen')
  receive({ maximized: false, fullScreen: false, maximizeBehavior: 'fullscreen' })
  assert.equal(state.fullScreen.value, false)
  unmount()
  assert.equal(unsubscribed, true)
  receive({ maximized: false, fullScreen: true, maximizeBehavior: 'fullscreen' })
  assert.equal(state.fullScreen.value, false)
})
