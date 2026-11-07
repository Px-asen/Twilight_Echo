import test from 'node:test'
import assert from 'node:assert/strict'
import { access, cp, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { desktopMigrationFixture, addOnlineMigrationFixture } from './desktopMigration.fixture.ts'
import { exportDesktopMigration, migrateDesktopBundle } from './desktopMigration.ts'
import { LibraryDatabase } from '../library/libraryDatabase.ts'
import { createPlaybackSessionStoreBundle } from '../persistence/playbackSessionRepository.ts'
import { createCorePlaybackRepository } from '../persistence/corePlaybackRepository.ts'
import { createPersonalBackupRepository } from '../../core/persistence/personalBackup.ts'
import { zoneCatalog } from '../coreProcess/zoneRuntime.ts'
import { syncGroupCatalog } from '../coreProcess/syncGroupRuntime.ts'
import { DspAssetLibrary } from '../../core/audio/dspAssetLibrary.ts'
import { lockServerProfile } from './profile.ts'
import { isQueueWorkspaceDocument } from '../../shared/queueWorkspace.ts'
import { SERVER_SETTINGS_FIELDS } from './configuration.ts'

async function files(root: string, prefix = ''): Promise<Array<[string, Buffer]>> {
  const result: Array<[string, Buffer]> = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...(await files(root, path)))
    else result.push([path, await readFile(join(root, path))])
  }
  return result.sort(([a], [b]) => a.localeCompare(b))
}
async function fixture(t: test.TestContext, withAutoMix = false) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-desktop-bundle-'))
  t.after(async () => {
    assert.equal(resolve(root, '..'), resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  })
  const source = await desktopMigrationFixture(root, withAutoMix ? ['natural', 'dj'] : undefined)
  return { root, ...source, bundle: join(root, 'bundle'), destination: join(root, 'server') }
}

test('offline bundle previews and migrates six SQL sessions, shuffled/original orders, named queue and member DSP without touching desktop data', async (t) => {
  const f = await fixture(t),
    before = await files(f.source)
  const manifest = await exportDesktopMigration({
    source: f.source,
    destination: f.bundle,
    stopped: true
  })
  assert.deepEqual(await files(f.source), before)
  const portable = createPersonalBackupRepository().readBackupFile(join(f.bundle, 'personal.json'))
  assert.ok(isQueueWorkspaceDocument(portable.data.queue))
  const named = portable.data.queue.sessions[0]
  assert.equal(named.libraryQueue, undefined)
  assert.equal(named.entries.length, 3)
  assert.equal(named.currentEntryId, f.sessions[0].data.track.queueEntryId)
  assert.deepEqual(named.originalEntryIds, f.sessions[0].originalEntryIds)
  assert.equal(named.position, 17)
  assert.equal(JSON.stringify(portable).includes('core-session-'), false)
  const inventory = (await files(f.bundle)).map(([path]) => path)
  assert.ok(!inventory.some((path) => /remote-tls|plugin-secrets|sqlite|server\.json/.test(path)))
  assert.deepEqual(
    Object.keys(
      JSON.parse(await readFile(join(f.bundle, manifest.primary.settings), 'utf8'))
    ).sort(),
    [...SERVER_SETTINGS_FIELDS].sort()
  )
  assert.deepEqual(
    manifest.groups.map(({ id, name, members, autoMixMode }) => ({ id, name, members, autoMixMode })),
    f.groups.map(group => ({ ...group, autoMixMode: group.autoMixMode ?? 'off' }))
  )
  const options = { file: f.bundle, destination: f.destination, libraryRoots: [f.music] }
  const preview = await migrateDesktopBundle(options)
  assert.equal(preview.applied, false)
  await assert.rejects(access(f.destination), { code: 'ENOENT' })
  await migrateDesktopBundle({ ...options, apply: true })
  assert.deepEqual(await zoneCatalog(f.destination).load(), f.zones)
  assert.deepEqual(await syncGroupCatalog(f.destination).load(), f.groups.map(group => ({ ...group, autoMixMode: group.autoMixMode ?? 'off' })))
  const db = new LibraryDatabase(join(f.destination, 'music-library.sqlite'))
  try {
    const queueIds = new Set<string>()
    for (const [index, original] of f.sessions.entries()) {
      const id = original.id,
        scope = id === 'local' ? undefined : id
      const directory =
        id === 'local'
          ? f.destination
          : join(f.destination, id.startsWith('zone-') ? 'zones' : 'groups', id)
      const repository = createCorePlaybackRepository(
        createPlaybackSessionStoreBundle(directory),
        {
          syncLibraryQueueReferences: async (...args) => db.syncLibraryQueueReferences(...args)
        },
        scope
          ? `${id.startsWith('group-') ? 'group' : 'zone'}:${id}:persisted`
          : 'core:persisted-playback',
        scope
      )
      const saved = await repository.load()
      assert.ok(saved?.data?.libraryQueue)
      const data = saved.data,
        reference = data.libraryQueue!
      queueIds.add(reference.id)
      assert.equal(data.position, 10 + index)
      assert.equal(data.track.queueEntryId, original.data.track.queueEntryId)
      assert.equal(data.queue, undefined)
      const exported = db.exportPlaybackQueue(reference, 32 * 1024 * 1024, true)
      assert.deepEqual(
        exported.queue.map((track) => track.queueEntryId),
        original.data.queue!.map((track) => track.queueEntryId)
      )
      assert.deepEqual(exported.originalQueueEntryIds, original.originalEntryIds)
      assert.equal(exported.queueIndex, 2)
      if (index < 4) {
        const settings = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
        assert.equal(settings.softwareVolume, 0.2 + index * 0.1)
        assert.equal(settings.dspScenes[0].name, `${id} room`)
        assert.equal(settings.dspPinnedSceneId, 'room')
        assert.equal(settings.remoteControlEnabled, false)
        const assets = new DspAssetLibrary(join(directory, 'dsp-assets'), {
          now: Date.now,
          newId: randomUUID
        })
        assert.deepEqual(
          await readFile(await assets.getPath(f.configuration.asset.id)),
          f.configuration.impulse
        )
      }
    }
    assert.equal(queueIds.size, 6)
    db.sql.exec('UPDATE queues SET created_at=0')
    db.collectLibraryQueueGarbage(1)
    assert.ok([...queueIds].every((id) => db.getLibraryQueue(id).total === 3))
  } finally {
    db.close()
  }
  assert.deepEqual(await files(f.source), before)
})

