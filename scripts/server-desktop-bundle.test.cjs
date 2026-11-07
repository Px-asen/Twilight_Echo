'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { once } = require('node:events')
const { createInterface } = require('node:readline')
const { mkdtemp, readFile, writeFile, rm, access } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const { serverTestNodeExecutable } = require('./server-cli.test.cjs')

for (const contextKind of [undefined, 'heart', 'detached', 'personalized'])
  test(
    `CLI bundle ${contextKind || 'standard'} restores six sessions into real service Core, retains member DSP and safely ungroups without Electron or a DAC`,
    { timeout: 60000 },
    async () => {
      const temporary = await mkdtemp(join(tmpdir(), 'twilight-desktop-bundle-core-'))
      const data = join(temporary, 'server'),
        bundle = join(temporary, 'bundle')
      const application = process.env.TWILIGHT_SERVER_PACKAGE_TEST_ROOT
      const entry = application ? join(application, 'out/server/server.cjs') : resolve(__dirname, '../out/server/server.cjs')
      const node = serverTestNodeExecutable(application)
      let server, exited
      try {
        const { desktopMigrationFixture, addOnlineMigrationFixture } =
          await import('../src/main/server/desktopMigration.fixture.ts')
        const f = await desktopMigrationFixture(temporary, ['natural', 'dj'])
        const online = contextKind ? await addOnlineMigrationFixture(f, contextKind) : undefined
        const guard = join(temporary, 'no-electron.cjs')
        await writeFile(
          guard,
          "const M=require('node:module'),load=M._load;M._load=function(name,...rest){if(name==='electron')throw Error('Unexpected Electron');return load.call(this,name,...rest)}"
        )
        const env = {
          ...process.env,
          TWILIGHT_METADATA_ENABLED: '0',
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${guard.replaceAll('\\', '/')}"`
        }
        const cli = async (...args) =>
          (
            await promisify(execFile)(node, [entry, ...args], {
              env,
              windowsHide: true,
              timeout: 20000,
              maxBuffer: 4 * 1024 * 1024
            })
          ).stdout.trim()
        const manifest = JSON.parse(
          await cli('export-migration', '--from', f.source, '--to', bundle, '--stopped')
        )
        assert.equal(manifest.zones.length, 3)
        assert.equal(manifest.groups.length, 2)
        const migrate = ['migrate', '--from', bundle, '--data', data, '--library', f.music]
        assert.equal(JSON.parse(await cli(...migrate)).applied, false)
        await assert.rejects(access(data), { code: 'ENOENT' })
        assert.equal(JSON.parse(await cli(...migrate, '--apply')).applied, true)
        server = spawn(node, [entry, 'service-child', '--data', data], {
          env,
          windowsHide: true,
          cwd: temporary,
          stdio: ['pipe', 'pipe', 'pipe']
        })
        let stderr = ''
        server.stderr.on('data', (chunk) => {
          stderr += chunk
        })
        exited = once(server, 'exit')
        const lines = createInterface({ input: server.stdout })
        const [ready] = await Promise.race([
          once(lines, 'line'),
          exited.then(([code]) => {
            throw Error(`Server failed ${code}: ${stderr}`)
          })
        ])
        assert.equal(ready, 'TWILIGHT_SERVER_READY')
        const health = JSON.parse(await cli('status', '--data', data))
        const rpc = async (kind, name, payload = {}) => {
          const request = join(temporary, `rpc-${randomUUID()}.json`)
          await writeFile(
            request,
            JSON.stringify({ kind, name, payload, epoch: health.epoch, requestId: randomUUID() })
          )
          return JSON.parse(await cli('rpc', '--data', data, '--request', request))
        }
        const zones = await rpc('query', 'zones.list'),
          groups = await rpc('query', 'groups.list')
        assert.equal(zones.error, null, JSON.stringify({ zones, stderr }))
        assert.equal(groups.error, null, JSON.stringify({ groups, stderr }))
        const all = [...zones.zones, ...groups.groups]
        assert.equal(all.length, 6)
        assert.equal(new Set(all.map((session) => session.queue?.id)).size, 6)
        for (const [index, original] of f.sessions.entries()) {
          const session = all.find((session) => session.id === original.id)
          assert.ok(session, original.id)
          assert.equal(session.playback.state, 'paused')
          assert.equal(session.playback.nativePlaybackActive, false)
          assert.equal(session.playback.position, 10 + index)
          assert.equal(session.queue.total, 3)
          assert.equal(session.queue.index, 2)
          assert.equal(session.track.queueEntryId, original.data.track.queueEntryId)
          assert.equal(
            session.queue.occurrenceId,
            index === 0 && online
              ? online.persisted.libraryQueue.entryId
              : original.data.track.queueEntryId
          )
          const page = await rpc('query', 'queue.page', {
            id: session.queue.id,
            revision: session.queue.revision,
            offset: 0,
            limit: 10
          })
          assert.deepEqual(
            page.items.map((item) => item.queueEntryId),
            original.data.queue.map((track) => track.queueEntryId)
          )
          if (index < 4) {
            assert.equal(session.output.connected, false)
            assert.equal(session.error, session.output.error)
            assert.match(session.error, /重新连接输出桥/)
            const settings = JSON.parse(
              await readFile(
                join(index ? join(data, 'zones', original.id) : data, 'settings.json'),
                'utf8'
              )
            )
            assert.equal(settings.softwareVolume, 0.2 + index * 0.1)
            assert.equal(settings.autoMixMode, index % 2 ? 'natural' : 'dj')
            assert.equal(settings.autoMixStemMode, 'auto')
            assert.equal(settings.autoMixStemDevice, 'cpu')
            assert.equal(settings.autoMixStemCacheMiB, 1024)
            assert.equal(settings.dspScenes[0].name, `${original.id} room`)
            const path = await rpc('query', 'groups.signalPath', {
              groupId: session.groupId,
              zoneId: session.id
            })
            assert.equal(path.hardware, null)
          } else {
            assert.equal(session.error, null, JSON.stringify({ session, stderr }))
            assert.deepEqual(session.members, f.groups[index - 4].members)
            assert.equal(session.autoMixMode, f.groups[index - 4].autoMixMode)
            assert.equal(session.playback.autoMixMode, session.autoMixMode)
            assert.equal(session.autoMixAvailable, true)
            assert.equal(session.coordination.phase, 'paused')
            assert.equal(session.coordination.audibleAtCoreMs, null)
          }
        }
        const workspace = await rpc('query', 'workspace.state')
        const named = await rpc('query', 'workspace.sessions', {
          revision: workspace.revision,
          contentRevision: workspace.contentRevision,
          offset: 0,
          limit: 10
        })
        assert.equal(named.items[0].name, '晚上听')
        for (const group of groups.groups)
          await rpc('command', 'groups.remove', { groupId: group.id, revision: group.revision })
        assert.equal((await rpc('query', 'groups.list')).groups.length, 0)
        const independent = await rpc('query', 'zones.list')
        assert.ok(
          independent.zones.every(
            (zone) => !zone.groupId && zone.playback.state === 'paused' && zone.queue.total === 3
          )
        )
        const state = await rpc('query', 'state.snapshot')
        if (contextKind === 'heart') {
          assert.equal(state.heart.active, true)
          assert.equal(state.playback.playMode, 'heart')
        } else if (contextKind === 'detached') {
          assert.equal(state.track.id, 'ncm:99')
          assert.equal(state.heart.available, false)
        } else if (contextKind === 'personalized') {
          assert.equal(state.personalized.providerId, 'ncm-provider')
          assert.equal(state.personalized.key, 'fm')
          assert.equal(state.personalized.queueId, state.queue.id)
        }
        await cli('stop', '--data', data)
        assert.equal((await exited)[0], 0, stderr)
        server = undefined
        await assert.rejects(access(join(data, 'server.lock')), { code: 'ENOENT' })
        console.log(
          '[server-desktop-bundle]',
          JSON.stringify({
            contextKind: contextKind || 'standard',
            sessions: 6,
            zones: 4,
            groups: 2,
            queuesDistinct: true,
            positions: all.map((session) => session.playback.position),
            memberDsp: true,
            groupAutoMixModes: groups.groups.map(group => group.autoMixMode),
            disconnected: true,
            hardware: null,
            ungrouped: true
          })
        )
      } finally {
        if (server) {
          server.kill()
          await exited
        }
        assert.equal(resolve(temporary, '..'), resolve(tmpdir()))
        await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      }
    }
  )
