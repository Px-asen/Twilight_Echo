import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditorParallax } from './createEditorParallax.ts'
import type { AppearanceLayerTilt } from './appearanceLayerView.ts'

function fixture(firstHandle = 1) {
  let time = 0,
    handle = firstHandle
  const callbacks = new Map<number, (time: number) => void>()
  const renders: AppearanceLayerTilt[] = []
  let requests = 0,
    cancellations = 0
  const parallax = createEditorParallax({
    clock: {
      now: () => time,
      request(callback) {
        requests++
        callbacks.set(handle, callback)
        return handle++
      },
      cancel(id) {
        cancellations++
        callbacks.delete(id)
      }
    },
    render: (tilt) => renders.push(tilt)
  })
  return {
    parallax,
    callbacks,
    renders,
    get requests() {
      return requests
    },
    get cancellations() {
      return cancellations
    },
    step(delta = 16) {
      time += delta
      const pending = [...callbacks.values()]
      callbacks.clear()
      pending.forEach((callback) => callback(time))
    },
    settle() {
      for (let frame = 0; callbacks.size && frame < 80; frame++) this.step()
      assert.equal(callbacks.size, 0, 'stationary pointer leaves a perpetual frame loop')
    }
  }
}

test('centre and idle input do no work; entry and exit ease to completion within 120ms', () => {
  const f = fixture()
  f.parallax.setPointer({ x: 0, y: 0 })
  assert.equal(f.requests, 0)
  assert.equal(f.renders.length, 0)
  f.parallax.enter({ x: 1, y: -1 })
  assert.equal(f.callbacks.size, 1)
  f.step()
  assert.ok(f.renders[0].x > 0 && f.renders[0].x < 4)
  assert.ok(f.renders[0].y > 0 && f.renders[0].y < 6)
  f.step(104)
  assert.equal(f.callbacks.size, 0)
  assert.deepEqual(f.renders.at(-1), { x: 4, y: 6 })
  const settledRenders = f.renders.length
  f.parallax.setPointer({ x: 1, y: -1 })
  f.step(1000)
  assert.equal(f.renders.length, settledRenders)
  assert.equal(f.callbacks.size, 0)
  f.parallax.reset()
  f.step()
  assert.ok(f.renders.at(-1)!.x > 0 && f.renders.at(-1)!.x < 4)
  f.step(104)
  assert.equal(f.callbacks.size, 0)
  assert.deepEqual(f.renders.at(-1), { x: 0, y: 0 })
  f.parallax.dispose()
})

test('continuous movement reaches the latest pointer next frame with no tracking or idle tail', () => {
  const f = fixture()
  for (let index = 0; index < 60; index++) {
    const point = { x: Math.sin(index * 0.12), y: Math.cos(index * 0.12) }
    for (let event = 0; event < 3; event++) f.parallax.setPointer(point)
    assert.equal(f.callbacks.size, 1, 'multiple pointer events schedule competing frames')
    f.step()
    assert.deepEqual(f.renders.at(-1), { x: -point.y * 4 || 0, y: point.x * 6 || 0 })
    assert.equal(f.callbacks.size, 0, 'stationary input keeps reprojecting native materials')
  }
  const count = f.renders.length
  const requests = f.requests
  f.step(1000)
  assert.equal(f.renders.length, count)
  assert.equal(f.requests, requests)
  f.parallax.dispose()
})

test('entry follows new targets without jumping or extending its deadline; later movement is direct', () => {
  const f = fixture()
  f.parallax.enter({ x: 1, y: -1 })
  f.parallax.setPointer({ x: 1, y: -1 })
  f.step()
  assert.ok(f.renders[0].x > 0 && f.renders[0].x < 4)
  f.parallax.setPointer({ x: -0.5, y: 0.5 })
  f.step()
  assert.ok(f.renders.at(-1)!.x > -2 && f.renders.at(-1)!.x < 0)
  f.step(88)
  assert.deepEqual(f.renders.at(-1), { x: -2, y: -3 })
  assert.equal(f.callbacks.size, 0)
  f.parallax.setPointer({ x: 0.75, y: 0.5 })
  f.step()
  assert.deepEqual(f.renders.at(-1), { x: -2, y: 4.5 })
  assert.equal(f.callbacks.size, 0)
  f.parallax.reset()
  f.step(40)
  const returning = f.renders.at(-1)!
  assert.ok(returning.x > -2 && returning.x < 0)
  f.parallax.reset()
  f.step(80)
  assert.deepEqual(f.renders.at(-1), { x: 0, y: 0 })
  assert.equal(f.callbacks.size, 0, 'repeated leave restarts the return animation')
  f.parallax.dispose()
})

test('high-rate movement before the first entry frame retains one short envelope and latest target', () => {
  const f = fixture()
  f.parallax.enter({ x: 1, y: -1 })
  for (let index = 0; index < 100; index++)
    f.parallax.setPointer({ x: index === 99 ? -0.5 : 1, y: index === 99 ? 0.5 : -1 })
  assert.equal(f.requests, 1)
  f.step()
  assert.ok(f.renders[0].x > -2 && f.renders[0].x < 0)
  assert.ok(f.renders[0].y > -3 && f.renders[0].y < 0)
  f.step(104)
  assert.deepEqual(f.renders.at(-1), { x: -2, y: -3 })
  assert.equal(f.callbacks.size, 0)
  f.parallax.dispose()
})

