'use strict'

const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const LOG_DIR = path.join(ROOT, '.cache', 'gate-logs')
const VERIFIED_STAMP_PATH = path.join(LOG_DIR, 'last-verified.json')
const LATEST_LOG_PATH = path.join(LOG_DIR, 'latest.log')

const FAST_STATIC_TESTS = [
  'scripts/architecture-boundaries.test.cjs',
  'scripts/core-boundaries.test.cjs',
  'scripts/ipc-channel-consistency.test.cjs',
  'scripts/tsconfig-shared-boundary.test.cjs',
  'scripts/feature-test-gates.test.cjs',
  'src/preload/sandboxBoundary.test.ts',
  'src/renderer/src/components/themeColorAudit.test.ts'
]

const LINTABLE_EXT_PATTERN = /\.(?:ts|mts|tsx|vue|js|mjs|cjs)$/
const LINT_EXCLUDED_PREFIXES = [
  'node_modules/',
  'dist/',
  'out/',
  'build/',
  'output/',
  'outputs/',
  'tmp/',
  'temp/',
  'work/',
  'audio-engine/build/',
  'audio-engine/out/',
  'src/main/plugins/rhine-vendor/',
  'src/core/plugins/rhine-vendor/'
]

const HEAVY_STANDALONE_TEST_PATTERNS = [
  /^scripts\/server-container\.test\.cjs$/,
  /^scripts\/core-packaged-runtime\.test\.cjs$/,
  /^scripts\/core-headless\.test\.cjs$/,
  /^scripts\/core-production-runtime\.test\.cjs$/,
  /soak\.test\./i,
  /wasapi-real-smoke/i,
  /windows-audio-operational-smoke/i
]

function parseCliArgs(argv) {
  const opts = {
    mode: 'fast',
    staged: false,
    push: false,
    ci: false,
    quiet: false,
    hook: false,
    explicitFiles: null
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') continue
    else if (arg === '--fast') opts.mode = 'fast'
    else if (arg === '--changed') opts.mode = 'changed'
    else if (arg === '--staged') opts.staged = true
    else if (arg === '--push') opts.push = true
    else if (arg === '--ci') opts.ci = true
    else if (arg === '--quiet') opts.quiet = true
    else if (arg === '--hook') {
      opts.mode = 'changed'
      opts.hook = true
      opts.quiet = true
    } else if (arg === '--files') {
      opts.explicitFiles = opts.explicitFiles ?? []
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        i += 1
        opts.explicitFiles.push(argv[i].replaceAll('\\', '/'))
      }
      if (opts.explicitFiles.length === 0) {
        throw new Error('--files requires at least one relative file path')
      }
    } else {
      throw new Error(
        `Unknown local-gate flag "${arg}". Expected --fast, --changed, --staged, --push, --ci, --quiet, --hook, or --files.`
      )
    }
  }
  return opts
}

