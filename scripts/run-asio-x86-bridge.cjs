const assert = require('node:assert/strict')
const { readFileSync, mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildAsioHelper } = require('./build-asio-helper.cjs')
const { verifyAsioAbiManifests } = require('./verify-asio-abi-manifest.cjs')

const root = resolve(__dirname, '..')
const testTemp = join(root, 'audio-engine', 'build', 'asio-test-temp')
const testEnvironment = { ...process.env, TEMP: testTemp, TMP: testTemp }
function run(binary, args = [], env = testEnvironment, quiet = false) {
  const result = spawnSync(binary, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 90000
  })
  if (result.stdout && !quiet) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert.equal(result.status, 0, `${binary} failed: ${result.error?.message || result.status}`)
  return result.stdout
}

function main() {
  if (process.platform !== 'win32')
    throw new Error('ASIO cross-bitness validation requires Windows')
  mkdirSync(testTemp, { recursive: true })
  const x86 = buildAsioHelper({ arch: 'x86' }).buildDir
  const x64 = process.env.TAE_ASIO_X64_TEST_DIR || buildAsioHelper({ arch: 'x64' }).buildDir
  const goldenLayout = JSON.parse(
    readFileSync(join(root, 'audio-engine/output/asio/helper/asio-helper-layout.json'), 'utf8')
  )
  for (const [arch, dir] of [
    ['x86', x86],
    ['x64', x64]
  ]) {
    const result = verifyAsioAbiManifests({
      goldenPath: join(
        root,
        `audio-engine/output/asio/abi/asio-abi-manifest${arch === 'x86' ? '-x86' : ''}.json`
      ),
      manifestPaths: [join(dir, 'twilight_asio_abi_manifest.exe')]
    })
    assert.ok(result.ok, result.message)
    const layout = JSON.parse(
      run(join(dir, 'twilight_asio_helper_layout.exe'), [], testEnvironment, true)
    )
    assert.deepEqual(layout, goldenLayout, `${arch} IPC layout differs from protocol v6`)
    run(join(dir, 'twilight_asio_abi_checks.exe'))
  }
  run(join(x86, 'twilight_asio_abi_cross_dll_tests.exe'), [], {
    ...testEnvironment,
    TAE_ASIO_FAKE_DRIVER_PATH: join(x86, 'twilight_asio_fake_driver.dll')
  })
  // Existing x64 isolation tests remain the regression baseline. The same
  // parent then repeats them against an actual x86 process (not a mock pointer).
  run(join(x64, 'twilight_asio_helper_process_tests.exe'), [
    join(x64, 'twilight-asio-helper-fixture.exe'),
    join(x64, 'twilight-asio-helper-parent-fixture.exe')
  ])
  run(join(x64, 'twilight_asio_helper_process_tests.exe'), [
    join(x86, 'twilight-asio-helper-fixture.exe'),
    join(x64, 'twilight-asio-helper-parent-fixture.exe'),
    join(x64, 'twilight-asio-helper-fixture.exe')
  ])
  console.log('ASIO x86 ABI, x64 regression, cross-bitness IPC and architecture routing passed.')
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
module.exports = { main }
