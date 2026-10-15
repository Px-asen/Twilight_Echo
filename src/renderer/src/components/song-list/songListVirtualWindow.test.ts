import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  estimateAlbumGridRowStride,
  estimateGridColumnWidth,
  estimateGridColumns,
  estimateGridRowStride,
  getSongListVirtualRange,
  getSongListGridScrollTopForIndex,
  getSongListGridVirtualRange,
  GRID_OVERSCAN_ROWS,
  maxMountedGridCards,
  resolveGridLayoutMetrics
} from './songListVirtualWindow.ts'

test('grid virtual window mounts only viewport + overscan cards', () => {
  const itemCount = 4_000
  const columns = 5
  const rowStride = 260
  const viewportHeight = 720
  const overscanRows = GRID_OVERSCAN_ROWS
  const cap = maxMountedGridCards(viewportHeight, rowStride, columns, overscanRows)

  for (const scrollTop of [0, 2_400, 18_000, 80_000, 200_000]) {
    const range = getSongListGridVirtualRange({
      itemCount,
      scrollTop,
      viewportHeight,
      gridOffsetTop: 180,
      columns,
      rowStride,
      overscanRows
    })
    const mounted = range.end - range.start
    assert.ok(mounted <= cap, `mounted ${mounted} exceeds cap ${cap} at scroll ${scrollTop}`)
    assert.ok(mounted > 0)
    assert.equal(range.start % columns, 0)
  }
})

test('table window keeps rows above the viewport and clamps stale offsets after filtering', () => {
  const input = {
    trackCount: 4000,
    scrollTop: 5000,
    viewportHeight: 700,
    tableOffsetTop: 300,
    rowHeight: 68
  }
  const range = getSongListVirtualRange(input)
  const firstVisible = Math.floor((input.scrollTop - input.tableOffsetTop) / input.rowHeight)
  assert.equal(range.start, firstVisible - 6)
  assert.ok(range.end > firstVisible + Math.ceil(input.viewportHeight / input.rowHeight))
  assert.deepEqual(getSongListVirtualRange({ ...input, trackCount: 3 }), { start: 0, end: 3 })
  assert.deepEqual(getSongListVirtualRange({ ...input, trackCount: 0 }), { start: 0, end: 0 })
})

test('A-Z jump scroll top lands the target index inside the window', () => {
  const itemCount = 800
  const columns = 4
  const rowStride = 240
  const gridOffsetTop = 160
  const viewportHeight = 640
  const index = firstIndexForLetter('M')

  const scrollTop = getSongListGridScrollTopForIndex(
    index,
    itemCount,
    columns,
    rowStride,
    gridOffsetTop
  )
  const range = getSongListGridVirtualRange({
    itemCount,
    scrollTop,
    viewportHeight,
    gridOffsetTop,
    columns,
    rowStride
  })
  assert.ok(index >= range.start && index < range.end)
})

test('fluid grid adds columns from the minimum readable cover width', () => {
  assert.equal(estimateGridColumns(1_000), 4)
  assert.equal(estimateGridColumns(740), 4)
  assert.equal(estimateGridColumns(400), 2)
  assert.equal(estimateGridColumns(404), 3)
  assert.equal(estimateGridColumns(80), 1)
  assert.equal(resolveGridLayoutMetrics(640).maxColumnWidth, 200)
  assert.equal(resolveGridLayoutMetrics(641).maxColumnWidth, 220)
  assert.equal(resolveGridLayoutMetrics(901).maxColumnWidth, 240)
  assert.equal(estimateGridColumnWidth(1_000, 4), 232)
})

test('few collections retain capped covers while narrow tracks still fit the container', () => {
  assert.equal(estimateGridColumnWidth(1_000, 1), 240)
  assert.equal(estimateGridColumnWidth(1_000, 2), 240)
  assert.equal(estimateGridColumnWidth(400, 2), 195)
  assert.equal(estimateGridColumnWidth(80, 1), 80)
  assert.equal(estimateGridColumnWidth(340, 2), 165)
  for (const compact of [false, true]) {
    const metrics = resolveGridLayoutMetrics(10_000, compact)
    const columns = estimateGridColumns(10_000, metrics)
    assert.ok(columns > 40)
    assert.ok(estimateGridColumnWidth(10_000, columns, metrics) <= metrics.maxColumnWidth)
    assert.ok(estimateGridColumnWidth(10_000, 1, metrics) <= metrics.maxColumnWidth)
  }
})

