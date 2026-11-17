import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { cpus, totalmem } from 'node:os'
import type { SQLInputValue } from 'node:sqlite'
import { openMixedLibraryFixture } from './fixtures/mixed-music-library.ts'
import { reconcileMusicLibrary } from '../src/main/library/libraryDatabaseReconciliation.ts'

// node --expose-gc --experimental-strip-types scripts/benchmark-unified-music-library.ts 50000 output/unified-library-100k.json
// Query-only follow-up: append --reuse-fixture=<absolute root> --ingestion-evidence=<original report>.
// After the worker probe, also declare --expected-completed-metadata-jobs=2 --expected-metadata-facts=1.
const args = process.argv.slice(2), positional = args.filter(arg => !arg.startsWith('--'))
const option = (name: string) => {
  const value = args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  assert.notEqual(value, '', `--${name} requires a value`)
  return value
}
const reuseRoot = option('reuse-fixture'), ingestionEvidencePath = option('ingestion-evidence')
const countOption = (name: string) => {
  const value = option(name) ?? '0', count = Number(value)
  assert.ok(/^\d+$/.test(value) && Number.isSafeInteger(count), `--${name} requires a non-negative integer`)
  return count
}
const expectedMetadata = { completedJobs: countOption('expected-completed-metadata-jobs'), facts: countOption('expected-metadata-facts') }
assert.ok(!ingestionEvidencePath || reuseRoot, '--ingestion-evidence requires --reuse-fixture')
const perSource = Number(positional[0] ?? 50_000)
const output = resolve(positional[1] ?? (reuseRoot ? 'output/unified-library-100k-reused.json' : 'output/unified-library-100k.json'))
const comparablePath = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
if (ingestionEvidencePath) assert.notEqual(comparablePath(output), comparablePath(ingestionEvidencePath), 'Query output must not overwrite its ingestion evidence')
const rounds = Number(process.env.MUSIC_BENCHMARK_ROUNDS ?? 3)
assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 10)
const start = performance.now()
const fixture = await openMixedLibraryFixture({ perSource, cached: Math.min(1000, perSource / 5), reuseRoot, expectedMetadata,
  progress: phase => console.error(`[mixed benchmark] ${phase}`) })