test('bundle preview and apply retain distinct group AutoMix modes without changing member preferences', async t => {
  const f = await fixture(t, true), before = await files(f.source)
  const manifest = await exportDesktopMigration({ source: f.source, destination: f.bundle, stopped: true })
  assert.deepEqual(manifest.groups.map(g => g.autoMixMode), ['natural', 'dj'])
  const options = { file: f.bundle, destination: f.destination, libraryRoots: [f.music] }
  const preview = await migrateDesktopBundle(options)
  assert.deepEqual((preview.additional as { groups: { autoMixMode: string }[] }).groups.map(g => g.autoMixMode), ['natural', 'dj'])
  await assert.rejects(access(f.destination), { code: 'ENOENT' })
  const applied = await migrateDesktopBundle({ ...options, apply: true })
  assert.deepEqual((applied.additional as { groups: { autoMixMode: string }[] }).groups.map(g => g.autoMixMode), ['natural', 'dj'])
  assert.deepEqual(await syncGroupCatalog(f.destination).load(), f.groups)
  for (const id of ['local', ...f.zones.map(z => z.id)]) {
    const at = (root: string) => id === 'local' ? root : join(root, 'zones', id)
    const original = JSON.parse(await readFile(join(at(f.source), 'settings.json'), 'utf8'))
    const restored = JSON.parse(await readFile(join(at(f.destination), 'settings.json'), 'utf8'))
    for (const key of ['autoMixMode', 'autoMixStemMode', 'autoMixStemDevice', 'autoMixStemCacheMiB'])
      assert.equal(restored[key], original[key], `${id}: ${key}`)
    assert.equal(restored.autoMixMode, id === 'local' ? 'dj' : original.autoMixMode)
  }
  assert.deepEqual(await files(f.source), before)
})

