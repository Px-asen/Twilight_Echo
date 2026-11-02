import type { IpcMain } from 'electron'
import {
  COVER_SMALL_JPEG_QUALITY,
  COVER_SMALL_THUMBNAIL_WIDTH,
  cacheCoverFromBuffer,
  isCoverCacheFileName,
  readCoverCacheFileBytes,
  readCoverCacheThumbnailBytes,
  resizeCoverImageBytes
} from '../library/coverCache'
import { grantRemoteImageUrl } from '../security/remoteMediaGrants.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'

const MAX_DATA_URL_BYTES = 8 * 1024 * 1024
const MAX_COVER_INPUT_BYTES = 16 * 1024 * 1024

export type CoverIpcResult = Uint8Array | string | null
export type CoverDisplaySize = 'sm' | 'md'

export function registerCoverIpc(ipcMain: IpcMain): void {
  ipcMain.handle(
    'cover:get',
    async (event, handle: string, size?: CoverDisplaySize): Promise<CoverIpcResult> => {
      assertTrustedIpcSender(event, 'cover IPC')
      if (!handle || typeof handle !== 'string') return null
      // Pass through existing data: URLs (e.g. from plugins)
      if (handle.startsWith('data:')) return normalizeCoverDataUrl(handle, size)
      if (!handle.startsWith('cover://')) return null
      const fileName = handle.slice('cover://'.length).split(/[?#]/, 1)[0]
      if (!fileName || fileName.includes('/') || !isCoverCacheFileName(fileName)) return null
      if (size === 'sm') return await readCoverCacheThumbnailBytes(fileName, 'sm')
      return await readCoverCacheFileBytes(fileName)
    }
  )

  ipcMain.handle('cover:cache', async (event, input: unknown): Promise<string | null> => {
    assertTrustedIpcSender(event, 'cover IPC')
    const data = normalizeCoverBuffer(input)
    if (!data || data.byteLength === 0 || data.byteLength > MAX_COVER_INPUT_BYTES) return null
    return cacheCoverFromBuffer(data)
  })

  // Re-issue an image grant for a durable http(s) cover origin (session restore /
  // listening-stats rows whose previous twilight-media token has expired).
  ipcMain.handle('cover:grantRemote', async (event, source: string): Promise<string> => {
    assertTrustedIpcSender(event, 'cover IPC')
    const raw = typeof source === 'string' ? source.trim() : ''
    if (!raw || raw.length > 4096) throw new Error('Remote cover source is invalid')
    return grantRemoteImageUrl(raw)
  })
}

function normalizeCoverDataUrl(handle: string, size?: CoverDisplaySize): CoverIpcResult {
  const match = handle.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/i)
  if (!match) return null
  if (Buffer.byteLength(handle, 'utf-8') > MAX_DATA_URL_BYTES) return null
  if (size === 'sm' && !/^image\/gif$/i.test(match[1])) {
    try {
      const raw = Buffer.from(match[2], 'base64')
      const resized = resizeCoverImageBytes(
        raw,
        match[1],
        COVER_SMALL_THUMBNAIL_WIDTH,
        COVER_SMALL_JPEG_QUALITY
      )
      if (resized) return resized.bytes
    } catch {
      // Fall back to original validated data URL.
    }
  }
  return handle
}

function normalizeCoverBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  return null
}
