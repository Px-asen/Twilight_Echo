'use strict'

/**
 * Repository gate: every structured audio error thrown in the main process must
 * have copy in every shipped message catalog.
 *
 * Without this, a `ipcError('audio.something_new', ...)` reaches the renderer,
 * finds no `error.audio.something_new` entry, and silently renders the generic
 * "unknown error" fallback — the exact failure mode this whole change set exists
 * to remove. The gate makes that a red test instead of a vague toast.
 *
 * Companion to `audio-reason-code-coverage.test.cjs`, which does the same job for
 * the native engine's `perfectReasonCode` values.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..')
const SOURCE_DIRS = [path.join(ROOT, 'src', 'main'), path.join(ROOT, 'src', 'core')]
const CATALOG_DIR = path.join(ROOT, 'src', 'shared', 'i18n', 'messages')
const LOCALES = ['zh-CN', 'en-US']

function collectSourceCodes(source, file) {
  const codes = new Set()
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const add = (value) => {
    if (
      value &&
      ts.isStringLiteralLike(value) &&
      /^(?:audio|diagnostics)\.[a-z0-9_.]+$/.test(value.text)
    ) {
      codes.add(value.text)
    }
  }
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ''
      if (['audioEngineError', 'nativeAudioError', 'ipcError', 'appError'].includes(name)) {
        add(node.arguments[0])
      } else if (name === 'runOutputRouteTransaction') {
        const options = node.arguments[0]
        if (options && ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            if (!ts.isPropertyAssignment(property)) continue
            if (
              (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
              property.name.text === 'errorCode'
            ) {
              add(property.initializer)
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return codes
}

/** Codes thrown through the structured helpers, as `code -> [source files]`. */
function collectThrownCodes() {
  const codes = new Map()
  for (const dir of SOURCE_DIRS) {
    for (const file of walk(dir)) {
      if (/\.(?:test|spec)\.[^.]+$/.test(file)) continue
      const source = fs.readFileSync(file, 'utf8')
      // Include literals delegated through the route transaction to nativeAudioError.
      // Parse call sites so comments and unrelated errorCode properties aren't evidence.
      for (const code of collectSourceCodes(source, file)) {
        const relative = path.relative(ROOT, file).replace(/\\/g, '/')
        if (!codes.has(code)) codes.set(code, [])
        codes.get(code).push(relative)
      }
    }
  }
  return codes
}

test('the probe follows transaction error codes without counting comments or unrelated properties', () => {
  const codes = collectSourceCodes(
    `
    // nativeAudioError('audio.comment_only', 'unused')
    const unrelated = { errorCode: 'audio.unrelated' }
    nativeAudioError('audio.direct', 'failed')
    router.runOutputRouteTransaction({ errorCode: 'audio.transaction', errorMessage: 'failed' })
    nativeAudioError(options.errorCode, options.errorMessage)
  `,
    'fixture.ts'
  )
  assert.deepEqual([...codes].sort(), ['audio.direct', 'audio.transaction'])
})

/** Message keys present in one catalog. Parsed as text: no TS loader needed. */
function catalogKeys(locale) {
  const source = fs.readFileSync(path.join(CATALOG_DIR, `${locale}.ts`), 'utf8')
  const keys = new Set()
  for (const match of source.matchAll(/^\s{2}'([^']+)':/gm)) keys.add(match[1])
  return keys
}

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      out.push(...walk(full))
    } else if (/\.ts$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

test('the probe finds the structured audio errors it is meant to police', () => {
  const codes = collectThrownCodes()
  // A silent zero would make every assertion below vacuously true.
  assert.ok(
    codes.size >= 15,
    `expected the main process to throw many structured audio errors, found ${codes.size}`
  )
  // Spot-check one code per migrated module so a refactor that drops the helper
  // (and goes back to a bare `throw new Error('中文')`) fails here.
  for (const expected of ['audio.device_switch_failed', 'audio.exclusive_unsupported']) {
    assert.ok(codes.has(expected), `${expected} should be thrown somewhere in src/main`)
  }
})

test('every thrown audio error code has copy in every shipped locale', () => {
  const codes = collectThrownCodes()
  const missing = []
  for (const locale of LOCALES) {
    const keys = catalogKeys(locale)
    for (const [code, files] of codes) {
      if (!keys.has(`error.${code}`)) {
        missing.push(`${locale}: error.${code} (thrown in ${files[0]})`)
      }
    }
  }
  assert.deepEqual(
    missing.sort(),
    [],
    'a thrown code with no catalog entry renders as the generic fallback instead of a real message'
  )
})

test('no catalog entry claims an audio error that nothing throws', () => {
  const codes = collectThrownCodes()
  const keys = catalogKeys('zh-CN')
  // Keys that describe app state rather than a throw site: they are rendered
  // directly by the renderer or the diagnostics report, never thrown.
  const RENDERER_OWNED = new Set([
    'error.audio.service_fatal',
    'error.audio.service_crashed',
    'error.audio.service_start_failed',
    'error.audio.service_still_failing',
    'error.audio.service_restarting',
    'error.audio.service_recovered',
    'error.audio.service_recovered_route_pending',
    'error.audio.restore_detail',
    'error.audio.output_route_not_restored',
    'error.audio.awaiting_route_confirmation',
    'error.audio.unknown_reason',
    'error.audio.native_unavailable',
    'error.audio.playback_target_unavailable',
    'error.audio.native_unavailable_detail',
    'error.audio.native_fallback',
    'error.audio.playback_fallback_switched',
    'error.audio.playback_fallback_rematched',
    'error.audio.current_track',
    'error.audio.decode_failed'
  ])
  const orphans = []
  for (const key of keys) {
    if (!key.startsWith('error.audio.')) continue
    if (RENDERER_OWNED.has(key)) continue
    const code = key.slice('error.'.length)
    if (!codes.has(code)) orphans.push(key)
  }
  assert.deepEqual(
    orphans.sort(),
    [],
    'dead copy: either the throw site was removed, or the key should be listed as renderer-owned'
  )
})
