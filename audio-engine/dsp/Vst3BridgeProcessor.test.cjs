const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { copyFileSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')
const { resolveMingwEnvironment } = require('../../scripts/audio-engine-toolchain.cjs')

test(
  'VST3 bridge transfers 2048 parameters and returns processed audio',
  {
    skip: process.platform !== 'win32',
    // Compilation is setup, and cold Windows CI runners can take over 45 seconds.
    // The processed-audio executable retains its separate 10-second deadline.
    timeout: 150000
  },
  () => {
    const env = resolveMingwEnvironment()
    assert.ok(env.W64DEVKIT_ROOT, 'W64DEVKIT_ROOT is required for the native bridge regression')
    const directory = mkdtempSync(join(tmpdir(), 'twilight-vst3-capacity-'))
    const executable = join(directory, 'bridge-test.exe')
    try {
      const build = spawnSync(
        join(env.W64DEVKIT_ROOT, 'bin', 'g++.exe'),
        [
          '-std=c++20',
          '-static',
          '-municode',
          '-o',
          executable,
          join(__dirname, 'Vst3BridgeProcessor.test.cpp'),
          join(__dirname, 'Vst3BridgeProcessor.cpp')
        ],
        { env, encoding: 'utf8', windowsHide: true, timeout: 120000 }
      )
      assert.equal(build.status, 0, build.error?.message || build.stderr || build.stdout)
      copyFileSync(executable, join(directory, 'twilight-vst3-host.exe'))
      const result = spawnSync(executable, [], {
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000
      })
      assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout)
      assert.match(result.stdout, /received processed audio/)
      assert.match(result.stdout, /helper exited with its audio-service owner/)
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
)
