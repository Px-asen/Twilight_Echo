const assert = require('node:assert/strict')
const fs = require('node:fs')
const { builtinModules } = require('node:module')
const path = require('node:path')
const asar = require('@electron/asar')
const yaml = require('js-yaml')
const semver = require('semver')
const { collectProductionPackages } = require('./server-package-dependencies.cjs')

const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..')
const BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`)
])
const BUNDLE_ENTRY_PATTERN = /^\/out\/(?:main|preload)\/.*\.(?:c|m)?js$/
const BUNDLE_IMPORT_PATTERN =
  /(?:^|[^\w$.])require\(\s*(['"])([^'"]+)\1\s*\)|(?:^|\s)from\s+(['"])([^'"]+)\3|(?:^|[^\w$.])import\(\s*(['"])([^'"]+)\5\s*\)/gm

function normalizeArchivePath(value) {
  return value.replaceAll('\\', '/')
}

function packageRootFromManifest(manifestPath) {
  return manifestPath.match(/^(.*\/node_modules\/(?:@[^/]+\/[^/]+|[^/]+))\/package\.json$/)?.[1]
}

function resolvePackagedAsarPath(targetPath) {
  const resolved = path.resolve(targetPath)
  if (resolved.endsWith('.asar')) return resolved
  if (resolved.endsWith('.app')) return path.join(resolved, 'Contents', 'Resources', 'app.asar')
  const directCandidates = [
    path.join(resolved, 'resources', 'app.asar'),
    path.join(resolved, 'Contents', 'Resources', 'app.asar')
  ]
  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue
      const bundleCandidate = path.join(resolved, entry.name, 'Contents', 'Resources', 'app.asar')
      if (fs.existsSync(bundleCandidate)) return bundleCandidate
    }
  }
  return path.join(resolved, 'resources', 'app.asar')
}

function dependencyManifestCandidates(packageRoot, dependencyName) {
  const candidates = []
  let cursor = packageRoot
  for (;;) {
    candidates.push(`${cursor}/node_modules/${dependencyName}/package.json`)
    const parentIndex = cursor.lastIndexOf('/node_modules/')
    if (parentIndex <= 0) break
    cursor = cursor.slice(0, parentIndex)
  }
  candidates.push(`/node_modules/${dependencyName}/package.json`)
  return [...new Set(candidates)]
}

function readWorkspaceOverrides(projectRoot) {
  if (!projectRoot) return {}
  const workspacePath = path.join(projectRoot, 'pnpm-workspace.yaml')
  if (!fs.existsSync(workspacePath)) return {}
  const parsed = yaml.load(fs.readFileSync(workspacePath, 'utf8'))
  return parsed && typeof parsed === 'object' && parsed.overrides ? parsed.overrides : {}
}

function isOverriddenVersion(dependencyName, actualVersion, overrides = {}) {
  for (const [selector, pinnedVersion] of Object.entries(overrides)) {
    const atIndex = selector.lastIndexOf('@')
    const packageName = atIndex > 0 ? selector.slice(0, atIndex) : selector
    if (packageName === dependencyName && String(pinnedVersion) === String(actualVersion)) {
      return true
    }
  }
  return false
}

function normalizeDependencyRange(rawRange) {
  if (typeof rawRange !== 'string') return null
  if (rawRange.startsWith('npm:')) {
    const atIndex = rawRange.lastIndexOf('@')
    return atIndex > 4 ? rawRange.slice(atIndex + 1) : null
  }
  return rawRange
}

function findMissingPackageDependencies(manifests) {
  const manifestPaths = new Set(
    [...manifests.keys()].map((packageRoot) => `${packageRoot}/package.json`)
  )
  const missing = []
  for (const [packageRoot, manifest] of manifests) {
    for (const dependencyName of Object.keys(manifest.dependencies || {})) {
      const resolved = dependencyManifestCandidates(packageRoot, dependencyName).some((candidate) =>
        manifestPaths.has(candidate)
      )
      if (!resolved) missing.push(`${manifest.name || packageRoot} -> ${dependencyName}`)
    }
  }
  return [...new Set(missing)].sort()
}

function findUnsatisfiedDependencyRanges(manifests, { overrides = {} } = {}) {
  const unsatisfied = []
  for (const [packageRoot, manifest] of manifests) {
    for (const [dependencyName, rawRange] of Object.entries(manifest.dependencies || {})) {
      const resolved = dependencyManifestCandidates(packageRoot, dependencyName)
        .map((candidate) => manifests.get(candidate.slice(0, -'/package.json'.length)))
        .find(Boolean)
      if (!resolved?.version) continue
      if (isOverriddenVersion(dependencyName, resolved.version, overrides)) continue
      const range = normalizeDependencyRange(rawRange)
      if (!range || !semver.validRange(range)) continue
      if (!semver.satisfies(resolved.version, range, { includePrerelease: true })) {
        unsatisfied.push(
          `${manifest.name || packageRoot} -> ${dependencyName}@${rawRange}: found ${resolved.version}`
        )
      }
    }
  }
  return [...new Set(unsatisfied)].sort()
}

function findUnexpectedPackageVersions(manifests, expectedPackages) {
  const unexpected = expectedPackages.flatMap(({ destination, manifest }) => {
    const actual = manifests.get('/' + destination)
    if (!actual) return [`${manifest.name}@${manifest.version} missing at ${destination}`]
    return actual.version === manifest.version
      ? []
      : [`${destination}: expected ${manifest.version}, found ${actual.version}`]
  })
  const expected = new Map(
    expectedPackages.map(({ destination, manifest }) => ['/' + destination, manifest])
  )
  for (const [packageRoot, manifest] of expected) {
    for (const name of Object.keys(manifest.dependencies || {})) {
      const candidates = dependencyManifestCandidates(packageRoot, name).map((candidate) =>
        candidate.slice(0, -'/package.json'.length)
      )
      const installed = candidates.map((candidate) => expected.get(candidate)).find(Boolean)
      const actual = candidates.map((candidate) => manifests.get(candidate)).find(Boolean)
      if (installed && actual && installed.version !== actual.version) {
        unexpected.push(
          `${manifest.name} -> ${name}: expected ${installed.version}, found ${actual.version}`
        )
      }
    }
  }
  return [...new Set(unexpected)].sort()
}

function parseExternalSpecifier(specifier) {
  if (
    !specifier ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:') ||
    specifier.startsWith('data:') ||
    specifier.startsWith('file:') ||
    BUILTIN_MODULES.has(specifier)
  ) {
    return null
  }
  const segments = specifier.split('/')
  if (specifier.startsWith('@')) {
    if (segments.length < 2) return null
    return {
      packageName: `${segments[0]}/${segments[1]}`,
      subpath: segments.slice(2).join('/')
    }
  }
  const packageName = segments[0]
  const subpath = segments.slice(1).join('/')
  if (subpath && BUILTIN_MODULES.has(packageName)) return null
  return { packageName, subpath }
}

function collectExportTargetStrings(target, results = []) {
  if (typeof target === 'string') {
    results.push(target)
  } else if (Array.isArray(target)) {
    for (const item of target) collectExportTargetStrings(item, results)
  } else if (target && typeof target === 'object') {
    for (const value of Object.values(target)) collectExportTargetStrings(value, results)
  }
  return results
}

function resolveSubpathInPackage(packageRoot, manifest, subpath, archivePaths) {
  if (!subpath) return true
  const exportsField = manifest?.exports
  if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    const requestedKey = `./${subpath}`
    if (Object.hasOwn(exportsField, requestedKey)) {
      return collectExportTargetStrings(exportsField[requestedKey]).some((target) =>
        archivePaths.has(`${packageRoot}/${target.replace(/^\.\//, '')}`)
      )
    }
    for (const [pattern, targetSpec] of Object.entries(exportsField)) {
      const wildcardIndex = pattern.indexOf('*')
      if (wildcardIndex < 0) continue
      const prefix = pattern.slice(0, wildcardIndex)
      const suffix = pattern.slice(wildcardIndex + 1)
      if (!requestedKey.startsWith(prefix) || !requestedKey.endsWith(suffix)) continue
      const captured = requestedKey.slice(prefix.length, requestedKey.length - suffix.length)
      const matched = collectExportTargetStrings(targetSpec).some((target) =>
        archivePaths.has(`${packageRoot}/${target.replaceAll('*', captured).replace(/^\.\//, '')}`)
      )
      if (matched) return true
    }
    return false
  }
  const basePath = `${packageRoot}/${subpath}`
  return [
    basePath,
    `${basePath}.js`,
    `${basePath}.cjs`,
    `${basePath}.mjs`,
    `${basePath}.json`,
    `${basePath}/index.js`,
    `${basePath}/index.cjs`,
    `${basePath}/index.mjs`
  ].some((candidate) => archivePaths.has(candidate))
}

