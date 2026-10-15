import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditorTransition } from './createEditorTransition.ts'

function fixture(duration?: number) {
  let time = 0,
    handle = 0,
    requests = 0
  const callbacks = new Map<number, (time: number) => void>()
  const cancelled: number[] = []
  const renders: number[] = []
  const motions: boolean[] = []
  const transition = createEditorTransition({
    duration,
    clock: {
      now: () => time,
      request: (callback) => {
        const next = handle++
        requests++
        callbacks.set(next, callback)
        return next
      },
      cancel: (next) => {
        cancelled.push(next)
        callbacks.delete(next)
      }
    },
    render: (next) => renders.push(next),
    motion: (next) => motions.push(next)
  })
  return {
    transition,
    callbacks,
    cancelled,
    renders,
    motions,
    get requests() {
      return requests
    },
    advance(delta: number) {
      time += delta
    },
    step(delta: number) {
      time += delta
      const pending = [...callbacks.values()]
      callbacks.clear()
      pending.forEach((callback) => callback(time))
    }
  }
}

test('a new transition is idle at zero without rendering or requesting a frame', () => {
  const { transition, callbacks, renders, motions } = fixture()
  assert.equal(transition.value, 0)
  assert.equal(transition.target, 0)
  assert.equal(transition.running, false)
  transition.setTarget(0)
  transition.setActive(true)
  transition.setAnimated(true)
  transition.finish()
  assert.equal(callbacks.size, 0)
  assert.deepEqual(renders, [])
  assert.deepEqual(motions, [])
})

test('progress eases through intermediate values and stops scheduling at the exact target', () => {
  const { transition, callbacks, renders, motions, step } = fixture()
  transition.setTarget(1)
  assert.equal(transition.value, 0)
  assert.equal(transition.running, true)
  assert.equal(callbacks.size, 1)
  step(100)
  assert.equal(transition.value, 0.15625)
  step(100)
  assert.equal(transition.value, 0.5)
  step(100)
  assert.equal(transition.value, 0.84375)
  step(100)
  assert.equal(transition.value, 1)
  assert.equal(transition.target, 1)
  assert.equal(transition.running, false)
  assert.equal(callbacks.size, 0)
  assert.deepEqual(motions, [true, false])
  const completedRenders = renders.length
  step(1000)
  assert.equal(renders.length, completedRenders)
})

test('duration controls completion while zero duration publishes immediately', () => {
  const timed = fixture(200)
  timed.transition.setTarget(1)
  timed.step(100)
  assert.equal(timed.transition.value, 0.5)
  timed.step(100)
  assert.equal(timed.transition.value, 1)
  assert.equal(timed.callbacks.size, 0)
  const immediate = fixture(0)
  immediate.transition.setTarget(1)
  assert.deepEqual(immediate.renders, [1])
  assert.equal(immediate.requests, 0)
  assert.equal(immediate.transition.running, false)
})

