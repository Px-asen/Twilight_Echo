import {
  createFallbackFluidCover,
  okLabToGamutSrgb,
  type MasteredFluidCover,
  type OkLabTuple
} from './fluidCoverMastering.ts'

export interface FluidFrameParams {
  /** Monotonically integrated phase in radians. */
  phase: number
  /** Audio low-frequency swell envelope in [0, 1]. */
  swell: number
  /** Active UI tone ('dark' | 'light'). */
  tone: 'dark' | 'light'
}

export interface FluidRendererOptions {
  /** Caps internal backing-store DPR for fillrate efficiency; defaults to 1.35. */
  maxRenderScale?: number
  /** Cross-dissolve duration in milliseconds when switching tracks; defaults to 1100. */
  transitionDurationMs?: number
}

const FBO_SIZE = 256

const FBO_VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_uv = a_pos * 0.5 + 0.5;
}
`

const PRESENT_VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
}
`

/**
 * Generates straight-line, 100% branch-free GLSL for a track's opaque-core sprite scene.
 *
 * CRITICAL ANGLE / D3D11 HLSL NOTE:
 * Never place `texture2D(...)` after a varying `if (...) return` or pass `sampler2D` through
 * nested divergent helpers — D3D11 `fxc.exe` compiles `texture2D` to `Sample()` (implicit
 * 2x2 pixel-quad derivatives) and rejects `gl.linkProgram` with `error X4014` if any
 * `texture2D` call sits inside divergent control flow.
 */
function buildTrackSceneFunctions(tag: 'Curr' | 'Prev', sampler: string, anchorPrefix: string): string {
  return `
vec3 overSprite${tag}(
  vec3 dstLab,
  vec2 uv,
  vec2 center,
  float scale,
  float rot,
  vec2 subCenter,
  float subZoom,
  vec3 anchorLab,
  float anchorMix,
  float feather,
  float opacity
) {
  vec2 local = rotate2d((uv - center) / scale, rot);
  vec2 dBox = max(abs(local) - vec2(0.30), vec2(0.0));
  float mask = (1.0 - smoothstep(0.0, feather, length(dBox))) * opacity;
  vec2 sampleUv = clamp(subCenter + local * subZoom, 0.02, 0.98);
  vec3 texLab = srgbVecToOkLab(texture2D(${sampler}, sampleUv).rgb);
  vec3 spriteLab = mix(texLab, anchorLab, anchorMix);
  return mix(dstLab, spriteLab, mask);
}

vec3 evalScene${tag}(vec2 uv, float phase, float swell) {
  vec2 baseLocal = rotate2d((uv - 0.5) / 1.38, phase * 0.12);
  vec3 baseTexLab = srgbVecToOkLab(texture2D(${sampler}, clamp(baseLocal + 0.5, 0.02, 0.98)).rgb);
  vec3 lab = mix(${anchorPrefix}4, baseTexLab, 0.72);

  lab = overSprite${tag}(
    lab, uv,
    vec2(0.26 + 0.13 * cos(phase * 0.27), 0.32 + 0.13 * sin(phase * 0.23)),
    0.92, -phase * 0.24,
    vec2(0.30, 0.30), 0.65, ${anchorPrefix}0, 0.58, 0.24, 0.96
  );

  lab = overSprite${tag}(
    lab, uv,
    vec2(0.74 - 0.15 * cos(phase * 0.31 + 0.8), 0.34 + 0.16 * sin(phase * 0.25 + 0.5)),
    0.84, phase * 0.29 + 0.7,
    vec2(0.70, 0.32), 0.62, ${anchorPrefix}1, 0.64, 0.24, 0.94
  );

  lab = overSprite${tag}(
    lab, uv,
    vec2(0.32 + 0.18 * sin(phase * 0.35 + 1.7), 0.74 - 0.14 * cos(phase * 0.29 + 1.2)),
    0.80, -phase * 0.33 + 1.5,
    vec2(0.32, 0.70), 0.62, ${anchorPrefix}2, 0.62, 0.23, 0.92
  );

  lab = overSprite${tag}(
    lab, uv,
    vec2(0.68 - 0.18 * sin(phase * 0.41 + 2.4), 0.68 + 0.16 * cos(phase * 0.36 + 2.0)),
    0.66, phase * 0.38 + 2.3,
    vec2(0.68, 0.68), 0.58, ${anchorPrefix}3, 0.68, 0.22, min(1.0, 0.90 + 0.06 * swell)
  );

  vec2 deepPos = vec2(0.82 - 0.16 * cos(phase * 0.19), 0.82 - 0.14 * sin(phase * 0.17));
  float deepMask = (1.0 - smoothstep(0.06, 0.46, length(uv - deepPos))) * 0.76;
  lab = mix(lab, ${anchorPrefix}4, deepMask);

  return lab;
}
`
}

/**
 * Pass 1 (256x256 FBO): Branch-free Apple Music Opaque-Core Orbiting Cover Sprites & Palette Pools.
 * Composites rotated cover sub-regions using Porter-Duff source-over (mix) rather than averaging,
 * and outputs packed perceptual OkLab (L, a + 0.5, b + 0.5, 1.0).
 */
