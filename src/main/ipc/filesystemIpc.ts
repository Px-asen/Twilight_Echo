import type { IpcMain } from 'electron'
import { resolveAuthorizedAudioFile } from '../security/localPaths'
import { normalizeLocalPath } from '../security/ipcValidation.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { encodeAudioFileUrlPath } from '../library/audioFileUrl.ts'
import { MAX_NATIVE_QUEUE_ITEMS } from '../../shared/nativeQueue.ts'

/** Bounds concurrent filesystem resolution while a queue-sized batch is verified. */
const AUTHORIZATION_BATCH_CONCURRENCY = 16

async function isAudioFileAuthorized(filePath: unknown): Promise<boolean> {
  try {
    await resolveAuthorizedAudioFile(normalizeLocalPath(filePath, 'audio file path'))
    return true
  } catch {
    return false
  }
}

export function registerFilesystemIpc(ipcMain: IpcMain): void {
  ipcMain.handle('fs:getAudioFileUrl', async (event, filePath: string) => {
    assertTrustedIpcSender(event, 'filesystem IPC')
    const resolvedPath = await resolveAuthorizedAudioFile(
      normalizeLocalPath(filePath, 'audio file path')
    )
    return `twilight-audio:///${encodeAudioFileUrlPath(resolvedPath)}`
  })

  ipcMain.handle('fs:isAudioFileAuthorized', async (event, filePath: string) => {
    assertTrustedIpcSender(event, 'filesystem IPC')
    return await isAudioFileAuthorized(filePath)
  })

  // Authorizing a whole native queue one file at a time cost one IPC round-trip
  // per track, which a library-sized queue turns into thousands before playback
  // can start. Verdicts are identical to the single-file channel because this
  // calls the same resolver; only the trip count and the fan-out change.
  ipcMain.handle('fs:areAudioFilesAuthorized', async (event, filePaths: unknown) => {
    assertTrustedIpcSender(event, 'filesystem IPC')
    if (!Array.isArray(filePaths) || filePaths.length > MAX_NATIVE_QUEUE_ITEMS) {
      throw new Error('Audio authorization batch is invalid or too large')
    }
    // Resolution hits the real filesystem per path (realpath + existence) and
    // refreshes the declared roots whenever a path falls outside them, so the
    // batch dedupes and stays bounded instead of flooding the main process.
    const verdicts = new Map<string, boolean>()
    const unique: string[] = []
    for (const filePath of filePaths) {
      const key = typeof filePath === 'string' ? filePath : String(filePath)
      if (verdicts.has(key)) continue
      verdicts.set(key, false)
      unique.push(key)
    }
    let cursor = 0
    const workers = Array.from(
      { length: Math.min(AUTHORIZATION_BATCH_CONCURRENCY, unique.length) },
      async () => {
        while (cursor < unique.length) {
          const key = unique[cursor++]
          verdicts.set(key, await isAudioFileAuthorized(key))
        }
      }
    )
    await Promise.all(workers)
    return filePaths.map(
      (filePath) =>
        verdicts.get(typeof filePath === 'string' ? filePath : String(filePath)) === true
    )
  })
}
