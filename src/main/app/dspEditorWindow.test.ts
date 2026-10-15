import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dspEditorWindowOptions,
  isDspEditorWindowRequest,
  registerDspEditorWindow,
  dspEditorInteractionWindow
} from './dspEditorWindow.ts'
import type { BrowserWindow } from 'electron'

test('only the named DSP view can open a native app window', () => {
  assert.equal(isDspEditorWindowRequest('about:blank', 'twilight-dsp-editor'), true)
  for (const [url, name] of [
    ['about:blank', '_blank'],
    ['https://example.com', 'twilight-dsp-editor'],
    ['file:///C:/private.html', 'twilight-dsp-editor'],
    ['about:blank#dsp', 'twilight-dsp-editor']
  ])
    assert.equal(isDspEditorWindowRequest(url, name), false)
})

test('DSP window fits the originating display even on a small or negative-coordinate screen', () => {
  for (const area of [
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: -1024, y: 0, width: 1024, height: 640 },
    { x: 200, y: -600, width: 560, height: 420 }
  ]) {
    const options = dspEditorWindowOptions(area)
    assert.ok(options.x! >= area.x && options.y! >= area.y)
    assert.ok(options.x! + options.width! <= area.x + area.width)
    assert.ok(options.y! + options.height! <= area.y + area.height)
    assert.ok(options.minWidth! <= options.width! && options.minHeight! <= options.height!)
    assert.equal(options.frame, true)
    assert.equal(options.alwaysOnTop, false)
    assert.equal(options.modal, false)
  }
})

test('native menus belong to the focused DSP editor only when it belongs to that opener', () => {
  const owner = {} as BrowserWindow
  const otherOwner = {} as BrowserWindow
  let close = () => {}
  let destroyed = false
  const child = {
    once: (_event: string, callback: () => void) => {
      close = callback
    },
    isDestroyed: () => destroyed
  } as unknown as BrowserWindow
  registerDspEditorWindow(owner, child)
  assert.equal(dspEditorInteractionWindow(owner, child), child)
  assert.equal(dspEditorInteractionWindow(otherOwner, child), otherOwner)
  assert.equal(dspEditorInteractionWindow(owner, null), owner)
  destroyed = true
  assert.equal(dspEditorInteractionWindow(owner, child), owner)
  destroyed = false
  close()
  assert.equal(dspEditorInteractionWindow(owner, child), owner)
})