const SCENE_FRAGMENT_SHADER = `
precision highp float;

varying vec2 v_uv;

uniform float u_phase;
uniform float u_swell;
uniform float u_transition;

uniform sampler2D u_prevTex;
uniform sampler2D u_currTex;

uniform vec3 u_prevA0;
uniform vec3 u_prevA1;
uniform vec3 u_prevA2;
uniform vec3 u_prevA3;
uniform vec3 u_prevA4;

uniform vec3 u_currA0;
uniform vec3 u_currA1;
uniform vec3 u_currA2;
uniform vec3 u_currA3;
uniform vec3 u_currA4;

vec2 rotate2d(vec2 p, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

float srgbToLinear(float c) {
  float v = clamp(c, 0.0, 1.0);
  float hi = pow(max((v + 0.055) / 1.055, 0.0001), 2.4);
  return mix(v / 12.92, hi, step(0.04045, v));
}

vec3 srgbVecToOkLab(vec3 srgb) {
  vec3 lin = vec3(srgbToLinear(srgb.r), srgbToLinear(srgb.g), srgbToLinear(srgb.b));
  float l = pow(max(0.00001, 0.4122214708 * lin.r + 0.5363325363 * lin.g + 0.0514459929 * lin.b), 0.33333333);
  float m = pow(max(0.00001, 0.2119034982 * lin.r + 0.6806995451 * lin.g + 0.1073969566 * lin.b), 0.33333333);
  float s = pow(max(0.00001, 0.0883024619 * lin.r + 0.2817188376 * lin.g + 0.6299787005 * lin.b), 0.33333333);
  return vec3(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  );
}

${buildTrackSceneFunctions('Curr', 'u_currTex', 'u_currA')}
${buildTrackSceneFunctions('Prev', 'u_prevTex', 'u_prevA')}

void main() {
  vec3 currLab = evalSceneCurr(v_uv, u_phase, u_swell);
  vec3 prevLab = evalScenePrev(v_uv, u_phase - 0.35, u_swell);
  vec3 lab = mix(prevLab, currLab, clamp(u_transition, 0.0, 1.0));

  gl_FragColor = vec4(
    clamp(lab.x, 0.0, 1.0),
    clamp(lab.y + 0.5, 0.0, 1.0),
    clamp(lab.z + 0.5, 0.0, 1.0),
    1.0
  );
}
`

/**
 * Pass 2 & 3 (256x256 FBO): Wide 73-Tap Equivalent Separable Gaussian Blur in Packed OkLab.
 * Uses hardware bilinear tap-pairing (sigma = 19.0 texels on 256x256 -> ~7.4% viewport optical sigma)
 * to melt sprite boundaries into stripe-free optical silk in < 0.06 ms.
 */
function buildBlurFragmentShader(): string {
  const sigma = 19.0
  const pairs = 18 // covers +-36 texels (73 taps total)
  const rawWeights: number[] = []
  let total = 0
  for (let i = 0; i <= pairs * 2; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma))
    rawWeights.push(w)
    total += i === 0 ? w : 2 * w
  }
  const norm = rawWeights.map((w) => w / total)
  const lines: string[] = [`  vec4 acc = texture2D(u_tex, v_uv) * ${norm[0]!.toFixed(7)};`]
  for (let p = 0; p < pairs; p++) {
    const i1 = p * 2 + 1
    const i2 = p * 2 + 2
    const w1 = norm[i1]!
    const w2 = norm[i2]!
    const wPair = w1 + w2
    const offset = i1 + w2 / (wPair || 1)
    lines.push(
      `  acc += (texture2D(u_tex, clamp(v_uv + u_step * ${offset.toFixed(5)}, 0.002, 0.998)) + texture2D(u_tex, clamp(v_uv - u_step * ${offset.toFixed(5)}, 0.002, 0.998))) * ${wPair.toFixed(7)};`
    )
  }

  return `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_step;
void main() {
${lines.join('\n')}
  gl_FragColor = vec4(acc.rgb, 1.0);
}
`
}

const BLUR_FRAGMENT_SHADER = buildBlurFragmentShader()

const OKLAB_GAMUT_AND_DITHER_GLSL = `
float linearToSrgb(float c) {
  float v = clamp(c, 0.0, 1.0);
  float hi = 1.055 * pow(max(v, 0.0001), 1.0 / 2.4) - 0.055;
  return mix(12.92 * v, hi, step(0.0031308, v));
}

vec3 okLabToLinearRgb(vec3 lab) {
  float lRoot = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float mRoot = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float sRoot = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  float l = lRoot * lRoot * lRoot;
  float m = mRoot * mRoot * mRoot;
  float s = sRoot * sRoot * sRoot;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}

vec3 okLabToGamutSrgb(vec3 lab) {
  vec3 lin = okLabToLinearRgb(lab);
  float minCh = min(lin.r, min(lin.g, lin.b));
  float maxCh = max(lin.r, max(lin.g, lin.b));
  float outOfGamut = clamp(step(0.0001, -minCh) + step(1.0001, maxCh), 0.0, 1.0);
  float lo = 0.0;
  float hi = 1.0;
  for (int i = 0; i < 5; i++) {
    float mid = 0.5 * (lo + hi);
    vec3 testLin = okLabToLinearRgb(vec3(lab.x, lab.yz * mid));
    float tMin = min(testLin.r, min(testLin.g, testLin.b));
    float tMax = max(testLin.r, max(testLin.g, testLin.b));
    float inside = step(-0.001, tMin) * step(tMax, 1.001);
    lo = mix(lo, mid, inside);
    hi = mix(mid, hi, inside);
  }
  vec3 mappedLin = okLabToLinearRgb(vec3(lab.x, lab.yz * lo));
  vec3 finalLin = mix(lin, mappedLin, outOfGamut);
  return vec3(linearToSrgb(finalLin.r), linearToSrgb(finalLin.g), linearToSrgb(finalLin.b));
}

float interleavedGradientNoise(vec2 screenPos) {
  return fract(52.9829189 * fract(dot(screenPos, vec2(0.06711056, 0.00583715))));
}

vec3 screenSpaceRgbDither(vec2 fragCoord) {
  vec3 n = vec3(
    interleavedGradientNoise(fragCoord),
    interleavedGradientNoise(fragCoord + vec2(17.0, 59.0)),
    interleavedGradientNoise(fragCoord + vec2(71.0, 23.0))
  );
  return (n - 0.5) * (1.8 / 255.0);
}
`

