'use strict'

const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const path = require('node:path')
const { discoverUnassignedTests } = require('./test-discovery.cjs')

const PRODUCT_GATES = [
  {
    name: 'library-and-sources',
    scripts: [
      'test:tag-duplicate-management',
      'test:playlist-lifecycle',
      'test:network-sources',
      'test:cue',
      'test:local-perf',
      'test:radio-remote'
    ]
  },
  {
    name: 'playback-and-audio',
    scripts: [
      'test:audio-manager',
      'test:playback-routing',
      'test:lyrics-management',
      'test:dsp-graph',
      'test:dsp-assets',
      'test:sleep-timer',
      'test:audio-toolchain'
    ]
  },
  {
    name: 'application-and-boundaries',
    scripts: [
      'test:core',
      'test:plugins',
      'test:plugin-tooling',
      'test:themes',
      'test:appearance-workspace',
      'test:app',
      'test:renderer-data-tooling',
      'test:cross-cutting-regressions'
    ]
  }
]
const PRODUCT_SCRIPTS = PRODUCT_GATES.flatMap((gate) => gate.scripts)

function parseGateCli(rawArgs) {
  const args = rawArgs.filter((arg) => arg !== '--')
  let reportPath = null
  let groupName = null
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--report') {
      const next = args[++i]
      if (!next || next.startsWith('--')) {
        throw new Error('Usage: pnpm run test:product -- [--group <name>] [--report <report.json>]')
      }
      reportPath = next
    } else if (arg === '--group') {
      const next = args[++i]
      if (!next || next.startsWith('--')) {
        throw new Error('Usage: pnpm run test:product -- [--group <name>] [--report <report.json>]')
      }
      if (!PRODUCT_GATES.some((gate) => gate.name === next)) {
        throw new Error(
          `Unknown product gate group "${next}". Expected one of: ${PRODUCT_GATES.map((g) => g.name).join(', ')}`
        )
      }
      groupName = next
    } else {
      throw new Error('Usage: pnpm run test:product -- [--group <name>] [--report <report.json>]')
    }
  }
  return { reportPath, groupName }
}

/** Collect every suite result; one failed group must not hide later failures. */
async function runProductQualityGate(runScript, options = {}) {
  const selectedGates = options.groupName
    ? PRODUCT_GATES.filter((gate) => gate.name === options.groupName)
    : PRODUCT_GATES
  if (selectedGates.length === 0) {
    throw new Error(`Unknown product gate group "${options.groupName}"`)
  }

  const groups = []
  for (const gate of selectedGates) {
    const suites = []
    for (const script of gate.scripts) {
      const started = Date.now()
      try {
        const exitCode = await runScript(script)
        suites.push({ script, exitCode, passed: exitCode === 0, durationMs: Date.now() - started })
      } catch (error) {
        suites.push({
          script,
          exitCode: null,
          passed: false,
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    if (
      gate.name === 'application-and-boundaries' &&
      Array.isArray(options.unassignedProductTests) &&
      options.unassignedProductTests.length > 0 &&
      typeof options.runUnassignedTests === 'function'
    ) {
      const started = Date.now()
      try {
        const exitCode = await options.runUnassignedTests(options.unassignedProductTests)
        suites.push({
          script: 'test:auto-discovered',
          exitCode,
          passed: exitCode === 0,
          durationMs: Date.now() - started
        })
      } catch (error) {
        suites.push({
          script: 'test:auto-discovered',
          exitCode: null,
          passed: false,
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    groups.push({ name: gate.name, passed: suites.every((suite) => suite.passed), suites })
  }
  return { schemaVersion: 1, passed: groups.every((group) => group.passed), groups }
}

function runPnpmScript(script) {
  const entry = process.env.npm_execpath
  if (!entry || !/\.(?:cjs|mjs|js)$/.test(entry)) {
    throw new Error(
      'Run this gate through pnpm run test:product so the declared package manager is used.'
    )
  }
  console.log(`\n[product quality] ${script}`)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, 'run', script], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      windowsHide: true
    })
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })
}

function runNodeTestFiles(files) {
  console.log(`\n[product quality] test:auto-discovered (${files.length} files)`)
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--test',
        '--test-concurrency=2',
        '--import',
        './scripts/register-renderer-aliases.mjs',
        ...files
      ],
      {
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit',
        windowsHide: true
      }
    )
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })
}

async function main() {
  const { reportPath, groupName } = parseGateCli(process.argv.slice(2))
  const { productTests } = discoverUnassignedTests()
  const report = await runProductQualityGate(runPnpmScript, {
    groupName,
    unassignedProductTests: productTests,
    runUnassignedTests: runNodeTestFiles
  })
  report.commit = process.env.GITHUB_SHA ?? null
  report.node = process.version
  if (groupName) report.group = groupName
  if (reportPath) writeFileSync(path.resolve(reportPath), JSON.stringify(report, null, 2) + '\n')
  for (const group of report.groups) {
    const failed = group.suites.filter((suite) => !suite.passed).map((suite) => suite.script)
    console.log(
      `[${group.passed ? 'PASS' : 'FAIL'}] ${group.name}${failed.length ? ': ' + failed.join(', ') : ''}`
    )
  }
  process.exitCode = report.passed ? 0 : 1
}

module.exports = { PRODUCT_GATES, PRODUCT_SCRIPTS, parseGateCli, runProductQualityGate }
if (require.main === module)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
