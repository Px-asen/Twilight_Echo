import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { migratePersonalBackup, personalDatabase } from './migration.ts'
import { personalBackupFixture } from '../../core/persistence/personalBackup.fixture.ts'
import { createPersonalBackupRepository } from '../../core/persistence/personalBackup.ts'
import { LibraryDatabase } from '../library/libraryDatabase.ts'
import { CoreStateDatabase } from '../library/coreStateDatabase.ts'
import type { LocalMusicLibraryDocument } from '../../shared/localLibrary.ts'
import type { PersonalBackup, PersonalRestoreOptions } from '../../shared/personalBackup.ts'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-server-migration-'))
  t.after(async () => {
    assert.equal(resolve(root, '..'), resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  })
  const music = join(root, '音乐'),
    file = join(root, 'personal.json'),
    destination = join(root, 'server')
  await mkdir(music)
  const backup = personalBackupFixture()
  await writeFile(file, JSON.stringify(backup))
  const options: PersonalRestoreOptions = {
    conflict: 'use-backup',
    mappings: [{ from: 'C:/Old', to: music }],
    domains: Object.keys(backup.data) as PersonalRestoreOptions['domains']
  }
  return { root, music, file, destination, backup, options }
}

test('desktop v1 migration previews without a destination, then restores every domain into a disconnected Server', async (t) => {
  const f = await fixture(t),
    original = await readFile(f.file, 'utf8')
  const input = {
    file: f.file,
    destination: f.destination,
    libraryRoots: [f.music],
    restoreOptions: f.options
  }
  const preview = await migratePersonalBackup(input)
  assert.equal(preview.applied, false)
  assert.equal(preview.preview.rows.length, 10)
  assert.equal(preview.mappedRoots[0], f.music)
  await assert.rejects(access(f.destination), { code: 'ENOENT' })
  await migratePersonalBackup({ ...input, apply: true })
  const database = new LibraryDatabase(join(f.destination, 'music-library.sqlite'))
  const state = new CoreStateDatabase(join(f.destination, 'core-state.sqlite'))
  try {
    const document = database.exportDocument()
    const track = document.tracks[0] as { id: string; filePath: string }
    assert.equal(track.id, 'song')
    assert.equal(track.filePath, join(f.music, 'song.flac').replaceAll('\\', '/'))
    const data = createPersonalBackupRepository().readPersonalData(f.destination, {
      library: document,
      playlists: database.preferencesPlaylistsLoad()?.data
    })
    for (const domain of [
      'playlists',
      'queue',
      'playback',
      'lyrics',
      'bookmarks',
      'radio',
      'podcasts'
    ])
      assert.ok(domain in data, domain)
    assert.equal((data.playback as { position: number }).position, 12)
    assert.equal(
      (data.lyrics as { tracks: Record<string, { offsetMs: number }> }).tracks.song.offsetMs,
      300
    )
    assert.equal(state.read('statistics-tracks').rows[0].key, 'song')
    assert.equal((state.read('statistics-tracks').rows[0].value as { seconds: number }).seconds, 20)
    assert.equal(state.read('versions').rows.length, 1)
    assert.equal(state.status().complete, true)
    assert.deepEqual(
      JSON.parse(await readFile(join(f.destination, 'bridge-output-selection.json'), 'utf8')),
      { version: 1, selected: true }
    )
    assert.equal(await readFile(f.file, 'utf8'), original)
    await assert.rejects(access(join(f.destination, 'server.lock')), { code: 'ENOENT' })
    await assert.rejects(access(join(f.destination, 'remote-tls.json')), { code: 'ENOENT' })
  } finally {
    state.close()
    database.close()
  }
})

