import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { compileStyle } from '@vue/compiler-sfc'
import {
  LIQUID_GLASS_PLAYBAR_FILTER_ID,
  functionalLiquidGlassSettings,
  DEFAULT_LIQUID_GLASS
} from '../../../shared/liquidGlass.ts'

const baseStyle = readFileSync(new URL('../assets/base.css', import.meta.url), 'utf8')
const defs = readFileSync(new URL('./LiquidGlassDefs.vue', import.meta.url), 'utf8')
const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const dashboardStyle = readFileSync(new URL('./LocalDashboard.css', import.meta.url), 'utf8')
const themeStore = readFileSync(new URL('../stores/useThemeStore.ts', import.meta.url), 'utf8')
const playerBarStyle = readFileSync(new URL('./player-bar/PlayerBar.css', import.meta.url), 'utf8')
const playerBar = readFileSync(new URL('./PlayerBar.vue', import.meta.url), 'utf8')
const settingsStyle = readFileSync(
  new URL('./settings-page/SettingsPage.css', import.meta.url),
  'utf8'
)
const liquidGlassSettings = readFileSync(
  new URL('./settings-page/LiquidGlassSettings.vue', import.meta.url),
  'utf8'
)
const settingsPage = readFileSync(new URL('./SettingsPage.vue', import.meta.url), 'utf8')
const sideMenu = readFileSync(new URL('./SideMenu.vue', import.meta.url), 'utf8')
const titleBar = readFileSync(new URL('./TitleBar.vue', import.meta.url), 'utf8')

test('legacy content glass settings resolve to functional chrome without mutating saved profiles', () => {
  const saved = {
    ...DEFAULT_LIQUID_GLASS,
    coverage: 'expanded' as const,
    homeCards: { ...DEFAULT_LIQUID_GLASS.homeCards, enabled: true }
  }
  const runtime = functionalLiquidGlassSettings(saved)
  assert.equal(runtime.coverage, 'functional')
  assert.equal(runtime.homeCards.enabled, false)
  assert.equal(saved.coverage, 'expanded')
  assert.equal(saved.homeCards.enabled, true)
  assert.equal(runtime.homeCards.light, saved.homeCards.light)
  assert.match(themeStore, /liquidGlass = functionalLiquidGlassSettings/)
})

test('content surfaces no longer register optical filters or geometry/pointer observers', () => {
  assert.doesNotMatch(
    defs,
    /cardMapUrl|cardSpecularUrl|IntersectionObserver|pointermove|homeCardsActive|expandedActive/
  )
  assert.doesNotMatch(dashboardStyle, /data-te-home-liquid-glass|--home-lg-filter/)
  assert.doesNotMatch(baseStyle, /data-te-liquid-glass-coverage='expanded'/)
  assert.doesNotMatch(liquidGlassSettings, /扩展实验|首页媒体焦点液态玻璃|setLiquidGlassCoverage/)
  assert.match(liquidGlassSettings, /内容卡片使用普通材质/)
  assert.match(app, /:active="playbarRefractionActive"/)
  assert.match(defs, /doc.querySelector\('\.app-shell-player'\)/)
  assert.match(defs, /props.targetDocument \?\? document/)
})

test('every theme runtime return path emits all chrome material targets', () => {
  for (const attribute of [
    'data-te-navigation-liquid-glass',
    'data-te-playbar-liquid-glass',
    'data-te-settings-navigation-liquid-glass',
    'data-te-home-liquid-glass',
    'data-te-liquid-glass-coverage'
  ]) {
    assert.equal(
      (themeStore.match(new RegExp(`'${attribute}':`, 'g')) ?? []).length,
      2,
      `${attribute} must be emitted on both return paths`
    )
  }
  assert.match(themeStore, /liquidGlass\.navigationEnabled/)
})

test('app shell uses regular material for navigation and samples only its active page', () => {
  assert.match(app, /useLiquidGlassEnvironment/)
  assert.match(app, /liquidGlassBackgroundPage = computed<AppBackgroundPage>/)
  assert.match(app, /:liquid-material="liquidGlassChromeActive"/)
})

test('chrome surfaces retain isolated blur layers and press-origin feedback', () => {
  assert.match(titleBar, /title-bar-liquid/)
  assert.match(titleBar, /function setPressOrigin\(event: PointerEvent\)/)
  assert.match(titleBar, /circle at var\(--te-lg-press-x, 50%\) var\(--te-lg-press-y, 50%\)/)
  assert.match(sideMenu, /side-menu-liquid/)
  assert.match(sideMenu, /function setPressOrigin\(event: PointerEvent\)/)
  assert.match(
    sideMenu,
    /backdrop-filter: blur\(var\(--te-chrome-frosted-blur, 24px\)\)\s*saturate\(var\(--te-chrome-frosted-saturation, 124%\)\)/
  )
  assert.match(settingsPage, /function setNavigationPressOrigin\(event: PointerEvent\)/)
  assert.match(settingsStyle, /circle at var\(--te-lg-press-x, 50%\) var\(--te-lg-press-y, 50%\)/)
  assert.match(playerBar, /function setGlassPressOrigin\(event: PointerEvent\)/)
  assert.match(playerBarStyle, /--te-lg-press-color/)
  assert.match(titleBar, /aria-label="关闭窗口"/)
})

