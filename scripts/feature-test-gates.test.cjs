'use strict'

const assert = require('node:assert/strict')
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')
const { PRODUCT_SCRIPTS } = require('./run-product-quality-gate.cjs')
const appearanceTests = require('./run-appearance-tests.cjs')
const coreTests = require('./run-core-tests.cjs')
const {
  discoverUnassignedTests,
  findBrokenTestReferences
} = require('./test-discovery.cjs')

const root = join(__dirname, '..')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('every explicitly referenced test file exists on disk', () => {
  const broken = findBrokenTestReferences({
    root,
    packageJson,
    appearanceTests,
    explicitCoreFiles: coreTests.explicitFiles
  })
  assert.deepEqual(broken, [], `Broken test file references:\n${broken.join('\n')}`)
})

test('delegated test runners do not duplicate test files', () => {
  const delegated = [...appearanceTests.unit, ...appearanceTests.ui, ...coreTests.explicitFiles]
  assert.equal(
    new Set(delegated).size,
    delegated.length,
    'registered runners cannot repeat a test file'
  )
})

test('product quality gate scripts exist in package.json', () => {
  for (const script of PRODUCT_SCRIPTS) {
    assert.equal(
      typeof packageJson.scripts[script],
      'string',
      `package.json is missing product gate script "${script}"`
    )
  }
})

test('auto-discovery routes new core/shared tests to core and other tests to product gate', () => {
  const sandbox = join(tmpdir(), `twilight-test-discovery-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(join(sandbox, 'src', 'core'), { recursive: true })
    mkdirSync(join(sandbox, 'src', 'renderer'), { recursive: true })
    mkdirSync(join(sandbox, 'scripts'), { recursive: true })
    writeFileSync(join(sandbox, 'src', 'core', 'owned.test.ts'), '')
    writeFileSync(join(sandbox, 'src', 'core', 'newCore.test.ts'), '')
    writeFileSync(join(sandbox, 'src', 'renderer', 'newUi.test.ts'), '')

    const discovered = discoverUnassignedTests({
      root: sandbox,
      packageJson: { scripts: {} },
      appearanceTests: { unit: [], ui: [] },
      explicitCoreFiles: ['src/core/owned.test.ts']
    })
    assert.deepEqual(discovered.coreTests, ['src/core/newCore.test.ts'])
    assert.deepEqual(discovered.productTests, ['src/renderer/newUi.test.ts'])
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})
