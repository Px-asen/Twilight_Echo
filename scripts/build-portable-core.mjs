import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { transformSync } from '@babel/core'
import { Linter } from 'eslint'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const ENTRY = path.join(ROOT, 'src/core/portableEmbeddedHost.ts')
const INTRO_FILE = path.join(ROOT, 'scripts/portable-core-intro.js')
const OUT_DIR = path.join(ROOT, 'dist/portable-core')
const OUT_FILE = path.join(OUT_DIR, 'music-core.js')
const LOCK_FILE = path.join(OUT_DIR, 'core-lock.json')
const STALE_MAP_FILE = path.join(OUT_DIR, 'music-core.js.map')
const SCENARIOS_SOURCE = path.join(ROOT, 'scripts/fixtures/portable-core-scenarios.json')
const SCENARIOS_FILE = path.join(OUT_DIR, 'portable-core-scenarios.json')

/** Everything that can change the bundle bytes. */
const CORE_SOURCE_PATHS = [
  'src/core',
  'src/shared',
  'scripts/portable-core-intro.js',
  'scripts/build-portable-core.mjs',
  'scripts/fixtures/portable-core-scenarios.json',
  'package.json',
  'pnpm-lock.yaml'
]

/** Globals the embedded engine provides natively or the intro installs. */
const EMBEDDED_GLOBALS = [
  'globalThis',
  'console',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
  'crypto',
  'structuredClone',
  'TextEncoder',
  'TextDecoder',
  'AbortController',
  'AbortSignal',
  'URL',
  'performance',
  'btoa',
  'atob',
  'AggregateError',
  'DOMException',
  'escape',
  'unescape'
]

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** The lock names a commit; a bundle built from uncommitted Core sources is
 * only allowed explicitly and is then recorded as such. */
function resolveSourceIdentity() {
  let commit
  try {
    commit = git(['rev-parse', 'HEAD']).trim()
  } catch (error) {
    throw new Error(`Portable Core builds require a git checkout: ${error.message}`)
  }
  const status = git(['status', '--porcelain', '--untracked-files=all', '--', ...CORE_SOURCE_PATHS])
    .split('\n')
    .filter(Boolean)
  if (status.length === 0) return { commit, sourceDirty: false }
  if (process.env.ALLOW_DIRTY_CORE !== '1') {
    throw new Error(
      `Core sources have uncommitted changes; commit them or set ALLOW_DIRTY_CORE=1:\n${status.join('\n')}`
    )
  }
  const hash = crypto.createHash('sha256')
  hash.update(git(['diff', 'HEAD', '--binary', '--', ...CORE_SOURCE_PATHS]))
  for (const line of status) {
    if (!line.startsWith('??')) continue
    const file = line.slice(3).trim()
    hash.update(`\0${file}\0`)
    hash.update(fs.readFileSync(path.join(ROOT, file)))
  }
  return { commit, sourceDirty: true, sourceDiffSha256: hash.digest('hex') }
}

/** Parses as ES2020 script and references nothing the embedded engine lacks. */
function verifyEmbeddedCompatibility(code) {
  const linter = new Linter({ configType: 'flat' })
  const globals = Object.fromEntries(EMBEDDED_GLOBALS.map((name) => [name, 'readonly']))
  const messages = linter.verify(code, [
    {
      languageOptions: { ecmaVersion: 2020, sourceType: 'script', globals },
      rules: { 'no-undef': 'error' }
    }
  ])
  const problems = messages.filter((message) => message.fatal || message.severity === 2)
  if (problems.length > 0) {
    const lines = code.split('\n')
    const detail = problems
      .slice(0, 20)
      .map(
        (message) =>
          `  ${message.line}:${message.column} ${message.message}\n    ${String(lines[message.line - 1] ?? '').trim().slice(0, 160)}`
      )
      .join('\n')
    throw new Error(`Portable Core bundle is not embedded-engine safe:\n${detail}`)
  }
}

/**
 * Android ships QuickJS 2020-01 (app.cash.quickjs 0.9.2). Its compiler miscounts the operand
 * stack when a `yield` runs with values pending inside a `try` that has a `finally`
 * (`this.info = yield f()`, `g(a, yield f())`) and rejects the whole bundle with
 * "unconsistent stack size". Async functions are lowered to generators above, so regenerator
 * rewrites every generator into a plain state machine with the same evaluation order. It hoists
 * generator locals to function scope and cannot emit `for...of` or destructuring declarations,
 * so those are lowered first, as @babel/preset-env does.
 */
function lowerGenerators(code) {
  const pass = (input, plugins) => {
    const result = transformSync(input, { babelrc: false, configFile: false, compact: false, sourceType: 'script', plugins })
    if (!result?.code) throw new Error('Babel produced no portable Core bundle')
    return result.code
  }
  const scoped = pass(code, [
    '@babel/plugin-transform-block-scoping',
    '@babel/plugin-transform-for-of',
    '@babel/plugin-transform-destructuring'
  ])
  return pass(scoped, ['@babel/plugin-transform-regenerator'])
}

