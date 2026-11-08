'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { buildDesktopCore, buildDesktopCoreChunks, ENTRIES } = require('./build-desktop-core.cjs')

test('staged desktop Node and production dependencies run outside the repository without PATH or asar', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-desktop-core-package-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()))
    fs.rmSync(temporary, { recursive: true, force: true })
  })
  const source = path.join(temporary, 'source')
  const destination = path.join(temporary, 'application/resources/core-node')
  fs.mkdirSync(path.join(source, 'node_modules/fixture-production'), { recursive: true })
  fs.writeFileSync(
    path.join(source, 'package.json'),
    JSON.stringify({
      name: 'TwilightFixture',
      version: '1.0.0',
      dependencies: { 'fixture-production': '1.0.0', '@electron-toolkit/utils': '0' }
    })
  )
  fs.writeFileSync(
    path.join(source, 'node_modules/fixture-production/package.json'),
    JSON.stringify({ name: 'fixture-production', version: '1.0.0', main: 'index.js' })
  )
  fs.writeFileSync(
    path.join(source, 'node_modules/fixture-production/index.js'),
    'module.exports = "packaged dependency"'
  )
  const nodeLicense = path.resolve(
    __dirname,
    `../resources/server-runtime/node-${process.version}-LICENSE.txt`
  )
  const build = (options) => {
    fs.mkdirSync(options.outdir, { recursive: true })
    for (const name of Object.keys(options.entryPoints)) {
      fs.writeFileSync(
        path.join(options.outdir, `${name}.cjs`),
        'console.log(JSON.stringify({version:process.version,dependency:require("fixture-production"),electron:process.versions.electron || null}))'
      )
    }
  }
  const result = await buildDesktopCore({
    root: source,
    destination,
    node: process.execPath,
    nodeLicense,
    build
  })
  assert.equal(result.packages.length, 1)
  assert.deepEqual(result.entries, Object.keys(ENTRIES))
  assert.ok(result.entries.includes('modelPackWorker'))
  fs.renameSync(source, `${source}-unavailable`)
  const executable = path.join(
    destination,
    'runtime',
    process.platform === 'win32' ? 'node.exe' : 'node'
  )
  const run = spawnSync(executable, [path.join(destination, 'out/server/musicCore.cjs')], {
    cwd: temporary,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PATH: '', NODE_PATH: '', NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '' }
  })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout), {
    version: process.version,
    dependency: 'packaged dependency',
    electron: null
  })
  assert.equal(
    fs.readFileSync(path.join(destination, 'runtime/LICENSE.txt'), 'utf8'),
    fs.readFileSync(nodeLicense, 'utf8')
  )
  assert.ok(fs.existsSync(path.join(destination, 'desktop-core-runtime.json')))
})

test('desktop staging refuses unrelated output and a failed build preserves a previous runtime', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-desktop-core-failure-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()))
    fs.rmSync(temporary, { recursive: true, force: true })
  })
  const source = path.join(temporary, 'source'),
    destination = path.join(temporary, 'target')
  fs.mkdirSync(source)
  fs.mkdirSync(destination)
  fs.writeFileSync(
    path.join(source, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1', dependencies: {} })
  )
  fs.writeFileSync(path.join(destination, 'existing'), 'preserve')
  await assert.rejects(
    () => buildDesktopCore({ root: source, destination }),
    /not a staged runtime/
  )
  fs.writeFileSync(path.join(destination, 'desktop-core-runtime.json'), '{"schemaVersion":1}')
  await assert.rejects(
    () =>
      buildDesktopCore({
        root: source,
        destination,
        nodeLicense: path.resolve(
          __dirname,
          `../resources/server-runtime/node-${process.version}-LICENSE.txt`
        ),
        build: () => {
          throw Error('build failed')
        }
      }),
    /build failed/
  )
  assert.equal(fs.readFileSync(path.join(destination, 'existing'), 'utf8'), 'preserve')
  assert.deepEqual(fs.readdirSync(temporary).sort(), ['source', 'target'])
})

test('desktop CJS chunks defer features and keep real Core ports shared across entries and first use', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-desktop-chunks-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()))
    fs.rmSync(temporary, { recursive: true, force: true })
  })
  const ports = JSON.stringify(
    path.resolve(__dirname, '../src/core/ports/index.ts').replaceAll('\\', '/')
  )
  const adapter = JSON.stringify(
    path.resolve(__dirname, '../src/adapters-node/index.ts').replaceAll('\\', '/')
  )
  fs.writeFileSync(
    path.join(temporary, 'entry.ts'),
    `
    import { nodeCorePorts } from ${adapter}
    export const registered = nodeCorePorts
    export const loaded = () => globalThis.__twilightFeatureLoads ?? 0
    export async function firstUse() { return (await import('./feature.ts')).use(nodeCorePorts) }
  `
  )
  fs.writeFileSync(
    path.join(temporary, 'other.ts'),
    `
    import { getCorePorts } from ${ports}
    export const current = () => getCorePorts()
  `
  )
  fs.writeFileSync(
    path.join(temporary, 'feature.ts'),
    `
    import { getCorePorts, coreFs } from ${ports}
    import dependency from 'fixture-production'
    globalThis.__twilightFeatureLoads = (globalThis.__twilightFeatureLoads ?? 0) + 1
    export function use(expected) {
      return { same: getCorePorts() === expected, native: coreFs.existsSync(process.execPath), dependency }
    }
  `
  )
  fs.mkdirSync(path.join(temporary, 'node_modules/fixture-production'), { recursive: true })
  fs.writeFileSync(
    path.join(temporary, 'node_modules/fixture-production/package.json'),
    '{"name":"fixture-production","main":"index.js"}'
  )
  fs.writeFileSync(
    path.join(temporary, 'node_modules/fixture-production/index.js'),
    'module.exports = "external dependency"'
  )
  const outdir = path.join(temporary, 'out/server')
  await buildDesktopCoreChunks({
    absWorkingDir: temporary,
    entryPoints: { musicCore: 'entry.ts', other: 'other.ts' },
    outdir,
    logLevel: 'silent'
  })
  assert.ok(fs.readdirSync(outdir).some((name) => /^feature-.*\.cjs$/.test(name)))
  const execution = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict')
    const main = require(${JSON.stringify(path.join(outdir, 'musicCore.cjs'))})
    const other = require(${JSON.stringify(path.join(outdir, 'other.cjs'))})
    assert.equal(main.loaded(), 0)
    assert.equal(main.registered, other.current())
    assert.ok(!Object.keys(require.cache).some(file => /[\\\\/]feature-[^\\\\/]+\\.cjs$/.test(file)))
    main.firstUse().then(async result => {
      assert.deepEqual(result, { same: true, native: true, dependency: 'external dependency' })
      assert.deepEqual(await main.firstUse(), result)
      assert.equal(main.loaded(), 1)
      assert.equal(main.registered, other.current())
      console.log('COLD_FEATURE_AND_SHARED_PORTS_OK')
    }).catch(error => { console.error(error); process.exitCode = 1 })
  `
    ],
    { cwd: temporary, encoding: 'utf8', windowsHide: true }
  )
  assert.equal(execution.status, 0, execution.stderr)
  assert.match(execution.stdout, /COLD_FEATURE_AND_SHARED_PORTS_OK/)
})
