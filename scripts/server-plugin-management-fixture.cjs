'use strict'
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFile, writeFile, access } = require('node:fs/promises')
const { join } = require('node:path')
const { ZipFile } = require('yazl')

async function checkPluginManagement({ secure, token, epoch, cli, rpc, temporary, remoteEnabled }) {
  const samples = {}
  async function call(name, payload = {}, command = false, expected = true) {
    const response = await secure('/api/core/rpc', { requestId: randomUUID(), epoch,
      kind: command ? 'command' : 'query', name: `plugins.management.${name}`, payload }, token)
    assert.equal(response.status, 200, JSON.stringify(response.json))
    assert.equal(response.json.ok, expected, JSON.stringify(response.json))
    if (!expected) return response.json.error
    const result = command ? response.json.value.result : response.json.value
    samples[`plugins.management.${name}`] = result
    return result
  }
  const id = 'com.example.server-fixture', marker = join(temporary, 'plugin-activated.txt')
  async function pack(version, fail = false, type = ['tool']) {
    const zip = new ZipFile(), chunks = []
    zip.addBuffer(Buffer.from(JSON.stringify({ id, name: 'Server fixture', version, description: 'Lifecycle fixture', author: 'Tests',
      license: 'MIT', type, main: 'index.mjs', engines: { twilightEcho: '*' }, apiVersion: 4, permissions: ['settings'] })), 'plugin.json')
    zip.addBuffer(Buffer.from(`import { appendFile } from 'node:fs/promises';
      export async function activate({ settings }) {
        await appendFile(${JSON.stringify(marker)}, ${JSON.stringify(version + '\n')});
        ${fail ? "throw new Error('fixture candidate failure');" : ""}
        await settings.set('cookie', 'fixture-only-secret');
        if (await settings.get('cookie') !== 'fixture-only-secret') throw Error('credential roundtrip failed');
      }`), 'index.mjs')
    zip.outputStream.on('data', chunk => chunks.push(chunk))
    const complete = new Promise((resolve, reject) => { zip.outputStream.on('end', resolve); zip.outputStream.on('error', reject) })
    zip.end(); await complete
    const bytes = Buffer.concat(chunks), file = join(temporary, `fixture-${version}.tep`)
    await writeFile(file, bytes)
    return { bytes, file }
  }
  async function preview(candidate) {
    const upload = await call('upload.begin', { fileName: 'fixture.tep', byteSize: candidate.bytes.length }, true)
    let offset = 0
    while (offset < candidate.bytes.length) {
      const bytes = candidate.bytes.subarray(offset, offset + upload.chunkBytes)
      const receipt = await call('upload.chunk', { uploadId: upload.uploadId, offset, data: bytes.toString('base64') }, true)
      offset += bytes.length; assert.equal(receipt.offset, offset)
    }
    return call('preview', { uploadId: upload.uploadId }, true)
  }
  const list = () => call('list')
  const installed = async () => (await list()).items.find(plugin => plugin.id === id)
  const edit = async (action, extra = {}) => {
    const plugin = await installed()
    return call('edit', { id, token: plugin.token, action, ...extra }, true)
  }
  const first = await pack('1.0.0')
  const initial = await list()
  assert.equal(initial.canManage, remoteEnabled)
  assert.doesNotMatch(JSON.stringify(initial), /versionRoot|dataDir|ciphertext|filePath/)
  if (!remoteEnabled) {
    assert.equal((await call('upload.begin', { fileName: 'fixture.tep', byteSize: first.bytes.length }, true, false)).code, 'FORBIDDEN')
    assert.equal(JSON.parse(await cli('plugin-install', '--from', first.file)).applied, false)
    await assert.rejects(access(marker))
    assert.equal(JSON.parse(await cli('plugin-install', '--from', first.file, '--apply')).applied, true)
    assert.equal((await installed()).enabled, false)
    await cli('plugin-enable', '--id', id)
    const plugin = await installed()
    assert.equal(plugin.enabled, true)
    assert.equal((await call('edit', { id, token: plugin.token, action: 'disable' }, true, false)).code, 'FORBIDDEN')
    await cli('plugin-disable', '--id', id)
    assert.equal(JSON.parse(await cli('plugin-uninstall', '--id', id)).applied, false)
    await cli('plugin-uninstall', '--id', id, '--apply', '--remove-data')
    assert.equal(await installed(), undefined)
    return
  }
  const cancelled = await preview(first)
  await assert.rejects(access(marker))
  await call('cancel', { previewId: cancelled.previewId }, true)
  assert.equal(await installed(), undefined)
  const accepted = await preview(first)
  await call('install', { previewId: accepted.previewId }, true)
  assert.equal((await installed()).enabled, false)
  assert.equal(await readFile(marker, 'utf8'), '1.0.0\n')
  const old = await installed()
  await edit('enable')
  assert.equal((await installed()).enabled, true)
  assert.equal((await call('edit', { id, token: old.token, action: 'disable' }, true, false)).code, 'STALE_REVISION')
  const pending = await preview(await pack('1.1.0'))
  await edit('disable')
  assert.equal((await call('install', { previewId: pending.previewId }, true, false)).code, 'STALE_REVISION')
  await edit('enable')
  const broken = await preview(await pack('2.0.0', true))
  assert.equal((await call('install', { previewId: broken.previewId }, true, false)).code, 'FAILED')
  assert.equal((await installed()).version, '1.0.0')
  assert.equal((await installed()).enabled, true)
  const activations = await readFile(marker, 'utf8')
  assert.ok(activations.endsWith('2.0.0\n1.0.0\n'), activations)
  const update = await preview(await pack('2.1.0'))
  assert.equal(update.previousVersion, '1.0.0')
  assert.equal(update.previouslyEnabled, true)
  await call('install', { previewId: update.previewId }, true)
  assert.equal((await installed()).version, '2.1.0')
  assert.equal((await installed()).enabled, true)
  const ui = await preview(await pack('3.0.0', false, ['ui']))
  assert.ok(ui.issues.length)
  assert.equal((await call('install', { previewId: ui.previewId }, true, false)).code, 'UNSUPPORTED_CAPABILITY')
  await call('cancel', { previewId: ui.previewId }, true)
  const descriptor = (await rpc('query', 'plugins.list')).find(plugin => plugin.id === id)
  const settings = await readFile(join(descriptor.paths.dataDir, 'settings.json'), 'utf8')
  assert.doesNotMatch(settings, /fixture-only-secret/)
  assert.match(settings, process.platform === 'win32' ? /windows-dpapi/ : /aes-256-gcm-profile/)
  await edit('uninstall', { removeData: true })
  assert.equal(await installed(), undefined)
  await assert.rejects(access(descriptor.paths.dataDir))
  await writeFile(join(temporary, 'plugin-wire.json'), JSON.stringify(samples, null, 2))
}
module.exports = { checkPluginManagement }
