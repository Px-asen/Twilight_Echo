import { app, nativeImage } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { join, extname, resolve } from 'path'
import { createHash } from 'crypto'
import { getMusicCacheRoot } from '../cache/ncmCache.ts'
import { readCachedProtocolFile, type ProtocolAssetBytes } from '../cache/protocolAssetCache'

// ─── Cover thumbnail disk cache ─────────────────────────────────────
// Every cover that reaches the disk cache is capped at 500px wide JPEG
// (~30-80KB each): main-process imports resize here, the scan worker's raw
// writes are normalized by `normalizeCachedCoverHandle` when the coordinator
// ingests its batches, and remote covers go through `resizeCoverImageBytes`
// before `remoteCoverCache` stores them. The renderer therefore never decodes
// a multi-megapixel bitmap for a thumbnail slot.
// Track.cover stores "cover://<hash>.jpg" instead of multi-MB base64 strings.
// A pre-blurred 32px version ("cover://<hash>_blur.jpg") is also generated
// for background use, eliminating expensive CSS filter: blur() at runtime.
export const COVER_THUMBNAIL_WIDTH = 500
export const COVER_JPEG_QUALITY = 85
export const COVER_BLUR_WIDTH = 32
export const COVER_CACHE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

export function getCoverCacheDir(): string {
  return join(getMusicCacheRoot(), 'cover-cache')
}

export function getLegacyCoverCacheDir(): string {
  return join(app.getPath('userData'), 'cover-cache')
}

export function ensureCoverCacheDir(): string {
  const dir = getCoverCacheDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export const BACKGROUND_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
export const MAX_BACKGROUND_IMAGE_BYTES = 20 * 1024 * 1024

export function getBackgroundImageDir(): string {
  return join(app.getPath('userData'), 'backgrounds')
}

export function ensureBackgroundImageDir(): string {
  const dir = getBackgroundImageDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function resolveBackgroundImageFile(fileName: string): string | null {
  const normalizedName = fileName.replace(/^\/+|\/+$/g, '')
  const safeName = normalizedName.replace(/[^a-zA-Z0-9._-]/g, '')
  if (!safeName || safeName !== normalizedName) return null
  const filePath = join(getBackgroundImageDir(), safeName)
  return existsSync(filePath) ? filePath : null
}

export function importBackgroundImageBuffer(fileName: string, data: Buffer): string {
  const ext = extname(fileName).toLowerCase()
  if (!BACKGROUND_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error('不支持的背景图片格式')
  }
  if (data.byteLength > MAX_BACKGROUND_IMAGE_BYTES) {
    throw new Error('背景图片过大')
  }
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 24)
  const targetName = `${hash}${ext === '.jpeg' ? '.jpg' : ext}`
  const targetPath = join(ensureBackgroundImageDir(), targetName)
  if (!existsSync(targetPath)) {
    writeFileSync(targetPath, data)
  }
  return `background://${targetName}`
}

export function importBackgroundImage(sourcePath: string): string {
  const resolvedPath = resolve(sourcePath)
  const fileStat = statSync(resolvedPath)
  if (!fileStat.isFile() || fileStat.size > MAX_BACKGROUND_IMAGE_BYTES) {
    throw new Error('背景图片无效或过大')
  }
  const data = readFileSync(resolvedPath)
  return importBackgroundImageBuffer(resolvedPath, data)
}

export function normalizeBackgroundImageImportData(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  return null
}

export function resolveCoverCacheFile(fileName: string): string | null {
  const currentPath = join(getCoverCacheDir(), fileName)
  if (existsSync(currentPath)) return currentPath
  const legacyPath = join(getLegacyCoverCacheDir(), fileName)
  return existsSync(legacyPath) ? legacyPath : null
}

/**
 * Async cover read for the cover:// protocol handler: current cache dir first,
 * then legacy dir, served from the main-process LRU once read.
 */
export async function readCoverCacheFileBytes(
  fileName: string
): Promise<ProtocolAssetBytes | null> {
  return readCachedProtocolFile(
    join(getCoverCacheDir(), fileName),
    join(getLegacyCoverCacheDir(), fileName)
  )
}

export function isCoverCacheFileName(fileName: string): boolean {
  return COVER_CACHE_EXTENSIONS.has(extname(fileName).toLowerCase())
}

export function getCoverCacheContentType(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    default:
      return 'image/jpeg'
  }
}

/** Extract cover from image buffer, resize, save to disk cache. Returns cover:// handle.
 *  Also generates a tiny pre-blurred version for background use. */