test('small complete rows use more width without large covers or empty track gaps', () => {
  const width = 1_428
  const metrics = resolveGridLayoutMetrics(width)
  for (const itemCount of [0, 1, 2, 5, 6, 7, 6_000]) {
    const columns = estimateGridColumns(width, metrics, itemCount)
    const cardWidth = estimateGridColumnWidth(width, columns, metrics)
    assert.equal(columns, Math.max(1, Math.min(6, itemCount)))
    assert.ok(cardWidth <= 240)
    const occupied = columns * cardWidth + (columns - 1) * metrics.columnGap
    if (itemCount >= 6) assert.ok(occupied / width > 0.99)
    if (itemCount <= 2) assert.equal(cardWidth, 240)
  }
  assert.equal(
    estimateGridColumns(width, metrics, 5),
    5,
    'playlist creation does not reserve an artwork slot'
  )
})

test('compact density has the same track cap and gaps at every container width', () => {
  const compact = resolveGridLayoutMetrics(1_000, true)
  assert.deepEqual(resolveGridLayoutMetrics(400, true), compact)
  assert.equal(estimateGridColumns(1_000, compact), 6)
  assert.equal(estimateGridColumnWidth(1_000, 1, compact), 190)
  assert.ok(
    estimateGridRowStride(180, compact) <
      estimateGridRowStride(180, resolveGridLayoutMetrics(1_000))
  )
})

test('full rows fill every feasible width while respecting cover bounds', () => {
  for (const compact of [false, true]) {
    for (let width = 80; width <= 3_200; width += 0.5) {
      const metrics = resolveGridLayoutMetrics(width, compact)
      const columns = estimateGridColumns(width, metrics)
      const cardWidth = estimateGridColumnWidth(width, columns, metrics)
      const minimum = Math.min(width, metrics.minColumnWidth)
      assert.ok(cardWidth >= minimum - 1e-9, `undersized cover at ${width}, compact=${compact}`)
      assert.ok(cardWidth <= metrics.maxColumnWidth, `oversized cover at ${width}`)
      assert.ok(
        (columns + 1) * minimum + columns * metrics.columnGap > width,
        `an extra readable column should not fit at ${width}`
      )

      const occupied = columns * cardWidth + (columns - 1) * metrics.columnGap
      const feasible = Array.from({ length: columns }, (_, index) => index + 1).some(
        (count) =>
          count * minimum + (count - 1) * metrics.columnGap <= width &&
          count * metrics.maxColumnWidth + (count - 1) * metrics.columnGap >= width
      )
      assert.ok(occupied <= width + 1e-9, `row overflows at ${width}`)
      if (feasible) {
        assert.ok(Math.abs(occupied / width - 1) < 1e-9, `unused row space at ${width}`)
      } else {
        assert.equal(cardWidth, metrics.maxColumnWidth, 'only the artwork cap may leave space')
      }
    }
  }
})

test('CSS and initial estimates share flexible tracks, ranges, gaps and flat-card geometry', () => {
  const css = readFileSync(new URL('./SongList.css', import.meta.url), 'utf8')
  const base = css.match(/^\.card-grid \{([^}]+)\}/m)?.[1] ?? ''
  const medium =
    css.match(/@container te-song-list \(max-width: 900px\) \{\s*\.card-grid \{([^}]+)\}/)?.[1] ??
    ''
  const narrow =
    css.match(/@container te-song-list \(max-width: 640px\) \{\s*\.card-grid \{([^}]+)\}/)?.[1] ??
    ''
  const compact =
    css.match(
      /:global\(html\[data-te-library-density='compact'\] \.card-grid\) \{([^}]+)\}/
    )?.[1] ?? ''
  assert.match(
    base,
    /repeat\(\s*var\(--te-grid-columns, auto-fill\),\s*minmax\(min\(100%,\s*var\(--te-grid-card-min\)\),\s*var\(--te-grid-card-max\)\)\s*\)/
  )
  assert.match(
    css,
    /\.artist-card,\s*\.album-card,\s*\.playlist-card \{[^}]*width: 100%;[^}]*max-width: var\(--te-grid-card-max\);/
  )
  for (const [width, density, rule] of [
    [1_000, false, base],
    [900, false, medium],
    [641, false, medium],
    [640, false, narrow],
    [400, true, compact],
    [1_000, true, compact]
  ] as const) {
    const metrics = resolveGridLayoutMetrics(width, density)
    for (const [property, expected] of [
      ['min', metrics.minColumnWidth],
      ['max', metrics.maxColumnWidth],
      ['pad-x', metrics.padX],
      ['pad-y', metrics.padY]
    ] as const) {
      const value = Number(rule.match(new RegExp(`--te-grid-card-${property}: (\\d+)px`))?.[1])
      assert.equal(value, expected, `CSS ${property} at ${width}, compact=${density}`)
    }
    const gap = rule.match(/gap: (\d+)px(?: (\d+)px)?;/)
    assert.equal(Number(gap?.[1]), metrics.rowGap)
    assert.equal(Number(gap?.[2] ?? gap?.[1]), metrics.columnGap)
  }
})

