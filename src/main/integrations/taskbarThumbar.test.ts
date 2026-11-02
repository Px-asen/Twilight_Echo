import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes, createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { EMPTY_MINI_PLAYER_STATE } from '../../shared/miniPlayer.ts'
import type { MiniPlayerCommand, MiniPlayerStateSnapshot } from '../../shared/miniPlayer.ts'
import type { ThumbarButton } from 'electron'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const source = await readFile(new URL('./taskbarThumbar.ts', import.meta.url), 'utf8')

async function fixture(
  options: { platform?: string; core?: boolean; dev?: boolean; hidden?: boolean } = {}
) {
  const calls: ThumbarButton[][] = []
  const commands: MiniPlayerCommand[] = []
  const ipc: unknown[][] = []
  const images: string[] = []
  let accepted = true
  let destroyed = false
  let contentsDestroyed = false
  let visible = options.hidden !== true
  const makeWindow = () =>
    Object.assign(new EventEmitter(), {
      id: 1,
      isVisible: () => visible,
      isMinimized: () => false,
      isDestroyed: () => destroyed,
      setThumbarButtons: (buttons: ThumbarButton[]) => {
        calls.push(buttons)
        return accepted
      },
      webContents: {
        isDestroyed: () => contentsDestroyed,
        send: (...args: unknown[]) => ipc.push(args)
      }
    })
  const win = makeWindow()
  const theme = Object.assign(new EventEmitter(), {
    shouldUseDarkColorsForSystemIntegratedUI: true
  })
  const state: MiniPlayerStateSnapshot = {
    ...EMPTY_MINI_PLAYER_STATE,
    track: {
      id: 'local:one',
      title: 'One',
      artist: 'Twilight Echo',
      album: 'Echo',
      albumArtist: '',
      trackNumber: 1,
      cover: null,
      coverSource: null,
      format: 'FLAC',
      sampleRate: 44100,
      bitDepth: 16
    },
    favoriteAvailable: true
  }
  const runtime = {
    mainWindow: win as ReturnType<typeof makeWindow> | null,
    latestMiniPlayerState: state as MiniPlayerStateSnapshot | null,
    appSettings: { taskbarThumbarButtonsEnabled: true },
    refreshTaskbarThumbarButtons: null as (() => void) | null
  }
  const api = runInNewContext(
    stripTypeScriptTypes(
      source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\r?\n/gm, '').replace(/^export /gm, '')
    ) +
      '\n;({ createTaskbarThumbarButtons, refreshTaskbarThumbarButtons, destroyTaskbarThumbarButtons })',
    {
      app: { getAppPath: () => root },
      nativeImage: {
        createFromPath: (path: string) => {
          images.push(path)
          return { path, isEmpty: () => false }
        }
      },
      nativeTheme: theme,
      writeDiagnostic: () => {},
      setImmediate,
      clearImmediate,
      join,
      is: { dev: options.dev !== false },
      runtime,
      process: {
        platform: options.platform ?? 'win32',
        resourcesPath: join(root, 'packaged-resources')
      },
      getCoreSystemPlayer: () =>
        options.core === false
          ? null
          : { dispatch: (command: MiniPlayerCommand) => commands.push(command) }
    }
  ) as Pick<
    typeof import('./taskbarThumbar.ts'),
    'createTaskbarThumbarButtons' | 'refreshTaskbarThumbarButtons' | 'destroyTaskbarThumbarButtons'
  >
  return {
    api,
    runtime,
    theme,
    win,
    state,
    calls,
    commands,
    ipc,
    images,
    makeWindow,
    show: () => {
      win.emit('show')
      visible = true
    },
    hide: () => {
      visible = false
    },
    settleShow: () => new Promise<void>((resolve) => setImmediate(resolve)),
    reject: () => {
      accepted = false
    },
    accept: () => {
      accepted = true
    },
    destroy: () => {
      destroyed = true
    },
    destroyContents: () => {
      contentsDestroyed = true
    }
  }
}

