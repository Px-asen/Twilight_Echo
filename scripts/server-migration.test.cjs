'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { once } = require('node:events')
const { createInterface } = require('node:readline')
const { mkdtemp, mkdir, readFile, writeFile, rm, access } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')

for (const version of [1, 2])
  test(
    `desktop v${version} export migrates through the CLI into a real paused Core without Electron or a DAC`,
    { timeout: 45000 },
    async () => {
      const temporary = await mkdtemp(join(tmpdir(), 'twilight-migrate-core-'))
      const music = join(temporary, '音乐'),
        data = join(temporary, 'server'),
        file = join(temporary, 'personal.json')
      const entry = resolve(__dirname, '../out/server/server.cjs'),
        options = join(temporary, 'options.json')
      let server, exit
      try {
        await mkdir(music)
        const wave = Buffer.alloc(44 + 480000)
        wave.write('RIFF')
        wave.writeUInt32LE(wave.length - 8, 4)
        wave.write('WAVEfmt ', 8)
        wave.writeUInt32LE(16, 16)
        wave.writeUInt16LE(1, 20)
        wave.writeUInt16LE(1, 22)
        wave.writeUInt32LE(8000, 24)
        wave.writeUInt32LE(16000, 28)
        wave.writeUInt16LE(2, 32)
        wave.writeUInt16LE(16, 34)
        wave.write('data', 36)
        wave.writeUInt32LE(480000, 40)
        await writeFile(join(music, 'song.wav'), wave)
        const { personalBackupFixture } =
          await import('../src/core/persistence/personalBackup.fixture.ts')
        const { remapPersonalPaths } = await import('../src/shared/personalBackup.ts')
        let backup = personalBackupFixture()
        backup.data = remapPersonalPaths(backup.data, [
          { from: 'C:/Old/song.flac', to: 'C:/Old/song.wav' }
        ])
        backup.data.playback.queue = [
          { ...backup.data.playback.track, queueEntryId: 'first-occurrence' },
          { ...backup.data.playback.track, queueEntryId: 'second-occurrence' }
        ]
        backup.data.playback.queueIndex = 1
        backup.data.playback.track = {
          ...backup.data.playback.track,
          queueEntryId: 'second-occurrence'
        }
        if (version === 2) {
          const { LibraryDatabase } = await import('../src/main/library/libraryDatabase.ts')
          const { personalDatabase } = await import('../src/main/server/migration.ts')
          const { createPersonalBackupRepository } =
            await import('../src/core/persistence/personalBackup.ts')
          const source = join(temporary, 'export-source')
          await mkdir(source)
          const database = new LibraryDatabase(join(source, 'music-library.sqlite'))
          try {
            database.replaceDocument(backup.data.library)
            while (database.catalogStatus().localPending) database.catalogAdvance()
            const recording = String(
              database.sql.prepare("SELECT id FROM catalog_entities WHERE kind='recording'").get()
                .id
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
            const timestamp = '2026-11-03T00:00:00.000Z'
            await writeFile(
              join(source, 'playback-session.json'),
              JSON.stringify({
                version: 2,
                revision: 1,
                savedAt: timestamp,
                data: backup.data.playback
              })
            )
            database.sql
              .prepare(
                "INSERT INTO personal_tags VALUES('default','evening','Evening','evening',1,1,10)"
              )
              .run()
            database.sql
              .prepare("INSERT INTO personal_tag_members VALUES('default','evening',?)")
              .run(recording)
            database.sql
              .prepare(
                "INSERT INTO personal_focus_queries VALUES('default','quiet','Quiet','quiet',?,1,1,10)"
              )
              .run(
                JSON.stringify({
                  version: 1,
                  entity: 'recording',
                  where: { tag: { id: 'evening' } }
                })
              )
            const portable =
              await createPersonalBackupRepository().createPersonalBackupFromDatabase(
                source,
                { statistics: backup.data.statistics, versions: backup.data.versions },
                personalDatabase(database)
              )
            backup = portable
          } finally {
            database.close()
          }
        }
        const original = JSON.stringify(backup)
        await writeFile(file, original)
        await writeFile(
          options,
          JSON.stringify({
            conflict: 'use-backup',
            mappings: [{ from: 'C:/Old', to: music }],
            domains: Object.keys(backup.data)
          })
        )
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
            await promisify(execFile)(process.execPath, [entry, ...args, '--data', data], {
              env,
              windowsHide: true,
              timeout: 20000,
              maxBuffer: 2 * 1024 * 1024
            })
          ).stdout.trim()
        const arguments_ = ['migrate', '--from', file, '--library', music, '--options', options]
        assert.equal(JSON.parse(await cli(...arguments_)).applied, false)
        await assert.rejects(access(data), { code: 'ENOENT' })
        assert.equal(JSON.parse(await cli(...arguments_, '--apply')).applied, true)
        server = spawn(process.execPath, [entry, 'service-child', '--data', data], {
          env,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
        let stderr = ''
        server.stderr.on('data', (data) => {
          stderr += data
        })
        exit = once(server, 'exit')
        const lines = createInterface({ input: server.stdout })
        const [ready] = await Promise.race([
          once(lines, 'line'),
          exit.then(([code]) => {
            throw Error(`Server failed ${code}: ${stderr}`)
          })
        ])
        assert.equal(ready, 'TWILIGHT_SERVER_READY')
        const health = JSON.parse(await cli('status'))
        const rpc = async (name, payload = {}) => {
          const request = join(temporary, `rpc-${randomUUID()}.json`)
          await writeFile(
            request,
            JSON.stringify({
              kind: 'query',
              name,
              payload,
              epoch: health.epoch,
              requestId: randomUUID()
            })
          )
          return JSON.parse(await cli('rpc', '--request', request))
        }
        const state = await rpc('state.snapshot')
        assert.equal(state.migrationRequired, false)
        assert.equal(
          state.playback.state,
          'paused',
          JSON.stringify({
            state,
            stderr,
            persisted: await readFile(join(data, 'playback-session.json'), 'utf8'),
            persistedQueue: await readFile(join(data, 'playback-queue.json'), 'utf8')
          })
        )
        assert.equal(state.queue.total, 2)
        assert.equal(state.queue.index, 1)
        assert.equal(state.queue.occurrenceId, 'second-occurrence')
        assert.equal(state.playback.position, 12)
        const queue = await rpc('queue.page', {
          id: state.queue.id,
          revision: state.queue.revision,
          offset: 0,
          limit: 10
        })
        assert.deepEqual(
          queue.items.map((item) => item.queueEntryId),
          ['first-occurrence', 'second-occurrence']
        )
        assert.equal((await rpc('library.tracks', { limit: 10 })).total, 1)
        const bridge = await rpc('zones.state')
        assert.equal(bridge.selectedOutputId, 'bridge')
        assert.equal(bridge.connected, false)
        assert.equal((await rpc('audio.signalPath')).hardware, null)
        const statistics = await rpc('statistics.tracks', { limit: 10, sort: 'seconds' })
        assert.equal(statistics.items[0].seconds, 20)
        if (version === 2) {
          const tag = (await rpc('tags.list', { limit: 10 })).items[0]
          assert.equal(tag.name, 'Evening')
          const recordings = await rpc('tags.recordings', { tagId: tag.id, limit: 10 })
          assert.equal(recordings.total, 1)
          const entityId = recordings.items[0].recordingId
          assert.equal((await rpc('ratings.detail', { entityId })).value.steps, 8)
          assert.equal((await rpc('preferences.detail', { entityId })).value.state, 'favorite')
          const focus = (await rpc('focus.saved.list', { limit: 10 })).items[0]
          assert.equal(focus.name, 'Quiet')
          assert.equal((await rpc('focus.query', { query: focus.query, limit: 10 })).total, 1)
        } else {
          assert.equal((await rpc('lyrics.entry', { trackId: 'song' })).override.offsetMs, 300)
          assert.ok(
            (await rpc('playlists.list', { limit: 10 })).items.some((item) => item.name === '收藏')
          )
        }
        await cli('stop')
        assert.equal((await exit)[0], 0, stderr)
        server = undefined
        assert.equal(await readFile(file, 'utf8'), original)
        console.log(
          '[server-migration]',
          JSON.stringify({
            version,
            queueTotal: state.queue.total,
            selectedOccurrence: state.queue.occurrenceId,
            position: state.playback.position,
            paused: true,
            hardware: null,
            statisticsSeconds: statistics.items[0].seconds
          })
        )
      } finally {
        if (server) {
          server.kill()
          await exit
        }
        assert.equal(resolve(temporary, '..'), resolve(tmpdir()))
        await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      }
    }
  )
