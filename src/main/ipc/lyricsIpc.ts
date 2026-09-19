import { dialog, BrowserWindow, type IpcMain } from 'electron'
import { basename, dirname } from 'path'
import { readFile, stat } from 'fs/promises'
import { importLyricsFromDialog } from '../lyrics/importLyrics.ts'
import { loadLocalCompanionLyrics, loadLocalLyrics } from '../lyrics/loadLyrics.ts'
import { saveLyricsFromDialog } from '../lyrics/saveLyrics.ts'
import {
  assertOnlineLyricsRateLimit,
  searchOnlineLyrics,
  type OnlineLyricsSearchResult
} from '../lyrics/onlineLyricsSearch.ts'
import { decodeLyrics } from '../../shared/lyricsEncoding.ts'
import { runtime } from '../core/runtime'
import {
  resolveAuthorizedAudioFile,
  resolveAuthorizedLibraryDirectory
} from '../security/localPaths'
import { normalizeIpcString, normalizeLocalPath } from '../security/ipcValidation.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { fetchAmlTtml } from '../lyrics/amllTtml.ts'

const MAX_LYRICS_FILE_NAME_LENGTH = 512

export function registerLyricsIpc(ipcMain: IpcMain): void {
  ipcMain.handle('lyrics:getAmlTtml', async (event, songId: unknown): Promise<string | null> => {
    assertTrustedIpcSender(event, 'AMLL TTML IPC')
    return await fetchAmlTtml(songId)
  })

  // Lyrics lazy loader — reads .lrc file on demand, falls back to embedded lyrics
  ipcMain.handle(
    'lyrics:get',
    async (event, dir: string, fileName: string, filePath?: string): Promise<string | null> => {
      assertTrustedIpcSender(event, 'lyrics IPC')
      const safeFileName = basename(
        normalizeIpcString(fileName, 'lyrics file name', MAX_LYRICS_FILE_NAME_LENGTH)
      )
      if (!safeFileName) return null
      let resolvedFilePath: string | null = null
      try {
        resolvedFilePath = filePath
          ? await resolveAuthorizedAudioFile(normalizeLocalPath(filePath, 'lyrics audio file path'))
          : null
      } catch {
        return null
      }
      let resolvedDir = resolvedFilePath ? dirname(resolvedFilePath) : null
      if (!resolvedDir) {
        try {
          resolvedDir = await resolveAuthorizedLibraryDirectory(
            normalizeLocalPath(dir, 'lyrics directory')
          )
        } catch {
          return null
        }
      }
      return await loadLocalLyrics(resolvedDir, safeFileName, resolvedFilePath)
    }
  )

  ipcMain.handle('lyrics:import', async (event): Promise<string | null> => {
    assertTrustedIpcSender(event, 'lyrics import IPC')
    const win = BrowserWindow.getFocusedWindow() ?? runtime.mainWindow
    const options: Electron.OpenDialogOptions = {
      title: 'Import LRC lyrics',
      properties: ['openFile'],
      filters: [{ name: 'Lyrics', extensions: ['lrc', 'txt'] }]
    }
    const result =
      win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
    return await importLyricsFromDialog(
      result,
      async (filePath) => decodeLyrics(await readFile(filePath)).text,
      async (filePath) => (await stat(filePath)).size
    )
  })

  ipcMain.handle('lyrics:save', async (event, contents: string): Promise<string | null> => {
    assertTrustedIpcSender(event, 'lyrics save IPC')
    if (typeof contents !== 'string') throw new Error('Lyrics content must be text')
    const win = BrowserWindow.getFocusedWindow() ?? runtime.mainWindow
    const options: Electron.SaveDialogOptions = {
      title: 'Save LRC lyrics',
      defaultPath: 'lyrics.lrc',
      filters: [{ name: 'LRC lyrics', extensions: ['lrc'] }]
    }
    const result =
      win && !win.isDestroyed()
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
    const saved = await saveLyricsFromDialog(result, contents)
    return saved?.filePath ?? null
  })

  ipcMain.handle(
    'lyrics:searchOnline',
    async (event, query: unknown): Promise<OnlineLyricsSearchResult> => {
      assertTrustedIpcSender(event, 'lyrics search IPC')
      assertOnlineLyricsRateLimit()
      return await searchOnlineLyrics(query)
    }
  )

  // Local translated lyrics loader — reads _trans.lrc file
  ipcMain.handle(
    'lyrics:getTranslated',
    async (event, dir: string, fileName: string, filePath?: string): Promise<string | null> => {
      assertTrustedIpcSender(event, 'lyrics translated IPC')
      const safeFileName = basename(
        normalizeIpcString(fileName, 'lyrics file name', MAX_LYRICS_FILE_NAME_LENGTH)
      )
      if (!safeFileName) return null
      let resolvedFilePath: string | null = null
      try {
        resolvedFilePath = filePath
          ? await resolveAuthorizedAudioFile(normalizeLocalPath(filePath, 'lyrics audio file path'))
          : null
      } catch {
        return null
      }
      let resolvedDir = resolvedFilePath ? dirname(resolvedFilePath) : null
      if (!resolvedDir) {
        try {
          resolvedDir = await resolveAuthorizedLibraryDirectory(
            normalizeLocalPath(dir, 'lyrics directory')
          )
        } catch {
          return null
        }
      }
      return await loadLocalCompanionLyrics(resolvedDir, safeFileName, 'translated')
    }
  )

  // Local romanized lyrics loader — reads _roma.lrc file
  ipcMain.handle(
    'lyrics:getRomanized',
    async (event, dir: string, fileName: string, filePath?: string): Promise<string | null> => {
      assertTrustedIpcSender(event, 'lyrics romanized IPC')
      const safeFileName = basename(
        normalizeIpcString(fileName, 'lyrics file name', MAX_LYRICS_FILE_NAME_LENGTH)
      )
      if (!safeFileName) return null
      let resolvedFilePath: string | null = null
      try {
        resolvedFilePath = filePath
          ? await resolveAuthorizedAudioFile(normalizeLocalPath(filePath, 'lyrics audio file path'))
          : null
      } catch {
        return null
      }
      let resolvedDir = resolvedFilePath ? dirname(resolvedFilePath) : null
      if (!resolvedDir) {
        try {
          resolvedDir = await resolveAuthorizedLibraryDirectory(
            normalizeLocalPath(dir, 'lyrics directory')
          )
        } catch {
          return null
        }
      }
      return await loadLocalCompanionLyrics(resolvedDir, safeFileName, 'romanized')
    }
  )
}
