const assert = require('node:assert/strict')
const test = require('node:test')
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
  assert.equal(options.cycles, 50)
  assert.equal(options.soakSeconds, 1800)
  assert.equal(options.minFreeBytes, 1024 ** 3)
  for (const args of [
    ['--sizes', '0'],
    ['--runs', '-1'],
    ['--sizes', '1057,'],
    ['--output'],
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
