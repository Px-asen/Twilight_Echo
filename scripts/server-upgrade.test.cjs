'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { packageServer } = require('./package-server.cjs')
const { registerServerCliTest } = require('./server-cli.test.cjs')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { once } = require('node:events')
const { createInterface } = require('node:readline')
const { randomUUID } = require('node:crypto')

const temporary = fs.mkdtempSync(join(tmpdir(), 'twilight-upgrade-package-'))
const old = process.env.TWILIGHT_SERVER_UPGRADE_OLD_ROOT || join(temporary, 'old-version')
const current = join(temporary, "new ' 中文 version")
test.before(() => {
  if (!process.env.TWILIGHT_SERVER_UPGRADE_OLD_ROOT) packageServer({ destination: old })
  packageServer({ destination: current })
  // A version-label fixture exercises the version fence; it is not a published 1.4.1 release.
  const manifestPath = join(current, 'server-package.json'),
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const pkgPath = join(current, 'package.json'),
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  manifest.applicationVersion = pkg.version = '1.4.1'
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  fs.writeFileSync(pkgPath, JSON.stringify(pkg))
})
test.after(() => {
  assert.equal(resolve(temporary, '..'), resolve(tmpdir()))
  fs.rmSync(temporary, { recursive: true, force: true })
})
registerServerCliTest('native', {
  applicationRoot: old,
  nodeExecutable: join(old, 'runtime/node.exe'),
  isolatedPackage: true,
  configurationMigration: true,
  upgradeTargetRoot: current
})

