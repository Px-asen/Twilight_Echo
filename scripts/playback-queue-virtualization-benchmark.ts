import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { dirname, resolve } from 'node:path'
import type { Track } from '../src/renderer/src/types/music.ts'
import {
  createPlaybackQueueDisplayItems,
  getPlaybackQueueScrollTopForIndex,
  getPlaybackQueueWindow,
  PLAYBACK_QUEUE_OVERSCAN,
  PLAYBACK_QUEUE_ROW_HEIGHT,
  toPlaybackQueueSnapshots
} from '../src/renderer/src/utils/playbackQueueVirtualization.ts'

const VIEWPORT_HEIGHT = 324

export interface QueueBenchmarkOptions {
  output: string
  sizes?: number[]
  iterations?: number
  lyricsBytes?: number
  tempoSegments?: number
}

type Metrics = {
  samplesMs: number[]
  p95Ms: number
  maxHeapDeltaBytes: number
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`)
  return parsed
}

export function parseArgs(args: string[]): QueueBenchmarkOptions {
  const options: QueueBenchmarkOptions = {
    output: '',
    sizes: [5_000, 20_000],
    iterations: 3,
    lyricsBytes: 2_048,
    tempoSegments: 24
  }
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--output') options.output = args[++index] ?? ''
    else if (value === '--sizes') {
      options.sizes = String(args[++index] ?? '')
        .split(',')
        .filter(Boolean)
        .map((item) => parsePositiveInteger(item.trim(), '--sizes'))
    } else if (value === '--iterations')
      options.iterations = parsePositiveInteger(args[++index], '--iterations')
    else if (value === '--lyrics-bytes')
      options.lyricsBytes = parsePositiveInteger(args[++index], '--lyrics-bytes')
    else if (value === '--tempo-segments')
      options.tempoSegments = parsePositiveInteger(args[++index], '--tempo-segments')
  }
  if (!options.output) throw new Error('--output is required')
  if (!options.sizes?.length) throw new Error('--sizes must contain positive integers')
  return options
}

function makeUniquePayload(trackIndex: number, kind: string, bytes: number): string {
  const prefix = `${kind}:${trackIndex}:`
  return (
    prefix +
    `${trackIndex.toString(36)}-`
      .repeat(Math.ceil((bytes - prefix.length) / 4))
      .slice(0, bytes - prefix.length)
  )
}

export function createProductionTrack(
  index: number,
  lyricsBytes: number,
  tempoSegments: number
): Track {
  const lyrics = makeUniquePayload(index, 'lyrics', lyricsBytes)
  const translatedLyrics = makeUniquePayload(index, 'translated', lyricsBytes)
  return {
    id: `local:benchmark-${index}`,
    title: `Benchmark Track ${index}`,
    artist: `Artist ${index % 31}`,
    album: `Album ${index % 97}`,
    filePath: `E:\\Benchmark\\${index}.flac`,
    fileName: `${index}.flac`,
    dir: 'E:\\Benchmark',
    duration: 180 + (index % 120),
    size: 10_000_000 + index,
    cover: `cover://benchmark-${index % 97}`,
    lyrics,
    translatedLyrics,
    metadataMatch: {
      providerId: 'ncm',
      trackId: `ncm:${index}`,
      confidence: 'high',
      score: 1
    },
    source: 'local',
    format: 'flac',
    sampleRate: 96_000,
    bitrate: 2_400,
    bitDepth: 24,
    bpm: 120,
    bpmAnalysis: {
      bpm: 120,
      confidence: 0.95,
      source: 'analyzed',
      analyzedAt: '2026-07-17T00:00:00.000Z',
      algorithmVersion: 1,
      tempoMap: Array.from({ length: tempoSegments }, (_, segment) => ({
        startMs: segment * 4_000,
        endMs: (segment + 1) * 4_000,
        bpm: 120 + ((index + segment) % 3),
        confidence: 0.9
      }))
    }
  }
}

function heavyPayloadBytes(tracks: readonly Track[]): number {
  return tracks.reduce((total, track) => {
    return (
      total +
      (track.lyrics?.length ?? 0) +
      (track.translatedLyrics?.length ?? 0) +
      (track.metadataMatch ? JSON.stringify(track.metadataMatch).length : 0) +
      (track.bpmAnalysis ? JSON.stringify(track.bpmAnalysis).length : 0)
    )
  }, 0)
}

function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

function gc(): void {
  if (typeof global.gc === 'function') global.gc()
}

function measure(operation: () => void): { durationMs: number; heapDeltaBytes: number } {
  gc()
  const before = process.memoryUsage().heapUsed
  const started = performance.now()
  operation()
  return {
    durationMs: performance.now() - started,
    heapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - before)
  }
}

