export type OkLabTuple = readonly [number, number, number]

export interface MasteredFluidCover {
  readonly width: number
  readonly height: number
  /** RGBA sRGB bytes (width * height * 4), contrast-mastered and gamut-mapped for WebGL/Canvas2D. */
  readonly pixels: Uint8Array
  /**
   * Five distinct perceptual OkLab palette anchors extracted via diversity-penalized hue clustering:
   * [0..3] = top 4 distinct vibrant cover hues, [4] = deep velvet shadow anchor for 3D fold contrast.
   */
  readonly anchorsOkLab: readonly [
    OkLabTuple,
    OkLabTuple,
    OkLabTuple,
    OkLabTuple,
    OkLabTuple
  ]
  /** Whether the source artwork carried meaningful chromatic content. */
  readonly isChromatic: boolean
}

export interface FluidMasteringOptions {
  tone?: 'dark' | 'light'
  fallbackAccentHex?: string
  signal?: AbortSignal
}

export const FLUID_COVER_SIZE = 128
const MAX_MASTERED_COVER_CACHE = 12
const masteredCoverCache = new Map<string, Promise<MasteredFluidCover>>()

function compactFluidCoverKey(url: string): string {
  if (url.length <= 256) return url
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  const step = Math.max(1, Math.floor(url.length / 2048))
  for (let i = 0; i < url.length; i += step) {
    const code = url.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (code + i), 0x85ebca6b) >>> 0
  }
  return `inline:${url.length}:${h1.toString(16)}:${h2.toString(16)}`
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1), 0, 1)
  return t * t * (3 - 2 * t)
}

export function srgbChannelToLinear(channel01: number): number {
  const c = clamp(channel01, 0, 1)
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function linearChannelToSrgb(linear: number): number {
  const c = clamp(linear, 0, 1)
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

export function srgbToOkLab(r01: number, g01: number, b01: number): [number, number, number] {
  const r = srgbChannelToLinear(r01)
  const g = srgbChannelToLinear(g01)
  const b = srgbChannelToLinear(b01)

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

export function okLabToLinearRgb(L: number, a: number, b: number): [number, number, number] {
  const lRoot = L + 0.3963377774 * a + 0.2158037573 * b
  const mRoot = L - 0.1055613458 * a - 0.0638541728 * b
  const sRoot = L - 0.0894841775 * a - 1.291485548 * b

  const l = lRoot * lRoot * lRoot
  const m = mRoot * mRoot * mRoot
  const s = sRoot * sRoot * sRoot

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
}

/**
 * Converts OkLab to sRGB [0..1] while preserving exact perceptual hue if chroma
 * exceeds the sRGB gamut cube (prevents cobalt blue -> cyan or amber -> yellow clipping).
 */
export function okLabToGamutSrgb(L: number, a: number, b: number): [number, number, number] {
  const clampedL = clamp(L, 0, 1)
  let [lr, lg, lb] = okLabToLinearRgb(clampedL, a, b)
  if (lr < 0 || lr > 1 || lg < 0 || lg > 1 || lb < 0 || lb > 1) {
    let low = 0
    let high = 1
    for (let step = 0; step < 6; step++) {
      const mid = (low + high) * 0.5
      const [tr, tg, tb] = okLabToLinearRgb(clampedL, a * mid, b * mid)
      if (
        tr >= -0.0005 &&
        tr <= 1.0005 &&
        tg >= -0.0005 &&
        tg <= 1.0005 &&
        tb >= -0.0005 &&
        tb <= 1.0005
      ) {
        low = mid
      } else {
        high = mid
      }
    }
    ;[lr, lg, lb] = okLabToLinearRgb(clampedL, a * low, b * low)
  }
  return [linearChannelToSrgb(lr), linearChannelToSrgb(lg), linearChannelToSrgb(lb)]
}

function parseHexToRgb01(hex: string | undefined): [number, number, number] {
  const clean = (hex ?? '').trim().replace(/^#/, '')
  if (!/^[\da-fA-F]{6}$/.test(clean)) return [0.13, 0.34, 0.78]
  return [
    Number.parseInt(clean.slice(0, 2), 16) / 255,
    Number.parseInt(clean.slice(2, 4), 16) / 255,
    Number.parseInt(clean.slice(4, 6), 16) / 255
  ]
}

interface HueCluster {
  x: number
  y: number
  L: number
  a: number
  b: number
  mass: number
}

function buildGaussianKernel(radius: number, sigma: number): Float32Array {
  const size = radius * 2 + 1
  const kernel = new Float32Array(size)
  let sum = 0
  const invTwoSigmaSq = 1 / (2 * sigma * sigma)
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) * invTwoSigmaSq)
    kernel[i + radius] = w
    sum += w
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum
  return kernel
}

// Gentle anti-aliasing pre-filter (radius 2, sigma 1.25): removes sharp text/pixel-art jaggies
// WITHOUT blurring distinct color regions into a single muddy average.
const GAUSSIAN_RADIUS = 2
const GAUSSIAN_KERNEL = buildGaussianKernel(GAUSSIAN_RADIUS, 1.25)

function blurOkLabGrid(
  L: Float32Array,
  a: Float32Array,
  b: Float32Array,
  width: number,
  height: number
): void {
  const count = width * height
  const tmpL = new Float32Array(count)
  const tmpA = new Float32Array(count)
  const tmpB = new Float32Array(count)
  const r = GAUSSIAN_RADIUS
  const k = GAUSSIAN_KERNEL

  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let sumL = 0
      let sumA = 0
      let sumB = 0
      for (let dx = -r; dx <= r; dx++) {
        const sx = clamp(x + dx, 0, width - 1)
        const w = k[dx + r]!
        const idx = row + sx
        sumL += L[idx]! * w
        sumA += a[idx]! * w
        sumB += b[idx]! * w
      }
      const out = row + x
      tmpL[out] = sumL
      tmpA[out] = sumA
      tmpB[out] = sumB
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sumL = 0
      let sumA = 0
      let sumB = 0
      for (let dy = -r; dy <= r; dy++) {
        const sy = clamp(y + dy, 0, height - 1)
        const w = k[dy + r]!
        const idx = sy * width + x
        sumL += tmpL[idx]! * w
        sumA += tmpA[idx]! * w
        sumB += tmpB[idx]! * w
      }
      const out = y * width + x
      L[out] = sumL
      a[out] = sumA
      b[out] = sumB
    }
  }
}