function gitLines(args, root = ROOT) {
  try {
    const out = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    })
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function collectChangedFiles(options = {}, root = ROOT) {
  if (Array.isArray(options.explicitFiles) && options.explicitFiles.length > 0) {
    return [...new Set(options.explicitFiles.map((f) => f.replaceAll('\\', '/')))].sort()
  }
  const files = new Set()
  const addAll = (list) => {
    for (const item of list) files.add(item.replaceAll('\\', '/'))
  }

  if (options.staged) {
    addAll(gitLines(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], root))
    return [...files].sort()
  }

  if (options.push) {
    const upstream = gitLines(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root)[0]
    if (upstream) {
      addAll(gitLines(['diff', '--name-only', '--diff-filter=ACMR', `${upstream}...HEAD`], root))
    } else {
      addAll(gitLines(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD~1...HEAD'], root))
    }
    return [...files].sort()
  }

  addAll(gitLines(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'], root))
  addAll(gitLines(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], root))
  addAll(gitLines(['ls-files', '--others', '--exclude-standard'], root))

  return [...files].sort()
}

function isRelevantSourcePath(relPath) {
  return (
    relPath === 'package.json' ||
    relPath === 'pnpm-lock.yaml' ||
    relPath === 'pnpm-workspace.yaml' ||
    relPath === 'eslint.config.mjs' ||
    relPath.startsWith('tsconfig') ||
    relPath.startsWith('electron.vite.config') ||
    relPath.startsWith('src/') ||
    relPath.startsWith('scripts/') ||
    relPath.startsWith('packages/') ||
    relPath.startsWith('resources/') ||
    relPath.startsWith('patches/')
  )
}

function computeWorkspaceFingerprint(root = ROOT) {
  const head = gitLines(['rev-parse', 'HEAD'], root)[0] ?? 'NO_HEAD'
  const changed = collectChangedFiles({}, root).filter(isRelevantSourcePath)
  const hash = crypto.createHash('sha256')
  hash.update(`HEAD:${head}\n`)
  for (const relPath of changed) {
    const absPath = path.join(root, relPath)
    hash.update(`FILE:${relPath}\n`)
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      hash.update(fs.readFileSync(absPath))
    } else {
      hash.update('DELETED')
    }
    hash.update('\n')
  }
  return {
    fingerprint: hash.digest('hex'),
    changedCount: changed.length,
    changedFiles: changed
  }
}

function isWorkspaceAlreadyVerified(root = ROOT) {
  const state = computeWorkspaceFingerprint(root)
  if (state.changedCount === 0) return { verified: true, reason: 'clean', state }
  try {
    const stamp = JSON.parse(fs.readFileSync(VERIFIED_STAMP_PATH, 'utf8'))
    if (stamp && stamp.fingerprint === state.fingerprint) {
      return { verified: true, reason: 'stamped', state }
    }
  } catch {
    // Missing or unreadable stamp means unverified.
  }
  return { verified: false, reason: 'dirty', state }
}

function writeVerifiedStamp(mode, root = ROOT) {
  const state = computeWorkspaceFingerprint(root)
  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.writeFileSync(
    VERIFIED_STAMP_PATH,
    JSON.stringify(
      {
        fingerprint: state.fingerprint,
        changedCount: state.changedCount,
        mode,
        verifiedAt: new Date().toISOString()
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
}

function filterLintableFiles(changedFiles, root = ROOT) {
  return changedFiles.filter((file) => {
    if (file.startsWith('.')) return false
    if (!LINTABLE_EXT_PATTERN.test(file)) return false
    if (file.startsWith('packages/create-twilight-plugin/') && file.endsWith('.cjs')) return false
    if (LINT_EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix))) return false
    return fs.existsSync(path.join(root, file))
  })
}

function deriveTypecheckTargets(changedFiles) {
  const targets = {
    core: false,
    node: false,
    web: false,
    portableCore: false
  }
  for (const file of changedFiles) {
    if (
      file.startsWith('src/core/') ||
      file.startsWith('src/shared/') ||
      file === 'tsconfig.core.json'
    ) {
      targets.core = true
      targets.node = true
      targets.web = true
      targets.portableCore = true
    } else if (
      file.startsWith('src/main/') ||
      file.startsWith('src/preload/') ||
      file.startsWith('src/adapters-node/') ||
      file.startsWith('scripts/') ||
      file.startsWith('electron.vite.config') ||
      file === 'tsconfig.node.json'
    ) {
      targets.node = true
      if (file === 'src/preload/types.ts' || /^src\/preload\/.*\.d\.ts$/.test(file)) {
        targets.web = true
      }
    } else if (file.startsWith('src/renderer/') || file === 'tsconfig.web.json') {
      targets.web = true
    }
  }
  return targets
}

function deriveAffectedUnitTests(changedFiles, options = {}, root = ROOT) {
  const selected = new Set()
  const isSkippedTest = (relPath) => {
    if (HEAVY_STANDALONE_TEST_PATTERNS.some((pattern) => pattern.test(relPath))) return true
    if (options.hook && /\.behavior\.test\.(?:ts|cjs|mjs)$/.test(relPath)) return true
    return false
  }

  for (const file of changedFiles) {
    if (/\.test\.(?:ts|cjs|mjs)$/.test(file)) {
      if (!isSkippedTest(file) && fs.existsSync(path.join(root, file))) {
        selected.add(file)
      }
      continue
    }
    if (!/^(?:src|scripts|packages|resources)\//.test(file)) continue
    const parsed = path.posix.parse(file)
    const dirAbs = path.join(root, parsed.dir)
    if (!fs.existsSync(dirAbs)) continue
    for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.test\.(?:ts|cjs|mjs)$/.test(entry.name)) continue
      const isDirectUnit =
        entry.name === `${parsed.name}.test.ts` ||
        entry.name === `${parsed.name}.test.cjs` ||
        entry.name === `${parsed.name}.test.mjs`
      const isScopedVariant =
        !options.hook &&
        entry.name.startsWith(`${parsed.name}.`) &&
        !/\.behavior\.test\./.test(entry.name)
      if (isDirectUnit || isScopedVariant) {
        const candidate = `${parsed.dir}/${entry.name}`
        if (!isSkippedTest(candidate)) selected.add(candidate)
      }
    }
  }
  return [...selected].sort()
}

function runNodeTool(label, scriptArgs, options = {}) {
  const started = Date.now()
  if (!options.quiet) {
    console.log(`\n[local-gate] ${label}`)
  }
  const cleanTmp = path.join(os.tmpdir(), 'twilight-local-gate-tmp')
  fs.mkdirSync(cleanTmp, { recursive: true })
  const env = {
    ...process.env,
    TEMP: cleanTmp,
    TMP: cleanTmp,
    ...(options.env ?? {})
  }
  const result = spawnSync(process.execPath, scriptArgs, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : 'inherit',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  })
  const durationMs = Date.now() - started
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error) {
    return { ok: false, label, durationMs, output: `${output}\n${result.error.message}`.trim() }
  }
  if (result.status !== 0) {
    return { ok: false, label, durationMs, output: output.trim() }
  }
  if (!options.quiet) {
    console.log(`[local-gate] PASS ${label} (${(durationMs / 1000).toFixed(1)}s)`)
  }
  return { ok: true, label, durationMs, output: output.trim() }
}

