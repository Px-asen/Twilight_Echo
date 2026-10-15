export interface SongListVirtualWindowInput {
  trackCount: number
  scrollTop: number
  viewportHeight: number
  tableOffsetTop: number
  rowHeight: number
  overscanRows?: number
}

export interface SongListGridVirtualWindowInput {
  itemCount: number
  scrollTop: number
  viewportHeight: number
  gridOffsetTop: number
  columns: number
  rowStride: number
  overscanRows?: number
}

export interface SongListGridVirtualRange {
  start: number
  end: number
  startRow: number
  endRow: number
  columns: number
  rowStride: number
}

export interface GridLayoutMetrics {
  minColumnWidth: number
  maxColumnWidth: number
  columnGap: number
  rowGap: number
  padX: number
  padY: number
  coverGap: number
}

export const GRID_OVERSCAN_ROWS = 2
export const GRID_AZ_SCAN_OFFSET = 104
export const GRID_AZ_SCROLL_PADDING = 92

export function getSongListVirtualRange({
  trackCount,
  scrollTop,
  viewportHeight,
  tableOffsetTop,
  rowHeight,
  overscanRows = 6
}: SongListVirtualWindowInput): { start: number; end: number } {
  const virtualScrollTop = Math.max(0, scrollTop - tableOffsetTop)
  const count = Math.ceil(viewportHeight / rowHeight) + overscanRows * 2
  const start = Math.min(
    Math.max(0, trackCount - count),
    Math.max(0, Math.floor(virtualScrollTop / rowHeight) - overscanRows)
  )
  return {
    start: Math.max(0, start),
    end: Math.min(trackCount, start + count)
  }
}

export function resolveGridLayoutMetrics(
  containerWidth: number,
  compact = false
): GridLayoutMetrics {
  if (compact) {
    return {
      minColumnWidth: 140,
      maxColumnWidth: 190,
      columnGap: 10,
      rowGap: 10,
      padX: 0,
      padY: 0,
      coverGap: 8
    }
  }
  if (containerWidth <= 640) {
    return {
      minColumnWidth: 128,
      maxColumnWidth: 200,
      columnGap: 10,
      rowGap: 12,
      padX: 0,
      padY: 0,
      coverGap: 13
    }
  }
  if (containerWidth <= 900) {
    return {
      minColumnWidth: 160,
      maxColumnWidth: 220,
      columnGap: 14,
      rowGap: 16,
      padX: 0,
      padY: 0,
      coverGap: 13
    }
  }
  return {
    minColumnWidth: 200,
    maxColumnWidth: 240,
    columnGap: 24,
    rowGap: 28,
    padX: 0,
    padY: 0,
    coverGap: 13
  }
}

export function estimateGridColumns(
  containerWidth: number,
  metrics = resolveGridLayoutMetrics(containerWidth),
  itemCount = Number.POSITIVE_INFINITY
): number {
  // Use every readable column that fits, but do not reserve empty tracks when
  // a small collection can share more width. CSS caps tracks at the same max.
  const { minColumnWidth, columnGap } = metrics
  const width = Math.max(0, containerWidth)
  const capacity = Math.max(1, Math.floor((width + columnGap) / (minColumnWidth + columnGap)))
  return Math.max(1, Math.min(capacity, Math.floor(itemCount)))
}

export function estimateGridColumnWidth(
  containerWidth: number,
  columns: number,
  metrics = resolveGridLayoutMetrics(containerWidth)
): number {
  const safeColumns = Math.max(1, Math.floor(columns))
  const available = Math.max(0, containerWidth - (safeColumns - 1) * metrics.columnGap)
  return Math.max(1, Math.min(metrics.maxColumnWidth, available / safeColumns))
}

export function estimateGridRowStride(
  columnWidth: number,
  metrics: GridLayoutMetrics,
  baseFontSize = 14
): number {
  const { rowGap, padX, padY, coverGap } = metrics
  const cover = Math.max(1, columnWidth - padX)
  const textBlock = baseFontSize * ((15 / 14) * 1.35 + (13 / 14) * 1.5) + 3
  return Math.max(1, Math.ceil(cover + padY + coverGap + textBlock + rowGap))
}

export function estimateAlbumGridRowStride(
  columnWidth: number,
  metrics: GridLayoutMetrics,
  baseFontSize = 14
): number {
  // Artwork is edge-to-edge; two title lines and two metadata lines keep cards uniform.
  const textHeight = baseFontSize * ((15 / 14) * 2.8 + (13 / 14) * 3)
  return Math.max(1, Math.ceil(columnWidth + textHeight + 22 + metrics.rowGap))
}

export function getSongListGridVirtualRange({
  itemCount,
  scrollTop,
  viewportHeight,
  gridOffsetTop,
  columns,
  rowStride,
  overscanRows = GRID_OVERSCAN_ROWS
}: SongListGridVirtualWindowInput): SongListGridVirtualRange {
  const safeCount = Math.max(0, Math.floor(itemCount))
  const safeColumns = Math.max(1, Math.floor(columns))
  const safeStride = Math.max(1, rowStride)
  const totalRows = Math.ceil(safeCount / safeColumns)
  const virtualScrollTop = Math.max(0, scrollTop - gridOffsetTop)
  const visibleRows = Math.ceil(Math.max(0, viewportHeight) / safeStride) + overscanRows * 2
  const startRow = Math.min(
    Math.max(0, totalRows - visibleRows),
    Math.max(0, Math.floor(virtualScrollTop / safeStride) - overscanRows)
  )
  const endRow = Math.min(totalRows, startRow + visibleRows)
  return {
    start: Math.min(safeCount, startRow * safeColumns),
    end: Math.min(safeCount, endRow * safeColumns),
    startRow,
    endRow,
    columns: safeColumns,
    rowStride: safeStride
  }
}

export function getSongListGridScrollTopForIndex(
  index: number,
  itemCount: number,
  columns: number,
  rowStride: number,
  gridOffsetTop: number,
  headerPadding = GRID_AZ_SCROLL_PADDING
): number {
  const safeCount = Math.max(0, Math.floor(itemCount))
  if (safeCount === 0) return 0
  const safeColumns = Math.max(1, Math.floor(columns))
  const safeStride = Math.max(1, rowStride)
  const safeIndex = Math.min(safeCount - 1, Math.max(0, Math.floor(index)))
  const row = Math.floor(safeIndex / safeColumns)
  return Math.max(0, gridOffsetTop + row * safeStride - headerPadding)
}

export function maxMountedGridCards(
  viewportHeight: number,
  rowStride: number,
  columns: number,
  overscanRows = GRID_OVERSCAN_ROWS
): number {
  const safeColumns = Math.max(1, Math.floor(columns))
  const visibleRows = Math.ceil(Math.max(0, viewportHeight) / Math.max(1, rowStride))
  return (visibleRows + overscanRows * 2) * safeColumns
}