function extractBundleExternalSpecifiers(sourceCode) {
  const specifiers = new Set()
  for (const match of sourceCode.matchAll(BUNDLE_IMPORT_PATTERN)) {
    const raw = match[2] || match[4] || match[6]
    if (raw) specifiers.add(raw)
  }
  return [...specifiers].sort()
}

function findUnresolvedBundleImports(
  asarPath,
  manifests,
  archiveEntryByPath,
  { externalPackages = [] } = {}
) {
  const external = new Set(externalPackages)
  const archivePaths = new Set(archiveEntryByPath.keys())
  const unresolved = []
  for (const [archivePath, rawEntry] of archiveEntryByPath) {
    if (!BUNDLE_ENTRY_PATTERN.test(archivePath)) continue
    const sourceCode = asar.extractFile(asarPath, rawEntry.slice(1)).toString('utf8')
    for (const specifier of extractBundleExternalSpecifiers(sourceCode)) {
      const parsed = parseExternalSpecifier(specifier)
      if (!parsed || external.has(parsed.packageName)) continue
      const packageRoot = `/node_modules/${parsed.packageName}`
      const manifest = manifests.get(packageRoot)
      if (
        !manifest ||
        !resolveSubpathInPackage(packageRoot, manifest, parsed.subpath, archivePaths)
      ) {
        unresolved.push(`${archivePath} -> ${specifier}`)
      }
    }
  }
  return [...new Set(unresolved)].sort()
}