export function cacheCoverFromBuffer(data: Buffer): string | null {
  try {
    const img = nativeImage.createFromBuffer(data)
    if (img.isEmpty()) return null
    const originalSize = img.getSize()
    let resized = img
    if (originalSize.width > COVER_THUMBNAIL_WIDTH) {
      resized = img.resize({ width: COVER_THUMBNAIL_WIDTH, quality: 'good' })
    }
    const jpegBuf = resized.toJPEG(COVER_JPEG_QUALITY)
    const hash = createHash('md5').update(jpegBuf).digest('hex').slice(0, 16)
    const fileName = `${hash}.jpg`
    const cacheDir = ensureCoverCacheDir()
    const fullPath = join(cacheDir, fileName)
    if (!existsSync(fullPath)) {
      writeFileSync(fullPath, jpegBuf)
    }
    // Generate pre-blurred tiny version for background (eliminates CSS blur at runtime)
    const blurFileName = `${hash}_blur.jpg`
    const blurPath = join(cacheDir, blurFileName)
    if (!existsSync(blurPath)) {
      const blurred = resized.resize({ width: COVER_BLUR_WIDTH, quality: 'good' })
      writeFileSync(blurPath, blurred.toJPEG(60))
    }
    return `cover://${fileName}`
  } catch {
    return null
  }
}

/**
 * Downscale encoded image bytes to the cover thumbnail width. Returns null when
 * the image already fits, cannot be decoded (GIF/SVG/WebP stay as-is), or is
 * not a raster type nativeImage handles; callers then keep the original bytes.
 */
export function resizeCoverImageBytes(
  bytes: Uint8Array,
  mime: string
): { bytes: Buffer; mime: string } | null {
  if (!/^image\/(?:jpe?g|png|webp)$/i.test(mime.split(';', 1)[0].trim())) return null
  try {
    const img = nativeImage.createFromBuffer(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    )
    if (img.isEmpty()) return null
    if (img.getSize().width <= COVER_THUMBNAIL_WIDTH) return null
    const resized = img.resize({ width: COVER_THUMBNAIL_WIDTH, quality: 'good' })
    return { bytes: resized.toJPEG(COVER_JPEG_QUALITY), mime: 'image/jpeg' }
  } catch {
    return null
  }
}

const MAX_NORMALIZED_COVER_HANDLES = 4096
const normalizedCoverHandles = new Map<string, Promise<string>>()

/**
 * The scan worker has no nativeImage, so it writes embedded/folder art at its
 * original size. Re-encode any such `cover://` file wider than the thumbnail
 * width to a 500px JPEG entry and return the replacement handle. Handles that
 * already fit (or cannot be decoded) are returned unchanged; results are
 * memoized so albums sharing one picture decode it once.
 */
export function normalizeCachedCoverHandle(handle: string): Promise<string> {
  const memoized = normalizedCoverHandles.get(handle)
  if (memoized) return memoized
  const pending = normalizeCachedCoverHandleUncached(handle).catch(() => handle)
  normalizedCoverHandles.delete(handle)
  normalizedCoverHandles.set(handle, pending)
  while (normalizedCoverHandles.size > MAX_NORMALIZED_COVER_HANDLES) {
    const oldest = normalizedCoverHandles.keys().next().value
    if (oldest === undefined) break
    normalizedCoverHandles.delete(oldest)
  }
  return pending
}

async function normalizeCachedCoverHandleUncached(handle: string): Promise<string> {
  if (!handle.startsWith('cover://')) return handle
  const fileName = handle.slice('cover://'.length)
  if (fileName.includes('/') || !isCoverCacheFileName(fileName)) return handle
  const filePath = resolveCoverCacheFile(fileName)
  if (!filePath) return handle
  const data = await readFile(filePath)
  const resized = resizeCoverImageBytes(data, getCoverCacheContentType(fileName))
  if (!resized) return handle
  const hash = createHash('md5').update(resized.bytes).digest('hex').slice(0, 16)
  const targetName = `${hash}.jpg`
  const targetPath = join(ensureCoverCacheDir(), targetName)
  if (!existsSync(targetPath)) writeFileSync(targetPath, resized.bytes)
  return `cover://${targetName}`
}

/** Migrate a base64 data: URL cover to disk cache. Returns cover:// handle. */
export function migrateBase64Cover(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  try {
    const buf = Buffer.from(match[2], 'base64')
    return cacheCoverFromBuffer(buf)
  } catch {
    return null
  }
}
