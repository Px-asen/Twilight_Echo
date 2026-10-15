import type { AppBackgroundImagePalette } from '../../../shared/appSettings.ts'
import { backgroundDisplayUrl } from '../../../shared/backgroundDisplay.ts'

const LOCAL_BACKGROUND_IMAGE = /^background:\/\/[a-zA-Z0-9._-]+$/
const SAMPLE_SIZE = 48
type PaletteBucket = { red: number; green: number; blue: number; weight: number }

function color(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((channel) =>
      Math.round(Math.max(0, Math.min(255, channel)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

/** Small, deterministic local raster sample; black, white and grayscale remain valid colors. */
export function backgroundImagePaletteFromPixels(
  pixels: ArrayLike<number>,
  image: string
): AppBackgroundImagePalette | null {
  if (!LOCAL_BACKGROUND_IMAGE.test(image) || !pixels.length || pixels.length % 4 !== 0) return null
  let red = 0
  let green = 0
  let blue = 0
  let totalAlpha = 0
  const buckets = new Map<number, PaletteBucket>()
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const channels = [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]]
    if (channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255))
      return null
    const [r, g, b, a] = channels
    const alpha = a / 255
    red += r * alpha
    green += g * alpha
    blue += b * alpha
    totalAlpha += alpha
    const maximum = Math.max(r, g, b)
    const minimum = Math.min(r, g, b)
    // An actual chromatic region supplies the tint; neutral images use their own average.
    if (alpha < 0.04 || maximum - minimum < 20 || maximum < 24 || minimum > 240) continue
    const key = (Math.floor(r / 16) << 8) | (Math.floor(g / 16) << 4) | Math.floor(b / 16)
    const bucket = buckets.get(key) ?? { red: 0, green: 0, blue: 0, weight: 0 }
    const weight = alpha * (0.25 + ((maximum - minimum) / 255) * 0.75)
    bucket.red += r * weight
    bucket.green += g * weight
    bucket.blue += b * weight
    bucket.weight += weight
    buckets.set(key, bucket)
  }
  const average =
    totalAlpha > 0 ? color(red / totalAlpha, green / totalAlpha, blue / totalAlpha) : '#000000'
  let dominant: PaletteBucket | undefined
  for (const bucket of buckets.values())
    if (!dominant || bucket.weight > dominant.weight) dominant = bucket
  return {
    image,
    average,
    accent: dominant
      ? color(
          dominant.red / dominant.weight,
          dominant.green / dominant.weight,
          dominant.blue / dominant.weight
        )
      : average,
    opacity: Number((totalAlpha / (pixels.length / 4)).toFixed(4))
  }
}

/** Decode once, sample locally, and release the bitmap on completion or cancellation. */
export function analyzeBackgroundImage(
  source: string,
  options: {
    createImage: () => HTMLImageElement
    createCanvas: () => HTMLCanvasElement
    signal?: AbortSignal
    timeoutMs?: number
  }
): Promise<AppBackgroundImagePalette | null> {
  if (!LOCAL_BACKGROUND_IMAGE.test(source)) return Promise.reject(new Error('无法读取本地背景图片'))
  if (options.signal?.aborted)
    return Promise.reject(new DOMException('图片分析已取消', 'AbortError'))
  return new Promise((resolve, reject) => {
    const image = options.createImage()
    let finished = false
    const cleanup = (): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      image.onload = null
      image.onerror = null
      image.src = ''
    }
    const fail = (error: Error): void => {
      if (finished) return
      finished = true
      cleanup()
      reject(error)
    }
    const abort = (): void => fail(new DOMException('图片分析已取消', 'AbortError'))
    const timer = setTimeout(
      () => fail(new Error('图片读取超时，请重新选择')),
      options.timeoutMs ?? 12000
    )
    options.signal?.addEventListener('abort', abort, { once: true })
    image.decoding = 'async'
    image.crossOrigin = 'anonymous'
    image.src = backgroundDisplayUrl(source)
    let decoding: Promise<void>
    try {
      decoding = image.decode()
    } catch {
      fail(new Error('无法读取这张图片'))
      return
    }
    void decoding.then(
      () => {
        if (finished) return
        let palette: AppBackgroundImagePalette | null = null
        try {
          const canvas = options.createCanvas()
          canvas.width = SAMPLE_SIZE
          canvas.height = SAMPLE_SIZE
          const context = canvas.getContext('2d', { willReadFrequently: true })
          if (context) {
            context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
            palette = backgroundImagePaletteFromPixels(
              context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data,
              source
            )
          }
        } catch {
          // Sampling failure must not discard an otherwise decoded image or manual colors.
        }
        finished = true
        cleanup()
        resolve(palette)
      },
      () => fail(new Error('无法读取这张图片'))
    )
  })
}
