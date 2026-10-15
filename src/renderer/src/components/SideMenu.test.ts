import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sideMenu = readFileSync(new URL('./SideMenu.vue', import.meta.url), 'utf8')
const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const playerBarCss = readFileSync(new URL('./player-bar/PlayerBar.css', import.meta.url), 'utf8')

const streamingCss = readFileSync(
  new URL('./streaming-page/StreamingPage.css', import.meta.url),
  'utf8'
)
const overlayCss = readFileSync(new URL('../assets/overlay-sidebars.css', import.meta.url), 'utf8')

test('overlay navigation owns its panel motion while page transitions keep their timing', () => {
  assert.match(sideMenu, /transition: transform var\(--te-motion-panel\) var\(--te-ease-soft\);/)
  assert.doesNotMatch(sideMenu, /side-menu-item-in/)
  assert.match(sideMenu, /class="side-menu overlay-side-panel"/)
  const overlayRule = overlayCss.match(
    /html body \.app-shell :is\(\.side-menu, \.queue-sidebar\)\.overlay-side-panel\s*\{([^}]*)\}/
  )
  assert.ok(overlayRule, 'navigation and queue must share a viewport overlay surface')
  assert.match(overlayRule[1], /position:\s*fixed;/)
  assert.match(overlayRule[1], /top:\s*var\(--te-window-content-top\);/)
  assert.match(overlayRule[1], /bottom:\s*var\(--te-window-content-bottom\);/)
  assert.match(overlayRule[1], /width:\s*var\(--te-overlay-panel-width\);/)
  assert.match(sideMenu, /\.side-menu\.open\s*\{\s*transform:\s*translate3d\(0, 0, 0\);\s*\}/)
  assert.match(
    overlayCss,
    /\.side-menu\.overlay-side-panel:not\(\.open\)\s*\{[^}]*transform:\s*translate3d\(calc\(-100% - var\(--te-window-surface-inset\)\), 0, 0\)/
  )
  assert.match(app, /opacity 0\.18s ease,\s*transform 0\.24s var\(--te-ease-out-strong\)/)
  assert.match(app, /translate3d\(0, 16px, 0\)/)
  assert.match(app, /opacity 0\.14s ease,\s*transform 0\.18s var\(--te-ease-enter\)/)
  assert.match(app, /translate3d\(0, -12px, 0\)/)
})

/**
 * Navigation slides over a stable content box. Resizing either content surface
 * during a menu toggle would move cards and scrollbars on every animation frame.
 * These base rules are separate from the page enter/leave transitions above.
 */
test('content surfaces retain full width without a menu-clearance animation', () => {
  const surfaces: [name: string, source: string, rule: RegExp][] = [
    ['App.vue .main-content', app, /^\.main-content\s*\{([^}]*)\}/m],
    ['StreamingPage.css .streaming-content', streamingCss, /^\.streaming-content\s*\{([^}]*)\}/m]
  ]
  for (const [name, source, rule] of surfaces) {
    const body = source.match(rule)?.[1]
    assert.ok(body, `${name} must define its stable content geometry`)
    assert.match(body, /width:\s*100%;/, `${name} must keep the full content width`)
    assert.equal(
      body.match(/padding-left:\s*([^;]+);/)?.[1].trim() ?? '0',
      '0',
      `${name} must not reserve an overlay inset`
    )
    assert.doesNotMatch(
      body,
      /transition(?:-property)?:[^;]*(?:padding|margin|left|width|flex-basis|transform)/,
      `${name} must not animate its geometry when navigation slides`
    )
  }
  const openContent = app.match(/^\.main-content\.menu-open\s*\{([^}]*)\}/m)
  assert.ok(openContent, 'local content must declare its open-menu geometry')
  assert.match(openContent[1], /^\s*padding-left:\s*0;\s*$/)
  const customContent = app.match(
    /html\[data-te-shell-layout='custom'\] \.app-shell-content \.main-content,\s*html\[data-te-shell-layout='custom'\] \.app-shell-content \.main-content\.menu-open\s*\{([^}]*)\}/
  )
  assert.ok(customContent, 'custom shells must share content geometry across menu states')
  assert.match(customContent[1], /padding-left:\s*0;/)
})

/**
 * The streaming menu state is a sibling rule. It must retain the same inset as
 * the closed state rather than narrow or translate the scroller behind the overlay.
 */
test('opening streaming navigation leaves its scroller and scrollbar in place', () => {
  function declaredProperties(body: string): string[] {
    return body
      .split(';')
      .map((declaration) => declaration.split(':')[0]?.trim() ?? '')
      .filter(Boolean)
  }

  const rules = [
    ...app.matchAll(/^\.streaming-page\.menu-open \.streaming-content\s*\{([^}]*)\}/gm)
  ]
  assert.ok(rules.length >= 1, 'the streaming open-menu sibling rule must exist')
  for (const [, body] of rules) {
    assert.match(body, /padding-left:\s*0;/)
    const properties = declaredProperties(body)
    assert.deepEqual(
      properties.filter((property) => property !== 'padding-left'),
      [],
      'opening an overlay must not add translation, width or flex-basis changes to the scroller'
    )
  }
  const customContent = app.match(
    /html\[data-te-shell-layout='custom'\] \.streaming-page \.streaming-content\s*\{([^}]*)\}/
  )
  assert.ok(customContent, 'custom streaming shells must retain the same content inset')
  assert.match(customContent[1], /^\s*padding-left:\s*0;\s*$/)
})

/**
 * `will-change` with a transform-like value makes an element a *permanent*
 * containing block for its `position: fixed` descendants. This shell has two that
 * resolve against the viewport by design — the full-height `.hifi-overlay` and the
 * viewport-wide `.player-panel-dismiss` — and containing them collapses both into
 * the bottom strip, which once made the HiFi deck open as a sliver.
 */
test('the playbar shell never promotes itself into a containing block', () => {
  const shellRule = playerBarCss.match(/\n\.player-bar-shell \{([^}]*)\}/)
  assert.ok(shellRule, 'the .player-bar-shell base rule must exist')
  assert.doesNotMatch(shellRule[1], /will-change/)
})
