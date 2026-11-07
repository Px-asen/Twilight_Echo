'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { mkdtemp, mkdir, writeFile, readFile, rm, access, cp } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { once } = require('node:events')
const { createInterface } = require('node:readline')
const { createServer, createConnection } = require('node:net')
const { request: httpsRequest } = require('node:https')
const { randomBytes, randomUUID, createHash, X509Certificate } = require('node:crypto')

function serverTestNodeExecutable(
  applicationRoot,
  { platform = process.platform, executable = process.execPath } = {}
) {
  // Windows ZIPs own their Node binary. Linux images provide Node in the
  // base image, not in /server/runtime. Never fall back from a broken ZIP.
  return applicationRoot && platform === 'win32'
    ? join(applicationRoot, 'runtime/node.exe')
    : executable
}

function registerServerCliTest(
  mode = 'console',
  {
    configurationMigration = false,
    applicationRoot = resolve(__dirname, '..'),
    nodeExecutable = process.execPath,
    isolatedPackage = false,
    upgradeTargetRoot,
    libraryManagement = false,
    sessionQueues = false,
    dspManagement = false,
    pluginManagement = false,
    remotePlugins = true
  } = {}
) {
  test(
    `Server ${mode}${configurationMigration ? ' with migrated DSP' : ''}${sessionQueues ? ' with explicit session queues' : ''}${dspManagement ? ' with daily DSP management' : ''}${pluginManagement ? ` with extension management (remote ${remotePlugins})` : ''} scans, authenticates local administration, approves TLS pairing and shuts down without Electron`,
    { timeout: 90000 },
    async () => {
      const app = applicationRoot,
        serverEntry = join(app, 'out/server/server.cjs')
      const temporary = await mkdtemp(join(tmpdir(), 'twilight-server-cli-'))
      const root = join(temporary, 'profile'),
        music = join(temporary, 'music')
      let server, exited, receiver, deviceClock
      try {
        const guard = join(temporary, 'no-electron.cjs')
        await writeFile(
          guard,
          `const M=require('node:module'),load=M._load;M._load=function(name,...rest){if(name==='electron')throw Error('Unexpected Electron');return load.call(this,name,...rest)};` +
            (isolatedPackage
              ? `const p=require('node:path'),resolve=M._resolveFilename,roots=${JSON.stringify([app, ...(upgradeTargetRoot ? [upgradeTargetRoot] : [])])};M._resolveFilename=function(...args){const file=resolve.apply(this,args);if(p.isAbsolute(file)&&roots.every(root=>{const relative=p.relative(root,file);return relative==='..'||relative.startsWith('..'+p.sep)||p.isAbsolute(relative)}))throw Error('Module escaped package: '+file);return file}`
              : '')
        )
        const env = {
          ...process.env,
          TWILIGHT_METADATA_ENABLED: '0',
          ...(isolatedPackage
            ? { NODE_PATH: '', PATH: process.platform === 'win32' ? `${process.env.SystemRoot}\\System32` : '/usr/bin:/bin' }
            : {}),
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${guard.replaceAll('\\', '/')}"`
        }
        const cliAt = async (data, ...args) => {
          const result = await promisify(execFile)(
            nodeExecutable,
            [serverEntry, ...args, '--data', data],
            { env, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }
          )
          return result.stdout.trim()
        }
        const cli = (...args) => cliAt(root, ...args)
        await mkdir(music)
        const wave = Buffer.alloc(44 + 48000)
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
        wave.writeUInt32LE(48000, 40)
        for (let i = 0; i < 24000; i++)
          wave.writeInt16LE(Math.round(Math.sin((i * Math.PI) / 4) * 8192), 44 + i * 2)
        await writeFile(join(music, '静默测试.wav'), wave)
        if (configurationMigration) {
          const { configurationFixture } =
            await import('../src/main/server/configuration.fixture.ts')
          const configuration = await configurationFixture(join(temporary, 'desktop-configuration'))
          const file = join(temporary, 'personal.json')
          await writeFile(
            file,
            JSON.stringify({
              format: 'twilight-personal-data',
              version: 1,
              createdAt: '2026-11-03T00:00:00Z',
              data: {
                library: {
                  version: 2,
                  revision: 0,
                  folders: [music],
                  exclusions: [],
                  tracks: [
                    {
                      id: 'seed-track',
                      title: '静默测试',
                      filePath: join(music, '静默测试.wav'),
                      duration: 3
                    }
                  ]
                }
              }
            })
          )
          await cli(
            'migrate',
            '--from',
            file,
            '--library',
            music,
            '--settings',
            configuration.settingsFile,
            '--dsp',
            configuration.dspProfile,
            '--apply'
          )
        } else await cli('init', '--library', music)
        if (dspManagement && process.env.TWILIGHT_VST3_FIXTURE_PATH) {
          const modules = join(temporary, 'plugins')
          await mkdir(modules)
          await cp(process.env.TWILIGHT_VST3_FIXTURE_PATH, join(modules, 'adelay.vst3'), { recursive: true })
          const profileFile = join(root, 'server.json')
          const profile = JSON.parse(await readFile(profileFile, 'utf8'))
          profile.vst3Roots = [modules]
          await writeFile(profileFile, JSON.stringify(profile))
        }
        if (pluginManagement && remotePlugins) {
          const file = join(root, 'server.json')
          await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), remotePluginManagement: true }))
        }
        await assert.rejects(cli('init'), /初始化需要空目录/)
        const nativeHost = join(app, 'out/server-service/twilight-server-service.exe')
        server = spawn(
          mode === 'native' ? nativeHost : nodeExecutable,
          mode === 'native'
            ? ['--console', '--node', nodeExecutable, '--entry', serverEntry, '--data', root]
            : [serverEntry, mode === 'service-child' ? 'service-child' : 'start', '--data', root],
          {
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            cwd: temporary
          }
        )
        let stderr = ''
        server.stderr.on('data', (data) => {
          stderr += data
        })
        exited = once(server, 'exit')
        const lines = createInterface({ input: server.stdout })
        const controlLines = []
        const ready = new Promise((resolve) =>
          lines.on('line', (line) => {
            controlLines.push(line)
            if (
              mode === 'native'
                ? line.startsWith('STATE RUNNING ')
                : mode === 'service-child'
                  ? line === 'TWILIGHT_SERVER_READY'
                  : line.startsWith('{')
            )
              resolve(line)
          })
        )
        const [line] = await Promise.race([
          ready.then((line) => [line]),
          exited.then(([code]) => {
            throw Error(`Server startup failed ${code}: ${stderr}`)
          })
        ])
        if (mode === 'console') assert.equal(JSON.parse(line).phase, 'ready')
        assert.equal(JSON.parse(await cli('status')).phase, 'ready')
        await assert.rejects(cli('start'), /EEXIST/)
        await assert.rejects(cli('unlock'), /仍存在/)
        const health = JSON.parse(await cli('status'))
        if (mode === 'console')
          await assert.rejects(cli('backup', '--to', join(temporary, 'live-backup')), /EEXIST/)
        const rpc = async (kind, name, payload = {}) => {
          const file = join(temporary, `rpc-${randomUUID()}.json`)
          await writeFile(
            file,
            JSON.stringify({ kind, name, payload, epoch: health.epoch, requestId: randomUUID() })
          )
          return JSON.parse(await cli('rpc', '--request', file))
        }
        const primary = await rpc('query', 'zones.state')
        assert.equal(
          primary.selectedOutputId,
          mode === 'console' && !configurationMigration ? 'local' : 'bridge'
        )
        assert.equal(
          primary.outputs.find((output) => output.id === 'local').available,
          mode === 'console'
        )
        if (mode !== 'console') {
          await assert.rejects(
            rpc('command', 'zones.select', { revision: primary.revision, outputId: 'local' }),
            /只能选择输出桥/
          )
          await assert.rejects(
            rpc('command', 'bridge.host', {
              revision: primary.revision,
              enabled: true,
              sampleRate: 48000
            }),
            /不承载本机 DAC/
          )
        }
        let page
        for (let i = 0; i < 100; i++) {
          page = await rpc('query', 'library.tracks', { limit: 10 })
          if (page.total === 1) break
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        assert.equal(page.total, 1, stderr)
        assert.equal(page.tracks[0].title, '静默测试')
        assert.equal((await rpc('query', 'state.snapshot')).playback.state, 'stopped')
        assert.equal((await rpc('query', 'audio.signalPath')).hardware, null)
        const run = JSON.parse(await readFile(join(root, 'server-run.json'), 'utf8'))
        const unauthorized = createConnection(run.address)
        await once(unauthorized, 'connect')
        const unauthorizedReply = once(unauthorized, 'data')
        unauthorized.end(
          JSON.stringify({ token: '00'.repeat(32), request: { kind: 'status' } }) + '\n'
        )
        assert.equal(JSON.parse(String((await unauthorizedReply)[0])).ok, false)
        unauthorized.destroy()

        const reservation = createServer()
        reservation.listen(0, '127.0.0.1')
        await once(reservation, 'listening')
        const port = reservation.address().port
        await new Promise((resolve) => reservation.close(resolve))
        const settings = await rpc('query', 'settings.state')
        await rpc('command', 'settings.edit', {
          revision: settings.revision,
          patch: { remoteControlPort: port }
        })
        const remote = JSON.parse(await cli('remote-on'))
        assert.equal(remote.running, true)
        const tls = JSON.parse(await readFile(join(root, 'remote-tls.json'), 'utf8'))
        const certificate = new X509Certificate(tls.cert)
        const secure = (path, body, token) =>
          new Promise((resolve, reject) => {
            const req = httpsRequest(
              {
                host: '127.0.0.1',
                port,
                path,
                ca: tls.cert,
                agent: false,
                checkServerIdentity: (_host, peer) =>
                  peer.raw.equals(certificate.raw) ? undefined : Error('Wrong pinned certificate'),
                method: body === undefined ? 'GET' : 'POST',
                headers: {
                  'content-type': 'application/json',
                  ...(token ? { authorization: `Bearer ${token}` } : {})
                }
              },
              (res) => {
                let text = ''
                res.setEncoding('utf8')
                res.on('data', (data) => {
                  text += data
                })
                res.on('end', () =>
                  resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null })
                )
              }
            )
            req.on('error', reject)
            req.end(body === undefined ? undefined : JSON.stringify(body))
          })
        assert.equal((await secure('/api/state')).status, 401)
        const nonce = randomBytes(32).toString('base64url')
        const ticket = (
          await secure('/api/pair/requests', {
            deviceName: '软件模拟手机',
            commitment: createHash('sha256').update(nonce).digest('base64url')
          })
        ).json
        await secure('/api/pair/reveal', {
          requestId: ticket.requestId,
          claimSecret: ticket.claimSecret,
          nonce
        })
        const phoneCode = String(
          createHash('sha256')
            .update(
              `twilight-pair-v2|${certificate.fingerprint256.replaceAll(':', '').toLowerCase()}|${nonce}|${ticket.serverNonce}`
            )
            .digest()
            .readUInt32BE(0) % 1000000
        ).padStart(6, '0')
        const pending = JSON.parse(await cli('remote-status')).pairingRequests[0]
        assert.equal(pending.verificationCode, phoneCode)
        assert.equal((await secure('/api/pair/claim', ticket)).json.state, 'pending')
        const wrongCode = phoneCode === '000000' ? '000001' : '000000'
        await assert.rejects(
          cli('allow-pairing', '--id', ticket.requestId, '--code', wrongCode),
          /验证码不一致/
        )
        await cli('allow-pairing', '--id', ticket.requestId, '--code', phoneCode)
        const claim = (await secure('/api/pair/claim', ticket)).json
        assert.equal(claim.state, 'approved')
        assert.equal((await secure('/api/state', undefined, claim.token)).status, 200)
        const response = await secure(
          '/api/core/rpc',
          {
            kind: 'query',
            name: 'search.songs',
            payload: { query: '静默测试', offset: 0, limit: 10 },
            epoch: health.epoch,
            requestId: randomUUID()
          },
          claim.token
        )
        assert.equal(response.json.ok, true, JSON.stringify(response.json))
        assert.equal(response.json.value.total, 1)
        assert.doesNotMatch(JSON.stringify(response.json), /filePath|streamUrl/)
        if (pluginManagement) await require('./server-plugin-management-fixture.cjs').checkPluginManagement({
          secure, token: claim.token, epoch: health.epoch, cli, rpc, temporary, root, remoteEnabled: remotePlugins
        })

        // The phone controls the real Core/decoder. Only the receiving DAC is simulated.
        const { AudioBridgeRuntime } = await import('../src/main/audio/bridgeRuntime.ts')
        const { createRemoteTlsIdentity } =
          await import('../src/adapters-node/remoteTlsIdentity.ts')
        const blocks = []
        const facts = {
          sampleRate: 48000,
          channels: 2,
          bufferedFrames: 0,
          capacityFrames: 12000,
          prebufferFrames: 1920,
          consumedFrames: 0,
          underruns: 0,
          started: false,
          failed: false,
          backend: 'wasapi-exclusive',
          deviceName: 'Simulated DAC',
          actualSampleRate: 48000,
          actualBitDepth: 24,
          actualChannels: 2,
          actualOutputFormat: 'int24',
          exclusive: true
        }
        receiver = new AudioBridgeRuntime({
          Stop() {},
          SetOutputBackend() {},
          SetOutputDevice() {},
          PullBridgePcm() {
            assert.fail('The receiving DAC must not decode')
          },
          OpenBridgeReceiver() {
            facts.bufferedFrames = facts.consumedFrames = 0
            facts.started = false
          },
          CloseBridgeReceiver() {
            facts.bufferedFrames = 0
            facts.started = false
          },
          WriteBridgePcm(data) {
            blocks.push(Buffer.from(data))
            facts.bufferedFrames += data.length / 8
            assert.ok(facts.bufferedFrames <= facts.capacityFrames)
            // Production BridgeReceiver::write starts ordinary playback at prebuffer.
            if (facts.bufferedFrames >= facts.prebufferFrames) facts.started = true
          },
          StartBridgeReceiver() {
            facts.started = true
          },
          GetBridgeReceiverInfo() {
            return JSON.stringify(facts)
          }
        })
        deviceClock = setInterval(() => {
          if (facts.started) {
            const n = Math.min(480, facts.bufferedFrames)
            facts.bufferedFrames -= n
            facts.consumedFrames += n
          }
        }, 10)
        const identity = createRemoteTlsIdentity()
        const grant = await receiver.startHost({
          ...identity,
          name: 'Software receiver',
          backend: 'wasapi-exclusive',
          device: 'simulated-dac',
          sampleRate: 48000
        })
        const zoneId = configurationMigration
          ? 'local'
          : (await rpc('command', 'zones.create', { revision: 0, name: 'Remote test' })).id
        const peer = {
          host: '127.0.0.1',
          port: grant.port,
          token: grant.token,
          fingerprint: identity.fingerprint
        }
        if (configurationMigration)
          await rpc('command', 'bridge.connect', { revision: primary.revision, peer })
        else await rpc('command', 'zones.connect', { zoneId, revision: 0, peer })
        const currentZone = async () =>
          (await rpc('query', 'zones.list')).zones.find((zone) => zone.id === zoneId)
        await rpc('command', 'zones.queueFromQuery', {
          zoneId,
          revision: (await currentZone()).revision,
          query: { ids: [page.tracks[0].id] }
        })
        const beforePlay = await currentZone()
        let managedDsp
        if (dspManagement) managedDsp = await require('./server-dsp-management-fixture.cjs').prepareDspLibrary(secure, claim.token, health.epoch, zoneId, cli, temporary)
        if (managedDsp?.vstNodeId) await managedDsp.setDelay(null)
        const play = async () => secure(
          '/api/core/rpc',
          {
            kind: 'command',
            name: 'zones.transport',
            epoch: health.epoch,
            requestId: randomUUID(),
            payload: { zoneId, revision: (await currentZone()).revision, action: { kind: 'play' } }
          },
          claim.token
        )
        const targetBlocks = configurationMigration || dspManagement ? 32 : 14
        const collect = async () => {
          const played = await play()
          assert.equal(played.json.ok, true, JSON.stringify(played.json))
          for (let i = 0; i < 300 && blocks.length < targetBlocks; i++)
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
        await collect()
        let presetRms
        if (managedDsp?.vstNodeId) {
          assert.ok(blocks.length >= targetBlocks)
          let energy = 0, count = 0
          for (const block of blocks.slice(16, targetBlocks)) for (let i = 0; i < block.length; i += 4) {
            energy += block.readFloatLE(i) ** 2; count++
          }
          presetRms = Math.sqrt(energy / count)
          // The bound preset delays by one second. This early window must be silent;
          // a dry fallback would otherwise mimic the later zero-delay override.
          assert.ok(presetRms < 1e-6, JSON.stringify({ presetRms }))
          await rpc('command', 'zones.transport', { zoneId, revision: null, action: { kind: 'stop' } })
          await managedDsp.setDelay(0)
          blocks.length = 0
          await collect()
        }
        assert.ok(
          blocks.length >= targetBlocks,
          JSON.stringify({
            blocks: blocks.length,
            zone: await currentZone(),
            receiver: receiver.state(),
            facts,
            signalPath: await rpc('query', 'zones.signalPath', { zoneId }),
            dsp: await rpc('query', 'zones.dsp', { zoneId }),
            stderr
          })
        )
        let squares = 0,
          samples = 0
        for (const block of blocks.slice(configurationMigration || dspManagement ? 16 : 3, targetBlocks))
          for (let i = 0; i < block.length; i += 4) {
            squares += block.readFloatLE(i) ** 2
            samples++
          }
        const rms = Math.sqrt(squares / samples)
        if (configurationMigration) {
          // Mono is FC; FFmpeg's default FC -> FL/FR matrix applies 1/sqrt(2) per channel.
          const sineRms = 0.25 * Math.SQRT1_2
          const expected = sineRms * Math.SQRT1_2 * 0.42 * 0.5 * 10 ** (-6 / 20)
          const graph = await rpc('query', 'audio.dsp.status')
          assert.equal(graph.activeSceneId, 'room', JSON.stringify(graph))
          assert.equal(graph.applyState, 'applied', JSON.stringify(graph))
          assert.equal(graph.compileState, 'ready', JSON.stringify(graph))
          const convolver = graph.nodes.find((node) => node.id === 'room-convolver')
          assert.ok(convolver.active && !convolver.bypassed, JSON.stringify(graph))
          assert.ok(Math.abs(rms / expected - 1) < 0.02, JSON.stringify({ rms, expected, graph }))
        } else if (dspManagement) {
          const graph = await rpc('query', 'zones.signalPath', { zoneId })
          assert.equal(graph.dsp.activeSceneId, managedDsp.sceneId)
          assert.ok(graph.dsp.nodes.some(node => node.type === 'convolver' && node.active && !node.bypassed), JSON.stringify(graph))
          if (managedDsp.vstNodeId) assert.ok(graph.dsp.nodes.some(node => node.id === managedDsp.vstNodeId && node.active && !node.bypassed), JSON.stringify({ graph, stderr, logs: controlLines.slice(-25) }))
          const expected = 0.25 * Math.SQRT1_2 * Math.SQRT1_2 * beforePlay.playback.volume * 0.5
          assert.ok(Math.abs(rms / expected - 1) < 0.05, JSON.stringify({ rms, expected, graph }))
        } else assert.ok(rms > 0.05 && rms < 0.3, `Actual decoded PCM RMS ${rms}`)
        const paused = await secure(
          '/api/core/rpc',
          {
            kind: 'command',
            name: 'zones.transport',
            epoch: health.epoch,
            requestId: randomUUID(),
            payload: { zoneId, revision: null, action: { kind: 'pause' } }
          },
          claim.token
        )
        assert.equal(paused.json.ok, true, JSON.stringify(paused.json))
        assert.equal((await currentZone()).playback.state, 'paused')
        if (libraryManagement) {
          const { exerciseRemoteLibrary } = require('./remote-library-management-fixture.cjs')
          try { await exerciseRemoteLibrary(secure, claim.token, health.epoch) }
          catch (error) { console.error('[remote-library-server]', stderr); throw error }
        }
        if (sessionQueues) {
          const { exerciseSessionQueues } = require('./remote-library-management-fixture.cjs')
          try { await exerciseSessionQueues(secure, claim.token, health.epoch, zoneId) }
          catch (error) { console.error('[session-queues-server]', stderr); throw error }
        }
        const checkpointZone = await currentZone()
        if (mode === 'service-child') server.stdin.write('TWILIGHT_SERVER_STOP\n')
        else {
          const stopped = JSON.parse(await cli('stop'))
          assert.equal(stopped.phase, 'stopped')
          assert.deepEqual(stopped.processes, [])
        }
        assert.equal((await exited)[0], 0, stderr)
        if (mode === 'service-child') assert.ok(controlLines.includes('TWILIGHT_SERVER_STOPPED'))
        if (mode === 'native') {
          assert.ok(controlLines.includes('STATE STOPPED error=0 pid=0'), controlLines.join('\n'))
          assert.match(await readFile(join(root, 'server-service.log'), 'utf8'), /ownedRemaining=0/)
        }
        server = undefined
        await assert.rejects(access(join(root, 'server.lock')), (error) => error.code === 'ENOENT')
        await assert.rejects(
          access(join(root, 'server-run.json')),
          (error) => error.code === 'ENOENT'
        )
        assert.doesNotMatch(
          stderr,
          /Unknown or unavailable platform capability|Unexpected Electron/
        )
        if (mode === 'console') {
          const backup = join(temporary, 'upgrade-backup'),
            restored = join(temporary, 'restored')
          const manifest = JSON.parse(await cli('backup', '--to', backup))
          assert.ok(manifest.files.some((file) => file.path === 'music-library.sqlite'))
          assert.ok(manifest.files.some((file) => file.path === 'core-state.sqlite'))
          await cliAt(restored, 'restore', '--from', backup)
          server = spawn(nodeExecutable, [serverEntry, 'start', '--data', restored], {
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: temporary
          })
          let restoreError = ''
          server.stderr.on('data', (data) => {
            restoreError += data
          })
          exited = once(server, 'exit')
          const restoredLines = createInterface({ input: server.stdout })
          const [restoredLine] = await Promise.race([
            once(restoredLines, 'line'),
            exited.then(([code]) => {
              throw Error(`Restored Server failed ${code}: ${restoreError}`)
            })
          ])
          const restoredHealth = JSON.parse(restoredLine)
          assert.equal(restoredHealth.phase, 'ready')
          const restoredRpc = async (name, payload = {}) => {
            const file = join(temporary, `restored-${randomUUID()}.json`)
            await writeFile(
              file,
              JSON.stringify({
                kind: 'query',
                name,
                payload,
                epoch: restoredHealth.epoch,
                requestId: randomUUID()
              })
            )
            return JSON.parse(await cliAt(restored, 'rpc', '--request', file))
          }
          assert.equal((await restoredRpc('library.tracks', { limit: 10 })).total, 1)
          const recovered = (await restoredRpc('zones.list')).zones.find(
            (zone) => zone.id === zoneId
          )
          assert.equal(recovered.queue.id, checkpointZone.queue.id)
          assert.equal(recovered.queue.occurrenceId, checkpointZone.queue.occurrenceId)
          assert.equal(recovered.playback.state, 'paused')
          assert.equal(recovered.output.connected, false)
          assert.equal((await secure('/api/state', undefined, claim.token)).status, 200)
          assert.notEqual(
            JSON.parse(await readFile(join(restored, 'server-run.json'), 'utf8')).token,
            run.token
          )
          await cliAt(restored, 'stop')
          assert.equal((await exited)[0], 0, restoreError)
          server = undefined
        }
        if (upgradeTargetRoot) {
          const { readdir } = require('node:fs/promises')
          const inventory = async (directory, prefix = '') => {
            const result = []
            for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
              const path = join(prefix, entry.name)
              if (entry.isDirectory()) result.push(...(await inventory(directory, path)))
              else result.push([path, await readFile(join(directory, path))])
            }
            return result.sort(([a], [b]) => a.localeCompare(b))
          }
          // Exercise the legacy managed-path setting as well as scene asset IDs.
          const { DspAssetLibrary } = await import('../src/core/audio/dspAssetLibrary.ts')
          const assets = new DspAssetLibrary(join(root, 'dsp-assets'), {
            now: Date.now,
            newId: randomUUID
          })
          const ownedIr = (await assets.list())[0]
          const settings = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))
          settings.audioProcessing.convolverIrPath = await assets.getPath(ownedIr.id)
          await writeFile(join(root, 'settings.json'), JSON.stringify(settings))
          const before = await inventory(root)
          const work = join(temporary, "upgrade ' 工作目录")
          const powershell = (
            await promisify(execFile)(
              join(process.env.SystemRoot, 'System32/where.exe'),
              ['pwsh'],
              { windowsHide: true }
            )
          ).stdout
            .trim()
            .split(/\r?\n/)[0]
          const manage = async (...args) =>
            JSON.parse(
              (
                await promisify(execFile)(
                  join(upgradeTargetRoot, 'runtime/node.exe'),
                  [join(upgradeTargetRoot, 'out/server/server.cjs'), ...args],
                  { env, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }
                )
              ).stdout
            )
          const arguments_ = [
            'upgrade',
            '--from',
            app,
            '--to',
            upgradeTargetRoot,
            '--data',
            root,
            '--work',
            work
          ]
          assert.equal((await manage(...arguments_)).applied, false)
          await assert.rejects(access(work), { code: 'ENOENT' })
          const upgraded = await manage(...arguments_, '--apply')
          assert.equal(upgraded.receipt.phase, 'active')
          assert.deepEqual(await inventory(root), before)
          const verifyInstance = async (instance) => {
            const entry = join(instance.application, 'out/server/server.cjs'),
              node = join(instance.application, 'runtime/node.exe')
            const at = async (...args) =>
              JSON.parse(
                (
                  await promisify(execFile)(node, [entry, ...args, '--data', instance.data], {
                    env,
                    windowsHide: true,
                    timeout: 20000,
                    maxBuffer: 2 * 1024 * 1024
                  })
                ).stdout
              )
            server = spawn(
              powershell,
              ['-NoProfile', '-NonInteractive', '-File', join(work, 'service-console.ps1')],
              { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
            )
            let failure = ''
            server.stderr.on('data', (data) => {
              failure += data
            })
            exited = once(server, 'exit')
            const ready = new Promise((resolveReady) =>
              createInterface({ input: server.stdout }).on('line', (line) => {
                if (line.startsWith('STATE RUNNING ')) resolveReady(line)
              })
            )
            await Promise.race([
              ready,
              exited.then(([code]) => {
                throw Error(`Activated version failed ${code}: ${failure}`)
              })
            ])
            const health = await at('status')
            const managed = JSON.parse(
              (
                await promisify(execFile)(
                  powershell,
                  ['-NoProfile', '-NonInteractive', '-File', join(work, 'server.ps1'), 'status'],
                  { env, windowsHide: true }
                )
              ).stdout
            )
            assert.equal(managed.epoch, health.epoch)
            await assert.rejects(
              promisify(execFile)(
                powershell,
                [
                  '-NoProfile',
                  '-NonInteractive',
                  '-File',
                  join(work, 'server.ps1'),
                  'status',
                  '--data',
                  root
                ],
                { env, windowsHide: true }
              ),
              /不接受 --data/
            )
            const query = async (name, payload = {}) => {
              const file = join(temporary, `upgrade-rpc-${randomUUID()}.json`)
              await writeFile(
                file,
                JSON.stringify({
                  kind: 'query',
                  name,
                  payload,
                  epoch: health.epoch,
                  requestId: randomUUID()
                })
              )
              return at('rpc', '--request', file)
            }
            const zone = (await query('zones.list')).zones.find((zone) => zone.id === zoneId)
            assert.equal(zone.queue.id, checkpointZone.queue.id)
            assert.equal(zone.queue.occurrenceId, checkpointZone.queue.occurrenceId)
            assert.equal(zone.playback.state, 'paused')
            assert.equal(zone.output.connected, false)
            assert.equal((await query('audio.signalPath')).hardware, null)
            assert.equal((await secure('/api/state', undefined, claim.token)).status, 200)
            assert.deepEqual(
              await readFile(join(instance.data, 'remote-tls.json')),
              await readFile(join(root, 'remote-tls.json'))
            )
            assert.notEqual(
              JSON.parse(await readFile(join(instance.data, 'server-run.json'), 'utf8')).token,
              run.token
            )
            const settings = JSON.parse(
              await readFile(join(instance.data, 'settings.json'), 'utf8')
            )
            assert.ok(settings.audioProcessing.convolverIrPath.startsWith(instance.data))
            assert.ok(settings.musicCachePath.startsWith(instance.data))
            await at('stop')
            assert.equal((await exited)[0], 0, failure)
            server = undefined
          }
          await verifyInstance(upgraded.receipt.active)
          await writeFile(
            join(upgraded.receipt.active.data, 'newer-profile-note'),
            'must remain after rollback'
          )
          const preview = await manage('rollback', '--work', work)
          assert.equal(preview.losesPostUpgradeChanges, true)
          const rolled = await manage('rollback', '--work', work, '--apply')
          assert.equal(rolled.receipt.phase, 'rolled-back')
          await verifyInstance(rolled.receipt.active)
          await assert.rejects(access(join(rolled.receipt.active.data, 'newer-profile-note')), {
            code: 'ENOENT'
          })
          assert.equal(
            await readFile(join(upgraded.receipt.active.data, 'newer-profile-note'), 'utf8'),
            'must remain after rollback'
          )
          assert.deepEqual(await inventory(root), before)
          console.log(
            '[server-upgrade]',
            JSON.stringify({
              sourceVersion: upgraded.receipt.source.applicationVersion,
              candidateVersion: upgraded.receipt.target.applicationVersion,
              rollbackVersion: rolled.receipt.active.applicationVersion,
              oldProfileUnchanged: true,
              sqlOccurrenceRetained: true,
              tlsPairingRetained: true,
              managedIrRebased: true,
              cacheRebased: true,
              newerProfileRetained: true,
              disconnected: true,
              hardware: null
            })
          )
        }
        const profile = JSON.parse(await readFile(join(root, 'server.json'), 'utf8'))
        await writeFile(
          join(root, 'server.json'),
          JSON.stringify({ ...profile, libraryRoots: [join(temporary, 'missing-library')] })
        )
        await assert.rejects(cli('start'), /ENOENT/)
        await assert.rejects(access(join(root, 'server.lock')), (error) => error.code === 'ENOENT')
        console.log(
          '[server-cli]',
          JSON.stringify({
            scan: true,
            mode,
            bridgeOnly: mode !== 'console',
            localAuthentication: true,
            tlsPairing: true,
            pathFreeRemoteLibrary: true,
            remotePcmToSimulatedDac: true,
            pcmRms: rms,
            shutdown: true,
            snapshotRestore: mode === 'console',
            configurationMigration,
            ...(dspManagement ? { dspProfileRoundtrip: true, nativeVst3: !!managedDsp.vstNodeId, presetRms } : {})
          })
        )
      } finally {
        clearInterval(deviceClock)
        if (server) {
          server.kill()
          await exited
        }
        await receiver?.close()
        assert.equal(resolve(temporary, '..'), resolve(tmpdir()))
        await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      }
    }
  )
}
module.exports = { registerServerCliTest, serverTestNodeExecutable }
if (require.main === module)
  for (const mode of ['console', 'service-child']) registerServerCliTest(mode)
