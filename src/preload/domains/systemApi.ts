import { collectClosePersistenceOutcome } from '../closePersistence.ts'
import { ipcRenderer, webFrame } from 'electron'
import { afterglowApi } from './afterglowApi.ts'
import {
  normalizePlaybackSessionSaveOptions,
  type PlaybackSessionSaveOptions
} from '../../shared/closePersistence.ts'
import type { EqualizerClipboardApi, NativeContextMenuRequest } from '../types'
import { NCM_CLOUD_TRANSFER_PROGRESS_CHANNEL } from '../../shared/ncmCloud.ts'
import { IPC } from '../../shared/ipcChannels.ts'
import { isAppHistoryCommand, type AppHistoryCommand } from '../../shared/appHistory.ts'
import type {
  NcmCloudDownloadRequest,
  NcmCloudDownloadResult,
  NcmCloudSelectedFile,
  NcmCloudTransferProgress,
  NcmCloudUploadResult,
  TrayNavigationTarget
} from '../types'
import type { AppStartupSnapshot } from '../../shared/appStartup.ts'
import type { SystemMediaNativeStatus } from '../../shared/systemMedia.ts'
import type { WindowChromeState } from '../../shared/windowChrome.ts'
import type {
  AppUpdateCheckResult,
  AppUpdateDownloadResult,
  AppUpdateInstallResult,
  AppUpdateProgress,
  AppUpdateSnapshot,
  AppUpdatePreferencePatch
} from '../../shared/appUpdate.ts'

const appNavigationCallbacks = new Set<(target: TrayNavigationTarget) => void>()
const historyCommandCallbacks = new Set<(command: AppHistoryCommand) => void>()
const savePlaybackSessionCallbacks = new Set<
  (options?: PlaybackSessionSaveOptions) => Promise<void> | void
>()
const equalizerClipboardApi: EqualizerClipboardApi = {
  copyEqBands: (bands) => ipcRenderer.invoke('window:copy-eq-bands', bands),
  pasteEqBands: () => ipcRenderer.invoke('window:paste-eq-bands')
}

export function bindSystemIpcEvents(): void {
  ipcRenderer.on(
    'app:save-playback-session',
    async (_event, requestId: string, rawOptions: unknown) => {
      const options = normalizePlaybackSessionSaveOptions(rawOptions)
      const outcome = await collectClosePersistenceOutcome(savePlaybackSessionCallbacks, options)
      try {
        await ipcRenderer.invoke('app:playback-session-saved', requestId, outcome)
      } catch (error) {
        // The main process treats a missing result as a timeout and keeps the
        // window open. Do not convert this IPC failure into a successful ACK.
        console.error('[persistence] Failed to report close persistence outcome:', error)
      }
    }
  )

  ipcRenderer.on('app:navigate', (_event, target: TrayNavigationTarget) => {
    if (target !== 'local' && target !== 'streaming') return
    for (const cb of appNavigationCallbacks) cb(target)
  })

  ipcRenderer.on(IPC.app.historyCommand, (_event, command: unknown) => {
    if (!isAppHistoryCommand(command)) return
    for (const cb of historyCommandCallbacks) cb(command)
  })
}

