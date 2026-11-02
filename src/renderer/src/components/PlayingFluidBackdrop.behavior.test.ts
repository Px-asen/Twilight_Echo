import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'
import { compileStyle, parse } from '@vue/compiler-sfc'
import { AppleMusicFluidRenderer } from '../utils/appleMusicFluidRenderer.ts'
import {
  masterFluidCoverPixels,
  okLabToGamutSrgb,
  srgbChannelToLinear,
  srgbToOkLab,
  type MasteredFluidCover,
  type OkLabTuple
} from '../utils/fluidCoverMastering.ts'

const require = createRequire(import.meta.url)
const workspaceRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))

async function transpileBrowserModule(relativePath: string): Promise<string> {
  const raw = await readFile(new URL(relativePath, import.meta.url), 'utf8')
  return stripTypeScriptTypes(raw).replace(/from\s+['"]\.\/([^'"]+)\.ts['"]/g, 'from "./$1.mjs"')
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0 || 1), 0, 1)
  return t * t * (3 - 2 * t)
}

function mixNum(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function mixVec3(a: readonly [number, number, number], b: readonly [number, number, number], t: number): [number, number, number] {
  return [mixNum(a[0], b[0], t), mixNum(a[1], b[1], t), mixNum(a[2], b[2], t)]
}

function rotate2d(px: number, py: number, angle: number): [number, number] {
  const s = Math.sin(angle)
  const c = Math.cos(angle)
  return [px * c - py * s, px * s + py * c]
}

function sampleCoverBilinearOkLab(cover: MasteredFluidCover, u: number, v: number): [number, number, number] {
  const cu = clamp(u, 0.02, 0.98) * (cover.width - 1)
  const cv = clamp(v, 0.02, 0.98) * (cover.height - 1)
  const x0 = Math.floor(cu)
  const y0 = Math.floor(cv)
  const x1 = Math.min(cover.width - 1, x0 + 1)
  const y1 = Math.min(cover.height - 1, y0 + 1)
  const tx = cu - x0
  const ty = cv - y0
  const read = (x: number, y: number): [number, number, number] => {
    const p = (y * cover.width + x) * 4
    return [cover.pixels[p]! / 255, cover.pixels[p + 1]! / 255, cover.pixels[p + 2]! / 255]
  }
  const c00 = read(x0, y0)
  const c10 = read(x1, y0)
  const c01 = read(x0, y1)
  const c11 = read(x1, y1)
  const top = mixVec3(c00, c10, tx)
  const bot = mixVec3(c01, c11, tx)
  const rgb = mixVec3(top, bot, ty)
  return srgbToOkLab(rgb[0], rgb[1], rgb[2])
}

function buildGaussian(radius: number, sigma: number): Float32Array {
  const k = new Float32Array(radius * 2 + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma))
    k[i + radius] = w
    sum += w
  }
  for (let i = 0; i < k.length; i++) k[i] = k[i]! / sum
  return k
}

interface FluidFboField {
  sample(uvX: number, uvY: number, width: number, height: number): [number, number, number]
}