test('100 pointer changes share one frame and follow the latest position inside the canvas', () => {
  const f = fixture()
  for (let index = 0; index < 100; index++)
    f.parallax.setPointer({ x: index === 99 ? -1 : 1, y: index === 99 ? 1 : -1 })
  assert.equal(f.requests, 1)
  assert.equal(f.renders.length, 0)
  f.settle()
  assert.deepEqual(f.renders.at(-1), { x: -4, y: -6 })
  f.parallax.setPointer({ x: Number.NaN, y: Number.POSITIVE_INFINITY })
  f.settle()
  assert.deepEqual(f.renders.at(-1), { x: 0, y: 0 })
  assert.ok(f.renders.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)))
  f.parallax.dispose()
})

test('every outside edge returns to neutral instead of keeping a clamped edge tilt', () => {
  const f = fixture()
  for (const point of [
    { x: -1.001, y: 0 },
    { x: 1.001, y: 0 },
    { x: 0, y: -1.001 },
    { x: 0, y: 1.001 },
    { x: Number.NaN, y: 1 },
    { x: 1, y: Number.POSITIVE_INFINITY }
  ]) {
    f.parallax.setPointer({ x: 0.75, y: -0.5 })
    f.step()
    assert.deepEqual(f.renders.at(-1), { x: 2, y: 4.5 })
    f.parallax.setPointer(point)
    f.step(40)
    assert.ok(f.renders.at(-1)!.x > 0 && f.renders.at(-1)!.x < 2)
    f.parallax.setPointer(point)
    f.step(80)
    assert.deepEqual(f.renders.at(-1), { x: 0, y: 0 })
    assert.equal(f.callbacks.size, 0, 'captured outside movement restarts the return deadline')
  }
  f.parallax.enter({ x: 2, y: -2 })
  assert.equal(f.callbacks.size, 0, 'entering with an outside coordinate retains an edge goal')
  f.parallax.dispose()
})

test('cancel or focus loss immediately clears current and pending tilt, including stale frames', () => {
  const f = fixture()
  f.parallax.setPointer({ x: 0.5, y: -0.75 })
  f.step()
  f.parallax.setPointer({ x: -0.5, y: 0.75 })
  const stale = [...f.callbacks.values()][0]
  f.parallax.reset(false)
  assert.equal(f.callbacks.size, 0)
  assert.deepEqual(f.renders.at(-1), { x: 0, y: 0 })
  const count = f.renders.length
  stale(100)
  f.parallax.reset(false)
  f.step(1000)
  assert.equal(f.renders.length, count, 'cancelled input reappears on a late frame')
  f.parallax.enter({ x: 1, y: -1 })
  const entry = [...f.callbacks.values()][0]
  f.parallax.reset(false)
  entry(1100)
  assert.equal(f.callbacks.size, 0)
  assert.equal(f.renders.length, count, 'cancelling before the first entry frame still renders')
  f.parallax.dispose()
})

test('rapid entry, leave and reentry keep one bounded return and never replay the prior edge', () => {
  const f = fixture()
  f.parallax.enter({ x: 1, y: -1 })
  f.step(30)
  f.parallax.reset()
  f.step(30)
  f.parallax.enter({ x: -1, y: 1 })
  f.step(30)
  f.parallax.setPointer({ x: -0.75, y: 0.5 })
  f.step(90)
  assert.deepEqual(f.renders.at(-1), { x: -2, y: -4.5 })
  assert.equal(f.callbacks.size, 0)
  f.parallax.reset()
  for (let index = 0; index < 8; index++) {
    f.parallax.reset()
    f.step(15)
  }
  assert.deepEqual(f.renders.at(-1), { x: 0, y: 0 })
  assert.equal(f.callbacks.size, 0)
  const count = f.renders.length
  f.step(1000)
  assert.equal(f.renders.length, count)
  f.parallax.dispose()
})

test('suspension cancels even handle zero, neutralizes immediately and drops hidden input', () => {
  const f = fixture(0)
  f.parallax.setPointer({ x: 1, y: 1 })
  const staleCallback = [...f.callbacks.values()][0]
  f.parallax.setActive(false)
  assert.equal(f.cancellations, 1)
  assert.equal(f.callbacks.size, 0)
  staleCallback(16)
  assert.equal(f.renders.length, 0)
  for (let index = 0; index < 100; index++) f.parallax.setPointer({ x: -1, y: 1 })
  f.parallax.reset()
  f.step(500)
  assert.equal(f.requests, 1)
  f.parallax.setActive(true)
  f.step()
  assert.equal(f.renders.length, 0, 'resume replays hidden pointer positions')
  f.parallax.setPointer({ x: 1, y: -1 })
  f.step()
  assert.ok(f.renders.length > 0)
  f.parallax.setActive(false)
  assert.deepEqual(f.renders.at(-1), { x: 0, y: 0 })
  const count = f.renders.length
  f.step(500)
  assert.equal(f.renders.length, count)
  f.parallax.dispose()
})

test('disposal and a render callback that deactivates cannot restart background frames', () => {
  const f = fixture()
  f.parallax.setPointer({ x: 1, y: -1 })
  f.step()
  f.parallax.dispose()
  const count = f.renders.length
  f.parallax.setActive(true)
  f.parallax.setPointer({ x: -1, y: 1 })
  f.parallax.reset()
  f.step(500)
  assert.equal(f.callbacks.size, 0)
  assert.equal(f.renders.length, count)

  let callback: ((time: number) => void) | undefined
  const parallax = createEditorParallax({
    clock: {
      now: () => 0,
      request: (next) => {
        callback = next
        return 1
      },
      cancel: () => {
        callback = undefined
      }
    },
    render: () => parallax.setActive(false)
  })
  parallax.setPointer({ x: 1, y: -1 })
  const tick = callback!
  callback = undefined
  tick(16)
  assert.equal(callback, undefined)
  parallax.dispose()
})