function readPackagedArchive(asarPath) {
  assert.ok(fs.existsSync(asarPath), `Packaged app.asar not found: ${asarPath}`)
  const archiveEntries = asar.listPackage(asarPath)
  const archiveEntryByPath = new Map(
    archiveEntries.map((entry) => [normalizeArchivePath(entry), entry])
  )
  const manifests = new Map()
  for (const [manifestPath, archiveEntry] of archiveEntryByPath) {
    const packageRoot = packageRootFromManifest(manifestPath)
    if (!packageRoot) continue
    const contents = asar.extractFile(asarPath, archiveEntry.slice(1))
    manifests.set(packageRoot, JSON.parse(contents.toString('utf8')))
  }
  return { manifests, archiveEntryByPath }
}

function readPackagedManifests(asarPath) {
  return readPackagedArchive(asarPath).manifests
}

function verifyPackagedDependencyClosure(
  targetPath,
  { projectRoot, externalPackages = ['electron'], overrides } = {}
) {
  const asarPath = resolvePackagedAsarPath(targetPath)
  const { manifests, archiveEntryByPath } = readPackagedArchive(asarPath)
  const missing = findMissingPackageDependencies(manifests)
  assert.deepEqual(missing, [], `Missing packaged runtime dependencies:\n${missing.join('\n')}`)

  const effectiveOverrides =
    overrides ?? readWorkspaceOverrides(projectRoot || DEFAULT_PROJECT_ROOT)
  const unsatisfied = findUnsatisfiedDependencyRanges(manifests, { overrides: effectiveOverrides })
  assert.deepEqual(
    unsatisfied,
    [],
    `Packaged runtime dependency version ranges are unsatisfied:\n${unsatisfied.join('\n')}`
  )

  const unresolvedBundleImports = findUnresolvedBundleImports(
    asarPath,
    manifests,
    archiveEntryByPath,
    { externalPackages }
  )
  assert.deepEqual(
    unresolvedBundleImports,
    [],
    `Unresolved external imports in packaged bundles:\n${unresolvedBundleImports.join('\n')}`
  )

  if (projectRoot) {
    const metadata = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    const expected = collectProductionPackages(projectRoot, metadata.dependencies || {}, {
      externalPackages
    })
    // The frozen installation includes intentional overrides; preserve those
    // exact versions and Node resolution paths rather than reinterpreting ranges.
    const unexpected = findUnexpectedPackageVersions(manifests, expected)
    assert.deepEqual(
      unexpected,
      [],
      `Packaged runtime graph differs from installation:\n${unexpected.join('\n')}`
    )
  }
  return { packages: manifests.size, asarPath }
}

function main(args = process.argv.slice(2)) {
  let standalone = false
  let projectRoot = DEFAULT_PROJECT_ROOT
  const positional = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--standalone') {
      standalone = true
      continue
    }
    if (arg === '--project-root') {
      projectRoot = path.resolve(args[++index] || '')
      continue
    }
    if (arg.startsWith('--project-root=')) {
      projectRoot = path.resolve(arg.slice('--project-root='.length))
      continue
    }
    positional.push(arg)
  }
  assert.equal(
    positional.length,
    1,
    'Usage: node scripts/verify-packaged-dependency-closure.cjs [--standalone] [--project-root <dir>] <app.asar|app-dir|App.app>'
  )
  const result = verifyPackagedDependencyClosure(positional[0], {
    projectRoot: standalone ? undefined : projectRoot,
    externalPackages: ['electron']
  })
  console.log(`Packaged dependency closure verified: ${result.packages} packages`)
}

if (require.main === module) main()

module.exports = {
  dependencyManifestCandidates,
  extractBundleExternalSpecifiers,
  findMissingPackageDependencies,
  findUnexpectedPackageVersions,
  findUnresolvedBundleImports,
  findUnsatisfiedDependencyRanges,
  isOverriddenVersion,
  normalizeArchivePath,
  packageRootFromManifest,
  parseExternalSpecifier,
  readPackagedArchive,
  readPackagedManifests,
  readWorkspaceOverrides,
  resolvePackagedAsarPath,
  resolveSubpathInPackage,
  verifyPackagedDependencyClosure
}
