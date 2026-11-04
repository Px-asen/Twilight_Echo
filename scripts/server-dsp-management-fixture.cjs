'use strict'
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { writeFileSync, readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')

/** Real paired TLS, Core, per-Zone assets and native graph. The caller checks post-DSP PCM. */
async function prepareDspLibrary(secure, token, epoch, zoneId, cli, temporary) {
  const samples = {}
  async function call(name, payload = {}, command = false, expected = true) {
    const response = await secure('/api/core/rpc', { requestId: randomUUID(), epoch,
      kind: command ? 'command' : 'query', name, payload: { zoneId, ...payload } }, token)
    assert.equal(response.status, 200, JSON.stringify(response.json))
    assert.equal(response.json.ok, expected, JSON.stringify(response.json))
    if (!expected) return response.json
    const value = command ? response.json.value.result : response.json.value
    samples[name] = value
    return value
  }
  const page = () => call('zones.dsp.library')
  const edit = async value => call('zones.dsp.library.edit', { revision: (await page()).revision, edit: value }, true)
  // > one chunk, and > the ordinary control request allowance, without spending its command quota.
  const wave = Buffer.alloc(800056)
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(3, 20); wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(192000, 28); wave.writeUInt16LE(4, 32)
  wave.writeUInt16LE(32, 34); wave.write('JUNK', 36); wave.writeUInt32LE(800000, 40)
  wave.write('data', 800044); wave.writeUInt32LE(4, 800048); wave.writeFloatLE(0.5, 800052)
  const upload = await call('zones.dsp.upload.begin', { kind: 'impulseResponse', fileName: 'Room impulse.wav', byteSize: wave.length }, true)
  let offset = 0
  while (offset < wave.length) {
    // 70 requests exercise the separate bounded byte-transfer budget.
    const chunk = wave.subarray(offset, Math.min(wave.length, offset + 12000))
    const result = await call('zones.dsp.upload.chunk', { uploadId: upload.uploadId, offset, data: chunk.toString('base64') }, true)
    offset += chunk.length; assert.equal(result.offset, offset)
  }
  const asset = await call('zones.dsp.upload.commit', { uploadId: upload.uploadId, revision: (await page()).revision }, true)
  assert.equal(asset.fileName, 'Room impulse.wav')
  const main = await call('zones.dsp.library', { zoneId: 'local' })
  assert.equal(main.assets.items.some(row => row.id === asset.id), false)
  await edit({ kind: 'createScene', name: 'Remote room' })
  const sceneId = (await page()).scenes.find(row => row.name === 'Remote room').id
  await edit({ kind: 'bindImpulse', sceneId, assetId: asset.id })
  const bound = await page()
  assert.equal(bound.assets.items.find(row => row.id === asset.id).referenceCount, 1)
  await call('zones.dsp.library.edit', { revision: bound.revision, edit: { kind: 'removeAsset', id: asset.id } }, true, false)
  const input = join(temporary, 'local-correction.apo')
  writeFileSync(input, 'Preamp: -3 dB\nFilter 1: ON PK Fc 1000 Hz Gain -1 dB Q 1\n')
  const imported = JSON.parse(await cli('dsp-import', '--zone', zoneId, '--from', input))
  assert.equal(imported.kind, 'correctionProfile')
  const localList = JSON.parse(await cli('dsp-library', '--zone', zoneId))
  assert.equal(localList.assets.total, 2)
  await cli('dsp-remove', '--zone', zoneId, '--id', imported.id)
  await cli('vst3-scan', '--zone', zoneId)
  for (let n = 0; n < 40 && JSON.parse(await cli('dsp-library', '--zone', zoneId)).scanning; n++) await new Promise(resolve => setTimeout(resolve, 50))
  let vstNodeId
  if (process.env.TWILIGHT_VST3_FIXTURE_PATH) {
    const catalog = await page()
    const plugin = catalog.plugins.items.find(row => row.name === 'ADelay')
    assert.equal(plugin?.status, 'available', JSON.stringify(catalog))
    const state = join(temporary, 'one-second.vststate'), bytes = Buffer.alloc(8)
    bytes.writeFloatLE(1, 0); bytes.writeInt32LE(0, 4); writeFileSync(state, bytes)
    const preset = JSON.parse(await cli('dsp-import', '--zone', zoneId, '--from', state))
    await edit({ kind: 'addVst3', sceneId, catalogId: plugin.id, stateAssetId: preset.id })
    const configured = await page()
    vstNodeId = configured.scenes.find(row => row.id === sceneId).nodes.find(node => node.type === 'vst3Plugin').id
    const parameters = await call('zones.dsp.parameters', { revision: configured.revision, sceneId, nodeId: vstNodeId })
    assert.equal(parameters.items.find(row => row.id === 100).value, null)
    // State encodes one second of delay. Explicit override must reach the actual native VST3 helper.
    await edit({ kind: 'parameter', sceneId, nodeId: vstNodeId, parameterId: 100, value: 0 })
    const updated = await call('zones.dsp.parameters', { revision: (await page()).revision, sceneId, nodeId: vstNodeId })
    assert.equal(updated.items.find(row => row.id === 100).value, 0)
  }
  await edit({ kind: 'applyScene', sceneId, confirmDsdPcmFallback: false })
  const dsp = await secure('/api/core/rpc', { requestId: randomUUID(), epoch, kind: 'query', name: 'zones.dsp', payload: { zoneId } }, token)
  assert.equal(dsp.json.ok, true)
  const enabled = await secure('/api/core/rpc', { requestId: randomUUID(), epoch, kind: 'command', name: 'zones.dsp.edit',
    payload: { zoneId, revision: dsp.json.value.revision, edit: { kind: 'processing', settings: { dspEnabled: true } } } }, token)
  assert.equal(enabled.json.ok, true, JSON.stringify(enabled.json))
  samples['zones.dsp.library'] = await page()
  const current = samples['zones.dsp.library']
  const download = await call('zones.dsp.profile.export', { revision: current.revision, name: 'Remote room backup' }, true)
  const chunks = []
  for (let position = 0; position < download.byteSize;) {
    const chunk = await call('zones.dsp.profile.chunk', { downloadId: download.downloadId, offset: position })
    assert.equal(chunk.offset, position)
    const bytes = Buffer.from(chunk.data, 'base64')
    chunks.push(bytes); position += bytes.length; assert.equal(chunk.nextOffset, position)
  }
  await call('zones.dsp.profile.release', { downloadId: download.downloadId }, true)
  const bundle = Buffer.concat(chunks)
  const staged = await call('zones.dsp.upload.begin', { kind: 'profile', fileName: 'backup.tedsp', byteSize: bundle.length }, true)
  for (let position = 0; position < bundle.length; position += staged.chunkBytes)
    await call('zones.dsp.upload.chunk', { uploadId: staged.uploadId, offset: position, data: bundle.subarray(position, position + staged.chunkBytes).toString('base64') }, true)
  const preview = await call('zones.dsp.profile.preview', { uploadId: staged.uploadId, revision: current.revision }, true)
  assert.deepEqual(preview.issues, [])
  assert.equal((await page()).scenes.length, current.scenes.length)
  const receipt = await call('zones.dsp.profile.import', { uploadId: staged.uploadId, previewId: preview.previewId, revision: preview.revision }, true)
  const importedPage = await page()
  assert.equal(importedPage.scenes.length, current.scenes.length + receipt.sceneIds.length)
  assert.equal(importedPage.scenes.find(row => row.active).id, sceneId)
  const exported = join(temporary, 'cli-roundtrip.tedsp')
  await cli('dsp-profile-export', '--zone', zoneId, '--to', exported)
  assert.ok(statSync(exported).size > 800000)
  const dryRun = JSON.parse(await cli('dsp-profile-import', '--zone', zoneId, '--from', exported))
  assert.equal(dryRun.applied, false); assert.deepEqual(dryRun.preview.issues, [])
  const accepted = JSON.parse(await cli('dsp-profile-import', '--zone', zoneId, '--from', exported, '--apply'))
  assert.equal(accepted.applied, true)
  assert.equal(readFileSync(exported).readUInt32LE(0), 0x04034b50)
  // Keep bounded DTO samples; binary transfer already verified above.
  delete samples['zones.dsp.profile.chunk']
  assert.equal(JSON.stringify(samples).includes('modulePath'), false)
  assert.equal(JSON.stringify(samples).includes('relativePath'), false)
  if (process.env.TWILIGHT_DSP_WIRE_OUTPUT) writeFileSync(process.env.TWILIGHT_DSP_WIRE_OUTPUT, JSON.stringify(samples, null, 2))
  return { sceneId, assetId: asset.id, vstNodeId,
    setDelay: value => edit({ kind: 'parameter', sceneId, nodeId: vstNodeId, parameterId: 100, value }) }
}
module.exports = { prepareDspLibrary }
