import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { createDefaultSettings } from '../../core/settings/normalization.ts'

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

test('the production entry starts the independent Core owner', async () => {
  const entry = await readFile(new URL('../index.ts', import.meta.url), 'utf8')
  assert.match(entry, /import \{ startCoreApp \} from '\.\/app\/lifecycle'/)
  assert.match(entry, /\bstartCoreApp\(\)/)
  assert.doesNotMatch(entry, /\bstartApp\(\)/)
})
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function fixture(platform: 'win32' | 'darwin' = 'win32') {
  const source = await readFile(new URL('./lifecycle.ts', import.meta.url), 'utf8')
  const events: string[] = []
  const startup = deferred(),
    navigation = deferred(),
    checkpoint = deferred(),
    reclamation = deferred()
  const failures: Array<{ error: Error; respond(choice: 'retry' | 'cancel' | 'force'): void }> = []
  let installed = false,
    quitAllowed = false
  const core = {
    start: () => {
      events.push('core:start')
      return startup.promise
    },
    shutdown: async () => {
      events.push('core:shutdown')
      await checkpoint.promise
      events.push('core:saved')
    },
    forceShutdown: async () => {
      events.push('core:force')
      await reclamation.promise
      events.push('core:reclaimed')
    }
  }
  const runtime = {
    appSettings: createDefaultSettings(platform),
    launchSettings: {},
    mainWindow: null as any,
    miniPlayerWindow: null,
    forceQuit: false,
    closingAfterPlaybackSessionSave: false
  }
  const app = Object.assign(new EventEmitter(), {
    setName() {},
    requestSingleInstanceLock: () => true,
    getPath: () => 'temporary-test-profile',
    commandLine: { appendSwitch() {} },
    isReady: () => true,
    whenReady: async () => {},
    quit: () => {
      const event = {
        prevented: false,
        preventDefault() {
          this.prevented = true
        }
      }
      app.emit('before-quit', event)
      if (!event.prevented) {
        events.push('app:quit')
        quitAllowed = true
      }
    }
  })
  const context: Record<string, any> = {
    runtime,
    app,
    process: { platform, env: {} },
    electronApp: { setAppUserModelId() {} },
    WINDOWS_APP_USER_MODEL_ID: 'test',
    readAppSettings: () => runtime.appSettings,
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    warmWindowsAcrylicBackdropAvailability: async () => {},
    ensureWindowsShellIdentity: () => ({ ok: true }),
    initializeLocalPathGrants: async () => {},
    createCoreApplication: () => {
      installed = true
      return core
    },
    getCoreApplication: () => (installed ? core : null),
    createMainWindowAndScheduleDeferredStartup: () => {
      events.push('window:create')
    },
    createWindow: () => {
      events.push('window:recreate')
      runtime.mainWindow = {
        isDestroyed: () => false,
        isMinimized: () => false,
        show() {},
        focus() {}
      }
      return runtime.mainWindow
    },
    isAfterglowModeActive: () => false,
    BrowserWindow: { getAllWindows: () => [{ auxiliary: true }] },
    requestRendererPlaybackSessionSave: async () => {
      events.push('navigation:save')
      await navigation.promise
    },
    showClosePersistenceFailure: (_win: unknown, error: Error) =>
      new Promise((respond) => failures.push({ error, respond })),
    dialog: {
      showErrorBox: (_title: string, error: string) => {
        throw Error(error)
      }
    },
    console,
    setTimeout,
    // The shell adapter creates no music owners. These calls register platform IPC only.
    installElectronSecurity() {},
    installExperienceProtocol() {},
    createRemoteMediaRequestHandler: () => () => {},
    mediaCoverCache: {},
    optimizer: { watchWindowShortcuts() {} }
  }
  for (const name of [
    'setupCoreShellIpc',
    'setupThemeIpc',
    'setupDesktopLyricsIpc',
    'setupMiniPlayerIpc',
    'setupDynamicIslandIpc',
    'setupTrayPlayerIpc',
    'setupWindowsSmtcIpc',
    'initializeTelemetry',
    'destroyDesktopLyrics',
    'destroyDynamicIsland',
    'destroyTrayPlayerWindow',
    'destroyMiniPlayerWindow',
    'shutdownAfterglowMode',
    'stopAppUpdateChecks',
    'destroyWindowsSmtc',
    'unregisterPlayerShortcuts',
    'destroyTray',
    'destroyTelemetry'
  ])
    context[name] = () => {
      events.push(name)
    }
  runInNewContext(
    stripTypeScriptTypes(
      source.slice(
        source.indexOf('function startDesktopApp'),
        source.indexOf('async function initializeDatabaseLibrary')
      )
    ),
    context
  )
  context.startDesktopApp('core')
  await turn()
  return {
    app,
    runtime,
    events,
    startup,
    navigation,
    checkpoint,
    reclamation,
    failures,
    get quitAllowed() {
      return quitAllowed
    }
  }
}

