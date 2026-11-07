import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CoreDspService, type CoreDspPlatform } from './dspService.ts'
import { CoreAudioOutputService } from './outputService.ts'
import { DspAssetLibrary } from './dspAssetLibrary.ts'
import { Vst3CatalogService } from './vst3Catalog.ts'
import { CoreSettingsRepository } from '../persistence/settingsRepository.ts'
import { AudioEngineManager } from '../../main/audioEngineManager.ts'
import { coreAudioConfiguration, createCoreAudioPersistence } from './settings.ts'
import { createDefaultPlaybackInfo, normalizeOutputConfig } from './audioEngineHelpers.ts'
import type { NativeAudioBinding } from './audioEngineTypes.ts'
import type { DspScene, DspSceneState } from '../../shared/dspGraph.ts'
import type { AudioProcessingSettings } from '../../shared/audioEngineTypes.ts'
import type { CoreStateRow } from '../../shared/coreState.ts'
import { computeAutoPreampDb } from '../../shared/eqResponse.ts'
import { initialAudioSettings } from './settings.ts'
import { CoreSettingsService } from '../settings/service.ts'
import { createSettingsImportEffects } from '../settings/importEffects.ts'
import { DspUploads } from './dspUploads.ts'
import { validDspLibraryPayload } from '../../shared/dspLibrary.ts'
import { createDspProfile, exportDspProfileArchive } from './dspProfileArchive.ts'

