import { app, nativeImage, nativeTheme, type BrowserWindow, type ThumbarButton } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { runtime } from '../core/runtime'
import { getCoreSystemPlayer } from '../coreProcess/systemPlayerBridge.ts'
import type { MiniPlayerCommand } from '../../shared/miniPlayer.ts'
import { writeDiagnostic } from '../diagnostics/logger.ts'

// Windows taskbar-thumbnail toolbar (thumbnail hover / taskbar preview).
// This is deliberately separate from Windows System Media Transport Controls:
// Thumbar buttons belong to the taskbar window preview while SMTC belongs to the
// system-wide media session surfaced by Windows media flyouts / lock-screen UI.

let lastSignature = ''
let lastReportedUpdate = ''
let owner: BrowserWindow | null = null
let hasShown = false
let pendingShowRefresh: ReturnType<typeof setImmediate> | null = null
const icons = new Map<string, Electron.NativeImage>()

function getThumbarIcon(name: string): Electron.NativeImage {
  const variant = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? name : `${name}-dark`
  const cached = icons.get(variant)
  if (cached) return cached
  const path = is.dev
    ? join(app.getAppPath(), 'build', 'smtc', `${variant}.ico`)
    : join(process.resourcesPath, 'smtc', `${variant}.ico`)
  const icon = nativeImage.createFromPath(path)
  if (icon.isEmpty()) throw new Error(`Taskbar icon could not be loaded: ${path}`)
  icons.set(variant, icon)
  return icon
}

function sendPlayerCommand(command: MiniPlayerCommand): void {
  const state = runtime.latestMiniPlayerState
  if (!state?.track) return
  if (command.type === 'toggle-favorite' && (!state.favoriteAvailable || state.favoriteLoading))
    return
  const core = getCoreSystemPlayer()
  if (core) {
    core.dispatch(command)
    return
  }
  const win = runtime.mainWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('miniPlayer:command', command)
}

function buildTaskbarThumbarButtons(): ThumbarButton[] {
  const state = runtime.latestMiniPlayerState
  const hasTrack = state?.track != null
  const isPlaying = state?.isPlaying === true
  return [
    {
      tooltip: '上一首',
      icon: getThumbarIcon('previous'),
      // Enabled is the native default. Electron 43 rejects the literal
      // 'enabled' flag even though its API documentation lists it.
      flags: hasTrack ? [] : ['disabled'],
      click: () => sendPlayerCommand({ type: 'previous' })
    },
    {
      tooltip: isPlaying ? '暂停' : '播放',
      icon: getThumbarIcon(isPlaying ? 'pause' : 'play'),
      flags: hasTrack ? [] : ['disabled'],
      click: () => sendPlayerCommand({ type: 'toggle-play' })
    },
    {
      tooltip: '下一首',
      icon: getThumbarIcon('next'),
      flags: hasTrack ? [] : ['disabled'],
      click: () => sendPlayerCommand({ type: 'next' })
    },
    {
      tooltip: state?.favoriteLoading
        ? '正在更新喜欢状态'
        : state?.favoriteLiked
          ? '取消喜欢'
          : '喜欢',
      icon: getThumbarIcon(state?.favoriteLiked ? 'heart-filled' : 'heart'),
      flags: hasTrack && state?.favoriteAvailable && !state.favoriteLoading ? [] : ['disabled'],
      click: () => sendPlayerCommand({ type: 'toggle-favorite' })
    }
  ]
}

export function refreshTaskbarThumbarButtons(force = false): void {
  if (process.platform !== 'win32') return
  const win = runtime.mainWindow
  if (!win || win !== owner || win.isDestroyed() || !hasShown) return
  const enabled = runtime.appSettings.taskbarThumbarButtonsEnabled !== false
  const state = runtime.latestMiniPlayerState
  const signature = JSON.stringify([
    enabled,
    state?.track?.id ?? null,
    state?.isPlaying === true,
    state?.favoriteAvailable === true,
    state?.favoriteLiked === true,
    state?.favoriteLoading === true,
    nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
  ])
  if (!force && signature === lastSignature) return
  // Windows may reject registration before the taskbar entry is ready. Only
  // cache successful updates so the next state/show event can try again.
  const accepted = win.setThumbarButtons(enabled ? buildTaskbarThumbarButtons() : [])
  const report = `${win.id}:${signature}:${accepted}`
  if (report !== lastReportedUpdate) {
    lastReportedUpdate = report
    writeDiagnostic(
      'taskbar',
      'buttons.updated',
      {
        windowId: win.id,
        enabled,
        hasTrack: state?.track != null,
        accepted,
        visible: win.isVisible(),
        minimized: win.isMinimized()
      },
      accepted ? 'info' : 'warn'
    )
  }
  lastSignature = accepted ? signature : ''
}

function refreshAfterShow(): void {
  if (pendingShowRefresh) clearImmediate(pendingShowRefresh)
  const win = owner
  // Electron emits 'show' while isVisible() is still false. Wait until show()
  // has returned before adding the toolbar to the Shell's visible window.
  pendingShowRefresh = setImmediate(() => {
    pendingShowRefresh = null
    if (!win || owner !== win || win.isDestroyed()) return
    hasShown = win.isVisible() || win.isMinimized()
    if (hasShown) refreshTaskbarThumbarButtons(true)
  })
}

export function createTaskbarThumbarButtons(): void {
  if (process.platform !== 'win32') return
  const win = runtime.mainWindow
  if (!win || win.isDestroyed()) return
  destroyTaskbarThumbarButtons()
  owner = win
  hasShown = win.isVisible() || win.isMinimized()
  owner.on('show', refreshAfterShow)
  nativeTheme.on('updated', refreshTaskbarThumbarButtons)
  runtime.refreshTaskbarThumbarButtons = refreshTaskbarThumbarButtons
  if (hasShown) refreshTaskbarThumbarButtons(true)
}

export function destroyTaskbarThumbarButtons(): void {
  if (pendingShowRefresh) clearImmediate(pendingShowRefresh)
  pendingShowRefresh = null
  owner?.removeListener('show', refreshAfterShow)
  owner = null
  hasShown = false
  nativeTheme.removeListener('updated', refreshTaskbarThumbarButtons)
  runtime.refreshTaskbarThumbarButtons = null
  lastSignature = ''
  lastReportedUpdate = ''
}
