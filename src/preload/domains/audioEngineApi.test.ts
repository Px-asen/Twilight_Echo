import assert from 'node:assert/strict'
import type { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'
import test from 'node:test'
import {
  normalizeAudioDeviceProfile,
  normalizeAudioDeviceProfileSettings,
  type AudioDeviceProfilesSnapshot
} from '../../shared/audioDeviceProfiles.ts'

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: 'test:audio-preload-electron', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'test:audio-preload-electron')
      return {
        format: 'module',
        shortCircuit: true,
        source: `import { EventEmitter } from 'node:events'
export const calls = []
export const state = { response: null }
export const ipcRenderer = Object.assign(new EventEmitter(), {
  invoke: async (...args) => { calls.push(args); return state.response }
})`
      }
    return nextLoad(url, context)
  }
})
const electron = (await import('electron')) as unknown as {
  calls: unknown[][]
  state: { response: AudioDeviceProfilesSnapshot | null }
  ipcRenderer: EventEmitter
}
const { audioEngineApi } = await import('./audioEngineApi.ts')
hooks.deregister()

test('device profile actions are exposed inside the audioEngine domain and forward complete DTOs', async () => {
  assert.deepEqual(Object.keys(audioEngineApi).sort(), [
    'audioEngine',
    'bpmAnalysis',
    'loudnessAnalysis',
    'opra'
  ])
  const profile = normalizeAudioDeviceProfile({
    version: 1,
    id: 'desktop',
    name: '桌面音箱',
    stableDeviceId: 'device:desktop',
    backend: 'wasapi'
  })
  assert.ok(profile)
  const snapshot: AudioDeviceProfilesSnapshot = {
    ...normalizeAudioDeviceProfileSettings(),
    current: profile,
    devices: [],
    scenes: [],
    unavailable: {},
    phase: 'idle',
    error: ''
  }
  electron.state.response = snapshot
  const api = audioEngineApi.audioEngine

  assert.equal(await api.getDeviceProfiles(), snapshot)
  assert.equal(await api.saveDeviceProfile(profile), snapshot)
  assert.equal(await api.applyDeviceProfile(profile.id), snapshot)
  assert.equal(await api.deleteDeviceProfile(profile.id), snapshot)
  assert.deepEqual(electron.calls, [
    ['audioEngine:getDeviceProfiles'],
    ['audioEngine:saveDeviceProfile', profile],
    ['audioEngine:applyDeviceProfile', profile.id],
    ['audioEngine:deleteDeviceProfile', profile.id]
  ])
})

test('device profile subscriptions can be removed independently and never expose Electron events', () => {
  const received: unknown[][] = []
  let secondCalls = 0
  const channel = 'audioEngine:device-profiles-changed'
  const removeFirst = audioEngineApi.audioEngine.onDeviceProfilesChanged((...args: unknown[]) => {
    received.push(args)
  })
  const removeSecond = audioEngineApi.audioEngine.onDeviceProfilesChanged(() => {
    secondCalls += 1
  })

  electron.ipcRenderer.emit(channel, { sender: 'private-electron-event' })
  assert.deepEqual(received, [[]])
  assert.equal(secondCalls, 1)

  removeFirst()
  electron.ipcRenderer.emit(channel, {})
  assert.deepEqual(received, [[]])
  assert.equal(secondCalls, 2)

  removeSecond()
  assert.equal(electron.ipcRenderer.listenerCount(channel), 0)
})
