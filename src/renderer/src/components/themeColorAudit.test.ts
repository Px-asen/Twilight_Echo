import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { THEME_TOKEN_DEFINITIONS } from '../../../shared/themeTokens.ts'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const rendererRoot = join(repositoryRoot, 'src', 'renderer', 'src')
interface FrozenColorAllowance {
  maxCount: number
  kind: 'debt' | 'migration'
  previousMaxCount: number
  sourceCommits: string[]
  reason: string
  fingerprint: Record<string, number>
}

type ColorAllowance = number | FrozenColorAllowance

interface ColorBaseline {
  version: number
  baselineCommit: string
  previousMax: number
  migrations: Array<{
    commit: string
    from: string
    to: string
    sourceMaxBefore: number
    sourceLiteralsBefore: number
    sourceLiteralsAfter: number
    transferred: number
  }>
  files: Record<string, ColorAllowance>
}

const baseline = JSON.parse(
  readFileSync(new URL('./theme-color-allowlist.json', import.meta.url), 'utf8')
) as ColorBaseline
const colorLiteral = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi

/** Functions whose arguments must each resolve to a single colour. */
const COLOR_FUNCTIONS = new Set([
  'color',
  'color-mix',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'rgb',
  'rgba'
])

/**
 * Tokens whose *value* is a gradient or a shadow — several layers or lengths,
 * never a single colour. Derived from the values rather than the `kind` label so
 * a mislabelled token still gets caught.
 */
const NON_COLOR_TOKENS = new Set<string>(
  THEME_TOKEN_DEFINITIONS.filter(
    (definition) =>
      definition.kind === 'shadow' ||
      [definition.defaults.pureWhite, definition.defaults.dark].some((value) =>
        value.includes('gradient(')
      )
  ).map((definition) => definition.cssVariable)
)

/**
 * A gradient cannot stand in for a colour. Feeding one to `color-mix()` — or to
 * another gradient's colour stop — makes the whole declaration invalid at
 * computed-value time, and Chromium then drops *every* layer of that property,
 * so the element paints nothing at all rather than degrading. That is silent:
 * the stylesheet parses, the rule is present in devtools, and the box is simply
 * empty. `.live-preview` in LyricsAppearanceCustomizer.vue shipped that way,
 * with `--te-playback-fluid-bg` used as a `linear-gradient` stop.
 */
test('gradient-valued and shadow-valued tokens are never used where a color is required', () => {
  const misuses: string[] = []
  for (const [file, styles] of collectStyleSources(rendererRoot)) {
    for (const misuse of nonColorTokenMisuses(styles)) misuses.push(`${file}: ${misuse}`)
  }

  assert.deepEqual(misuses, [])
})

/**
 * Reports each place a `NON_COLOR_TOKENS` member sits inside a function that
 * requires a colour. Tracks the enclosing call stack rather than matching a
 * regex against one declaration, so nesting several levels deep still counts.
 */
function nonColorTokenMisuses(styles: string): string[] {
  const misuses: string[] = []
  const callStack: string[] = []
  for (let index = 0; index < styles.length; index += 1) {
    if (styles[index] === ')') {
      callStack.pop()
      continue
    }
    if (styles[index] !== '(') continue
    let start = index
    while (start > 0 && /[\w-]/.test(styles[start - 1])) start -= 1
    const name = styles.slice(start, index).toLowerCase()
    if (name === 'var') {
      const token = /^\s*(--[\w-]+)/.exec(styles.slice(index + 1))?.[1]
      if (token && NON_COLOR_TOKENS.has(token)) {
        const context = enclosingColorContext(callStack)
        if (context) misuses.push(`var(${token}) inside ${context}()`)
      }
    }
    callStack.push(name)
  }
  return misuses
}

function enclosingColorContext(callStack: readonly string[]): string | null {
  for (let index = callStack.length - 1; index >= 0; index -= 1) {
    const name = callStack[index]
    if (COLOR_FUNCTIONS.has(name) || name.endsWith('gradient')) return name
  }
  return null
}