/**
 * Pass 4 (Full Viewport): Branch-free Smooth Divergence-Free Liquid Curl Warp + OkLab Chroma Polish +
 * Soft-Knee Lightness Ceiling + Screen-Space 3-Channel IGN RGB Dithering.
 */
const PRESENT_FRAGMENT_SHADER = `
precision highp float;

varying vec2 v_uv;

uniform sampler2D u_blurredTex;
uniform vec2 u_resolution;
uniform float u_phase;
uniform float u_swell;
uniform float u_minL;
uniform float u_maxL;
uniform float u_chromaAllow;
uniform float u_toneScale;

${OKLAB_GAMUT_AND_DITHER_GLSL}

void main() {
  float maxDim = max(u_resolution.x, u_resolution.y);
  vec2 aspectScale = u_resolution / max(maxDim, 1.0);
  vec2 aPos = (v_uv - 0.5) * aspectScale * 1.35;

  // Warping AFTER wide Gaussian blur bends color pools into organic, stripe-free liquid silk waves
  float warpAmp = 0.085 + 0.028 * u_swell;
  vec2 warpedUv = vec2(
    v_uv.x
      + warpAmp * sin(aPos.y * 3.4 + u_phase * 0.48) * cos(aPos.x * 2.1 - u_phase * 0.31)
      + warpAmp * 0.55 * cos((aPos.x + aPos.y) * 4.2 - u_phase * 0.39),
    v_uv.y
      + warpAmp * cos(aPos.x * 3.2 - u_phase * 0.44) * sin(aPos.y * 2.3 + u_phase * 0.29)
      + warpAmp * 0.55 * sin((aPos.x - aPos.y) * 3.9 + u_phase * 0.36)
  );

  vec4 packed = texture2D(u_blurredTex, clamp(warpedUv, 0.005, 0.995));
  vec3 lab = vec3(packed.r, packed.g - 0.5, packed.b - 0.5);

  // Branch-free post-blur chroma recovery keeps transitions jewel-saturated instead of pastel-flat
  float c = length(lab.yz);
  float safeC = max(c, 0.0001);
  float x = clamp((c * 1.24) / 0.295, 0.0, 8.0);
  float e2x = exp(-2.0 * x);
  float postC = 0.295 * ((1.0 - e2x) / (1.0 + e2x));
  lab.yz *= mix(1.0, postC / safeC, step(0.004, c));

  // Tone-adaptive perceptual lightness damping (settles dark mode comfortably while preserving chroma)
  lab.x *= u_toneScale;

  // Glossy liquid light-wave modulation
  float caust = sin(aPos.x * 2.8 + aPos.y * 2.2 + u_phase * 0.45 + cos(aPos.y * 3.1 - u_phase * 0.35));
  lab.x *= 1.0 + (0.038 + 0.018 * u_swell) * caust;

  // Branch-free chroma-aware perceptual lightness ceiling
  float chroma = length(lab.yz);
  float dynamicMaxL = u_maxL + u_chromaAllow * smoothstep(0.04, 0.145, chroma);
  float knee = dynamicMaxL - 0.06;
  float excess = max(0.0, lab.x - knee);
  lab.x = min(lab.x, knee) + 0.06 * (excess / (excess + 0.06));
  lab.x = clamp(lab.x, u_minL, dynamicMaxL);

  vec3 srgb = okLabToGamutSrgb(lab) + screenSpaceRgbDither(gl_FragCoord.xy);
  gl_FragColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
}
`

/**
 * Guaranteed branch-free single-pass WebGL fallback shader (used ONLY if FBO creation fails on an
 * unusual GPU/VM after `canvas.getContext('webgl')` has already bound the canvas to WebGL).
 */
