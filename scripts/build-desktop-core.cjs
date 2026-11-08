'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { parseArgs } = require('node:util')
const { copyProductionPackages } = require('./server-package-dependencies.cjs')

const ENTRIES = {
  bootstrap: 'src/main/server/bootstrap.ts',
  musicCore: 'src/main/coreProcess/entry.ts',
  audioEngineService: 'src/main/audioEngineService.ts',
  audioAnalysisService: 'src/main/audioAnalysisService.ts',
  libraryDatabaseService: 'src/main/library/libraryDatabaseService.ts',
  libraryScanService: 'src/main/library/libraryScanService.ts',
  modelPackWorker: 'src/main/coreProcess/modelPackWorker.ts',
  pluginHost: 'src/main/plugins/host.ts'
}

/** Stage a self-contained desktop worker runtime outside app.asar. This uses
 * the same production dependency copier as Server, without a Server profile. */
async function buildDesktopCore({
  root = path.resolve(__dirname, '..'),
  destination = path.join(root, 'out', 'desktop-core'),
  node = process.execPath,
  nodeLicense,
  build
} = {}) {
  const target = path.resolve(destination)
  const parent = path.dirname(target)
  if (target === parent || target === path.resolve(root))
    throw new Error('Invalid desktop Core output directory')
  if (fs.existsSync(target) && !fs.existsSync(path.join(target, 'desktop-core-runtime.json')))
    throw new Error('Desktop Core output already exists and is not a staged runtime')
  const probe = spawnSync(
    node,
    ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', ELECTRON_RUN_AS_NODE: '' }
    }
  )
  if (probe.error || probe.status !== 0)
    throw new Error('The selected Node runtime could not start')
  const runtime = JSON.parse(probe.stdout)
  if (
    !/^v24\.\d+\.\d+$/.test(runtime.version) ||
    runtime.platform !== process.platform ||
    runtime.arch !== process.arch
  )
    throw new Error('Desktop Core requires Node 24 for the build platform and architecture')
  const license =
    nodeLicense ||
    path.join(root, 'resources', 'server-runtime', `node-${runtime.version}-LICENSE.txt`)
  if (!fs.readFileSync(license, 'utf8').startsWith('Node.js is licensed for use as follows:'))
    throw new Error('The selected Node release requires its complete LICENSE')
  const application = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const dependencies = { ...application.dependencies }
  delete dependencies['@electron-toolkit/utils']
  fs.mkdirSync(parent, { recursive: true })
  const staging = fs.mkdtempSync(path.join(parent, '.desktop-core-stage-'))
  const backup = `${staging}.previous`
  let replaced = false
  try {
    await (build ?? buildDesktopCoreChunks)({
      absWorkingDir: root,
      entryPoints: ENTRIES,
      outdir: path.join(staging, 'out', 'server'),
      logLevel: 'info'
    })
    for (const name of Object.keys(ENTRIES)) {
      if (!fs.statSync(path.join(staging, 'out', 'server', `${name}.cjs`)).isFile())
        throw new Error(`Missing desktop Core entry: ${name}`)
    }
    fs.mkdirSync(path.join(staging, 'runtime'))
    fs.copyFileSync(
      node,
      path.join(staging, 'runtime', runtime.platform === 'win32' ? 'node.exe' : 'node')
    )
    if (runtime.platform !== 'win32') fs.chmodSync(path.join(staging, 'runtime', 'node'), 0o755)
    fs.copyFileSync(license, path.join(staging, 'runtime', 'LICENSE.txt'))
    fs.writeFileSync(
      path.join(staging, 'package.json'),
      JSON.stringify(
        {
          name: `${application.name}-desktop-core`,
          version: application.version,
          private: true,
          license: application.license,
          dependencies
        },
        null,
        2
      ) + '\n'
    )
    const packages = copyProductionPackages(root, staging, dependencies)
    const manifest = {
      schemaVersion: 1,
      applicationVersion: application.version,
      nodeVersion: runtime.version,
      platform: runtime.platform,
      arch: runtime.arch,
      entries: Object.keys(ENTRIES),
      packages
    }
    fs.writeFileSync(
      path.join(staging, 'desktop-core-runtime.json'),
      JSON.stringify(manifest, null, 2) + '\n'
    )
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup)
      replaced = true
    }
    try {
      fs.renameSync(staging, target)
    } catch (error) {
      if (replaced) fs.renameSync(backup, target)
      throw error
    }
    if (replaced) removeOwned(backup, parent)
    return { ...manifest, directory: target }
  } catch (error) {
    removeOwned(staging, parent)
    throw error
  }
}

/** One Rollup module graph keeps shared Core ports/state singletons intact while
 * leaving dynamic features in separately parsed CommonJS chunks. */
async function buildDesktopCoreChunks({ absWorkingDir, entryPoints, outdir, logLevel = 'info' }) {
  const { build } = await import('vite')
  return build({
    configFile: false,
    root: absWorkingDir,
    publicDir: false,
    logLevel,
    define: { 'import.meta.url': '__entryUrl', __TWILIGHT_AUTOMIX_EVALUATION__: 'false' },
    build: {
      ssr: true,
      target: 'node24',
      outDir: outdir,
      emptyOutDir: true,
      minify: false,
      sourcemap: 'hidden',
      copyPublicDir: false,
      rollupOptions: {
        input: Object.fromEntries(
          Object.entries(entryPoints).map(([name, entry]) => [
            name,
            path.resolve(absWorkingDir, entry)
          ])
        ),
        external: (id) => !id.startsWith('.') && !id.startsWith('\0') && !path.isAbsolute(id),
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          // Existing service/native asset resolvers use __dirname. Keep shared
          // chunks beside their entry files as electron-vite does.
          chunkFileNames: '[name]-[hash].cjs',
          hoistTransitiveImports: false,
          banner: 'const __entryUrl = require("node:url").pathToFileURL(__filename).href;'
        }
      }
    }
  })
}

function removeOwned(directory, parent) {
  if (
    path.dirname(path.resolve(directory)) !== path.resolve(parent) ||
    !path.basename(directory).startsWith('.desktop-core-stage-')
  )
    throw new Error('Invalid staging cleanup path')
  fs.rmSync(directory, { recursive: true, force: true })
}

module.exports = { buildDesktopCore, buildDesktopCoreChunks, ENTRIES }

if (require.main === module) {
  const { values } = parseArgs({
    options: {
      to: { type: 'string' },
      'output-dir': { type: 'string' },
      node: { type: 'string' },
      'node-license': { type: 'string' }
    }
  })
  if (values.to && values['output-dir']) throw new Error('Use either --output-dir or --to')
  const destination = values['output-dir'] || values.to
  void buildDesktopCore({
    ...(destination ? { destination: path.resolve(destination) } : {}),
    ...(values.node ? { node: path.resolve(values.node) } : {}),
    ...(values['node-license'] ? { nodeLicense: path.resolve(values['node-license']) } : {})
  }).then(
    (result) => console.log(JSON.stringify(result, null, 2)),
    (error) => {
      console.error(error)
      process.exitCode = 1
    }
  )
}
