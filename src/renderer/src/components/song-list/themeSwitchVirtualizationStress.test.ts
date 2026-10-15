import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  BUILT_IN_THEME_PRESETS,
  resolveThemeProfileModes,
  themeModesToDataAttributes
} from '../../../../shared/theme.ts'
import { nearestRankPercentile } from '../../utils/themePerformance.ts'
import {
  getSongListGridVirtualRange,
  getSongListVirtualRange,
  maxMountedGridCards
} from './songListVirtualWindow.ts'

const TRACK_COUNT = 10_000
const ROW_HEIGHT = 56
const VIEWPORT_HEIGHT = 720
const PREVIEW_P95_BUDGET_MS = 32

test('10k SongList stays virtualized while all built-in themes switch during scrolling', () => {
  const tracks = Array.from({ length: TRACK_COUNT }, (_, index) => ({
    id: `local:stress:${index}`,
    title: `Theme stress track ${index}`,
    artist: `Artist ${index % 127}`,
    album: `Album ${index % 311}`
  }))
  const originalTracks = tracks
  const samplesMs: number[] = []
  const scrollPositions = [0, TRACK_COUNT * ROW_HEIGHT * 0.5, TRACK_COUNT * ROW_HEIGHT - 1]

  for (let iteration = 0; iteration < 40; iteration += 1) {
    for (const preset of BUILT_IN_THEME_PRESETS) {
      for (const scrollTop of scrollPositions) {
        const startedAt = performance.now()
        const attributes = themeModesToDataAttributes(resolveThemeProfileModes(preset))
        const range = getSongListVirtualRange({
          trackCount: tracks.length,
          scrollTop,
          viewportHeight: VIEWPORT_HEIGHT,
          tableOffsetTop: 0,
          rowHeight: ROW_HEIGHT
        })
        const visibleTracks = tracks.slice(range.start, range.end)
        samplesMs.push(performance.now() - startedAt)

        assert.equal(tracks, originalTracks)
        assert.ok(Object.keys(attributes).length > 0)
        assert.ok(visibleTracks.length <= Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + 12)
      }
    }
  }

  const p95Ms = nearestRankPercentile(samplesMs, 0.95)
  assert.ok(p95Ms !== null && p95Ms < PREVIEW_P95_BUDGET_MS, `theme + scroll p95 ${p95Ms}ms`)
})

test('theme runtime cannot rebuild the library or become a SongList reset source', () => {
  const themeStore = readFileSync(new URL('../../stores/useThemeStore.ts', import.meta.url), 'utf8')
  const virtualScroll = readFileSync(
    new URL('./useSongListVirtualScroll.ts', import.meta.url),
    'utf8'
  )
  const songList = readFileSync(new URL('../SongList.vue', import.meta.url), 'utf8')

  assert.doesNotMatch(themeStore, /useMusicStore|tracks\.value\s*=/)
  // DOM attributes may trigger a geometry remeasure for larger type or density.
  // They must not couple the virtual window to a global theme/library store.
  assert.doesNotMatch(virtualScroll, /useThemeStore|useMusicStore|tracks\.value\s*=/)
  assert.match(songList, /v-for="\(track, index\) in visibleTracks"/)
  assert.doesNotMatch(songList.match(/resetSources:\s*\[[\s\S]*?\]/)?.[0] ?? '', /theme/i)
})

test('10k collection grid stays within viewport + overscan while scrolling', () => {
  const itemCount = 10_000
  const columns = 5
  const rowStride = 260
  const viewportHeight = 720
  const cap = maxMountedGridCards(viewportHeight, rowStride, columns)
  for (const scrollTop of [0, 8_000, 40_000, 120_000]) {
    const range = getSongListGridVirtualRange({
      itemCount,
      scrollTop,
      viewportHeight,
      gridOffsetTop: 180,
      columns,
      rowStride
    })
    assert.ok(range.end - range.start <= cap)
  }
})
