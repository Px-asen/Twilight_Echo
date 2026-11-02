import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FLUID_COVER_SIZE,
  createFallbackFluidCover,
  masterFluidCoverPixels,
  okLabToGamutSrgb,
  srgbChannelToLinear,
  srgbToOkLab
} from './fluidCoverMastering.ts'

function relativeLuminance(r255: number, g255: number, b255: number): number {
  const r = srgbChannelToLinear(r255 / 255)
  const g = srgbChannelToLinear(g255 / 255)
  const b = srgbChannelToLinear(b255 / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

test('OkLab conversion round-trips sRGB accurately and preserves perceptual hue when gamut mapping', () => {
  const samples: [number, number, number][] = [
    [0.14, 0.36, 0.86],
    [0.88, 0.52, 0.16],
    [0.54, 0.2, 0.78],
    [0.95, 0.95, 0.95]
  ]

  for (const [r, g, b] of samples) {
    const [L, okA, okB] = srgbToOkLab(r, g, b)
    const [rtR, rtG, rtB] = okLabToGamutSrgb(L, okA, okB)
    assert.ok(Math.abs(rtR - r) < 0.01)
    assert.ok(Math.abs(rtG - g) < 0.01)
    assert.ok(Math.abs(rtB - b) < 0.01)
  }

  // Push cobalt blue chroma well beyond sRGB cube and verify hue angle does not skew to cyan
  const [baseL, baseA, baseB] = srgbToOkLab(0.12, 0.32, 0.92)
  const targetHue = Math.atan2(baseB, baseA)
  const [mappedR, mappedG, mappedB] = okLabToGamutSrgb(baseL, baseA * 2.1, baseB * 2.1)
  const [, outA, outB] = srgbToOkLab(mappedR, mappedG, mappedB)
  const outHue = Math.atan2(outB, outA)
  const hueDiffDeg = Math.abs(((outHue - targetHue + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * (180 / Math.PI)
  assert.ok(hueDiffDeg < 2.5, `expected hue preservation within 2.5 deg, got ${hueDiffDeg}`)
})

test('masterFluidCoverPixels suppresses white borders and large central white billboards without washing out jewel hues', () => {
  const w = 32
  const h = 32
  const rgba = new Uint8Array(w * h * 4)

  // Anderson .Paak-style layout: fiery amber top, huge pure-white central billboard, deep navy bottom
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const inBillboard = x >= 5 && x < 27 && y >= 9 && y < 21
      const inWhiteBorder = x === 0 || x === w - 1 || y === 0 || y === h - 1
      if (inBillboard || inWhiteBorder) {
        rgba[i] = 255
        rgba[i + 1] = 255
        rgba[i + 2] = 255
      } else if (y < 14) {
        rgba[i] = 232
        rgba[i + 1] = 132
        rgba[i + 2] = 28
      } else {
        rgba[i] = 24
        rgba[i + 1] = 36
        rgba[i + 2] = 74
      }
      rgba[i + 3] = 255
    }
  }

  const mastered = masterFluidCoverPixels(rgba, w, h, { tone: 'dark' })
  assert.equal(mastered.isChromatic, true)

  // Center pixel (previously pure #FFFFFF billboard) must now be chromatic & rich, not washed-out white
  const centerIdx = (15 * w + 16) * 4
  const [cL, cA, cB] = srgbToOkLab(
    mastered.pixels[centerIdx]! / 255,
    mastered.pixels[centerIdx + 1]! / 255,
    mastered.pixels[centerIdx + 2]! / 255
  )
  const centerChroma = Math.hypot(cA, cB)
  assert.ok(centerChroma > 0.05, `expected billboard region to be inpainted with chromatic pigment, got C=${centerChroma}`)
  assert.ok(cL < 0.66, `expected billboard region lightness to stay bounded, got L=${cL}`)

  // Extracted anchors must include both warm amber (+b) and cool navy (-b) clusters plus deep shadow anchor
  assert.equal(mastered.anchorsOkLab.length, 5)
  assert.ok(
    mastered.anchorsOkLab.slice(0, 4).some((a) => a[2] > 0.05),
    'anchors should retain warm amber +b hue cluster'
  )
  assert.ok(
    mastered.anchorsOkLab.slice(0, 4).some((a) => a[2] < -0.03),
    'anchors should retain cool navy -b hue cluster'
  )
  assert.ok(mastered.anchorsOkLab[4][0] <= 0.22, '5th anchor must be a deep velvet shadow tone')
})

test('masterFluidCoverPixels preserves 4 distinct jewel hues on high-key multi-hue anime covers with tinted white bloom glare', () => {
  const size = 48
  const rgba = new Uint8Array(size * size * 4)

  // Recollect Lines-style high-key multi-hue cover: central lavender-white glare + pink, cyan, gold, and violet motifs
  for (let y = 0; y < size; y++) {
    const ny = y / (size - 1)
    for (let x = 0; x < size; x++) {
      const nx = x / (size - 1)
      const p = (y * size + x) * 4
      const centerDist = Math.hypot(nx - 0.48, ny - 0.48)
      if (ny > 0.88) {
        rgba.set([172, 162, 188, 255], p)
      } else if (Math.hypot(nx - 0.27, ny - 0.42) < 0.14) {
        rgba.set([250, 212, 108, 255], p) // golden yellow
      } else if (Math.hypot(nx - 0.48, ny - 0.3) < 0.15 || Math.hypot(nx - 0.28, ny - 0.58) < 0.13) {
        rgba.set([246, 138, 198, 255], p) // sakura pink
      } else if (Math.hypot(nx - 0.72, ny - 0.52) < 0.17) {
        rgba.set([46, 168, 238, 255], p) // cerulean cyan-blue
      } else if (centerDist < 0.34) {
        rgba.set([242, 234, 255, 255], p) // lavender-tinted white bloom glare
      } else {
        rgba.set([108, 64, 186, 255], p) // royal violet
      }
    }
  }

  const mastered = masterFluidCoverPixels(rgba, size, size, { tone: 'dark' })
  assert.equal(mastered.isChromatic, true)
  assert.equal(mastered.anchorsOkLab.length, 5)

  const primaryAnchors = mastered.anchorsOkLab.slice(0, 4)
  // Verify distinct hue quadrants were extracted rather than collapsing to one dusty purple average
  assert.ok(
    primaryAnchors.some((a) => a[1] > 0.08),
    'expected a vibrant pink/magenta (+a) anchor'
  )
  assert.ok(
    primaryAnchors.some((a) => a[1] < -0.02 && a[2] < -0.05),
    'expected a vibrant cyan/cerulean (-a, -b) anchor'
  )
  assert.ok(
    primaryAnchors.some((a) => a[2] > 0.08),
    'expected a vibrant golden-yellow (+b) anchor'
  )
  assert.ok(mastered.anchorsOkLab[4][0] <= 0.22, 'expected deep velvet shadow 5th anchor')

  // Pairwise distance across top 3 extracted anchors must show genuine color separation
  let maxAnchorDist = 0
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const d = Math.hypot(
        primaryAnchors[i]![1] - primaryAnchors[j]![1],
        primaryAnchors[i]![2] - primaryAnchors[j]![2]
      )
      maxAnchorDist = Math.max(maxAnchorDist, d)
    }
  }
  assert.ok(maxAnchorDist > 0.18, `expected wide OkLab chroma separation across extracted hues, got ${maxAnchorDist}`)
})

test('pure white and grayscale covers remain neutral monochrome and guarantee >= 4.5:1 white lyric contrast', () => {
  const w = 16
  const h = 16
  const whiteRgba = new Uint8Array(w * h * 4).fill(255)

  const mastered = masterFluidCoverPixels(whiteRgba, w, h, { tone: 'dark' })
  assert.equal(mastered.isChromatic, false)
  assert.equal(mastered.anchorsOkLab.length, 5)

  let maxLum = 0
  let maxChroma = 0
  for (let i = 0; i < w * h; i++) {
    const p = i * 4
    const r = mastered.pixels[p]!
    const g = mastered.pixels[p + 1]!
    const b = mastered.pixels[p + 2]!
    maxLum = Math.max(maxLum, relativeLuminance(r, g, b))
    const [, okA, okB] = srgbToOkLab(r / 255, g / 255, b / 255)
    maxChroma = Math.max(maxChroma, Math.hypot(okA, okB))
  }

  const whiteContrast = 1.05 / (maxLum + 0.05)
  assert.ok(whiteContrast >= 5.0, `expected >= 5.0 white lyric contrast on #FFFFFF cover, got ${whiteContrast}`)
  assert.ok(maxChroma < 0.02, `expected pure white cover not to invent fake saturation, got C=${maxChroma}`)

  const fallback = createFallbackFluidCover('#4a7dff', 'dark')
  assert.equal(fallback.width, FLUID_COVER_SIZE)
  assert.equal(fallback.height, FLUID_COVER_SIZE)
  assert.equal(fallback.anchorsOkLab.length, 5)
  assert.equal(fallback.isChromatic, true)

  // Verify dark mode adaptation settles lightness comfortably lower than light mode while keeping chroma rich
  const lightFallback = createFallbackFluidCover('#4a7dff', 'light')
  assert.ok(
    fallback.anchorsOkLab[0][0] < lightFallback.anchorsOkLab[0][0] - 0.08,
    `expected dark mode fallback anchor L (${fallback.anchorsOkLab[0][0]}) to be comfortably darker than light mode (${lightFallback.anchorsOkLab[0][0]})`
  )
  assert.ok(
    Math.hypot(fallback.anchorsOkLab[0][1], fallback.anchorsOkLab[0][2]) >= 0.11,
    'dark mode adaptation must preserve rich OkLab chroma without washing to gray'
  )
})
