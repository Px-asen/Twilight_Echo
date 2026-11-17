import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { THEME_TOKEN_DEFINITIONS } from '../../../shared/themeTokens.ts'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const rendererRoot = join(repositoryRoot, 'src', 'renderer', 'src')

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
 * so the element paints nothing at all rather than degrading.
 */
test('gradient-valued and shadow-valued tokens are never used where a color is required', () => {
  const misuses: string[] = []
  for (const [file, styles] of collectStyleSources(rendererRoot)) {
    for (const misuse of nonColorTokenMisuses(styles)) misuses.push(`${file}: ${misuse}`)
  }

  assert.deepEqual(misuses, [])
})

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