test(
  'old package upgrades and rolls back four Zones and two groups with six SQL queues, positions, original orders and member DSP',
  { timeout: 180000 },
  async () => {
    const { desktopMigrationFixture } =
      await import('../src/main/server/desktopMigration.fixture.ts')
    const { LibraryDatabase } = await import('../src/main/library/libraryDatabase.ts')
    const { DspAssetLibrary } = await import('../src/core/audio/dspAssetLibrary.ts')
    const root = join(temporary, 'six-session-upgrade')
    fs.mkdirSync(root)
    const fixture = await desktopMigrationFixture(root)
    const data = join(root, 'server'),
      bundle = join(root, 'bundle'),
      work = join(root, 'upgrade')
    const guard = join(root, 'package-boundary.cjs')
    fs.writeFileSync(
      guard,
      `const M=require('node:module'),p=require('node:path'),load=M._load,resolve=M._resolveFilename,roots=${JSON.stringify([old, current])};M._load=function(name,...args){if(name==='electron')throw Error('Unexpected Electron');return load.call(this,name,...args)};M._resolveFilename=function(...args){const file=resolve.apply(this,args);if(p.isAbsolute(file)&&roots.every(root=>{const relative=p.relative(root,file);return relative==='..'||relative.startsWith('..'+p.sep)||p.isAbsolute(relative)}))throw Error('Module escaped package: '+file);return file}`
    )
    const env = {
      ...process.env,
      TWILIGHT_METADATA_ENABLED: '0',
      NODE_PATH: '',
      PATH: `${process.env.SystemRoot}\\System32`,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${guard.replaceAll('\\', '/')}"`
    }
    const cli = async (application, ...args) =>
      JSON.parse(
        (
          await promisify(execFile)(
            join(application, 'runtime/node.exe'),
            [join(application, 'out/server/server.cjs'), ...args],
            { env, windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024 }
          )
        ).stdout
      )
    await cli(old, 'export-migration', '--from', fixture.source, '--to', bundle, '--stopped')
    await cli(
      old,
      'migrate',
      '--from',
      bundle,
      '--data',
      data,
      '--library',
      fixture.music,
      '--apply'
    )
    const inventory = (directory, prefix = '') =>
      fs
        .readdirSync(join(directory, prefix), { withFileTypes: true })
        .flatMap((entry) =>
          entry.isDirectory()
            ? inventory(directory, join(prefix, entry.name))
            : [[join(prefix, entry.name), fs.readFileSync(join(directory, prefix, entry.name))]]
        )
        .sort(([a], [b]) => a.localeCompare(b))
    const verifyInstance = async (instance) => {
      const at = (...args) => cli(instance.application, ...args, '--data', instance.data)
      const server = spawn(
        join(instance.application, 'out/server-service/twilight-server-service.exe'),
        [
          '--console',
          '--node',
          join(instance.application, 'runtime/node.exe'),
          '--entry',
          join(instance.application, 'out/server/server.cjs'),
          '--data',
          instance.data
        ],
        { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      )
      const exited = once(server, 'exit'),
        lines = createInterface({ input: server.stdout })
      let stderr = ''
      server.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      let all
      try {
        await Promise.race([
          new Promise((resolveReady) =>
            lines.on('line', (line) => {
              if (line.startsWith('STATE RUNNING ')) resolveReady()
            })
          ),
          exited.then(([code]) => {
            throw Error(`Six-session host failed ${code}: ${stderr}`)
          })
        ])
        const health = await at('status')
        const rpc = async (name, payload = {}) => {
          const request = join(root, `rpc-${randomUUID()}.json`)
          fs.writeFileSync(
            request,
            JSON.stringify({
              kind: 'query',
              name,
              payload,
              epoch: health.epoch,
              requestId: randomUUID()
            })
          )
          return at('rpc', '--request', request)
        }
        const zones = await rpc('zones.list'),
          groups = await rpc('groups.list')
        assert.equal(zones.error, null, stderr)
        assert.equal(groups.error, null, stderr)
        assert.equal(zones.zones.length, 4)
        assert.equal(groups.groups.length, 2)
        all = [...zones.zones, ...groups.groups]
        assert.equal(new Set(all.map((session) => session.queue.id)).size, 6)
        for (const [index, original] of fixture.sessions.entries()) {
          const session = all.find((session) => session.id === original.id)
          assert.equal(session.playback.state, 'paused')
          assert.equal(session.playback.position, 10 + index)
          assert.equal(session.queue.total, 3)
          assert.equal(session.queue.index, 2)
          assert.equal(session.queue.occurrenceId, original.data.track.queueEntryId)
          const page = await rpc('queue.page', {
            id: session.queue.id,
            revision: session.queue.revision,
            offset: 0,
            limit: 10
          })
          assert.deepEqual(
            page.items.map((item) => item.queueEntryId),
            original.data.queue.map((item) => item.queueEntryId)
          )
          if (index < 4) {
            assert.equal(session.output.connected, false)
            assert.equal(session.output.selected, true)
            assert.equal(session.error, session.output.error)
            const directory = index ? join(instance.data, 'zones', original.id) : instance.data
            const settings = JSON.parse(fs.readFileSync(join(directory, 'settings.json'), 'utf8'))
            assert.equal(settings.softwareVolume, 0.2 + index * 0.1)
            assert.equal(settings.dspScenes[0].name, `${original.id} room`)
            assert.equal(settings.dspPinnedSceneId, 'room')
            const assets = new DspAssetLibrary(join(directory, 'dsp-assets'), {
              now: Date.now,
              newId: randomUUID
            })
            assert.deepEqual(
              fs.readFileSync(await assets.getPath(fixture.configuration.asset.id)),
              fixture.configuration.impulse
            )
            assert.equal(
              (await rpc('groups.signalPath', { groupId: session.groupId, zoneId: session.id }))
                .hardware,
              null
            )
          } else {
            assert.equal(session.error, null)
            assert.deepEqual(session.members, fixture.groups[index - 4].members)
            assert.equal(session.coordination.phase, 'paused')
          }
        }
        const workspace = await rpc('workspace.state')
        const named = await rpc('workspace.sessions', {
          revision: workspace.revision,
          contentRevision: workspace.contentRevision,
          offset: 0,
          limit: 10
        })
        assert.equal(named.items[0].name, '晚上听')
        await at('stop')
        assert.equal((await exited)[0], 0, stderr)
        assert.equal(fs.existsSync(join(instance.data, 'server.lock')), false)
        assert.equal(fs.existsSync(join(instance.data, 'server-run.json')), false)
        // Inspect original order only after the real database worker has stopped.
        const db = new LibraryDatabase(join(instance.data, 'music-library.sqlite'))
        try {
          for (const original of fixture.sessions) {
            const session = all.find((session) => session.id === original.id)
            const exported = db.exportPlaybackQueue(
              {
                id: session.queue.id,
                revision: session.queue.revision,
                index: session.queue.index,
                entryId: session.queue.occurrenceId
              },
              32 * 1024 * 1024,
              true
            )
            assert.deepEqual(exported.originalQueueEntryIds, original.originalEntryIds)
          }
        } finally {
          db.close()
        }
        return all.map((session) => ({
          id: session.id,
          queueId: session.queue.id,
          occurrenceId: session.queue.occurrenceId,
          position: session.playback.position
        }))
      } finally {
        lines.close()
        if (server.exitCode === null && server.signalCode === null) {
          server.kill()
          await exited
        }
      }
    }
    const baseline = await verifyInstance({ application: old, data })
    const before = inventory(data)
    const upgraded = await cli(
      current,
      'upgrade',
      '--from',
      old,
      '--to',
      current,
      '--data',
      data,
      '--work',
      work,
      '--apply'
    )
    assert.equal(upgraded.receipt.health.baseline.zones, 4)
    assert.equal(upgraded.receipt.health.candidate.groups, 2)
    assert.deepEqual(await verifyInstance(upgraded.receipt.active), baseline)
    assert.deepEqual(inventory(data), before)
    const rolled = await cli(current, 'rollback', '--work', work, '--apply')
    assert.deepEqual(await verifyInstance(rolled.receipt.active), baseline)
    assert.deepEqual(inventory(data), before)
    console.log(
      '[server-upgrade-zones]',
      JSON.stringify({
        versions: [
          upgraded.receipt.source.applicationVersion,
          upgraded.receipt.target.applicationVersion,
          rolled.receipt.active.applicationVersion
        ],
        zones: 4,
        groups: 2,
        queues: 6,
        positions: baseline.map((session) => session.position),
        originalOrders: true,
        memberDspAssets: true,
        sourceUnchanged: true,
        connected: false,
        hardware: null
      })
    )
  }
)
