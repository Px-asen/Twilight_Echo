import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  symlink,
  writeFile
} from 'node:fs/promises'
import { join, resolve, toNamespacedPath } from 'node:path'
import { tmpdir } from 'node:os'
import { backupServerProfile, restoreServerProfile } from './maintenance.ts'
import { initializeServerProfile, lockServerProfile } from './profile.ts'
import { createProfileCipher } from './profileCredentials.ts'

async function fixture(t: test.TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'twilight-maintenance-'))
  t.after(async () => {
    assert.equal(resolve(temporary, '..'), resolve(tmpdir()))
    await rm(temporary, { recursive: true, force: true })
  })
  const root = join(temporary, 'source'),
    snapshot = join(temporary, 'snapshot'),
    restored = join(temporary, 'restored')
  await initializeServerProfile(root, [])
  const database = new DatabaseSync(join(root, 'music-library.sqlite'))
  database.exec(
    "CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('queue and metadata')"
  )
  database.close()
  await mkdir(join(root, 'dsp-assets'))
  await writeFile(join(root, 'dsp-assets', '脉冲.bin'), Buffer.from([0, 1, 128, 255]))
  await writeFile(join(root, 'remote-tls.json'), 'private test identity')
  await writeFile(join(root, 'server-run.json'), 'obsolete per-run token')
  return { temporary, root, snapshot, restored }
}

test('offline snapshot retains SQLite, TLS identity and owned DSP files, but not locks or per-run tokens', async (t) => {
  const f = await fixture(t)
  const scope = Buffer.from('backup-plugin-scope')
  const credential = await createProfileCipher(f.root).protect(Buffer.from('backup-fixture-value'), scope)
  const manifest = await backupServerProfile(f.root, f.snapshot, '1.4.0')
  assert.ok(manifest.files.some((file) => file.path === 'dsp-assets/脉冲.bin'))
  assert.ok(!manifest.files.some((file) => ['server.lock', 'server-run.json'].includes(file.path)))
  await assert.rejects(access(join(f.root, 'server.lock')), { code: 'ENOENT' })
  await restoreServerProfile(f.snapshot, f.restored, '1.4.0')
  assert.equal((await createProfileCipher(f.restored).unprotect(credential, scope)).toString(), 'backup-fixture-value')
  assert.equal(await readFile(join(f.restored, 'remote-tls.json'), 'utf8'), 'private test identity')
  assert.deepEqual(
    await readFile(join(f.restored, 'dsp-assets', '脉冲.bin')),
    Buffer.from([0, 1, 128, 255])
  )
  assert.equal(
    await readFile(join(f.restored, 'server.json'), 'utf8'),
    await readFile(join(f.root, 'server.json'), 'utf8')
  )
  const database = new DatabaseSync(join(f.restored, 'music-library.sqlite'), { readOnly: true })
  assert.equal(database.prepare('SELECT value FROM evidence').get()!.value, 'queue and metadata')
  database.close()
  assert.equal(await readFile(join(f.root, 'server-run.json'), 'utf8'), 'obsolete per-run token')
})

test('a running or stale-locked profile cannot be backed up, and existing or nested targets are never replaced', async (t) => {
  const f = await fixture(t),
    unlock = await lockServerProfile(f.root)
  await assert.rejects(backupServerProfile(f.root, f.snapshot, '1.4.0'), { code: 'EEXIST' })
  await unlock()
  await assert.rejects(backupServerProfile(f.root, join(f.root, 'nested'), '1.4.0'), /不能位于源/)
  await backupServerProfile(f.root, f.snapshot, '1.4.0')
  await assert.rejects(backupServerProfile(f.root, f.snapshot, '1.4.0'), /已存在/)
  await mkdir(f.restored)
  await writeFile(join(f.restored, 'keep'), 'existing data')
  await assert.rejects(restoreServerProfile(f.snapshot, f.restored, '1.4.0'), /已存在/)
  assert.equal(await readFile(join(f.restored, 'keep'), 'utf8'), 'existing data')
})

test('incomplete, missing-file and wrong-version snapshots cannot produce a restored profile', async (t) => {
  const f = await fixture(t)
  await mkdir(f.snapshot)
  await assert.rejects(restoreServerProfile(f.snapshot, f.restored, '1.4.0'), { code: 'ENOENT' })
  await rmdir(f.snapshot)
  await backupServerProfile(f.root, f.snapshot, '1.4.0')
  await assert.rejects(restoreServerProfile(f.snapshot, f.restored, '1.5.0'), /原版本程序/)
  await rm(join(f.snapshot, 'data', 'remote-tls.json'))
  await assert.rejects(restoreServerProfile(f.snapshot, f.restored, '1.4.0'), /清单／大小不一致/)
  await assert.rejects(access(f.restored), { code: 'ENOENT' })
})

test('SQLite corruption of the same file size is rejected before publishing; source and snapshot remain available', async (t) => {
  const f = await fixture(t)
  await backupServerProfile(f.root, f.snapshot, '1.4.0')
  const path = join(f.snapshot, 'data', 'music-library.sqlite'),
    bytes = await readFile(path)
  bytes.fill(0)
  await writeFile(path, bytes)
  await assert.rejects(restoreServerProfile(f.snapshot, f.restored, '1.4.0'), /database|SQLite/)
  await assert.rejects(access(f.restored), { code: 'ENOENT' })
  assert.deepEqual((await readdir(f.temporary)).sort(), ['snapshot', 'source'])
  const source = new DatabaseSync(join(f.root, 'music-library.sqlite'), { readOnly: true })
  assert.equal(source.prepare('SELECT count(*) AS n FROM evidence').get()!.n, 1)
  source.close()
})

test('a linked resource is not traversed or copied and a failed backup releases its profile lock', async (t) => {
  const f = await fixture(t),
    outside = join(f.temporary, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep'), 'not owned by the profile')
  await symlink(outside, join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(backupServerProfile(f.root, f.snapshot, '1.4.0'), /包含链接/)
  await assert.rejects(access(join(f.root, 'server.lock')), { code: 'ENOENT' })
  await assert.rejects(access(f.snapshot), { code: 'ENOENT' })
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'not owned by the profile')
})

test(
  'Windows snapshot staging validates SQLite beyond MAX_PATH before publishing a normal-length restored profile',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = await fixture(t)
    await backupServerProfile(f.root, f.snapshot, '1.4.0')
    const parent = join(f.temporary, 'a'.repeat(90), 'b'.repeat(70))
    await mkdir(parent, { recursive: true })
    const restored = join(parent, 'restored')
    assert.ok(
      join(restored + '.partial-00000000-0000-0000-0000-000000000000', 'music-library.sqlite')
        .length > 260
    )
    await restoreServerProfile(f.snapshot, restored, '1.4.0')
    const db = new DatabaseSync(toNamespacedPath(join(restored, 'music-library.sqlite')), {
      readOnly: true
    })
    try {
      assert.equal(db.prepare('SELECT value FROM evidence').get()!.value, 'queue and metadata')
    } finally {
      db.close()
    }
  }
)