test('renderer business styles do not exceed the hard-coded color baseline', () => {
  const styles = collectStyleSources(rendererRoot).filter(
    ([file]) => file !== 'src/renderer/src/assets/base.css'
  )
  assert.deepEqual(colorRegressions(styles, baseline.files), [])
})

test('color debt has exact fingerprints and provenance, and extracted CSS consumes its old budget', () => {
  assert.equal(baseline.version, 2)
  assert.match(baseline.baselineCommit, /^[a-f\d]{40}$/)
  let total = 0
  for (const [file, allowance] of Object.entries(baseline.files)) {
    const maximum = maxColorCount(allowance)
    assert.ok(Number.isInteger(maximum) && maximum >= 0, `${file}: invalid budget`)
    total += maximum
    if (typeof allowance === 'number') continue
    assert.ok(['debt', 'migration'].includes(allowance.kind), `${file}: missing classification`)
    assert.ok(
      Number.isInteger(allowance.previousMaxCount) && allowance.previousMaxCount >= 0,
      `${file}: invalid prior budget`
    )
    assert.ok(allowance.reason.length >= 40, `${file}: explain the retained colors`)
    assert.ok(allowance.sourceCommits.length > 0, `${file}: missing source commit`)
    for (const commit of allowance.sourceCommits) assert.match(commit, /^[a-f\d]{40}$/)
    for (const [literal, count] of Object.entries(allowance.fingerprint)) {
      assert.deepEqual(colorLiterals(literal), [literal], `${file}: invalid fingerprint color`)
      assert.ok(Number.isInteger(count) && count > 0, `${file}: invalid fingerprint count`)
    }
    assert.equal(
      Object.values(allowance.fingerprint).reduce((sum, count) => sum + count, 0),
      maximum,
      `${file}: no unassigned room in frozen debt`
    )
  }
  assert.ok(total < baseline.previousMax, 'retire unused budgets instead of growing the baseline')
  for (const migration of baseline.migrations) {
    assert.match(migration.commit, /^[a-f\d]{40}$/)
    assert.equal(
      migration.sourceLiteralsBefore - migration.sourceLiteralsAfter,
      migration.transferred
    )
    assert.ok(maxColorCount(baseline.files[migration.from]) <= migration.sourceLiteralsAfter)
    const target = baseline.files[migration.to]
    assert.notEqual(typeof target, 'number')
    assert.equal((target as FrozenColorAllowance).kind, 'migration')
    assert.ok(maxColorCount(target) <= migration.transferred)
    assert.ok(
      maxColorCount(baseline.files[migration.from]) + maxColorCount(target) <=
        migration.sourceLiteralsBefore
    )
    assert.ok(migration.sourceLiteralsBefore <= migration.sourceMaxBefore)
  }
})

test('color audit rejects growth and same-count color swaps while allowing tokenization', () => {
  const file = 'component.css'
  const files: Record<string, ColorAllowance> = {
    [file]: {
      maxCount: 2,
      kind: 'debt',
      previousMaxCount: 0,
      sourceCommits: ['0'.repeat(40)],
      reason: 'Test fixture for a retained two-color legacy component.',
      fingerprint: { '#fff': 1, '#000': 1 }
    },
    'old.css': 0
  }
  assert.deepEqual(colorRegressions([[file, 'color:#fff;background:#000']], files), [])
  assert.deepEqual(colorRegressions([[file, 'color:var(--text);background:#000']], files), [])
  assert.deepEqual(colorRegressions([[file, 'color:#fff;background:#123']], files), [
    'component.css: #123: 1 > frozen 0'
  ])
  assert.deepEqual(colorRegressions([[file, 'color:#fff;background:#fff']], files), [
    'component.css: #fff: 2 > frozen 1'
  ])
  assert.ok(
    colorRegressions([[file, 'color:#fff;background:#000;border-color:#fff']], files).length
  )
  assert.deepEqual(colorRegressions([['new.css', 'color:#fff']], files), ['new.css: 1 > 0'])
  assert.deepEqual(colorRegressions([['old.css', 'color:#fff']], files), ['old.css: 1 > 0'])
})

