import { app, BrowserWindow, dialog, protocol, net, ipcMain } from 'electron'
import { installExperienceProtocol } from '../plugins/experienceProtocol.ts'
import { applyPendingPersonalRestore } from '../persistence/personalBackup.ts'
import { readAppSettings } from '../core/settings'
import { join, extname } from 'path'
import { cpus } from 'os'
import { pathToFileURL } from 'url'
import { fetch as undiciFetch } from 'undici'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { runtime } from '../core/runtime'
import { createRemoteCoverCache } from '../cache/remoteCoverCache.ts'
import { ensureMusicCacheDirectories } from '../cache/ncmCache'
import { readCachedProtocolFile } from '../cache/protocolAssetCache'
import { kwinHasInputMethodConfigured } from '../imeBackend'
import {
  getCoverCacheDir,
  getCoverCacheContentType,
  isCoverCacheFileName,
  readCoverCacheFileBytes,
  resizeCoverImageBytes,
  resolveBackgroundImageFile,
  prepareBackgroundForDisplay
} from '../library/coverCache'
import { decodeAudioFileUrlPath } from '../library/audioFileUrl.ts'
import {
  initializeLocalPathGrants,
  resolveAuthorizedAudioFile,
  resolveAuthorizedLibraryDirectory
} from '../security/localPaths'
import {
  unregisterPlayerShortcuts,
  destroyTray,
  applyRuntimeSettings
} from '../integrations/shortcutsTray'
import {
  destroyDesktopLyrics,
  showDesktopLyrics,
  setupDesktopLyricsIpc
} from '../integrations/desktopLyrics'
import { destroyDynamicIsland, setupDynamicIslandIpc } from '../integrations/dynamicIsland.ts'
import { restoreMainWindowFromMiniPlayer, setupMiniPlayerIpc } from '../integrations/miniPlayer'
import { setupTrayPlayerIpc } from '../integrations/trayPlayer'
import { destroyWindowsSmtc, setupWindowsSmtcIpc } from '../integrations/windowsSmtc.ts'
import {
  ensureWindowsShellIdentity,
  WINDOWS_APP_USER_MODEL_ID
} from '../integrations/windowsAppIdentity.ts'
import { setupNcmIpc } from '../ncm/api'
import { ensureAudioEngineRuntime, setupAudioEngineIpc } from '../audio/engineIpc'
import { AudioAnalysisServiceClient } from '../audioAnalysisServiceClient.ts'
import { LocalLibraryScanServiceClient } from '../library/libraryScanServiceClient.ts'
import { LibraryDatabaseServiceClient } from '../library/libraryDatabaseServiceClient.ts'
import { LibraryDatabaseRuntime } from '../library/libraryDatabaseRuntime.ts'
import { selectLibraryStorage } from '../library/libraryStorageMode.ts'
import { setupBpmAnalysisIpc } from '../bpm/bpmIpc'
import { setupLoudnessAnalysisIpc } from '../audio/loudnessIpc'
import { setupOpraIpc } from '../ipc/opra'
import { setupPluginIpc } from '../ipc/plugins'
import { setupDataIpc } from '../ipc/data'
import {
  ensureActiveLibraryExclusionsLoaded,
  prepareAudioFilesForRemoval,
  trashLocalFileWithRetry,
  readSacdIsoMetadata
} from '../ipc/libraryIpc.ts'
import { filterAuthorizedLibraryRoots } from '../security/localPaths'
import { normalizeLocalPath } from '../security/ipcValidation.ts'
import { normalizeCachedCoverHandle } from '../library/coverCache'
import { setupLibraryDatabaseIpc } from '../ipc/libraryDatabaseIpc.ts'
import { setupThemeIpc } from '../ipc/themes'
import { resolveThemeAssetFile } from '../themes/themeArchive.ts'
import { setupRadioMediaIpc, destroyRadioMediaIpc } from '../radio/radioMediaIpc.ts'
import { setupRemoteIpc, destroyRemoteIpc } from '../remote/remoteIpc.ts'
import { setupNetworkSourceIpc } from '../network/networkIpc.ts'
import { installElectronSecurity } from '../security/electronSecurity.ts'
import { createRemoteMediaRequestHandler } from '../security/remoteMediaGrants.ts'
import { destroyTelemetry, initializeTelemetry } from '../analytics/index.ts'
import { createWindow } from './window'
import {
  isAfterglowModeActive,
  restoreAfterglowMode,
  shutdownAfterglowMode
} from './AfterglowModeService'
import { startAppUpdateChecks, stopAppUpdateChecks } from './appUpdateService.ts'
import {
  consumeAppSettingsLoadIssue,
  supportsNativeWindowTransparency,
  warmWindowsAcrylicBackdropAvailability
} from '../core/settings'
import type { SettingsFileLoadIssue } from '../persistence/settingsFile.ts'

