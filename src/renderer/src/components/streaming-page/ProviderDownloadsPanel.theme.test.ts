import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const panel = readFileSync(new URL('./ProviderDownloadsPanel.vue', import.meta.url), 'utf8')
const baseCss = readFileSync(new URL('../../assets/base.css', import.meta.url), 'utf8')
const panelStyles = Array.from(
  panel.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi),
  (match) => match[1]
).join('\n')

/** Surfaces and text that must carry a dedicated value in each palette. */
const PALETTE_TOKENS = [
  '--te-card-bg',
  '--te-card-border',
  '--te-subtle-bg',
  '--te-hover-bg',
  '--te-settings-text',
  '--te-settings-text-muted',
  '--te-primary-500',
  '--te-neutral-50',
  '--te-glass-shadow',
  '--te-info-soft-bg',
  '--te-info-soft-fg',
  '--te-success-soft-bg',
  '--te-success-soft-fg',
  '--te-danger-soft-bg',
  '--te-danger-soft-fg'
]

function declaredVariables(selectorPattern: RegExp): Set<string> {
  const declared = new Set<string>()
  const cssWithoutComments = baseCss.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const rule of cssWithoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim()
    const sharedRootRoles = selectorPattern.test(':root') && /^:root\s*,\s*:is\(/.test(selector)
    if (!selectorPattern.test(selector) && !sharedRootRoles) continue
    for (const declaration of rule[2].matchAll(/(--te-[a-z0-9-]+)\s*:/gi)) {
      declared.add(declaration[1])
    }
  }
  return declared
}

const lightTokens = declaredVariables(/^:root(,\s*:root\[data-theme='pureWhite'\])?$/)
const darkTokens = declaredVariables(/^:root\[data-theme='dark'\]$/)

test('every theme token the download panel reads is declared in the light palette', () => {
  const referenced = new Set(
    Array.from(panelStyles.matchAll(/var\((--te-[a-z0-9-]+)/gi), (match) => match[1])
  )
  assert.ok(referenced.size > 0, 'expected the panel to consume theme tokens')
  // The shell measures this at runtime; it is geometry rather than a palette token.
  referenced.delete('--te-playbar-bottom-clearance')
  const undeclared = [...referenced].filter((token) => !lightTokens.has(token)).sort()
  assert.deepEqual(
    undeclared,
    [],
    'the panel used to paint itself with tokens that were never declared (--te-panel-bg, --te-muted, --te-border, --te-accent), so every surface silently fell back to a hard-coded dark literal'
  )
})

test('the download panel palette tokens are re-declared for the dark theme', () => {
  const missing = PALETTE_TOKENS.filter((token) => !darkTokens.has(token)).sort()
  assert.deepEqual(missing, [])
})

test('no token is read through a literal fallback that pins one palette', () => {
  // `var(--te-panel-bg, #1e1e2e)` is how the panel used to render a dark card under
  // the light theme's dark body text: the fallback hid the missing token instead of
  // failing loudly.
  assert.doesNotMatch(
    panelStyles,
    /(?:color|background(?:-color)?|border(?:-color)?|box-shadow):[^;]*var\(\s*--te-[a-z0-9-]+\s*,/i
  )
})

test('the panel paints its own text colour instead of inheriting the page colour', () => {
  const panelRule = panelStyles.match(/\.provider-download-panel\s*\{([\s\S]*?)\}/)?.[1]
  assert.equal(typeof panelRule, 'string')
  assert.match(panelRule as string, /background:\s*var\(--te-card-bg\)/)
  assert.match(panelRule as string, /color:\s*var\(--te-settings-text\)/)
  for (const selector of [
    '.provider-download-panel-header h3',
    '.provider-download-title',
    '.provider-download-artist'
  ]) {
    const rule = panelStyles.match(
      new RegExp(`${selector.replace(/[.]/g, '\\.')}\\s*\\{([\\s\\S]*?)\\}`)
    )?.[1]
    assert.match(rule ?? '', /color:\s*var\(--te-settings-/, `${selector} needs an explicit color`)
  }
})

test('the panel does not borrow settings-page-only button classes', () => {
  // SettingsPage.css owns `.soft-button`/`.muted-button`; the teleported panel has to
  // stand on its own scoped styles.
  assert.doesNotMatch(panel, /"(soft-button|muted-button)"/)
})

test('status badges resolve a distinct palette pair for every terminal state', () => {
  for (const status of ['queued', 'preparing', 'downloading', 'completed', 'failed']) {
    assert.match(
      panelStyles,
      new RegExp(`\\.provider-download-badge\\[data-status='${status}'\\]`),
      `missing badge colours for ${status}`
    )
  }
})