function boostJewelChroma(
  L: number,
  okA: number,
  okB: number,
  minChromaFloor = 0
): [number, number, number] {
  const c = Math.hypot(okA, okB)
  if (c <= 1e-5) return [L, okA, okB]
  const rawBoost = c * 1.56 + 0.042 * smoothstep(0.014, 0.075, c)
  const targetC = Math.max(minChromaFloor, 0.305 * Math.tanh(rawBoost / 0.305))
  const scale = targetC / c
  return [L, okA * scale, okB * scale]
}

function okLabDistance(a: OkLabTuple, b: OkLabTuple): number {
  const dL = (a[0] - b[0]) * 0.65
  const dA = a[1] - b[1]
  const dB = a[2] - b[2]
  return Math.hypot(dL, dA, dB)
}

/**
 * Pure CPU perceptual mastering of raw RGBA cover pixels into:
 * 1. A sharp, contrast-stretched, white-border-suppressed OkLab cover texture.
 * 2. Five maximally distinct OkLab palette anchors (4 vibrant cover hues + 1 deep velvet shadow anchor)
 *    using 18-sector hue clustering with mutual color-distance diversity scoring (never quadrant averaging!).
 */
export function masterFluidCoverPixels(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: FluidMasteringOptions = {}
): MasteredFluidCover {
  const tone = options.tone ?? 'dark'
  const count = width * height
  const gridL = new Float32Array(count)
  const gridA = new Float32Array(count)
  const gridB = new Float32Array(count)
  const chroma = new Float32Array(count)
  const alphaArr = new Float32Array(count)

  const CHROMA_THRESHOLD = 0.032
  const HUE_BINS = 18
  const hueBuckets = Array.from({ length: HUE_BINS }, () => ({
    x: 0,
    y: 0,
    L: 0,
    a: 0,
    b: 0,
    w: 0,
    mass: 0
  }))

  // 32-bin lightness histogram for adaptive auto-levels contrast stretching
  const HIST_BINS = 32
  const lHist = new Uint32Array(HIST_BINS)
  let validToneCount = 0
  let chromaticCount = 0
  let opaqueCount = 0

  for (let y = 0; y < height; y++) {
    const ny = (y + 0.5) / height
    for (let x = 0; x < width; x++) {
      const nx = (x + 0.5) / width
      const idx = y * width + x
      const p = idx * 4
      const alpha = (rgba[p + 3] ?? 255) / 255
      alphaArr[idx] = alpha

      const r = (rgba[p] ?? 0) / 255
      const g = (rgba[p + 1] ?? 0) / 255
      const b = (rgba[p + 2] ?? 0) / 255
      const [L, okA, okB] = srgbToOkLab(r, g, b)
      const c = Math.hypot(okA, okB)

      gridL[idx] = L
      gridA[idx] = okA
      gridB[idx] = okB
      chroma[idx] = c

      if (alpha >= 0.4) {
        opaqueCount++
        // Exclude white borders/billboards, blown-out tinted white glare, and dead-black bars from histogram & palette
        const isWhiteOrGlare = c < 0.072 && L > 0.82
        const isDeadBlackBar = c < 0.022 && L < 0.055
        if (!isWhiteOrGlare && !isDeadBlackBar) {
          const hBin = clamp(Math.floor(L * HIST_BINS), 0, HIST_BINS - 1)
          lHist[hBin]!++
          validToneCount++
        }

        if (c >= CHROMA_THRESHOLD && L >= 0.06 && L <= 0.93 && !isWhiteOrGlare) {
          chromaticCount++
          const angle = Math.atan2(okB, okA) // [-PI, PI]
          const binIdx =
            Math.floor(((angle + Math.PI) / (Math.PI * 2)) * HUE_BINS) % HUE_BINS
          // Weight strongly by chroma^2.1 and reject blown-out glare so each hue bucket
          // captures its pure vivid pigment rather than white/lavender-diluted bloom pixels.
          const purityWeight =
            Math.pow(c, 2.1) *
            (0.35 + 0.65 * Math.sin(clamp(L, 0.08, 0.9) * Math.PI)) *
            (1 - smoothstep(0.8, 0.93, L)) *
            alpha
          const massWeight = Math.pow(c, 1.25) * (1 - 0.65 * smoothstep(0.8, 0.94, L)) * alpha
          const bucket = hueBuckets[binIdx]!
          bucket.x += nx * purityWeight
          bucket.y += ny * purityWeight
          bucket.L += L * purityWeight
          bucket.a += okA * purityWeight
          bucket.b += okB * purityWeight
          bucket.w += purityWeight
          bucket.mass += massWeight
        }
      }
    }
  }

  const isChromatic = opaqueCount > 0 && chromaticCount / opaqueCount >= 0.032

  // Compute 12th and 88th lightness percentiles so high-key pastel/anime covers
  // stretch across deep shadow valleys and glowing highlights instead of flat mid-gray!
  let p12 = 0.14
  let p88 = 0.86
  if (validToneCount >= 16) {
    let acc = 0
    let foundLow = false
    for (let i = 0; i < HIST_BINS; i++) {
      acc += lHist[i]!
      const frac = acc / validToneCount
      if (!foundLow && frac >= 0.12) {
        p12 = i / HIST_BINS
        foundLow = true
      }
      if (frac >= 0.88) {
        p88 = (i + 1) / HIST_BINS
        break
      }
    }
    if (p88 - p12 < 0.22) {
      const mid = (p12 + p88) * 0.5
      p12 = clamp(mid - 0.14, 0.04, 0.72)
      p88 = clamp(mid + 0.14, p12 + 0.2, 0.96)
    }
  }

  // Extract distinct hue clusters
  const candidates: HueCluster[] = []
  if (isChromatic) {
    for (let i = 0; i < HUE_BINS; i++) {
      const b = hueBuckets[i]!
      if (b.w > 1e-5) {
        candidates.push({
          x: b.x / b.w,
          y: b.y / b.w,
          L: b.L / b.w,
          a: b.a / b.w,
          b: b.b / b.w,
          mass: b.mass
        })
      }
    }
    candidates.sort((u, v) => v.mass - u.mass)
  }

  // Select up to 4 maximally distinct vibrant clusters using diversity-penalized greedy scoring
  const selectedClusters: HueCluster[] = []
  if (candidates.length > 0) {
    selectedClusters.push(candidates[0]!)
    const used = new Set<number>([0])
    while (selectedClusters.length < 4 && used.size < candidates.length) {
      let bestIdx = -1
      let bestScore = -1
      for (let i = 0; i < candidates.length; i++) {
        if (used.has(i)) continue
        const cand = candidates[i]!
        const candTuple: OkLabTuple = [cand.L, cand.a, cand.b]
        let minDist = Infinity
        for (const sel of selectedClusters) {
          const d = okLabDistance(candTuple, [sel.L, sel.a, sel.b])
          if (d < minDist) minDist = d
        }
        // Balance cluster presence (mass^0.52) with perceptual color separation (minDist^1.45)
        const score = Math.pow(cand.mass, 0.52) * (0.04 + Math.pow(minDist, 1.45))
        if (score > bestScore) {
          bestScore = score
          bestIdx = i
        }
      }
      if (bestIdx >= 0) {
        used.add(bestIdx)
        selectedClusters.push(candidates[bestIdx]!)
      } else {
        break
      }
    }
  }

  const isLight = tone === 'light'
  const minL = isLight ? 0.21 : 0.135
  const baseMaxL = isLight ? 0.57 : 0.465
  const chromaMaxAllowance = isLight ? 0.125 : 0.095

  for (let y = 0; y < height; y++) {
    const ny = (y + 0.5) / height
    for (let x = 0; x < width; x++) {
      const nx = (x + 0.5) / width
      const idx = y * width + x
      let L = gridL[idx]!
      let okA = gridA[idx]!
      let okB = gridB[idx]!
      const c = chroma[idx]!
      const alpha = alphaArr[idx]!

      if (isChromatic && selectedClusters.length > 0) {
        // Suppress white borders/billboards AND blown-out tinted white bloom glare (L > 0.81, C < 0.072),
        // muted gray footers (C < 0.032, L > 0.64), transparent cutouts, and dead-black bars —
        // while keeping true saturated colors (yellow C ~ 0.20, cyan C ~ 0.13, pink C ~ 0.16) intact!
        const whiteGlareFactor =
          (1 - smoothstep(0.038, 0.078, c)) * smoothstep(0.79, 0.9, L)
        const grayBoxFactor =
          (1 - smoothstep(0.016, 0.036, c)) * smoothstep(0.66, 0.8, L) * 0.85
        const blackBarFactor =
          (1 - smoothstep(0.012, 0.028, c)) * (1 - smoothstep(0.03, 0.08, L)) * 0.78
        const transparentFactor = 1 - smoothstep(0.2, 0.85, alpha)
        const replaceFactor = clamp(
          Math.max(whiteGlareFactor, grayBoxFactor, blackBarFactor, transparentFactor),
          0,
          1
        )

        if (replaceFactor > 0.01) {
          // Sharp localized 1/dist^5 nearest-cluster pigment fill so white billboards inherit
          // the adjacent vivid hue rather than an average of all cover colors!
          let sumW = 0
          let fillL = 0
          let fillA = 0
          let fillB = 0
          for (const cl of selectedClusters) {
            const dx = nx - cl.x
            const dy = ny - cl.y
            const distSq = dx * dx + dy * dy + 0.035
            const w = 1 / (distSq * distSq * Math.sqrt(distSq))
            sumW += w
            fillL += cl.L * w
            fillA += cl.a * w
            fillB += cl.b * w
          }
          if (sumW > 0) {
            L = L * (1 - replaceFactor) + (fillL / sumW) * replaceFactor
            okA = okA * (1 - replaceFactor) + (fillA / sumW) * replaceFactor
            okB = okB * (1 - replaceFactor) + (fillB / sumW) * replaceFactor
          }
        }

        const [, boostedA, boostedB] = boostJewelChroma(L, okA, okB)
        okA = boostedA
        okB = boostedB
        const boostedC = Math.hypot(okA, okB)

        // Blend 68% adaptive percentile auto-levels with 32% global curve so high-key covers
        // gain rich dark-to-bright sculptural depth without blowing out naturally dark covers.
        const adaptiveT = smoothstep(p12, p88, L)
        const globalT = smoothstep(0.05, 0.92, L)
        const contrastT = adaptiveT * 0.68 + globalT * 0.32
        const pixelMaxL = baseMaxL + chromaMaxAllowance * smoothstep(0.045, 0.155, boostedC)
        L = minL + (pixelMaxL - minL) * contrastT
      } else {
        // Pure monochrome / grayscale cover: smoky slate-silver tonal window, high lyric contrast
        const monoMin = isLight ? 0.22 : 0.13
        const monoMax = isLight ? 0.48 : 0.35
        L = monoMin + (monoMax - monoMin) * smoothstep(0.02, 0.98, L)
        if (c > 0.032) {
          const scale = 0.032 / c
          okA *= scale
          okB *= scale
        }
      }

      gridL[idx] = L
      gridA[idx] = okA
      gridB[idx] = okB
    }
  }

  blurOkLabGrid(gridL, gridA, gridB, width, height)

  // Build the 5 final OkLab palette anchors for the liquid ribbon & fold shader
  const palette: [number, number, number][] = []
  if (isChromatic && selectedClusters.length > 0) {
    const anchorFloorL = isLight ? 0.29 : 0.23
    const anchorMinClamp = isLight ? 0.25 : 0.19
    const staggerScale = isLight ? 1 : 0.85
    // Master each distinct extracted hue cluster into a jewel-toned ribbon pigment
    for (let i = 0; i < 4; i++) {
      const cl = selectedClusters[i % selectedClusters.length]!
      const [, ba, bb] = boostJewelChroma(cl.L, cl.a, cl.b, 0.11)
      const bc = Math.hypot(ba, bb)
      const adaptiveT = smoothstep(p12, p88, cl.L) * 0.65 + smoothstep(0.06, 0.92, cl.L) * 0.35
      // Stagger lightness slightly across the 4 primary ribbons so overlapping folds always have contrast
      const stagger = (i === 0 ? 0.03 : i === 1 ? 0.055 : i === 2 ? -0.04 : 0.01) * staggerScale
      const maxAllow = baseMaxL + chromaMaxAllowance * smoothstep(0.045, 0.155, bc)
      const targetL = clamp(
        anchorFloorL + (maxAllow - anchorFloorL) * adaptiveT + stagger,
        anchorMinClamp,
        maxAllow
      )
      palette.push([targetL, ba, bb])
    }

    // If cover had only 1–2 hues (e.g. duotone cover), synthesize analogous harmonic companions
    // so the 4 ribbons still exhibit dimensional tonal richness instead of identical flat fills.
    if (selectedClusters.length === 1) {
      const [pL, pA, pB] = palette[0]!
      const c = Math.hypot(pA, pB)
      const h = Math.atan2(pB, pA)
      const capHi = isLight ? 0.64 : 0.53
      const capMid = isLight ? 0.6 : 0.49
      palette[1] = [clamp(pL + 0.06, anchorMinClamp, capHi), Math.cos(h + 0.32) * c * 0.94, Math.sin(h + 0.32) * c * 0.94]
      palette[2] = [clamp(pL - 0.07, isLight ? 0.21 : 0.16, capMid), Math.cos(h - 0.28) * c * 0.9, Math.sin(h - 0.28) * c * 0.9]
      palette[3] = [clamp(pL + 0.02, anchorMinClamp, capMid), Math.cos(h + 0.16) * c, Math.sin(h + 0.16) * c]
    }

    // 5th anchor: Deep Velvet Shadow Anchor (pick darkest/coolest cluster hue at deep L)
    let darkest = selectedClusters[0]!
    for (const cl of selectedClusters) {
      // Prefer cool blue/violet/indigo hues or the darkest cluster for natural deep shadows
      const coolBias = cl.b < 0 ? -0.08 : 0
      if (cl.L + coolBias < darkest.L + (darkest.b < 0 ? -0.08 : 0)) {
        darkest = cl
      }
    }
    const shadowAngle = Math.atan2(darkest.b, darkest.a)
    const shadowChroma = clamp(Math.hypot(darkest.a, darkest.b) * 1.15, 0.065, 0.145)
    const shadowL = isLight ? 0.23 : 0.14
    palette.push([
      shadowL,
      Math.cos(shadowAngle) * shadowChroma,
      Math.sin(shadowAngle) * shadowChroma
    ])
  } else {
    // Monochrome smoky silver-charcoal 5-anchor relief palette
    const hi = isLight ? 0.45 : 0.34
    const mid = isLight ? 0.35 : 0.25
    const lo = isLight ? 0.23 : 0.14
    const tintA = gridA[Math.floor(count / 2)]!
    const tintB = gridB[Math.floor(count / 2)]!
    palette.push(
      [hi, tintA, tintB],
      [mid + 0.04, tintA, tintB],
      [mid - 0.03, tintA, tintB],
      [hi - 0.03, tintA, tintB],
      [lo, tintA, tintB]
    )
  }

  const outPixels = new Uint8Array(count * 4)
  for (let i = 0; i < count; i++) {
    const [sr, sg, sb] = okLabToGamutSrgb(gridL[i]!, gridA[i]!, gridB[i]!)
    const p = i * 4
    outPixels[p] = Math.round(sr * 255)
    outPixels[p + 1] = Math.round(sg * 255)
    outPixels[p + 2] = Math.round(sb * 255)
    outPixels[p + 3] = 255
  }

  return {
    width,
    height,
    pixels: outPixels,
    anchorsOkLab: [palette[0]!, palette[1]!, palette[2]!, palette[3]!, palette[4]!],
    isChromatic
  }
}

