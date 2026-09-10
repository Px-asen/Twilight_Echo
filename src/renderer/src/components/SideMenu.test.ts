import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sideMenu = readFileSync(new URL('./SideMenu.vue', import.meta.url), 'utf8')
const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const playerBarCss = readFileSync(new URL('./player-bar/PlayerBar.css', import.meta.url), 'utf8')
const providerSidebar = readFileSync(
  new URL('./streaming-page/ProviderSidebar.vue', import.meta.url),
  'utf8'
)
const streamingCss = readFileSync(
  new URL('./streaming-page/StreamingPage.css', import.meta.url),
  'utf8'
)

test('local sidebar opening follows the streaming navigation timing', () => {
  assert.match(
    sideMenu,
    /transform var\(--te-motion-panel\) var\(--te-ease-soft\),\s*box-shadow var\(--te-motion-panel\);/
  )
  assert.doesNotMatch(sideMenu, /side-menu-item-in/)
  assert.match(app, /transition: padding-left var\(--te-motion-panel\) var\(--te-ease-soft\);/)
  assert.match(
    app,
    /transform 0\.48s cubic-bezier\(0\.16, 1, 0\.3, 1\),\s*filter 0\.42s cubic-bezier\(0\.16, 1, 0\.3, 1\)/
  )
  assert.match(app, /translate3d\(0, 40px, 0\) scale\(0\.99\)/)
  assert.match(
    app,
    /transform 0\.3s cubic-bezier\(0\.4, 0, 0\.2, 1\),\s*filter 0\.28s cubic-bezier\(0\.4, 0, 0\.2, 1\)/
  )
  assert.match(app, /translate3d\(0, -40px, 0\) scale\(0\.99\)/)
  assert.match(playerBarCss, /transition: left var\(--te-motion-panel\) var\(--te-ease-soft\);/)
})

/**
 * Every surface that clears the open side menu keeps its right edge pinned to the
 * window and moves only its left one. `transform` cannot express that — it carries
 * both edges — so animating it snapped the right edge inward by the clearance on
 * the first frame and swept it back over the rest, which read as the page flinching
 * on its right side. The clearance property itself has to be the animated one, on
 * all three surfaces, even though each frame costs a layout pass.
 *
 * The 0.32s duration is what pins these to the *clearance* animation specifically;
 * the page-transition transforms in the same files run on their own curves.
 */
test('side-menu clearance animates the inset, never a transform', () => {
  const surfaces: [name: string, source: string, property: 'padding-left' | 'left'][] = [
    ['App.vue .main-content', app, 'padding-left'],
    ['PlayerBar.css .player-bar-shell', playerBarCss, 'left'],
    ['StreamingPage.css .streaming-content', streamingCss, 'padding-left']
  ]
  for (const [name, source, property] of surfaces) {
    assert.match(
      source,
      new RegExp(`transition: ${property} var\\(--te-motion-panel\\) var\\(--te-ease-soft\\);`),
      `${name} must animate ${property} to keep its right edge pinned`
    )
    assert.doesNotMatch(
      source,
      /transition: transform var\(--te-motion-panel\) var\(--te-ease-soft\);/,
      `${name} must not animate transform for the clearance — it moves the right edge too`
    )
  }
})

/**
 * The streaming sidebar's give-way lives in a sibling rule rather than an `.open`
 * class on the content. It used to narrow the box *and* translate it into place,
 * which is the same right-edge sweep in two properties instead of one. Padding
 * leaves the border box — and the scrollbar riding its right edge — where it was.
 */
test('the streaming content gives way by padding, not by narrowing and translating', () => {
  /** Property names only. `var(--te-menu-width)` is a *value* — matching the raw
   *  text for "width" would flag the correct declaration. */
  function declaredProperties(body: string): string[] {
    return body
      .split(';')
      .map((declaration) => declaration.split(':')[0]?.trim() ?? '')
      .filter(Boolean)
  }

  const rules = [...providerSidebar.matchAll(/\.streaming-sidebar\.open \+ [^{]*\{([^}]*)\}/g)]
  assert.ok(rules.length >= 1, 'the streaming give-way sibling rule must exist')
  for (const [, body] of rules) {
    assert.match(body, /padding-left:\s*var\(--te-menu-width\)/)
    const properties = declaredProperties(body)
    assert.deepEqual(
      properties.filter((property) => property !== 'padding-left'),
      [],
      'padding alone clears the sidebar: a translate sweeps the right edge back in, ' +
        'and width/flex-basis drag the scroller’s scrollbar inward with it'
    )
  }
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