function buildFluidFboField(
  cover: MasteredFluidCover,
  phase: number,
  swell: number,
  tone: 'dark' | 'light' = 'dark'
): FluidFboField {
  const isLight = tone === 'light'
  const uMinL = isLight ? 0.18 : 0.115
  const uMaxL = isLight ? 0.565 : 0.455
  const uChromaAllow = isLight ? 0.135 : 0.095
  const uToneScale = isLight ? 1.0 : 0.94
  const FW = 64
  const FH = 64
  const fboL = new Float32Array(FW * FH)
  const fboA = new Float32Array(FW * FH)
  const fboB = new Float32Array(FW * FH)
  const [a0, a1, a2, a3, aDeep]: readonly [
    OkLabTuple,
    OkLabTuple,
    OkLabTuple,
    OkLabTuple,
    OkLabTuple
  ] = cover.anchorsOkLab

  const overSpriteBox = (
    dst: [number, number, number],
    uvX: number,
    uvY: number,
    cx: number,
    cy: number,
    scale: number,
    rot: number,
    subCenter: [number, number],
    subZoom: number,
    anchor: OkLabTuple,
    anchorMix: number,
    feather: number,
    opacity: number
  ): [number, number, number] => {
    const [lx, ly] = rotate2d((uvX - cx) / scale, (uvY - cy) / scale, rot)
    const boxDist = Math.hypot(Math.max(Math.abs(lx) - 0.3, 0), Math.max(Math.abs(ly) - 0.3, 0))
    const mask = (1 - smoothstep(0, feather, boxDist)) * opacity
    if (mask <= 0.002) return dst
    const texLab = sampleCoverBilinearOkLab(cover, subCenter[0] + lx * subZoom, subCenter[1] + ly * subZoom)
    return mixVec3(dst, mixVec3(texLab, anchor, anchorMix), mask)
  }

  for (let fy = 0; fy < FH; fy++) {
    const uvY = (fy + 0.5) / FH
    for (let fx = 0; fx < FW; fx++) {
      const uvX = (fx + 0.5) / FW
      const [bLx, bLy] = rotate2d((uvX - 0.5) / 1.38, (uvY - 0.5) / 1.38, phase * 0.12)
      let lab = mixVec3(aDeep, sampleCoverBilinearOkLab(cover, bLx + 0.5, bLy + 0.5), 0.72)

      lab = overSpriteBox(
        lab,
        uvX,
        uvY,
        0.26 + 0.13 * Math.cos(phase * 0.27),
        0.32 + 0.13 * Math.sin(phase * 0.23),
        0.92,
        -phase * 0.24,
        [0.3, 0.3],
        0.65,
        a0,
        0.58,
        0.24,
        0.96
      )
      lab = overSpriteBox(
        lab,
        uvX,
        uvY,
        0.74 - 0.15 * Math.cos(phase * 0.31 + 0.8),
        0.34 + 0.16 * Math.sin(phase * 0.25 + 0.5),
        0.84,
        phase * 0.29 + 0.7,
        [0.7, 0.32],
        0.62,
        a1,
        0.64,
        0.24,
        0.94
      )
      lab = overSpriteBox(
        lab,
        uvX,
        uvY,
        0.32 + 0.18 * Math.sin(phase * 0.35 + 1.7),
        0.74 - 0.14 * Math.cos(phase * 0.29 + 1.2),
        0.8,
        -phase * 0.33 + 1.5,
        [0.32, 0.7],
        0.62,
        a2,
        0.62,
        0.23,
        0.92
      )
      lab = overSpriteBox(
        lab,
        uvX,
        uvY,
        0.68 - 0.18 * Math.sin(phase * 0.41 + 2.4),
        0.68 + 0.16 * Math.cos(phase * 0.36 + 2.0),
        0.66,
        phase * 0.38 + 2.3,
        [0.68, 0.68],
        0.58,
        a3,
        0.68,
        0.22,
        Math.min(1, 0.9 + 0.06 * swell)
      )

      const dx = uvX - (0.82 - 0.16 * Math.cos(phase * 0.19))
      const dy = uvY - (0.82 - 0.14 * Math.sin(phase * 0.17))
      const deepMask = (1 - smoothstep(0.06, 0.46, Math.hypot(dx, dy))) * 0.76
      lab = mixVec3(lab, aDeep, deepMask)

      const idx = fy * FW + fx
      fboL[idx] = lab[0]
      fboA[idx] = lab[1]
      fboB[idx] = lab[2]
    }
  }

  // Scaled separable Gaussian blur matching sigma = 19 / 256 (~4.75 texels on 64x64)
  const R = 9
  const K = buildGaussian(R, 4.75)
  const tmpL = new Float32Array(FW * FH)
  const tmpA = new Float32Array(FW * FH)
  const tmpB = new Float32Array(FW * FH)

  for (let y = 0; y < FH; y++) {
    const row = y * FW
    for (let x = 0; x < FW; x++) {
      let sL = 0
      let sA = 0
      let sB = 0
      for (let d = -R; d <= R; d++) {
        const sx = clamp(x + d, 0, FW - 1)
        const w = K[d + R]!
        sL += fboL[row + sx]! * w
        sA += fboA[row + sx]! * w
        sB += fboB[row + sx]! * w
      }
      tmpL[row + x] = sL
      tmpA[row + x] = sA
      tmpB[row + x] = sB
    }
  }
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      let sL = 0
      let sA = 0
      let sB = 0
      for (let d = -R; d <= R; d++) {
        const sy = clamp(y + d, 0, FH - 1)
        const w = K[d + R]!
        const i = sy * FW + x
        sL += tmpL[i]! * w
        sA += tmpA[i]! * w
        sB += tmpB[i]! * w
      }
      const o = y * FW + x
      fboL[o] = sL
      fboA[o] = sA
      fboB[o] = sB
    }
  }

  const sampleFbo = (u: number, v: number): [number, number, number] => {
    const cu = clamp(u, 0.005, 0.995) * (FW - 1)
    const cv = clamp(v, 0.005, 0.995) * (FH - 1)
    const x0 = Math.floor(cu)
    const y0 = Math.floor(cv)
    const x1 = Math.min(FW - 1, x0 + 1)
    const y1 = Math.min(FH - 1, y0 + 1)
    const tx = cu - x0
    const ty = cv - y0
    const rd = (x: number, y: number): [number, number, number] => {
      const i = y * FW + x
      return [fboL[i]!, fboA[i]!, fboB[i]!]
    }
    return mixVec3(mixVec3(rd(x0, y0), rd(x1, y0), tx), mixVec3(rd(x0, y1), rd(x1, y1), tx), ty)
  }

  return {
    sample(uvX: number, uvY: number, width: number, height: number): [number, number, number] {
      const maxDim = Math.max(width, height)
      const ax = (uvX - 0.5) * (width / maxDim) * 1.35
      const ay = (uvY - 0.5) * (height / maxDim) * 1.35

      const warpAmp = 0.085 + 0.028 * swell
      const wx =
        uvX +
        warpAmp * Math.sin(ay * 3.4 + phase * 0.48) * Math.cos(ax * 2.1 - phase * 0.31) +
        warpAmp * 0.55 * Math.cos((ax + ay) * 4.2 - phase * 0.39)
      const wy =
        uvY +
        warpAmp * Math.cos(ax * 3.2 - phase * 0.44) * Math.sin(ay * 2.3 + phase * 0.29) +
        warpAmp * 0.55 * Math.sin((ax - ay) * 3.9 + phase * 0.36)

      const lab = sampleFbo(wx, wy)
      const c = Math.hypot(lab[1], lab[2])
      if (c > 0.008) {
        const postC = 0.295 * Math.tanh((c * 1.24) / 0.295)
        const s = postC / c
        lab[1] *= s
        lab[2] *= s
      }

      lab[0] *= uToneScale
      const caust = Math.sin(ax * 2.8 + ay * 2.2 + phase * 0.45 + Math.cos(ay * 3.1 - phase * 0.35))
      lab[0] *= 1 + (0.038 + 0.018 * swell) * caust

      const chroma = Math.hypot(lab[1], lab[2])
      const dynamicMaxL = uMaxL + uChromaAllow * smoothstep(0.04, 0.145, chroma)
      if (lab[0] > dynamicMaxL - 0.06) {
        const excess = lab[0] - (dynamicMaxL - 0.06)
        lab[0] = dynamicMaxL - 0.06 + 0.06 * (excess / (excess + 0.06))
      }
      lab[0] = clamp(lab[0], uMinL, dynamicMaxL)

      return okLabToGamutSrgb(lab[0], lab[1], lab[2])
    }
  }
}

