const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const { readPeImports, readPeMachine, classifyImports } = require('./pe-imports.cjs')

const ASIO_HELPER_PROTOCOL_VERSION = 7

function verifyAsioHelperPair(nativeDir, { spawn = spawnSync } = {}) {
  for (const [file, architecture, machine] of [
    ['twilight-asio-helper.exe', 'x64', 0x8664],
    ['twilight-asio-helper-x86.exe', 'x86', 0x14c]
  ]) {
    const binary = join(nativeDir, file)
    assert.ok(existsSync(binary), `Missing required ASIO ${architecture} helper: ${binary}`)
    assert.equal(readPeMachine(binary), machine, `${file} must be a Windows ${architecture} PE`)
    if (architecture === 'x86') {
      const imports = readPeImports(binary)
      const { bundled } = classifyImports(imports, { systemDirectory: 'SysWOW64' })
      assert.equal(
        bundled.length,
        0,
        `The x86 helper must use /MT and Windows system DLLs only: ${bundled.join(', ')}`
      )
      assert.ok(
        !imports.some((name) => /^(?:msvcp|vcruntime|ucrtbased)/i.test(name)),
        'The x86 helper must not depend on a shared VC runtime'
      )
    }
    const result = spawn(binary, ['--self-test'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    })
    assert.equal(
      result.status,
      0,
      `${file} self-test failed: ${result.error?.message || result.stderr || ''}`
    )
    const info = JSON.parse(result.stdout)
    assert.equal(info.kind, 'twilight-asio-helper')
    assert.equal(info.status, 'ready')
    assert.equal(info.architecture, architecture, `${file} reported the wrong architecture`)
    assert.equal(
      info.protocolVersion,
      ASIO_HELPER_PROTOCOL_VERSION,
      `${file} is stale; rebuild and stage the engine and both ASIO helpers together`
    )
  }
  const addon = join(nativeDir, 'twilight_audio_node.node')
  assert.ok(existsSync(addon), `Missing audio addon for ASIO protocol validation: ${addon}`)
  const engine = spawn(
    process.execPath,
    [join(__dirname, 'staged-audio-runtime-observation.cjs'), addon],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    }
  )
  assert.equal(
    engine.status,
    0,
    `Cannot inspect the staged audio engine: ${engine.error?.message || engine.stderr || ''}`
  )
  assert.equal(
    JSON.parse(engine.stdout).features?.asioHelperProtocolVersion,
    ASIO_HELPER_PROTOCOL_VERSION,
    'The audio engine and ASIO helpers use different protocols; rebuild and stage them together'
  )
  return { architectures: ['x64', 'x86'], protocolVersion: ASIO_HELPER_PROTOCOL_VERSION }
}

module.exports = { ASIO_HELPER_PROTOCOL_VERSION, verifyAsioHelperPair }