function benchmarkSize(
  queueLength: number,
  options: Required<Pick<QueueBenchmarkOptions, 'iterations' | 'lyricsBytes' | 'tempoSegments'>>
) {
  const source = Array.from({ length: queueLength }, (_, index) =>
    createProductionTrack(index, options.lyricsBytes, options.tempoSegments)
  )
  const sourceHeavyBytes = heavyPayloadBytes(source)
  const snapshotMetrics: Metrics = { samplesMs: [], p95Ms: 0, maxHeapDeltaBytes: 0 }
  const windowMetrics: Metrics = { samplesMs: [], p95Ms: 0, maxHeapDeltaBytes: 0 }
  let snapshotHeavyBytes = -1
  let windows: Array<{
    position: 'first' | 'middle' | 'last'
    range: { start: number; end: number }
    rows: number
  }> = []

  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    let snapshots: Track[] = []
    const snapshotMeasure = measure(() => {
      snapshots = toPlaybackQueueSnapshots(source)
    })
    snapshotMetrics.samplesMs.push(snapshotMeasure.durationMs)
    snapshotMetrics.maxHeapDeltaBytes = Math.max(
      snapshotMetrics.maxHeapDeltaBytes,
      snapshotMeasure.heapDeltaBytes
    )
    snapshotHeavyBytes = heavyPayloadBytes(snapshots)
    assert.equal(
      snapshotHeavyBytes,
      0,
      'production queue snapshots must strip heavy lyric/match/BPM payloads'
    )

    const positions = [
      ['first', 0],
      ['middle', Math.floor(queueLength / 2)],
      ['last', queueLength - 1]
    ] as const
    const windowMeasure = measure(() => {
      windows = positions.map(([position, index]) => {
        const scrollTop = getPlaybackQueueScrollTopForIndex(
          index,
          snapshots.length,
          VIEWPORT_HEIGHT
        )
        const range = getPlaybackQueueWindow(snapshots.length, scrollTop, VIEWPORT_HEIGHT)
        const rows = createPlaybackQueueDisplayItems(snapshots, range)
        assert.ok(
          rows.some((row) => row.index === index),
          `${position} current item must be visible`
        )
        assert.ok(rows.length <= 18, `${position} window must remain bounded`)
        return { position, range, rows: rows.length }
      })
    })
    windowMetrics.samplesMs.push(windowMeasure.durationMs)
    windowMetrics.maxHeapDeltaBytes = Math.max(
      windowMetrics.maxHeapDeltaBytes,
      windowMeasure.heapDeltaBytes
    )
  }

  snapshotMetrics.p95Ms = percentile95(snapshotMetrics.samplesMs)
  windowMetrics.p95Ms = percentile95(windowMetrics.samplesMs)
  const limits = {
    mountedRows:
      Math.ceil(VIEWPORT_HEIGHT / PLAYBACK_QUEUE_ROW_HEIGHT) + PLAYBACK_QUEUE_OVERSCAN * 2,
    snapshotP95Ms: Math.max(16, (queueLength / 1_000) * 4),
    windowP95Ms: 8,
    windowHeapDeltaBytes: 8 * 1024 * 1024,
    snapshotHeavyBytes: 0
  }
  assert.ok(
    snapshotMetrics.p95Ms <= limits.snapshotP95Ms,
    'snapshot time exceeded reproducible threshold'
  )
  assert.ok(
    windowMetrics.p95Ms <= limits.windowP95Ms,
    'window time exceeded reproducible threshold'
  )
  assert.ok(
    windowMetrics.maxHeapDeltaBytes <= limits.windowHeapDeltaBytes,
    'window memory exceeded threshold'
  )
  assert.equal(snapshotHeavyBytes, limits.snapshotHeavyBytes)

  return {
    queueLength,
    sourceHeavyBytes,
    snapshotHeavyBytes,
    limits,
    snapshotMetrics,
    windowMetrics,
    windows
  }
}

export function runBenchmark(options: QueueBenchmarkOptions) {
  const normalized = {
    iterations: options.iterations ?? 3,
    lyricsBytes: options.lyricsBytes ?? 2_048,
    tempoSegments: options.tempoSegments ?? 24
  }
  const result = {
    schemaVersion: 2,
    title: 'Twilight Echo production queue virtualization benchmark',
    generatedAt: new Date().toISOString(),
    runner: {
      implementation: 'src/renderer/src/utils/playbackQueueVirtualization.ts',
      command: process.argv,
      rowHeight: PLAYBACK_QUEUE_ROW_HEIGHT,
      viewportHeight: VIEWPORT_HEIGHT,
      overscan: PLAYBACK_QUEUE_OVERSCAN,
      gcExposed: typeof global.gc === 'function'
    },
    scenarios: (options.sizes ?? [5_000, 20_000]).map((size) => benchmarkSize(size, normalized))
  }
  mkdirSync(dirname(resolve(options.output)), { recursive: true })
  writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`)
  return result
}

if (import.meta.main) {
  const result = runBenchmark(parseArgs(process.argv.slice(2)))
  console.log(JSON.stringify(result, null, 2))
}