test('thumbnail toolbar has previous, play/pause, next and favorite in reference order', async () => {
  const f = await fixture()
  f.api.createTaskbarThumbarButtons()
  assert.deepEqual(
    Array.from(f.calls[0], (button) => button.tooltip),
    ['上一首', '播放', '下一首', '喜欢']
  )
  for (const button of f.calls[0]) {
    assert.equal(button.flags?.join(), '')
    button.click()
  }
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands)), [
    { type: 'previous' },
    { type: 'toggle-play' },
    { type: 'next' },
    { type: 'toggle-favorite' }
  ])
  f.state.isPlaying = true
  f.state.favoriteLiked = true
  f.api.refreshTaskbarThumbarButtons()
  assert.equal(f.calls.at(-1)![1].tooltip, '暂停')
  assert.equal(f.calls.at(-1)![3].tooltip, '取消喜欢')
  assert.ok(f.images.some((path) => path.endsWith('pause.ico')))
  assert.ok(f.images.some((path) => path.endsWith('heart-filled.ico')))
})

test('favorite availability and pending state refresh the button and guard queued clicks', async () => {
  const f = await fixture()
  f.api.createTaskbarThumbarButtons()
  const staleClick = f.calls[0][3].click
  f.state.favoriteLoading = true
  f.api.refreshTaskbarThumbarButtons()
  assert.equal(f.calls.at(-1)![3].tooltip, '正在更新喜欢状态')
  assert.equal(f.calls.at(-1)![3].flags?.join(), 'disabled')
  staleClick()
  assert.equal(f.commands.length, 0)
  f.state.favoriteLoading = false
  f.state.favoriteAvailable = false
  f.api.refreshTaskbarThumbarButtons()
  assert.equal(f.calls.length, 3)
  assert.equal(f.calls.at(-1)![3].flags?.join(), 'disabled')
  staleClick()
  assert.equal(f.commands.length, 0)
  f.runtime.latestMiniPlayerState = null
  f.api.refreshTaskbarThumbarButtons()
  for (const button of f.calls.at(-1)!) {
    assert.equal(button.flags?.join(), 'disabled')
    button.click()
  }
  assert.equal(f.commands.length, 0)
})

test('legacy renderer receives the existing mini-player command contract safely', async () => {
  const f = await fixture({ core: false })
  f.api.createTaskbarThumbarButtons()
  for (const button of f.calls[0]) button.click()
  assert.deepEqual(JSON.parse(JSON.stringify(f.ipc)), [
    ['miniPlayer:command', { type: 'previous' }],
    ['miniPlayer:command', { type: 'toggle-play' }],
    ['miniPlayer:command', { type: 'next' }],
    ['miniPlayer:command', { type: 'toggle-favorite' }]
  ])
  f.destroyContents()
  f.calls[0][3].click()
  assert.equal(f.ipc.length, 4)
})

test('clock ticks reuse the toolbar and cached icons; system tone changes refresh its artwork', async () => {
  const f = await fixture()
  f.api.createTaskbarThumbarButtons()
  f.state.currentTime++
  f.api.refreshTaskbarThumbarButtons()
  assert.equal(f.calls.length, 1)
  assert.equal(f.images.length, 4)
  f.win.emit('show')
  await f.settleShow()
  assert.equal(f.calls.length, 2)
  assert.equal(f.images.length, 4)
  f.theme.shouldUseDarkColorsForSystemIntegratedUI = false
  f.theme.emit('updated')
  assert.equal(f.calls.length, 3)
  assert.ok(f.images.slice(4).every((path) => path.endsWith('-dark.ico')))
})

test('failed early registration is retried; disabling and re-enabling preserves all four slots', async () => {
  const f = await fixture()
  f.reject()
  f.api.createTaskbarThumbarButtons()
  f.accept()
  f.api.refreshTaskbarThumbarButtons()
  assert.equal(f.calls.length, 2)
  f.runtime.appSettings.taskbarThumbarButtonsEnabled = false
  f.api.refreshTaskbarThumbarButtons()
  assert.equal(f.calls.at(-1)!.length, 0)
  f.runtime.appSettings.taskbarThumbarButtonsEnabled = true
  f.api.refreshTaskbarThumbarButtons()
  assert.equal(f.calls.at(-1)!.length, 4)
})

