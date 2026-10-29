import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileStyle, parse } from '@vue/compiler-sfc'
import { THEME_TOKEN_DEFINITIONS } from '../../../shared/themeTokens.ts'

const require = createRequire(import.meta.url)

test('dark cover backgrounds stay brighter, legible and stable through fades without affecting other modes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-playback-backdrop-'))
  try {
    const source = await readFile(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')
    const { descriptor } = parse(source)
    const template = descriptor.template!.content.match(
      /<div v-if="!visualizerMounted" class="backdrop"[\s\S]*?\n        <\/div>/
    )?.[0]
    assert.ok(template, 'fixture must render the production backdrop template')
    const compiled = compileStyle({
      source: descriptor.styles[0].content,
      filename: 'PlayingMusic.vue',
      id: 'data-v-backdrop-test',
      scoped: true
    })
    assert.deepEqual(compiled.errors, [])
    const noise = await readFile(new URL('../assets/images/playback-dither.svg', import.meta.url))
    const css = compiled.code.replace(
      '../assets/images/playback-dither.svg',
      `data:image/svg+xml;base64,${noise.toString('base64')}`
    )
    await copyFile(require.resolve('vue/dist/vue.global.js'), join(directory, 'vue.js'))
    await writeFile(join(directory, 'index.html'), fixtureHtml(template, css))
    await writeFile(join(directory, 'runner.cjs'), runnerSource())
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const { stdout } = await promisify(execFile)(
      require('electron') as string,
      ['--no-sandbox', '--force-device-scale-factor=1', join(directory, 'runner.cjs')],
      { env, windowsHide: true, timeout: 45_000 }
    )
    assert.match(stdout, /PLAYBACK_BACKDROP_OK/)
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), 'twilight-playback-backdrop-')))
    await rm(directory, { recursive: true, force: true })
  }
})

