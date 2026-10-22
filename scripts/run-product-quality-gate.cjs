'use strict'

const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const path = require('node:path')

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

/** Collect every suite result; one failed group must not hide later failures. */
async function runProductQualityGate(runScript) {
  const groups = []
  for (const gate of PRODUCT_GATES) {
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

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--report' || !args[1])) {
    throw new Error('Usage: pnpm run test:product -- --report <existing-directory/report.json>')
  }
  const report = await runProductQualityGate(runPnpmScript)
  report.commit = process.env.GITHUB_SHA ?? null
  report.node = process.version
  if (args[1]) writeFileSync(path.resolve(args[1]), JSON.stringify(report, null, 2) + '\n')
  for (const group of report.groups) {
    const failed = group.suites.filter((suite) => !suite.passed).map((suite) => suite.script)
    console.log(
      `[${group.passed ? 'PASS' : 'FAIL'}] ${group.name}${failed.length ? ': ' + failed.join(', ') : ''}`
    )
  }
  process.exitCode = report.passed ? 0 : 1
}

module.exports = { PRODUCT_GATES, PRODUCT_SCRIPTS, runProductQualityGate }
if (require.main === module)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