test('Core starts before a normal migration window without awaiting renderer-supplied migration', async () => {
  const f = await fixture()
  assert.ok(f.events.indexOf('core:start') < f.events.indexOf('window:create'))
  assert.ok(f.events.includes('setupCoreShellIpc'))
  assert.equal(f.events.includes('core:shutdown'), false)
  f.app.emit('window-all-closed')
  assert.equal(f.quitAllowed, false)
  assert.equal(f.events.includes('core:shutdown'), false)
})

test('second instance and activate rebuild the missing main window even when auxiliary windows remain', async () => {
  for (const platform of ['win32', 'darwin'] as const) {
    const f = await fixture(platform)
    for (const event of ['second-instance', 'activate']) {
      for (const mainWindow of [null, { isDestroyed: () => true }]) {
        f.runtime.mainWindow = mainWindow
        f.app.emit(event)
      }
    }
    assert.equal(f.events.filter((value) => value === 'window:recreate').length, 4)
    assert.equal(
      f.events.some((value) => /^(playback:|seek:|queue:|core:shutdown)/.test(value)),
      false
    )
  }
})

test('macOS Dock activation restores and focuses the existing hidden or minimized window', async () => {
  for (const minimized of [false, true]) {
    const f = await fixture('darwin')
    const calls: string[] = []
    const win = {
      isDestroyed: () => false,
      isMinimized: () => minimized,
      restore: () => calls.push('restore'),
      show: () => calls.push('show'),
      focus: () => calls.push('focus')
    }
    f.runtime.mainWindow = win
    f.app.emit('activate')
    assert.deepEqual(calls, minimized ? ['restore', 'show', 'focus'] : ['show', 'focus'])
    assert.equal(f.runtime.mainWindow, win)
    assert.equal(f.events.includes('window:recreate'), false)
    assert.equal(f.events.includes('core:shutdown'), false)
  }
})

test('macOS activation cannot reopen the window during explicit quit with background-close enabled', async () => {
  const f = await fixture('darwin')
  assert.equal(f.runtime.appSettings.closeWindowBehavior, 'tray')
  f.app.quit()
  await turn()
  f.app.emit('activate')
  f.app.emit('second-instance')
  assert.equal(f.events.includes('window:recreate'), false)
  assert.equal(f.quitAllowed, false)
  f.navigation.resolve()
  await turn()
  f.checkpoint.resolve()
  await turn()
  assert.equal(f.quitAllowed, true)
  assert.equal(f.events.filter((value) => value === 'core:shutdown').length, 1)
  assert.ok(f.events.indexOf('core:saved') < f.events.indexOf('app:quit'))
})

test('explicit quit destroys satellite windows, saves navigation and waits for final Core ACK once', async () => {
  const f = await fixture()
  f.app.quit()
  f.app.quit()
  await turn()
  assert.equal(f.quitAllowed, false)
  assert.equal(f.events.filter((value) => value === 'navigation:save').length, 1)
  assert.equal(f.events.includes('core:shutdown'), false)
  assert.ok(f.events.indexOf('destroyMiniPlayerWindow') < f.events.indexOf('navigation:save'))
  f.navigation.resolve()
  await turn()
  assert.equal(f.events.filter((value) => value === 'core:shutdown').length, 1)
  assert.equal(f.quitAllowed, false)
  f.checkpoint.resolve()
  await turn()
  assert.equal(f.quitAllowed, true)
  assert.equal(f.runtime.closingAfterPlaybackSessionSave, true)
  assert.ok(f.events.indexOf('core:saved') < f.events.indexOf('app:quit'))
  f.app.emit('will-quit')
  assert.ok(f.events.includes('destroyTelemetry'))
})