const SINGLE_PASS_FALLBACK_FRAGMENT_SHADER = `
precision highp float;

varying vec2 v_uv;

uniform vec2 u_resolution;
uniform float u_phase;
uniform float u_swell;
uniform float u_transition;
uniform float u_minL;
uniform float u_maxL;
uniform float u_chromaAllow;
uniform float u_toneScale;

uniform vec3 u_prevA0;
uniform vec3 u_prevA1;
uniform vec3 u_prevA2;
uniform vec3 u_prevA3;
uniform vec3 u_prevA4;

uniform vec3 u_currA0;
uniform vec3 u_currA1;
uniform vec3 u_currA2;
uniform vec3 u_currA3;
uniform vec3 u_currA4;

${OKLAB_GAMUT_AND_DITHER_GLSL}

vec3 evalPool(vec2 aPos, float phase, float swell, vec3 a0, vec3 a1, vec3 a2, vec3 a3, vec3 aDeep) {
  float warp = 0.24 + 0.05 * swell;
  vec2 w = vec2(
    aPos.x + warp * sin(aPos.y * 2.8 + phase * 0.45),
    aPos.y + warp * cos(aPos.x * 2.6 - phase * 0.38)
  );
  vec3 lab = aDeep;
  float m0 = 1.0 - smoothstep(0.05, 0.95, length(w - vec2(-0.32 * cos(phase * 0.27), -0.26 * sin(phase * 0.23))));
  float m1 = 1.0 - smoothstep(0.05, 0.92, length(w - vec2(0.36 * cos(phase * 0.31 + 0.8), -0.28 * sin(phase * 0.25 + 0.5))));
  float m2 = 1.0 - smoothstep(0.05, 0.90, length(w - vec2(-0.30 * sin(phase * 0.35 + 1.7), 0.34 * cos(phase * 0.29 + 1.2))));
  float m3 = 1.0 - smoothstep(0.05, 0.85, length(w - vec2(0.32 * sin(phase * 0.41 + 2.4), 0.30 * cos(phase * 0.36 + 2.0))));
  lab = mix(lab, a0, m0 * 0.92);
  lab = mix(lab, a1, m1 * 0.88);
  lab = mix(lab, a2, m2 * 0.86);
  lab = mix(lab, a3, m3 * 0.84);
  return lab;
}

void main() {
  float maxDim = max(u_resolution.x, u_resolution.y);
  vec2 aPos = (v_uv - 0.5) * (u_resolution / max(maxDim, 1.0)) * 1.35;
  vec3 currLab = evalPool(aPos, u_phase, u_swell, u_currA0, u_currA1, u_currA2, u_currA3, u_currA4);
  vec3 prevLab = evalPool(aPos, u_phase - 0.35, u_swell, u_prevA0, u_prevA1, u_prevA2, u_prevA3, u_prevA4);
  vec3 lab = mix(prevLab, currLab, clamp(u_transition, 0.0, 1.0));
  lab.x *= u_toneScale;
  float chroma = length(lab.yz);
  float dynamicMaxL = u_maxL + u_chromaAllow * smoothstep(0.04, 0.145, chroma);
  lab.x = clamp(lab.x, u_minL, dynamicMaxL);
  vec3 srgb = okLabToGamutSrgb(lab) + screenSpaceRgbDither(gl_FragCoord.xy);
  gl_FragColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
}
`

function easeInOutSine(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return -(Math.cos(Math.PI * x) - 1) * 0.5
}

function readCoverAnchor(cover: MasteredFluidCover, index: number): OkLabTuple {
  return cover.anchorsOkLab[index] ?? cover.anchorsOkLab[0] ?? [0.22, 0, 0]
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Unable to allocate WebGL shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info =
      typeof gl.getShaderInfoLog === 'function'
        ? (gl.getShaderInfoLog(shader) ?? 'Unknown shader compile error')
        : 'Unknown shader compile error'
    gl.deleteShader(shader)
    throw new Error(info)
  }
  return shader
}

function linkProgram(gl: WebGLRenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc)
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc)
  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vert)
    gl.deleteShader(frag)
    throw new Error('Unable to create WebGL program')
  }
  gl.attachShader(program, vert)
  gl.attachShader(program, frag)
  gl.linkProgram(program)
  gl.deleteShader(vert)
  gl.deleteShader(frag)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info =
      typeof gl.getProgramInfoLog === 'function'
        ? (gl.getProgramInfoLog(program) ?? 'WebGL link failed')
        : 'WebGL link failed'
    gl.deleteProgram(program)
    throw new Error(info)
  }
  return program
}

interface FboTarget {
  fbo: WebGLFramebuffer
  tex: WebGLTexture
}

function createFboTarget(gl: WebGLRenderingContext, size: number): FboTarget {
  const tex = gl.createTexture()
  if (!tex) throw new Error('Unable to allocate FBO texture')
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)

  const fbo = gl.createFramebuffer()
  if (!fbo) {
    gl.deleteTexture(tex)
    throw new Error('Unable to allocate WebGL framebuffer')
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo)
    gl.deleteTexture(tex)
    throw new Error(`Incomplete WebGL FBO: ${status}`)
  }
  return { fbo, tex }
}

interface WebGLMultiFboBackend {
  kind: 'webgl'
  mode: 'fbo'
  gl: WebGLRenderingContext
  quadBuffer: WebGLBuffer
  prevTex: WebGLTexture
  currTex: WebGLTexture
  fboA: FboTarget
  fboB: FboTarget
  sceneProgram: WebGLProgram
  sceneAttrPos: number
  uScenePhase: WebGLUniformLocation | null
  uSceneSwell: WebGLUniformLocation | null
  uSceneTransition: WebGLUniformLocation | null
  uScenePrevTex: WebGLUniformLocation | null
  uSceneCurrTex: WebGLUniformLocation | null
  uScenePrevAnchors: (WebGLUniformLocation | null)[]
  uSceneCurrAnchors: (WebGLUniformLocation | null)[]
  blurProgram: WebGLProgram
  blurAttrPos: number
  uBlurTex: WebGLUniformLocation | null
  uBlurStep: WebGLUniformLocation | null
  presentProgram: WebGLProgram
  presentAttrPos: number
  uPresentTex: WebGLUniformLocation | null
  uPresentResolution: WebGLUniformLocation | null
  uPresentPhase: WebGLUniformLocation | null
  uPresentSwell: WebGLUniformLocation | null
  uPresentMinL: WebGLUniformLocation | null
  uPresentMaxL: WebGLUniformLocation | null
  uPresentChromaAllow: WebGLUniformLocation | null
  uPresentToneScale: WebGLUniformLocation | null
}