function fixtureHtml(template: string, css: string): string {
  const defaults = Object.fromEntries(
    (['dark', 'pureWhite'] as const).map((tone) => [
      tone,
      Object.fromEntries(
        THEME_TOKEN_DEFINITIONS.filter((token) => token.id.startsWith('playback.backdrop.')).map(
          (token) => [token.cssVariable, token.defaults[tone]]
        )
      )
    ])
  )
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>
  :root { --te-player-bg: #0b0f15; --te-ease-out-strong: ease-out }
  body { margin: 0 }
  ${css}
  #foreground { position: absolute; z-index: 1; top: 32px; left: 32px; width: 180px;
    height: 80px; border: 0; background: #234567; color: white; font-size: 20px }
  html[data-baseline] .backdrop { filter: none !important }
  </style></head><body><div id="app"></div><script src="vue.js"></script><script>
  const { createApp, ref, computed, nextTick } = Vue
  const defaults = ${JSON.stringify(defaults)}
  const mode = ref('blur'), currentTrack = ref(null), visualizerMounted = ref(false)
  const cover = (colors) => 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">' +
    '<defs><linearGradient id="c" x2="1" y2="1"><stop stop-color="' + colors[0] +
    '"/><stop offset=".48" stop-color="' + colors[1] + '"/><stop offset="1" stop-color="' +
    colors[2] + '"/></linearGradient></defs><path fill="url(#c)" d="M0 0h800v800H0z"/></svg>')
  const covers = [cover(['#00684c', '#bf987b', '#14375b']), cover(['#040710', '#2c4877', '#b5bbc4']), cover(['#fff', '#fff', '#fff']), cover(['#101010', '#101010', '#101010'])]
  currentTrack.value = { id: '0', cover: covers[0] }
  createApp({
    __scopeId: 'data-v-backdrop-test',
    components: { CoverImg: { props: ['cover', 'coverSource', 'identity'], template: '<img :src="cover">' } },
    setup: () => ({ mode, currentTrack, visualizerMounted, hasSwitchedPlaybackView: true,
      isBlurBackground: computed(() => mode.value === 'blur'),
      isFluidBackground: computed(() => mode.value === 'fluid'),
      isSolidBackground: computed(() => mode.value === 'solid'),
      coverIdentity: computed(() => currentTrack.value?.id) }),
    template: ${JSON.stringify(`<div class="playing-music" :class="'bg-' + mode" style="--accent-color: #168864">${template}<button id="foreground">播放 / 暂停</button></div>`)}
  }).mount('#app')
  window.configure = async ({ theme = 'dark', background = 'blur', track = 0, visualizer = false, motion = 'off', baseline = false, tokens = true, filter, settle = 650 } = {}) => {
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.teMotion = motion
    document.documentElement.toggleAttribute('data-baseline', baseline)
    const style = document.documentElement.style
    for (const [name, value] of Object.entries(defaults[theme === 'dark' ? 'dark' : 'pureWhite'])) {
      if (tokens) style.setProperty(name, value)
      else style.removeProperty(name)
    }
    if (filter) style.setProperty('--te-playback-backdrop-filter', filter)
    mode.value = background
    visualizerMounted.value = visualizer
    currentTrack.value = track === null ? null : { id: String(track), cover: covers[track] }
    await nextTick()
    await Promise.all([...document.images].map(image => image.decode()))
    await new Promise(resolve => setTimeout(resolve, settle))
  }
  </script></body></html>`
}

function runnerSource(): string {
  return `const { app, BrowserWindow, nativeImage } = require('electron')
  const assert = require('node:assert/strict')
  const { join } = require('node:path')
  const { mkdir, writeFile } = require('node:fs/promises')
  const profile = process.env.TWILIGHT_ELECTRON_USER_DATA_DIR || join(__dirname, 'profile')
  app.setPath('userData', profile)
  app.commandLine.appendSwitch('disk-cache-dir', join(profile, 'cache'))
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 2560, height: 1440, useContentSize: true,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, offscreen: true } })
    const js = code => win.webContents.executeJavaScript(code)
    const configure = options => js('window.configure(' + JSON.stringify(options) + ')')
    const capture = async () => {
      const image = await win.webContents.capturePage()
      return { image, pixels: image.toBitmap(), ...image.getSize() }
    }
    const stats = (before, after) => {
      assert.equal(before.width, after.width)
      let changed = 0, sum = 0, max = 0, count = 0, foregroundChanges = 0, samples = 0
      const channelSum = [0, 0, 0], squared = [0, 0, 0], products = [0, 0, 0]
      for (let y = 0; y < before.height; y++) for (let x = 0; x < before.width; x++) {
        const foreground = x >= 32 && x < 212 && y >= 32 && y < 112
        const deltaRgb = []
        for (let c = 0; c < 3; c++) {
          const i = (y * before.width + x) * 4 + c
          const delta = after.pixels[i] - before.pixels[i]
          if (foreground) { foregroundChanges += delta !== 0; continue }
          changed += delta !== 0; sum += delta; max = Math.max(max, Math.abs(delta)); count++
          channelSum[c] += delta; squared[c] += delta * delta; deltaRgb[c] = delta
        }
        if (foreground) continue
        samples++
        products[0] += deltaRgb[0] * deltaRgb[1]
        products[1] += deltaRgb[1] * deltaRgb[2]
        products[2] += deltaRgb[2] * deltaRgb[0]
      }
      const meanRgb = channelSum.map(sum => sum / samples)
      const variance = squared.map((sum, c) => sum / samples - meanRgb[c] ** 2)
      const correlation = [[0, 1], [1, 2], [2, 0]].map(([a, b], i) =>
        (products[i] / samples - meanRgb[a] * meanRgb[b]) / Math.sqrt(variance[a] * variance[b]))
      return { changed: changed / count, mean: sum / count, max, foregroundChanges,
        meanRgb, rmsRgb: squared.map(sum => Math.sqrt(sum / samples)), correlation }
    }
    const longestFlatRun = frame => {
      const y = Math.floor(frame.height / 2)
      let longest = 1, run = 1
      for (let x = 513; x < 2048; x++) {
        const i = (y * frame.width + x) * 4
        const same = [0, 1, 2].every(c => frame.pixels[i + c] === frame.pixels[i - 4 + c])
        run = same ? run + 1 : 1
        longest = Math.max(longest, run)
      }
      return longest
    }
    const luminance = frame => {
      let total = 0, max = 0, count = 0
      const linear = value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
      for (let y = 128; y < frame.height; y += 4) for (let x = 0; x < frame.width; x += 4) {
        const i = (y * frame.width + x) * 4
        const value = .2126 * linear(frame.pixels[i + 2] / 255) +
          .7152 * linear(frame.pixels[i + 1] / 255) + .0722 * linear(frame.pixels[i] / 255)
        total += value; max = Math.max(max, value); count++
      }
      return { mean: total / count, max }
    }
    try {
      await win.loadFile(join(__dirname, 'index.html'))
      const visualDir = process.env.TWILIGHT_BACKDROP_VISUAL_DIR
      if (visualDir) await mkdir(visualDir, { recursive: true })
      for (const track of [0, 1]) {
        await configure({ track, filter: 'blur(58px) saturate(1.32) brightness(0.36)' })
        const dimmed = await capture()
        await configure({ track, baseline: true })
        const before = await capture()
        assert.equal(before.width, 2560); assert.equal(before.height, 1440)
        await configure({ track })
        const after = await capture()
        const result = stats(before, after)
        const flatRuns = [longestFlatRun(before), longestFlatRun(after)]
        const brightness = [luminance(dimmed).mean, luminance(after).mean]
        console.log('BACKDROP', track, JSON.stringify({ ...result, flatRuns, brightness }))
        if (visualDir) {
          await writeFile(join(visualDir, 'cover-' + track + '-before.png'), before.image.toPNG())
          await writeFile(join(visualDir, 'cover-' + track + '-after.png'), after.image.toPNG())
          await writeFile(join(visualDir, 'cover-' + track + '-dimmed.png'), dimmed.image.toPNG())
          await writeFile(join(visualDir, 'cover-' + track + '-metrics.json'), JSON.stringify({ ...result, flatRuns, brightness }, null, 2))
        }
        assert.ok(brightness[1] > brightness[0] * 1.8, 'removing duplicate dimming must visibly lift the cover background')
        assert.ok(result.changed > 0.1, 'noise must survive all dimming/gradient layers')
        assert.ok(result.max <= 4, 'grain must stay subtle')
        assert.ok(result.correlation.every(value => Math.abs(value) < .2), 'R/G/B must be dithered independently, not only the brightness')
        assert.ok(result.meanRgb.every(value => Math.abs(value) < .25), 'dither must not shift any color channel')
        assert.ok(flatRuns[1] <= Math.max(4, flatRuns[0] / 2), 'long flat color steps must be broken up; already-smooth gradients must stay smooth')
        assert.ok(Math.abs(result.mean) < 0.25, 'grain must not lift blacks or shift the palette')
        assert.equal(result.foregroundChanges, 0, 'grain leaked onto foreground controls')
        const repeated = await capture()
        assert.equal(after.pixels.equals(repeated.pixels), true, 'static grain must not shimmer')
      }
      await configure({ track: 3, baseline: true })
      const darkBefore = await capture()
      await configure({ track: 3 })
      const darkAfter = await capture()
      const darkStats = stats(darkBefore, darkAfter)
      console.log('DARK_RGB_DITHER', JSON.stringify(darkStats))
      assert.ok(darkStats.rmsRgb.every(value => value > 1.3), 'all channels must retain effective dithering even near black')
      assert.ok(darkStats.meanRgb.every(value => Math.abs(value) < .25), 'dark dither must not lift blacks or introduce a color cast')
      assert.ok(darkStats.max <= 4)
      assert.equal(darkStats.foregroundChanges, 0)
      await configure({ track: 2 })
      const whiteCover = await capture()
      const contrast = 1.05 / (luminance(whiteCover).max + .05)
      console.log('WHITE_LYRIC_CONTRAST', contrast)
      assert.ok(contrast >= 4.5, 'the brightest cover must retain readable white lyrics')
      for (const options of [{}, { tokens: false }, { filter: 'blur(64px) saturate(0.9) brightness(0.6)' }]) {
        await configure({ ...options, track: 0 })
        const filter = await js('getComputedStyle(document.querySelector(".backdrop-cover-wrap img")).filter')
        await configure({ ...options, track: 1, motion: 'full', settle: 40 })
        const fading = await js('[...document.querySelectorAll(".backdrop-cover-wrap")].map(wrap => ({ classes: wrap.className, filter: getComputedStyle(wrap.querySelector("img")).filter, transition: getComputedStyle(wrap).transitionProperty }))')
        assert.equal(fading.length, 2, 'both covers must participate in the fade')
        for (const layer of fading) {
          assert.match(layer.classes, /backdrop-cover-fade-(enter|leave)-active/)
          assert.equal(layer.filter, filter, 'fading must not override default or custom artwork filters')
          assert.equal(layer.transition, 'opacity', 'the expensive filter must stay static during the fade')
        }
        await configure({ ...options, track: 1 })
        assert.equal(await js('getComputedStyle(document.querySelector(".backdrop-cover-wrap img")).filter'), filter)
      }
      await configure({})
      const defaultFilter = await js('getComputedStyle(document.querySelector(".backdrop-cover-wrap img")).filter')
      await configure({ tokens: false })
      assert.equal(await js('getComputedStyle(document.querySelector(".backdrop-cover-wrap img")).filter'), defaultFilter, 'dark CSS fallback must match the applied theme default')
      for (const options of [{ theme: 'light' }, { theme: 'pureWhite' }, { background: 'solid' }, { background: 'fluid' }, { track: null }]) {
        await configure(options)
        assert.equal(await js('getComputedStyle(document.querySelector(".backdrop")).filter'), 'none', JSON.stringify(options))
        assert.match(await js('getComputedStyle(document.querySelector(".backdrop-accent")).backgroundImage'), /radial-gradient/, 'other background modes must retain their existing lighting')
      }
      await configure({ motion: 'reduced' })
      assert.match(await js('getComputedStyle(document.querySelector(".backdrop")).filter'), /#dither/)
      assert.equal(await js('document.elementFromPoint(64, 64).id'), 'foreground')
      assert.equal(await js('getComputedStyle(document.querySelector(".backdrop-accent")).backgroundImage'), 'none', 'dark cover mode must not add radial alpha bands')
      const tint = await js('getComputedStyle(document.querySelector(".backdrop-accent")).backgroundColor')
      await js('document.documentElement.style.setProperty("--te-playback-backdrop-highlight", "rgba(200, 100, 255, 0.2)")')
      assert.notEqual(await js('getComputedStyle(document.querySelector(".backdrop-accent")).backgroundColor'), tint, 'custom highlight colors must still affect the flat wash')

      // Offscreen capturePage uses DPR 1 even with a fractional-scale switch.
      // Capture the actual compositor surface at 150%, matching the reported display.
      win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: 1706, height: 1066, deviceScaleFactor: 1.5, mobile: false
      })
      assert.equal(await js('devicePixelRatio'), 1.5)
      const captureNative = async () => {
        const { data } = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
          fromSurface: true, captureBeyondViewport: false
        })
        const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
        return { image, pixels: image.toBitmap(), ...image.getSize() }
      }
      await configure({ track: 2 })
      const flat = await captureNative()
      assert.equal(flat.width, 2559); assert.equal(flat.height, 1599)
      // Stay inside the artwork's natural blur falloff at the viewport edges.
      const horizontalMeans = frame => [.18, .3, .4, .6, .75, .88].map(fraction => {
        const rgb = [0, 0, 0], x0 = Math.round(frame.width * fraction) - 32
        for (let y = 300; y < 428; y++) for (let x = x0; x < x0 + 64; x++) {
          const index = (y * frame.width + x) * 4
          for (let c = 0; c < 3; c++) rgb[c] += frame.pixels[index + c] / (128 * 64)
        }
        return rgb
      })
      const span = frame => [0, 1, 2].map(channel => {
        const means = horizontalMeans(frame).map(rgb => rgb[channel])
        return Math.max(...means) - Math.min(...means)
      })
      // Reproduce the old lighting as a positive control: grain alone did not
      // remove its concentric color contours on an otherwise uniform cover.
      const radial = 'radial-gradient(circle at 18% 26%, color-mix(in srgb, var(--accent-color) 22%, transparent), transparent 42%), radial-gradient(circle at 88% 20%, var(--te-playback-backdrop-highlight), transparent 26%)'
      await js('document.querySelector(".backdrop-accent").style.background = ' + JSON.stringify(radial))
      await js('new Promise(resolve => setTimeout(resolve, 150))')
      const rings = await captureNative()
      const ringSpan = span(rings), flatSpan = span(flat)
      console.log('NATIVE_150_PERCENT_LIGHTING', JSON.stringify({ size: flat.image.getSize(), ringSpan, flatSpan }))
      if (visualDir) {
        await writeFile(join(visualDir, 'native-150-radial.png'), rings.image.toPNG())
        await writeFile(join(visualDir, 'native-150-flat.png'), flat.image.toPNG())
      }
      assert.ok(ringSpan.some(value => value > 4), 'the regression control must expose the old radial contours')
      assert.ok(flatSpan.every(value => value < .15), 'uniform art must remain horizontally uniform after the tint and native-pixel dither')
      assert.ok(luminance(flat).mean >= luminance(rings).mean * .95, 'removing rings must not restore the dim background')
      await js('document.querySelector(".backdrop-accent").style.removeProperty("background")')
      win.webContents.debugger.detach()
      await configure({ visualizer: true })
      assert.equal(await js('document.querySelector(".backdrop")'), null)
      console.log('PLAYBACK_BACKDROP_OK')
      app.exit(0)
    } catch (error) { console.error(error.stack); app.exit(1) }
  })`
}
