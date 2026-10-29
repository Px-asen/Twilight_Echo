import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CoreSettingsRepository } from './settingsRepository.ts'
import { createDefaultSettings, normalizeAppSettings } from '../settings/normalization.ts'
import { buildEffectiveAudioProcessingSettings } from '../audio/audioProcessingEffective.ts'
import { initialAudioSettings, coreAudioConfiguration } from '../audio/settings.ts'

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'core-settings-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let changed = 0
  const options = {
    filePath: join(root, 'settings.json'),
    environment: {
      platform: 'win32' as const,
      defaultCachePath: join(root, 'cache'),
      resolvePath: resolve
    },
    changed: () => changed++
  }
  return { root, options, changed: () => changed }
}

test('normalization keeps platform defaults, aliases and all settings domains without Electron', () => {
  for (const [platform, output] of [
    ['win32', 'wasapi'],
    ['darwin', 'coreaudio'],
    ['linux', 'alsa']
  ] as const) {
    const defaults = createDefaultSettings(platform)
    assert.equal(defaults.audioOutput, output)
    const settings = normalizeAppSettings(
      { autoLaunch: true, closeToTray: true, musicCachePath: './old-cache' },
      {
        platform,
        defaultCachePath: 'default-cache',
        resolvePath: (path) => `resolved:${path}`
      }
    )
    assert.equal(settings.audioOutput, output)
    assert.equal(settings.cachePath, 'resolved:./old-cache')
    assert.equal(settings.musicCachePath, settings.cachePath)
    assert.equal(settings.launchAtLogin, true)
    assert.equal(settings.closeWindowBehavior, 'tray')
    assert.equal(settings.audioDeviceProfiles.volumeCeiling, 1)
    assert.equal(settings.playbackResumeMode, 'off')
  }
})

test('the existing full settings file round-trips; startup audio inputs never override persisted choices', (t) => {
  const f = fixture(t)
  const repository = new CoreSettingsRepository({
    ...f.options,
    initial: { audioDevice: 'initial-dac' }
  })
  assert.equal(repository.read().audioDevice, 'initial-dac')
  repository.update({
    audioDevice: 'saved-dac',
    remoteControlEnabled: true,
    downloadFolder: join(f.root, 'downloads'),
    language: 'zh-CN'
  })
  repository.update({ audioExclusiveMode: true })
  const file = JSON.parse(readFileSync(f.options.filePath, 'utf8'))
  assert.equal(file.audioDevice, 'saved-dac')
  assert.equal(file.remoteControlEnabled, true)
  assert.equal(file.language, 'zh-CN')
  assert.equal(file.downloadFolder, join(f.root, 'downloads'))
  assert.equal(file.audioExclusiveMode, true)
  assert.equal(file.settings, undefined)
  assert.equal(f.changed(), 2)
  const reopened = new CoreSettingsRepository({
    ...f.options,
    initial: { audioDevice: 'wrong-initial-dac' }
  })
  assert.deepEqual(reopened.read(), repository.read())
  const detached = reopened.read()
  detached.libraryFolders.push('renderer-mutation')
  assert.deepEqual(reopened.read().libraryFolders, [])
})

test('failed atomic settings publication leaves in-memory authority and notifications unchanged', (t) => {
  const f = fixture(t)
  const repository = new CoreSettingsRepository(f.options)
  repository.update({ audioDevice: 'old' })
  const before = repository.read()
  renameSync(f.options.filePath, join(f.root, 'saved.json'))
  mkdirSync(f.options.filePath)
  writeFileSync(join(f.options.filePath, 'obstruction'), 'not a settings file')
  assert.throws(() => repository.update({ audioDevice: 'new' }))
  assert.deepEqual(repository.read(), before)
  assert.equal(f.changed(), 1)
})

test('missing settings retain the original startup processing graph rather than the generic default scene', (t) => {
  const f = fixture(t)
  const repository = new CoreSettingsRepository({
    ...f.options,
    initial: initialAudioSettings({
      exclusiveMode: false,
      audioProcessing: { dspEnabled: true, eqEnabled: true, eqPreamp: -5 }
    })
  })
  const config = coreAudioConfiguration(repository.read())
  const equalizer = config.dspScenes![0].graph.nodes.find((node) => node.type === 'equalizer')!
  assert.equal(equalizer.enabled, true)
  assert.equal(equalizer.params.preampDb, -5)
  assert.equal(config.audioProcessing!.eqPreamp, -5)
})

test('Core retains backup recovery and preserves user EQ separately from effective headphone compensation', (t) => {
  const f = fixture(t)
  const repository = new CoreSettingsRepository(f.options)
  const processing = {
    ...repository.read().audioProcessing,
    dspEnabled: true,
    eqEnabled: true,
    eqPreamp: -2
  }
  const compensation = {
    ...repository.read().headphoneCompensation,
    enabled: true,
    preampDb: -4,
    bands: [{ frequency: 100, gain: 2, q: 1, filterType: 'peak' as const }]
  }
  repository.update({ audioProcessing: processing, headphoneCompensation: compensation })
  repository.update({ audioDevice: 'new' })
  writeFileSync(f.options.filePath, '{corrupt')
  const recovered = new CoreSettingsRepository(f.options)
  assert.equal(recovered.issue?.kind, 'recovered')
  assert.equal(recovered.read().audioProcessing.eqPreamp, -2)
  const effective = buildEffectiveAudioProcessingSettings(
    recovered.read().audioProcessing,
    recovered.read().headphoneCompensation
  )
  assert.equal(effective.eqPreamp, -6)
  assert.equal(recovered.read().audioProcessing.eqPreamp, -2)
})

test('built-in and custom EQ presets persist modifications, full deletion, and factory restoration', (t) => {
  const f = fixture(t)
  const repository = new CoreSettingsRepository(f.options)
  assert.equal(repository.read().audioEqBuiltInPresets, null)
  assert.deepEqual(repository.read().audioEqPresets, [])

  repository.update({
    audioEqBuiltInPresets: [
      {
        id: 'warm',
        name: '  Warm V2  ',
        eqMode: 'graphic',
        eqPreamp: -2.5,
        eqBands: [{ frequency: 62, gain: 3.5, q: 1, filterType: 'peak' }]
      }
    ],
    audioEqPresets: [
      {
        id: 'custom-1',
        name: 'My Custom',
        eqMode: 'parametric',
        eqPreamp: -1,
        eqBands: [{ frequency: 1000, gain: -2, q: 1.4, filterType: 'peak' }]
      }
    ]
  })
  assert.equal(repository.read().audioEqBuiltInPresets?.length, 1)
  assert.equal(repository.read().audioEqBuiltInPresets?.[0]?.name, 'Warm V2')
  assert.equal(repository.read().audioEqPresets.length, 1)

  // Deleting all built-in presets persists an explicit empty list instead of reverting to null.
  repository.update({ audioEqBuiltInPresets: [], audioEqPresets: [] })
  const reopened = new CoreSettingsRepository(f.options)
  assert.deepEqual(reopened.read().audioEqBuiltInPresets, [])
  assert.deepEqual(reopened.read().audioEqPresets, [])

  // Restoring factory defaults sets audioEqBuiltInPresets back to null.
  reopened.update({ audioEqBuiltInPresets: null })
  assert.equal(reopened.read().audioEqBuiltInPresets, null)
})
