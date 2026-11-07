import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as credentials from '../../shared/qqmusicLogin.ts'

const source = ts.transpileModule(
  readFileSync(new URL('./qqmusicOfficialLogin.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText

function fixture(loadFails = false) {
  let values: Array<{ name: string; value: string }> = []
  let cleared = 0
  const cookies = Object.assign(new EventEmitter(), {
    get: async (filter: { url: string }) => {
      assert.equal(filter.url, 'https://y.qq.com/')
      return values
    }
  })
  const loginSession = {
    cookies,
    clearStorageData: async () => {
      cleared++
    }
  }
  const windows: Window[] = []
  class Window extends EventEmitter {
    readonly options: { webPreferences?: Record<string, unknown> }
    destroyed = false
    shown = false
    url = ''
    popup!: (details: { url: string }) => { action: string }
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: (handler: Window['popup']) => {
        this.popup = handler
      }
    })
    constructor(options: Window['options'] = {}) {
      super()
      this.options = options
      windows.push(this)
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
    show() {
      this.shown = true
    }
    async loadURL(url: string) {
      this.url = url
      if (loadFails) throw new Error('internal browser failure')
    }
  }
  const exports = {} as {
    openQqMusicOfficialLogin(signal?: AbortSignal): Promise<credentials.QqMusicOfficialCredential>
  }
  runInNewContext(source, {
    exports,
    Error,
    setTimeout,
    clearTimeout,
    require: (id: string) => {
      if (id === 'electron')
        return {
          BrowserWindow: Window,
          session: {
            fromPartition: (partition: string) => {
              assert.ok(partition.startsWith('twilight-qq-login-'))
              return loginSession
            }
          }
        }
      if (id === 'node:crypto') return { randomUUID: () => 'isolated-test' }
      if (id === '../../shared/qqmusicLogin.ts') return credentials
      throw new Error(`Unexpected dependency: ${id}`)
    }
  })
  return {
    open: exports.openQqMusicOfficialLogin,
    windows,
    cookies,
    cleared: () => cleared,
    change: (next: typeof values) => {
      values = next
      cookies.emit('changed')
    },
    popup: () => {
      const child = new Window()
      windows[0].webContents.emit('did-create-window', child)
      return child
    }
  }
}

test('official browser waits for complete music cookies and cleans its session and popups on success', async () => {
  const f = fixture()
  const result = f.open()
  const main = f.windows[0]
  assert.equal(main.url, 'https://y.qq.com/n/ryqq/')
  assert.equal(main.options.webPreferences?.nodeIntegration, false)
  assert.equal(main.options.webPreferences?.sandbox, true)
  main.emit('ready-to-show')
  assert.equal(main.shown, true)
  const child = f.popup()
  for (const window of [main, child]) {
    assert.equal(window.popup({ url: 'https://graph.qq.com/oauth2.0/authorize' }).action, 'allow')
    assert.equal(window.popup({ url: 'https://unrelated.test/' }).action, 'deny')
    for (const event of ['will-navigate', 'will-redirect']) {
      let blocked = false
      window.webContents.emit(
        event,
        {
          preventDefault: () => {
            blocked = true
          }
        },
        'https://unrelated.test/'
      )
      assert.equal(blocked, true)
    }
  }
  f.change([{ name: 'qqmusic_uin', value: '123456' }])
  await Promise.resolve()
  assert.equal(main.destroyed, false)
  f.change([
    { name: 'qqmusic_uin', value: '123456' },
    { name: 'qqmusic_key', value: 'test-music-key' },
    { name: 'login_type', value: '1' },
    { name: 'p_skey', value: 'not-returned' }
  ])
  assert.deepEqual(await result, {
    musicid: '123456',
    str_musicid: '123456',
    musickey: 'test-music-key',
    loginType: 2
  })
  assert.ok(f.windows.every((window) => window.destroyed))
  assert.equal(f.cookies.listenerCount('changed'), 0)
  assert.equal(f.cleared(), 1)
})

for (const mode of ['abort', 'close', 'timeout', 'load'] as const) {
  test(`official browser releases its windows and cookie listener on ${mode}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = fixture(mode === 'load')
    const controller = new AbortController()
    const result = f.open(controller.signal)
    const failure = assert.rejects(result, /取消|超时|加载失败/)
    f.popup()
    if (mode === 'abort') controller.abort()
    else if (mode === 'close') f.windows[0].destroy()
    else if (mode === 'timeout') t.mock.timers.tick(180_000)
    await failure
    assert.ok(f.windows.every((window) => window.destroyed))
    assert.equal(f.cookies.listenerCount('changed'), 0)
    assert.equal(f.cleared(), 1)
  })
}

test('an already cancelled request never opens a browser', () => {
  const f = fixture()
  assert.throws(() => f.open(AbortSignal.abort()), { name: 'AbortError' })
  assert.equal(f.windows.length, 0)
})
