import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { configurationFixture } from './configuration.fixture.ts'
import { prepareMigratedConfiguration } from './configuration.ts'
import { migratePersonalBackup } from './migration.ts'
import { DspAssetLibrary } from '../../core/audio/dspAssetLibrary.ts'
import { createLegacyDspGraph } from '../../shared/dspGraph.ts'

async function fixture(t: test.TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'twilight-config-migration-'))
  t.after(async () => {
    assert.equal(resolve(temporary, '..'), resolve(tmpdir()))
    await rm(temporary, { recursive: true, force: true })
  })
  const source = await configurationFixture(join(temporary, 'source')),
    root = join(temporary, 'target')
  await mkdir(root)
  return { temporary, source, root }
}

test('settings and tedsp migration retain processing, scene rules, pin and asset bytes but not desktop device, path or trust settings', async (t) => {
  const f = await fixture(t),
    source = await readFile(f.source.settingsFile, 'utf8')
  const result = await prepareMigratedConfiguration(f.root, {
    settingsFile: f.source.settingsFile,
    dspProfile: f.source.dspProfile,
    resumeMode: 'trackAndPosition',
    libraryRoots: [],
    mappings: []
  })
  assert.equal(result.settings.softwareVolume, 0.42)
  assert.equal(result.settings.remoteControlEnabled, false)
  assert.notEqual(result.settings.audioDevice, 'old-desktop-DAC')
  assert.notEqual(result.settings.cachePath, 'Z:/old-desktop-cache')
  assert.deepEqual(result.settings.libraryFolders, [])
  assert.equal(result.settings.dspPinnedSceneId, 'room')
  assert.deepEqual(result.settings.dspScenes[0].rules, f.source.scene.rules)
  assert.equal(result.settings.dspScenes[0].graph.outputStage.headroomGainDb, -6)
  const assets = new DspAssetLibrary(join(f.root, 'dsp-assets'), {
    now: Date.now,
    newId: randomUUID
  })
  assert.deepEqual(await readFile(await assets.getPath(f.source.asset.id)), f.source.impulse)
  assert.deepEqual(
    result.report.assets.map((asset) => asset.id),
    [f.source.asset.id]
  )
  assert.equal(await readFile(f.source.settingsFile, 'utf8'), source)
})

test('a partial settings backup changes only its supplied business fields and keeps the personal resume mode', async (t) => {
  const f = await fixture(t)
  await writeFile(
    f.source.settingsFile,
    JSON.stringify({ softwareVolume: 0.25, remoteControlEnabled: true })
  )
  const result = await prepareMigratedConfiguration(f.root, {
    settingsFile: f.source.settingsFile,
    resumeMode: 'trackAndPosition',
    libraryRoots: [],
    mappings: []
  })
  assert.deepEqual(result.report.importedFields, ['softwareVolume'])
  assert.equal(result.settings.softwareVolume, 0.25)
  assert.equal(result.settings.playbackResumeMode, 'trackAndPosition')
  assert.equal(result.settings.remoteControlEnabled, false)
})

test('legacy convolution can be explicitly copied without granting its directory as a scanned music root', async (t) => {
  const f = await fixture(t)
  f.source.settings.audioProcessing.convolverIrPath = f.source.impulseFile
  f.source.settings.dspScenes = [
    {
      ...f.source.scene,
      id: 'default',
      graph: createLegacyDspGraph(f.source.settings.audioProcessing)
    }
  ]
  await writeFile(f.source.settingsFile, JSON.stringify(f.source.settings))
  await assert.rejects(
    prepareMigratedConfiguration(f.root, {
      settingsFile: f.source.settingsFile,
      resumeMode: 'off',
      libraryRoots: [],
      mappings: []
    }),
    /明确授权/
  )
  const result = await prepareMigratedConfiguration(f.root, {
    settingsFile: f.source.settingsFile,
    impulseFile: f.source.impulseFile,
    resumeMode: 'off',
    libraryRoots: [],
    mappings: []
  })
  assert.ok(result.settings.audioProcessing.convolverIrPath.startsWith(join(f.root, 'dsp-assets')))
  assert.notEqual(result.settings.audioProcessing.convolverIrPath, f.source.impulseFile)
  const convolver = result.settings.dspScenes[0].graph.nodes.find(
    (node) => node.type === 'convolver'
  )!
  assert.equal(
    convolver.params.impulseResponsePath,
    result.settings.audioProcessing.convolverIrPath
  )
  assert.deepEqual(result.settings.libraryFolders, [])
})

test('missing managed assets cannot be replaced by an arbitrary path in a settings backup', async (t) => {
  const f = await fixture(t)
  f.source.settings.dspScenes[0].graph.nodes[0].params.impulseResponsePath = f.source.impulseFile
  await writeFile(f.source.settingsFile, JSON.stringify(f.source.settings))
  await assert.rejects(
    prepareMigratedConfiguration(f.root, {
      settingsFile: f.source.settingsFile,
      resumeMode: 'off',
      libraryRoots: [join(f.temporary, 'source')],
      mappings: []
    }),
    /Managed impulse response not found/
  )
})

test('personal migration accepts settings and tedsp together, previews outside the destination and commits assets with the new profile', async (t) => {
  const f = await fixture(t),
    file = join(f.temporary, 'personal.json'),
    destination = join(f.temporary, 'server')
  await writeFile(
    file,
    JSON.stringify({
      format: 'twilight-personal-data',
      version: 1,
      createdAt: '2026-11-03T00:00:00Z',
      data: { library: { version: 2, tracks: [], folders: [], exclusions: [] } }
    })
  )
  const input = {
    file,
    destination,
    libraryRoots: [],
    settingsFile: f.source.settingsFile,
    dspProfile: f.source.dspProfile
  }
  const preview = await migratePersonalBackup(input)
  assert.equal(preview.configuration.pinnedSceneId, 'room')
  await assert.rejects(access(destination), { code: 'ENOENT' })
  await migratePersonalBackup({ ...input, apply: true })
  const saved = JSON.parse(await readFile(join(destination, 'settings.json'), 'utf8'))
  assert.equal(saved.softwareVolume, 0.42)
  assert.equal(saved.remoteControlEnabled, false)
  assert.equal(saved.dspScenes[0].graph.nodes[0].params.impulseResponseAssetId, f.source.asset.id)
  const assets = new DspAssetLibrary(join(destination, 'dsp-assets'), {
    now: Date.now,
    newId: randomUUID
  })
  assert.deepEqual(await readFile(await assets.getPath(f.source.asset.id)), f.source.impulse)
})