test('all chrome recipes consume bounded context variables and preserve reduced-effect fallbacks', () => {
  for (const source of [titleBar, sideMenu, settingsStyle, playerBarStyle]) {
    assert.match(source, /--te-lg-context-(?:rgb|surface|label|rim|shadow)/)
    assert.match(source, /prefers-reduced-transparency/)
    assert.match(source, /forced-colors: active/)
  }
  assert.match(settingsStyle, /data-te-liquid-glass-scrolled='on'/)
  assert.match(playerBarStyle, /body\.te-no-blur .player-bar-liquid .player-bar-warp/)
  assert.match(titleBar, /--te-lg-context-material/)
  assert.match(playerBarStyle, /data-te-liquid-glass-source='solid'/)
  assert.match(sideMenu, /background: var\(--te-lg-context-surface-solid/)
})

test('the one optical filter remains on the playback backdrop rather than foreground content', () => {
  assert.equal((defs.match(/<filter\b/g) ?? []).length, 1)
  assert.match(defs, /:id="LIQUID_GLASS_PLAYBAR_FILTER_ID"/)
  assert.match(
    playerBarStyle,
    new RegExp(`backdrop-filter:[^;]*url\\(#${LIQUID_GLASS_PLAYBAR_FILTER_ID}\\)`)
  )
  assert.doesNotMatch(playerBarStyle, /(?:^|[^-])filter: url\(#te-lg-playbar\)/m)
  assert.doesNotMatch(
    dashboardStyle + baseStyle + settingsStyle,
    /url\(#te-lg-(?:card|home-card|expanded-card)\)/
  )
})

test('playback controls use transmission without specular composites', () => {
  assert.doesNotMatch(defs, /SPECULAR|getSpecularMapUrl|feComposite/)
  assert.match(defs, /getDisplacementMapUrl\(geometry, glassRasterDensity/)
})

test('no chain masks refraction against an feImage-derived alpha', () => {
  // Chromium silently yields an empty result for `feComposite operator="in"` whose
  // `in2` traces back to an `feImage`, when the filter runs on the *backdrop* path.
  // It then abandons the whole `backdrop-filter` and paints the raw backdrop, so
  // the blur disappears too — the surface reads as plain unfiltered content. That
  // is exactly the failure these chains shipped with: covers behind the playbar
  // stayed pin-sharp.
  //
  // Masking here was redundant anyway. The displacement map's offset already
  // decays to zero by `radius` depth, so the middle of a surface is optically
  // clear without any composite gymnastics.
  //
  // `in2="SourceGraphic"` is a different case and is fine — verified by pixel
  // probe — which is why the specular clip is still allowed.
  const chains = defs.match(/<filter[\s\S]*?<\/filter>/g) ?? []
  assert.equal(chains.length, 1)

  for (const chain of chains) {
    assert.doesNotMatch(
      chain,
      /EDGE_MASK|EDGE_INTENSITY|INVERTED_MASK|CENTER_CLEAN/,
      'the map-derived edge mask makes the whole backdrop-filter a no-op'
    )
    for (const composite of chain.match(/<feComposite[\s\S]*?\/>/g) ?? []) {
      const in2 = /in2="([^"]+)"/.exec(composite)?.[1]
      assert.equal(
        in2,
        'SourceGraphic',
        `feComposite in2="${in2}" derives from the map and empties the chain on the backdrop path`
      )
    }
  }
})

test('playbar pointer tracking remains element-local', () => {
  assert.match(playerBar, /@pointermove="onGlassPointerMove"/)
  assert.match(playerBar, /playerBarRef\.value/)
  assert.doesNotMatch(playerBar, /document\.elementFromPoint/)
  assert.match(playerBar, /props.previewAppearance\?\.surfaceMaterial \?\? effectiveSurfaceMaterial\.value/)
  assert.match(playerBar, /effectiveLiquidGlass\.value\.followPointer/)
  assert.doesNotMatch(playerBar, /settings\.value\.(surfaceMaterial|liquidGlass)/)
})

test('Linux playbar accessibility preferences override the backdrop fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'te-playbar-accessibility-'))
  const require = createRequire(import.meta.url)
  try {
    const css = compileStyle({
      source: playerBarStyle,
      filename: 'PlayerBar.css',
      id: 'data-v-accessibility',
      scoped: true
    }).code
    const html = join(directory, 'fixture.html')
    const runner = join(directory, 'runner.cjs')
    await writeFile(
      html,
      `<html data-platform="linux"><head><style>${css}</style></head><body>
      <div class="player-bar-liquid" data-v-accessibility>
      <span class="player-bar-warp" data-v-accessibility></span>
      </div></body></html>`
    )
    await writeFile(
      runner,
      `const { app, BrowserWindow } = require('electron');
      const assert = require('node:assert/strict');
      app.whenReady().then(async () => {
        const win = new BrowserWindow({ show: false });
        try {
          await win.loadFile(process.argv.at(-1));
          win.webContents.debugger.attach('1.3');
          const readStyle = () => win.webContents.executeJavaScript(
            'getComputedStyle(document.querySelector(".player-bar-warp")).backdropFilter'
          );
          assert.match(await readStyle(), /blur\\(/);
          for (const [name, value] of [
            ['prefers-contrast', 'more'],
            ['prefers-reduced-transparency', 'reduce'],
            ['forced-colors', 'active']
          ]) {
            await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
              features: [{ name, value }]
            });
            assert.equal(await win.webContents.executeJavaScript(
              'matchMedia("(' + name + ': ' + value + ')").matches'
            ), true, name + ': preference must be active');
            assert.equal(await readStyle(), 'none', name + ': backdrop must be disabled');
          }
          console.error('PLAYBAR_ACCESSIBILITY_OK'); app.exit(0);
        } catch (error) { console.error(error); app.exit(1); }
      });`
    )
    const { stderr } = await promisify(execFile)(
      require('electron') as string,
      ['--no-sandbox', runner, html],
      { windowsHide: true, timeout: 30000 }
    )
    assert.match(stderr, /PLAYBAR_ACCESSIBILITY_OK/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('playbar regions keep their columns when a theme inserts decorative grid content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'te-playbar-grid-'))
  const require = createRequire(import.meta.url)
  try {
    const css = compileStyle({
      source: playerBarStyle,
      filename: 'PlayerBar.css',
      id: 'data-v-grid',
      scoped: true
    }).code
    const html = join(directory, 'fixture.html')
    const runner = join(directory, 'runner.cjs')
    await writeFile(
      html,
      `<html><head><style>${css}
      .player-bar::before { content: ''; }
      </style></head><body><div class="player-bar-shell" data-v-grid>
      <div class="player-bar player-bar-liquid" data-v-grid>
      <span class="player-bar-warp" data-v-grid></span>
      <div class="player-left" data-v-grid>Song</div>
      <div class="player-center" data-v-grid>Playback</div>
      <div class="player-right" data-v-grid>Queue</div>
      </div></div><script>
      window.check = () => {
        const shell = document.querySelector('.player-bar-shell');
        const bar = document.querySelector('.player-bar');
        for (const mode of ['standard', 'mini', 'compact']) {
          shell.dataset.tePlaybarMode = mode;
          bar.className = 'player-bar ' + (mode === 'standard' ? 'player-bar-liquid' : 'player-bar-' + mode);
          for (const menu of [false, true]) {
            shell.classList.toggle('menu-open', menu);
            shell.style.setProperty('--te-menu-width', '200px');
            const regions = ['left','center','right'].map(name => bar.querySelector('.player-' + name));
            const rects = regions.map(node => node.getBoundingClientRect());
            if (!(rects[0].x < rects[1].x && rects[1].x < rects[2].x)) throw Error(mode + ': columns shifted');
            for (const [index, node] of regions.entries()) {
              const style = getComputedStyle(node);
              if (style.gridRowStart !== '1' || style.gridColumnStart !== String(index + 1)) throw Error(mode + ': implicit grid placement');
              const rect = node.getBoundingClientRect(), parent = bar.getBoundingClientRect();
              if (rect.top < parent.top || rect.bottom > parent.bottom + 1) throw Error(mode + ': region outside bar');
            }
          }
        }
        return true;
      };
      </script></body></html>`
    )
    await writeFile(
      runner,
      `const { app, BrowserWindow } = require('electron');
      app.whenReady().then(async () => {
        const win = new BrowserWindow({ show: false, width: 1399, height: 814 });
        try {
          await win.loadFile(process.argv.at(-1));
          for (const width of [1399, 1100, 900]) {
            win.setContentSize(width, 814);
            const result = await win.webContents.executeJavaScript('(() => { try { return window.check() } catch (e) { return e.message } })()');
            if (result !== true) throw Error(result);
          }
          console.error('PLAYBAR_GRID_OK'); app.exit(0);
        } catch (error) { console.error(error); app.exit(1); }
      });`
    )
    const { stderr } = await promisify(execFile)(
      require('electron') as string,
      ['--no-sandbox', runner, html],
      { windowsHide: true, timeout: 30000 }
    )
    assert.match(stderr, /PLAYBAR_GRID_OK/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('browser press states preserve glass panel geometry and keyboard feedback', async () => {
  assert.doesNotMatch(defs + playerBar, /LiquidGlassPressController|tickGlassPress|tickPress/)
  const directory = await mkdtemp(join(tmpdir(), 'te-press-feedback-'))
  const require = createRequire(import.meta.url)
  try {
    const css = [playerBarStyle, dashboardStyle]
      .map(
        (source) =>
          compileStyle({ source, filename: 'press.css', id: 'data-v-press', scoped: true }).code
      )
      .join('\n')
    const html = join(directory, 'fixture.html')
    const runner = join(directory, 'runner.cjs')
    await writeFile(
      html,
      `<html data-te-motion="full" data-te-liquid-glass-coverage="expanded"
      data-te-home-liquid-glass="on" data-platform="win32"><style>${baseStyle}\n${css}
      .fixture { position: relative; margin: 20px; width: 600px; height: 100px; }
      button { width: 100px; height: 40px; }
      .positioned { transform: translateX(40px); transition: color 100ms; }
      </style><body><div class="home" data-v-press>
      <div id="hero-panel" class="feature-card fixture" data-v-press data-te-interactive><button id="hero">Hero</button></div>
      </div><div id="card-panel" class="album-card fixture" data-v-press data-te-interactive><button id="card">Album</button></div>
      <div id="player-panel" class="player-bar-liquid fixture" data-v-press><button id="player">Play</button></div>
      <button id="positioned" class="positioned">Positioned</button>
      <button id="disabled" disabled>Disabled</button><button id="aria-disabled" aria-disabled="true">Disabled</button>
      </body></html>`
    )
    await writeFile(
      runner,
      `const { app, BrowserWindow } = require('electron');
      const assert = require('node:assert/strict');
      app.whenReady().then(async () => {
        const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { offscreen: true, backgroundThrottling: false } });
        try {
          await win.loadFile(process.argv.at(-1));
          const run = code => win.webContents.executeJavaScript(code);
          const settle = () => run('new Promise(resolve => {document.getAnimations().filter(animation => animation instanceof CSSTransition).forEach(animation => animation.finish());requestAnimationFrame(() => requestAnimationFrame(resolve))})');
          win.webContents.debugger.attach('1.3');
          const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument');
          await win.webContents.debugger.sendCommand('CSS.enable');
          const force = async (selector, forcedPseudoClasses) => {
            const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId:root.nodeId, selector });
            await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses });
          };
          const snapshot = id => run('(() => { const el = document.getElementById(' + JSON.stringify(id) + '); const r = el.getBoundingClientRect(), p = el.parentElement.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, parent:[p.x,p.y,p.width,p.height], opacity:getComputedStyle(el).opacity, parentOpacity:getComputedStyle(el.parentElement).opacity }; })()');
          for (const mode of ['full', 'reduced', 'off']) {
            await run('document.documentElement.dataset.teMotion = ' + JSON.stringify(mode));
            await settle();
            for (const id of ['hero', 'card', 'player', 'positioned', 'disabled', 'aria-disabled']) {
              const before = await snapshot(id);
              await force('#' + id, ['active']);
              if (['hero','card','player'].includes(id)) await force('#' + id + '-panel', ['active']);
              await settle();
              const down = await snapshot(id);
              assert.deepEqual(down.parent, before.parent, mode + '/' + id + ': panel must stay fixed');
              for (const key of ['x','y','width','height','parentOpacity']) assert.equal(down[key], before[key], mode + '/' + id + '/' + key);
              if (id.includes('disabled')) assert.equal(down.opacity, before.opacity, 'disabled feedback is stable');
              else { assert.ok(Number(down.opacity) < Number(before.opacity), 'pressed control is visible'); }
              await force('#' + id, []);
              if (['hero','card','player'].includes(id)) await force('#' + id + '-panel', []);
              await settle();
              const after = await snapshot(id);
              assert.deepEqual(after, before, mode + '/' + id + ': release restores baseline');
            }
          }
          await force('#positioned', ['focus-visible']);
          assert.equal(await run('getComputedStyle(document.getElementById("positioned")).outlineStyle'), 'solid');
          console.error('PRESS_FEEDBACK_OK'); app.exit(0);
        } catch (error) { console.error(error); app.exit(1); }
      });`
    )
    const { stderr } = await promisify(execFile)(
      require('electron') as string,
      ['--no-sandbox', runner, html],
      { windowsHide: true, timeout: 30000 }
    )
    assert.match(stderr, /PRESS_FEEDBACK_OK/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
