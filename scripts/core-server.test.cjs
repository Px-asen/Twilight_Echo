'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { once } = require('node:events')
const { createNodeCoreSupervisor } = require('../out/server/nodeSupervisor.cjs')
const { createServerPlatform } = require('../out/server/platform.cjs')

test(
  'standalone Node Core owns real SQLite and isolated services without loading Electron',
  { timeout: 90000 },
  async () => {
    const root = resolve(__dirname, '..')
    const directory = await mkdtemp(join(tmpdir(), 'twilight-core-server-'))
    const children = [],
      alive = new Set()
    let supervisor,
      serial = 0,
      businessMessages = 0
    const env = { ...process.env }
    try {
      const guard = join(directory, 'no-electron.cjs')
      await writeFile(
        guard,
        `const M=require('node:module'),load=M._load;M._load=function(name,...rest){if(name==='electron')throw Error('Standalone server loaded Electron');return load.call(this,name,...rest)}`
      )
      process.env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require "${guard.replaceAll('\\', '/')}"`
      process.env.TWILIGHT_METADATA_ENABLED = '0'
      const music = join(directory, 'music')
      await mkdir(music)
      const library = join(directory, 'music-library.json')
      await writeFile(
        library,
        JSON.stringify({
          version: 2,
          revision: 0,
          folders: [],
          exclusions: [],
          tracks: [
            {
              id: 'one',
              title: 'One',
              artist: 'Artist',
              album: 'Album',
              filePath: join(music, 'one.wav'),
              duration: 1
            },
            {
              id: 'two',
              title: 'Two',
              artist: 'Artist',
              album: 'Album',
              filePath: join(music, 'two.wav'),
              duration: 1
            }
          ]
        })
      )
      supervisor = createNodeCoreSupervisor({
        applicationRoot: root,
        entryDirectory: join(root, 'out/server'),
        configuration: {
          root: directory,
          libraryFilePath: library,
          coverCacheDir: join(directory, 'music-cache/cover-cache'),
          libraryStorage: 'sqlite'
        },
        platform: await createServerPlatform({
          root: directory,
          libraryRoots: [music],
          vst3Roots: []
        }),
        observe(child, service) {
          children.push({ child, service })
          alive.add(child)
          child.once('exit', () => alive.delete(child))
          child.child.stdout.on('data', (data) => process.stdout.write(data))
          child.child.stderr.on('data', (data) => process.stderr.write(data))
          if (service === 'twilight-core')
            child.on('message', (message) => {
              if (message?.kind === 'core:platform') console.log('[server-platform]', message.name)
            })
          if (service !== 'twilight-core')
            child.on('message', (message) => {
              if (message?.kind !== 'supervisor:audio-stopped') businessMessages++
            })
        }
      })
      supervisor.on('failure', (error) => console.error('[server-test]', error))
      const identity = {
        id: 'server-admin:test',
        role: 'server-admin',
        permissions: [
          'playback:read',
          'playback:write',
          'library:read',
          'library:write',
          'settings:read',
          'settings:write',
          'migration:write'
        ]
      }
      supervisor.connect(identity)
      const request = (kind, name, payload = {}, epoch = supervisor.getStatus().epoch) =>
        supervisor.request(identity.id, {
          kind,
          name,
          payload,
          epoch,
          requestId: 'server:' + ++serial
        })
      const initialized = once(supervisor, 'initialized')
      const started = supervisor.start()
      void started.catch(() => {})
      await Promise.race([initialized, started])
      assert.equal((await request('query', 'state.snapshot')).migrationRequired, true)
      const counts = Object.fromEntries(
        [
          'versions',
          'statistics-tracks',
          'statistics-days',
          'inbox',
          'podcast-preferences',
          'eq-preferences'
        ].map((k) => [k, 0])
      )
      await request('command', 'migration.begin', {
        id: 'standalone-new-profile',
        manifest: { version: 1, counts }
      })
      await request('command', 'migration.commit', { id: 'standalone-new-profile' })
      await started
      const snapshot = await request('query', 'state.snapshot')
      assert.equal(snapshot.phase, 'ready')
      assert.equal((await request('query', 'zones.state')).supported, true)
      assert.equal((await request('query', 'audio.signalPath')).hardware, null)
      const page = await request('query', 'library.tracks', { limit: 10 })
      assert.equal(page.total, 2)

      const zoneA = (await request('command', 'zones.create', { revision: 0, name: 'Study' })).id
      const zoneB = (await request('command', 'zones.create', { revision: 1, name: 'Bedroom' })).id
      await request('command', 'zones.queueFromQuery', {
        zoneId: zoneA,
        revision: 0,
        query: { ids: ['one'] }
      })
      const topology = await request('query', 'zones.list')
      const source = topology.zones.find((zone) => zone.id === zoneA)
      const groupId = (
        await request('command', 'groups.create', {
          revision: topology.revision,
          name: 'Node group',
          members: topology.zones
            .filter((zone) => [zoneA, zoneB].includes(zone.id))
            .map((zone) => ({ zoneId: zone.id, revision: zone.revision, downstreamDelayMs: 0 })),
          source: {
            zoneId: zoneA,
            queue: {
              id: source.queue.id,
              revision: source.queue.revision,
              occurrenceId: source.queue.occurrenceId
            }
          }
        })
      ).id
      const groupQueue = (await request('query', 'groups.list')).groups[0].queue.id

      const database = children.find((row) => row.service === 'twilight-database').child
      const databaseExit = once(database, 'exit')
      database.kill()
      await databaseExit
      assert.equal((await request('query', 'library.tracks', { limit: 10 })).total, 2)
      assert.ok(children.filter((row) => row.service === 'twilight-database').length >= 2)

      const oldEpoch = supervisor.getStatus().epoch
      const recovered = new Promise((resolve) =>
        supervisor.on('status', (status) => {
          if (status.phase === 'ready' && status.epoch !== oldEpoch) resolve()
        })
      )
      children.find((row) => row.service === 'twilight-core').child.kill()
      await recovered
      await assert.rejects(
        request('query', 'state.snapshot', {}, oldEpoch),
        (error) => error.code === 'STALE_EPOCH'
      )
      assert.equal((await request('query', 'library.tracks', { limit: 10 })).total, 2)
      assert.equal((await request('query', 'audio.signalPath')).hardware, null)
      const groups = await request('query', 'groups.list')
      assert.equal(groups.groups[0].queue.id, groupQueue)
      assert.equal(groups.groups[0].playback.state, 'paused')
      await request('command', 'groups.remove', { groupId, revision: groups.groups[0].revision })
      assert.equal(businessMessages, 0)
      await supervisor.shutdown()
      assert.equal(alive.size, 0)
      console.log(
        '[server-test]',
        JSON.stringify({
          node: process.versions.node,
          services: [...new Set(children.map((row) => row.service))],
          businessMessages,
          epochRecovery: true,
          databaseRecovery: true,
          groupRestoredPaused: true,
          remaining: alive.size
        })
      )
    } finally {
      if (supervisor && alive.size) await supervisor.forceShutdown()
      if (env.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = env.NODE_OPTIONS
      if (env.TWILIGHT_METADATA_ENABLED === undefined) delete process.env.TWILIGHT_METADATA_ENABLED
      else process.env.TWILIGHT_METADATA_ENABLED = env.TWILIGHT_METADATA_ENABLED
      assert.equal(resolve(directory, '..'), resolve(tmpdir()))
      await rm(directory, { recursive: true, force: true })
    }
  }
)
