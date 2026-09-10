import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeEqualizerPatch } from './equalizerSettingsPatch.ts'
import { defaultAudioProcessing } from './equalizerPageLogic.ts'

test('switching modes and editing bands preserves EQ bypass until explicitly enabled', () => {
  const disabled = { ...defaultAudioProcessing, eqEnabled: false, dspEnabled: false }
  const parametric = mergeEqualizerPatch(disabled, { eqMode: 'parametric' })
  assert.equal(parametric.eqEnabled, false)
  assert.equal(parametric.dspEnabled, false)
  const edited = mergeEqualizerPatch(parametric, { eqPreamp: -4 })
  assert.equal(edited.eqEnabled, false)
  const enabled = mergeEqualizerPatch(edited, { eqEnabled: true })
  assert.equal(enabled.eqEnabled, true)
  assert.equal(enabled.dspEnabled, true)
  assert.equal(mergeEqualizerPatch(enabled, { eqMode: 'graphic' }).eqEnabled, true)
})