async function main() {
  const source = resolveSourceIdentity()
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.rmSync(STALE_MAP_FILE, { force: true })

  await build({
    root: ROOT,
    logLevel: 'warn',
    configFile: false,
    define: { __TWILIGHT_AUTOMIX_EVALUATION__: 'false' },
    // Native async functions resolve through the engine's intrinsic Promise,
    // which a host-pumped loop never sees. Generators await the global Promise.
    esbuild: {
      supported: { 'async-await': false, 'async-generator': false, 'for-await': false }
    },
    build: {
      outDir: OUT_DIR,
      emptyOutDir: false,
      sourcemap: false,
      minify: false,
      // Regenerator (see lowerGenerators) cannot emit object spread, optional chains or
      // catch-less bindings, so esbuild lowers everything after ES2017.
      target: 'es2017',
      lib: {
        entry: ENTRY,
        name: 'TwilightPortableCore',
        formats: ['iife'],
        fileName: () => 'music-core.js'
      },
      rollupOptions: {
        external: [],
        output: {
          intro: fs.readFileSync(INTRO_FILE, 'utf8')
        },
        onwarn(warning, warn) {
          if (warning.code === 'CIRCULAR_DEPENDENCY') return
          warn(warning)
        }
      }
    }
  })

  if (!fs.existsSync(OUT_FILE)) {
    throw new Error(`Expected portable Core bundle was not produced at ${OUT_FILE}`)
  }

  const bundleCode = lowerGenerators(fs.readFileSync(OUT_FILE, 'utf8'))

  // Verify the bundle has zero Node.js runtime imports, require() calls, or Legacy Node I/O shim references
  const forbiddenPatterns = [
    { pattern: /\bnode:[a-z0-9_/]+\b/i, reason: 'node:* builtin module reference' },
    { pattern: /__TWILIGHT_CORE_PORTS__/, reason: 'Legacy Node I/O shim (__TWILIGHT_CORE_PORTS__)' },
    { pattern: /\brequire\s*\(/, reason: 'CommonJS require() call' },
    { pattern: /\basync\s+(function\b|\(|[A-Za-z_$][\w$]*\s*=>)/, reason: 'native async function' },
    { pattern: /\bfunction\s*\*|\byield\b/, reason: 'generator left for the embedded QuickJS compiler' }
  ]

  for (const { pattern, reason } of forbiddenPatterns) {
    if (pattern.test(bundleCode)) {
      throw new Error(`Portable Core bundle validation failed: found forbidden ${reason}`)
    }
  }
  verifyEmbeddedCompatibility(bundleCode)
  fs.writeFileSync(OUT_FILE, bundleCode, 'utf8')

  const sha256 = crypto.createHash('sha256').update(bundleCode, 'utf8').digest('hex')
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  // The scenario corpus travels with the bundle so every host replays the same contract.
  const scenarios = fs.readFileSync(SCENARIOS_SOURCE)
  JSON.parse(scenarios.toString('utf8'))
  fs.writeFileSync(SCENARIOS_FILE, scenarios)

  const lockMetadata = {
    upstream: 'https://github.com/Px-asen/Twilight_Echo',
    commit: source.commit,
    sourceDirty: source.sourceDirty,
    ...(source.sourceDiffSha256 ? { sourceDiffSha256: source.sourceDiffSha256 } : {}),
    musicCoreVersion: pkg.version ?? '1.4.0-perview0',
    audioCoreVersion: '0.1.0',
    protocolVersion: 1,
    hostApiVersion: '2.0.0',
    nativeAbiVersion: '0.1.0',
    bundleFile: 'music-core.js',
    bundleSha256: sha256,
    bundleBytes: Buffer.byteLength(bundleCode, 'utf8'),
    scenariosFile: path.basename(SCENARIOS_FILE),
    scenariosSha256: crypto.createHash('sha256').update(scenarios).digest('hex')
  }

  fs.writeFileSync(LOCK_FILE, `${JSON.stringify(lockMetadata, null, 2)}\n`, 'utf8')

  if (process.env.SKIP_ANDROID_SYNC !== '1') {
    const androidTargets = [
      path.join(ROOT, 'sdk/android-app'),
      path.resolve(ROOT, '../Twilight_Echo_Android')
    ]
    for (const androidAppRoot of androidTargets) {
      if (fs.existsSync(androidAppRoot)) {
        const androidAssetsCoreDir = path.join(androidAppRoot, 'runtime-host/src/main/assets/core')
        fs.mkdirSync(androidAssetsCoreDir, { recursive: true })
        fs.copyFileSync(OUT_FILE, path.join(androidAssetsCoreDir, 'music-core.js'))
        fs.copyFileSync(LOCK_FILE, path.join(androidAssetsCoreDir, 'core-lock.json'))
        fs.copyFileSync(LOCK_FILE, path.join(androidAppRoot, 'core-lock.json'))
        const androidScenarioDir = path.join(androidAppRoot, 'app/src/androidTest/assets/core')
        fs.mkdirSync(androidScenarioDir, { recursive: true })
        fs.copyFileSync(SCENARIOS_FILE, path.join(androidScenarioDir, path.basename(SCENARIOS_FILE)))
      }
    }
  }

  console.log(
    `[portable-core] Built ${ path.relative(ROOT, OUT_FILE) } (${lockMetadata.bundleBytes} bytes, sha256=${sha256.slice(0, 12)}...${source.sourceDirty ? ', DIRTY sources' : ''})`
  )
}

main().catch((error) => {
  console.error('[portable-core] Build failed:', error)
  process.exitCode = 1
})
