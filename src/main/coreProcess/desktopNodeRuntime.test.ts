import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  DESKTOP_NODE_ENTRIES,
  desktopCoreHost,
  desktopElectronNodeEnvironment,
  desktopNodeEnvironment,
  inProcessWorkerServicesEnabled,
  resolveDesktopNodeRuntime
} from './desktopNodeRuntime.ts'

test('desktop Core host defaults to electron-node and command line selection wins over environment', () => {
  assert.equal(desktopCoreHost([], {}), 'electron-node')
  assert.equal(desktopCoreHost([], { TWILIGHT_CORE_HOST: 'electron' }), 'electron')
  assert.equal(desktopCoreHost([], { TWILIGHT_CORE_HOST: 'node' }), 'node')
  assert.equal(
    desktopCoreHost(['--core-host=electron'], { TWILIGHT_CORE_HOST: 'node' }),
    'electron'
  )
  assert.equal(
    desktopCoreHost(['--core-host=electron-node'], { TWILIGHT_CORE_HOST: 'electron' }),
    'electron-node'
  )
  assert.equal(desktopCoreHost(['--core-host', 'node'], {}), 'node')
  assert.throws(() => desktopCoreHost(['--core-host'], {}), /Unsupported Core host/)
  assert.throws(
    () => desktopCoreHost([], { TWILIGHT_CORE_HOST: '/external/node' }),
    /Unsupported Core host/
  )
  assert.deepEqual(inProcessWorkerServicesEnabled('electron-node', [], {}), ['database', 'scan'])
  assert.deepEqual(inProcessWorkerServicesEnabled('electron', [], {}), ['database', 'scan'])
  assert.equal(inProcessWorkerServicesEnabled('node', [], {}), undefined)
  assert.equal(
    inProcessWorkerServicesEnabled('electron-node', ['--isolate-all-services'], {}),
    undefined
  )
  assert.equal(
    inProcessWorkerServicesEnabled('electron-node', [], { TWILIGHT_CORE_WORKER_THREADS: '0' }),
    undefined
  )
  const electronNodeEnv = desktopElectronNodeEnvironment('/app/resources', {
    NODE_OPTIONS: '--require injected',
    NODE_PATH: 'outside',
    TWILIGHT_LOG_SESSION_ID: 'session'
  })
  assert.equal(electronNodeEnv.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(electronNodeEnv.NODE_OPTIONS, undefined)
  assert.equal(electronNodeEnv.NODE_PATH, undefined)
  assert.equal(electronNodeEnv.TWILIGHT_DESKTOP_NODE_HOST, '1')
  assert.equal(electronNodeEnv.TWILIGHT_DESKTOP_RESOURCES_PATH, '/app/resources')
  assert.equal(electronNodeEnv.TWILIGHT_LOG_SESSION_ID, 'session')
})

test('desktop resolver uses complete package-owned entries outside asar and fails closed on missing runtime', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-desktop-node-'))
  t.after(() => {
    assert.equal(resolve(directory, '..'), resolve(tmpdir()))
    rmSync(directory, { recursive: true, force: true })
  })
  const resources = join(directory, 'resources')
  const root = join(resources, 'core-node')
  mkdirSync(join(root, 'runtime'), { recursive: true })
  mkdirSync(join(root, 'out/server'), { recursive: true })
  writeFileSync(
    join(root, 'desktop-core-runtime.json'),
    JSON.stringify({ schemaVersion: 1, nodeVersion: 'v24.21.0', platform: 'win32', arch: 'x64' })
  )
  writeFileSync(join(root, 'runtime/node.exe'), 'fixture')
  writeFileSync(join(root, 'runtime/LICENSE.txt'), 'license')
  for (const name of DESKTOP_NODE_ENTRIES)
    writeFileSync(join(root, 'out/server', `${name}.cjs`), 'fixture')
  const options = {
    packaged: true,
    appPath: join(resources, 'app.asar'),
    resourcesPath: resources,
    platform: 'win32' as const,
    arch: 'x64'
  }
  const runtime = resolveDesktopNodeRuntime(options)
  assert.equal(runtime.executable, join(root, 'runtime/node.exe'))
  assert.equal(runtime.entries.core, join(root, 'out/server/musicCore.cjs'))
  assert.equal(runtime.resourcesPath, resources)
  assert.equal(runtime.entries.audio, runtime.entries['audio-test'])
  assert.throws(() => resolveDesktopNodeRuntime({ ...options, arch: 'arm64' }), /platform\/version/)
  assert.throws(() => resolveDesktopNodeRuntime({ ...options, packaged: false }), /Build\/stage/)
  const env = desktopNodeEnvironment(runtime, {
    PATH: 'user-path',
    NODE_PATH: 'outside',
    NODE_OPTIONS: '--require injected',
    ELECTRON_RUN_AS_NODE: '1',
    LD_PRELOAD: '/packaged/libavformat.so',
    TWILIGHT_LOG_SESSION_ID: 'session'
  })
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.NODE_PATH, undefined)
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(env.PATH, 'user-path')
  assert.equal(env.LD_PRELOAD, '/packaged/libavformat.so')
  assert.equal(env.TWILIGHT_LOG_SESSION_ID, 'session')
  assert.equal(env.TWILIGHT_DESKTOP_RESOURCES_PATH, resources)
  unlinkSync(runtime.entries.scan)
  assert.throws(() => resolveDesktopNodeRuntime(options), /libraryScanService/)
})

test('development Node runtime uses staged output and refuses an entry linked outside the package', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-desktop-node-dev-'))
  t.after(() => {
    assert.equal(resolve(directory, '..'), resolve(tmpdir()))
    rmSync(directory, { recursive: true, force: true })
  })
  const root = join(directory, 'out/desktop-core')
  mkdirSync(join(root, 'runtime'), { recursive: true })
  mkdirSync(join(root, 'out/server'), { recursive: true })
  writeFileSync(
    join(root, 'desktop-core-runtime.json'),
    JSON.stringify({
      schemaVersion: 1,
      nodeVersion: 'v24.21.0',
      platform: process.platform,
      arch: process.arch
    })
  )
  writeFileSync(
    join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
    'fixture'
  )
  writeFileSync(join(root, 'runtime/LICENSE.txt'), 'license')
  for (const name of DESKTOP_NODE_ENTRIES)
    writeFileSync(join(root, 'out/server', `${name}.cjs`), 'fixture')
  const options = { packaged: false, appPath: directory, resourcesPath: 'ignored' }
  const runtime = resolveDesktopNodeRuntime(options)
  assert.equal(runtime.resourcesPath, join(directory, 'resources'))
  const outside = join(directory, 'external')
  mkdirSync(outside)
  writeFileSync(join(outside, 'bootstrap.cjs'), 'untrusted')
  rmSync(join(root, 'out/server'), { recursive: true, force: true })
  symlinkSync(outside, join(root, 'out/server'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => resolveDesktopNodeRuntime(options), /outside its package/)
})
