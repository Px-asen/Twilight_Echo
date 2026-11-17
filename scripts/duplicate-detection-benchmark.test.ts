import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DUPLICATE_BENCHMARK_COLLISION_P95_BUDGET_MS,
  DUPLICATE_BENCHMARK_ITERATIONS,
  DUPLICATE_BENCHMARK_ROWS,
  DUPLICATE_BENCHMARK_UNIQUE_P95_BUDGET_MS,
  DUPLICATE_BENCHMARK_WARMUP_ITERATIONS,
  buildCollisionRows,
  buildUniqueRows,
  canonicalizeProvenanceBytes,
  collectDuplicateDetectionBenchmarkProvenance,
  createDuplicateBenchmarkManifest,
  parseDuplicateBenchmarkCli,
  percentile,
  runDuplicateDetectionBenchmark
} from './duplicate-detection-benchmark.ts'

test('benchmark provenance canonicalizes CRLF without changing other bytes', () => {
  const crlf = Uint8Array.from([0x61, 0x0d, 0x0a, 0x62, 0x0d, 0x0a, 0x0d, 0x63])
  const expected = Uint8Array.from([0x61, 0x0a, 0x62, 0x0a, 0x0d, 0x63])

  assert.deepEqual(canonicalizeProvenanceBytes(crlf), expected)
  assert.deepEqual(canonicalizeProvenanceBytes(expected), expected)
})

test('benchmark provenance hashes only duplicate-detection contracts and implementation', async () => {
  const provenance = await collectDuplicateDetectionBenchmarkProvenance()
  assert.equal(provenance.algorithm, 'sha256')
  assert.deepEqual(Object.keys(provenance).sort(), [
    'algorithm',
    'coreSource',
    'sharedContract',
    'source'
  ])
  assert.match(provenance.coreSource.sha256, /^[0-9a-f]{64}$/)
  assert.match(provenance.source.sha256, /^[0-9a-f]{64}$/)
  assert.match(provenance.sharedContract.sha256, /^[0-9a-f]{64}$/)
})

test('duplicate benchmark produces independent 10k-style unique and collision fixtures', () => {
  assert.equal(buildUniqueRows(10).length, 10)
  const collision = buildCollisionRows(10)
  assert.equal(collision.length, 10)
  assert.equal(collision.filter((item) => item.contentHash).length, 2)
  assert.equal(collision.filter((item) => item.audioFingerprint).length, 2)
})

test('duplicate benchmark records warmup-isolated reproducible scenario metrics and manifest', async () => {
  const result = await runDuplicateDetectionBenchmark({
    rows: 100,
    warmupIterations: 1,
    iterations: 2
  })
  assert.equal(result.schemaVersion, 2)
  assert.equal(result.warmupIterations, 1)
  assert.equal(result.iterations, 2)
  assert.equal(result.scenarios.unique.rows, 100)
  assert.equal(result.scenarios.unique.elapsedMs.length, 2)
  assert.equal(result.scenarios.collision.elapsedMs.length, 2)
  assert.equal(result.scenarios.unique.groups, 0)
  assert.equal(result.scenarios.collision.groups, 50)
  assert.deepEqual(result.scenarios.collision.groupsByEvidence, {
    path: 10,
    contentHash: 10,
    audioFingerprint: 10,
    metadataCandidate: 10,
    logicalTrack: 10
  })
  assert.ok(result.scenarios.unique.p95Ms <= result.budgets.uniqueP95Ms)
  assert.ok(result.scenarios.collision.p95Ms <= result.budgets.collisionP95Ms)

  const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`)
  const manifest = createDuplicateBenchmarkManifest(result, 'benchmark.json', bytes)
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.evidence.path, 'benchmark.json')
  assert.equal(manifest.evidence.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.deepEqual(manifest.provenance, result.provenance)
})

test('duplicate benchmark builds the production 10k unique and high-collision fixtures', () => {
  const unique = buildUniqueRows(10_000)
  const collision = buildCollisionRows(10_000)
  assert.equal(unique.length, 10_000)
  assert.equal(collision.length, 10_000)
  assert.equal(new Set(unique.map((item) => item.filePath)).size, 10_000)
  assert.equal(collision.filter((item) => item.contentHash).length, 2_000)
  assert.equal(collision.filter((item) => item.audioFingerprint).length, 2_000)
})

test('production collision fixture has one intentional pair per evidence class', async () => {
  const result = await runDuplicateDetectionBenchmark({
    rows: 10_000,
    warmupIterations: 1,
    iterations: 1
  })
  assert.equal(result.scenarios.unique.groups, 0)
  assert.equal(result.scenarios.collision.groups, 5_000)
  assert.deepEqual(result.scenarios.collision.groupsByEvidence, {
    path: 1_000,
    contentHash: 1_000,
    audioFingerprint: 1_000,
    metadataCandidate: 1_000,
    logicalTrack: 1_000
  })
})

test('production benchmark contract has enough measured samples for a real p95', () => {
  assert.equal(DUPLICATE_BENCHMARK_ROWS, 10_000)
  assert.equal(DUPLICATE_BENCHMARK_WARMUP_ITERATIONS, 3)
  assert.equal(DUPLICATE_BENCHMARK_ITERATIONS, 20)
  assert.equal(DUPLICATE_BENCHMARK_UNIQUE_P95_BUDGET_MS, 1_500)
  assert.equal(DUPLICATE_BENCHMARK_COLLISION_P95_BUDGET_MS, 2_500)
  assert.equal(
    percentile(
      Array.from({ length: 20 }, (_, index) => index + 1),
      0.95
    ),
    19
  )
})

test('benchmark CLI accepts pnpm argument separators and requires an evidence output for manifests', () => {
  const parsed = parseDuplicateBenchmarkCli([
    '--',
    '--output',
    'benchmark.json',
    '--manifest',
    'benchmark.manifest.json'
  ])
  assert.match(parsed.output ?? '', /benchmark\.json$/)
  assert.match(parsed.manifest ?? '', /benchmark\.manifest\.json$/)
  assert.throws(
    () => parseDuplicateBenchmarkCli(['--', '--manifest', 'manifest.json']),
    /requires --output/
  )
})