const signal = () => new AbortController().signal
function fixture(
  t: test.TestContext,
  initial?: { processing?: Partial<AudioProcessingSettings>; preferences?: CoreStateRow[] }
) {
  const root = mkdtempSync(join(tmpdir(), 'core-dsp-'))
  const info = createDefaultPlaybackInfo('wasapi', 'auto', false, normalizeOutputConfig())
  let nativeRevision = 0,
    failNative = false,
    stops = 0,
    scans = 0,
    failWrite = false
  const dispatch: unknown[] = []
  let preferenceReads = 0
  const settings = new CoreSettingsRepository({
    filePath: join(root, 'settings.json'),
    environment: { platform: 'win32', resolvePath: resolve, defaultCachePath: join(root, 'cache') },
    initial: initialAudioSettings({ exclusiveMode: false, audioProcessing: initial?.processing }),
    changed: () => output?.changed()
  })
  const originalUpdate = settings.update.bind(settings)
  settings.update = (patch) => {
    if (failWrite) {
      failWrite = false
      throw new Error('disk full')
    }
    return originalUpdate(patch)
  }
  const persistence = createCoreAudioPersistence(settings)
  const assets = new DspAssetLibrary(join(root, 'dsp-assets'), { now: Date.now, newId: randomUUID })
  let chosen: string | null = null
  let scanGate: Promise<void> = Promise.resolve()
  const catalog = new Vst3CatalogService(
    join(root, 'dsp-vst3'),
    {
      scan: async () => {
        scans++
        await scanGate
        return {
          classId: 'A'.repeat(32),
          name: 'Fixture',
          vendor: 'Twilight Echo',
          version: '1',
          parameters: Array.from({ length: 201 }, (_, id) => ({
            id,
            title: `P${id}`,
            unit: '',
            defaultNormalizedValue: 0,
            stepCount: 0,
            flags: 0
          }))
        }
      }
    },
    [join(root, 'modules')],
    {
      platform: 'win32',
      helpers: { platformSupported: true, scannerPresent: true, hostPresent: true },
      now: Date.now
    }
  )
  const native = {
    GetPlaybackInfo: () => JSON.stringify(info),
    GetLastError: () => '',
    SetDspConfig: () => {},
    SetOutputConfig: () => {},
    SetDspPluginChain: () => {},
    ApplyDspState: (revision: number, value: string) => {
      dispatch.push(JSON.parse(value))
      if (failNative) {
        failNative = false
        throw new Error('compile failed')
      }
      nativeRevision = revision
    },
    GetDspGraphStatus: () =>
      JSON.stringify({ revision: nativeRevision, nodes: [], compileState: 'ready' }),
    Pause: () => {
      info.state = 'paused'
    },
    Stop: () => {
      stops++
      info.state = 'stopped'
    }
  } as unknown as NativeAudioBinding
  const engine = new AudioEngineManager(coreAudioConfiguration(settings.read()), {
    platform: 'win32',
    nativeBinding: native,
    persistAudioOutput: persistence.output,
    persistDeviceProfiles: persistence.profile,
    dspAssetPathResolver: (id) => assets.getKnownPath(id),
    vst3StateAssetResolver: (id) => assets.resolveVst3State(id),
    vst3ModuleResolver: (id, classId) => catalog.resolveAvailableModule(id, classId)
  })
  const output: CoreAudioOutputService = new CoreAudioOutputService({
    engine,
    settings,
    changed: () => {}
  })
  const platform = {
    call: async (name: string, payload: { path?: string; paths?: string[] }) => {
      if (name === 'dsp.registerVst3Paths' || name === 'dsp.authorizeVst3Paths')
        return payload.paths
      if (name === 'dsp.authorizeImpulse') throw new Error('IR path not authorized')
      return chosen
    }
  } as CoreDspPlatform
  const dsp = new CoreDspService({
    engine,
    configuration: output,
    settings,
    assets,
    catalog,
    preferences: {
      coreStateRead: async () => {
        preferenceReads++
        return {
          domain: 'eq-preferences',
          revision: 0,
          rows: initial?.preferences ?? [],
          next: null
        }
      }
    },
    platform,
    temporaryDirectory: root,
    uploadDirectory: join(root, 'dsp-upload-staging'),
    now: Date.now,
    newId: randomUUID,
    failed: (error) => {
      throw error
    }
  })
  t.after(() => {
    engine.destroy()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    settings,
    assets,
    catalog,
    engine,
    output,
    dsp,
    dispatch,
    info,
    preferenceReads: () => preferenceReads,
    stops: () => stops,
    scans: () => scans,
    choose: (path: string | null) => {
      chosen = path
    },
    failNative: () => {
      failNative = true
    },
    failWrite: () => {
      failWrite = true
    },
    blockScan: (gate: Promise<void>) => {
      scanGate = gate
    }
  }
}

test('managed uploads bind to disabled scenes, explicitly apply, protect references and remain Zone isolated', async t => {
  const f = fixture(t), other = fixture(t)
  await f.dsp.initialize(); await other.dsp.initialize()
  const data = Buffer.from('Preamp: -4 dB\nFilter 1: ON PK Fc 1000 Hz Gain -3 dB Q 1\n')
  const upload = await f.dsp.beginUpload('phone', { zoneId: 'local', kind: 'correctionProfile', fileName: 'Room.apo', byteSize: data.length })
  await assert.rejects(f.dsp.uploadChunk('tablet', upload.uploadId, 0, data.toString('base64')), { code: 'NOT_FOUND' })
  await assert.rejects(f.dsp.commitUpload('phone', upload.uploadId, f.output.getRevision(), signal()), { code: 'INVALID_REQUEST' })
  await f.dsp.uploadChunk('phone', upload.uploadId, 0, data.toString('base64'))
  await assert.rejects(f.dsp.uploadChunk('phone', upload.uploadId, 0, data.toString('base64')), { code: 'INVALID_REQUEST' })
  const asset = await f.dsp.commitUpload('phone', upload.uploadId, f.output.getRevision(), signal())
  assert.equal(asset.fileName, 'Room.apo'); assert.equal(asset.name, 'Room.apo')
  assert.equal((await other.dsp.library()).assets.total, 0)
  const edit = (value: Parameters<CoreDspService['editLibrary']>[1]) => f.dsp.editLibrary(f.output.getRevision(), value, signal())
  await edit({ kind: 'createScene', name: 'Room' })
  const scene = (await f.dsp.state()).scenes.scenes.find(row => row.name === 'Room')!
  assert.equal(scene.enabled, false)
  await edit({ kind: 'bindCorrection', sceneId: scene.id, assetId: asset.id })
  let view = await f.dsp.library()
  assert.equal(view.assets.items[0].referenceCount, 1)
  await assert.rejects(edit({ kind: 'removeAsset', id: asset.id }), /引用/)
  assert.equal((await f.dsp.state()).scenes.activeSceneId, 'default')
  await edit({ kind: 'applyScene', sceneId: scene.id, confirmDsdPcmFallback: false })
  assert.equal((await f.dsp.state()).scenes.pinnedSceneId, scene.id)
  assert.equal((await f.dsp.state()).processing.eqEnabled, true)
  const saved = f.settings.read().dspScenes.find(row => row.id === scene.id)!
  assert.equal(saved.graph.nodes.find(node => node.type === 'equalizer')?.params.preampDb, -4)
  const before = f.output.getRevision()
  await edit({ kind: 'removeScene', sceneId: scene.id })
  await assert.rejects(f.dsp.library(100, 0, before), { code: 'STALE_REVISION' })
  await edit({ kind: 'removeAsset', id: asset.id })
  view = await f.dsp.library()
  assert.equal(view.assets.total, 0)
  assert.equal(JSON.stringify(view).includes(f.root.replaceAll('\\', '\\\\')), false)
  await f.dsp.shutdown(); await other.dsp.shutdown()
})

test('upload lifetime, quotas, schema and CAS prevent abandoned or stale imports from becoming durable assets', async t => {
  const f = fixture(t); await f.dsp.initialize()
  const input = { zoneId: 'local', kind: 'vst3State' as const, fileName: 'state.bin', byteSize: 1 }
  const upload = await f.dsp.beginUpload('phone', input)
  await f.dsp.uploadChunk('phone', upload.uploadId, 0, 'AA==')
  const revision = f.output.getRevision()
  await f.dsp.editLibrary(revision, { kind: 'createScene', name: 'Changed' }, signal())
  await assert.rejects(f.dsp.commitUpload('phone', upload.uploadId, revision, signal()), { code: 'STALE_REVISION' })
  assert.equal((await f.dsp.library()).assets.total, 0)
  await assert.rejects(f.dsp.uploadChunk('phone', upload.uploadId, 0, 'AA=='), { code: 'NOT_FOUND' })
  let now = 0
  const staging = new DspUploads(join(f.root, 'expiry'), () => now, randomUUID, files)
  await staging.initialize()
  const first = await staging.begin('phone', input)
  await staging.begin('tablet', input)
  await assert.rejects(staging.begin('third', input), { code: 'BUSY' })
  now = 600_001
  await assert.rejects(staging.chunk('phone', first.uploadId, 0, 'AA=='), { code: 'NOT_FOUND' })
  const last = await staging.begin('phone', input)
  await staging.disconnect('phone')
  await assert.rejects(staging.chunk('phone', last.uploadId, 0, 'AA=='), { code: 'NOT_FOUND' })
  assert.equal(validDspLibraryPayload('zones.dsp.upload.begin', { ...input, fileName: '../state.bin' }), false)
  assert.equal(validDspLibraryPayload('zones.dsp.upload.begin', { ...input, kind: '__proto__' }), false)
  assert.equal(validDspLibraryPayload('zones.dsp.library.edit', { zoneId: 'local', revision: 1, edit: { kind: 'scan', paths: ['C:/injected'] } }), false)
  await staging.close(); await f.dsp.shutdown()
})

test('managed legacy impulse paths remain editable without granting arbitrary library paths', async t => {
  const f = fixture(t); await f.dsp.initialize()
  const asset = await f.assets.importBuffer({ kind: 'impulseResponse', fileName: 'managed.wav', data: new Uint8Array([1, 2]) })
  const path = await f.assets.getPath(asset.id)
  await f.dsp.edit({ revision: f.output.getRevision(), edit: { kind: 'processing', settings: { convolverIrPath: path } } }, signal())
  await f.dsp.edit({ revision: f.output.getRevision(), edit: { kind: 'processing', settings: { dspEnabled: true } } }, signal())
  assert.equal((await f.dsp.state()).processing.convolverIrPath, path)
  await assert.rejects(f.dsp.edit({ revision: f.output.getRevision(), edit: { kind: 'processing', settings: { convolverIrPath: 'C:/untrusted.wav' } } }, signal()), /not authorized/)
  await f.dsp.shutdown()
})

test('headless VST3 scan reports progress outside the playback lane and only publishes path-free catalog entries', async t => {
  const f = fixture(t); await f.dsp.initialize()
  mkdirSync(join(f.root, 'modules')); writeFileSync(join(f.root, 'modules', 'effect.vst3'), 'fixture')
  let release!: () => void
  f.blockScan(new Promise<void>(resolve => { release = resolve }))
  await f.dsp.editLibrary(f.output.getRevision(), { kind: 'scan' }, signal())
  assert.equal((await f.dsp.library()).scanning, true)
  await assert.rejects(f.dsp.editLibrary(f.output.getRevision(), { kind: 'scan' }, signal()), { code: 'BUSY' })
  release(); await f.dsp.flush()
  const page = await f.dsp.library()
  assert.equal(page.scanning, false); assert.equal(page.plugins.total, 1)
  assert.equal(page.plugins.items[0].parameterCount, 201)
  assert.equal('modulePath' in page.plugins.items[0], false)
  assert.equal('searchPaths' in page, false)
  await f.dsp.editLibrary(f.output.getRevision(), { kind: 'createScene', name: 'Plugin scene' }, signal())
  const sceneId = (await f.dsp.library()).scenes.find(row => row.name === 'Plugin scene')!.id
  await f.dsp.editLibrary(f.output.getRevision(), { kind: 'addVst3', sceneId, catalogId: page.plugins.items[0].id, stateAssetId: null }, signal())
  assert.ok((await f.dsp.state()).scenes.scenes.find(row => row.id === sceneId)!.graph.nodes.some(node => node.vst3?.catalogId === page.plugins.items[0].id))
  await f.dsp.shutdown()
})

async function profileUpload(f: ReturnType<typeof fixture>, data: Buffer) {
  const upload = await f.dsp.beginUpload('phone', { zoneId: 'local', kind: 'profile', fileName: 'scene.tedsp', byteSize: data.length })
  for (let offset = 0; offset < data.length; offset += upload.chunkBytes)
    await f.dsp.uploadChunk('phone', upload.uploadId, offset, data.subarray(offset, offset + upload.chunkBytes).toString('base64'))
  return upload
}
async function downloadProfile(f: ReturnType<typeof fixture>) {
  const download = await f.dsp.exportProfile('phone', f.output.getRevision(), 'Room', signal())
  const parts: Buffer[] = []
  for (let offset = 0; offset < download.byteSize;) {
    const chunk = await f.dsp.profileChunk('phone', download.downloadId, offset)
    parts.push(Buffer.from(chunk.data, 'base64')); offset = chunk.nextOffset
  }
  await f.dsp.releaseProfile('phone', download.downloadId)
  return Buffer.concat(parts)
}

test('profile preview is isolated, import appends disabled scenes, export embeds legacy IR and roundtrip preserves graph assets', async t => {
  const f = fixture(t), target = fixture(t)
  await f.dsp.initialize(); await target.dsp.initialize()
  const asset = await f.assets.importBuffer({ kind: 'impulseResponse', fileName: 'Room.wav', data: new Uint8Array([1, 2]) })
  const edit = (value: Parameters<CoreDspService['editLibrary']>[1]) => f.dsp.editLibrary(f.output.getRevision(), value, signal())
  await edit({ kind: 'createScene', name: 'Room' })
  const sceneId = (await f.dsp.library()).scenes.find(scene => scene.name === 'Room')!.id
  await edit({ kind: 'bindImpulse', sceneId, assetId: asset.id })
  const data = await downloadProfile(f)
  const before = await target.dsp.state()
  const upload = await profileUpload(target, data)
  const preview = await target.dsp.previewProfile('phone', upload.uploadId, target.output.getRevision(), signal())
  assert.equal(preview.assetCount, 1); assert.deepEqual(preview.issues, [])
  assert.equal((await target.dsp.library()).assets.total, 0)
  assert.deepEqual(await target.dsp.state(), before)
  await assert.rejects(target.dsp.importProfile('tablet', upload.uploadId, preview.previewId, preview.revision, signal()), { code: 'NOT_FOUND' })
  const imported = await target.dsp.importProfile('phone', upload.uploadId, preview.previewId, preview.revision, signal())
  const after = await target.dsp.state()
  assert.equal(after.scenes.pinnedSceneId, before.scenes.pinnedSceneId)
  assert.equal(after.scenes.activeSceneId, before.scenes.activeSceneId)
  assert.equal(imported.sceneIds.length, preview.scenes.length)
  assert.ok(after.scenes.scenes.filter(scene => imported.sceneIds.includes(scene.id)).every(scene => !scene.enabled && !scene.allowDsdPcmFallback))
  assert.equal((await target.dsp.library()).assets.items[0].fileName, 'Room.wav')
  const repeat = await profileUpload(target, data)
  const stale = await target.dsp.previewProfile('phone', repeat.uploadId, target.output.getRevision(), signal())
  await target.dsp.editLibrary(stale.revision, { kind: 'createScene', name: 'other-controller' }, signal())
  await assert.rejects(target.dsp.importProfile('phone', repeat.uploadId, stale.previewId, stale.revision, signal()), { code: 'STALE_REVISION' })
  await target.dsp.cancelUpload('phone', repeat.uploadId).catch(() => {})
  // Legacy path conversion is local to the downloaded package, not a saved-settings mutation.
  await f.dsp.edit({ revision: f.output.getRevision(), edit: { kind: 'processing', settings: { convolverIrPath: await f.assets.getPath(asset.id) } } }, signal())
  const source = await f.dsp.state()
  await downloadProfile(f)
  assert.deepEqual(await f.dsp.state(), source)
  await f.dsp.shutdown(); await target.dsp.shutdown()
})

test('profile native/save failure rolls back newly imported assets; external paths and absent assets cannot be applied', async t => {
  const f = fixture(t), source = fixture(t)
  await f.dsp.initialize(); await source.dsp.initialize()
  const asset = await source.assets.importBuffer({ kind: 'impulseResponse', fileName: 'Room.wav', data: new Uint8Array([1, 3]) })
  await source.dsp.editLibrary(source.output.getRevision(), { kind: 'createScene', name: 'Room' }, signal())
  const sceneId = (await source.dsp.library()).scenes.find(scene => scene.name === 'Room')!.id
  await source.dsp.editLibrary(source.output.getRevision(), { kind: 'bindImpulse', sceneId, assetId: asset.id }, signal())
  const data = await downloadProfile(source), upload = await profileUpload(f, data)
  const preview = await f.dsp.previewProfile('phone', upload.uploadId, f.output.getRevision(), signal())
  const before = await f.dsp.state(); f.failWrite()
  await assert.rejects(f.dsp.importProfile('phone', upload.uploadId, preview.previewId, preview.revision, signal()), /disk full/)
  assert.deepEqual((await f.dsp.state()).scenes, before.scenes)
  assert.equal((await f.dsp.library()).assets.total, 0)
  const scenes = structuredClone((await source.dsp.state()).scenes.scenes)
  const file = join(source.root, 'external.tedsp')
  scenes[0].graph.nodes.push({ id: 'bad', type: 'convolver', enabled: true, params: { impulseResponsePath: 'C:/private.wav' } })
  await exportDspProfileArchive({ outputPath: file, profile: createDspProfile({ name: 'External', scenes, pinnedSceneId: null, assetIds: [] }) }, source.assets)
  const bad = await profileUpload(f, readFileSync(file))
  await assert.rejects(f.dsp.previewProfile('phone', bad.uploadId, f.output.getRevision(), signal()), /外部路径/)
  await f.dsp.cancelUpload('phone', bad.uploadId)
  delete scenes[0].graph.nodes.at(-1)!.params.impulseResponsePath
  scenes[0].graph.nodes.at(-1)!.params.impulseResponseAssetId = `impulseResponse:${'f'.repeat(64)}`
  await exportDspProfileArchive({ outputPath: file, profile: createDspProfile({ name: 'Missing', scenes, pinnedSceneId: null, assetIds: [] }) }, source.assets)
  const missing = await profileUpload(f, readFileSync(file))
  const blocked = await f.dsp.previewProfile('phone', missing.uploadId, f.output.getRevision(), signal())
  assert.ok(blocked.issues.length > 0)
  await assert.rejects(f.dsp.importProfile('phone', missing.uploadId, blocked.previewId, blocked.revision, signal()), { code: 'INVALID_REQUEST' })
  await f.dsp.shutdown(); await source.dsp.shutdown()
})

test('VST3 parameters preserve preset state, reject readonly fields, quantize steps, fence pages and rollback failed saves', async t => {
  const f = fixture(t); await f.dsp.initialize()
  mkdirSync(join(f.root, 'modules')); writeFileSync(join(f.root, 'modules', 'effect.vst3'), 'fixture')
  await f.catalog.scan()
  const plugin = (await f.catalog.getState()).entries[0]
  const state = await f.assets.importBuffer({ kind: 'vst3State', fileName: 'state.bin', data: new Uint8Array([1]) })
  const edit = (value: Parameters<CoreDspService['editLibrary']>[1]) => f.dsp.editLibrary(f.output.getRevision(), value, signal())
  await edit({ kind: 'createScene', name: 'Plugin' })
  const sceneId = (await f.dsp.library()).scenes.find(scene => scene.name === 'Plugin')!.id
  await edit({ kind: 'addVst3', sceneId, catalogId: plugin.id, stateAssetId: state.id })
  const nodeId = (await f.dsp.library()).scenes.find(scene => scene.id === sceneId)!.nodes.find(node => node.type === 'vst3Plugin')!.id
  let page = await f.dsp.nodeParameters(f.output.getRevision(), sceneId, nodeId)
  assert.equal(page.items[0].value, null); assert.equal(page.items[0].overridden, false)
  const originalFind = f.catalog.find.bind(f.catalog)
  f.catalog.find = async id => {
    const entry = await originalFind(id)
    if (entry) entry.parameters = entry.parameters.map(parameter => ({ ...parameter, stepCount: parameter.id === 0 ? 4 : 0, flags: parameter.id === 1 ? 2 : 0 }))
    return entry
  }
  await edit({ kind: 'parameter', sceneId, nodeId, parameterId: 0, value: 0.39 })
  const previous = page.revision
  page = await f.dsp.nodeParameters(f.output.getRevision(), sceneId, nodeId)
  assert.equal(page.items[0].value, 0.5)
  assert.equal((await f.dsp.nodeParameters(page.revision, sceneId, nodeId, 200)).items.length, 1)
  await assert.rejects(f.dsp.nodeParameters(previous, sceneId, nodeId), { code: 'STALE_REVISION' })
  await assert.rejects(edit({ kind: 'parameter', sceneId, nodeId, parameterId: 1, value: 0.7 }), /不可编辑/)
  f.failWrite(); await assert.rejects(edit({ kind: 'parameter', sceneId, nodeId, parameterId: 0, value: 1 }), /disk full/)
  assert.equal((await f.dsp.nodeParameters(f.output.getRevision(), sceneId, nodeId)).items[0].value, 0.5)
  await edit({ kind: 'parameter', sceneId, nodeId, parameterId: 0, value: null })
  assert.equal((await f.dsp.nodeParameters(f.output.getRevision(), sceneId, nodeId)).items[0].value, null)
  await f.dsp.shutdown()
})

test('profile preview rebinds installed VST3 by class identity and reports missing plugins without publishing assets', async t => {
  const source = fixture(t), target = fixture(t), missing = fixture(t)
  for (const f of [source, target, missing]) await f.dsp.initialize()
  for (const f of [source, target]) {
    mkdirSync(join(f.root, 'modules')); writeFileSync(join(f.root, 'modules', 'effect.vst3'), 'fixture')
    await f.catalog.scan()
  }
  const plugin = (await source.catalog.getState()).entries[0]
  await source.dsp.editLibrary(source.output.getRevision(), { kind: 'createScene', name: 'Plugin' }, signal())
  const sceneId = (await source.dsp.library()).scenes.find(scene => scene.name === 'Plugin')!.id
  await source.dsp.editLibrary(source.output.getRevision(), { kind: 'addVst3', sceneId, catalogId: plugin.id, stateAssetId: null }, signal())
  const bytes = await downloadProfile(source)
  const unavailable = await profileUpload(missing, bytes)
  const blocked = await missing.dsp.previewProfile('phone', unavailable.uploadId, missing.output.getRevision(), signal())
  assert.ok(blocked.issues.some(issue => issue.includes('VST3')))
  const upload = await profileUpload(target, bytes)
  const preview = await target.dsp.previewProfile('phone', upload.uploadId, target.output.getRevision(), signal())
  assert.deepEqual(preview.issues, [])
  await target.dsp.importProfile('phone', upload.uploadId, preview.previewId, preview.revision, signal())
  const node = (await target.dsp.state()).scenes.scenes.flatMap(scene => scene.graph.nodes).find(node => node.type === 'vst3Plugin')!
  assert.notEqual(node.vst3?.catalogId, plugin.id)
  assert.equal(node.vst3?.catalogId, (await target.catalog.getState()).entries[0].id)
  const download = await target.dsp.exportProfile('phone', target.output.getRevision(), 'portable', signal())
  await assert.rejects(target.dsp.profileChunk('tablet', download.downloadId, 0), { code: 'NOT_FOUND' })
  await target.dsp.disconnectUploads('phone')
  await assert.rejects(target.dsp.profileChunk('phone', download.downloadId, 0), { code: 'NOT_FOUND' })
  for (const f of [source, target, missing]) await f.dsp.shutdown()
})

test('Core DSP uses the original settings file, effective EQ and shared output revision', async (t) => {
  const f = fixture(t)
  await f.dsp.initialize()
  await f.dsp.edit(
    {
      revision: f.output.getRevision(),
      edit: { kind: 'processing', settings: { dspEnabled: true, eqEnabled: true, eqPreamp: -3 } }
    },
    signal()
  )
  const state = await f.dsp.state()
  assert.equal(state.processing.eqPreamp, -3)
  assert.equal(f.engine.getAudioProcessing().eqPreamp, -3)
  assert.equal(
    JSON.parse(readFileSync(join(f.root, 'settings.json'), 'utf8')).audioProcessing.eqPreamp,
    -3
  )
  const before = f.dispatch.length
  await assert.rejects(
    f.dsp.edit({ revision: 0, edit: { kind: 'processing', settings: { eqPreamp: 9 } } }, signal()),
    { code: 'STALE_REVISION' }
  )
  assert.equal(f.dispatch.length, before)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(
    f.dsp.edit(
      { revision: state.revision, edit: { kind: 'processing', settings: { eqPreamp: 9 } } },
      cancelled.signal
    )
  )
  assert.equal(f.dispatch.length, before)
})

test('native failure and disk failure restore the acknowledged processing and graph', async (t) => {
  const f = fixture(t)
  await f.dsp.initialize()
  await f.dsp.edit(
    {
      revision: f.output.getRevision(),
      edit: { kind: 'processing', settings: { dspEnabled: true, eqEnabled: true, eqPreamp: -2 } }
    },
    signal()
  )
  const before = await f.dsp.state()
  for (const fail of [f.failNative, f.failWrite]) {
    fail()
    await assert.rejects(
      f.dsp.edit(
        {
          revision: f.output.getRevision(),
          edit: { kind: 'processing', settings: { eqPreamp: -5 } }
        },
        signal()
      )
    )
    assert.equal(f.engine.getAudioProcessing().eqPreamp, -2)
    assert.equal(f.settings.read().audioProcessing.eqPreamp, -2)
    assert.deepEqual(f.engine.getDspSceneState().scenes, before.scenes.scenes)
  }
  assert.equal(f.stops(), 0)
})

test('failed publication retains the exact DSD confirmation attached to the old graph', async (t) => {
  const f = fixture(t)
  await f.dsp.initialize()
  const previous = f.engine.getDspSceneState().scenes
  previous[0].allowDsdPcmFallback = true
  f.settings.update({ dspScenes: previous })
  const scenes = structuredClone(previous)
  scenes[0].graph.nodes.push({ id: 'changed', type: 'equalizer', enabled: false, params: {} })
  f.failWrite()
  await assert.rejects(
    f.dsp.edit(
      { revision: f.output.getRevision(), edit: { kind: 'scenes', scenes, pinnedSceneId: null } },
      signal()
    ),
    /disk full/
  )
  assert.equal(f.engine.getDspSceneState().scenes[0].allowDsdPcmFallback, true)
  assert.deepEqual(f.engine.getDspSceneState().scenes, f.settings.read().dspScenes)
})

test('managed asset references survive profile round-trip and prevent deletion without a renderer', async (t) => {
  const f = fixture(t)
  await f.dsp.initialize()
  const source = join(f.root, 'correction.apo')
  writeFileSync(source, 'Preamp: -3 dB\nFilter 1: ON PK Fc 100 Hz Gain -2 dB Q 1\n')
  f.choose(source)
  await f.dsp.import({ revision: f.output.getRevision(), kind: 'correctionProfile' }, signal())
  const page = await f.dsp.assets()
  assert.equal(page.total, 1)
  const id = page.items[0].id
  assert.equal((await f.dsp.correction(id)).preampDb, -3)
  const scenes = structuredClone((await f.dsp.state()).scenes.scenes)
  scenes[0].android = {
    schemaVersion: 1,
    crossfadeSeconds: 2.5,
    allowedSampleRates: [44100, 96000],
    dsdOutputMode: 'native',
    dsdRatePolicy: 'exact',
    futurePhoneSetting: { enabled: true }
  }
  scenes[0].graph.nodes.push({
    id: 'correction',
    type: 'equalizer',
    enabled: false,
    params: { correctionProfileAssetId: id }
  })
  await f.dsp.edit(
    { revision: f.output.getRevision(), edit: { kind: 'scenes', scenes, pinnedSceneId: null } },
    signal()
  )
  await assert.rejects(f.dsp.removeAsset(f.output.getRevision(), id, signal()), /引用/)
  const archive = join(f.root, 'roundtrip.tedsp')
  f.choose(archive)
  await f.dsp.export(f.output.getRevision(), 'Round trip', signal())
  const imported = (await f.dsp.import(
    { revision: f.output.getRevision(), kind: 'profile' },
    signal()
  )) as { state: DspSceneState }
  assert.deepEqual(imported.state, f.engine.getDspSceneState())
  assert.deepEqual(imported.state.scenes[0].android, scenes[0].android)
  imported.state.scenes[0].android!.crossfadeSeconds = 9
  assert.deepEqual(f.settings.read().dspScenes, scenes)
  assert.equal((await f.dsp.assets()).items[0].referenceCount, 1)
  const reopened = new DspAssetLibrary(join(f.root, 'dsp-assets'), {
    now: Date.now,
    newId: randomUUID
  })
  assert.equal((await reopened.list())[0].id, id)
})

test('an owned legacy convolution path retains its managed asset until the path is explicitly cleared', async (t) => {
  const f = fixture(t)
  const asset = await f.assets.importBuffer({
    kind: 'impulseResponse',
    fileName: 'legacy.wav',
    data: new Uint8Array([1, 2, 3, 4])
  })
  const path = await f.assets.getPath(asset.id)
  f.settings.update({
    audioProcessing: {
      ...f.settings.read().audioProcessing,
      convolverIrPath: path,
      convolverEnabled: true
    }
  })
  await f.dsp.initialize()
  assert.equal((await f.dsp.assets()).items[0].referenceCount, 1)
  await assert.rejects(f.dsp.removeAsset(f.output.getRevision(), asset.id, signal()), /引用/)
  f.settings.update({
    audioProcessing: {
      ...f.settings.read().audioProcessing,
      convolverIrPath: '',
      convolverEnabled: false
    }
  })
  await f.dsp.removeAsset(f.output.getRevision(), asset.id, signal())
  assert.equal((await f.dsp.assets()).total, 0)
})

test('scene IR paths are authorized and an asset ID cannot smuggle an arbitrary path', async (t) => {
  const f = fixture(t)
  await f.dsp.initialize()
  const scenes = structuredClone((await f.dsp.state()).scenes.scenes)
  const node = {
    id: 'ir',
    type: 'convolver' as const,
    enabled: true,
    params: { impulseResponsePath: 'C:/private.wav' }
  }
  scenes[0].graph.nodes.push(node)
  await assert.rejects(
    f.dsp.edit(
      { revision: f.output.getRevision(), edit: { kind: 'scenes', scenes, pinnedSceneId: null } },
      signal()
    ),
    /authorized/
  )
  Object.assign(node.params, { impulseResponseAssetId: 'impulseResponse:' + 'a'.repeat(64) })
  await assert.rejects(
    f.dsp.edit(
      { revision: f.output.getRevision(), edit: { kind: 'scenes', scenes, pinnedSceneId: null } },
      signal()
    ),
    /not found/
  )
})

test('slow VST probing leaves output lane and Pause responsive; catalog survives crash quarantine', async (t) => {
  const f = fixture(t)
  await f.dsp.initialize()
  const modules = join(f.root, 'modules')
  mkdirSync(modules)
  writeFileSync(join(modules, 'fixture.vst3'), 'fake module; never executed')
  let release!: () => void
  f.blockScan(
    new Promise<void>((resolve) => {
      release = resolve
    })
  )
  const scan = f.dsp.editVst3(
    { revision: f.output.getRevision(), edit: { kind: 'scan' } },
    signal()
  )
  while (f.scans() === 0) await new Promise((resolve) => setImmediate(resolve))
  let read = false
  await f.output.serialize(async () => {
    read = true
  })
  assert.equal(read, true)
  await f.engine.pause()
  release()
  await scan
  const page = await f.dsp.vst3(0, 1)
  assert.equal(page.total, 1)
  assert.equal('parameters' in page.items[0], false)
  assert.equal((await f.dsp.parameters(page.items[0].id, page.revision, 200, 200)).items.length, 1)
  const scenes: DspScene[] = structuredClone((await f.dsp.state()).scenes.scenes)
  scenes[0].graph.nodes.push({
    id: 'vst',
    type: 'vst3Plugin',
    enabled: true,
    params: {},
    vst3: { catalogId: page.items[0].id, classId: page.items[0].classId }
  })
  await f.dsp.edit(
    {
      revision: f.output.getRevision(),
      edit: { kind: 'scenes', scenes, pinnedSceneId: scenes[0].id }
    },
    signal()
  )
  await f.dsp.quarantineActive('fixture crash')
  assert.equal((await f.catalog.getState()).entries[0].status, 'quarantined')
  await f.dsp.editVst3(
    { revision: f.output.getRevision(), edit: { kind: 'clearQuarantine', id: page.items[0].id } },
    signal()
  )
  assert.equal((await f.catalog.getState()).entries[0].status, 'available')
  assert.equal(f.scans(), 2)
  await f.dsp.flush()
})

const boosted = [
  { frequency: 1000, gain: 8, q: 1, filterType: 'peak' as const },
  { frequency: 18000, gain: 12, q: 10, filterType: 'peak' as const }
]
const importedPreference = [
  { key: 'autoPreamp', value: true },
  { key: 'manualPreamp', value: 2.3 }
]

test('imported automatic EQ works before a window opens and retains the original manual gain', async (t) => {
  const f = fixture(t, {
    processing: {
      dspEnabled: true,
      eqEnabled: true,
      eqMode: 'parametric',
      eqBands: boosted,
      eqPreamp: -1
    },
    preferences: importedPreference
  })
  await f.dsp.initialize()
  assert.equal(f.preferenceReads(), 0)
  assert.equal((await f.dsp.state()).autoPreamp, null)
  await f.dsp.activate()
  const expected = computeAutoPreampDb(boosted)
  assert.equal((await f.dsp.state()).processing.eqPreamp, expected)
  assert.equal(f.engine.getAudioProcessing().eqPreamp, expected)
  assert.deepEqual((await f.dsp.state()).autoPreamp, { enabled: true, manualDb: 2.3 })
  const published = JSON.parse(readFileSync(join(f.root, 'settings.json'), 'utf8'))
  assert.equal(published.audioProcessing.eqPreamp, expected)
  assert.deepEqual(published.audioEqAutoPreamp, { enabled: true, manualDb: 2.3 })
  const unchanged = f.dispatch.length
  const revision = f.settings.getRevision()
  await f.dsp.activate()
  assert.equal(f.preferenceReads(), 1)
  assert.equal(f.settings.getRevision(), revision)
  assert.equal(f.dispatch.length, unchanged)
  await f.dsp.edit(
    { revision: f.output.getRevision(), edit: { kind: 'autoPreamp', enabled: false } },
    signal()
  )
  assert.equal(f.engine.getAudioProcessing().eqPreamp, 2.3)
  assert.equal((await f.dsp.state()).autoPreamp?.manualDb, null)
  await f.dsp.activate()
  assert.equal(f.preferenceReads(), 1)
  assert.equal((await f.dsp.state()).autoPreamp?.enabled, false)
})

test('band edits compensate in the same transaction; manual preamp overrides disable automatic gain', async (t) => {
  const f = fixture(t, {
    processing: {
      dspEnabled: true,
      eqEnabled: true,
      eqMode: 'parametric',
      eqPreamp: 3.7,
      eqBands: boosted
    }
  })
  await f.dsp.initialize()
  await f.dsp.activate()
  await f.dsp.edit(
    { revision: f.output.getRevision(), edit: { kind: 'autoPreamp', enabled: true } },
    signal()
  )
  assert.equal((await f.dsp.state()).autoPreamp?.manualDb, 3.7)
  const bands = boosted.map((band) => ({ ...band, gain: band.gain / 2 }))
  await f.dsp.edit(
    {
      revision: f.output.getRevision(),
      edit: { kind: 'processing', settings: { eqBands: bands } }
    },
    signal()
  )
  assert.equal(f.engine.getAudioProcessing().eqPreamp, computeAutoPreampDb(bands))
  await f.dsp.edit(
    { revision: f.output.getRevision(), edit: { kind: 'processing', settings: { eqPreamp: 4.2 } } },
    signal()
  )
  assert.equal(f.engine.getAudioProcessing().eqPreamp, 4.2)
  assert.deepEqual((await f.dsp.state()).autoPreamp, { enabled: false, manualDb: null })
  const oldRevision = f.output.getRevision()
  await f.dsp.edit({ revision: oldRevision, edit: { kind: 'autoPreamp', enabled: true } }, signal())
  await assert.rejects(
    f.dsp.edit({ revision: oldRevision, edit: { kind: 'autoPreamp', enabled: false } }, signal()),
    { code: 'STALE_REVISION' }
  )
  assert.equal((await f.dsp.state()).autoPreamp?.enabled, true)
})

test('automatic EQ native/file failures roll back both the preference and acknowledged sound', async (t) => {
  const f = fixture(t, {
    processing: {
      dspEnabled: true,
      eqEnabled: true,
      eqMode: 'parametric',
      eqPreamp: 2.3,
      eqBands: boosted
    }
  })
  await f.dsp.initialize()
  await f.dsp.activate()
  const before = await f.dsp.state()
  for (const fail of [f.failNative, f.failWrite]) {
    fail()
    await assert.rejects(
      f.dsp.edit(
        { revision: f.output.getRevision(), edit: { kind: 'autoPreamp', enabled: true } },
        signal()
      )
    )
    const state = await f.dsp.state()
    assert.deepEqual(state.processing, before.processing)
    assert.deepEqual(state.autoPreamp, before.autoPreamp)
    assert.deepEqual(state.scenes.scenes, before.scenes.scenes)
    assert.equal(f.engine.getAudioProcessing().eqPreamp, 2.3)
  }
  assert.equal(f.stops(), 0)
})

test('interrupted browser preference activation retries without overwriting a completed Core preference', async (t) => {
  const f = fixture(t, {
    processing: {
      dspEnabled: true,
      eqEnabled: true,
      eqMode: 'parametric',
      eqPreamp: 2.3,
      eqBands: boosted
    },
    preferences: importedPreference
  })
  await f.dsp.initialize()
  f.failWrite()
  await assert.rejects(f.dsp.activate(), /disk full/)
  assert.equal(f.settings.read().audioEqAutoPreamp, null)
  assert.equal(f.engine.getAudioProcessing().eqPreamp, 2.3)
  await f.dsp.activate()
  assert.deepEqual(f.settings.read().audioEqAutoPreamp, { enabled: true, manualDb: 2.3 })
  await f.dsp.edit(
    { revision: f.output.getRevision(), edit: { kind: 'processing', settings: { eqPreamp: 4 } } },
    signal()
  )
  await f.dsp.activate()
  assert.equal(f.preferenceReads(), 2)
  assert.equal(f.engine.getAudioProcessing().eqPreamp, 4)
})

test('device-rate changes compensate without a client and identical observations do not write', async (t) => {
  const f = fixture(t, {
    processing: { dspEnabled: true, eqEnabled: true, eqMode: 'parametric', eqBands: boosted },
    preferences: importedPreference
  })
  await f.dsp.initialize()
  await f.dsp.activate()
  const initial = f.engine.getAudioProcessing().eqPreamp
  f.info.outputInfo.actualSampleRate = 8000
  f.dsp.observePlayback(f.info)
  await f.dsp.flush()
  const expected = computeAutoPreampDb(boosted, { sampleRate: 8000 })
  assert.notEqual(expected, initial)
  assert.equal(f.engine.getAudioProcessing().eqPreamp, expected)
  const writes = f.settings.getRevision(),
    native = f.dispatch.length
  f.dsp.observePlayback(f.info)
  await f.dsp.flush()
  assert.equal(f.settings.getRevision(), writes)
  assert.equal(f.dispatch.length, native)
  await f.dsp.shutdown()
  f.info.outputInfo.actualSampleRate = 96000
  f.dsp.observePlayback(f.info)
  await f.dsp.flush()
  assert.equal(f.settings.getRevision(), writes)
})

test('active scene EQ edits retain graph nodes, auto headroom and a single headphone contribution', async (t) => {
  const f = fixture(t, {
    processing: { dspEnabled: true, eqEnabled: true, eqMode: 'parametric', eqPreamp: 2.3 }
  })
  await f.dsp.initialize()
  await f.dsp.activate()
  const scenes = structuredClone((await f.dsp.state()).scenes.scenes)
  const custom = structuredClone(scenes[0])
  custom.id = 'custom'
  const eq = custom.graph.nodes.find((node) => node.type === 'equalizer')!
  eq.params = { ...eq.params, mode: 'parametric', bands: boosted, preampDb: 1.7 }
  eq.enabled = true
  scenes.push(custom)
  scenes[0].graph.nodes.push({ id: 'keep-default', type: 'equalizer', enabled: false, params: {} })
  await f.dsp.edit(
    { revision: f.output.getRevision(), edit: { kind: 'scenes', scenes, pinnedSceneId: 'custom' } },
    signal()
  )
  await f.dsp.edit(
    { revision: f.output.getRevision(), edit: { kind: 'autoPreamp', enabled: true } },
    signal()
  )
  let state = await f.dsp.state()
  assert.equal(state.autoPreamp?.manualDb, 1.7)
  assert.equal(state.processing.eqPreamp, computeAutoPreampDb(boosted))
  assert.equal(
    state.scenes.scenes[1].graph.nodes.find((node) => node.type === 'equalizer')!.params.preampDb,
    state.processing.eqPreamp
  )
  assert.ok(state.scenes.scenes[0].graph.nodes.some((node) => node.id === 'keep-default'))
  const compensation = {
    ...f.settings.read().headphoneCompensation,
    enabled: true,
    preampDb: -4,
    bands: [boosted[0]]
  }
  await f.dsp.edit(
    {
      revision: f.output.getRevision(),
      edit: { kind: 'headphoneCompensation', settings: compensation }
    },
    signal()
  )
  state = await f.dsp.state()
  assert.equal(state.headphoneCompensation.enabled, true)
  assert.equal(state.headphoneCompensation.preampDb, -4)
  const bands = [boosted[1]]
  await f.dsp.edit(
    {
      revision: f.output.getRevision(),
      edit: { kind: 'processing', settings: { eqBands: bands } }
    },
    signal()
  )
  state = await f.dsp.state()
  assert.equal(state.processing.eqBands.length, 1)
  assert.equal(f.engine.getAudioProcessing().eqBands.length, 2)
  const active = state.scenes.scenes.find((scene) => scene.id === 'custom')!
  const activeEq = active.graph.nodes.find((node) => node.type === 'equalizer')!
  assert.equal((activeEq.params.bands as unknown[]).length, 2)
  assert.equal(activeEq.params.preampDb, computeAutoPreampDb(bands) - 4)

  await f.dsp.edit(
    {
      revision: f.output.getRevision(),
      edit: { kind: 'headphoneCompensation', settings: { enabled: false } }
    },
    signal()
  )
  state = await f.dsp.state()
  assert.equal(state.headphoneCompensation.enabled, false)
  assert.equal(f.engine.getAudioProcessing().eqBands.length, 1)
  const unstackedEq = state.scenes.scenes
    .find((scene) => scene.id === 'custom')!
    .graph.nodes.find((node) => node.type === 'equalizer')!
  assert.equal((unstackedEq.params.bands as unknown[]).length, 1)
  assert.equal(unstackedEq.params.preampDb, computeAutoPreampDb(bands))
})

test('settings restore uses the real DSP checkpoint and rejects unauthorized IR before any mutation', async (t) => {
  const f = fixture(t)
  await f.dsp.initialize()
  const before = f.settings.read()
  await assert.rejects(
    f.dsp.prepareSettingsRestore(
      {
        ...before,
        audioProcessing: { ...before.audioProcessing, convolverIrPath: 'D:/private.wav' }
      },
      signal()
    ),
    /not authorized/
  )
  assert.deepEqual(f.settings.read(), before)
  const next = f.settings.normalize({
    audioProcessing: { ...before.audioProcessing, dspEnabled: true, eqEnabled: true, eqPreamp: -3 }
  })
  const prepared = await f.dsp.prepareSettingsRestore(next, signal())
  await f.output.serialize(() => f.dsp.restoreSettings(prepared))
  assert.equal(f.engine.getAudioProcessing().eqPreamp, -3)
  assert.equal(f.settings.read().audioProcessing.eqPreamp, -3)
  f.failWrite()
  const rejected = { ...prepared, audioProcessing: { ...prepared.audioProcessing, eqPreamp: -8 } }
  await assert.rejects(
    f.output.serialize(() => f.dsp.restoreSettings(rejected)),
    /disk full/
  )
  assert.equal(f.engine.getAudioProcessing().eqPreamp, -3)
  assert.equal(f.settings.read().audioProcessing.eqPreamp, -3)
})

test('full settings import composes the existing native owner without playback/session commands', async (t) => {
  const f = fixture(t)
  await f.dsp.initialize()
  const service = new CoreSettingsService({
    repository: f.settings,
    serialize: (action) => f.output.serialize(action),
    authorizePaths: async (paths) => paths,
    configureLibrary: async () => {},
    schedule: () => () => {},
    failed: (error) => {
      throw error
    },
    audio: f.engine,
    importEffects: createSettingsImportEffects(f.engine, f.dsp)
  })
  const current = f.settings.read()
  const restored = await service.restore(
    service.getRevision(),
    f.settings.normalize({
      language: 'en-US',
      softwareVolume: 0.25,
      playMode: 'shuffle',
      audioProcessing: {
        ...current.audioProcessing,
        dspEnabled: true,
        eqEnabled: true,
        eqPreamp: -4
      }
    }),
    signal()
  )
  assert.equal(restored.settings.language, 'en-US')
  assert.equal(restored.settings.audioProcessing.eqPreamp, -4)
  assert.equal(f.engine.getAudioProcessing().eqPreamp, -4)
  assert.equal(restored.settings.playMode, 'shuffle')
  assert.equal(restored.settings.softwareVolume, 0.25)
  assert.equal(f.stops(), 0)
  assert.equal(f.info.state, 'stopped')
})
