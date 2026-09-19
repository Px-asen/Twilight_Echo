export interface EqPlotBounds {
  width: number
  height: number
}

function bound(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)))
}

export function placeEqInspector(
  plot: EqPlotBounds,
  node: { x: number; y: number },
  panel: EqPlotBounds
): { left: number; top: number } {
  const left = bound((plot.width - panel.width) / 2, 8, plot.width - panel.width - 8)
  const bottom = Math.max(8, plot.height - panel.height - 12)
  const overlap = node.x >= left - 24 && node.x <= left + panel.width + 24 && node.y >= bottom - 30
  return { left, top: overlap ? 12 : bottom }
}

export function placeEqTooltip(
  plot: EqPlotBounds,
  node: { x: number; y: number }
): { left: number; top: number; width: number } {
  const width = Math.min(222, Math.max(0, plot.width - 12))
  return {
    left: bound(node.x - width / 2, 6, plot.width - width - 6),
    top: bound(node.y >= 82 ? node.y - 78 : node.y + 24, 6, plot.height - 64),
    width
  }
}
