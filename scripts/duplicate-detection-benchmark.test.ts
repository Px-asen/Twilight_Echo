import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
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
  runDuplicateDetectionBenchmark,
  type DuplicateDetectionBenchmarkManifest,
  type DuplicateDetectionBenchmarkProvenance,
  type DuplicateDetectionBenchmarkResult
} from './duplicate-detection-benchmark.ts'

const evidenceUrl = new URL(
  './fixtures/te-4.4-duplicate-detection-2026-09-30.json',
  import.meta.url
)
const manifestUrl = new URL(
  './fixtures/te-4.4-duplicate-detection-2026-09-30.manifest.json',
  import.meta.url
)

function assertAuthenticatedArchive(
  evidenceBytes: Uint8Array,
  manifest: DuplicateDetectionBenchmarkManifest,
  provenance: DuplicateDetectionBenchmarkProvenance
): DuplicateDetectionBenchmarkResult {
  const evidence = JSON.parse(
    Buffer.from(evidenceBytes).toString('utf8')
  ) as DuplicateDetectionBenchmarkResult
  assert.equal(evidence.schemaVersion, 2)
  assert.equal(evidence.rows, DUPLICATE_BENCHMARK_ROWS)
  assert.equal(evidence.warmupIterations, DUPLICATE_BENCHMARK_WARMUP_ITERATIONS)
  assert.equal(evidence.iterations, DUPLICATE_BENCHMARK_ITERATIONS)
  assert.deepEqual(evidence.budgets, {
    uniqueP95Ms: DUPLICATE_BENCHMARK_UNIQUE_P95_BUDGET_MS,
    collisionP95Ms: DUPLICATE_BENCHMARK_COLLISION_P95_BUDGET_MS
  })
  assert.deepEqual(evidence.provenance, provenance)
  assert.equal(evidence.scenarios.unique.rows, DUPLICATE_BENCHMARK_ROWS)
  assert.equal(evidence.scenarios.unique.groups, 0)
  assert.deepEqual(evidence.scenarios.unique.groupsByEvidence, {})
  assert.equal(evidence.scenarios.collision.rows, DUPLICATE_BENCHMARK_ROWS)
  assert.equal(evidence.scenarios.collision.groups, 5_000)
  assert.deepEqual(evidence.scenarios.collision.groupsByEvidence, {
    path: 1_000,
    contentHash: 1_000,
    audioFingerprint: 1_000,
    metadataCandidate: 1_000,
    logicalTrack: 1_000
  })
  for (const scenario of [evidence.scenarios.unique, evidence.scenarios.collision]) {
    assert.equal(scenario.elapsedMs.length, DUPLICATE_BENCHMARK_ITERATIONS)
    assert.ok(scenario.elapsedMs.every((sample) => Number.isFinite(sample) && sample > 0))
    assert.equal(scenario.p50Ms, percentile(scenario.elapsedMs, 0.5))
    assert.equal(scenario.p95Ms, percentile(scenario.elapsedMs, 0.95))
    assert.equal(scenario.hashUnavailableIds, 0)
  }
  assert.ok(evidence.scenarios.unique.p95Ms <= DUPLICATE_BENCHMARK_UNIQUE_P95_BUDGET_MS)
  assert.ok(evidence.scenarios.collision.p95Ms <= DUPLICATE_BENCHMARK_COLLISION_P95_BUDGET_MS)

  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.generatedAt, evidence.generatedAt)
  assert.equal(manifest.evidence.path, 'te-4.4-duplicate-detection-2026-09-30.json')
  assert.equal(manifest.evidence.sha256, createHash('sha256').update(evidenceBytes).digest('hex'))
  assert.deepEqual(manifest.provenance, provenance)
  assert.deepEqual(manifest.benchmark, {
    rows: evidence.rows,
    warmupIterations: evidence.warmupIterations,
    iterations: evidence.iterations,
    budgets: evidence.budgets,
    unique: {
      p50Ms: evidence.scenarios.unique.p50Ms,
      p95Ms: evidence.scenarios.unique.p95Ms
    },
    collision: {
      p50Ms: evidence.scenarios.collision.p50Ms,
      p95Ms: evidence.scenarios.collision.p95Ms
    }
  })
  return evidence
}

test('benchmark provenance canonicalizes CRLF without changing other bytes', () => {
  const crlf = Uint8Array.from([0x61, 0x0d, 0x0a, 0x62, 0x0d, 0x0a, 0x0d, 0x63])
  const expected = Uint8Array.from([0x61, 0x0a, 0x62, 0x0a, 0x0d, 0x63])

  assert.deepEqual(canonicalizeProvenanceBytes(crlf), expected)
  assert.deepEqual(canonicalizeProvenanceBytes(expected), expected)
})

test('duplicate benchmark produces independent 10k-style unique and collision fixtures', () => {
  assert.equal(buildUniqueRows(10).length, 10)
  const collision = buildCollisionRows(10)
  assert.equal(collision.length, 10)
  assert.equal(collision.filter((item) => item.contentHash).length, 2)
  assert.equal(collision.filter((item) => item.audioFingerprint).length, 2)
})

test('duplicate benchmark records warmup-isolated reproducible scenario metrics', async () => {
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

test('archived benchmark evidence and manifest authenticate the current implementation', async () => {
  const evidenceBytes = readFileSync(evidenceUrl)
  const manifest = JSON.parse(
    readFileSync(manifestUrl, 'utf8')
  ) as DuplicateDetectionBenchmarkManifest
  const provenance = await collectDuplicateDetectionBenchmarkProvenance()

  assertAuthenticatedArchive(evidenceBytes, manifest, provenance)
})

test('archive contract rejects one-sided evidence tampering', async () => {
  const evidence = JSON.parse(
    readFileSync(evidenceUrl, 'utf8')
  ) as DuplicateDetectionBenchmarkResult
  const manifest = JSON.parse(
    readFileSync(manifestUrl, 'utf8')
  ) as DuplicateDetectionBenchmarkManifest
  const provenance = await collectDuplicateDetectionBenchmarkProvenance()
  evidence.scenarios.unique.elapsedMs[0] += 1
  const tampered = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`)

  assert.throws(() => assertAuthenticatedArchive(tampered, manifest, provenance))
})

test('archive contract rejects stale provenance even when its manifest is recomputed', async () => {
  const evidence = JSON.parse(
    readFileSync(evidenceUrl, 'utf8')
  ) as DuplicateDetectionBenchmarkResult
  const provenance = await collectDuplicateDetectionBenchmarkProvenance()
  evidence.provenance.source.sha256 = '0'.repeat(64)
  const staleBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`)
  const staleManifest = createDuplicateBenchmarkManifest(
    evidence,
    'te-4.4-duplicate-detection-2026-09-30.json',
    staleBytes
  )

  assert.throws(() => assertAuthenticatedArchive(staleBytes, staleManifest, provenance))
})

test('archive contract rejects hand-edited p95 values even when its manifest is recomputed', async () => {
  const evidence = JSON.parse(
    readFileSync(evidenceUrl, 'utf8')
  ) as DuplicateDetectionBenchmarkResult
  const provenance = await collectDuplicateDetectionBenchmarkProvenance()
  evidence.scenarios.unique.p95Ms = 0
  const editedBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`)
  const editedManifest = createDuplicateBenchmarkManifest(
    evidence,
    'te-4.4-duplicate-detection-2026-09-30.json',
    editedBytes
  )

  assert.throws(() => assertAuthenticatedArchive(editedBytes, editedManifest, provenance))
})
