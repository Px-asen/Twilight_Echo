import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditorViewport, type EditorFrameClock } from './createEditorViewport.ts'
import {
  availableEditorRect,
  editorContextRects,
  projectEditorRect,
  type EditorCamera,
  type EditorNode,
  type EditorRect
} from './viewportGeometry.ts'

const nodes: EditorNode[] = [
  { id: 'title', rect: { left: 0, top: 0, width: 1370, height: 40 } },
  { id: 'sidebar', rect: { left: 8, top: 40, width: 240, height: 740 } },
  { id: 'player', rect: { left: 70, top: 784, width: 1230, height: 72 } },
  { id: 'card', rect: { left: 300, top: 290, width: 940, height: 340 } }
]
test('the initial camera renders only after both scene and viewport are ready', () => {
  const frames: EditorCamera[] = []
  const engine = createEditorViewport({
    clock: { now: () => 0, request: () => 1, cancel: () => {} },
    render: (camera) => frames.push(camera)
  })
  engine.resize({ width: 1000, height: 600 })
  assert.equal(frames.length, 0)
  engine.setScene({ width: 1370, height: 880 }, nodes)
  assert.equal(frames.length, 1)
  engine.resize({ width: Number.NaN, height: 600 })
  assert.equal(frames.length, 1)
  engine.dispose()
})
function fixture() {
  let time = 0,
    id = 0
  const callbacks = new Map<number, (time: number) => void>()
  const renders: EditorCamera[] = []
  const motions: boolean[] = []
  const clock: EditorFrameClock = {
    now: () => time,
    request: (callback) => {
      callbacks.set(++id, callback)
      return id
    },
    cancel: (handle) => {
      callbacks.delete(handle)
    }
  }
  const engine = createEditorViewport({
    clock,
    render: (value) => renders.push(value),
    motion: (running) => motions.push(running)
  })
  engine.setAnimated(false)
  engine.resize({ width: 1100, height: 640 })
  engine.setScene({ width: 1370, height: 880 }, nodes)
  return {
    engine,
    renders,
    motions,
    callbacks,
    step(delta: number) {
      time += delta
      const pending = [...callbacks.values()]
      callbacks.clear()
      pending.forEach((callback) => callback(time))
    }
  }
}
function contains(space: EditorRect, rect: EditorRect) {
  assert.ok(
    rect.left >= space.left - 0.001 && rect.top >= space.top - 0.001,
    'part starts outside available viewport'
  )
  assert.ok(
    rect.left + rect.width <= space.left + space.width + 0.001 &&
      rect.top + rect.height <= space.top + space.height + 0.001,
    'part ends outside available viewport'
  )
}
test('default fit contains every complete part across window sizes and floating panels', () => {
  const { engine } = fixture()
  for (const size of [
    { width: 1370, height: 650 },
    { width: 1000, height: 520 },
    { width: 660, height: 380 }
  ]) {
    for (const panel of [
      [],
      [{ left: size.width - 252, top: 60, width: 240, height: 300 }],
      [{ left: size.width - 252, top: 60, width: 240, height: 44 }]
    ]) {
      engine.resize(size, panel)
      for (const node of nodes) {
        engine.focus(node.id)
        contains(
          availableEditorRect(size, panel),
          projectEditorRect(node.rect, engine.snapshot().camera)
        )
      }
    }
  }
  engine.dispose()
})
test('new registered node IDs share fitting and zooming without core changes', () => {
  const { engine } = fixture()
  const future = {
    id: 'future-plugin-widget',
    rect: { left: 900, top: 200, width: 280, height: 460 }
  }
  engine.setScene({ width: 1370, height: 880 }, [...nodes, future])
  engine.focus(future.id)
  contains(
    availableEditorRect({ width: 1100, height: 640 }),
    projectEditorRect(future.rect, engine.snapshot().camera)
  )
  const baseline = engine.snapshot().camera.scale
  engine.zoomBy(1.25)
  assert.ok(engine.snapshot().camera.scale > baseline)
  engine.fit()
  assert.equal(engine.snapshot().camera.scale, baseline)
})
test('context fading covers only the surrounding scene and keeps complete modules clear', () => {
  const scene = { width: 1370, height: 880 }
  for (const node of nodes) {
    const panels = editorContextRects(scene, node.rect)
    assert.equal(panels.length, 4)
    panels.forEach((panel) => {
      assert.ok(panel.width >= 0 && panel.height >= 0)
      contains({ left: 0, top: 0, ...scene }, panel)
      const overlapWidth = Math.max(
        0,
        Math.min(panel.left + panel.width, node.rect.left + node.rect.width) -
          Math.max(panel.left, node.rect.left)
      )
      const overlapHeight = Math.max(
        0,
        Math.min(panel.top + panel.height, node.rect.top + node.rect.height) -
          Math.max(panel.top, node.rect.top)
      )
      assert.equal(overlapWidth * overlapHeight, 0, 'context covers selected module')
    })
    const clearWidth =
      Math.min(scene.width, node.rect.left + node.rect.width + 10) -
      Math.max(0, node.rect.left - 10)
    const clearHeight =
      Math.min(scene.height, node.rect.top + node.rect.height + 10) -
      Math.max(0, node.rect.top - 10)
    assert.equal(
      panels.reduce((area, panel) => area + panel.width * panel.height, 0),
      scene.width * scene.height - clearWidth * clearHeight
    )
  }
})
test('equivalent scene and state updates do not render again or interrupt an animation', () => {
  const { engine, renders, callbacks, step } = fixture()
  const before = renders.length
  for (let i = 0; i < 100; i++) {
    engine.setScene(
      { width: 1370, height: 880 },
      nodes.map((node) => ({ ...node }))
    )
    engine.resize({ width: 1100, height: 640 })
    engine.setAnimated(false)
    engine.setActive(true)
  }
  assert.equal(renders.length, before)
  assert.equal(callbacks.size, 0)
  engine.setAnimated(true)
  engine.focus('card')
  step(80)
  const midway = engine.snapshot().camera
  for (let i = 0; i < 100; i++) {
    engine.setScene({ width: 1370, height: 880 }, nodes)
    engine.resize({ width: 1100, height: 640 })
    engine.setAnimated(true)
    engine.setActive(true)
  }
  assert.deepEqual(engine.snapshot().camera, midway)
  assert.equal(callbacks.size, 1)
  step(260)
  assert.deepEqual(engine.snapshot().camera, engine.snapshot().goal)
  assert.equal(callbacks.size, 0)
  engine.dispose()
})
test('interrupted camera animation continues from the visible frame with one scheduled callback', () => {
  const { engine, step, callbacks } = fixture()
  engine.setAnimated(true)
  const initial = engine.snapshot().camera
  engine.focus('title')
  assert.deepEqual(engine.snapshot().camera, initial)
  step(100)
  const midway = engine.snapshot().camera
  assert.notDeepEqual(midway, initial)
  assert.notDeepEqual(midway, engine.snapshot().goal)
  engine.focus('player')
  assert.deepEqual(engine.snapshot().camera, midway)
  assert.equal(callbacks.size, 1)
  step(340)
  assert.deepEqual(engine.snapshot().camera, engine.snapshot().goal)
  assert.equal(callbacks.size, 0)
})
test('reduced motion stops animation and reaches the target immediately', () => {
  const { engine, step, callbacks } = fixture()
  engine.setAnimated(true)
  engine.focus('card')
  step(90)
  engine.setAnimated(false)
  assert.equal(callbacks.size, 0)
  assert.deepEqual(engine.snapshot().camera, engine.snapshot().goal)
})
test('zoom keeps the pointer anchor stationary and pan keeps the object reachable', () => {
  const { engine } = fixture()
  engine.focus('card')
  const before = engine.snapshot().camera,
    anchor = { x: 400, y: 300 }
  const source = {
    x: (anchor.x - before.x) / before.scale,
    y: (anchor.y - before.y) / before.scale
  }
  engine.zoomBy(1.25, anchor)
  const after = engine.snapshot().camera
  assert.ok(Math.abs(source.x * after.scale + after.x - anchor.x) < 0.001)
  assert.ok(Math.abs(source.y * after.scale + after.y - anchor.y) < 0.001)
  engine.panBy({ x: 100000, y: -100000 })
  const projected = projectEditorRect(nodes[3].rect, engine.snapshot().camera)
  assert.ok(projected.left < 1100 && projected.top + projected.height > 0)
  engine.fit()
  contains(
    availableEditorRect({ width: 1100, height: 640 }),
    projectEditorRect(nodes[3].rect, engine.snapshot().camera)
  )
})
test('dragging during an animation starts from the displayed camera rather than jumping to its goal', () => {
  const { engine, step } = fixture()
  engine.setAnimated(true)
  engine.focus('title')
  step(80)
  const before = engine.snapshot().camera
  engine.panBy({ x: 8, y: 5 })
  assert.ok(Math.abs(engine.snapshot().camera.x - before.x - 8) < 0.001)
  assert.ok(Math.abs(engine.snapshot().camera.y - before.y - 5) < 0.001)
  assert.equal(engine.snapshot().camera.scale, before.scale)
})
test('hidden and disposed editors schedule no frames and resume at their latest target', () => {
  const { engine, callbacks, renders } = fixture()
  engine.setAnimated(true)
  engine.focus('title')
  engine.setActive(false)
  const count = renders.length
  engine.focus('player')
  assert.equal(callbacks.size, 0)
  assert.equal(renders.length, count)
  engine.setActive(true)
  assert.deepEqual(engine.snapshot().camera, engine.snapshot().goal)
  engine.dispose()
  engine.focus('card')
  assert.equal(callbacks.size, 0)
})

