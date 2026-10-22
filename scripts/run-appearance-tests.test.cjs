const assert = require('node:assert/strict')
const test = require('node:test')
const { unit, ui, runAppearanceTests } = require('./run-appearance-tests.cjs')

test('full appearance gate executes every declared test in one bounded child', () => {
  const calls = []
  assert.equal(
    runAppearanceTests([], (command, args, options) => {
      calls.push({ command, args, options })
      return { status: 0 }
    }),
    0
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, process.execPath)
  assert.ok(calls[0].args.includes('--test-concurrency=1'))
  assert.deepEqual(
    calls[0].args.filter((arg) => /\.test\.(ts|cjs)$/.test(arg)),
    [...unit, ...ui]
  )
  assert.ok(!calls[0].args.includes('--test-skip-pattern'))
  assert.equal(calls[0].options.windowsHide, true)
})

test('unit mode cannot claim the UI tests and unsupported arguments fail closed', () => {
  runAppearanceTests(['--unit'], (_command, args) => {
    assert.deepEqual(
      args.filter((arg) => /\.test\.(ts|cjs)$/.test(arg)),
      unit
    )
    return { status: 0 }
  })
  assert.throws(() => runAppearanceTests(['--unt']), /Usage:/)
  assert.throws(() => runAppearanceTests(['--unit', '--unit']), /Usage:/)
})

test('appearance gate propagates child failures, termination and launch errors', () => {
  assert.equal(
    runAppearanceTests([], () => ({ status: 7 })),
    7
  )
  assert.equal(
    runAppearanceTests([], () => ({ status: null, signal: 'SIGTERM' })),
    1
  )
  const failure = new Error('cannot launch test process')
  assert.throws(
    () => runAppearanceTests([], () => ({ error: failure })),
    (error) => error === failure
  )
})