export function startApp(): void {
  app.setName('TwilightEcho')
  electronApp.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)
  runtime.launchSettings = { ...runtime.appSettings }

  if (!runtime.appSettings.hardwareAcceleration) {
    app.disableHardwareAcceleration()
  }

  if (runtime.appSettings.musicCachePath) {
    try {
      ensureMusicCacheDirectories(runtime.appSettings.musicCachePath)
      app.commandLine.appendSwitch(
        'disk-cache-dir',
        join(runtime.appSettings.musicCachePath, 'renderer-cache')
      )
    } catch (err) {
      console.warn('无法使用自定义缓存目录：', err)
    }
  }

  // Streaming provider URLs are resolved asynchronously after user commands.
  // Desktop playback must not be blocked by Chromium's web-page autoplay policy.
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

  // Linux Wayland 下的输入法（fcitx5/ibus）集成：
  // - KWin 只有在系统设置里配置了「虚拟键盘/输入法」时才会暴露
  //   zwp_input_method 协议（text-input 通道的前提）。未配置时，
  //   Wayland 原生客户端的 text-input 完全不可用，导致 fcitx5 无法输入。
  //   此时回退到 X11（XWayland）后端，让 fcitx5 通过 GTK_IM_MODULE /
  //   XIM 的前端工作（与 VS Code 等 Electron 应用一致）。
  // - KWin 已配置输入法时，遵循 fcitx-im 官方建议使用 text-input-v1；
  //   KWin 对 zwp_text_input_v3 的实现与 Chromium 存在协议理解差异。
  // - GNOME/Sway 等仅支持 text-input-v3 的 compositor 保持 v3。
  if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
    const desktop = (
      process.env.XDG_CURRENT_DESKTOP ||
      process.env.XDG_SESSION_DESKTOP ||
      ''
    ).toLowerCase()
    const isKWin = desktop.includes('kde') || desktop.includes('plasma')

    if (isKWin && !kwinHasInputMethodConfigured()) {
      app.commandLine.appendSwitch('ozone-platform', 'x11')
    } else {
      app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform')
      app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
      app.commandLine.appendSwitch('enable-wayland-ime')
      app.commandLine.appendSwitch('wayland-text-input-version', isKWin ? '1' : '3')
    }
  }

  // Linux 上透明窗口需要显式启用透明视觉，否则整窗不渲染（纯透明）。
  // Wayland 会话不受支持，且该开关可能进一步破坏内容呈现，因此仅在支持时启用。
  if (
    process.platform === 'linux' &&
    runtime.appSettings.windowTransparency === true &&
    supportsNativeWindowTransparency()
  ) {
    app.commandLine.appendSwitch('enable-transparent-visuals')
  }

  const gotSingleInstanceLock = app.requestSingleInstanceLock()
  let libraryStorage: 'json' | 'sqlite' = 'json'
  if (!gotSingleInstanceLock) {
    app.quit()
  } else {
    try {
      libraryStorage = selectLibraryStorage(
        app.getPath('userData'),
        app.isPackaged,
        process.env.TWILIGHT_SQLITE_LIBRARY
      )
      if (libraryStorage === 'json') applyPendingPersonalRestore(app.getPath('userData'))
      runtime.appSettings = readAppSettings()
      runtime.launchSettings = { ...runtime.appSettings }
    } catch (error) {
      dialog.showErrorBox(
        '个人数据恢复尚未完成',
        `数据恢复日志已保留，下次启动将继续恢复。\n${error instanceof Error ? error.message : String(error)}`
      )
      app.exit(1)
      return
    }
    protocol.registerSchemesAsPrivileged([
      {
        scheme: 'plugin-ui',
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
      },
      {
        scheme: 'twilight-audio',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          stream: true
        }
      },
      {
        scheme: 'twilight-media',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          stream: true,
          // Playbar dominant-color sampling loads covers with crossOrigin=anonymous.
          // Without corsEnabled, Chromium taints/fails those requests and can leave
          // the same twilight-media:// URL blank in the player-bar <img> as well.
          corsEnabled: true
        }
      },
      {
        // Local library art (`cover://<hash>.jpg`). Theme sampling also hits these
        // URLs with crossOrigin=anonymous — same corsEnabled requirement as above.
        scheme: 'cover',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true
        }
      },
      {
        scheme: 'background',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true
        }
      },
      {
        scheme: 'theme-asset',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true
        }
      }
    ])

    // Focus-only: no OS protocol client / argv deep links (see AGENTS.md).
    app.on('second-instance', () => {
      if (isAfterglowModeActive()) {
        void restoreAfterglowMode()
        return
      }
      if (runtime.miniPlayerWindow && !runtime.miniPlayerWindow.isDestroyed()) {
        restoreMainWindowFromMiniPlayer()
        return
      }
      const win = runtime.mainWindow
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })

    const acrylicBackdropWarmup = warmWindowsAcrylicBackdropAvailability()
    app.whenReady().then(async () => {
      if (libraryStorage === 'sqlite') {
        try {
          await initializeDatabaseLibrary()
        } catch (error) {
          runtime.libraryDatabase?.destroy()
          runtime.libraryDatabase = null
          runtime.localLibraryScanService?.destroy()
          runtime.localLibraryScanService = null
          dialog.showErrorBox(
            'SQLite 曲库启动未完成',
            `恢复日志与原始数据已保留，未退回旧 JSON。\n${error instanceof Error ? error.message : String(error)}`
          )
          app.exit(1)
          return
        }
      }
      await acrylicBackdropWarmup
      const shellIdentity = ensureWindowsShellIdentity()
      if (!shellIdentity.ok) {
        console.warn(
          '[app-identity] unable to register Windows Shell identity:',
          shellIdentity.error
        )
      }
      installElectronSecurity()
      installExperienceProtocol()
      await initializeLocalPathGrants(runtime.launchSettings)
      if (runtime.libraryDatabase) {
        try {
          await runtime.libraryDatabase.refreshRoots()
        } catch (error) {
          runtime.libraryDatabase.destroy()
          runtime.localLibraryScanService?.destroy()
          dialog.showErrorBox('SQLite 曲库目录授权失败', String(error))
          app.exit(1)
          return
        }
      }

      // Register cover:// protocol — Chromium reads cached image assets directly from disk,
      // no IPC, no base64, browser manages decode cache natively.
      protocol.handle('cover', async (request) => {
        const url = new URL(request.url)
        const fileName = url.hostname + url.pathname
        // Sanitize: only allow alphanumeric/hash filenames
        const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '')
        if (!isCoverCacheFileName(safeName)) {
          return new Response('Forbidden', { status: 403 })
        }
        const data = await readCoverCacheFileBytes(safeName)
        if (!data) {
          return new Response('Not Found', { status: 404 })
        }
        return new Response(data, {
          headers: {
            'Content-Type': getCoverCacheContentType(safeName),
            // Cover filenames are content hashes, so each distinct art has a
            // distinct immutable URL. CoverImg remounts per track identity, which
            // is the real guard against the cold-start sticky-decode issue that
            // once required no-store here.
            'Cache-Control': 'public, max-age=31536000, immutable',
            // Permit crossOrigin=anonymous canvas sampling without tainting
            // concurrent plain <img> loads of the same cover:// URL.
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD'
          }
        })
      })

      protocol.handle('background', async (request) => {
        const url = new URL(request.url)
        const fileName = (url.hostname + url.pathname).replace(/^\/+/, '')
        const filePath = resolveBackgroundImageFile(fileName)
        if (!filePath) {
          return new Response('Not Found', { status: 404 })
        }
        const displayPath = await prepareBackgroundForDisplay(filePath)
        // Stream from disk; Chromium owns the encoded/decode caches. Do not also
        // retain a full wallpaper Buffer in the main-process thumbnail LRU.
        const response = await net
          .fetch(pathToFileURL(displayPath).toString(), {
            method: request.method,
            bypassCustomProtocolHandlers: true
          })
          .catch(() => null)
        if (!response) return new Response('Not Found', { status: 404 })
        const headers = new Headers(response.headers)
        for (const [name, value] of Object.entries({
          // Background filenames are sha256 slices of the stored bytes.
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD'
        }))
          headers.set(name, value)
        return new Response(request.method === 'HEAD' ? null : response.body, {
          status: response.status,
          headers
        })
      })

      protocol.handle('theme-asset', async (request) => {
        try {
          const url = new URL(request.url)
          if (url.hostname !== 'asset') return new Response('Forbidden', { status: 403 })
          const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
          const profileId = segments.shift() ?? ''
          const filePath = resolveThemeAssetFile(profileId, segments.join('/'))
          if (!filePath) return new Response('Not Found', { status: 404 })
          const extension = extname(filePath).toLowerCase()
          const contentType =
            extension === '.png'
              ? 'image/png'
              : extension === '.webp'
                ? 'image/webp'
                : extension === '.woff2'
                  ? 'font/woff2'
                  : 'image/jpeg'
          const data = await readCachedProtocolFile(filePath)
          if (!data) return new Response('Not Found', { status: 404 })
          return new Response(data, {
            headers: {
              'Content-Type': contentType,
              // Theme archive assets can change under a stable profile path.
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, HEAD'
            }
          })
        } catch {
          return new Response('Not Found', { status: 404 })
        }
      })

      protocol.handle('twilight-audio', async (request) => {
        try {
          const url = new URL(request.url)
          const encodedPath = url.pathname.replace(/^\/+/, '')
          if (!encodedPath) return new Response('Bad Request', { status: 400 })
          const filePath = await resolveAuthorizedAudioFile(decodeAudioFileUrlPath(encodedPath))
          return net.fetch(pathToFileURL(filePath).toString(), {
            headers: request.headers,
            bypassCustomProtocolHandlers: true
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : '无法读取音频文件'
          return new Response(message, { status: 404 })
        }
      })

      // Provider CDN art/audio (especially NetEase) is unreliable through Electron's
      // Chromium net.fetch in the main process — headers/redirects get mangled and
      // covers come back as 403 HTML. undici speaks plain HTTP with the UA/Referer
      // we set in remoteMediaGrants and is already a production dependency.
      protocol.handle(
        'twilight-media',
        createRemoteMediaRequestHandler({
          imageCache: createRemoteCoverCache(
            () => (runtime.appSettings.cachePolicy.cover ? getCoverCacheDir() : null),
            { resize: resizeCoverImageBytes }
          ),
          fetch: async (source, init) => {
            const upstream = await undiciFetch(source, {
              method: init.method,
              signal: init.signal,
              headers: init.headers as Record<string, string> | undefined,
              // Manual so remoteMediaGrants can re-apply NetEase Referer on each hop.
              redirect: 'manual'
            })
            // Convert undici Response → web Response for protocol.handle consumers.
            const headers = new Headers()
            upstream.headers.forEach((value, key) => {
              headers.set(key, value)
            })
            return new Response(upstream.body as ReadableStream<Uint8Array> | null, {
              status: upstream.status,
              statusText: upstream.statusText,
              headers
            })
          }
        })
      )

      app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window)
      })

      runtime.localLibraryScanService ??= new LocalLibraryScanServiceClient({
        serviceEntry: join(__dirname, 'libraryScanService.js')
      })
      setupLibraryDatabaseIpc(
        ipcMain,
        runtime.libraryDatabase?.api,
        runtime.libraryDatabase
          ? {
              scanDirectories: (request) => runtime.libraryDatabase!.scanDirectories(request),
              removeFiles: (request) =>
                runtime.libraryDatabase!.removeFiles(request.items, request.mode)
            }
          : undefined,
        runtime.libraryDatabase?.playlistRepair,
        runtime.libraryDatabase?.selections,
        runtime.libraryDatabase?.queueBuilds
      )
      setupDataIpc()
      setupThemeIpc()
      setupDesktopLyricsIpc()
      setupMiniPlayerIpc()
      setupDynamicIslandIpc()
      setupTrayPlayerIpc()
      setupWindowsSmtcIpc()

      setupAudioEngineIpc()
      runtime.audioAnalysisService = new AudioAnalysisServiceClient({
        serviceEntry: join(__dirname, 'audioAnalysisService.js'),
        maxConcurrency: Math.max(1, Math.min(4, Math.floor(cpus().length / 2)))
      })
      setupBpmAnalysisIpc()
      setupLoudnessAnalysisIpc()
      setupNcmIpc()
      setupRadioMediaIpc()
      setupRemoteIpc()
      setupNetworkSourceIpc()
      setupOpraIpc()
      setupPluginIpc()
      initializeTelemetry()

      // Linux 上透明窗口必须等合成器视觉就绪后再建窗，否则内容不渲染
      if (
        process.platform === 'linux' &&
        runtime.appSettings.windowTransparency === true &&
        supportsNativeWindowTransparency()
      ) {
        setTimeout(() => {
          createMainWindowAndScheduleDeferredStartup()
        }, 360)
      } else {
        createMainWindowAndScheduleDeferredStartup()
      }

      app.on('activate', function () {
        if (isAfterglowModeActive()) {
          void restoreAfterglowMode()
          return
        }
        if (runtime.miniPlayerWindow && !runtime.miniPlayerWindow.isDestroyed()) {
          restoreMainWindowFromMiniPlayer()
        } else if (BrowserWindow.getAllWindows().length === 0) {
          createWindow()
        }
      })
    })

    app.on('window-all-closed', () => {
      // Afterglow deliberately lives without any BrowserWindow.
      if (isAfterglowModeActive()) return
      if (process.platform !== 'darwin' && !runtime.appSettings.closeToTray) {
        app.quit()
      }
    })

    app.on('before-quit', () => {
      runtime.forceQuit = true
      destroyDesktopLyrics()
      destroyDynamicIsland()
      // 队列已同步落盘；退出期间的网络投递是尽力而为，未发出的事件下次启动重试。
      void runtime.telemetry?.endSession()
      void runtime.pluginManager?.broadcastEvent('app:before-quit', null)
    })

    app.on('will-quit', () => {
      shutdownAfterglowMode()
      stopAppUpdateChecks()
      destroyDesktopLyrics()
      destroyDynamicIsland()
      destroyWindowsSmtc()
      unregisterPlayerShortcuts()
      destroyTray()
      void runtime.pluginManager?.destroy()
      runtime.bpmAnalysisManager?.cancel()
      runtime.loudnessAnalysisManager?.cancel()
      void runtime.libraryLoudnessManager?.cancel()
      runtime.audioAnalysisService?.destroy()
      runtime.audioAnalysisService = null
      runtime.localLibraryIndexCoordinator?.destroy()
      runtime.localLibraryIndexCoordinator = null
      runtime.libraryDatabase?.destroy()
      runtime.libraryDatabase = null
      runtime.localLibraryScanService?.destroy()
      runtime.localLibraryScanService = null
      runtime.audioEngineManager?.destroy()
      runtime.audioEngineManager = null
      destroyTelemetry()
      runtime.bpmAnalysisManager = null
      runtime.loudnessAnalysisManager = null
      runtime.libraryLoudnessManager = null
      runtime.pluginManager = null
      destroyRadioMediaIpc()
      void destroyRemoteIpc()
      if (runtime.ncmServer) {
        runtime.ncmServer.close()
        runtime.ncmServer = null
      }
      runtime.ncmServerPromise = null
    })
  }
}