interface WebGLSinglePassBackend {
  kind: 'webgl'
  mode: 'single'
  gl: WebGLRenderingContext
  quadBuffer: WebGLBuffer
  program: WebGLProgram
  attrPos: number
  uResolution: WebGLUniformLocation | null
  uPhase: WebGLUniformLocation | null
  uSwell: WebGLUniformLocation | null
  uTransition: WebGLUniformLocation | null
  uMinL: WebGLUniformLocation | null
  uMaxL: WebGLUniformLocation | null
  uChromaAllow: WebGLUniformLocation | null
  uToneScale: WebGLUniformLocation | null
  uPrevAnchors: (WebGLUniformLocation | null)[]
  uCurrAnchors: (WebGLUniformLocation | null)[]
}

type WebGLBackend = WebGLMultiFboBackend | WebGLSinglePassBackend

interface Canvas2DBackend {
  kind: 'canvas2d'
  ctx: CanvasRenderingContext2D
  prevSprite: HTMLCanvasElement
  currSprite: HTMLCanvasElement
}

function createCoverTexture(gl: WebGLRenderingContext, cover: MasteredFluidCover): WebGLTexture {
  const tex = gl.createTexture()
  if (!tex) throw new Error('Unable to allocate WebGL texture')
  uploadCoverTexture(gl, tex, cover)
  return tex
}

function uploadCoverTexture(
  gl: WebGLRenderingContext,
  tex: WebGLTexture,
  cover: MasteredFluidCover
): void {
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    cover.width,
    cover.height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    cover.pixels
  )
}

function writeSpriteCanvas(target: HTMLCanvasElement, cover: MasteredFluidCover): void {
  target.width = cover.width
  target.height = cover.height
  const ctx = target.getContext('2d')
  if (!ctx) return
  const imgData = ctx.createImageData(cover.width, cover.height)
  imgData.data.set(cover.pixels)
  ctx.putImageData(imgData, 0, 0)
}

function resetWebGLPipelineState(gl: WebGLRenderingContext): void {
  if (typeof gl.disable === 'function') {
    if (gl.DEPTH_TEST !== undefined) gl.disable(gl.DEPTH_TEST)
    if (gl.BLEND !== undefined) gl.disable(gl.BLEND)
    if (gl.CULL_FACE !== undefined) gl.disable(gl.CULL_FACE)
    if (gl.SCISSOR_TEST !== undefined) gl.disable(gl.SCISSOR_TEST)
  }
  if (typeof gl.colorMask === 'function') {
    gl.colorMask(true, true, true, true)
  }
}

