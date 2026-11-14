'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildDesktopCore, ENTRIES } = require('./build-desktop-core.cjs')

const WINDOWS_NODE_VERSION = 'v24.21.0'

/** Returns true when packaging should bundle an external Node runtime under resources/core-node. */
function shouldBundleWindowsDesktopCore(args = [], env = process.env) {
  return args.includes('--with-node-core') || env.TWILIGHT_BUNDLE_NODE_CORE === '1'
}

async function prepareWindowsDesktopCore({
  root = path.resolve(__dirname, '..'),
  args = [],
  platform = process.platform,
  arch = process.arch,
  node = process.env.TWILIGHT_DESKTOP_NODE_EXECUTABLE || process.execPath,
  probe = spawnSync,
  stage = buildDesktopCore
} = {}) {
  if (
    platform !== 'win32' ||
    arch !== 'x64' ||
    args.some((arg) => ['--arm64', '--ia32', '--universal'].includes(arg))
  )
    throw new Error('Desktop Node packaging requires a Windows x64 build and target')
  if (!path.isAbsolute(node))
    throw new Error('TWILIGHT_DESKTOP_NODE_EXECUTABLE must be an absolute path')
  const result = probe(
    node,
    ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', ELECTRON_RUN_AS_NODE: '' }
    }
  )
  if (result.error || result.status !== 0)
    throw new Error('Selected desktop Node executable could not start')
  const runtime = JSON.parse(result.stdout)
  if (
    runtime.version !== WINDOWS_NODE_VERSION ||
    runtime.platform !== 'win32' ||
    runtime.arch !== 'x64'
  )
    throw new Error(
      `Windows packages require Node ${WINDOWS_NODE_VERSION} x64. Set TWILIGHT_DESKTOP_NODE_EXECUTABLE to that release's absolute node.exe path; nothing was downloaded.`
    )
  return stage({
    root,
    destination: path.join(root, 'out', 'desktop-core'),
    node,
    nodeLicense: path.join(
      root,
      'resources',
      'server-runtime',
      `node-${WINDOWS_NODE_VERSION}-LICENSE.txt`
    )
  })
}

function verifyPackagedDesktopCore(resources, applicationVersion) {
  const root = path.join(resources, 'core-node')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'desktop-core-runtime.json'), 'utf8'))
    if (
      manifest.schemaVersion !== 1 ||
      manifest.nodeVersion !== WINDOWS_NODE_VERSION ||
      manifest.platform !== 'win32' ||
      manifest.arch !== 'x64' ||
      manifest.applicationVersion !== applicationVersion
    )
      throw new Error('desktop Node runtime version/platform does not match this Windows package')
    for (const name of [
      'runtime/node.exe',
      'runtime/LICENSE.txt',
      'package.json',
      ...Object.keys(ENTRIES).map((entry) => `out/server/${entry}.cjs`)
    ]) {
      if (!fs.statSync(path.join(root, name)).isFile())
        throw new Error(`Missing desktop Core file: ${name}`)
    }
  } catch (cause) {
    throw new Error(
      `Windows desktop Core runtime was not staged correctly. Run scripts/build-app-package.cjs or scripts/build-windows-release.cjs. ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
  return manifest
}

module.exports = {
  WINDOWS_NODE_VERSION,
  prepareWindowsDesktopCore,
  shouldBundleWindowsDesktopCore,
  verifyPackagedDesktopCore
}