test('card stride estimates grow with the shared font scale without changing cover size', () => {
  const metrics = resolveGridLayoutMetrics(1_000)
  assert.equal(estimateAlbumGridRowStride(200, metrics, 14), 331)
  assert.ok(estimateAlbumGridRowStride(200, metrics, 21) > 331)
  assert.ok(estimateGridRowStride(200, metrics, 21) > estimateGridRowStride(200, metrics, 14))
})

test('filtering at an old scroll offset cannot leave a large empty grid spacer', () => {
  const input = {
    scrollTop: 80_000,
    viewportHeight: 720,
    gridOffsetTop: 180,
    columns: 4,
    rowStride: 325
  }
  const shrunk = getSongListGridVirtualRange({ ...input, itemCount: 3 })
  assert.equal(shrunk.startRow, 0)
  assert.deepEqual([shrunk.start, shrunk.end], [0, 3])
  const empty = getSongListGridVirtualRange({ ...input, itemCount: 0 })
  assert.equal(empty.startRow, 0)
  assert.deepEqual([empty.start, empty.end], [0, 0])
  const last = getSongListGridVirtualRange({ ...input, itemCount: 80 })
  assert.equal(last.end, 80)
  assert.ok(last.start < last.end)
})

test('six thousand collections keep last-item and indexed return targets mounted after reflow', () => {
  const itemCount = 6_000
  const viewportHeight = 640
  const gridOffsetTop = 180
  for (const compact of [false, true]) {
    for (const width of [280, 400, 640, 641, 900, 1_000, 1_428, 2_400]) {
      const metrics = resolveGridLayoutMetrics(width, compact)
      const columns = estimateGridColumns(width, metrics, itemCount)
      const cardWidth = estimateGridColumnWidth(width, columns, metrics)
      for (const fontSize of [14, 20, 28]) {
        const rowStride = estimateAlbumGridRowStride(cardWidth, metrics, fontSize)
        for (const index of [0, 127, 2_999, itemCount - 1]) {
          const scrollTop = getSongListGridScrollTopForIndex(
            index,
            itemCount,
            columns,
            rowStride,
            gridOffsetTop
          )
          const range = getSongListGridVirtualRange({
            itemCount,
            scrollTop,
            viewportHeight,
            gridOffsetTop,
            columns,
            rowStride
          })
          assert.ok(index >= range.start && index < range.end)
          assert.equal(range.start % columns, 0)
          assert.ok(
            range.end - range.start <= maxMountedGridCards(viewportHeight, rowStride, columns)
          )
          if (index === itemCount - 1) assert.equal(range.end, itemCount)
        }
      }
    }
  }
})

