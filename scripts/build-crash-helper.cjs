const { spawnSync } = require('node:child_process')
const { mkdirSync, copyFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const {
  prepareAsioMsvcNinjaToolchain,
  resolveAsioMsvcEnvironment,
  cmakeCachePath
} = require('./asio-msvc-toolchain.cjs')
const { archiveNativeSymbols, bindShippedSymbols } = require('./diagnostic-symbols.cjs')
function buildCrashHelpers({ root = resolve(__dirname, '..'), stage = true } = {}) {
  const results = []
  for (const arch of ['x64', 'x86']) {
    const toolchain = prepareAsioMsvcNinjaToolchain({
      env: resolveAsioMsvcEnvironment({ env: process.env }),
      arch
    })
    if (!toolchain.ok) throw new Error(toolchain.message)
    const buildDir = join(root, 'audio-engine', 'build', `crash-helper-${arch}`)
    const run = (args) => {
      const result = spawnSync(toolchain.cmakePath, args, {
        cwd: root,
        env: toolchain.environment,
        stdio: 'inherit',
        windowsHide: true
      })
      if (result.error || result.status !== 0)
        throw result.error || new Error(`Crash helper ${arch} build failed`)
    }
    run([
      '-S',
      join(root, 'audio-engine', 'diagnostics'),
      '-B',
      buildDir,
      '-G',
      'Ninja',
      `-DCMAKE_MAKE_PROGRAM=${cmakeCachePath(toolchain.ninjaPath)}`,
      `-DCMAKE_RC_COMPILER=${cmakeCachePath(toolchain.rcPath)}`,
      '-DCMAKE_BUILD_TYPE=Release'
    ])
    run(['--build', buildDir])
    const name = `twilight-crash-helper${arch === 'x86' ? '-x86' : ''}.exe`
    if (stage) {
      mkdirSync(join(root, 'resources', 'audio-engine'), { recursive: true })
      const symbols = archiveNativeSymbols(join(buildDir, name))
      copyFileSync(join(buildDir, name), join(root, 'resources', 'audio-engine', name))
      bindShippedSymbols(join(root, 'resources', 'audio-engine', name), symbols)
    }
    results.push({
      arch,
      buildDir,
      executable: join(buildDir, name),
      fixture: join(buildDir, 'twilight-crash-fixture.exe')
    })
  }
  return results
}
if (require.main === module) console.log(JSON.stringify(buildCrashHelpers()))
module.exports = { buildCrashHelpers }