test('bundle maps all current and named local paths together and honors playback-domain exclusion', async (t) => {
  const f = await fixture(t)
  await exportDesktopMigration({ source: f.source, destination: f.bundle, stopped: true })
  const relocated = join(f.root, 'new-music')
  await cp(f.music, relocated, { recursive: true })
  const options = {
    file: f.bundle,
    destination: f.destination,
    libraryRoots: [relocated],
    apply: true,
    restoreOptions: {
      conflict: 'use-backup' as const,
      domains: ['library', 'queue', 'playback'] as const,
      mappings: [{ from: f.music, to: relocated }]
    }
  }
  await migrateDesktopBundle({
    ...options,
    restoreOptions: { ...options.restoreOptions, domains: [...options.restoreOptions.domains] }
  })
  const db = new LibraryDatabase(join(f.destination, 'music-library.sqlite'))
  try {
    for (const original of f.sessions) {
      const directory =
        original.id === 'local'
          ? f.destination
          : join(f.destination, original.id.startsWith('zone-') ? 'zones' : 'groups', original.id)
      const saved = await createPlaybackSessionStoreBundle(directory).storage.load()
      assert.ok(saved?.data?.libraryQueue)
      const queue = db.exportPlaybackQueue(saved.data.libraryQueue, 32 * 1024 * 1024)
      assert.ok(
        queue.queue.every((track) =>
          String(track.filePath).startsWith(relocated.replaceAll('\\', '/'))
        )
      )
    }
    const workspace = createPersonalBackupRepository().readPersonalData(
      f.destination,
      { library: null },
      ['queue']
    ).queue
    assert.ok(isQueueWorkspaceDocument(workspace))
    assert.ok(
      workspace.sessions[0].entries.every((track) =>
        track.filePath!.startsWith(relocated.replaceAll('\\', '/'))
      )
    )
  } finally {
    db.close()
  }
  const excluded = join(f.root, 'without-playback')
  await migrateDesktopBundle({
    ...options,
    destination: excluded,
    restoreOptions: { ...options.restoreOptions, domains: ['library', 'queue'] }
  })
  for (const original of f.sessions) {
    const directory =
      original.id === 'local'
        ? excluded
        : join(excluded, original.id.startsWith('zone-') ? 'zones' : 'groups', original.id)
    assert.equal(
      (await createPlaybackSessionStoreBundle(directory).storage.load())?.data ?? null,
      null
    )
  }
})

test('external raw IRs require an explicit export grant and become portable managed assets for each member', async (t) => {
  const f = await fixture(t)
  const settings = structuredClone(f.configuration.settings)
  settings.audioProcessing.convolverIrPath = f.configuration.impulseFile
  delete settings.dspScenes[0].graph.nodes[0].params.impulseResponseAssetId
  settings.dspScenes[0].graph.nodes[0].params.impulseResponsePath = f.configuration.impulseFile
  await writeFile(join(f.source, 'settings.json'), JSON.stringify(settings))
  const assets = new DspAssetLibrary(join(f.source, 'zones', f.zones[0].id, 'dsp-assets'), {
    now: Date.now,
    newId: randomUUID
  })
  const member = structuredClone(settings)
  member.audioProcessing.convolverIrPath = await assets.getPath(f.configuration.asset.id)
  member.dspScenes[0].graph.nodes[0].params.impulseResponsePath =
    member.audioProcessing.convolverIrPath
  await writeFile(join(f.source, 'zones', f.zones[0].id, 'settings.json'), JSON.stringify(member))
  const before = await files(f.source)
  const input = { source: f.source, destination: f.bundle, stopped: true }
  await assert.rejects(exportDesktopMigration(input), /--asset-root/)
  await assert.rejects(access(f.bundle), { code: 'ENOENT' })
  await exportDesktopMigration({ ...input, assetRoots: [join(f.root, 'configuration')] })
  await migrateDesktopBundle({
    file: f.bundle,
    destination: f.destination,
    libraryRoots: [f.music],
    apply: true
  })
  for (const directory of [f.destination, join(f.destination, 'zones', f.zones[0].id)]) {
    const restored = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
    assert.ok(restored.audioProcessing.convolverIrPath.startsWith(directory))
    assert.deepEqual(
      await readFile(restored.audioProcessing.convolverIrPath),
      f.configuration.impulse
    )
    assert.equal(
      restored.dspScenes[0].graph.nodes[0].params.impulseResponseAssetId,
      f.configuration.asset.id
    )
    assert.equal(restored.dspScenes[0].graph.nodes[0].params.impulseResponsePath, undefined)
  }
  assert.deepEqual(await files(f.source), before)
})