export const systemApi = {
  systemMedia: {
    getNativeStatus: (): Promise<SystemMediaNativeStatus> =>
      ipcRenderer.invoke('systemMedia:getNativeStatus')
  },
  window: {
    ...equalizerClipboardApi,
    copyTrackNames: (text: string): Promise<void> =>
      ipcRenderer.invoke('window:copy-track-names', text),
    getState: (): Promise<WindowChromeState> => ipcRenderer.invoke('window:getState'),
    onStateChanged: (callback: (state: WindowChromeState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: WindowChromeState): void => {
        callback(state)
      }
      ipcRenderer.on('window:state-changed', listener)
      return () => ipcRenderer.removeListener('window:state-changed', listener)
    },
    popupContextMenu: (request: NativeContextMenuRequest): Promise<string | null> =>
      ipcRenderer.invoke('contextMenu:popup', request),
    closeContextMenu: (requestId: string): Promise<void> =>
      ipcRenderer.invoke('contextMenu:close', requestId),
    minimize: (): void => ipcRenderer.send('window:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('window:toggleMaximize'),
    close: (): void => ipcRenderer.send('window:close'),
    clearMemoryCache: (): void => {
      try {
        webFrame?.clearCache?.()
      } catch {
        // Ignore in non-Electron test environments.
      }
    }
  },
  dialog: {
    openFolder: (options?: { deferImport?: boolean }): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder', options)
  },
  shell: {
    showItemInFolder: (filePath: string): Promise<void> =>
      ipcRenderer.invoke('shell:showItemInFolder', filePath),
    openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:openPath', path),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url)
  },
  discord: {
    getStatus: (): Promise<{
      enabled: boolean
      connected: boolean
      lastError: string | null
    }> => ipcRenderer.invoke('discord:getStatus'),
    updateActivity: (data: {
      title: string
      artist: string
      album?: string
      playing: boolean
      startTime?: number
    }): Promise<void> => ipcRenderer.invoke('discord:updateActivity', data),
    clearActivity: (): Promise<void> => ipcRenderer.invoke('discord:clearActivity')
  },
  app: {
    getStartupSnapshot: (): Promise<AppStartupSnapshot> =>
      ipcRenderer.invoke('app:getStartupSnapshot'),
    consumePendingNavigation: (): Promise<TrayNavigationTarget | null> =>
      ipcRenderer.invoke('app:consumePendingNavigation'),
    relaunch: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
    checkForUpdates: (): Promise<AppUpdateCheckResult> => ipcRenderer.invoke('app:checkForUpdates'),
    getUpdateState: (): Promise<AppUpdateSnapshot> => ipcRenderer.invoke('app:getUpdateState'),
    setUpdatePreferences: (patch: AppUpdatePreferencePatch): Promise<AppUpdateSnapshot> =>
      ipcRenderer.invoke('app:setUpdatePreferences', patch),
    dismissUpdate: (action: 'skip' | 'later'): Promise<AppUpdateSnapshot> =>
      ipcRenderer.invoke('app:dismissUpdate', action),
    onUpdateState: (cb: (snapshot: AppUpdateSnapshot) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: AppUpdateSnapshot): void =>
        cb(snapshot)
      ipcRenderer.on('app:update-state', handler)
      return () => ipcRenderer.removeListener('app:update-state', handler)
    },
    downloadUpdate: (): Promise<AppUpdateDownloadResult> =>
      ipcRenderer.invoke('app:downloadUpdate'),
    cancelUpdateDownload: (): Promise<boolean> => ipcRenderer.invoke('app:cancelUpdateDownload'),
    installUpdate: (): Promise<AppUpdateInstallResult> => ipcRenderer.invoke('app:installUpdate'),
    onUpdateProgress: (cb: (progress: AppUpdateProgress) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: AppUpdateProgress): void => {
        cb(progress)
      }
      ipcRenderer.on('app:update-progress', handler)
      return () => ipcRenderer.removeListener('app:update-progress', handler)
    },
    onSavePlaybackSession: (
      cb: (options?: PlaybackSessionSaveOptions) => Promise<void> | void
    ): (() => void) => {
      savePlaybackSessionCallbacks.add(cb)
      return () => savePlaybackSessionCallbacks.delete(cb)
    },
    onNavigate: (cb: (target: TrayNavigationTarget) => void): (() => void) => {
      appNavigationCallbacks.add(cb)
      return () => appNavigationCallbacks.delete(cb)
    },
    onHistoryCommand: (cb: (command: AppHistoryCommand) => void): (() => void) => {
      historyCommandCallbacks.add(cb)
      return () => historyCommandCallbacks.delete(cb)
    },
    afterglow: afterglowApi
  },
  ncmCloud: {
    chooseUploadFiles: (): Promise<NcmCloudSelectedFile[]> =>
      ipcRenderer.invoke('ncmCloud:chooseUploadFiles'),
    upload: (handle: string): Promise<NcmCloudUploadResult> =>
      ipcRenderer.invoke('ncmCloud:upload', handle),
    download: (request: NcmCloudDownloadRequest): Promise<NcmCloudDownloadResult> =>
      ipcRenderer.invoke('ncmCloud:download', request),
    cancel: (transferId: string): Promise<boolean> =>
      ipcRenderer.invoke('ncmCloud:cancel', transferId),
    onProgress: (callback: (progress: NcmCloudTransferProgress) => void): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        progress: NcmCloudTransferProgress
      ): void => {
        callback(progress)
      }
      ipcRenderer.on(NCM_CLOUD_TRANSFER_PROGRESS_CHANNEL, handler)
      return () => ipcRenderer.removeListener(NCM_CLOUD_TRANSFER_PROGRESS_CHANNEL, handler)
    }
  },
  fonts: {
    listInstalled: (): Promise<string[]> => ipcRenderer.invoke('fonts:listInstalled')
  }
}
