import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, open, rm, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateStemMaterial,
  stemBudgetMs,
  stemResultMatchesRun,
  STEM_MODEL_VERSION,
  STEM_CHECKPOINT_SHA256,
  AutoMixStemService
} from './autoMixStemService.ts'
import { normalizeAutoMixStemCacheMiB } from '../../shared/twilightAutoMix.ts'

test('disabled stems bypass detection and source material export', async () => {
  let detections = 0
  const service = new AutoMixStemService(
    'unused',
    () => {
      detections++
      return null
    },
    () => false
  )
  const request = '{"mode":"dj"}'
  await service.select(request, async (actual) => {
    assert.equal(actual, request)
    return { ok: true }
  })
  assert.equal(await service.prepare({ ok: true }, () => 0, new AbortController().signal), null)
  assert.equal(detections, 0)
})

test('host passes each selected device to the worker and rechecks enable after detection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stem-device-request-test-'))
  const workerDirectory = join(root, 'worker'),
    pack = join(root, 'pack')
  await mkdir(workerDirectory)
  await mkdir(join(pack, 'runtime'), { recursive: true })
  // A tiny process fixture observes the real spawn request without running a model.
  await copyFile(process.execPath, join(pack, 'runtime/python.exe'))
  const metadata = JSON.stringify({
    modelVersion: STEM_MODEL_VERSION,
    checkpointSha256: STEM_CHECKPOINT_SHA256
  })
  await writeFile(join(pack, 'manifest.json'), metadata)
  await writeFile(join(pack, 'model.lock.json'), metadata)
  await writeFile(
    join(workerDirectory, 'worker.py'),
    `const fs=require('node:fs'),path=require('node:path');const file=process.argv[2],request=JSON.parse(fs.readFileSync(file,'utf8'));fs.writeFileSync(path.join(path.dirname(file),'result.json'),JSON.stringify({ok:false,reason:'policy_test_complete',resources:{requestedDevice:request.device}}));`
  )
  let device = 'auto',
    enabled = true
  const observed: unknown[] = []
  const service = new AutoMixStemService(
    join(root, 'cache'),
    async () => pack,
    () => enabled,
    (resources) => observed.push(resources.requestedDevice),
    () => 512,
    () => workerDirectory,
    () => device
  )
  try {
    for (device of ['auto', 'gpu', 'cpu']) {
      const selection = await service.select('{}', async (request) => ({
        ok: true,
        stemDirectory: JSON.parse(request).materialDirectory,
        inputs: [],
        channels: 2,
        currentStartSeconds: 100
      }))
      try {
        await assert.rejects(
          service.prepare(selection, () => 0, new AbortController().signal),
          /policy_test_complete/
        )
      } finally {
        await service.release(selection)
      }
    }
    assert.deepEqual(observed, ['auto', 'gpu', 'cpu'])
    const changed = new AutoMixStemService(
      'unused',
      async () => {
        enabled = false
        return pack
      },
      () => enabled
    )
    await changed.select('{}', async (request) => {
      assert.equal(request, '{}')
      return { ok: true }
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy and unsupported stem cache settings migrate to 512 MiB', () => {
  for (const value of [undefined, null, '256', -1, 128, NaN, Infinity])
    assert.equal(normalizeAutoMixStemCacheMiB(value), 512)
  for (const value of [0, 256, 512, 1024, 2048])
    assert.equal(normalizeAutoMixStemCacheMiB(value), value)
})

test('streamed material hashing checks bytes and length, and honors cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stem-digest-test-'))
  const path = join(directory, '中文材料.f32')
  const block = Buffer.alloc(256 * 1024, 123)
  const hash = createHash('sha256')
  const file = await open(path, 'w')
  try {
    for (let i = 0; i < 65; i++) {
      await file.write(block)
      hash.update(block)
    }
  } finally {
    await file.close()
  }
  const digest = hash.digest('hex')
  const length = block.length * 65
  try {
    await validateStemMaterial(path, length, digest, new AbortController().signal)
    await assert.rejects(
      validateStemMaterial(path, length - 1, digest, new AbortController().signal),
      /material_digest_mismatch/
    )
    await assert.rejects(
      validateStemMaterial(path, length, '0'.repeat(64), new AbortController().signal),
      /material_digest_mismatch/
    )
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(validateStemMaterial(path, length, digest, aborted.signal), /abort/i)
    const during = new AbortController()
    const pending = validateStemMaterial(path, length, digest, during.signal)
    setImmediate(() => during.abort())
    await assert.rejects(pending, /abort/i)
    // The file handle must be closed on every failure, including Windows.
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stem budget preserves native preparation and submission time', () => {
  assert.equal(stemBudgetMs(100, 0), 78000)
  assert.equal(stemBudgetMs(200, 0), 90000)
  assert.equal(stemBudgetMs(22, 0), 0)
})

test('stem tickets reject old arrangement policies and stale worker runs', () => {
  const selection = { ok: true, selectionId: 9 }
  const result = {
    runId: 'current-run',
    stemMaterials: {
      selectionId: 9,
      version: 2,
      modelVersion: STEM_MODEL_VERSION,
      arrangementVersion: 'twilight-stem-arrangement-1'
    }
  }
  assert.equal(stemResultMatchesRun(result, selection, 'current-run'), true)
  assert.equal(stemResultMatchesRun(result, selection, 'previous-run'), false)
  assert.equal(
    stemResultMatchesRun(result, { ...selection, selectionId: 10 }, 'current-run'),
    false
  )
  for (const arrangementVersion of [undefined, 'fixed-duck-v2', 'twilight-stem-arrangement-2'])
    assert.equal(
      stemResultMatchesRun(
        { ...result, stemMaterials: { ...result.stemMaterials, arrangementVersion } },
        selection,
        'current-run'
      ),
      false
    )
  assert.equal(
    stemResultMatchesRun(
      { ...result, stemMaterials: { ...result.stemMaterials, version: 1 } },
      selection,
      'current-run'
    ),
    false
  )
  assert.equal(
    stemResultMatchesRun(
      { ...result, stemMaterials: { ...result.stemMaterials, modelVersion: 'different-model' } },
      selection,
      'current-run'
    ),
    false
  )
})