test('a real frozen stylesheet rejects an equal-count palette replacement without touching source files', () => {
  const sources = collectStyleSources(rendererRoot)
  const source = sources.find(
    ([file, styles]) => typeof baseline.files[file] === 'object' && countColorLiterals(styles) > 0
  )
  if (!source) {
    // Fully tokenized legacy files no longer need a real-palette mutation check.
    assert.deepEqual(colorRegressions(sources, baseline.files), [])
    return
  }
  const [file, original] = source
  const styles = original.replace(/\/\*[\s\S]*?\*\//g, '')
  const allowance = baseline.files[file] as FrozenColorAllowance
  const replacement = ['#010203', '#040506'].find((value) => !allowance.fingerprint[value])
  assert.ok(replacement)
  const changed = styles.replace(colorLiterals(styles)[0], replacement)
  assert.notEqual(changed, styles)
  assert.equal(countColorLiterals(changed), countColorLiterals(styles))
  assert.deepEqual(colorRegressions([[file, styles]], baseline.files), [])
  assert.deepEqual(colorRegressions([[file, changed]], baseline.files), [
    `${file}: ${replacement}: 1 > frozen 0`
  ])
})

test('color audit accepts variable color channels while counting literal channels and fallbacks', () => {
  assert.equal(countColorLiterals('color: rgb(var(--text-rgb) / 0.8)'), 0)
  assert.equal(countColorLiterals('color: hsl(var(--accent-hsl) / var(--opacity))'), 0)
  assert.equal(countColorLiterals('color: rgb(255 255 255 / var(--opacity))'), 1)
  assert.equal(countColorLiterals('color: var(--text, #ffffff)'), 1)
  assert.equal(countColorLiterals('color: rgb(var(--text-rgb, 255 255 255))'), 1)
})

function countColorLiterals(styles: string): number {
  return colorLiterals(styles).length
}

function colorLiterals(styles: string): string[] {
  return Array.from(styles.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(colorLiteral))
    .map(([value]) => value)
    .filter((value) => !/^(?:rgba?|hsla?)\(\s*var\(\s*--[\w-]+\s*\)$/i.test(value))
}

function maxColorCount(allowance: ColorAllowance | undefined): number {
  return typeof allowance === 'number' ? allowance : (allowance?.maxCount ?? 0)
}

function colorRegressions(
  sources: ReadonlyArray<readonly [string, string]>,
  allowances: Readonly<Record<string, ColorAllowance>>
): string[] {
  const regressions: string[] = []
  for (const [file, styles] of sources) {
    const literals = colorLiterals(styles)
    const allowance = allowances[file]
    const maximum = maxColorCount(allowance)
    if (literals.length > maximum) regressions.push(`${file}: ${literals.length} > ${maximum}`)
    if (!allowance || typeof allowance === 'number') continue
    const actual: Record<string, number> = {}
    for (const literal of literals) actual[literal] = (actual[literal] ?? 0) + 1
    for (const [literal, count] of Object.entries(actual)) {
      const frozen = allowance.fingerprint[literal] ?? 0
      if (count > frozen) regressions.push(`${file}: ${literal}: ${count} > frozen ${frozen}`)
    }
  }
  return regressions
}

/** Every renderer stylesheet as `[repo-relative path, style text]`, base.css included. */
function collectStyleSources(directory: string): Array<[string, string]> {
  const sources: Array<[string, string]> = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      sources.push(...collectStyleSources(path))
      continue
    }
    if (extname(entry.name) !== '.css' && extname(entry.name) !== '.vue') continue
    sources.push([relative(repositoryRoot, path).replaceAll('\\', '/'), readStyles(path)])
  }
  return sources
}

function readStyles(path: string): string {
  const source = readFileSync(path, 'utf8')
  if (!path.endsWith('.vue')) return source
  return Array.from(
    source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi),
    (match) => match[1]
  ).join('\n')
}
