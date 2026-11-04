'use strict'
const { spawnSync } = require('node:child_process')
const { mkdirSync, copyFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const toolchain = require('./audio-engine-toolchain.cjs')

function buildServerService({
  root = resolve(__dirname, '..'),
  buildDir = process.env.TWILIGHT_SERVER_SERVICE_BUILD_DIR ||
    join(root, 'native/server-service/build')
} = {}) {
  const source = join(root, 'native/server-service')
  const prepared = toolchain.prepareMingwCmakeEnvironment({
    buildDir,
    env: toolchain.resolveMingwEnvironment()
  })
  if (!prepared.ok) throw new Error(prepared.message)
  mkdirSync(join(buildDir, 'tmp'), { recursive: true })
  const run = (args) => {
    const result = spawnSync('cmake', args, {
      cwd: root,
      env: prepared.environment,
      windowsHide: true,
      stdio: 'inherit'
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Server Service build failed (${result.status})`)
  }
  run(['-S', source, '-B', buildDir, '-G', 'MinGW Makefiles', '-DCMAKE_BUILD_TYPE=Release'])
  run(['--build', buildDir, '--parallel', '4'])
  const staged = join(root, 'out/server-service')
  mkdirSync(staged, { recursive: true })
  const executable = join(staged, 'twilight-server-service.exe')
  copyFileSync(join(buildDir, 'twilight-server-service.exe'), executable)
  copyFileSync(join(buildDir, 'twilight_server_credentials.node'), join(staged, 'twilight_server_credentials.node'))
  return executable
}
if (require.main === module) console.log(buildServerService())
module.exports = { buildServerService }
