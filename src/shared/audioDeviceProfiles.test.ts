import assert from 'node:assert/strict'
import test from 'node:test'
import {
  matchAudioDeviceProfile,
  normalizeAudioDeviceProfile,
  normalizeAudioDeviceProfileSettings
} from './audioDeviceProfiles.ts'

const raw = {
  version: 1,
  id: 'desk',
  name: '桌面',
  stableDeviceId: 'stable-dac',
  backend: 'wasapi',
  volumeCeiling: 0.4
}

test('old settings migrate without inventing a profile or raising software volume', () => {
  assert.deepEqual(normalizeAudioDeviceProfileSettings(), {
    version: 1,
    profiles: [],
    activeProfileId: null,
    volumeCeiling: 1,
    outputStageOverride: null
  })
  const profile = normalizeAudioDeviceProfile(raw)!
  const state = normalizeAudioDeviceProfileSettings({
    version: 1,
    profiles: [profile, profile, { ...raw, version: 99 }],
    activeProfileId: 'desk',
    volumeCeiling: 0.4
  })
  assert.equal(state.profiles.length, 1)
  assert.equal(state.activeProfileId, 'desk')
  assert.equal(state.volumeCeiling, 0.4)
  assert.deepEqual(normalizeAudioDeviceProfileSettings(JSON.parse(JSON.stringify(state))), state)
  assert.equal(
    normalizeAudioDeviceProfileSettings({ ...state, activeProfileId: 'missing' }).activeProfileId,
    null
  )
})

test('matching uses stable identity and backend, never display names or default aliases', () => {
  const profile = normalizeAudioDeviceProfile(raw)!
  const devices = [
    { id: 'a', platformStableId: 'stable-dac', label: '同名设备', isDefault: false },
    { id: 'b', platformStableId: 'other-dac', label: '同名设备', isDefault: false },
    { id: 'asio:a', platformStableId: 'stable-dac', label: '同名设备', isDefault: false }
  ]
  assert.deepEqual(
    matchAudioDeviceProfile(profile, devices).map((device) => device.id),
    ['a']
  )
  assert.equal(matchAudioDeviceProfile(profile, [...devices, { ...devices[0], id: 'c' }]).length, 2)
  assert.equal(normalizeAudioDeviceProfile({ ...raw, stableDeviceId: 'auto' }), null)
  assert.equal(normalizeAudioDeviceProfile({ ...raw, backend: 'unknown' }), null)
})

test('profile normalization keeps scene references, SRC, routing and existing DSD policy', () => {
  const profile = normalizeAudioDeviceProfile({
    ...raw,
    dspSceneId: 'headphones',
    graph: { nodes: [1] },
    outputConfig: { routingMode: 'stereo', preferredBufferSize: 256 },
    outputStage: { targetSampleRate: 96000, resamplerQuality: 'soxrHq', dither: 'tpdf' },
    processing: {
      dsdOutputMode: 'dop',
      dsdRatePolicy: 'downrate',
      dsdRoute: { enabled: true, backend: 'asio', device: 'asio:1', strictPassthrough: true }
    }
  })!
  assert.equal(profile.dspSceneId, 'headphones')
  assert.equal('graph' in profile, false)
  assert.equal(profile.processing.dsdRatePolicy, 'downrate')
  assert.equal(profile.processing.dsdRoute.strictPassthrough, true)
  assert.equal(profile.outputStage.targetSampleRate, 96000)
  assert.equal(profile.outputConfig.preferredBufferSize, 256)
})
