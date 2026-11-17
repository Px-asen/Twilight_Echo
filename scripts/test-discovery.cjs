'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SCAN_DIRECTORIES = ['scripts', 'src', 'packages', 'resources']
const CONTAINER_OWNED_TESTS = ['scripts/server-container.test.cjs']
const TEST_FILE_PATTERN = /\.test\.(?:ts|cjs|mjs)$/
const EXPLICIT_SCRIPT_TOKEN_PATTERN =
  /^(?:src|scripts|packages|resources|audio-engine)\/\S+\.test\.(?:ts|cjs|mjs)$/

function collectRepositoryTestFiles(root = ROOT) {
  const results = []
  const walk = (directory) => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (TEST_FILE_PATTERN.test(entry.name)) {
        results.push(path.relative(root, fullPath).replaceAll('\\', '/'))
      }
    }
  }
  for (const dir of SCAN_DIRECTORIES) {
    walk(path.join(root, dir))
  }
  return results.sort()
}

function collectPackageScriptTestTokens(packageJson, root = ROOT) {
  if (!packageJson) {
    packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  }
  const tokens = []
  for (const [scriptName, command] of Object.entries(packageJson.scripts ?? {})) {
    if (!scriptName.startsWith('test:') || typeof command !== 'string') continue
    for (const rawToken of command.split(/\s+/)) {
      const cleaned = rawToken.replace(/^['"]|['"]$/g, '')
      if (EXPLICIT_SCRIPT_TOKEN_PATTERN.test(cleaned)) {
        tokens.push({ scriptName, file: cleaned })
      }
    }
  }
  return tokens
}

function collectExplicitlyOwnedTests(options = {}) {
  const root = options.root ?? ROOT
  const packageJson =
    options.packageJson ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const appearanceTests = options.appearanceTests ?? require('./run-appearance-tests.cjs')
  const explicitCoreFiles =
    options.explicitCoreFiles ?? require('./run-core-tests.cjs').explicitFiles

  const scriptTokens = collectPackageScriptTestTokens(packageJson, root)
  const owned = new Set(scriptTokens.map((item) => item.file))
  for (const file of appearanceTests.unit) owned.add(file)
  for (const file of appearanceTests.ui) owned.add(file)
  for (const file of explicitCoreFiles) owned.add(file)
  for (const file of CONTAINER_OWNED_TESTS) owned.add(file)
  return { owned, scriptTokens, appearanceTests, explicitCoreFiles }
}

function discoverUnassignedTests(options = {}) {
  const root = options.root ?? ROOT
  const allTestFiles = collectRepositoryTestFiles(root)
  const { owned } = collectExplicitlyOwnedTests(options)
  const unassigned = allTestFiles.filter((file) => !owned.has(file))
  const coreTests = []
  const productTests = []
  for (const file of unassigned) {
    if (file.startsWith('src/core/') || file.startsWith('src/shared/')) {
      coreTests.push(file)
    } else {
      productTests.push(file)
    }
  }
  return { allTestFiles, unassigned, coreTests, productTests }
}

function mergeCoreTestFiles(explicitCoreFiles, options = {}) {
  const { coreTests } = discoverUnassignedTests({ ...options, explicitCoreFiles })
  return [...new Set([...explicitCoreFiles, ...coreTests])]
}

function findBrokenTestReferences(options = {}) {
  const root = options.root ?? ROOT
  const { scriptTokens, appearanceTests, explicitCoreFiles } = collectExplicitlyOwnedTests(options)
  const broken = []
  const check = (source, file) => {
    if (!fs.existsSync(path.join(root, file))) {
      broken.push(`${source}: ${file}`)
    }
  }
  for (const { scriptName, file } of scriptTokens) {
    check(`package.json#${scriptName}`, file)
  }
  for (const file of appearanceTests.unit) check('run-appearance-tests.cjs#unit', file)
  for (const file of appearanceTests.ui) check('run-appearance-tests.cjs#ui', file)
  for (const file of explicitCoreFiles) check('run-core-tests.cjs', file)
  for (const file of CONTAINER_OWNED_TESTS) check('container', file)
  return broken
}

module.exports = {
  CONTAINER_OWNED_TESTS,
  collectExplicitlyOwnedTests,
  collectPackageScriptTestTokens,
  collectRepositoryTestFiles,
  discoverUnassignedTests,
  findBrokenTestReferences,
  mergeCoreTestFiles
}