test('nonfinite targets are ignored and finite targets stay within zero and one', () => {
  const { transition, callbacks, renders } = fixture()
  for (const next of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
    transition.setTarget(next)
  assert.equal(transition.target, 0)
  assert.equal(callbacks.size, 0)
  transition.setTarget(2, false)
  assert.equal(transition.value, 1)
  transition.setTarget(-2, false)
  assert.equal(transition.value, 0)
  transition.setTarget(0.25, false)
  assert.deepEqual(renders, [1, 0, 0.25])
  for (const duration of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const timed = fixture(duration)
    timed.transition.setTarget(1)
    timed.step(200)
    assert.equal(timed.transition.value, 0.5)
    timed.step(200)
    assert.equal(timed.transition.value, 1)
  }
})

test('reversing an interrupted transition starts at the last published value', () => {
  const { transition, callbacks, step, advance } = fixture()
  transition.setTarget(1)
  step(100)
  const published = transition.value
  advance(100)
  transition.setTarget(0)
  assert.equal(transition.value, published, 'retargeting jumps ahead of the visible frame')
  assert.equal(transition.target, 0)
  assert.equal(callbacks.size, 1)
  step(1)
  assert.ok(transition.value > published, 'reversal abruptly loses the visible incoming velocity')
  step(100)
  assert.ok(transition.value < published && transition.value > 0)
  step(100)
  assert.equal(transition.value, 0)
  assert.equal(callbacks.size, 0)
  assert.equal(transition.running, false)
})

test('repeating a target leaves the pending frame and its original timing intact', () => {
  const state = fixture()
  state.transition.setTarget(1)
  state.step(100)
  const pending = [...state.callbacks.keys()]
  const requests = state.requests
  for (let i = 0; i < 100; i++) state.transition.setTarget(1)
  assert.deepEqual([...state.callbacks.keys()], pending)
  assert.equal(state.requests, requests)
  assert.deepEqual(state.motions, [true])
  state.step(300)
  assert.equal(state.transition.value, 1)
  assert.equal(state.callbacks.size, 0)
})

test('hidden changes perform no work and resume publishes the newest target exactly once', () => {
  const state = fixture()
  state.transition.setTarget(1)
  state.step(100)
  const stale = [...state.callbacks.values()][0]
  state.transition.setActive(false)
  const published = state.transition.value
  const renders = state.renders.length
  const requests = state.requests
  for (let i = 0; i < 100; i++) state.transition.setTarget(i / 100)
  state.transition.setTarget(0.75)
  state.step(1000)
  stale(1000)
  assert.equal(state.transition.value, published)
  assert.equal(state.transition.target, 0.75)
  assert.equal(state.transition.running, false)
  assert.equal(state.renders.length, renders)
  assert.equal(state.requests, requests)
  assert.equal(state.callbacks.size, 0)
  state.transition.setActive(true)
  assert.equal(state.transition.value, 0.75)
  assert.equal(state.renders.length, renders + 1)
  assert.equal(state.requests, requests)
  state.transition.setActive(true)
  stale(2000)
  assert.equal(state.renders.length, renders + 1)
  assert.equal(state.callbacks.size, 0)
})

test('an explicit nonanimated target cancels animation, including its current target', () => {
  const state = fixture()
  state.transition.setTarget(1)
  state.transition.setTarget(1, false)
  assert.deepEqual(state.cancelled, [0], 'frame handle zero was not cancelled')
  assert.equal(state.transition.value, 1)
  assert.equal(state.callbacks.size, 0)
  state.transition.setTarget(0)
  state.step(100)
  state.transition.setTarget(0.4, false)
  assert.equal(state.transition.value, 0.4)
  assert.equal(state.transition.target, 0.4)
  assert.equal(state.transition.running, false)
  assert.equal(state.callbacks.size, 0)
})

test('disabling animation finishes the current target and future targets render directly', () => {
  const state = fixture()
  state.transition.setTarget(1)
  state.step(100)
  state.transition.setAnimated(false)
  assert.equal(state.transition.value, 1)
  assert.equal(state.transition.running, false)
  assert.equal(state.callbacks.size, 0)
  const requests = state.requests
  state.transition.setTarget(0.3)
  assert.equal(state.transition.value, 0.3)
  assert.equal(state.requests, requests)
  state.transition.setActive(false)
  state.transition.setTarget(0.6)
  assert.equal(state.transition.value, 0.3)
  state.transition.setActive(true)
  assert.equal(state.transition.value, 0.6)
  state.transition.setAnimated(true)
  assert.equal(state.callbacks.size, 0)
  state.transition.setTarget(1)
  assert.equal(state.callbacks.size, 1)
})

test('finish reaches the target while inactive finish waits for resume', () => {
  const state = fixture()
  state.transition.setTarget(1)
  state.step(100)
  state.transition.finish()
  assert.equal(state.transition.value, 1)
  assert.equal(state.transition.running, false)
  assert.equal(state.callbacks.size, 0)
  state.transition.setActive(false)
  state.transition.setTarget(0.4)
  const renders = state.renders.length
  state.transition.finish()
  assert.equal(state.transition.value, 1)
  assert.equal(state.renders.length, renders)
  state.transition.setActive(true)
  assert.equal(state.transition.value, 0.4)
  assert.equal(state.renders.length, renders + 1)
  assert.equal(state.callbacks.size, 0)
})

test('cancelled callbacks cannot publish stale values or clear a replacement frame', () => {
  const state = fixture()
  state.transition.setTarget(1)
  state.step(100)
  const stale = [...state.callbacks.values()][0]
  state.transition.setTarget(0)
  const published = state.transition.value
  const replacement = [...state.callbacks.keys()]
  const renders = state.renders.length
  stale(500)
  assert.equal(state.transition.value, published)
  assert.equal(state.renders.length, renders)
  assert.deepEqual([...state.callbacks.keys()], replacement)
  state.step(400)
  assert.equal(state.transition.value, 0)
  assert.equal(state.transition.running, false)
  assert.equal(state.callbacks.size, 0)
})

test('dispose releases resources and rejects all later requests and late callbacks', () => {
  const state = fixture()
  state.transition.setTarget(1)
  const stale = [...state.callbacks.values()][0]
  state.transition.dispose()
  const requests = state.requests
  state.transition.setTarget(0.5)
  state.transition.setActive(false)
  state.transition.setActive(true)
  state.transition.setAnimated(false)
  state.transition.finish()
  state.transition.dispose()
  stale(1000)
  assert.equal(state.transition.value, 0)
  assert.equal(state.transition.target, 1)
  assert.equal(state.transition.running, false)
  assert.equal(state.requests, requests)
  assert.equal(state.callbacks.size, 0)
  assert.deepEqual(state.renders, [])
  assert.deepEqual(state.motions, [true, false])
})

test('retargeting inside render does not schedule the superseded animation again', () => {
  let time = 0,
    handle = 0,
    redirected = false
  const callbacks = new Map<number, (time: number) => void>()
  const transition = createEditorTransition({
    clock: {
      now: () => time,
      request: (callback) => {
        callbacks.set(++handle, callback)
        return handle
      },
      cancel: (next) => callbacks.delete(next)
    },
    render: () => {
      if (!redirected) {
        redirected = true
        transition.setTarget(0)
      }
    }
  })
  transition.setTarget(1)
  const pending = [...callbacks.values()]
  callbacks.clear()
  time = 100
  pending.forEach((callback) => callback(time))
  assert.equal(transition.value, 0.15625)
  assert.equal(transition.target, 0)
  assert.equal(callbacks.size, 1)
  const replacement = [...callbacks.values()]
  callbacks.clear()
  time = 500
  replacement.forEach((callback) => callback(time))
  assert.equal(transition.value, 0)
  assert.equal(transition.running, false)
  assert.equal(callbacks.size, 0)
})