export class AppleMusicFluidRenderer {
  private readonly canvas: HTMLCanvasElement
  private readonly maxRenderScale: number
  private readonly transitionDurationMs: number
  private backend: WebGLBackend | Canvas2DBackend | null = null
  private prevCover: MasteredFluidCover
  private currCover: MasteredFluidCover
  private transitionStartMs = 0
  private transitionProgress = 1
  private cssWidth = 1
  private cssHeight = 1
  private disposed = false

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault()
    this.backend = null
  }

  private readonly onContextRestored = (): void => {
    if (this.disposed) return
    this.initBackend()
  }

  constructor(canvas: HTMLCanvasElement, options: FluidRendererOptions = {}) {
    this.canvas = canvas
    this.maxRenderScale = options.maxRenderScale ?? 1.35
    this.transitionDurationMs = options.transitionDurationMs ?? 1100
    const initial = createFallbackFluidCover()
    this.prevCover = initial
    this.currCover = initial

    this.canvas.addEventListener('webglcontextlost', this.onContextLost)
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored)
    this.initBackend()
  }

  getBackendKind(): 'webgl' | 'canvas2d' | 'none' {
    return this.backend?.kind ?? 'none'
  }

  resize(cssWidth: number, cssHeight: number, dpr = window.devicePixelRatio || 1): void {
    if (this.disposed) return
    this.cssWidth = Math.max(1, Math.floor(cssWidth))
    this.cssHeight = Math.max(1, Math.floor(cssHeight))
    const scale = Math.min(Math.max(1, dpr), this.maxRenderScale)
    const pixelWidth = Math.max(1, Math.round(this.cssWidth * scale))
    const pixelHeight = Math.max(1, Math.round(this.cssHeight * scale))
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth
      this.canvas.height = pixelHeight
    }
  }

  setCover(cover: MasteredFluidCover, immediate = false, nowMs = performance.now()): void {
    if (this.disposed) return
    if (immediate || this.transitionProgress < 0.08) {
      this.prevCover = cover
      this.currCover = cover
      this.transitionProgress = 1
    } else {
      this.prevCover = this.currCover
      this.currCover = cover
      this.transitionStartMs = nowMs
      this.transitionProgress = 0
    }

    if (!this.backend) this.initBackend()
    if (!this.backend) return

    if (this.backend.kind === 'webgl') {
      if (this.backend.mode === 'fbo') {
        this.backend.gl.activeTexture(this.backend.gl.TEXTURE0)
        uploadCoverTexture(this.backend.gl, this.backend.prevTex, this.prevCover)
        uploadCoverTexture(this.backend.gl, this.backend.currTex, this.currCover)
      }
    } else {
      writeSpriteCanvas(this.backend.prevSprite, this.prevCover)
      writeSpriteCanvas(this.backend.currSprite, this.currCover)
    }
  }

  isTransitioning(): boolean {
    return this.transitionProgress < 1
  }

  render(params: FluidFrameParams, nowMs = performance.now()): void {
    if (this.disposed) return
    if (!this.backend) this.initBackend()
    if (!this.backend) return

    if (this.transitionProgress < 1) {
      const elapsed = Math.max(0, nowMs - this.transitionStartMs)
      const raw =
        this.transitionDurationMs <= 0 ? 1 : Math.min(1, elapsed / this.transitionDurationMs)
      this.transitionProgress = raw >= 1 ? 1 : easeInOutSine(raw)
    }

    if (this.backend.kind === 'webgl') {
      if (this.backend.mode === 'fbo') {
        this.renderWebGLMultiFbo(this.backend, params)
      } else {
        this.renderWebGLSinglePass(this.backend, params)
      }
    } else {
      this.renderCanvas2D(this.backend, params)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored)
    if (this.backend?.kind === 'webgl') {
      const b = this.backend
      const { gl } = b
      if (b.mode === 'fbo') {
        gl.deleteFramebuffer(b.fboA.fbo)
        gl.deleteTexture(b.fboA.tex)
        gl.deleteFramebuffer(b.fboB.fbo)
        gl.deleteTexture(b.fboB.tex)
        gl.deleteTexture(b.prevTex)
        gl.deleteTexture(b.currTex)
        gl.deleteBuffer(b.quadBuffer)
        gl.deleteProgram(b.sceneProgram)
        gl.deleteProgram(b.blurProgram)
        gl.deleteProgram(b.presentProgram)
      } else {
        gl.deleteBuffer(b.quadBuffer)
        gl.deleteProgram(b.program)
      }
    }
    this.backend = null
  }

  private initBackend(): void {
    if (this.disposed) return
    let gl: WebGLRenderingContext | null = null
    try {
      gl = (this.canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'low-power',
        preserveDrawingBuffer: false
      }) ||
        this.canvas.getContext('experimental-webgl', {
          alpha: false,
          antialias: false,
          depth: false,
          stencil: false
        })) as WebGLRenderingContext | null
    } catch {
      gl = null
    }

    if (gl) {
      try {
        const sceneProgram = linkProgram(gl, FBO_VERTEX_SHADER, SCENE_FRAGMENT_SHADER)
        const blurProgram = linkProgram(gl, FBO_VERTEX_SHADER, BLUR_FRAGMENT_SHADER)
        const presentProgram = linkProgram(gl, PRESENT_VERTEX_SHADER, PRESENT_FRAGMENT_SHADER)

        const quadBuffer = gl.createBuffer()
        if (!quadBuffer) {
          gl.deleteProgram(sceneProgram)
          gl.deleteProgram(blurProgram)
          gl.deleteProgram(presentProgram)
          throw new Error('Unable to create WebGL quad buffer')
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer)
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
          gl.STATIC_DRAW
        )

        const fboA = createFboTarget(gl, FBO_SIZE)
        const fboB = createFboTarget(gl, FBO_SIZE)
        const prevTex = createCoverTexture(gl, this.prevCover)
        const currTex = createCoverTexture(gl, this.currCover)

        this.backend = {
          kind: 'webgl',
          mode: 'fbo',
          gl,
          quadBuffer,
          prevTex,
          currTex,
          fboA,
          fboB,
          sceneProgram,
          sceneAttrPos: gl.getAttribLocation(sceneProgram, 'a_pos'),
          uScenePhase: gl.getUniformLocation(sceneProgram, 'u_phase'),
          uSceneSwell: gl.getUniformLocation(sceneProgram, 'u_swell'),
          uSceneTransition: gl.getUniformLocation(sceneProgram, 'u_transition'),
          uScenePrevTex: gl.getUniformLocation(sceneProgram, 'u_prevTex'),
          uSceneCurrTex: gl.getUniformLocation(sceneProgram, 'u_currTex'),
          uScenePrevAnchors: [0, 1, 2, 3, 4].map((i) =>
            gl.getUniformLocation(sceneProgram, `u_prevA${i}`)
          ),
          uSceneCurrAnchors: [0, 1, 2, 3, 4].map((i) =>
            gl.getUniformLocation(sceneProgram, `u_currA${i}`)
          ),
          blurProgram,
          blurAttrPos: gl.getAttribLocation(blurProgram, 'a_pos'),
          uBlurTex: gl.getUniformLocation(blurProgram, 'u_tex'),
          uBlurStep: gl.getUniformLocation(blurProgram, 'u_step'),
          presentProgram,
          presentAttrPos: gl.getAttribLocation(presentProgram, 'a_pos'),
          uPresentTex: gl.getUniformLocation(presentProgram, 'u_blurredTex'),
          uPresentResolution: gl.getUniformLocation(presentProgram, 'u_resolution'),
          uPresentPhase: gl.getUniformLocation(presentProgram, 'u_phase'),
          uPresentSwell: gl.getUniformLocation(presentProgram, 'u_swell'),
          uPresentMinL: gl.getUniformLocation(presentProgram, 'u_minL'),
          uPresentMaxL: gl.getUniformLocation(presentProgram, 'u_maxL'),
          uPresentChromaAllow: gl.getUniformLocation(presentProgram, 'u_chromaAllow'),
          uPresentToneScale: gl.getUniformLocation(presentProgram, 'u_toneScale')
        }
        return
      } catch (fboError) {
        // Once a canvas acquires a WebGL context, `getContext('2d')` always returns null.
        // Fall back to a branch-free single-pass WebGL program on the SAME `gl` context
        // so the canvas can never get stuck on an unpainted #000000 black buffer.
        console.warn('[AppleMusicFluidRenderer] Multi-FBO pipeline fallback:', fboError)
        try {
          const program = linkProgram(
            gl,
            PRESENT_VERTEX_SHADER,
            SINGLE_PASS_FALLBACK_FRAGMENT_SHADER
          )
          const quadBuffer = gl.createBuffer()
          if (!quadBuffer) {
            gl.deleteProgram(program)
            throw new Error('Unable to create fallback quad buffer')
          }
          gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer)
          gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
            gl.STATIC_DRAW
          )
          this.backend = {
            kind: 'webgl',
            mode: 'single',
            gl,
            quadBuffer,
            program,
            attrPos: gl.getAttribLocation(program, 'a_pos'),
            uResolution: gl.getUniformLocation(program, 'u_resolution'),
            uPhase: gl.getUniformLocation(program, 'u_phase'),
            uSwell: gl.getUniformLocation(program, 'u_swell'),
            uTransition: gl.getUniformLocation(program, 'u_transition'),
            uMinL: gl.getUniformLocation(program, 'u_minL'),
            uMaxL: gl.getUniformLocation(program, 'u_maxL'),
            uChromaAllow: gl.getUniformLocation(program, 'u_chromaAllow'),
            uToneScale: gl.getUniformLocation(program, 'u_toneScale'),
            uPrevAnchors: [0, 1, 2, 3, 4].map((i) =>
              gl.getUniformLocation(program, `u_prevA${i}`)
            ),
            uCurrAnchors: [0, 1, 2, 3, 4].map((i) =>
              gl.getUniformLocation(program, `u_currA${i}`)
            )
          }
          return
        } catch (singleError) {
          console.error('[AppleMusicFluidRenderer] Single-pass WebGL fallback failed:', singleError)
          return
        }
      }
    }

    const ctx = this.canvas.getContext('2d')
    if (!ctx || typeof document === 'undefined') return
    const prevSprite = document.createElement('canvas')
    const currSprite = document.createElement('canvas')
    writeSpriteCanvas(prevSprite, this.prevCover)
    writeSpriteCanvas(currSprite, this.currCover)
    this.backend = { kind: 'canvas2d', ctx, prevSprite, currSprite }
  }

  private renderWebGLMultiFbo(b: WebGLMultiFboBackend, params: FluidFrameParams): void {
    const { gl } = b
    resetWebGLPipelineState(gl)
    gl.bindBuffer(gl.ARRAY_BUFFER, b.quadBuffer)

    // Pass 1: Render opaque-core orbiting cover sprites into 256x256 fboA (packed OkLab)
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fboA.fbo)
    gl.viewport(0, 0, FBO_SIZE, FBO_SIZE)
    gl.useProgram(b.sceneProgram)
    gl.enableVertexAttribArray(b.sceneAttrPos)
    gl.vertexAttribPointer(b.sceneAttrPos, 2, gl.FLOAT, false, 0, 0)

    gl.uniform1f(b.uScenePhase, params.phase)
    gl.uniform1f(b.uSceneSwell, params.swell)
    gl.uniform1f(b.uSceneTransition, this.transitionProgress)

    for (let i = 0; i < 5; i++) {
      const pa = readCoverAnchor(this.prevCover, i)
      const ca = readCoverAnchor(this.currCover, i)
      gl.uniform3f(b.uScenePrevAnchors[i]!, pa[0], pa[1], pa[2])
      gl.uniform3f(b.uSceneCurrAnchors[i]!, ca[0], ca[1], ca[2])
    }

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, b.prevTex)
    gl.uniform1i(b.uScenePrevTex, 0)

    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, b.currTex)
    gl.uniform1i(b.uSceneCurrTex, 1)

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // Unbind TEXTURE1 before FBO ping-pong passes
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, null)

    // Pass 2: Horizontal 73-tap separable Gaussian blur (fboA -> fboB)
    const invFbo = 1 / FBO_SIZE
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fboB.fbo)
    gl.viewport(0, 0, FBO_SIZE, FBO_SIZE)
    gl.useProgram(b.blurProgram)
    gl.enableVertexAttribArray(b.blurAttrPos)
    gl.vertexAttribPointer(b.blurAttrPos, 2, gl.FLOAT, false, 0, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, b.fboA.tex)
    gl.uniform1i(b.uBlurTex, 0)
    gl.uniform2f(b.uBlurStep, invFbo, 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // Pass 3: Vertical 73-tap separable Gaussian blur (fboB -> fboA)
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fboA.fbo)
    gl.viewport(0, 0, FBO_SIZE, FBO_SIZE)
    gl.bindTexture(gl.TEXTURE_2D, b.fboB.tex)
    gl.uniform2f(b.uBlurStep, 0, invFbo)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // Pass 4: Present full-screen liquid curl warp + OkLab chroma polish + IGN RGB dither
    const w = Math.max(1, this.canvas.width)
    const h = Math.max(1, this.canvas.height)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, w, h)
    gl.useProgram(b.presentProgram)
    gl.enableVertexAttribArray(b.presentAttrPos)
    gl.vertexAttribPointer(b.presentAttrPos, 2, gl.FLOAT, false, 0, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, b.fboA.tex)
    gl.uniform1i(b.uPresentTex, 0)
    const isLight = params.tone === 'light'
    gl.uniform2f(b.uPresentResolution, w, h)
    gl.uniform1f(b.uPresentPhase, params.phase)
    gl.uniform1f(b.uPresentSwell, params.swell)
    gl.uniform1f(b.uPresentMinL, isLight ? 0.18 : 0.115)
    gl.uniform1f(b.uPresentMaxL, isLight ? 0.565 : 0.455)
    gl.uniform1f(b.uPresentChromaAllow, isLight ? 0.135 : 0.095)
    gl.uniform1f(b.uPresentToneScale, isLight ? 1.0 : 0.94)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // Unbind fboA.tex from TEXTURE0 so the next frame's Pass 1 bindFramebuffer(fboA) never sees a feedback loop
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  private renderWebGLSinglePass(b: WebGLSinglePassBackend, params: FluidFrameParams): void {
    const { gl } = b
    const w = Math.max(1, this.canvas.width)
    const h = Math.max(1, this.canvas.height)
    const isLight = params.tone === 'light'
    resetWebGLPipelineState(gl)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, w, h)
    gl.useProgram(b.program)
    gl.bindBuffer(gl.ARRAY_BUFFER, b.quadBuffer)
    gl.enableVertexAttribArray(b.attrPos)
    gl.vertexAttribPointer(b.attrPos, 2, gl.FLOAT, false, 0, 0)
    gl.uniform2f(b.uResolution, w, h)
    gl.uniform1f(b.uPhase, params.phase)
    gl.uniform1f(b.uSwell, params.swell)
    gl.uniform1f(b.uTransition, this.transitionProgress)
    gl.uniform1f(b.uMinL, isLight ? 0.18 : 0.115)
    gl.uniform1f(b.uMaxL, isLight ? 0.565 : 0.455)
    gl.uniform1f(b.uChromaAllow, isLight ? 0.135 : 0.095)
    gl.uniform1f(b.uToneScale, isLight ? 1.0 : 0.94)
    for (let i = 0; i < 5; i++) {
      const pa = readCoverAnchor(this.prevCover, i)
      const ca = readCoverAnchor(this.currCover, i)
      gl.uniform3f(b.uPrevAnchors[i]!, pa[0], pa[1], pa[2])
      gl.uniform3f(b.uCurrAnchors[i]!, ca[0], ca[1], ca[2])
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private renderCanvas2D(b: Canvas2DBackend, params: FluidFrameParams): void {
    const { ctx } = b
    const w = this.canvas.width
    const h = this.canvas.height
    const maxDim = Math.max(w, h)
    ctx.save()
    ctx.imageSmoothingEnabled = true

    const drawLayerSet = (
      sprite: HTMLCanvasElement,
      cover: MasteredFluidCover,
      alpha: number,
      phase: number
    ): void => {
      if (alpha <= 0.001) return
      ctx.save()
      ctx.globalAlpha = alpha
      const deep = readCoverAnchor(cover, 4)
      const [dr, dg, db] = okLabToGamutSrgb(deep[0], deep[1], deep[2])
      ctx.fillStyle = `rgb(${Math.round(dr * 255)}, ${Math.round(dg * 255)}, ${Math.round(db * 255)})`
      ctx.fillRect(0, 0, w, h)

      const layers = [
        { cx: w * 0.5, cy: h * 0.5, size: maxDim * 1.44, rot: phase * 0.14, op: 0.85 },
        { cx: w * 0.3, cy: h * 0.34, size: maxDim * 0.96, rot: -phase * 0.24, op: 0.9 },
        {
          cx: w * (0.66 + 0.16 * Math.cos(phase * 0.31)),
          cy: h * (0.58 + 0.15 * Math.sin(phase * 0.26)),
          size: maxDim * 0.78,
          rot: phase * 0.22,
          op: 0.88
        }
      ]
      for (const layer of layers) {
        ctx.save()
        ctx.globalAlpha = alpha * layer.op
        ctx.translate(layer.cx, layer.cy)
        ctx.rotate(layer.rot)
        ctx.drawImage(sprite, -layer.size * 0.5, -layer.size * 0.5, layer.size, layer.size)
        ctx.restore()
      }
      ctx.restore()
    }

    if (this.transitionProgress < 0.999) {
      drawLayerSet(b.prevSprite, this.prevCover, 1, params.phase - 0.35)
    }
    drawLayerSet(b.currSprite, this.currCover, this.transitionProgress, params.phase)
    ctx.restore()
  }
}
