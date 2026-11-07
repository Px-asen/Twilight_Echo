'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { inspectLinuxNativeRuntime, inspectLinuxAutoMixInputs, stageLinuxServer } = require('./stage-linux-server.cjs')
const { serverTestNodeExecutable } = require('./server-cli.test.cjs')

test('package migration gates use image Node on Linux and the embedded Node in Windows ZIPs', () => {
  const application = path.resolve('migration-package')
  const executable = path.resolve('image-runtime', 'node')
  assert.equal(serverTestNodeExecutable(application, { platform: 'linux', executable }), executable)
  assert.equal(serverTestNodeExecutable(undefined, { platform: 'linux', executable }), executable)
  assert.equal(serverTestNodeExecutable(undefined, { platform: 'win32', executable }), executable)
  // This intentionally does not test existence and fall back to the host Node:
  // a Windows ZIP missing its runtime must still fail its integration gate.
  assert.equal(
    serverTestNodeExecutable(application, { platform: 'win32', executable }),
    path.join(application, 'runtime/node.exe')
  )
})

test('Linux binary inspection rejects PE, wrong architecture, endianness and truncated ELF before staging', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-linux-inputs-'))
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }) })
  const names = ['libtwilight-audio-engine.so', 'libtwilight-soxr.so', 'twilight_audio_node.node', 'twilight_image_node.node']
  const header = Buffer.alloc(20); header.write('7f454c46', 0, 'hex'); header[4] = 2; header[5] = 1; header.writeUInt16LE(62, 18)
  for (const name of names) fs.writeFileSync(path.join(root, name), header)
  assert.deepEqual(inspectLinuxNativeRuntime(root), names)
  const elf32 = Buffer.from(header); elf32[4] = 1
  const bigEndian = Buffer.from(header); bigEndian[5] = 2
  for (const invalid of [Buffer.from('MZ'), header.subarray(0, 10), elf32, bigEndian]) {
    fs.writeFileSync(path.join(root, names[0]), invalid)
    assert.throws(() => inspectLinuxNativeRuntime(root), /x86_64 ELF/)
  }
  const arm = Buffer.from(header); arm.writeUInt16LE(183, 18)
  fs.writeFileSync(path.join(root, names[0]), arm)
  assert.throws(() => inspectLinuxNativeRuntime(root), /x86_64 ELF/)
})

test('Linux inputs include locked public graphs, exact notices and all optional worker sources', () => {
  const root = path.resolve(__dirname, '..')
  const result = inspectLinuxAutoMixInputs(root)
  assert.equal(result.assets, path.join(root, 'resources/audio-engine/automix-native'))
  assert.deepEqual(result.workers, ['worker.py', 'arrangement.py', 'probe.py'])
  assert.throws(() => inspectLinuxAutoMixInputs(path.join(root, 'missing-build-inputs')), /ENOENT/)
})

test('container uses a public-only model build stage and gates the new network and recovery capabilities', () => {
  const root = path.resolve(__dirname, '..')
  const docker = fs.readFileSync(path.join(root, 'deploy/server/Dockerfile'), 'utf8')
  assert.match(docker, /FROM python:3\.12-slim-bookworm AS public-model-tools/)
  assert.match(docker, /FROM public-model-tools AS public-models/)
  assert.match(docker, /COPY --from=public-models \/public-graphs/)
  assert.match(docker, /stage-automix-native-assets\.cjs/)
  const runtime = docker.split('AS runtime')[1]
  assert.ok(!/COPY.*(?:model-work|public-models|python)/.test(runtime))
  for (const file of ['audio-bridge-formats-native.test.cjs', 'audio-sync-groups-native.test.cjs',
    'audio-group-automix-binding-native.test.cjs', 'audio-group-automix-coordinator-native.test.cjs', 'server-desktop-bundle.test.cjs'])
    assert.ok(docker.includes(file), file)
  if (process.platform !== 'linux') assert.throws(() => stageLinuxServer({}), /Linux x86_64/)
})
