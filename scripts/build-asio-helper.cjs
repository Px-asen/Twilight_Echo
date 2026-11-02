const { spawnSync } = require('node:child_process')
const { join, resolve } = require('node:path')
const {
  prepareAsioMsvcNinjaToolchain,
  resolveAsioMsvcEnvironment,
  cmakeCachePath
} = require('./asio-msvc-toolchain.cjs')

function buildAsioHelper({
  root = resolve(__dirname, '..'),
  arch = 'x86',
  buildDir,
  environment = process.env,
  tests = true
} = {}) {
  const env = resolveAsioMsvcEnvironment({ env: environment })
  const toolchain = prepareAsioMsvcNinjaToolchain({ env, arch })
  if (!toolchain.ok) throw new Error(toolchain.message)
  buildDir = resolve(
    buildDir ||
      (arch === 'x86' && env.TAE_ASIO_X86_BUILD_DIR) ||
      join(root, 'audio-engine', 'build', `asio-helper-msvc-${arch}`)
  )
  const run = (args) => {
    const result = spawnSync(toolchain.cmakePath, args, {
      cwd: root,
      env: toolchain.environment,
      stdio: 'inherit',
      windowsHide: true
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`ASIO ${arch} helper build failed (${result.status})`)
  }
  run([
    '-S',
    join(root, 'audio-engine', 'asio-helper'),
    '-B',
    buildDir,
    '-G',
    'Ninja',
    `-DCMAKE_MAKE_PROGRAM=${cmakeCachePath(toolchain.ninjaPath)}`,
    `-DCMAKE_RC_COMPILER=${cmakeCachePath(toolchain.rcPath)}`,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DTAE_ASIO_HELPER_ARCH=${arch}`,
    `-DTAE_BUILD_TESTS=${tests ? 'ON' : 'OFF'}`
  ])
  run(['--build', buildDir])
  return {
    buildDir,
    artifactPath: join(
      buildDir,
      arch === 'x86' ? 'twilight-asio-helper-x86.exe' : 'twilight-asio-helper.exe'
    )
  }
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2)
    const options = {}
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--arch' && args[i + 1]) options.arch = args[++i]
      else if (args[i] === '--build-dir' && args[i + 1]) options.buildDir = args[++i]
      else throw new Error('Usage: build-asio-helper.cjs [--arch x86|x64] [--build-dir <path>]')
    }
    console.log(JSON.stringify(buildAsioHelper(options)))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { buildAsioHelper }
