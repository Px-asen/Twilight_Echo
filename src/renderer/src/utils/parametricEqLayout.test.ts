import assert from 'node:assert/strict'
import test from 'node:test'
import { placeEqInspector, placeEqTooltip } from './parametricEqLayout.ts'

test('inspector stays at the bottom unless it would cover the selected node', () => {
  const plot = { width: 1000, height: 600 }
  const panel = { width: 460, height: 146 }
  assert.deepEqual(placeEqInspector(plot, { x: 500, y: 200 }, panel), { left: 270, top: 442 })
  assert.deepEqual(placeEqInspector(plot, { x: 500, y: 450 }, panel), { left: 270, top: 12 })
  assert.deepEqual(placeEqInspector(plot, { x: 50, y: 500 }, panel), { left: 270, top: 442 })
})

test('tooltips remain inside the plot at all frequency and gain extremes', () => {
  for (const width of [300, 660, 1300]) {
    const plot = { width, height: 360 }
    for (const x of [0, width / 2, width]) {
      for (const y of [0, 180, 360]) {
        const tooltip = placeEqTooltip(plot, { x, y })
        assert.ok(tooltip.left >= 0)
        assert.ok(tooltip.left + tooltip.width <= width)
        assert.ok(tooltip.top >= 0 && tooltip.top + 64 <= plot.height)
      }
    }
  }
})