test('preview rejects a mismatched original-order sidecar before creating any target', async (t) => {
  const f = await fixture(t)
  const manifest = await exportDesktopMigration({
    source: f.source,
    destination: f.bundle,
    stopped: true
  })
  for (const path of [
    manifest.primary.order!,
    manifest.zones[1].order!,
    manifest.groups[1].order!
  ]) {
    const full = join(f.bundle, path),
      before = await readFile(full)
    await writeFile(full, JSON.stringify(['not-an-occurrence', 'duplicate', 'duplicate']))
    await assert.rejects(
      migrateDesktopBundle({ file: f.bundle, destination: f.destination, libraryRoots: [f.music] }),
      /原始队列顺序/
    )
    await assert.rejects(access(f.destination), { code: 'ENOENT' })
    await writeFile(full, before)
  }
})

test('offline export requires explicit stop confirmation and refuses a locked Server, existing destination and missing DSP asset', async (t) => {
  const f = await fixture(t)
  const options = { source: f.source, destination: f.bundle, stopped: true }
  await assert.rejects(exportDesktopMigration({ ...options, stopped: false }), /--stopped/)
  await writeFile(join(f.source, 'server.json'), '{}')
  const unlock = await lockServerProfile(f.source)
  try {
    await assert.rejects(exportDesktopMigration(options), { code: 'EEXIST' })
  } finally {
    await unlock()
  }
  await mkdir(f.bundle)
  await writeFile(join(f.bundle, 'keep'), 'old destination')
  await assert.rejects(exportDesktopMigration(options), /目标已存在/)
  assert.equal(await readFile(join(f.bundle, 'keep'), 'utf8'), 'old destination')
  const assets = new DspAssetLibrary(join(f.source, 'dsp-assets'), {
    now: Date.now,
    newId: randomUUID
  })
  await rm(await assets.getPath(f.configuration.asset.id))
  const before = await files(f.source)
  await assert.rejects(
    exportDesktopMigration({ ...options, destination: join(f.root, 'failed') }),
    /资料文件缺失/
  )
  await assert.rejects(access(join(f.root, 'failed')), { code: 'ENOENT' })
  assert.deepEqual(await files(f.source), before)
})

