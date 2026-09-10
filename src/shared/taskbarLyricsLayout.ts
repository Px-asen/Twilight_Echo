interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}

export function taskbarLyricsBounds(
  bounds: Rectangle,
  workArea: Rectangle,
  width: number,
  offset: number
): Rectangle {
  const bottom = bounds.y + bounds.height - workArea.y - workArea.height
  const top = workArea.y - bounds.y
  const height = Math.min(48, Math.max(28, bottom > 0 ? bottom : top > 0 ? top : 40))
  const safeWidth = Math.min(Math.max(160, width), bounds.width)
  return {
    x: Math.round(
      bounds.x + ((bounds.width - safeWidth) * Math.max(0, Math.min(100, offset))) / 100
    ),
    y: Math.round(
      bottom > 0
        ? bounds.y + bounds.height - height
        : top > 0
          ? bounds.y
          : bounds.y + bounds.height - height
    ),
    width: Math.round(safeWidth),
    height: Math.round(height)
  }
}
