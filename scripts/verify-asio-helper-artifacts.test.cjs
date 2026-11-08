const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createMinimalPe } = require('./pe-fixture.cjs')
const {
  verifyAsioHelperPair,
  ASIO_HELPER_PROTOCOL_VERSION
} = require('./verify-asio-helper-artifacts.cjs')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asio-helper-pair-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'twilight-asio-helper.exe'), createMinimalPe())
  fs.writeFileSync(path.join(dir, 'twilight_audio_node.node'), createMinimalPe())
  fs.writeFileSync(
    path.join(dir, 'twilight-asio-helper-x86.exe'),
    createMinimalPe({ machine: 0x14c })
  )
  return dir
}
function spawn(binary) {
  if (binary === process.execPath)
    return {
      status: 0,
      stdout: JSON.stringify({
        features: { asioHelperProtocolVersion: ASIO_HELPER_PROTOCOL_VERSION }
      })
    }
  return {
    status: 0,
    stdout: JSON.stringify({
      kind: 'twilight-asio-helper',
      status: 'ready',
      architecture: binary.endsWith('-x86.exe') ? 'x86' : 'x64',
      protocolVersion: ASIO_HELPER_PROTOCOL_VERSION
    })
  }
}

test('release pair verifies both PE machines and protocol self-tests', (t) => {
  const dir = fixture(t)
  assert.deepEqual(verifyAsioHelperPair(dir, { spawn }).architectures, ['x64', 'x86'])
  const source = fs.readFileSync(
    path.join(__dirname, '../audio-engine/output/asio/helper/AsioHelperVersion.h'),
    'utf8'
  )
  assert.match(source, new RegExp(`kProtocolVersion = ${ASIO_HELPER_PROTOCOL_VERSION};`))
})
test('a stale engine cannot ship with a current helper pair', (t) => {
  const dir = fixture(t)
  assert.throws(
    () =>
      verifyAsioHelperPair(dir, {
        spawn: (binary) =>
          binary === process.execPath
            ? { status: 0, stdout: '{"features":{"asioHelperProtocolVersion":5}}' }
            : spawn(binary)
      }),
    /different protocols/
  )
})
test('release fails for a missing or incorrectly built x86 helper', (t) => {
  const dir = fixture(t)
  const binary = path.join(dir, 'twilight-asio-helper-x86.exe')
  fs.writeFileSync(binary, createMinimalPe())
  assert.throws(() => verifyAsioHelperPair(dir, { spawn }), /must be a Windows x86 PE/)
  fs.rmSync(binary)
  assert.throws(() => verifyAsioHelperPair(dir, { spawn }), /Missing required ASIO x86 helper/)
})
test('release rejects stale protocol and architecture metadata', (t) => {
  const dir = fixture(t)
  for (const patch of [{ protocolVersion: 6 }, { architecture: 'arm64' }]) {
    assert.throws(() =>
      verifyAsioHelperPair(dir, {
        spawn: (binary) => {
          const result = spawn(binary)
          return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), ...patch }) }
        }
      })
    )
  }
})
test('x86 helper cannot pull same-named x64 runtime DLLs into its directory', (t) => {
  const dir = fixture(t)
  for (const dependency of ['vcruntime140.dll', 'libstdc++-6.dll']) {
    fs.writeFileSync(
      path.join(dir, 'twilight-asio-helper-x86.exe'),
      createMinimalPe({ machine: 0x14c, imports: [dependency] })
    )
    assert.throws(() => verifyAsioHelperPair(dir, { spawn }), /runtime|system DLLs/)
  }
})
