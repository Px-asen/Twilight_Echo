import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { LibraryLoudnessCache, loudnessDigest } from './libraryLoudnessCache.ts'

test('loudness sidecars atomically retain complete groups, invalidate old algorithms and clear backups', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'loudness-cache-'))
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  })
  const cache = new LibraryLoudnessCache(directory)
  const track = {
    source: 'analyzed' as const,
    available: true,
    algorithmVersion: 2,
    integratedLufs: -20,
    truePeakDb: -6,
    analyzedAt: '2026-09-14T00:00:00Z'
  }
  const measurement = { tracks: [track], album: track }
  const id = 'album:../../outside'
  const fingerprint = loudnessDigest('size-mtime-membership')
  cache.set(id, fingerprint, measurement)
  assert.deepEqual(new LibraryLoudnessCache(directory).get(id, fingerprint), measurement)
  assert.equal(cache.get(id, loudnessDigest('source-changed')), null)
  const files = await readdir(directory)
  assert.ok(files.every((name) => /^[a-f0-9]{64}\.json(?:\.bak)?$/.test(name)))
  const path = join(directory, `${loudnessDigest(id)}.json`)
  await writeFile(path, '{broken')
  assert.deepEqual(cache.get(id, fingerprint), measurement)
  const old = JSON.parse(await readFile(path, 'utf8'))
  old.measurement.tracks[0].algorithmVersion = 1
  await writeFile(path, JSON.stringify(old))
  assert.equal(cache.get(id, fingerprint), null)
  cache.clear([id])
  assert.deepEqual(await readdir(directory), [])
  assert.equal(cache.get(id, fingerprint), null)
  assert.throws(
    () => cache.set(id, fingerprint, { tracks: [{ ...track, available: false }], album: null }),
    /原始响度/
  )
})
