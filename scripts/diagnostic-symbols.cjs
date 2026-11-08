const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const archiveRoot = () =>
  process.env.TWILIGHT_SYMBOL_DIRECTORY || path.join(root, 'output', 'diagnostic-symbols')
// These digests bind a shipped artifact to its exact symbols, not a general file check.
const artifactId = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function archiveNativeSymbols(file, { originalName = path.basename(file), toolDirectory } = {}) {
  const id = artifactId(file)
  const directory = path.join(archiveRoot(), id)
  if (fs.existsSync(path.join(directory, 'symbols.json')))
    return JSON.parse(fs.readFileSync(path.join(directory, 'symbols.json'), 'utf8'))
  fs.mkdirSync(directory, { recursive: true })
  fs.copyFileSync(file, path.join(directory, originalName))
  const debug = `${originalName}.debug`
  const knownKit =
    process.env.W64DEVKIT_ROOT ||
    (process.platform === 'win32'
      ? require('./audio-engine-toolchain.cjs').resolveMingwEnvironment().W64DEVKIT_ROOT
      : undefined)
  toolDirectory ||= knownKit ? path.join(knownKit, 'bin') : undefined
  const objcopy = toolDirectory
    ? path.join(toolDirectory, 'objcopy.exe')
    : process.platform === 'win32'
      ? 'objcopy.exe'
      : 'objcopy'
  const dsym = process.platform === 'darwin' ? `${originalName}.dSYM` : null
  const result = spawnSync(
    process.platform === 'darwin' ? 'dsymutil' : objcopy,
    process.platform === 'darwin'
      ? [file, '-o', path.join(directory, dsym)]
      : ['--only-keep-debug', file, path.join(directory, debug)],
    {
      windowsHide: true,
      encoding: 'utf8'
    }
  )
  const pdbs = fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.pdb'))
  for (const name of pdbs)
    fs.copyFileSync(path.join(path.dirname(file), name), path.join(directory, name))
  const metadata = {
    schemaVersion: 1,
    artifactId: id,
    binary: originalName,
    debug: !dsym && result.status === 0 ? debug : null,
    dsym: dsym && result.status === 0 ? dsym : null,
    error:
      result.status !== 0
        ? result.error?.message || result.stderr || 'Symbol extraction failed'
        : null,
    pdbs,
    archivedAt: new Date().toISOString()
  }
  fs.writeFileSync(path.join(directory, 'symbols.json'), JSON.stringify(metadata, null, 2))
  return metadata
}
function bindShippedSymbols(file, symbols) {
  const id = artifactId(file)
  const directory = archiveRoot()
  fs.mkdirSync(directory, { recursive: true })
  const indexPath = path.join(directory, 'index.json')
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : {}
  index[id] = symbols
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2))
  return { binary: path.basename(file), artifactId: id, symbolArtifactId: symbols.artifactId }
}
function archiveJavaScriptSymbols(directory) {
  const records = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === 'node_modules') continue
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (/\.(?:js|cjs|mjs)\.map$/.test(file)) {
        const binary = file.slice(0, -4)
        if (!fs.existsSync(binary)) continue
        const id = artifactId(binary),
          archive = path.join(archiveRoot(), id)
        fs.mkdirSync(archive, { recursive: true })
        fs.copyFileSync(binary, path.join(archive, path.basename(binary)))
        fs.copyFileSync(file, path.join(archive, path.basename(file)))
        records.push({
          file: path.relative(directory, binary).replaceAll('\\', '/'),
          artifactId: id,
          map: path.basename(file)
        })
      }
    }
  }
  walk(directory)
  fs.writeFileSync(
    path.join(directory, 'diagnostic-build.json'),
    JSON.stringify(
      { schemaVersion: 1, createdAt: new Date().toISOString(), javascript: records },
      null,
      2
    )
  )
  return records
}
module.exports = {
  archiveRoot,
  artifactId,
  archiveNativeSymbols,
  bindShippedSymbols,
  archiveJavaScriptSymbols
}
