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
  LIQUID_GLASS_CARD_FILTER_ID,
  LIQUID_GLASS_CARD_SELECTOR,
  LIQUID_GLASS_EXPANDED_CARD_FILTER_ID,
  LIQUID_GLASS_EXPANDED_SURFACE_SELECTOR,
  LIQUID_GLASS_HOME_CARD_FILTER_ID,
  LIQUID_GLASS_PLAYBAR_FILTER_ID
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

test('shared glass is scoped to chrome and dashboard clear glass is hero-only', () => {
  assert.equal(LIQUID_GLASS_CARD_SELECTOR, '.home .feature-card')
  assert.doesNotMatch(
    baseStyle,
    /html\[data-te-surface-material='liquidGlass'\]\s*\n\s*:is\(\s*\n\s*\.artist-card/
  )
  assert.match(
    dashboardStyle,
    /html\[data-te-home-liquid-glass='on'\]\s+\.home\s+\.feature-card\s*\{/
  )
  assert.doesNotMatch(dashboardStyle, /:is\(\s*\.feature-card,\s*\.signal-card/)
})

test('expensive hero observers and pointer tracking stay inactive outside the clear scope', () => {
  assert.match(defs, /props\.active &&\s*props\.homeCardsActive &&/)
  assert.match(defs, /!props\.homeCardsActive && !props\.expandedActive/)
  assert.match(defs, /new IntersectionObserver/)
  assert.match(defs, /rootMargin: '128px 0px'/)
  assert.match(
    defs,
    /props\.expandedActive && surface\.matches\(LIQUID_GLASS_EXPANDED_SURFACE_SELECTOR\)/
  )
})

test('expanded coverage is opt-in and excludes dense rows and nested surfaces', () => {
  assert.equal(
    LIQUID_GLASS_EXPANDED_SURFACE_SELECTOR,
    '.artist-card,.album-card,.playlist-card,.glass-card,.signal-card,.chart-card,.profile-card,.recent-card,.ranking-card'
  )
  assert.match(app, /settings\.value\.liquidGlass\.coverage === 'expanded'/)
  assert.match(app, /:expanded-active="settings\.liquidGlass\.coverage === 'expanded'"/)
  assert.match(baseStyle, /data-te-liquid-glass-coverage='expanded'/)
  assert.doesNotMatch(
    baseStyle,
    /filter: url\(#te-lg-expanded-card\)/,
    'co-locating an feImage chain with backdrop-filter breaks the backdrop pass in Chromium'
  )
  assert.match(baseStyle, /prefers-reduced-transparency: reduce/)
  assert.match(baseStyle, /prefers-contrast: more/)
  assert.match(baseStyle, /forced-colors: active/)
  assert.match(baseStyle, /te-liquid-glass-budget/)
  assert.match(baseStyle, /data-window-transparent='on'\]\[data-platform='win32'/)
  assert.doesNotMatch(baseStyle, /data-te-legacy-content-glass/)
  assert.doesNotMatch(baseStyle, /data-te-liquid-glass-coverage='expanded'[^\n]*.*track-row/)
  assert.doesNotMatch(baseStyle, /data-te-liquid-glass-coverage='expanded'[\s\S]*?\.feature-card/)
  assert.match(liquidGlassSettings, /setLiquidGlassCoverage/)
  assert.match(liquidGlassSettings, /coverage === 'functional'/)
  assert.match(liquidGlassSettings, /coverage === 'expanded'/)
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
  assert.match(app, /:liquid-material="liquidGlassChromeActive"/)
})

test('chrome surfaces retain isolated blur layers and press-origin feedback', () => {
  assert.match(titleBar, /title-bar-liquid/)
  assert.match(titleBar, /function setPressOrigin\(event: PointerEvent\)/)
  assert.match(titleBar, /circle at var\(--te-lg-press-x, 50%\) var\(--te-lg-press-y, 50%\)/)
  assert.match(sideMenu, /side-menu-liquid/)
  assert.match(sideMenu, /function setPressOrigin\(event: PointerEvent\)/)
  assert.match(sideMenu, /backdrop-filter: blur\(20px\) saturate\(128%\)/)
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
  assert.match(baseStyle, /data-te-liquid-glass-source='solid'/)
  assert.match(baseStyle, /--te-lg-context-material/)
  assert.match(playerBarStyle, /data-te-liquid-glass-source='solid'/)
  assert.match(sideMenu, /data-te-liquid-glass-source='solid'/)
})

test('all SVG filters remain defined once and referenced from their intended surfaces', () => {
  for (const id of [
    LIQUID_GLASS_CARD_FILTER_ID,
    LIQUID_GLASS_EXPANDED_CARD_FILTER_ID,
    LIQUID_GLASS_HOME_CARD_FILTER_ID,
    LIQUID_GLASS_PLAYBAR_FILTER_ID
  ]) {
    const constant =
      id === LIQUID_GLASS_CARD_FILTER_ID
        ? 'LIQUID_GLASS_CARD_FILTER_ID'
        : id === LIQUID_GLASS_EXPANDED_CARD_FILTER_ID
          ? 'LIQUID_GLASS_EXPANDED_CARD_FILTER_ID'
          : id === LIQUID_GLASS_HOME_CARD_FILTER_ID
            ? 'LIQUID_GLASS_HOME_CARD_FILTER_ID'
            : 'LIQUID_GLASS_PLAYBAR_FILTER_ID'
    assert.match(defs, new RegExp(`:id="${constant}"`))
  }
  assert.match(defs, /:id="LIQUID_GLASS_EXPANDED_CARD_FILTER_ID"[\s\S]*expandedChannelScales/)
  // Card surfaces keep the glass to backdrop-filter + CSS sheen: an feImage-based
  // `filter: url()` on the same layer makes Chromium abandon the backdrop pass and
  // burns a full filter pass per card per frame.
  assert.doesNotMatch(settingsStyle, /filter: url\(#te-lg-card\)/)
  assert.match(dashboardStyle, /filter: var\(--home-lg-filter\)/)
  assert.match(dashboardStyle, /--home-lg-filter: none/)
  // The playbar warp layer paints only its own gradients, so `filter` would have
  // nothing textured to bend. The chain has to sit in the *backdrop* list, where
  // the compositor hands it the scrolling content behind the bar.
  assert.match(playerBarStyle, /backdrop-filter:[^;]*url\(#te-lg-playbar\)/)
  assert.ok(
    !/(^|[^-])filter: url\(#te-lg-playbar\)/m.test(playerBarStyle),
    'playbar must not reference the chain from `filter`, where it is a visual no-op'
  )
})

test('every filter chain lands the baked highlight after refraction resolves', () => {
  // The highlight is a lerp toward white, so it has to sit on top of the resolved
  // refraction rather than being displaced along with the source.
  const chains = defs.match(/<filter[\s\S]*?<\/filter>/g) ?? []
  assert.equal(chains.length, 4, 'all four shared chains must be present')

  for (const chain of chains) {
    const refracted = chain.indexOf('result="REFRACTED"')
    const specular = chain.indexOf('result="SPECULAR_RAW"')
    assert.ok(refracted >= 0, 'refraction must be a named result')
    assert.ok(specular > refracted, 'the highlight must composite after refraction')
    // The map is a full rectangle; unclipped it fills the rounded corners and the
    // surface reads as square.
    assert.match(
      chain,
      /<feComposite in="SPECULAR" in2="SourceGraphic" operator="in" result="SPECULAR_CLIPPED" \/>/
    )
    assert.match(chain, /<feBlend in="REFRACTED" in2="SPECULAR_CLIPPED" mode="screen" \/>/)
    // Co-registration with the displacement map depends on identical subregion
    // attributes, since both are resolved against the same primitive subregion.
    // `none` rather than `slice`: the rasters are now baked at the surface's own
    // measured size, so any aspect-preserving fit would re-introduce the crop that
    // put the corner arc off the visible corner.
    assert.match(chain, /result="SPECULAR_RAW"\s*\n\s*preserveAspectRatio="none"/)
  }
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
  assert.equal(chains.length, 4)

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

test('a zero-strength highlight drops out of the chain instead of compositing a no-op', () => {
  for (const flag of [
    'cardSpecularActive',
    'expandedSpecularActive',
    'homeSpecularActive',
    'playbarSpecularActive'
  ]) {
    assert.match(defs, new RegExp(`<template v-if="${flag}">`))
    // Both halves matter: zero strength, and an empty URL from a canvas-less context.
    assert.match(defs, new RegExp(`const ${flag} = computed\\(`))
  }
  assert.match(defs, /resolveSpecularMapStrength/)
  // Both rasters are baked from the measured geometry, so the highlight lands on
  // exactly the rim the refraction bends.
  assert.match(defs, /getSpecularMapUrl\(playbar\)/)
  assert.match(defs, /getSpecularMapUrl\(card\)/)
})

test('the expanded and dashboard chains scale the highlight by their own profile', () => {
  const chains = defs.match(/<filter[\s\S]*?<\/filter>/g) ?? []
  const byId = (constant: string): string => {
    const chain = chains.find((candidate) => candidate.includes(`:id="${constant}"`))
    assert.ok(chain, `${constant} chain must exist`)
    return chain
  }

  assert.match(byId('LIQUID_GLASS_CARD_FILTER_ID'), /:slope="specularStrength"/)
  assert.match(byId('LIQUID_GLASS_PLAYBAR_FILTER_ID'), /:slope="specularStrength"/)
  // Broad content panes turn to white plastic long before compact chrome does.
  assert.match(byId('LIQUID_GLASS_EXPANDED_CARD_FILTER_ID'), /:slope="expandedSpecularStrength"/)
  assert.match(byId('LIQUID_GLASS_HOME_CARD_FILTER_ID'), /:slope="homeSpecularStrength"/)
  // The playbar's short axis needs the wide-strip bake, not the square one.
  assert.match(byId('LIQUID_GLASS_PLAYBAR_FILTER_ID'), /:href="playbarSpecularUrl"/)
  assert.match(byId('LIQUID_GLASS_CARD_FILTER_ID'), /:href="cardSpecularUrl"/)
})

test('playbar pointer tracking remains element-local', () => {
  assert.match(playerBar, /@pointermove="onGlassPointerMove"/)
  assert.match(playerBar, /playerBarRef\.value/)
  assert.doesNotMatch(playerBar, /document\.elementFromPoint/)
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