/**
 * Generates an ambient fallback fluid palette & texture when no track cover is available.
 */
export function createFallbackFluidCover(
  accentHex = '#3567b5',
  tone: 'dark' | 'light' = 'dark'
): MasteredFluidCover {
  const [ar, ag, ab] = parseHexToRgb01(accentHex)
  const [, baseA, baseB] = srgbToOkLab(ar, ag, ab)
  const c = Math.max(0.11, Math.min(0.24, Math.hypot(baseA, baseB) || 0.15))
  const angle = Math.atan2(baseB || -0.1, baseA || -0.03)
  const isLight = tone === 'light'
  const lCenter = isLight ? 0.45 : 0.325
  const maxAnchorCap = isLight ? 0.58 : 0.46

  const a0: OkLabTuple = [
    clamp(lCenter + 0.08, 0.2, maxAnchorCap),
    Math.cos(angle) * c,
    Math.sin(angle) * c
  ]
  const a1: OkLabTuple = [
    clamp(lCenter + 0.03, 0.19, maxAnchorCap - 0.02),
    Math.cos(angle + 0.62) * c * 0.92,
    Math.sin(angle + 0.62) * c * 0.92
  ]
  const a2: OkLabTuple = [
    clamp(lCenter - 0.04, 0.16, maxAnchorCap - 0.06),
    Math.cos(angle - 0.58) * c * 0.88,
    Math.sin(angle - 0.58) * c * 0.88
  ]
  const a3: OkLabTuple = [
    clamp(lCenter + 0.05, 0.19, maxAnchorCap - 0.01),
    Math.cos(angle + 1.15) * c * 0.82,
    Math.sin(angle + 1.15) * c * 0.82
  ]
  const a4: OkLabTuple = [
    isLight ? 0.23 : 0.14,
    Math.cos(angle - 0.2) * c * 0.55,
    Math.sin(angle - 0.2) * c * 0.55
  ]

  const size = FLUID_COVER_SIZE
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    const ty = y / (size - 1)
    for (let x = 0; x < size; x++) {
      const tx = x / (size - 1)
      const topL = a0[0] * (1 - tx) + a1[0] * tx
      const topA = a0[1] * (1 - tx) + a1[1] * tx
      const topB = a0[2] * (1 - tx) + a1[2] * tx

      const botL = a2[0] * (1 - tx) + a3[0] * tx
      const botA = a2[1] * (1 - tx) + a3[1] * tx
      const botB = a2[2] * (1 - tx) + a3[2] * tx

      const L = topL * (1 - ty) + botL * ty
      const okA = topA * (1 - ty) + botA * ty
      const okB = topB * (1 - ty) + botB * ty
      const [sr, sg, sb] = okLabToGamutSrgb(L, okA, okB)
      const p = (y * size + x) * 4
      pixels[p] = Math.round(sr * 255)
      pixels[p + 1] = Math.round(sg * 255)
      pixels[p + 2] = Math.round(sb * 255)
      pixels[p + 3] = 255
    }
  }

  return {
    width: size,
    height: size,
    pixels,
    anchorsOkLab: [a0, a1, a2, a3, a4],
    isChromatic: true
  }
}

function loadCoverImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const img = new Image()
    if (/^https?:/i.test(url)) {
      img.crossOrigin = 'anonymous'
    }
    const cleanup = (): void => {
      img.onload = null
      img.onerror = null
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      img.src = ''
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    img.onload = () => {
      cleanup()
      resolve(img)
    }
    img.onerror = () => {
      cleanup()
      reject(new Error(`Failed to decode cover image: ${url}`))
    }
    img.src = url
  })
}

async function decodeAndMasterCover(
  coverUrl: string,
  tone: 'dark' | 'light',
  fallbackAccentHex: string
): Promise<MasteredFluidCover> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return createFallbackFluidCover(fallbackAccentHex, tone)
  }
  try {
    const img = await loadCoverImage(coverUrl)
    const size = FLUID_COVER_SIZE
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return createFallbackFluidCover(fallbackAccentHex, tone)

    const sw = img.naturalWidth || img.width || size
    const sh = img.naturalHeight || img.height || size
    const crop = Math.min(sw, sh)
    const sx = Math.max(0, (sw - crop) * 0.5)
    const sy = Math.max(0, (sh - crop) * 0.5)
    ctx.clearRect(0, 0, size, size)
    ctx.drawImage(img, sx, sy, crop, crop, 0, 0, size, size)
    const imageData = ctx.getImageData(0, 0, size, size)
    canvas.width = 0
    canvas.height = 0
    img.removeAttribute('src')
    return masterFluidCoverPixels(imageData.data, size, size, { tone, fallbackAccentHex })
  } catch {
    return createFallbackFluidCover(fallbackAccentHex, tone)
  }
}

