import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import typescript from 'typescript'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

/**
 * The control is positioned from live geometry and themed purely through the
 * cascade, so a stubbed DOM would prove nothing: the scrollbar gutter, the
 * player-bar clamp, the occlusion hit test and the light/dark tokens only exist
 * in a real render. This mounts the shipped runtime and base.css in an actual
 * Electron window and drives it the way a user would.
 */
test('the shared back-to-top control reveals, anchors, retargets and themes in a real window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-scroll-top-'))
  try {
    const controller = await compileController()
    const baseCss = await readFile(new URL('../assets/base.css', import.meta.url), 'utf8')
    const htmlPath = join(directory, 'scroll-top.html')
    const runnerPath = join(directory, 'scroll-top-runner.cjs')
    await writeFile(htmlPath, createFixture(baseCss, controller), 'utf8')
    await writeFile(runnerPath, electronRunnerSource(), 'utf8')

    const electronPath = require('electron') as string
    const { stderr } = await execFileAsync(electronPath, ['--no-sandbox', runnerPath, htmlPath], {
      timeout: 60_000,
      windowsHide: true
    })
    assert.doesNotMatch(stderr, /SCROLL_TOP_FAILED/)
    assert.match(stderr, /SCROLL_TOP_OK/)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

async function compileController(): Promise<string> {
  const scrollbars = await readFile(new URL('./autoHideScrollbars.ts', import.meta.url), 'utf8')
  const policy = await readFile(new URL('./scrollToTopPolicy.ts', import.meta.url), 'utf8')
  const runtime = await readFile(new URL('./scrollToTopButton.ts', import.meta.url), 'utf8')
  const motion = await readFile(new URL('../../../shared/motion.ts', import.meta.url), 'utf8')
  const scrollMotion = (
    await readFile(new URL('../app/scrollMotion.ts', import.meta.url), 'utf8')
  ).replace(/^import[^\n]*\n/, '')
  const inlined = runtime
    .replace(/import\s+\{[\s\S]*?\}\s+from\s+'\.\/scrollToTopPolicy'\s*/, '')
    .replace(/import[^\n]*scrollMotion[^\n]*\n/, '')
  assert.doesNotMatch(inlined, /^import\s/m, 'the fixture must run the runtime without imports')
  const combined = `${motion}\n${scrollMotion}\n${policy}\n${inlined}`.replace(/^export /gm, '')
  const transpiled = typescript.transpileModule(combined, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.None
    }
  })
  assert.deepEqual(transpiled.diagnostics ?? [], [])
  const autoHide = typescript.transpileModule(scrollbars.replace(/^export /gm, ''), {
    compilerOptions: { target: typescript.ScriptTarget.ES2022, module: typescript.ModuleKind.None }
  })
  assert.deepEqual(autoHide.diagnostics ?? [], [])
  return `(()=>{${autoHide.outputText}\nwindow.installAutoHideScrollbars=installAutoHideScrollbars})();\n${transpiled.outputText}\nwindow.installScrollToTopButton = installScrollToTopButton`
}

function electronRunnerSource(): string {
  return `const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const target = process.argv.at(-1)
app.setPath('userData', path.join(__dirname, 'profile'))
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    useContentSize: true,
    // A hidden window's compositor acknowledges scroll commits lazily, so every
    // scrolled frame costs ~600ms there. Mapping it fully transparent and
    // unfocusable keeps the frames real and cheap without anything appearing.
    opacity: 0,
    focusable: false,
    skipTaskbar: true,
    webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false }
  })
  window.showInactive()
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) =>
    console.error('RENDERER', sourceId + ':' + line, message)
  )
  try {
    await window.loadFile(path.resolve(target))
    await window.webContents.executeJavaScript('window.runScrollTopChecks()')
    app.exit(0)
  } catch (error) {
    console.error('SCROLL_TOP_FAILED', error && error.stack ? error.stack : error)
    app.exit(1)
  }
})`
}