test('motion ownership starts with animated work and ends at the final camera frame', () => {
  const { engine, callbacks, motions, renders, step } = fixture()
  assert.deepEqual(motions, [], 'initial fit must not claim an animation layer')
  engine.setAnimated(true)
  engine.focus('card')
  assert.deepEqual(motions, [true])
  step(80)
  engine.setScene({ width: 1370, height: 880 }, nodes)
  engine.resize({ width: 1100, height: 640 })
  engine.focus('card')
  assert.deepEqual(motions, [true], 'equivalent state must retain the same finite animation')
  assert.equal(callbacks.size, 1)
  step(260)
  assert.deepEqual(motions, [true, false])
  assert.deepEqual(engine.snapshot().camera, engine.snapshot().goal)
  assert.equal(callbacks.size, 0)
  const settledRenders = renders.length
  step(1000)
  assert.equal(renders.length, settledRenders, 'settled cameras must not keep a render loop')
  engine.dispose()
  assert.deepEqual(motions, [true, false], 'disposing idle work must not emit duplicate releases')
})

test('interruption, hidden state and reduced motion release their animation ownership', () => {
  const { engine, callbacks, motions, renders, step } = fixture()
  engine.setAnimated(true)
  engine.focus('title')
  step(80)
  const visible = engine.snapshot().camera
  engine.focus('player')
  assert.deepEqual(engine.snapshot().camera, visible)
  assert.deepEqual(motions, [true, false, true], 'retargeting must cancel the old animation')
  assert.equal(callbacks.size, 1)
  engine.setActive(false)
  assert.deepEqual(motions, [true, false, true, false])
  const suspendedRenders = renders.length
  engine.focus('card')
  step(1000)
  assert.equal(callbacks.size, 0)
  assert.equal(renders.length, suspendedRenders)
  engine.setActive(true)
  assert.deepEqual(engine.snapshot().camera, engine.snapshot().goal)
  assert.deepEqual(
    motions,
    [true, false, true, false],
    'resume must publish the latest target directly'
  )
  engine.focus('sidebar')
  step(80)
  engine.setAnimated(false)
  assert.deepEqual(motions.slice(-2), [true, false])
  assert.equal(callbacks.size, 0)
  assert.deepEqual(engine.snapshot().camera, engine.snapshot().goal)
  engine.dispose()
})

test('disposing active animation releases ownership and all queued work exactly once', () => {
  const { engine, callbacks, motions, renders, step } = fixture()
  engine.setAnimated(true)
  engine.focus('card')
  step(60)
  const count = renders.length
  engine.dispose()
  assert.deepEqual(motions, [true, false])
  assert.equal(callbacks.size, 0)
  engine.dispose()
  engine.setActive(true)
  engine.setAnimated(true)
  engine.focus('player')
  engine.zoomBy(1.25)
  step(1000)
  assert.equal(renders.length, count)
  assert.equal(callbacks.size, 0)
  assert.deepEqual(motions, [true, false])
})