test('hidden startup waits until show returns and still updates after a later hide', async () => {
  const f = await fixture({ hidden: true })
  f.api.createTaskbarThumbarButtons()
  f.api.refreshTaskbarThumbarButtons()
  assert.equal(f.calls.length, 0)
  assert.equal(f.images.length, 0)
  f.show()
  assert.equal(f.calls.length, 0)
  await f.settleShow()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].length, 4)
  f.hide()
  f.state.isPlaying = true
  f.api.refreshTaskbarThumbarButtons()
  assert.equal(f.calls.at(-1)![1].tooltip, '暂停')
})

test('a rejected forced refresh invalidates an earlier success instead of suppressing retries', async () => {
  const f = await fixture()
  f.api.createTaskbarThumbarButtons()
  f.reject()
  f.win.emit('show')
  await f.settleShow()
  f.accept()
  f.api.refreshTaskbarThumbarButtons()
  assert.equal(f.calls.length, 3)
})

test('teardown cancels a pending show registration', async () => {
  const f = await fixture({ hidden: true })
  f.api.createTaskbarThumbarButtons()
  f.show()
  f.api.destroyTaskbarThumbarButtons()
  await f.settleShow()
  assert.equal(f.calls.length, 0)
})

test('window recreation and teardown do not retain listeners or stale toolbar signatures', async () => {
  const f = await fixture()
  f.api.createTaskbarThumbarButtons()
  const next = f.makeWindow()
  f.runtime.mainWindow = next
  f.api.createTaskbarThumbarButtons()
  assert.equal(f.calls.length, 2)
  assert.equal(f.win.listenerCount('show'), 0)
  assert.equal(next.listenerCount('show'), 1)
  assert.equal(f.theme.listenerCount('updated'), 1)
  f.api.destroyTaskbarThumbarButtons()
  assert.equal(next.listenerCount('show'), 0)
  assert.equal(f.theme.listenerCount('updated'), 0)
  assert.equal(f.runtime.refreshTaskbarThumbarButtons, null)
})

test('non-Windows hosts, absent windows and destroyed windows are left alone', async () => {
  for (const platform of ['linux', 'darwin']) {
    const f = await fixture({ platform })
    f.api.createTaskbarThumbarButtons()
    f.api.refreshTaskbarThumbarButtons()
    assert.equal(f.calls.length, 0)
    assert.equal(f.images.length, 0)
  }
  const f = await fixture()
  f.destroy()
  f.api.createTaskbarThumbarButtons()
  f.api.refreshTaskbarThumbarButtons()
  assert.equal(f.calls.length, 0)
  f.runtime.mainWindow = null
  f.api.createTaskbarThumbarButtons()
  f.api.refreshTaskbarThumbarButtons()
  assert.equal(f.calls.length, 0)
})

test('packaged toolbar icons are resolved from resources, not the source tree', async () => {
  const f = await fixture({ dev: false })
  f.api.createTaskbarThumbarButtons()
  assert.ok(f.images.every((path) => path.startsWith(join(root, 'packaged-resources', 'smtc'))))
})

test('all taskbar icons contain antialiased transparent artwork at standard Windows densities', async () => {
  const { PNG } = createRequire(import.meta.url)('pngjs')
  for (const name of ['previous', 'play', 'pause', 'next', 'heart', 'heart-filled']) {
    for (const suffix of ['', '-dark']) {
      const ico = await readFile(join(root, 'build', 'smtc', `${name}${suffix}.ico`))
      assert.equal(ico.readUInt16LE(2), 1)
      assert.equal(ico.readUInt16LE(4), 3)
      for (const [i, size] of [16, 24, 32].entries()) {
        const entry = 6 + i * 16
        const offset = ico.readUInt32LE(entry + 12)
        const png = PNG.sync.read(ico.subarray(offset, offset + ico.readUInt32LE(entry + 8)))
        assert.equal(png.width, size)
        assert.equal(png.height, size)
        const alpha = Array.from(png.data as Uint8Array).filter((_, index) => index % 4 === 3)
        assert.ok(alpha.some((value) => value === 0))
        assert.ok(alpha.some((value) => value === 255))
        assert.ok(alpha.some((value) => value > 0 && value < 255))
      }
    }
  }
})