const db = fixture.database, e = fixture.expected, limit = 50
const fixtureMs = performance.now() - start
const originalFetch = globalThis.fetch
let networkRequests = 0
globalThis.fetch = async () => { networkRequests++; throw new Error('Offline benchmark must not request HTTP') }
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]
const focus = { version: 1 as const, entity: 'recording' as const }
type Page = { total: number; items?: unknown[]; tracks?: unknown[] }
const check = <T extends Page>(page: T, total: number, offset = 0) => {
  assert.equal(page.total, total)
  const items = page.items ?? page.tracks!
  assert.equal(items.length, Math.min(limit, Math.max(0, total - offset)))
  assert.ok(items.length <= limit)
  return page
}
const deep = (total: number) => Math.max(0, total - limit)
const cases: Record<string, () => Page> = {
  queryTracksFirst: () => check(db.queryTracks({ sort: 'title', limit }), e.localTracks),
  queryTracksDeep: () => check(db.queryTracks({ sort: 'title', limit, offset: deep(e.localTracks) }), e.localTracks, deep(e.localTracks)),
  catalogFirst: () => check(db.catalogQuery({ kind: 'recording', limit }), e.catalogBindingLibraryRecordings),
  catalogDeep: () => check(db.catalogQuery({ kind: 'recording', limit, offset: deep(e.catalogBindingLibraryRecordings) }), e.catalogBindingLibraryRecordings, deep(e.catalogBindingLibraryRecordings)),
  genreFirst: () => check(db.genresBrowse({ kind: 'recording', genreId: 'genre:jazz', limit }), e.jazzLibraryBindingRecordings),
  genreDeep: () => check(db.genresBrowse({ kind: 'recording', genreId: 'genre:jazz', limit, offset: deep(e.jazzLibraryBindingRecordings) }), e.jazzLibraryBindingRecordings, deep(e.jazzLibraryBindingRecordings)),
  genreFormatFacet: () => {
    const page = db.genresFacets({ kind: 'recording', genreId: 'genre:jazz', dimension: 'format', limit })
    assert.deepEqual(page.items.map(i => [i.value, i.count]).sort(), [['AAC', perSource / 2], ['FLAC', perSource / 2]])
    return check(page, 2)
  },
  focusFirst: () => check(db.focusQuery({ query: focus, limit }), e.libraryRecordings),
  focusDeep: () => check(db.focusQuery({ query: focus, limit, offset: deep(e.libraryRecordings) }), e.libraryRecordings, deep(e.libraryRecordings)),
  focusJazz: () => check(db.focusQuery({ query: { ...focus, where: { genre: { id: 'genre:jazz' } } }, limit }), e.jazzLibraryRecordings),
  focusProviderFacet: () => {
    const page = db.focusFacets({ query: focus, facet: 'provider', limit })
    assert.deepEqual(page.items.map(i => [i.value, i.count]).sort(), [['local', perSource], ['ncm', perSource]])
    return check(page, 2)
  },
  albumsFirst: () => check(db.albumsBrowse({ entityId: fixture.anchor.releaseId, limit }), e.projectReleases),
  albumsDeep: () => check(db.albumsBrowse({ entityId: fixture.anchor.releaseId, limit, offset: deep(e.projectReleases) }), e.projectReleases, deep(e.projectReleases)),
  albumSourcesFirst: () => {
    const page = db.albumsBrowse({ entityId: fixture.anchor.releaseId, limit: 1 }), release = page.items[0]
    return check(db.albumsSources({ entityId: fixture.anchor.releaseId, releaseId: release.id, token: page.token, limit }), e.anchorReleaseSources)
  },
  metadataTasksFirst: () => {
    const page = db.metadataTasks({ limit })
    assert.deepEqual(Object.fromEntries(Object.entries(page.counts).filter(([, count]) => count > 0)), fixture.metadataInventory.jobStates)
    return check(page, fixture.metadataInventory.totalJobs)
  }
}
try {
  let ingestionEvidence: unknown = null
  if (ingestionEvidencePath) {
    const sourceReportPath = resolve(ingestionEvidencePath)
    const original = JSON.parse(readFileSync(sourceReportPath, 'utf8')) as {
      timestamp: string; expected: unknown; fixtureMs: number; ingestionPhasesMs: Record<string, number>; fixture?: { mode: string }
    }
    assert.deepEqual(original.expected, e, 'Ingestion evidence must describe the same fixture inventory')
    assert.equal(original.fixture?.mode ?? 'seeded', 'seeded', 'Reference an ingestion report, not another reuse run')
    assert.ok(Object.keys(original.ingestionPhasesMs).length > 0, 'Ingestion evidence must contain measured ingestion phases')
    ingestionEvidence = { sourceReportPath, sourceTimestamp: original.timestamp, fixtureMs: original.fixtureMs,
      ingestionPhasesMs: original.ingestionPhasesMs, measurement: 'Linked original-round ingestion evidence; not measured again by this run' }
  }
  globalThis.gc?.()
  const baselineMemory = process.memoryUsage()
  const metrics: Record<string, unknown> = {}
  const sql = db.sql, prepare = sql.prepare.bind(sql)
  const capturedPlans = new Map<string, Array<{ sql: string; params: SQLInputValue[] }>>()
  const planCases = new Set(['catalogFirst', 'genreFirst', 'genreFormatFacet', 'focusFirst', 'focusJazz', 'focusProviderFacet', 'albumsFirst'])
  const firstRead = (name: string, action: () => Page): Page => {
    if (!planCases.has(name)) return action()
    const captured: Array<{ sql: string; params: SQLInputValue[] }> = []
    capturedPlans.set(name, captured)
    sql.prepare = ((query: string) => {
      const statement = prepare(query)
      if (/^\s*WITH\b/i.test(query)) for (const method of ['get', 'all'] as const) {
        const original = statement[method].bind(statement)
        Object.defineProperty(statement, method, {
          configurable: true,
          writable: true,
          value: (...params: SQLInputValue[]) => {
            captured.push({ sql: query, params })
            return original(...params)
          }
        })
      }
      return statement
    }) as typeof sql.prepare
    try { return action() } finally { sql.prepare = prepare }
  }
  const firstIds = new Map<string, Set<string>>()
  for (const [name, action] of Object.entries(cases)) {
    console.error(`[mixed benchmark] ${name}`)
    const coldStart = performance.now(), cold = firstRead(name, action), firstMs = performance.now() - coldStart
    const records = (cold.items ?? cold.tracks!) as Record<string, unknown>[]
    if (records.every(row => typeof row.id === 'string')) {
      const ids = new Set(records.map(row => String(row.id)))
      assert.equal(ids.size, records.length)
      if (name.endsWith('First')) firstIds.set(name, ids)
      if (name.endsWith('Deep') && cold.total >= limit * 2) {
        const first = firstIds.get(name.replace(/Deep$/, 'First'))!
        for (const id of ids) assert.equal(first.has(id), false)
      }
    }
    if (/^(queryTracks|catalog|genreFirst|genreDeep|focusFirst|focusDeep|focusJazz)/.test(name)) {
      for (const row of records) {
        const index = Number(String(row.title).split(' ')[1])
        assert.ok(Number.isSafeInteger(index) && index >= 0 && index < perSource)
        if (/^genre|Jazz$/.test(name)) assert.equal(index % 2, 0)
        if (/^focus/.test(name)) assert.equal(row.sourceCount, index < e.confirmedPairs ? 2 : 1)
      }
    }
    const samples: number[] = [], memoryBefore = process.memoryUsage()
    for (let i = 0; i < rounds; i++) { const before = performance.now(); action(); samples.push(performance.now() - before) }
    const memoryAfter = process.memoryUsage()
    const p50Ms = percentile(samples, 0.5), p95Ms = percentile(samples, 0.95)
    metrics[name] = { firstMs, samplesMs: samples, p50Ms, p95Ms, maxMs: Math.max(...samples),
      total: cold.total, returned: (cold.items ?? cold.tracks!).length, memoryBefore, memoryAfter }
    console.error(`[mixed benchmark] ${name} complete first=${firstMs.toFixed(2)}ms p50=${p50Ms.toFixed(2)}ms p95=${p95Ms.toFixed(2)}ms`)
  }
  // Separate scopes and personal state retain their actual meaning at scale.
  assert.equal(db.catalogQuery({ kind: 'recording', scope: 'all', limit: 1 }).total, e.catalogSources)
  assert.equal(db.focusQuery({ query: { ...focus, scope: 'catalog' }, limit: 1 }).total, e.catalogRecordings)
  assert.equal(db.focusQuery({ query: { ...focus, where: { rating: { mode: 'personal', target: 'self', gteStars: 4 } } }, limit: 1 }).total, e.ratedFourStars)
  assert.equal(db.focusQuery({ query: { ...focus, where: { automaticPlaybackBlocked: true } }, limit: 1 }).total, e.banned)
  assert.equal(db.focusQuery({ query: { ...focus, where: { tag: { id: fixture.tagId } } }, limit: 1 }).total, e.taggedRecordings)
  // Explain exactly the SQL and bound inputs used by the first real read. Do not
  // execute the workload again merely to obtain a plan for an expensive query.
  const plans = Object.fromEntries([...capturedPlans].map(([name, captures]) => [name,
    captures.map(capture => ({ sql: capture.sql,
      plan: prepare(`EXPLAIN QUERY PLAN ${capture.sql}`).all(...capture.params) }))]))
  const reconciliationStart = performance.now(), reconciliationReport = reconcileMusicLibrary(db.sql, { exampleLimit: 5 })
  const reconciliation = { ms: performance.now() - reconciliationStart, report: reconciliationReport }
  assert.equal(reconciliationReport.summary.errorChecks, 0)
  let workerProbe: unknown = null
  if (fixture.mode !== 'reused' && !args.includes('--no-worker')) {
    const { probeMusicLibraryWorker } = await import('./unified-music-library-worker-probe.ts')
    workerProbe = await probeMusicLibraryWorker({ databasePath: fixture.databasePath, localTrackId: fixture.anchor.localTrackId,
      progress: phase => console.error(`[worker probe] ${phase}`) })
  }
  assert.equal(networkRequests, 0)
  const report = {
    workload: 'Synthetic SQLite metadata benchmark through production read methods and separately identified ingestion; no real media/audio/UI measurement',
    timestamp: new Date().toISOString(), runtime: process.versions,
    machine: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, cpuThreads: cpus().length, totalMemoryBytes: totalmem() },
    fixture: { mode: fixture.mode, reusedPath: fixture.mode === 'reused' ? fixture.root : null,
      metadataInventory: fixture.metadataInventory,
      schema: fixture.schema,
      setupMeasurement: fixture.mode === 'reused' ? 'Production constructor open, possible migration/backup, and fixture validation before query_only=ON; no ingestion in this run' : 'Create, ingest and validate the fixture in this run' },
    method: { pageLimit: limit, warmup: 'first invocation recorded separately per case, including lightweight SQL capture where applicable; later samples run without capture; shared SQLite caches, no cold-cache measurement', rounds,
      fixtureReuse: fixture.mode === 'reused' ? 'Cross-process reuse of an existing SQLite fixture; OS and filesystem caches may be warm' : 'Fixture ingested in this process before query measurement',
      workerProbe: fixture.mode === 'reused' ? 'Skipped: query-only fixture reuse must not publish metadata' : args.includes('--no-worker') ? 'Skipped by --no-worker' : 'Executed after read measurements',
      deepOffset: 'max(0, exact expected total - pageLimit)', measurement: 'single process serial wall clock, RSS/heap/external snapshots per operation',
      catalogGrouping: 'catalog/genre retain playback bindings; Focus groups explicitly confirmed metadata recording identities', network: 'global fetch rejected and counted; worker probe separately counts mock-provider dispatch' },
    expected: e, fixtureMs, ingestionPhasesMs: fixture.phaseTimingsMs, ingestionEvidence, baselineMemory, finalMemory: process.memoryUsage(), peakRssKiB: process.resourceUsage().maxRSS,
    semanticChecks: ['complete expected totals', 'bounded pages', 'unique page IDs', 'disjoint first/deep pages where ranges do not overlap',
      'library/cache membership separation', 'confirmed identity source counts', 'genre membership', 'rating/ban/tag filters', 'edition/source totals'],
    offlineHttpRequests: networkRequests, metrics, reconciliation, workerProbe, plans
  }
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ output, expected: e, fixtureMs, metrics, offlineHttpRequests: networkRequests }, null, 2))
} finally { globalThis.fetch = originalFetch; fixture.close() }