async function initializeDatabaseLibrary(): Promise<void> {
  const root = app.getPath('userData')
  const database = new LibraryDatabaseServiceClient({
    serviceEntry: join(__dirname, 'libraryDatabaseService.js'),
    libraryFilePath: join(root, 'music-library.json'),
    coverCacheDir: getCoverCacheDir()
  })
  runtime.localLibraryScanService = new LocalLibraryScanServiceClient({
    serviceEntry: join(__dirname, 'libraryScanService.js')
  })
  runtime.libraryDatabase = new LibraryDatabaseRuntime({
    root,
    libraryFilePath: join(root, 'music-library.json'),
    database,
    scanner: runtime.localLibraryScanService,
    coverCacheDir: getCoverCacheDir(),
    resolveRoots: () => filterAuthorizedLibraryRoots(runtime.appSettings.libraryFolders),
    authorizeRemoval: async (filePath, mode) => {
      const path = normalizeLocalPath(filePath, 'library removal path')
      if (mode === 'trash') await resolveAuthorizedAudioFile(path)
    },
    authorizeRepairDirectory: resolveAuthorizedLibraryDirectory,
    authorizeRepairFile: resolveAuthorizedAudioFile,
    prepareTrash: prepareAudioFilesForRemoval,
    trashItem: async (filePath) => {
      await trashLocalFileWithRetry(
        await resolveAuthorizedAudioFile(normalizeLocalPath(filePath, 'trash item path'))
      )
    },
    normalizeCoverHandle: normalizeCachedCoverHandle,
    readSacdIsoMetadata,
    closeDatabase: () => database.destroy(),
    watcherDebounceMs: runtime.libraryWatcherDebounceMs
  })
  await runtime.libraryDatabase.initialize()
  // Personal restore runs before any other persistence owners or windows and
  // may have restored directory grants/settings used by the rest of startup.
  runtime.appSettings = readAppSettings()
  runtime.launchSettings = { ...runtime.appSettings }
}

