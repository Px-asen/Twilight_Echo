const assert = require('node:assert/strict')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const {
  parseArgs,
  summarize,
  acceptanceEligible,
  STEADY_PHASES
} = require('./benchmark-memory.cjs')

test('memory benchmark defaults preserve the accepted workload and stop budget', () => {
  const options = parseArgs([])
  assert.deepEqual(options.sizes, [1057, 10000, 100000])
  assert.equal(options.runs, 3)
  assert.equal(options.scenario, 'full')
  assert.equal(options.coreHost, 'electron')
  assert.equal(options.cycles, 50)
  assert.equal(options.soakSeconds, 1800)
  assert.equal(options.minFreeBytes, 1024 ** 3)
  for (const args of [
    ['--sizes', '0'],
    ['--runs', '-1'],
    ['--sizes', '1057,'],
    ['--output'],
    ['--scenario', 'unknown'],
    ['--core-host', 'unknown'],
    ['--unknown', 'x']
  ])
    assert.throws(() => parseArgs(args))
})

test('memory summary separates private resident, commit and GPU counters and sums concurrent processes per role', () => {
  const run = {
    phases: [{ name: 'idle', start: 0, end: 100 }],
    roles: { 1: 'main', 2: 'Renderer', 3: 'Renderer' }
  }
  const samples = [25, 60, 80, 100].map((timestamp) => ({
    timestamp,
    gpuAvailable: true,
    gpu: [{ pid: 2, dedicatedBytes: 1000, sharedBytes: 2000 }],
    processes: [
      { pid: 1, privateWorkingSetBytes: 10, privateCommitBytes: 20, workingSetBytes: 30 },
      { pid: 2, privateWorkingSetBytes: 100, privateCommitBytes: 200, workingSetBytes: 300 },
      { pid: 3, privateWorkingSetBytes: 50, privateCommitBytes: 80, workingSetBytes: 120 }
    ]
  }))
  const result = summarize(run, samples)[0]
  assert.equal(result.stablePrivateWorkingSetBytes, 160)
  assert.equal(result.stablePrivateCommitBytes, 300)
  assert.equal(result.roles.Renderer.privateWorkingSetBytes, 150)
  assert.equal(result.gpu.dedicatedBytes, 1000)
  assert.equal(result.gpu.sharedBytes, 2000)
  assert.equal(result.valid, true)
})

test('incomplete phases and absent counters cannot be reported as a stable zero-memory result', () => {
  const result = summarize(
    { phases: [{ name: 'failed', start: 0, end: 10, incomplete: true }] },
    []
  )[0]
  assert.equal(result.valid, false)
  assert.equal(result.stablePrivateWorkingSetBytes, null)
  assert.equal(result.gpu.dedicatedBytes, null)
})

test('exited processes contribute zero to their role; V8 heaps retain each process identity', () => {
  const run = {
    phases: [{ name: 'idle', start: 0, end: 100 }],
    roles: { 1: 'main', 2: 'plugin', 3: 'plugin' }
  }
  const process = (pid, bytes) => ({
    pid,
    privateWorkingSetBytes: bytes,
    privateCommitBytes: bytes
  })
  const samples = [60, 80, 100].map((timestamp, i) => ({
    timestamp,
    processes: i ? [process(1, 10)] : [process(1, 10), process(2, 100)]
  }))
  const runtime = [60, 80, 100].map((timestamp) => ({
    timestamp,
    utilities: [
      { pid: 2, heapUsed: 20 },
      { pid: 3, heapUsed: 30 }
    ]
  }))
  const phase = summarize(run, samples, runtime)[0]
  assert.equal(phase.roles.plugin.privateWorkingSetBytes, 0)
  assert.equal(phase.runtime['plugin:2'].heapUsed, 20)
  assert.equal(phase.runtime['plugin:3'].heapUsed, 30)
})

test('acceptance requires every scenario, the full workload, hardware compositing and the sandbox', () => {
  const options = parseArgs([])
  const result = {
    status: 'complete',
    exitCode: 0,
    environment: { gpu: { gpu_compositing: 'enabled' } },
    summary: STEADY_PHASES.map((name) => ({ name, valid: true }))
  }
  assert.equal(acceptanceEligible(options, result), true)
  assert.equal(acceptanceEligible({ ...options, diagnosticNoSandbox: true }, result), false)
  assert.equal(acceptanceEligible({ ...options, cycles: 2 }, result), false)
  assert.equal(acceptanceEligible({ ...options, scenario: 'steady' }, result), false)
  assert.equal(acceptanceEligible(options, { ...result, summary: [] }), false)
  assert.equal(acceptanceEligible(options, { ...result, status: 'memory-pressure' }), false)
  assert.equal(
    acceptanceEligible(options, {
      ...result,
      environment: { gpu: { gpu_compositing: 'disabled_software' } }
    }),
    false
  )
})

test('steady residency is an explicit workload and preserves configured dwell times', () => {
  const options = parseArgs([
    '--scenario',
    'steady',
    '--settle-seconds',
    '45',
    '--soak-seconds',
    '60'
  ])
  assert.equal(options.scenario, 'steady')
  assert.equal(options.settleSeconds, 45)
  assert.equal(options.soakSeconds, 60)
  assert.equal(options.diagnosticNoSandbox, undefined)
})

test('Node comparison is an explicit host selection without changing the accepted workload', () => {
  const options = parseArgs(['--core-host', 'node'])
  assert.equal(options.coreHost, 'node')
  assert.equal(options.scenario, 'full')
  assert.equal(options.diagnosticNoSandbox, undefined)
})

test('an explicitly installed Electron path leaves sandbox and workload requirements intact', () => {
  const options = parseArgs(['--electron-executable', './runtime/electron.exe'])
  assert.equal(options.electronExecutable, require('node:path').resolve('./runtime/electron.exe'))
  assert.equal(options.diagnosticNoSandbox, undefined)
  assert.equal(options.runs, 3)
})

test(
  'Windows sampling rejects stale parent PIDs while retaining real descendants',
  {
    skip: process.platform !== 'win32'
  },
  () => {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `
    . ./scripts/memory-process-tree.ps1
    function Entry($id, $parent, $seconds) {
      [pscustomobject]@{ ProcessId=$id; ParentProcessId=$parent; CreationDate=[datetime]'2026-11-08T00:00:00Z' + [timespan]::FromSeconds($seconds) }
    }
    $processes = @((Entry 10 1 10), (Entry 20 10 11), (Entry 30 20 12),
      (Entry 40 10 1), (Entry 50 40 2), (Entry 60 20 3))
    $ids = Get-MemoryProcessIds -RootProcessId 10 -Processes $processes
    if (($ids | Sort-Object) -join ',' -ne '10,20,30') { throw 'Reused PID admitted an unrelated process' }
    $missing = Get-MemoryProcessIds -RootProcessId 999 -Processes $processes
    if ($missing.Count -ne 0) { throw 'Missing root must not include processes' }
  `
      ],
      { encoding: 'utf8', windowsHide: true }
    )
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
)
