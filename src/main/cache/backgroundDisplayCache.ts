import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { backgroundBlurTier } from '../../shared/backgroundDisplay.ts'

// Keep a 4K landscape wallpaper sharp while bounding portrait/panoramic images too.
// Blurred wallpapers lack high-frequency detail, so smaller derivatives dramatically
// reduce GPU texture + Gaussian blur ping-pong FBO memory with no visual loss.
export const BACKGROUND_DISPLAY_MAX_EDGE = 3840
export const BACKGROUND_DISPLAY_MAX_PIXELS = 3840 * 2160
export const BACKGROUND_BLUR_MEDIUM_MAX_EDGE = 1280
export const BACKGROUND_BLUR_MEDIUM_MAX_PIXELS = 1280 * 960
export const BACKGROUND_BLUR_HEAVY_MAX_EDGE = 800
export const BACKGROUND_BLUR_HEAVY_MAX_PIXELS = 800 * 600

export function backgroundDisplaySize(width: number, height: number, blurPx = 0) {
  const tier = backgroundBlurTier(blurPx)
  const maxEdge =
    tier >= 20
      ? BACKGROUND_BLUR_HEAVY_MAX_EDGE
      : tier >= 8
        ? BACKGROUND_BLUR_MEDIUM_MAX_EDGE
        : BACKGROUND_DISPLAY_MAX_EDGE
  const maxPixels =
    tier >= 20
      ? BACKGROUND_BLUR_HEAVY_MAX_PIXELS
      : tier >= 8
        ? BACKGROUND_BLUR_MEDIUM_MAX_PIXELS
        : BACKGROUND_DISPLAY_MAX_PIXELS
  const scale = Math.min(
    1,
    maxEdge / Math.max(width, height),
    Math.sqrt(maxPixels / (width * height))
  )
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale))
  }
}

type DisplayImage = {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(size: { width: number; height: number; quality: 'best' }): DisplayImage
  toPNG(): Buffer
  toBitmap?(): Buffer
  toJPEG?(quality: number): Buffer
}

function canEncodeOpaqueJpeg(source: string, image: DisplayImage): boolean {
  if (typeof image.toJPEG !== 'function') return false
  if (/\.jpe?g$/i.test(source)) return true
  if (typeof image.toBitmap !== 'function') return false
  const bitmap = image.toBitmap()
  if (bitmap.byteLength < 4) return false
  for (let i = 3; i < bitmap.byteLength; i += 4) {
    if (bitmap[i] !== 255) return false
  }
  return true
}

/** Originals remain untouched for export. Only paths, never decoded images, are retained. */
export function createBackgroundDisplayCache(decode: (bytes: Buffer) => DisplayImage) {
  const pending = new Map<string, Promise<string>>()
  const resolved = new Map<string, string>()
  // A page switch can request several large wallpapers at once. Decode them serially.
  let conversion: Promise<unknown> = Promise.resolve()

  async function prepare(source: string, tier: 0 | 8 | 20): Promise<string> {
    const info = await stat(source)
    const directory = join(dirname(source), 'display-v1')
    const tierSuffix = tier > 0 ? `-b${tier}` : ''
    const base = join(
      directory,
      `${basename(source)}-${info.size}-${Math.floor(info.mtimeMs)}${tierSuffix}`
    )
    for (const candidate of [`${base}.jpg`, `${base}.png`]) {
      try {
        await stat(candidate)
        return candidate
      } catch {
        // Generate once, then reuse the encoded derivative across app launches.
      }
    }
    const image = decode(await readFile(source))
    if (image.isEmpty()) return source
    const size = image.getSize()
    const displaySize = backgroundDisplaySize(size.width, size.height, tier)
    if (size.width === displaySize.width && size.height === displaySize.height) return source
    const resized = image.resize({ ...displaySize, quality: 'best' })
    const useJpeg = canEncodeOpaqueJpeg(source, resized)
    const target = useJpeg ? `${base}.jpg` : `${base}.png`
    const bytes = useJpeg ? resized.toJPEG!(tier > 0 ? 85 : 90) : resized.toPNG()
    await mkdir(directory, { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, bytes)
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
    return target
  }

  return async (source: string, blurPx = 0): Promise<string> => {
    const tier = backgroundBlurTier(blurPx)
    const cacheKey = tier > 0 ? `${source}?blur=${tier}` : source
    const cached = resolved.get(cacheKey)
    if (cached) {
      try {
        // A disk-cache cleanup may remove derivatives while the app is running.
        if (cached !== source) await stat(cached)
        resolved.delete(cacheKey)
        resolved.set(cacheKey, cached)
        return cached
      } catch {
        resolved.delete(cacheKey)
      }
    }
    const existing = pending.get(cacheKey)
    if (existing) return existing
    const result = conversion
      .then(() => prepare(source, tier))
      .then((path) => {
        resolved.set(cacheKey, path)
        if (resolved.size > 32) resolved.delete(resolved.keys().next().value!)
        return path
      })
      .catch(() => source)
      .finally(() => pending.delete(cacheKey))
    pending.set(cacheKey, result)
    conversion = result.then(() => undefined)
    return result
  }
}