function createMainWindowAndScheduleDeferredStartup(): void {
  createWindow()
  showAppSettingsLoadIssue(consumeAppSettingsLoadIssue())
  const mainWindow = runtime.mainWindow
  if (!mainWindow) return
  mainWindow.once('ready-to-show', () => {
    if (runtime.mainWindow !== mainWindow || mainWindow.isDestroyed() || runtime.forceQuit) return
    startAppUpdateChecks()
    if (runtime.appSettings.desktopLyrics.enabled) showDesktopLyrics()
    void ensureAudioEngineRuntime().catch((error) => {
      console.error('[音频引擎] 初始化失败：', error instanceof Error ? error.message : error)
    })
    setTimeout(() => {
      void ensureActiveLibraryExclusionsLoaded()
        .catch((error) => {
          console.error(
            '[library] failed to initialize exclusions before starting watchers:',
            error instanceof Error ? error.message : error
          )
        })
        .then(() => {
          if (runtime.mainWindow !== mainWindow || mainWindow.isDestroyed() || runtime.forceQuit)
            return
          applyRuntimeSettings()
        })
    }, 0)
  })
}

function showAppSettingsLoadIssue(issue: SettingsFileLoadIssue | null): void {
  if (!issue) return

  const options: Electron.MessageBoxOptions =
    issue.kind === 'recovered'
      ? {
          type: 'warning',
          title: 'Twilight Echo 数据恢复',
          message: '设置已从备份恢复',
          detail: issue.restoreError
            ? `已读取有效备份，但恢复主文件失败：${issue.restoreError}`
            : issue.corruptCopyPath
              ? `主文件已由最后一个有效备份恢复。损坏副本保留在：${issue.corruptCopyPath}`
              : '主文件缺失，已由最后一个有效备份恢复。',
          buttons: ['确定'],
          defaultId: 0
        }
      : {
          type: 'error',
          title: 'Twilight Echo 数据恢复',
          message: '设置主文件和备份均已损坏',
          detail: buildCorruptSettingsDetail(issue),
          buttons: ['使用默认设置继续'],
          defaultId: 0
        }
  const win = runtime.mainWindow
  const prompt =
    win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
  void prompt.catch((error) => {
    console.error('[persistence] failed to show settings recovery notice:', error)
  })
}

function buildCorruptSettingsDetail(
  issue: Extract<SettingsFileLoadIssue, { kind: 'corrupt' }>
): string {
  const preservedPaths = [issue.corruptCopyPath, issue.corruptBackupCopyPath].filter(Boolean)
  const preservedDetail =
    preservedPaths.length > 0
      ? `\n\n损坏副本已保留：\n${preservedPaths.join('\n')}`
      : '\n\n无法创建额外副本；请先备份原设置文件。'
  return `应用本次使用默认设置，未把损坏内容当作有效配置。\n主文件：${issue.primaryError}\n备份：${issue.backupError}${preservedDetail}`
}