test('initial grid measurement uses the padded grid and CSS metrics rather than window width', () => {
  const source = readFileSync(new URL('./useSongListGridRendering.ts', import.meta.url), 'utf8')
  const declaration = source.slice(
    source.indexOf('  function estimateFromContainer('),
    source.indexOf('\n  function measureGridMetrics(')
  )
  const container = { clientWidth: 800 }
  const grid = { clientWidth: 700 }
  const values = new Map<object, Record<string, string>>([
    [
      container,
      {
        'padding-left': '32px',
        'padding-right': '32px',
        '--te-font-size-body': '21px'
      }
    ],
    [
      grid,
      {
        'padding-left': '2px',
        'padding-right': '2px',
        '--te-grid-card-min': '160px',
        '--te-grid-card-max': '220px',
        '--te-grid-card-pad-x': '0px',
        '--te-grid-card-pad-y': '0px',
        'column-gap': '14px',
        'row-gap': '16px'
      }
    ]
  ])
  const context = {
    containerRef: { value: container },
    gridColumns: { value: 1 },
    gridRowStride: { value: 1 },
    category: () => 'albums',
    virtualItemCount: { value: 6_000 },
    document: { documentElement: { dataset: {} } },
    window: {
      get innerWidth(): never {
        throw new Error('Grid geometry must not read window width')
      },
      getComputedStyle: (element: typeof container) => ({
        getPropertyValue: (property: string) => values.get(element)?.[property] ?? ''
      })
    },
    resolveGridLayoutMetrics,
    estimateGridColumns,
    estimateGridColumnWidth,
    estimateAlbumGridRowStride,
    estimateGridRowStride
  }
  const estimate = runInNewContext(
    `${stripTypeScriptTypes(declaration)}\nestimateFromContainer`,
    context
  )
  estimate(grid)
  assert.equal(context.gridColumns.value, 4)
  assert.equal(context.gridRowStride.value, 323)
  estimate(grid, 2)
  assert.equal(context.gridColumns.value, 2, 'measured template columns take priority')
  assert.equal(context.gridRowStride.value, 380)
  context.virtualItemCount.value = 2
  estimate(grid)
  assert.equal(context.gridColumns.value, 2, 'small collections do not leave reserved columns')
  assert.equal(context.gridRowStride.value, 380)
})

test('column changes wait for layout and retain observed card stride for virtual rows', () => {
  const source = readFileSync(new URL('./useSongListGridRendering.ts', import.meta.url), 'utf8')
  const declarations = source.slice(
    source.indexOf('  function estimateFromContainer('),
    source.indexOf('\n  function scheduleMeasure(')
  )
  let scheduled = 0
  let heightReads = 0
  const observed: object[] = []
  const card = {
    getBoundingClientRect: () => {
      heightReads++
      return { height: 317.5 }
    }
  }
  const grid = { clientWidth: 1_428, offsetTop: 180, querySelector: () => card }
  const container = { clientWidth: 1_428, firstElementChild: {}, querySelector: () => grid }
  const context = {
    containerRef: { value: container },
    showGrid: { value: true },
    virtualItemCount: { value: 6 },
    gridColumns: { value: 1 },
    gridRowStride: { value: 1 },
    gridOffsetTop: { value: 0 },
    category: () => 'albums',
    document: { documentElement: { dataset: {} } },
    observedGrid: null,
    observedCard: null,
    layoutObserver: null,
    ResizeObserver: class {
      disconnect(): void {}
      observe(element: object): void {
        observed.push(element)
      }
    },
    window: {
      getComputedStyle: () => ({
        get gridTemplateColumns(): string {
          return Array.from({ length: context.gridColumns.value }, () => '220px').join(' ')
        },
        rowGap: '22px',
        getPropertyValue: () => ''
      })
    },
    nextTick: (callback: () => void) => callback(),
    scheduleMeasure: () => scheduled++,
    updateViewportHeight: () => {},
    resolveGridLayoutMetrics,
    estimateGridColumns,
    estimateGridColumnWidth,
    estimateAlbumGridRowStride,
    estimateGridRowStride
  }
  const measure = runInNewContext(
    `${stripTypeScriptTypes(declarations)}\nmeasureGridMetrics`,
    context
  )
  measure()
  assert.equal(context.gridColumns.value, 6)
  assert.equal(scheduled, 1)
  assert.equal(heightReads, 0, 'old card height must not win before new columns have laid out')
  measure()
  assert.equal(context.gridRowStride.value, 339.5, 'actual card height plus gap wins the fallback')
  assert.equal(context.gridOffsetTop.value, 180)
  assert.deepEqual(observed, [container, grid, container.firstElementChild, card])

  grid.clientWidth = container.clientWidth = 1_000
  measure()
  assert.equal(context.gridColumns.value, 4)
  assert.equal(scheduled, 2)
  measure()
  assert.equal(context.gridRowStride.value, 339.5)
  context.virtualItemCount.value = 2
  measure()
  assert.equal(context.gridColumns.value, 2)
  assert.equal(scheduled, 3)
})

function firstIndexForLetter(letter: string): number {
  const names = Array.from({ length: 800 }, (_, index) => {
    const code = 65 + (index % 26)
    return `${String.fromCharCode(code)}rtist ${index}`
  })
  return names.findIndex((name) => name.startsWith(letter))
}
