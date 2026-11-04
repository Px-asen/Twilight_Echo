'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

function resolvePackage(from, name) {
  // A fixed non-builtin request yields Node's search paths even for packages
  // such as string_decoder which deliberately share a builtin's name.
  const paths = createRequire(path.join(from, 'package.json')).resolve.paths('__twilight_package__')
  for (const root of paths) {
    const candidate = path.join(root, name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate)
  }
  return null
}

/** Preserve the installed dependency graph, including nested versions and peers.
 * No install, lifecycle script, registry request or symlink is needed at runtime. */
function collectProductionPackages(root, roots) {
  root = fs.realpathSync(root)
  const staged = new Map(),
    queue = []
  const add = (source) => {
    if (staged.has(source)) return
    // The repository's install policy is nodeLinker: hoisted. Preserve its
    // real physical locations rather than nesting every transitive import anew.
    const destination = path.relative(root, source).replaceAll('\\', '/')
    if (!destination.startsWith('node_modules/') || destination.split('/').includes('..'))
      throw new Error('生产依赖不在仓库 node_modules 中；请按现有 hoisted 安装策略准备依赖')
    const record = {
      source,
      destination,
      manifest: JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
    }
    staged.set(source, record)
    queue.push(record)
  }
  for (const name of Object.keys(roots).sort()) {
    const source = resolvePackage(root, name)
    if (!source) throw new Error(`缺少已安装的生产依赖：${name}`)
    add(source)
  }
  for (let index = 0; index < queue.length; index++) {
    const record = queue[index],
      manifest = record.manifest
    const names = new Set([
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.optionalDependencies || {}),
      ...Object.keys(manifest.peerDependencies || {})
    ])
    for (const name of [...names].sort()) {
      const optional =
        Object.hasOwn(manifest.optionalDependencies || {}, name) ||
        manifest.peerDependenciesMeta?.[name]?.optional === true
      const source = resolvePackage(record.source, name)
      if (!source) {
        if (optional) continue
        throw new Error(`缺少已安装的生产依赖：${manifest.name} -> ${name}`)
      }
      add(source)
    }
  }
  return queue
}

function copyPackageTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (
      ['node_modules', '.git', 'test', 'tests', '__tests__', 'benchmark', 'benchmarks'].includes(
        entry.name
      )
    )
      continue
    const from = path.join(source, entry.name),
      to = path.join(destination, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`生产包包含链接，未复制：${from}`)
    if (entry.isDirectory()) copyPackageTree(from, to)
    else if (entry.isFile()) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL)
  }
}

function copyProductionPackages(root, destination, roots) {
  const packages = collectProductionPackages(root, roots)
  for (const record of packages)
    copyPackageTree(record.source, path.join(destination, record.destination))
  const inventory = packages.map(({ destination, manifest }) => ({
    path: destination,
    name: manifest.name,
    version: manifest.version
  }))
  // Resolve from the output itself, never accept a package in a parent checkout.
  for (const record of packages) {
    const directory = path.join(destination, record.destination)
    for (const name of [
      ...Object.keys(record.manifest.dependencies || {}),
      ...Object.keys(record.manifest.peerDependencies || {})
    ]) {
      const optional =
        Object.hasOwn(record.manifest.optionalDependencies || {}, name) ||
        record.manifest.peerDependenciesMeta?.[name]?.optional
      const resolved = resolvePackage(directory, name)
      if (optional && !resolved) continue
      if (
        !resolved ||
        path.relative(destination, resolved).startsWith('..') ||
        path.isAbsolute(path.relative(destination, resolved))
      )
        throw new Error(`交付包依赖未闭合：${record.manifest.name} -> ${name}`)
    }
  }
  return inventory
}
module.exports = { resolvePackage, collectProductionPackages, copyProductionPackages }