function recordGateLog(entries) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const lines = entries.map(
    (entry) =>
      `=== [${entry.ok ? 'PASS' : 'FAIL'}] ${entry.label} (${entry.durationMs}ms) ===\n${entry.output || '(inherited stdio)'}\n`
  )
  fs.writeFileSync(LATEST_LOG_PATH, lines.join('\n'), 'utf8')
}

function executeGate(opts) {
  const logs = []
  const runStep = (label, args, extra = {}) => {
    const res = runNodeTool(label, args, { quiet: opts.quiet, ...extra })
    logs.push(res)
    if (!res.ok) {
      recordGateLog(logs)
      if (opts.quiet && res.output) {
        const tail = res.output.split(/\r?\n/).slice(-35).join('\n')
        console.error(`[local-gate] FAILED at "${label}":\n${tail}`)
      }
    }
    return res.ok
  }

  const changedFiles = opts.ci ? [] : collectChangedFiles(opts)

  // 1. Lint
  const eslintBin = path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js')
  if (opts.ci) {
    if (!runStep('eslint (full repository)', [eslintBin, '--cache', '.'])) return 1
  } else {
    const lintFiles = filterLintableFiles(changedFiles)
    if (lintFiles.length > 0) {
      if (
        !runStep(`eslint (${lintFiles.length} changed files)`, [
          eslintBin,
          '--cache',
          '--no-warn-ignored',
          ...lintFiles
        ])
      ) {
        return 1
      }
    }
  }

  // 2. Fast static boundary & contract tests (~2s)
  if (
    !runStep('static architecture & contract checks', [
      '--experimental-strip-types',
      '--test',
      '--import',
      './scripts/register-renderer-aliases.mjs',
      ...FAST_STATIC_TESTS
    ])
  ) {
    return 1
  }

  // 3. Dependency / patch policy checks when relevant
  const touchesDeps =
    opts.ci ||
    changedFiles.some(
      (file) =>
        file === 'package.json' ||
        file === 'pnpm-lock.yaml' ||
        file === 'pnpm-workspace.yaml' ||
        file.startsWith('patches/')
    )
  if (touchesDeps) {
    if (!runStep('verify:install-policy', ['scripts/verify-install-policy.cjs'])) return 1
    if (!runStep('verify:ncm-patch', ['scripts/verify-ncm-patch.cjs'])) return 1
  }

  if (opts.mode === 'fast') {
    recordGateLog(logs)
    return 0
  }

  // 4. Incremental typechecks & Portable Core verification (--changed mode)
  const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  const vueTscBin = path.join(ROOT, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js')
  const typeTargets = deriveTypecheckTargets(changedFiles)

  if (typeTargets.core) {
    if (!runStep('typecheck:core', [tscBin, '--noEmit', '-p', 'tsconfig.core.json'])) return 1
  }
  if (typeTargets.node) {
    if (
      !runStep('typecheck:node', [
        tscBin,
        '--noEmit',
        '-p',
        'tsconfig.node.json',
        '--composite',
        'false'
      ])
    ) {
      return 1
    }
  }
  if (typeTargets.web) {
    if (
      !runStep(
        'typecheck:web',
        [vueTscBin, '--noEmit', '-p', 'tsconfig.web.json', '--composite', 'false'],
        { env: { NODE_OPTIONS: '--max-old-space-size=4096' } }
      )
    ) {
      return 1
    }
  }
  if (typeTargets.portableCore) {
    if (
      !runStep('build:portable-core (QuickJS check)', ['scripts/build-portable-core.mjs'], {
        env: { ALLOW_DIRTY_CORE: '1', SKIP_ANDROID_SYNC: '1' }
      })
    ) {
      return 1
    }
  }

  // 5. Affected unit tests
  const unitTests = deriveAffectedUnitTests(changedFiles, { hook: opts.hook })
  if (unitTests.length > 0) {
    if (
      !runStep(`affected tests (${unitTests.length} files)`, [
        '--experimental-strip-types',
        '--test',
        '--test-concurrency=2',
        '--import',
        './scripts/register-renderer-aliases.mjs',
        ...unitTests
      ])
    ) {
      return 1
    }
  }

  recordGateLog(logs)
  if (!opts.explicitFiles) {
    writeVerifiedStamp(opts.hook ? 'hook' : 'changed')
  }
  return 0
}

module.exports = {
  FAST_STATIC_TESTS,
  VERIFIED_STAMP_PATH,
  collectChangedFiles,
  computeWorkspaceFingerprint,
  deriveAffectedUnitTests,
  deriveTypecheckTargets,
  filterLintableFiles,
  isWorkspaceAlreadyVerified,
  parseCliArgs
}

if (require.main === module) {
  try {
    const opts = parseCliArgs(process.argv.slice(2))
    process.exitCode = executeGate(opts)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