export async function masterFluidCover(
  coverUrl: string | null | undefined,
  options: FluidMasteringOptions = {}
): Promise<MasteredFluidCover> {
  const tone = options.tone ?? 'dark'
  const fallbackHex = options.fallbackAccentHex ?? '#3567b5'
  const cleanUrl = (coverUrl ?? '').trim()
  if (!cleanUrl) {
    return createFallbackFluidCover(fallbackHex, tone)
  }

  const cacheKey = `v5::${tone}::${compactFluidCoverKey(cleanUrl)}`
  let pending = masteredCoverCache.get(cacheKey)
  if (pending) {
    masteredCoverCache.delete(cacheKey)
    masteredCoverCache.set(cacheKey, pending)
  } else {
    pending = decodeAndMasterCover(cleanUrl, tone, fallbackHex)
    masteredCoverCache.set(cacheKey, pending)
    if (masteredCoverCache.size > MAX_MASTERED_COVER_CACHE) {
      const oldestKey = masteredCoverCache.keys().next().value
      if (oldestKey !== undefined) masteredCoverCache.delete(oldestKey)
    }
  }

  const result = await pending
  if (options.signal?.aborted) {
    return result
  }
  return result
}

export function clearFluidCoverCache(): void {
  masteredCoverCache.clear()
}