function createFixture(baseCss: string, controller: string): string {
  return `<!doctype html>
<html data-te-motion="off">
<head>
<meta charset="utf-8" />
<style>${baseCss}</style>
<style>
  .probe { position: fixed; overflow-y: auto; overflow-x: hidden; background: #dddddd; }
  #page { left: 0; top: 0; width: 52vw; height: 100vh; }
  #panel { left: 54vw; top: 0; width: 20vw; height: 400px; }
  #tiny { left: 76vw; top: 0; width: 18vw; height: 200px; }
  #optout { left: 76vw; top: 220px; width: 18vw; height: 400px; }
  /* A later page rule must not replace the shared Chromium painter. */
  .probe { scrollbar-width: thin; scrollbar-color: purple yellow; }
  .probe::-webkit-scrollbar { width: 6px; }
  #tiny { scrollbar-width: none !important; }
  .filler { height: 5000px; }
  /* Mirrors PlayerBar.css: the shell keeps its box and stays click-through, the
     bar inside it takes the clicks, and auto-hide tucks only the bar away. */
  .player-bar-shell { position: fixed; left: 0; right: 0; bottom: 0; height: 90px; pointer-events: none; }
  .player-bar { width: 100%; height: 100%; background: #bbbbbb; pointer-events: auto; }
  .player-bar-shell[data-te-playbar-hidden='true'] .player-bar {
    transform: translateY(calc(100% + 24px));
    opacity: 0;
    pointer-events: none;
  }
  #cover { position: fixed; inset: 0; z-index: 30000; background: #000000; }
  /* Paints under the control but over the page: the queue-drawer situation. */
  #corner { position: fixed; left: 0; bottom: 90px; width: 52vw; height: 140px; z-index: 40; background: #999999; }
</style>
</head>
<body>
  <script>window.addEventListener('error', (event) => console.error('FIXTURE_ERROR', event.message, event.error && event.error.stack))</script>
  <div id="page" class="probe"><div class="filler"></div></div>
  <div id="panel" class="probe"><div class="filler"></div></div>
  <div id="tiny" class="probe"><div class="filler"></div></div>
  <div id="optout" class="probe" data-te-scroll-top="off"><div class="filler"></div></div>
  <div class="player-bar-shell" data-te-playbar-hidden="false" data-te-playbar-visibility="auto">
    <div class="player-bar"></div>
  </div>
  <script>${controller}</script>
  <script>${fixtureChecks()}</script>
</body></html>`
}

