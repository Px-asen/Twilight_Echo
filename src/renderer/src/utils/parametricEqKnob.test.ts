import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createEqKnobGesture,
  createEqWheelCommit,
  eqParameterAtPosition,
  eqParameterPosition,
  normalizeEqParameter,
  nudgeEqParameter
} from './parametricEqKnob.ts'

test('knob mapping uses logarithmic frequency and Q, and linear gain', () => {
  assert.equal(eqParameterAtPosition('frequency', 0), 20)
  assert.equal(eqParameterAtPosition('frequency', 1), 20000)
  assert.equal(eqParameterAtPosition('frequency', 0.5), 632)
  assert.equal(eqParameterAtPosition('q', 0.5), 1.41)
  assert.equal(eqParameterAtPosition('gain', 0.5), 0)
  assert.ok(Math.abs(eqParameterPosition('frequency', 200) - 1 / 3) < 1e-12)
  assert.equal(eqParameterPosition('gain', 9), 0.75)
  assert.equal(eqParameterAtPosition('gain', -2), -18)
  assert.equal(eqParameterAtPosition('q', 4), 20)
  assert.equal(normalizeEqParameter('frequency', 2345.67), 2346)
  assert.equal(normalizeEqParameter('gain', 3.26), 3.3)
})

test('keyboard and wheel steps support fine edits and respect filter limits', () => {
  assert.equal(nudgeEqParameter('gain', 0, 1), 0.5)
  assert.equal(nudgeEqParameter('gain', 0, 1, true), 0.1)
  assert.equal(nudgeEqParameter('frequency', 1000, 1), 1025)
  assert.equal(nudgeEqParameter('frequency', 1000, 1, true), 1005)
  assert.equal(nudgeEqParameter('q', 1, 1), 1.08)
  assert.equal(nudgeEqParameter('q', 1, 1, true), 1.01)
  assert.equal(nudgeEqParameter('gain', 18, 1), 18)
  assert.equal(nudgeEqParameter('q', 0.1, -1), 0.1)
})

test('pointer editing spans the range in 180px, ignores other pointers, and commits once', () => {
  let value = -18
  let commits = 0
  const gesture = createEqKnobGesture({
    field: 'gain',
    readValue: () => value,
    preview: (next) => {
      value = next
    },
    commit: () => {
      commits += 1
    }
  })
  assert.equal(gesture.start(1, 300), true)
  assert.equal(gesture.start(2, 100), false)
  gesture.move(2, 0)
  assert.equal(value, -18)
  gesture.move(1, 210)
  assert.equal(value, 0)
  gesture.move(1, 120)
  assert.equal(value, 18)
  assert.equal(commits, 0)
  assert.equal(gesture.finish(2), false)
  assert.equal(gesture.finish(1), true)
  assert.equal(gesture.finish(1), false)
  assert.equal(commits, 1)
})

test('switching Shift during a gesture changes speed without jumping', () => {
  let value = 0
  const gesture = createEqKnobGesture({
    field: 'gain',
    readValue: () => value,
    preview: (next) => {
      value = next
    },
    commit: () => {}
  })
  gesture.start(1, 200)
  gesture.move(1, 190)
  assert.equal(value, 2)
  gesture.move(1, 180, true)
  assert.equal(value, 2.2)
  gesture.move(1, 170)
  assert.equal(value, 4.2)
})

test('pointer cancellation finishes the last preview once and an untouched click never commits', () => {
  let value = 1000
  let commits = 0
  const gesture = createEqKnobGesture({
    field: 'frequency',
    readValue: () => value,
    preview: (next) => {
      value = next
    },
    commit: () => {
      commits += 1
    }
  })
  gesture.start(4, 200)
  gesture.finish()
  assert.equal(commits, 0)
  gesture.start(4, 200)
  gesture.move(4, 190)
  const preview = value
  gesture.finish()
  gesture.finish(4)
  assert.equal(value, preview)
  assert.equal(commits, 1)
  assert.equal(gesture.active(), false)
})

test('a wheel burst commits once after settling and flush cannot duplicate that commit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let commits = 0
  const wheel = createEqWheelCommit(() => {
    commits += 1
  })
  wheel.schedule()
  t.mock.timers.tick(100)
  wheel.schedule()
  t.mock.timers.tick(139)
  assert.equal(commits, 0)
  t.mock.timers.tick(1)
  assert.equal(commits, 1)
  wheel.flush()
  assert.equal(commits, 1)
  wheel.schedule()
  wheel.flush()
  t.mock.timers.tick(200)
  assert.equal(commits, 2)
  assert.equal(wheel.pending(), false)
})