test('window close preferences still distinguish tray/mini hiding from explicit application quit', async () => {
  const source = await readFile(new URL('./window.ts', import.meta.url), 'utf8')
  const win = Object.assign(new EventEmitter(), {
    getNormalBounds: () => ({ width: 900, height: 600 }),
    isMaximized: () => false,
    isFullScreen: () => false,
    hide: () => {
      hidden++
    }
  })
  let quit = 0,
    hidden = 0,
    mini = 0
  const runtime = {
    mainWindow: win,
    forceQuit: false,
    closingAfterPlaybackSessionSave: false,
    appSettings: { closeWindowBehavior: 'quit' }
  }
  const context = {
    runtime,
    console,
    windowStatePath: 'test-window-state',
    saveWindowState() {},
    getCoreApplication: () => ({}),
    app: {
      quit: () => {
        quit++
      }
    },
    showMiniPlayer: () => {
      mini++
    },
    closeMainWindowAfterPlaybackSessionSave: () => {
      throw new Error('Core close must not enter the legacy window persistence gate')
    }
  }
  runInNewContext(
    stripTypeScriptTypes(
      source.slice(
        source.indexOf("  runtime.mainWindow.on('close'"),
        source.indexOf("  runtime.mainWindow.on('closed'")
      )
    ),
    context
  )
  let prevented = 0
  const event = {
    preventDefault: () => {
      prevented++
    }
  }
  win.emit('close', event)
  assert.equal(quit, 1)
  runtime.appSettings.closeWindowBehavior = 'miniPlayer'
  win.emit('close', event)
  assert.equal(mini, 1)
  assert.equal(quit, 1)
  assert.equal(hidden, 0)
  assert.equal(prevented, 2)
  // While Core shutdown or its failure dialog is pending, another close must
  // still go to the application owner, even with a tray preference.
  runtime.forceQuit = true
  win.emit('close', event)
  win.emit('close', event)
  assert.equal(quit, 3)
  assert.equal(prevented, 4)
  assert.equal(mini, 1)
  runtime.closingAfterPlaybackSessionSave = true
  win.emit('close', event)
  assert.equal(quit, 3)
  assert.equal(prevented, 4)
})

