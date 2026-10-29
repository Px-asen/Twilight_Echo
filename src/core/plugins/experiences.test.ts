import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TwilightPluginDescriptor } from '../../shared/pluginTypes.ts'
import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import { CorePluginExperiences } from './experiences.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'twilight-core-experiences-'))
  const versionRoot = join(root, 'package')
  await mkdir(join(versionRoot, 'ui'), { recursive: true })
  await writeFile(join(versionRoot, 'ui', 'index.html'), '<main>Experience</main>')
  await writeFile(join(versionRoot, 'theme.css'), ':root{--color:blue}')
  const plugin: TwilightPluginDescriptor = {
    id: 'com.example.experience',
    name: 'Experience',
    version: '1.0.0',
    description: '',
    author: 'Example',
    license: 'MIT',
    type: ['ui'],
    engines: { twilightEcho: '*' },
    apiVersion: 4,
    permissions: ['ui:inject', 'settings', 'library:write'],
    contributes: {
      experiences: [{ id: 'library', name: 'Library', entry: 'ui/index.html', bridgeVersion: 2 }]
    },
    status: 'enabled',
    enabled: true,
    builtIn: false,
    error: null,
    isDsp: false,
    source: 'tep',
    installedAt: null,
    updatedAt: null,
    paths: {
      root,
      versionRoot,
      manifestPath: join(versionRoot, 'plugin.json'),
      dataDir: join(root, 'data'),
      logPath: join(root, 'plugin.log')
    }
  }
  const queries: unknown[] = []
  const database: Pick<LibraryDatabaseApi, 'queryCollections' | 'queryTracks'> = {
    async queryCollections(_kind, query) {
      queries.push(query)
      return {
        revision: 17,
        total: 1,
        offset: 0,
        letterOffsets: {},
        items: [
          {
            id: 'release-one',
            name: 'Album',
            artist: 'Artist',
            releaseDate: '2001',
            trackCount: 1,
            duration: 120,
            cover: null
          }
        ]
      }
    },
    async queryTracks(query) {
      queries.push(query)
      assert.equal(query?.contentRevision, 17)
      return {
        revision: 17,
        total: 1,
        offset: 0,
        versions: {},
        tracks: [
          {
            id: 'track-one',
            filePath: 'C:/music/one.flac',
            title: 'One',
            artist: 'Artist',
            album: 'Album',
            duration: 120,
            size: 0
          }
        ]
      }
    }
  }
  const manager = {
    list: async () => [plugin],
    listExtensions: async () => [
      {
        pluginId: plugin.id,
        ui: [],
        themes: [{ id: 'theme', name: 'Theme', stylesheet: join(versionRoot, 'theme.css') }]
      }
    ]
  }
  const create = () =>
    new CorePluginExperiences(
      manager,
      database,
      () => false,
      async () => ({ saved: true })
    )
  return {
    root,
    plugin,
    queries,
    create,
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

test('Core authorizes only enabled experience package resources and registered theme stylesheets', async () => {
  const f = await fixture()
  try {
    const service = f.create()
    assert.equal((await service.list())[0].url, `plugin-ui://${f.plugin.id}/1.0.0/ui/index.html`)
    assert.deepEqual(await service.resource(`plugin-ui://${f.plugin.id}/1.0.0/ui/index.html`), {
      path: join(f.plugin.paths.versionRoot, 'ui', 'index.html')
    })
    assert.equal(await service.resource(`plugin-ui://${f.plugin.id}/1.0.0/theme.css`), null)
    assert.equal(await service.resource(`plugin-ui://${f.plugin.id}/0.9.0/ui/index.html`), null)
    assert.equal(await service.stylesheet(f.plugin.id, 'theme'), ':root{--color:blue}')
    f.plugin.enabled = false
    assert.deepEqual(await service.list(), [])
    assert.equal(await service.resource(`plugin-ui://${f.plugin.id}/1.0.0/ui/index.html`), null)
  } finally {
    await f.cleanup()
  }
})

test('Core lists sidebar metadata through the same enabled-package boundary as full experiences', async () => {
  const f = await fixture()
  try {
    f.plugin.contributes = {
      experiences: [
        {
          id: 'battery',
          name: 'Battery',
          entry: 'ui/index.html',
          bridgeVersion: 2,
          launch: 'sidebar',
          sidebar: { height: 128 }
        }
      ]
    }
    const service = f.create()
    const [widget] = await service.list()
    assert.equal(widget.launch, 'sidebar')
    assert.deepEqual(widget.sidebar, { height: 128 })
    assert.deepEqual(await service.resource(widget.url), {
      path: join(f.plugin.paths.versionRoot, 'ui', 'index.html')
    })
    f.plugin.enabled = false
    assert.deepEqual(await service.list(), [])
    assert.equal(await service.resource(widget.url), null)
  } finally {
    await f.cleanup()
  }
})

test('Core owns versioned documents and preferences across renderer-independent service reconstruction', async () => {
  const f = await fixture()
  try {
    const service = f.create()
    await service.preferences(f.plugin.id, { view: 'albums' })
    assert.deepEqual(await service.document(f.plugin.id), { revision: 0, value: {} })
    await service.document(f.plugin.id, { revision: 0, value: { config: { onlineEnabled: true } } })
    await assert.rejects(
      () => service.document(f.plugin.id, { revision: 0, value: {} }),
      /资料已发生变化/
    )
    await service.shutdown()
    const next = f.create()
    assert.deepEqual(await next.preferences(f.plugin.id), { view: 'albums' })
    assert.deepEqual(await next.document(f.plugin.id), {
      revision: 1,
      value: { config: { onlineEnabled: true } }
    })
  } finally {
    await f.cleanup()
  }
})

test('metadata tasks resolve authoritative library albums inside Core and retain the established release identity', async () => {
  const f = await fixture()
  try {
    const service = f.create()
    const task = await service.music(f.plugin.id, 'task', { scope: 'all' })
    assert.ok(task && 'albums' in task && Array.isArray(task.albums))
    assert.equal(task.albums.length, 1)
    assert.equal(
      task.albums[0].id,
      'album-8d5a8e89edfedc628007f0e0ebc357c4596fbc3c16118b04ee71179ff981574a'
    )
    assert.equal(task.albums[0].title, 'Album')
    assert.equal(task.albums[0].trackCount, 1)
    assert.equal(f.queries.length, 2)
    await service.flush()
    const data = JSON.parse(
      await readFile(join(f.plugin.paths.dataDir, 'music-metadata.json'), 'utf8')
    )
    assert.equal(Object.keys(data.value.proofs).length, 1)
    await service.shutdown()
  } finally {
    await f.cleanup()
  }
})