test('desktop v2 export preserves favorite, rating, tag, Focus and playlist through mapped Server migration', async (t) => {
  const f = await fixture(t),
    source = join(f.root, 'desktop-export-source')
  await mkdir(source)
  const database = new LibraryDatabase(join(source, 'music-library.sqlite'))
  let backup: PersonalBackup
  try {
    database.replaceDocument(f.backup.data.library as LocalMusicLibraryDocument)
    while (database.catalogStatus().localPending) database.catalogAdvance()
    const recording = String(
      database.sql.prepare("SELECT id FROM catalog_entities WHERE kind='recording'").get()!.id
    )
    database.ratingsSet(
      { entityId: recording, token: database.ratingsDetail(recording).token, steps: 8 },
      10
    )
    database.preferencesSet(
      {
        entityId: recording,
        token: database.preferencesDetail(recording).token,
        state: 'favorite'
      },
      10
    )
    database.sql
      .prepare("INSERT INTO personal_tags VALUES('default','tag-one','Evening','evening',1,1,10)")
      .run()
    database.sql
      .prepare("INSERT INTO personal_tag_members VALUES('default','tag-one',?)")
      .run(recording)
    database.sql
      .prepare(
        "INSERT INTO personal_focus_queries VALUES('default','focus-one','Quiet','quiet',?,1,1,10)"
      )
      .run(JSON.stringify({ version: 1, entity: 'recording', where: { tag: { id: 'tag-one' } } }))
    database.preferencesPlaylistsRestore(
      [
        {
          id: 'custom-one',
          name: '夜晚',
          trackIds: ['song'],
          createdAt: '2026-11-03T00:00:00.000Z'
        }
      ],
      'source-playlists',
      0,
      10
    )
    backup = await createPersonalBackupRepository().createPersonalBackupFromDatabase(
      source,
      { statistics: f.backup.data.statistics, versions: f.backup.data.versions },
      personalDatabase(database)
    )
  } finally {
    database.close()
  }
  assert.equal(backup.version, 2)
  await writeFile(f.file, JSON.stringify(backup))
  const restoreOptions = {
    ...f.options,
    domains: Object.keys(backup.data) as PersonalRestoreOptions['domains']
  }
  const report = await migratePersonalBackup({
    file: f.file,
    destination: f.destination,
    libraryRoots: [f.music],
    restoreOptions,
    apply: true
  })
  assert.equal(report.sourceVersion, 2)
  const restored = new LibraryDatabase(join(f.destination, 'music-library.sqlite'))
  try {
    const recording = String(
      restored.sql.prepare("SELECT id FROM catalog_entities WHERE kind='recording'").get()!.id
    )
    assert.equal(restored.ratingsDetail(recording).value?.steps, 8)
    assert.equal(restored.preferencesDetail(recording).value?.state, 'favorite')
    assert.equal(restored.sql.prepare('SELECT name FROM personal_tags').get()!.name, 'Evening')
    assert.equal(
      restored.sql
        .prepare('SELECT count(*) AS n FROM personal_tag_members WHERE entity_id=?')
        .get(recording)!.n,
      1
    )
    assert.equal(
      restored.sql.prepare('SELECT name FROM personal_focus_queries').get()!.name,
      'Quiet'
    )
    assert.ok(
      restored
        .preferencesPlaylistsLoad()!
        .data.some((playlist) => playlist.id === 'custom-one' && playlist.trackIds.includes('song'))
    )
    assert.equal(
      (restored.exportDocument().tracks[0] as { filePath: string }).filePath,
      join(f.music, 'song.flac').replaceAll('\\', '/')
    )
  } finally {
    restored.close()
  }
})

test('migration requires explicit root grants, refuses an existing profile and leaves source exports untouched on failure', async (t) => {
  const f = await fixture(t),
    original = await readFile(f.file, 'utf8')
  await assert.rejects(
    migratePersonalBackup({
      file: f.file,
      destination: f.destination,
      libraryRoots: [],
      restoreOptions: f.options,
      apply: true
    }),
    /明确授权/
  )
  await assert.rejects(access(f.destination), { code: 'ENOENT' })
  await mkdir(f.destination)
  await writeFile(join(f.destination, 'keep'), 'existing user data')
  await assert.rejects(
    migratePersonalBackup({
      file: f.file,
      destination: f.destination,
      libraryRoots: [f.music],
      restoreOptions: f.options,
      apply: true
    }),
    { code: 'EEXIST' }
  )
  assert.equal(await readFile(join(f.destination, 'keep'), 'utf8'), 'existing user data')
  const options = {
    ...f.options,
    domains: ['library', 'versions'] as PersonalRestoreOptions['domains']
  }
  const invalid = structuredClone(f.backup)
  invalid.data.versions = { version: 999 }
  await writeFile(f.file, JSON.stringify(invalid))
  await assert.rejects(
    migratePersonalBackup({
      file: f.file,
      destination: join(f.root, 'failed'),
      libraryRoots: [f.music],
      restoreOptions: options,
      apply: true
    }),
    /格式/
  )
  assert.deepEqual(await readdir(f.destination), ['keep'])
  await writeFile(f.file, original)
})

test('a restore failure after reserving the new profile removes only that incomplete target', async (t) => {
  const f = await fixture(t)
  const original = await readFile(f.file, 'utf8')
  await assert.rejects(
    migratePersonalBackup({
      file: f.file,
      destination: f.destination,
      libraryRoots: [f.music],
      restoreOptions: f.options,
      apply: true,
      additional: async (root) => {
        assert.equal(root, f.destination)
        await access(join(root, 'music-library.sqlite'))
        throw new Error('扩展恢复失败')
      }
    }),
    /扩展恢复失败/
  )
  await assert.rejects(access(f.destination), { code: 'ENOENT' })
  assert.equal(await readFile(f.file, 'utf8'), original)
  assert.deepEqual((await readdir(f.root)).sort(), ['personal.json', '音乐'])
})