test('bundle rejects escaped references, invalid topology and existing import target without publishing partial profiles', async (t) => {
  const f = await fixture(t)
  const original = await exportDesktopMigration({
    source: f.source,
    destination: f.bundle,
    stopped: true
  })
  const input = { file: f.bundle, destination: f.destination, libraryRoots: [f.music], apply: true }
  const manifestFile = join(f.bundle, 'migration.json')
  for (const corrupt of [
    { ...original, personal: '../desktop/settings.json' },
    ...['unexpected', null, ['natural']].map(autoMixMode => ({ ...original,
      groups: original.groups.map((group, i) => i ? group : { ...group, autoMixMode }) })),
    {
      ...original,
      groups: original.groups.map((group, i) =>
        i
          ? group
          : {
              ...group,
              members: group.members.map((member) => ({ ...member, downstreamDelayMs: 251 }))
            }
      )
    },
    {
      ...original,
      groups: original.groups.map((group, i) =>
        i
          ? group
          : {
              ...group,
              members: group.members.map((member, j) =>
                j ? member : { ...member, zoneId: 'zone-cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
              )
            }
      )
    }
  ]) {
    await writeFile(manifestFile, JSON.stringify(corrupt))
    await assert.rejects(migrateDesktopBundle(input))
    await assert.rejects(access(f.destination), { code: 'ENOENT' })
  }
  await writeFile(manifestFile, JSON.stringify(original))
  await mkdir(f.destination)
  await writeFile(join(f.destination, 'keep'), 'existing user data')
  await assert.rejects(migrateDesktopBundle(input), { code: 'EEXIST' })
  assert.equal(await readFile(join(f.destination, 'keep'), 'utf8'), 'existing user data')
})

for (const kind of ['heart', 'detached', 'personalized', 'liked'] as const)
  test(`bundle preserves ${kind} continuation without retaining source SQL identities or credentials`, async (t) => {
    const f = await fixture(t),
      online = await addOnlineMigrationFixture(f, kind)
    const before = await files(f.source)
    const manifest = await exportDesktopMigration({
      source: f.source,
      destination: f.bundle,
      stopped: true
    })
    assert.ok(manifest.primary.context)
    const metadata = await readFile(join(f.bundle, manifest.primary.context), 'utf8')
    assert.equal(
      /core-session-|private-token|expired\.example|accessToken|streamUrl/.test(metadata),
      false
    )
    const portable = await readFile(join(f.bundle, 'personal.json'), 'utf8')
    assert.equal(
      /core-session-|private-token|expired\.example|accessToken|streamUrl/.test(portable),
      false
    )
    const input = { file: f.bundle, destination: f.destination, libraryRoots: [f.music] }
    assert.equal((await migrateDesktopBundle(input)).applied, false)
    await migrateDesktopBundle({ ...input, apply: true })
    const db = new LibraryDatabase(join(f.destination, 'music-library.sqlite'))
    try {
      const saved = await createCorePlaybackRepository(
        createPlaybackSessionStoreBundle(f.destination),
        { syncLibraryQueueReferences: async (...args) => db.syncLibraryQueueReferences(...args) }
      ).load()
      assert.ok(saved?.data?.libraryQueue)
      const data = saved.data
      assert.equal(data.position, online.persisted.position)
      assert.equal(data.track.queueEntryId, online.persisted.track.queueEntryId)
      assert.equal(data.playMode, online.persisted.playMode)
      assert.equal(data.libraryQueue!.entryId, online.persisted.libraryQueue!.entryId)
      if (kind === 'personalized') {
        assert.deepEqual(data.personalizedStream, {
          ...online.persisted.personalizedStream,
          queueId: data.libraryQueue!.id
        })
      } else {
        assert.equal(data.heart!.queueId, data.libraryQueue!.id)
        assert.equal(data.heart!.likedPlaylistId, 123)
        assert.equal(data.detachedHeartTrack, kind === 'detached' ? true : undefined)
        if (kind === 'heart') {
          const base = data.heart!.baseQueue!
          assert.notEqual(base.id, data.libraryQueue!.id)
          const exported = db.exportPlaybackQueue(base, 32 * 1024 * 1024, true)
          assert.deepEqual(
            exported.queue.map((track) => track.queueEntryId),
            online.base.queue.map((track) => track.queueEntryId)
          )
          assert.deepEqual(exported.originalQueueEntryIds, online.base.originalQueueEntryIds)
          assert.equal(db.getLibraryQueue(base.id).playMode, 'repeat')
          db.sql.exec('UPDATE queues SET created_at=0')
          db.collectLibraryQueueGarbage(1)
          assert.equal(db.getLibraryQueue(base.id).total, 3)
        }
      }
    } finally {
      db.close()
    }
    assert.deepEqual(await files(f.source), before)
  })

test('preview rejects broken online contexts instead of downgrading them to an ordinary queue', async (t) => {
  const f = await fixture(t)
  await addOnlineMigrationFixture(f, 'heart')
  const manifest = await exportDesktopMigration({
    source: f.source,
    destination: f.bundle,
    stopped: true
  })
  const path = join(f.bundle, manifest.primary.context!),
    original = JSON.parse(await readFile(path, 'utf8'))
  for (const context of [
    { ...original, heart: { ...original.heart, likedPlaylistId: -1 } },
    {
      ...original,
      heart: { ...original.heart, base: { ...original.heart.base, originalEntryIds: [] } }
    },
    { version: 1, heart: { likedPlaylistId: 123 }, detached: {} },
    { version: 1, personalized: { providerId: 'ncm-provider', key: 'unknown' } }
  ]) {
    await writeFile(path, JSON.stringify(context))
    await assert.rejects(
      migrateDesktopBundle({ file: f.bundle, destination: f.destination, libraryRoots: [f.music] }),
      /上下文|原始队列顺序/
    )
    await assert.rejects(access(f.destination), { code: 'ENOENT' })
  }
})