test('macOS default window close hides the UI and leaves Core alive, while an explicit quit bypasses hiding', async () => {
  const source = await readFile(new URL('./window.ts', import.meta.url), 'utf8')
  const calls: string[] = []
  const win = Object.assign(new EventEmitter(), {
    getNormalBounds: () => ({ width: 900, height: 700 }),
    isMaximized: () => false,
    isFullScreen: () => true,
    hide: () => calls.push('hide')
  })
  const runtime = {
    mainWindow: win,
    forceQuit: false,
    closingAfterPlaybackSessionSave: false,
    appSettings: createDefaultSettings('darwin')
  }
  const savedWindows: unknown[] = []
  const context = {
    runtime,
    process: { platform: 'darwin' },
    console,
    windowStatePath: 'test-window-state',
    saveWindowState: (_path: string, state: unknown) => savedWindows.push(state),
    getCoreApplication: () => ({ snapshot: () => ({}) }),
    app: { quit: () => calls.push('quit') },
    require: (id: string) => {
      assert.equal(id, './AfterglowModeService')
      return { handleMainWindowHidden: () => calls.push('afterglow:hide') }
    }
  }
  const closeHandler = source.slice(
    source.indexOf("  runtime.mainWindow.on('close'"),
    source.indexOf("  runtime.mainWindow.on('closed'")
  )
  runInNewContext(
    ts.transpileModule(closeHandler, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText,
    context
  )
  const event = { preventDefault: () => calls.push('prevent') }
  win.emit('close', event)
  await turn()
  assert.deepEqual(calls, ['prevent', 'hide', 'afterglow:hide'])
  assert.deepEqual(
    savedWindows.map((state) => JSON.parse(JSON.stringify(state))),
    [{ width: 900, height: 700, maximized: false, fullScreen: true }]
  )

  calls.length = 0
  runtime.forceQuit = true
  win.emit('close', event)
  assert.deepEqual(calls, ['prevent', 'quit'])

  calls.length = 0
  runtime.closingAfterPlaybackSessionSave = true
  win.emit('close', event)
  assert.deepEqual(calls, [])
})

test('failed Core quit presents one choice, cancels safely and allows a later quit attempt', async () => {
  const f = await fixture()
  f.app.quit()
  f.navigation.resolve()
  await turn()
  f.checkpoint.reject(new Error('Core did not confirm final persistence'))
  await turn()
  assert.equal(f.failures.length, 1)
  assert.match(f.failures[0].error.message, /final persistence/)
  f.app.quit()
  f.app.quit()
  await turn()
  assert.equal(f.failures.length, 1)
  assert.equal(f.events.filter((event) => event === 'core:shutdown').length, 1)
  f.failures[0].respond('cancel')
  await turn()
  assert.equal(f.runtime.forceQuit, false)
  assert.equal(f.quitAllowed, false)
  f.checkpoint.promise = Promise.resolve()
  f.app.quit()
  await turn()
  assert.equal(f.quitAllowed, true)
})

test('retry keeps the quit owner and does not repeat a successful renderer save', async () => {
  const f = await fixture()
  f.app.quit()
  f.navigation.resolve()
  await turn()
  f.checkpoint.reject(new Error('checkpoint failed'))
  await turn()
  f.checkpoint.promise = Promise.resolve()
  f.failures[0].respond('retry')
  await turn()
  assert.equal(f.events.filter((event) => event === 'navigation:save').length, 1)
  assert.equal(f.events.filter((event) => event === 'core:shutdown').length, 2)
  assert.equal(f.quitAllowed, true)
})

test('quit without saving bypasses persistence once and waits for owned process reclamation', async () => {
  const f = await fixture()
  f.app.quit()
  f.navigation.resolve()
  await turn()
  f.checkpoint.reject(new Error('Core did not confirm final persistence'))
  await turn()
  f.failures[0].respond('force')
  await turn()
  f.app.quit()
  assert.equal(f.events.filter((event) => event === 'core:force').length, 1)
  assert.equal(f.events.filter((event) => event === 'core:shutdown').length, 1)
  assert.equal(f.quitAllowed, false)
  f.reclamation.resolve()
  await turn()
  assert.equal(f.quitAllowed, true)
  assert.equal(f.runtime.closingAfterPlaybackSessionSave, true)
  assert.ok(f.events.indexOf('core:reclaimed') < f.events.indexOf('app:quit'))
})

test('discard remains available when renderer saving fails, and cleanup retry never re-enters saving', async () => {
  const f = await fixture()
  f.app.quit()
  f.navigation.reject(new Error('Timed out waiting for renderer persistence'))
  await turn()
  f.failures[0].respond('force')
  await turn()
  f.reclamation.reject(new Error('Core termination not confirmed'))
  await turn()
  assert.equal(f.quitAllowed, false)
  assert.equal(f.failures.length, 2)
  f.reclamation.promise = Promise.resolve()
  f.failures[1].respond('retry')
  await turn()
  assert.equal(f.events.filter((event) => event === 'navigation:save').length, 1)
  assert.equal(f.events.filter((event) => event === 'core:shutdown').length, 0)
  assert.equal(f.events.filter((event) => event === 'core:force').length, 2)
  assert.equal(f.quitAllowed, true)
})

test('unexpected main renderer destruction preserves Core and rebinds SMTC to a renderer-free anchor', async () => {
  const source = await readFile(new URL('./window.ts', import.meta.url), 'utf8')
  const win = new EventEmitter()
  const events: string[] = []
  const runtime = { mainWindow: win as EventEmitter | null, forceQuit: false }
  runInNewContext(
    stripTypeScriptTypes(
      source.slice(
        source.indexOf("  runtime.mainWindow.on('closed'"),
        source.indexOf('  if (!getCoreApplication()) installAudioDeviceHotplugWatcher')
      )
    ),
    {
      runtime,
      afterglowUnloading: false,
      awaitingAfterglowHandoff: false,
      getCoreApplication: () => ({}),
      destroyTaskbarThumbarButtons: () => events.push('thumbar:destroy'),
      createAfterglowAnchorWindow: () => events.push('anchor:create'),
      getAfterglowAnchorHandle: () => Buffer.alloc(8),
      rebindWindowsSmtc: () => events.push('smtc:rebind'),
      destroyWindowsSmtc: () => events.push('smtc:destroy')
    }
  )
  win.emit('closed')
  assert.equal(runtime.mainWindow, null)
  assert.deepEqual(events, ['thumbar:destroy', 'anchor:create', 'smtc:rebind'])
})