function fixtureChecks(): string {
  return `
const html = document.documentElement
const page = document.getElementById('page')
const panel = document.getElementById('panel')
const tiny = document.getElementById('tiny')
const optout = document.getElementById('optout')
const bar = document.querySelector('.player-bar-shell')

const frames = (count) => new Promise((resolve) => {
  let left = count || 4
  const step = () => { left -= 1; if (left <= 0) resolve(); else requestAnimationFrame(step) }
  requestAnimationFrame(step)
})
const settle = async () => { await frames(4); await new Promise((resolve) => setTimeout(resolve, 0)) }
const control = () => document.querySelector('.te-scroll-top')
const fail = (message) => { throw new Error(message) }
const near = (actual, expected, label) => {
  if (Math.abs(actual - expected) > 1.5) fail(label + ': expected ' + expected + ', got ' + actual)
}
// A click is how the runtime learns the layout may have changed, so it doubles
// as the fixture's way of forcing a geometry and occlusion refresh.
const nudge = async () => {
  document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
}
const shown = () => {
  const element = control()
  if (!element) return false
  const style = getComputedStyle(element)
  return element.dataset.teScrollTopVisible === 'true' &&
    style.visibility === 'visible' &&
    style.opacity === '1' &&
    style.pointerEvents === 'auto'
}
const revealFor = (element) => Math.min(420, Math.max(240, element.clientHeight * 0.5))
const hover = (element) => element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
const gutterOf = (element) => element.getBoundingClientRect().width - element.clientWidth
const showPage = async () => {
  hover(page)
  page.scrollTop = revealFor(page) + 120
  await nudge()
  if (!shown()) fail('the control did not return to the page container')
}

window.runScrollTopChecks = async () => {
  const stopButton = window.installScrollToTopButton()
  const stopScrollbars = window.installAutoHideScrollbars()
  if (control()) fail('the control was created before anything had scrolled')

  const thumbStyle = () => getComputedStyle(page, '::-webkit-scrollbar-thumb')
  const initialWidth = page.clientWidth
  const borderTolerance = Math.min(0.75, 1 / window.devicePixelRatio)
  if (getComputedStyle(page).scrollbarWidth !== 'auto') fail('page rule replaced the custom painter')
  if (getComputedStyle(page).scrollbarColor !== 'auto') fail('standard color replaced the custom painter')
  if (getComputedStyle(page, '::-webkit-scrollbar').width !== '10px') fail('gutter width is inconsistent')
  if (thumbStyle().backgroundColor !== 'rgba(0, 0, 0, 0)') fail('idle thumb is visible')
  if (thumbStyle().borderRadius !== '999px') fail('thumb is not rounded')
  if (getComputedStyle(tiny).scrollbarWidth !== 'none') fail('permanently hidden surface lost its opt-out')
  for (const tone of ['dark', 'pureWhite']) {
    html.dataset.theme = tone
    page.dispatchEvent(new Event('scroll'))
    await settle()
    if (thumbStyle().backgroundColor === 'rgba(0, 0, 0, 0)') fail('scrolling thumb is hidden in ' + tone)
    if (Math.abs(parseFloat(thumbStyle().borderLeftWidth) - 3) > borderTolerance) fail('scrolling thumb is not 4px wide')
    const rect = page.getBoundingClientRect()
    page.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: rect.right - 4, clientY: rect.top + 100
    }))
    await settle()
    if (Math.abs(parseFloat(thumbStyle().borderLeftWidth) - 2) > borderTolerance) fail('edge target did not reveal the 6px thumb')
    if (page.clientWidth !== initialWidth) fail('revealing the scrollbar shifted page content')
    hover(page)
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    if (thumbStyle().backgroundColor !== 'rgba(0, 0, 0, 0)') fail('idle thumb did not hide in ' + tone)
  }
  delete html.dataset.theme

  page.scrollTop = revealFor(page) - 40
  await settle()
  if (control()) fail('the control was injected before the reveal distance')

  page.scrollTop = revealFor(page) + 40
  await settle()
  if (!shown()) fail('the control did not appear past the reveal distance')

  let element = control()
  if (element.getAttribute('aria-label') !== '回到开头') fail('label was ' + element.getAttribute('aria-label'))
  if (!element.querySelector('i.ph.ph-arrow-up')) fail('the arrow glyph is missing')

  let box = element.getBoundingClientRect()
  const pageBox = page.getBoundingClientRect()
  const barBox = bar.getBoundingClientRect()
  near(box.width, 40, 'control width')
  near(box.height, 40, 'control height')
  near(box.right, pageBox.right - gutterOf(page) - 16, 'right edge clears the scrollbar gutter')
  near(box.bottom, barBox.top - 16, 'bottom edge clears the player bar')
  const hit = document.elementFromPoint(Math.round(box.left + 20), Math.round(box.top + 20))
  if (!hit || !(hit === element || element.contains(hit))) fail('the control is not clickable at its anchor')

  // Re-probing an anchor the control already occupies must see through itself,
  // or every click in the app would blink it off and on again.
  await nudge()
  if (!shown()) fail('the control hid itself when its own anchor was re-probed')
  near(control().getBoundingClientRect().bottom, barBox.top - 16, 'bottom edge after a re-probe')

  const lightColor = getComputedStyle(element).color
  const lightSurface = getComputedStyle(element).backgroundColor
  if (!/^rgb\\(37, 99, 235\\)$/.test(lightColor)) fail('light icon color was ' + lightColor)
  if (!/^rgba\\(255, 255, 255/.test(lightSurface)) fail('light surface was ' + lightSurface)
  html.dataset.theme = 'dark'
  await frames(2)
  const darkColor = getComputedStyle(element).color
  const darkSurface = getComputedStyle(element).backgroundColor
  if (!/^rgb\\(96, 165, 250\\)$/.test(darkColor)) fail('dark icon color was ' + darkColor)
  if (!/^rgba\\(28, 28, 31/.test(darkSurface)) fail('dark surface was ' + darkSurface)
  if (darkSurface === lightSurface) fail('the surface did not change between tones')
  delete html.dataset.theme
  await frames(2)
  if (getComputedStyle(element).color !== lightColor) fail('the light tone did not restore')

  // Pointing at another container hands the control over to it.
  panel.scrollTop = 0
  hover(panel)
  await settle()
  if (shown()) fail('the control stayed visible over an unscrolled panel')
  panel.scrollTop = revealFor(panel) + 60
  await settle()
  if (!shown()) fail('the control did not follow the pointer to the scrolled panel')
  box = control().getBoundingClientRect()
  const panelBox = panel.getBoundingClientRect()
  near(box.right, panelBox.right - gutterOf(panel) - 16, 'panel right edge')
  near(box.bottom, panelBox.bottom - 16, 'panel bottom edge')

  // Popovers shorter than the minimum never host it, and opted-out subtrees
  // suppress it even while they scroll.
  await showPage()
  hover(tiny)
  tiny.scrollTop = 400
  await settle()
  if (shown()) fail('a 200px container was given the control')
  await showPage()
  optout.scrollTop = 400
  await settle()
  if (shown()) fail('an opted-out container was given the control')

  // A tucked-away player bar must not keep reserving the bottom strip.
  await showPage()
  bar.dataset.tePlaybarHidden = 'true'
  await nudge()
  near(control().getBoundingClientRect().bottom, pageBox.bottom - 16, 'bottom edge with the bar hidden')
  bar.dataset.tePlaybarHidden = 'false'
  await nudge()
  near(control().getBoundingClientRect().bottom, barBox.top - 16, 'bottom edge with the bar back')

  // A container left scrolled under an overlay must not keep a floating control.
  const cover = document.createElement('div')
  cover.id = 'cover'
  document.body.append(cover)
  await nudge()
  if (shown()) fail('the control stayed visible while its container was covered')
  cover.remove()
  await nudge()
  if (!shown()) fail('the control did not return once the container was uncovered')

  // A drawer that only takes the corner — the playback queue sits exactly there
  // — still covers the anchor, so the control must give that corner up.
  const corner = document.createElement('div')
  corner.id = 'corner'
  document.body.append(corner)
  await nudge()
  if (shown()) fail('the control floated on top of a panel occupying its corner')
  corner.remove()
  await nudge()
  if (!shown()) fail('the control did not return once the corner was free')

  element = control()
  element.click()
  await settle()
  if (page.scrollTop !== 0) fail('the click left the container at ' + page.scrollTop)
  if (shown()) fail('the control stayed visible at the top of the container')

  // CSS smooth must not override reduced/off or explicit smooth requests.
  page.style.scrollBehavior = 'smooth'
  for (const mode of ['reduced', 'off']) {
    html.dataset.teMotion = mode
    page.scrollTo({ top: 1800, behavior: 'instant' })
    hover(page)
    await nudge()
    control().click()
    if (page.scrollTop !== 0) fail(mode + ' did not scroll instantly through CSS smooth')
    if (scrollMotionBehavior('smooth') !== 'instant') fail(mode + ' allowed an explicit smooth override')
  }
  html.dataset.teMotion = 'full'
  if (scrollMotionBehavior('smooth', true) !== 'instant') fail('keyboard navigation was animated')
  page.scrollTo({ top: 1800, behavior: 'instant' })
  hover(page)
  await nudge()
  // Windows runners can disable compositor scroll animations independently of
  // the app preference. Observe the requested behavior while still delegating
  // to the real DOM scroll and checking that it reaches the target.
  const nativeScrollTo = page.scrollTo.bind(page)
  let scrollRequest
  page.scrollTo = (options) => { scrollRequest = options; nativeScrollTo(options) }
  control().click()
  if (scrollRequest?.behavior !== 'smooth' || scrollRequest.top !== 0) fail('full mode lost smooth scrolling')
  const scrollDeadline = performance.now() + 2000
  while (page.scrollTop !== 0 && performance.now() < scrollDeadline) await frames(1)
  if (page.scrollTop !== 0) fail('full mode did not reach the top: ' + page.scrollTop)
  page.scrollTo = nativeScrollTo
  page.style.scrollBehavior = 'auto'

  html.dataset.teMotion = 'full'
  await frames(2)
  const motionStyle = getComputedStyle(element)
  if (!/opacity/.test(motionStyle.transitionProperty)) fail('opacity is not animated: ' + motionStyle.transitionProperty)
  if (!/[1-9]/.test(motionStyle.transitionDuration)) fail('the reveal has no duration: ' + motionStyle.transitionDuration)

  html.dataset.teMotion = 'off'
  await showPage()
  if (!page.classList.contains('is-scrollbar-active')) fail('scrolling did not reveal its thumb')
  // Model visibility synchronously here so pending frames cannot race the assertion.
  // The native hide/show lifecycle is covered by the streaming wheel fixture.
  const hidden = Object.getOwnPropertyDescriptor(document, 'hidden')
  const nativeFrame = window.requestAnimationFrame
  let requestedFrames = 0
  window.requestAnimationFrame = (callback) => { requestedFrames++; return nativeFrame.call(window, callback) }
  hover(page)
  Object.defineProperty(document, 'hidden', { configurable: true, value: true })
  document.dispatchEvent(new Event('visibilitychange'))
  const beforeHiddenEvents = requestedFrames
  hover(page)
  page.dispatchEvent(new Event('scroll'))
  document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  if (requestedFrames !== beforeHiddenEvents) fail('hidden scrolling scheduled new frames')
  if (control().dataset.teScrollTopVisible !== 'false') fail('hidden document retained its back-to-top control')
  if (page.classList.contains('is-scrollbar-active')) fail('hidden document retained its active thumb')
  if (hidden) Object.defineProperty(document, 'hidden', hidden)
  else delete document.hidden
  window.requestAnimationFrame = nativeFrame
  document.dispatchEvent(new Event('visibilitychange'))
  await frames(2)
  if (!shown()) fail('visible document did not restore the active back-to-top anchor')
  stopButton(); stopScrollbars()
  if (control()) fail('cleanup retained the back-to-top control')
  hover(page); page.dispatchEvent(new Event('scroll'))
  await frames(2)
  if (control() || page.classList.contains('is-scrollbar-active')) fail('disposed handlers still responded to scrolling')
  console.log('SCROLL_TOP_OK')
}
`
}