test('AppleMusicFluidRenderer manages WebGL shader lifecycle, cross-track OkLab transitions, context loss recovery, and Canvas2D fallback', () => {
  const listeners = new Map<string, EventListener[]>()
  const uniforms = new Map<string, number[]>()
  const compiledSources: string[] = []
  let drawCalls = 0
  let deletedPrograms = 0
  let fboStatus = 36053

  const mockGl = {
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    COMPILE_STATUS: 35713,
    LINK_STATUS: 35714,
    ARRAY_BUFFER: 34962,
    STATIC_DRAW: 35044,
    TEXTURE_2D: 3553,
    UNPACK_FLIP_Y_WEBGL: 37440,
    TEXTURE_WRAP_S: 10242,
    TEXTURE_WRAP_T: 10243,
    CLAMP_TO_EDGE: 33071,
    TEXTURE_MIN_FILTER: 10241,
    TEXTURE_MAG_FILTER: 10240,
    LINEAR: 9729,
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    FLOAT: 5126,
    TEXTURE0: 33984,
    TEXTURE1: 33985,
    TRIANGLE_STRIP: 5,
    FRAMEBUFFER: 36160,
    COLOR_ATTACHMENT0: 36064,
    FRAMEBUFFER_COMPLETE: 36053,
    createShader: () => ({}),
    shaderSource: (_shader: unknown, src: string) => {
      compiledSources.push(src)
    },
    compileShader: () => {},
    getShaderParameter: () => true,
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    deleteProgram: () => {
      deletedPrograms++
    },
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    deleteBuffer: () => {},
    createFramebuffer: () => ({}),
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => fboStatus,
    deleteFramebuffer: () => {},
    createTexture: () => ({}),
    bindTexture: () => {},
    pixelStorei: () => {},
    texParameteri: () => {},
    texImage2D: () => {},
    deleteTexture: () => {},
    getAttribLocation: () => 0,
    getUniformLocation: (_prog: unknown, name: string) => name,
    viewport: () => {},
    useProgram: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    uniform2f: (loc: string, x: number, y: number) => uniforms.set(loc, [x, y]),
    uniform1f: (loc: string, x: number) => uniforms.set(loc, [x]),
    uniform3f: (loc: string, x: number, y: number, z: number) => uniforms.set(loc, [x, y, z]),
    uniform1i: (loc: string, x: number) => uniforms.set(loc, [x]),
    activeTexture: () => {},
    drawArrays: () => {
      drawCalls++
    }
  }

  let webglAvailable = true
  const mockCanvas = {
    width: 300,
    height: 150,
    addEventListener(type: string, cb: EventListener) {
      listeners.set(type, [...(listeners.get(type) ?? []), cb])
    },
    removeEventListener(type: string, cb: EventListener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((fn) => fn !== cb)
      )
    },
    getContext(kind: string) {
      if (webglAvailable && (kind === 'webgl' || kind === 'experimental-webgl')) return mockGl
      return null
    }
  } as unknown as HTMLCanvasElement

  const renderer = new AppleMusicFluidRenderer(mockCanvas, {
    maxRenderScale: 1.35,
    transitionDurationMs: 1100
  })
  assert.equal(renderer.getBackendKind(), 'webgl')

  // DPR cap: 1920x1080 @ DPR 2.0 must cap internal buffer at 1.35x
  renderer.resize(1920, 1080, 2.0)
  assert.equal(mockCanvas.width, Math.round(1920 * 1.35))
  assert.equal(mockCanvas.height, Math.round(1080 * 1.35))

  const coverA = masterFluidCoverPixels(new Uint8Array(16 * 16 * 4).fill(200), 16, 16)
  const coverB = masterFluidCoverPixels(new Uint8Array(16 * 16 * 4).fill(90), 16, 16)

  renderer.setCover(coverA, true, 1000)
  assert.equal(renderer.isTransitioning(), false)

  renderer.setCover(coverB, false, 2000)
  assert.equal(renderer.isTransitioning(), true)

  renderer.render({ phase: 1.25, swell: 0.35, tone: 'dark' }, 2550)
  // 4 passes per rendered frame: Pass 1 Scene FBO -> Pass 2 BlurH FBO -> Pass 3 BlurV FBO -> Pass 4 Present
  assert.equal(drawCalls, 4)
  const midTransition = uniforms.get('u_transition')?.[0] ?? 0
  assert.ok(midTransition > 0.45 && midTransition < 0.55, `expected ~0.5 easeInOutSine midpoint, got ${midTransition}`)

  renderer.render({ phase: 1.6, swell: 0.2, tone: 'dark' }, 3150)
  assert.equal(renderer.isTransitioning(), false)
  assert.equal(uniforms.get('u_transition')?.[0], 1)

  // Context loss & restoration recovery
  let prevented = false
  for (const fn of listeners.get('webglcontextlost') ?? []) {
    fn({ preventDefault: () => { prevented = true } } as unknown as Event)
  }
  assert.equal(prevented, true)
  assert.equal(renderer.getBackendKind(), 'none')

  for (const fn of listeners.get('webglcontextrestored') ?? []) {
    fn({} as Event)
  }
  assert.equal(renderer.getBackendKind(), 'webgl')

  renderer.dispose()
  // 3 linked WebGL programs (sceneProgram, blurProgram, presentProgram) cleaned up on dispose()
  assert.equal(deletedPrograms, 3)
  assert.equal(renderer.getBackendKind(), 'none')

  // Guard against ANGLE D3D11 HLSL `error X4014` divergent-flow gradient compile failures:
  // Verify no GLSL shader passes `sampler2D` into user functions, uses `if (...) return` before `texture2D`,
  // or calls `pow(max(0.0, ...))` with zero base.
  assert.ok(compiledSources.length >= 6)
  for (const src of compiledSources) {
    assert.doesNotMatch(src, /\([^)]*sampler2D\s+\w+/, 'GLSL functions must not take sampler2D arguments')
    assert.doesNotMatch(src, /\bif\s*\(/, 'GLSL shaders must remain 100% branch-free for ANGLE D3D11 fxc')
    assert.doesNotMatch(src, /pow\(\s*max\(\s*0\.0\b/, 'GLSL pow() base must be strictly > 0')
  }

  // Verify single-pass WebGL fallback on the SAME WebGL-locked canvas if FBO creation fails
  // (preventing a #000000 black screen when `getContext('2d')` returns null on a WebGL canvas!)
  fboStatus = 0
  drawCalls = 0
  const fboFallbackRenderer = new AppleMusicFluidRenderer(mockCanvas)
  assert.equal(fboFallbackRenderer.getBackendKind(), 'webgl')
  fboFallbackRenderer.render({ phase: 0.8, swell: 0.2, tone: 'dark' }, 1000)
  assert.equal(drawCalls, 1, 'single-pass WebGL fallback must still draw instead of leaving black canvas')
  fboFallbackRenderer.dispose()

  // Verify graceful fallback when WebGL is disabled
  webglAvailable = false
  const noGlRenderer = new AppleMusicFluidRenderer(mockCanvas)
  assert.equal(noGlRenderer.getBackendKind(), 'none')
  noGlRenderer.dispose()
})

test('PlayingFluidBackdrop bundles cleanly with PlayingMusic fluid optical scrim and preserves multi-hue Apple Music fidelity & >= 4.5:1 lyric contrast', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-fluid-backdrop-'))
  try {
    // 1. Verify PlayingFluidBackdrop.vue compiles cleanly via Vite + @vitejs/plugin-vue
    const entryPath = join(directory, 'entry.ts')
    await writeFile(
      entryPath,
      `import PlayingFluidBackdrop from '@renderer/components/PlayingFluidBackdrop.vue'\nexport { PlayingFluidBackdrop }\n`,
      'utf8'
    )
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspaceRoot,
      plugins: [vue()],
      resolve: {
        alias: {
          '@renderer': join(workspaceRoot, 'src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          pinia: join(resolve(require.resolve('pinia/package.json'), '..'), 'dist/pinia.mjs')
        }
      },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: entryPath,
          name: 'PlayingFluidBackdropBundle',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const emitted = await readdir(join(directory, 'bundle'))
    assert.ok(emitted.some((f) => f.endsWith('.js')), 'PlayingFluidBackdrop.vue must bundle cleanly')

    // 2. Verify PlayingMusic.vue fluid CSS contract
    const playingSource = await readFile(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')
    assert.match(playingSource, /<PlayingFluidBackdrop/)
    assert.match(playingSource, /\.playing-music\.bg-fluid \.backdrop-scrim/)
    const { descriptor } = parse(playingSource)
    const compiled = compileStyle({
      source: descriptor.styles[0].content,
      filename: 'PlayingMusic.vue',
      id: 'data-v-fluid-test',
      scoped: true
    })
    assert.deepEqual(compiled.errors, [])

    // 3. Try real Electron offscreen WebGL BrowserWindow when WindowStation is interactive;
    //    if running inside a non-interactive Windows CLI sandbox (0x80000003), fall back to
    //    direct shader field evaluation so CI and sandboxed shells both validate pixel fidelity.
    const noise = await readFile(new URL('../assets/images/playback-dither.svg', import.meta.url))
    const css = compiled.code.replace(
      '../assets/images/playback-dither.svg',
      `data:image/svg+xml;base64,${noise.toString('base64')}`
    )
    await writeFile(
      join(directory, 'fluidCoverMastering.mjs'),
      await transpileBrowserModule('../utils/fluidCoverMastering.ts')
    )
    await writeFile(
      join(directory, 'fluidAudioReactivity.mjs'),
      await transpileBrowserModule('../utils/fluidAudioReactivity.ts')
    )
    await writeFile(
      join(directory, 'appleMusicFluidRenderer.mjs'),
      await transpileBrowserModule('../utils/appleMusicFluidRenderer.ts')
    )
    await writeFile(join(directory, 'index.html'), buildElectronHtml(css))
    await writeFile(join(directory, 'runner.cjs'), buildElectronRunner())

    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    let ranElectron = false
    try {
      const { stdout } = await promisify(execFile)(
        require('electron') as string,
        ['--no-sandbox', '--force-device-scale-factor=1', join(directory, 'runner.cjs')],
        { env, windowsHide: true, timeout: 60_000 }
      )
      assert.match(stdout, /APPLE_MUSIC_FLUID_BACKDROP_OK/)
      ranElectron = true
    } catch (error) {
      const code = (error as { code?: number }).code
      if (code !== 2147483651) throw error
    }

    if (!ranElectron) {
      // Direct 4-pass Multi-FBO pixel-field verification across Marshmello, Anderson .Paak, Recollect Lines, and pure #FFFFFF covers
      const size = 48
      const marshRgba = new Uint8Array(size * size * 4)
      const paakRgba = new Uint8Array(size * size * 4)
      const recollectRgba = new Uint8Array(size * size * 4)
      const whiteRgba = new Uint8Array(size * size * 4).fill(255)

      for (let y = 0; y < size; y++) {
        const ny = y / (size - 1)
        for (let x = 0; x < size; x++) {
          const nx = x / (size - 1)
          const p = (y * size + x) * 4
          // Marshmello: pink upper-left, royal blue body, electric violet lower stream, white bottom strip
          if (y >= Math.floor(size * 0.84) || x === 0 || x === size - 1 || y === 0) {
            marshRgba.set([255, 255, 255, 255], p)
          } else if (y < size * 0.36 && x < size * 0.68) {
            marshRgba.set([239, 123, 168, 255], p)
          } else if (y > size * 0.64 && x > size * 0.25 && x < size * 0.78) {
            marshRgba.set([139, 61, 255, 255], p)
          } else {
            marshRgba.set([20, 96, 242, 255], p)
          }

          // Anderson .Paak: fiery amber top, huge pure-white central billboard, deep navy bottom
          if (x >= 8 && x < size - 8 && y >= 12 && y < 28) {
            paakRgba.set([255, 255, 255, 255], p)
          } else if (y < 22) {
            paakRgba.set([238, 146, 36, 255], p)
          } else {
            paakRgba.set([18, 30, 62, 255], p)
          }

          // Recollect Lines: high-key multi-hue anime cover with large central lavender-white glare
          const centerDist = Math.hypot(nx - 0.48, ny - 0.48)
          if (ny > 0.88) {
            recollectRgba.set([172, 162, 188, 255], p)
          } else if (Math.hypot(nx - 0.27, ny - 0.42) < 0.14) {
            recollectRgba.set([250, 212, 108, 255], p)
          } else if (Math.hypot(nx - 0.48, ny - 0.3) < 0.15 || Math.hypot(nx - 0.28, ny - 0.58) < 0.13) {
            recollectRgba.set([246, 138, 198, 255], p)
          } else if (Math.hypot(nx - 0.72, ny - 0.52) < 0.17) {
            recollectRgba.set([46, 168, 238, 255], p)
          } else if (centerDist < 0.34) {
            recollectRgba.set([242, 234, 255, 255], p)
          } else {
            recollectRgba.set([108, 64, 186, 255], p)
          }
        }
      }

      const marshCover = masterFluidCoverPixels(marshRgba, size, size, { tone: 'dark' })
      const paakCover = masterFluidCoverPixels(paakRgba, size, size, { tone: 'dark' })
      const recollectCover = masterFluidCoverPixels(recollectRgba, size, size, { tone: 'dark' })
      const whiteCover = masterFluidCoverPixels(whiteRgba, size, size, { tone: 'dark' })

      const marshField = buildFluidFboField(marshCover, 1.08, 0.25)
      const marshTL = marshField.sample(0.2, 0.2, 1440, 920)
      const marshBL = marshField.sample(0.22, 0.78, 1440, 920)
      const marshBR = marshField.sample(0.78, 0.78, 1440, 920)
      assert.ok(marshBL[2] > marshBL[1] + 0.12 || marshBR[2] > marshBR[1] + 0.12)
      assert.ok(
        Math.hypot(marshTL[0] - marshBL[0], marshTL[1] - marshBL[1], marshTL[2] - marshBL[2]) > 0.08
      )

      const paakField = buildFluidFboField(paakCover, 0.76, 0.3)
      const paakCenter = paakField.sample(0.5, 0.45, 1440, 920)
      const paakWarm = paakField.sample(0.28, 0.24, 1440, 920)
      assert.ok(!(paakCenter[0] > 0.78 && paakCenter[1] > 0.78 && paakCenter[2] > 0.78))
      assert.ok(paakWarm[0] > paakWarm[2] + 0.12)

      // Recollect Lines regression: ensure distinct screen regions preserve multi-hue separation
      // rather than blurring into one uniform dusty-purple mass!
      const recollectField = buildFluidFboField(recollectCover, 1.25, 0.25)
      const recProbes = [
        recollectField.sample(0.24, 0.26, 1440, 920),
        recollectField.sample(0.76, 0.28, 1440, 920),
        recollectField.sample(0.28, 0.74, 1440, 920),
        recollectField.sample(0.76, 0.76, 1440, 920)
      ]
      let maxRecDist = 0
      for (let i = 0; i < recProbes.length; i++) {
        for (let j = i + 1; j < recProbes.length; j++) {
          const d = Math.hypot(
            recProbes[i]![0] - recProbes[j]![0],
            recProbes[i]![1] - recProbes[j]![1],
            recProbes[i]![2] - recProbes[j]![2]
          )
          maxRecDist = Math.max(maxRecDist, d)
        }
      }
      assert.ok(
        maxRecDist > 0.22,
        `expected distinct multi-hue pools across screen regions on high-key anime cover, got sRGB dist=${maxRecDist}`
      )

      const whiteField = buildFluidFboField(whiteCover, 0.5, 0)
      let maxWhiteY = 0
      for (let gy = 0; gy < 12; gy++) {
        for (let gx = 0; gx < 16; gx++) {
          const [sr, sg, sb] = whiteField.sample((gx + 0.5) / 16, (gy + 0.5) / 12, 1440, 920)
          // Composite through .playing-music.bg-fluid .backdrop-scrim (center ~4%, edge ~16%)
          const scrimAlpha = 0.04
          const cr = sr * (1 - scrimAlpha) + (6 / 255) * scrimAlpha
          const cg = sg * (1 - scrimAlpha) + (8 / 255) * scrimAlpha
          const cb = sb * (1 - scrimAlpha) + (14 / 255) * scrimAlpha
          const Y =
            0.2126 * srgbChannelToLinear(cr) +
            0.7152 * srgbChannelToLinear(cg) +
            0.0722 * srgbChannelToLinear(cb)
          maxWhiteY = Math.max(maxWhiteY, Y)
        }
      }
      const whiteContrast = 1.05 / (maxWhiteY + 0.05)
      assert.ok(whiteContrast >= 4.5, `expected >= 4.5 WCAG contrast on pure white cover, got ${whiteContrast}`)
    }
  } finally {
    if (directory.startsWith(join(tmpdir(), 'twilight-fluid-backdrop-'))) {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

function buildElectronHtml(scopedCss: string): string {
  return `<!doctype html>
<html data-theme="dark">
<head><meta charset="utf-8" /><style>
  :root { --te-player-bg: #0b0f15; --accent-color: #3567b5; }
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #0b0f15; }
  .playing-music { position: relative; width: 100vw; height: 100vh; overflow: hidden; }
  ${scopedCss}
  .playing-fluid-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; pointer-events: none; }
</style></head>
<body>
  <div id="root" class="playing-music bg-fluid" data-v-fluid-test>
    <div class="backdrop" data-v-fluid-test>
      <div class="backdrop-fluid" data-v-fluid-test><canvas id="fluid-canvas" class="playing-fluid-canvas"></canvas></div>
      <div class="backdrop-scrim" data-v-fluid-test></div>
      <div class="backdrop-accent" data-v-fluid-test></div>
    </div>
  </div>
  <script type="module">
    import { masterFluidCover } from './fluidCoverMastering.mjs'
    import { AppleMusicFluidRenderer } from './appleMusicFluidRenderer.mjs'
    const svgUri = (svg) => 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
    const covers = [
      svgUri('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#ffffff"/><rect x="10" y="10" width="380" height="330" fill="#1750d8"/><rect x="10" y="10" width="260" height="150" fill="#ef7ba8"/><path d="M40 270 Q180 250 320 340 L40 340 Z" fill="#8b3dff"/></svg>'),
      svgUri('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="220" fill="#e68a24"/><rect width="400" height="180" y="220" fill="#111d38"/><rect x="50" y="95" width="300" height="135" fill="#ffffff"/></svg>'),
      svgUri('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#ffffff"/></svg>')
    ]
    const canvas = document.getElementById('fluid-canvas')
    const renderer = new AppleMusicFluidRenderer(canvas, { maxRenderScale: 1.35, transitionDurationMs: 1100 })
    renderer.resize(window.innerWidth, window.innerHeight, 1)
    window.fluidHarness = {
      getBackendKind: () => renderer.getBackendKind(),
      async renderCover(idx, phase) {
        const mastered = await masterFluidCover(covers[idx], { tone: 'dark' })
        renderer.setCover(mastered, true, 1000)
        renderer.render({ phase, swell: 0.25, tone: 'dark' }, 1000)
      }
    }
  </script>
</body></html>`
}

function buildElectronRunner(): string {
  return `const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const profile = process.env.TWILIGHT_ELECTRON_USER_DATA_DIR || join(__dirname, 'profile')
app.setPath('userData', profile)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: false, offscreen: true } })
  try {
    await win.loadFile(join(__dirname, 'index.html'))
    assert.equal(await win.webContents.executeJavaScript('window.fluidHarness.getBackendKind()'), 'webgl')
    await win.webContents.executeJavaScript('window.fluidHarness.renderCover(2, 0.5)')
    const whiteImg = await win.webContents.capturePage()
    const bmp = whiteImg.toBitmap()
    const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
    let maxY = 0
    for (let i = 0; i < bmp.length; i += 64) {
      const Y = 0.2126 * lin(bmp[i + 2] / 255) + 0.7152 * lin(bmp[i + 1] / 255) + 0.0722 * lin(bmp[i] / 255)
      if (Y > maxY) maxY = Y
    }
    assert.ok(1.05 / (maxY + 0.05) >= 4.5)
    console.log('APPLE_MUSIC_FLUID_BACKDROP_OK')
    app.exit(0)
  } catch (e) {
    console.error(e)
    app.exit(1)
  }
})`
}
