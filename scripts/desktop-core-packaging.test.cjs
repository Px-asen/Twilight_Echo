'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const yaml = require('js-yaml')
const {
  WINDOWS_NODE_VERSION,
  prepareWindowsDesktopCore,
  shouldBundleWindowsDesktopCore,
  verifyPackagedDesktopCore
} = require('./desktop-core-packaging.cjs')
const { buildStagedElectronBuilderConfig } = require('./packaged-audio-staging.cjs')
const { ENTRIES } = require('./build-desktop-core.cjs')

test('Windows staging uses an explicit matching Node release and rejects other platforms or architectures before build', async () => {
  const root = path.resolve(__dirname, '..'),
    node = path.resolve('pinned-node.exe')
  const calls = []
  const options = {
    root,
    node,
    platform: 'win32',
    arch: 'x64',
    args: ['--win', '--x64'],
    probe: (executable, args, options) => {
      assert.equal(executable, node)
      assert.equal(options.env.NODE_OPTIONS, '')
      assert.deepEqual(args.slice(0, 1), ['-p'])
      return {
        status: 0,
        stdout: JSON.stringify({ version: WINDOWS_NODE_VERSION, platform: 'win32', arch: 'x64' })
      }
    },
    stage: async (value) => {
      calls.push(value)
      return { staged: true }
    }
  }
  assert.deepEqual(await prepareWindowsDesktopCore(options), { staged: true })
  assert.equal(calls[0].node, node)
  assert.equal(calls[0].destination, path.join(root, 'out/desktop-core'))
  assert.equal(
    calls[0].nodeLicense,
    path.join(root, 'resources/server-runtime/node-v24.21.0-LICENSE.txt')
  )
  for (const change of [
    { platform: 'linux' },
    { platform: 'darwin' },
    { arch: 'arm64' },
    { args: ['--win', '--arm64'] }
  ])
    await assert.rejects(() => prepareWindowsDesktopCore({ ...options, ...change }), /Windows x64/)
  await assert.rejects(
    () => prepareWindowsDesktopCore({ ...options, node: 'node' }),
    /absolute path/
  )
  await assert.rejects(
    () =>
      prepareWindowsDesktopCore({
        ...options,
        probe: () => ({
          status: 0,
          stdout: JSON.stringify({ version: 'v22.0.0', platform: 'win32', arch: 'x64' })
        })
      }),
    /Node v24.21.0 x64/
  )
  assert.equal(calls.length, 1)
})

test('default desktop build omits external core-node; opt-in staging injects and verifies complete runtime', (t) => {
  const root = path.resolve(__dirname, '..')
  const rawConfig = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')
  const config = yaml.load(rawConfig)
  assert.ok(!config.extraResources.some((resource) => resource.to === 'core-node'))
  assert.equal(config.win.extraResources, undefined)
  assert.equal(config.mac.extraResources, undefined)
  assert.equal(config.linux.extraResources, undefined)
  for (const excluded of ['!out/server/**', '!out/server-service/**', '!out/renderer/automix-stems/**']) {
    assert.ok(config.files.includes(excluded), `Expected ${excluded} in electron-builder.yml files`)
  }
  assert.equal(shouldBundleWindowsDesktopCore([], {}), false)
  assert.equal(shouldBundleWindowsDesktopCore(['--with-node-core'], {}), true)
  assert.equal(shouldBundleWindowsDesktopCore([], { TWILIGHT_BUNDLE_NODE_CORE: '1' }), true)
  const defaultStaged = yaml.load(
    buildStagedElectronBuilderConfig(rawConfig, root, 'staged/audio-engine', {
      bundleNodeCore: false
    })
  )
  assert.equal(defaultStaged.win.extraResources, undefined)
  const optedInStaged = yaml.load(
    buildStagedElectronBuilderConfig(rawConfig, root, 'staged/audio-engine', {
      bundleNodeCore: true
    })
  )
  assert.deepEqual(
    optedInStaged.win.extraResources.find((resource) => resource.to === 'core-node'),
    { from: 'out/desktop-core', to: 'core-node', filter: ['**/*', '!**/*.map'] }
  )
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-package-node-check-'))
  t.after(() => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()))
    fs.rmSync(temporary, { recursive: true, force: true })
  })
  assert.throws(() => verifyPackagedDesktopCore(temporary, '2.0.0'), /not staged correctly/)
  const runtime = path.join(temporary, 'core-node')
  for (const file of [
    'runtime/node.exe',
    'runtime/LICENSE.txt',
    'package.json',
    ...Object.keys(ENTRIES).map((name) => `out/server/${name}.cjs`)
  ]) {
    fs.mkdirSync(path.dirname(path.join(runtime, file)), { recursive: true })
    fs.writeFileSync(path.join(runtime, file), 'fixture')
  }
  const manifest = {
    schemaVersion: 1,
    nodeVersion: WINDOWS_NODE_VERSION,
    platform: 'win32',
    arch: 'x64',
    applicationVersion: '2.0.0'
  }
  fs.writeFileSync(path.join(runtime, 'desktop-core-runtime.json'), JSON.stringify(manifest))
  assert.deepEqual(verifyPackagedDesktopCore(temporary, '2.0.0'), manifest)
  assert.throws(() => verifyPackagedDesktopCore(temporary, 'next-version'), /does not match/)
  fs.unlinkSync(path.join(runtime, 'out/server/modelPackWorker.cjs'))
  assert.throws(() => verifyPackagedDesktopCore(temporary, '2.0.0'), /not staged correctly/)
})

test('both Windows package entry points gate external Node staging on shouldBundleWindowsDesktopCore before native packaging', () => {
  const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8')
  for (const name of ['build-app-package.cjs', 'build-windows-release.cjs']) {
    const source = read(name)
    assert.ok(source.includes('shouldBundleWindowsDesktopCore('), name)
    const stage = source.indexOf('await prepareWindowsDesktopCore(')
    assert.ok(stage >= 0, name)
    assert.ok(stage < source.indexOf('prepareSmtcMsvc({'), name)
  }
  assert.match(
    read('after-pack-windows.cjs'),
    /verifyPackagedDesktopCore\(join\(context.appOutDir, 'resources'\), context.packager.appInfo.version\)/
  )
})
