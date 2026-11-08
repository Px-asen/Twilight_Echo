import assert from 'node:assert/strict'
import test from 'node:test'
import { useEqualizerHistory, snapshotEqualizer } from './useEqualizerHistory.ts'
import type { EqSnapshot } from './useEqualizerHistory.ts'

const initial: EqSnapshot = {
  eqEnabled: true,
  eqMode: 'parametric',
  eqPreamp: -3,
  eqBands: [{ frequency: 1000, gain: 0, q: 1, filterType: 'peak', enabled: false, channelMask: 2 }]
}
const edited = (gain: number): EqSnapshot => ({
  ...initial,
  eqBands: [{ ...initial.eqBands[0], gain }]
})

test('workspace restore retains both A/B histories without applying audio and rejects a changed engine snapshot', async () => {
  const original = useEqualizerHistory(initial, async () => {})
  await original.commit(edited(3))
  await original.switchSlot('B')
  await original.commit(edited(6))
  await original.travel('undo')
  const serialized = JSON.stringify(original.snapshot())
  const applied: EqSnapshot[] = []
  const resumed = useEqualizerHistory(initial, async (value) => {
    applied.push(value)
  })
  assert.equal(resumed.restore(JSON.parse(serialized), initial), true)
  assert.equal(resumed.activeSlot.value, 'B')
  assert.equal(resumed.canRedo.value, true)
  assert.equal(applied.length, 0)
  await resumed.travel('redo')
  assert.deepEqual(applied.at(-1), edited(6))
  await resumed.switchSlot('A')
  assert.deepEqual(applied.at(-1), edited(3))
  const changed = useEqualizerHistory(edited(9), async () => {})
  assert.equal(changed.restore(JSON.parse(serialized), edited(9)), false)
  assert.equal(changed.canUndo.value, false)
})

test('one committed gesture restores exact EQ parameters, bypass, routing and preamp', async () => {
  const applied: EqSnapshot[] = []
  const history = useEqualizerHistory(initial, async (value) => {
    applied.push(value)
  })
  const preview = snapshotEqualizer(initial)
  for (let gain = 1; gain <= 20; gain++) preview.eqBands[0].gain = gain
  preview.eqPreamp = -12
  preview.eqEnabled = false
  await history.commit(preview)
  preview.eqBands[0].gain = 999
  await history.travel('undo')
  assert.deepEqual(applied.at(-1), initial)
  assert.equal(history.canUndo.value, false)
  assert.equal(history.canRedo.value, true)
  await history.travel('redo')
  assert.equal(applied.at(-1)?.eqBands[0].gain, 20)
  assert.equal(applied.at(-1)?.eqPreamp, -12)
  assert.equal(applied.at(-1)?.eqEnabled, false)
})

test('A/B keeps independent histories and copy replaces only the inactive slot', async () => {
  let applied = initial
  const history = useEqualizerHistory(initial, async (value) => {
    applied = value
  })
  await history.commit(edited(6))
  await history.switchSlot('B')
  assert.deepEqual(applied, initial)
  assert.equal(history.canUndo.value, false)
  await history.commit(edited(-4))
  await history.switchSlot('A')
  assert.equal(applied.eqBands[0].gain, 6)
  await history.travel('undo')
  assert.equal(applied.eqBands[0].gain, 0)
  await history.travel('redo')
  await history.copyToOther()
  assert.equal(history.activeSlot.value, 'A')
  await history.switchSlot('B')
  assert.equal(applied.eqBands[0].gain, 6)
  assert.equal(history.canUndo.value, false)
  applied.eqBands[0].gain = 90
  await history.switchSlot('A')
  assert.equal(applied.eqBands[0].gain, 6)
})

test('new edit after undo drops redo, unchanged commits do not grow history, reset clears both slots', async () => {
  const history = useEqualizerHistory(initial, async () => {})
  await history.commit(initial)
  assert.equal(history.canUndo.value, false)
  await history.commit(edited(6))
  await history.travel('undo')
  await history.commit(edited(-3))
  assert.equal(history.canRedo.value, false)
  history.reset(initial)
  assert.equal(history.canUndo.value, false)
  await history.switchSlot('B')
  assert.equal(history.canUndo.value, false)
})

test('pending applies serialize; rejected undo or A/B does not advance history and allows retry', async () => {
  let release!: () => void
  let rejectApply = false
  let calls = 0
  const applied: EqSnapshot[] = []
  const history = useEqualizerHistory(initial, async (value) => {
    calls++
    if (calls === 1)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    if (rejectApply) throw new Error('engine rejected')
    applied.push(value)
  })
  const edit = history.commit(edited(6))
  const switchB = history.switchSlot('B')
  await Promise.resolve()
  assert.equal(calls, 1)
  assert.equal(history.busy.value, true)
  release()
  await Promise.all([edit, switchB])
  assert.equal(applied[0].eqBands[0].gain, 6)
  assert.equal(applied[1].eqBands[0].gain, 0)
  rejectApply = true
  await assert.rejects(history.switchSlot('A'), /engine rejected/)
  assert.equal(history.activeSlot.value, 'B')
  rejectApply = false
  await history.switchSlot('A')
  rejectApply = true
  await assert.rejects(history.travel('undo'), /engine rejected/)
  assert.equal(history.canUndo.value, true)
  assert.equal(history.canRedo.value, false)
  assert.equal(history.busy.value, false)
  rejectApply = false
  await history.travel('undo')
  assert.deepEqual(applied.at(-1), initial)
})

test('history stores at most 100 edits and never captures unrelated processing settings', async () => {
  const snapshot = snapshotEqualizer({ ...initial, dspEnabled: true } as EqSnapshot)
  assert.equal('dspEnabled' in snapshot, false)
  const history = useEqualizerHistory(initial, async () => {})
  for (let index = 1; index <= 105; index++) await history.commit(edited(index))
  for (let index = 0; index < 100; index++) await history.travel('undo')
  assert.equal(history.canUndo.value, false)
})
