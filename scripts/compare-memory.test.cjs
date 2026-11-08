const assert = require('node:assert/strict')
const test = require('node:test')
const { compareReports } = require('./compare-memory.cjs')
function report(resident = [100, 110, 120], commit = [200, 210, 220]) {
  return {
    status: 'complete',
    acceptanceEligible: true,
    options: {
      sizes: [1057],
      runs: 3,
      scenario: 'full',
      cycles: 50,
      soakSeconds: 1800,
      settleSeconds: 120
    },
    machine: { memoryBytes: 16 * 1024 ** 3, cpu: 'fixture', electron: 'fixture' },
    runs: resident.map((bytes, i) => ({
      size: 1057,
      status: 'complete',
      acceptanceEligible: true,
      environment: { dpr: 1, width: 1280, height: 939, gpu: { gpu_compositing: 'enabled' } },
      settings: { theme: 'pureWhite', sandbox: true },
      summary: [
        {
          name: 'playing',
          valid: true,
          stablePrivateWorkingSetBytes: bytes,
          stablePrivateCommitBytes: commit[i],
          roles: { main: { privateWorkingSetBytes: bytes, privateCommitBytes: commit[i] } },
          gpu: { dedicatedBytes: 10, sharedBytes: 20 }
        }
      ]
    }))
  }
}
test('memory comparison reports repeat medians and ranges, with separate commit and GPU', () => {
  const result = compareReports(report(), report([50, 60, 70], [150, 160, 170]))
  assert.equal(result.comparable, true)
  assert.equal(result.memoryTargetMet, true)
  const phase = result.sizes[0].phases[0]
  assert.deepEqual(phase.privateWorkingSetBytes.before, { median: 110, min: 100, max: 120 })
  assert.deepEqual(phase.privateCommitBytes.after, { median: 160, min: 150, max: 170 })
  assert.equal(phase.gpu.sharedBytes.after.median, 20)
})
test('pressure, missing repetitions and changed geometry never yield a reduction claim', () => {
  for (const mutate of [
    (value) => {
      value.status = 'memory-pressure'
    },
    (value) => {
      value.runs.pop()
    },
    (value) => {
      value.runs[0].environment.dpr = 2
    },
    (value) => {
      value.runs[0].acceptanceEligible = false
    }
  ]) {
    const after = report([1, 2, 3])
    mutate(after)
    const result = compareReports(report(), after)
    assert.equal(result.comparable, false)
    assert.equal(result.memoryTargetMet, false)
    assert.deepEqual(result.sizes, [])
  }
})
test('lower resident memory with greater private commit fails the memory gate', () => {
  const result = compareReports(report(), report([20, 30, 40], [300, 310, 320]))
  assert.equal(result.comparable, true)
  assert.equal(result.memoryTargetMet, false)
})
