'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  deriveTypecheckTargets,
  filterLintableFiles,
  parseCliArgs
} = require('./local-gate.cjs')

test('parseCliArgs supports fast, changed, staged, push, ci, quiet, hook, and --files modes', () => {
  assert.deepEqual(parseCliArgs(['--fast', '--staged']), {
    mode: 'fast',
    staged: true,
    push: false,
    ci: false,
    quiet: false,
    hook: false,
    explicitFiles: null
  })
  assert.deepEqual(parseCliArgs(['--hook']), {
    mode: 'changed',
    staged: false,
    push: false,
    ci: false,
    quiet: true,
    hook: true,
    explicitFiles: null
  })
  assert.deepEqual(parseCliArgs(['--changed', '--files', 'src\\main\\index.ts', 'package.json']), {
    mode: 'changed',
    staged: false,
    push: false,
    ci: false,
    quiet: false,
    hook: false,
    explicitFiles: ['src/main/index.ts', 'package.json']
  })
  assert.throws(() => parseCliArgs(['--unknown']), /Unknown local-gate flag/)
})

test('deriveTypecheckTargets maps core/shared to full matrix + portableCore and scopes main/renderer', () => {
  assert.deepEqual(deriveTypecheckTargets(['src/renderer/src/App.vue']), {
    core: false,
    node: false,
    web: true,
    portableCore: false
  })
  assert.deepEqual(deriveTypecheckTargets(['src/main/index.ts']), {
    core: false,
    node: true,
    web: false,
    portableCore: false
  })
  assert.deepEqual(deriveTypecheckTargets(['src/preload/types.ts']), {
    core: false,
    node: true,
    web: true,
    portableCore: false
  })
  assert.deepEqual(deriveTypecheckTargets(['src/core/application.ts']), {
    core: true,
    node: true,
    web: true,
    portableCore: true
  })
})

test('filterLintableFiles excludes hidden dot-paths, build outputs, and vendor trees', () => {
  const filtered = filterLintableFiles([
    '.cache/lint-check.cjs',
    '.vscode/helper.js',
    'out/main/index.js',
    'scripts/local-gate.cjs',
    'README.md'
  ])
  assert.deepEqual(filtered, ['scripts/local-gate.cjs'])
})
