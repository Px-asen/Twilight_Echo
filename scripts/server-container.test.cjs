'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { mkdtemp, mkdir, writeFile, readFile, rm, access, stat } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { once } = require('node:events')
const { randomUUID, randomBytes } = require('node:crypto')

test(`container runtime scans, checks health, restores an offline snapshot and stops via ${process.platform === 'win32' ? 'local administration' : 'SIGTERM'}`, { timeout: 90_000 }, async t => {
  const app = process.env.TWILIGHT_CONTAINER_APP || '/opt/twilight'
  const native = require(join(app, 'resources/audio-engine/twilight_audio_node.node'))
  assert.equal(typeof native.GetDspGraphStatus, 'function')
  const raster = require(join(app, 'resources/audio-engine/twilight_image_node.node')).resize(Buffer.from([255, 0, 0, 255]), 'image/rgba', 1, 1, 1)
  assert.equal(raster.width, 1); assert.equal(raster.height, 1)
  const temporary = await mkdtemp(join(tmpdir(), 'twilight-container-'))
  let root = join(temporary, 'data')
  const music = join(temporary, 'music'), entry = join(app, 'out/server/server.cjs')
  let child, exited
  t.after(async () => { if (child && child.exitCode == null) { child.kill('SIGTERM'); await exited }
    await rm(temporary, { recursive: true, force: true }) })
  const env = { ...process.env, TWILIGHT_METADATA_ENABLED: '0', NODE_PATH: '' }
  const cliAt = async (data, ...args) => (await promisify(execFile)(process.execPath, [entry, ...args, '--data', data],
    { env, timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout.trim()
  const cli = (...args) => cliAt(root, ...args)
  await mkdir(music)
  const wave = Buffer.alloc(44 + 16000)
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34)
  wave.write('data', 36); wave.writeUInt32LE(16000, 40)
  await writeFile(join(music, 'Container.wav'), wave)
  await cli('init', '--library', music)
  const credentialKey = randomBytes(32)
  await writeFile(join(root, 'server-credentials.key'), credentialKey, { mode: 0o600 })
  const profileId = JSON.parse(await readFile(join(root, 'server.json'), 'utf8')).id
  const start = async () => {
    child = spawn(process.execPath, [entry, 'start', '--bridge-only', '--data', root], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    exited = once(child, 'exit')
    let output = '', error = ''
    child.stderr.on('data', data => { error += data })
    await Promise.race([new Promise(resolve => child.stdout.on('data', data => {
      output += data; if (output.split('\n').some(line => line.startsWith('{') && line.includes('ready'))) resolve()
    })), exited.then(([code]) => { throw Error(`Server exited ${code}: ${error}`) })])
    return JSON.parse(await cli('status'))
  }
  let health = await start()
  assert.equal(JSON.parse(await cli('health')).phase, 'ready')
  const rpc = async (name, payload = {}) => {
    const request = join(temporary, 'request.json')
    await writeFile(request, JSON.stringify({ requestId: randomUUID(), kind: 'query', epoch: health.epoch, name, payload }))
    return JSON.parse(await cli('rpc', '--request', request))
  }
  assert.equal((await rpc('zones.state')).outputs.find(item => item.id === 'local').available, false)
  let library
  for (let i = 0; i < 100; i++) {
    library = await rpc('library.tracks', { limit: 10 })
    if (library.total === 1) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(library.total, 1)
  const item = library.tracks[0]
  assert.equal(item.title, 'Container')
  await cli('remote-on')
  assert.equal(JSON.parse(await cli('remote-status')).enabled, true)
  const tlsIdentity = await readFile(join(root, 'remote-tls.json'))
  const snapshot = join(temporary, 'snapshot')
  await assert.rejects(cli('backup', '--to', snapshot), /EEXIST/)
  if (process.platform === 'win32') await cli('stop')
  else child.kill('SIGTERM')
  assert.equal((await exited)[0], 0); child = undefined
  await assert.rejects(access(join(root, 'server.lock')))
  health = await start()
  assert.equal(JSON.parse(await readFile(join(root, 'server.json'), 'utf8')).id, profileId)
  assert.equal(JSON.parse(await cli('remote-status')).enabled, true)
  await cli('stop'); assert.equal((await exited)[0], 0); child = undefined
  await assert.rejects(cli('health'))
  await cli('backup', '--to', snapshot)
  const restored = join(temporary, 'restored')
  await cliAt(restored, 'restore', '--from', snapshot)
  await assert.rejects(cliAt(restored, 'restore', '--from', snapshot), /已存在/)
  assert.deepEqual(await readFile(join(restored, 'server-credentials.key')), credentialKey)
  if (process.platform !== 'win32') {
    const key = await stat(join(restored, 'server-credentials.key'))
    assert.equal(key.mode & 0o777, 0o600)
    assert.equal(key.uid, process.getuid())
    assert.notEqual(process.getuid(), 0, 'Runtime acceptance must run as a non-root user')
  }
  assert.deepEqual(await readFile(join(restored, 'remote-tls.json')), tlsIdentity)
  // A candidate profile is started separately; neither source nor snapshot is replaced.
  root = restored
  health = await start()
  assert.equal(JSON.parse(await cli('health')).phase, 'ready')
  assert.equal(JSON.parse(await readFile(join(root, 'server.json'), 'utf8')).id, profileId)
  assert.equal(JSON.parse(await cli('remote-status')).enabled, true)
  assert.equal((await rpc('library.tracks', { limit: 10 })).tracks[0].id, item.id)
  await cli('stop'); assert.equal((await exited)[0], 0); child = undefined
})
