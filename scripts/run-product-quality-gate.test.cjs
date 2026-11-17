'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const {
  PRODUCT_GATES,
  PRODUCT_SCRIPTS,
  parseGateCli,
  runProductQualityGate
} = require('./run-product-quality-gate.cjs')
const packageJson = require('../package.json')

test('product gate owns every product suite once without invoking application or native builds', () => {
  assert.equal(new Set(PRODUCT_SCRIPTS).size, PRODUCT_SCRIPTS.length)
  for (const script of PRODUCT_SCRIPTS) {
    assert.ok(packageJson.scripts[script], `${script} must exist`)
    assert.doesNotMatch(
      packageJson.scripts[script],
      /(?:\b(?:build|configure|package):|pnpm run (?:build|configure|package)\b)/
    )
  }
})

test('CLI parser accepts optional --group and --report and rejects unknown groups', () => {
  assert.deepEqual(parseGateCli([]), { reportPath: null, groupName: null })
  assert.deepEqual(
    parseGateCli(['--', '--group', 'playback-and-audio', '--report', 'out/gate.json']),
    { reportPath: 'out/gate.json', groupName: 'playback-and-audio' }
  )
  assert.throws(() => parseGateCli(['--group', 'unknown-shard']), /Unknown product gate group/)
})

test('single-group mode executes only the selected shard', async () => {
  const called = []
  const report = await runProductQualityGate(
    async (script) => {
      called.push(script)
      return 0
    },
    { groupName: 'playback-and-audio' }
  )
  assert.equal(report.passed, true)
  assert.deepEqual(
    report.groups.map((g) => g.name),
    ['playback-and-audio']
  )
  assert.deepEqual(called, PRODUCT_GATES[1].scripts)
})

test('suite failures and launch errors are all reported and do not skip remaining outcomes', async () => {
  const called = []
  const report = await runProductQualityGate(async (script) => {
    called.push(script)
    if (script === PRODUCT_SCRIPTS[0]) return 1
    if (script === PRODUCT_SCRIPTS[1]) throw new Error('launch failed')
    return 0
  })
  assert.deepEqual(called, PRODUCT_SCRIPTS)
  assert.equal(report.passed, false)
  assert.equal(report.groups[0].passed, false)
  assert.equal(report.groups[0].suites[1].error, 'launch failed')
  assert.ok(report.groups.slice(1).every((group) => group.passed))
})

test('all successful product outcomes produce a passing aggregate report', async () => {
  const report = await runProductQualityGate(async () => 0)
  assert.equal(report.passed, true)
  assert.deepEqual(
    report.groups.map((group) => group.name),
    PRODUCT_GATES.map((group) => group.name)
  )
  assert.ok(
    report.groups
      .flatMap((group) => group.suites)
      .every((suite) => suite.passed && suite.exitCode === 0)
  )
})

test('CLI launches all declared suites and writes a complete report before failing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'twilight-product-gate-'))
  try {
    const entry = path.join(root, 'pnpm-fixture.cjs')
    const reportPath = path.join(root, 'report.json')
    writeFileSync(
      entry,
      `if (process.argv[2] !== 'run') process.exit(2); process.exit(process.argv[3] === '${PRODUCT_SCRIPTS[0]}' ? 1 : 0)`
    )
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [path.join(__dirname, 'run-product-quality-gate.cjs'), '--report', reportPath],
          {
            env: { ...process.env, npm_execpath: entry },
            windowsHide: true,
            timeout: 20000,
            stdio: 'pipe'
          }
        ),
      (error) => error.status === 1
    )
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    assert.equal(report.passed, false)
    assert.equal(report.groups[0].suites[0].exitCode, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
