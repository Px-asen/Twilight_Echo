'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { fork } = require('node:child_process')
const { createServer } = require('node:http')
const { mkdtemp, writeFile, readFile, readdir, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, dirname, sep } = require('node:path')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')

test('real analysis worker and native decoder serve a bounded CUE WAV through actual DLNA SOAP and HTTP Range',
  { timeout: 30000 }, async (t) => {
    const root = resolve(__dirname, '..')
    const addon = resolve(process.env.TWILIGHT_SEGMENT_NATIVE_BINDING ||
      join(root, 'resources/audio-engine/twilight_audio_node.node'))
    const directory = await mkdtemp(join(tmpdir(), 'twilight-cue-cast-'))
    const children = new Set()
    let analysis, cast, server
    t.after(async () => {
      await cast?.shutdown()
      analysis?.destroy()
      await Promise.all([...children].map(child => new Promise(resolve => {
        child.once('exit', resolve); child.kill()
      })))
      if (server) {
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
      }
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
      await rm(directory, { recursive: true, force: true })
    })
    const worker = join(directory, 'analysis.cjs')
    await build({
      stdin: { contents: "import './src/adapters-node/index.ts'; import './src/main/audioAnalysisService.ts'", resolveDir: root },
      outfile: worker, bundle: true, platform: 'node', format: 'cjs', packages: 'external', external: ['*.node'],
      banner: { js: `module.paths.unshift(${JSON.stringify(join(root, 'node_modules'))});` },
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(join(root, 'src/main/audioAnalysisService.ts')).href) },
      plugins: [{ name: 'test-native-location', setup(builder) {
        builder.onLoad({ filter: /main[\\/]audioAnalysisService\.ts$/ }, async (args) => {
          const source = await readFile(args.path, 'utf8')
          const contents = source.replace('const nativeLoad = loadNativeBindingWithDiagnostics()',
            `const nativeLoad = { binding: require(${JSON.stringify(addon)}), attempts: [], candidateCount: 1 }`)
          assert.notEqual(contents, source)
          return { contents, loader: 'ts', resolveDir: dirname(args.path) }
        })
      } }]
    })
    await import('../src/adapters-node/index.ts')
    const [{ AudioAnalysisServiceClient }, { CoreCastService }, { createCastPcmSegments },
      { RemoteHttpServer }, { SourceResources }, { createCastBackend }, soap] = await Promise.all([
      import('../src/main/audioAnalysisServiceClient.ts'), import('../src/core/cast/service.ts'),
      import('../src/adapters-node/castPcmSegments.ts'), import('../src/core/cast/httpServer.ts'),
      import('../src/core/playback/sourceResources.ts'), import('../src/core/cast/backend.ts'),
      import('../src/shared/soap.ts')
    ])
    const rate = 44100, stride = 6, frames = rate * 3
    const pcm = Buffer.alloc(frames * stride)
    for (let index = 0; index < frames * 2; index++)
      pcm.writeIntLE(((index * 100003 + 17) % 0x1000000) - 0x800000, index * 3, 3)
    const header = Buffer.alloc(44)
    header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8)
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22)
    header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * stride, 28)
    header.writeUInt16LE(stride, 32); header.writeUInt16LE(24, 34)
    header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
    const source = join(directory, '中文 # 百分号 %.wav')
    await writeFile(source, Buffer.concat([header, pcm]))
    analysis = new AudioAnalysisServiceClient({ serviceEntry: worker, launch: () => {
      const child = fork(worker, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
      children.add(child)
      child.once('exit', () => children.delete(child))
      child.stdout.on('data', bytes => process.stdout.write(bytes))
      child.stderr.on('data', bytes => process.stderr.write(bytes))
      child.postMessage = message => child.send(message)
      return child
    } })
    const resources = new SourceResources()
    const media = new RemoteHttpServer({ staticRoot: directory, addresses: () => ['127.0.0.1'],
      useSource: action => resources.use(action) })
    let current = 0, duration = 0, state = 'STOPPED', url = ''
    const actions = [], seeks = [], received = []
    let receiverError
    server = createServer(async (req, res) => {
      try {
        let body = ''
        for await (const chunk of req) body += chunk
        const action = String(req.headers.soapaction).split('#')[1]?.replace('"', '')
        actions.push(action)
        if (action === 'SetAVTransportURI') {
          url = /<CurrentURI>(.*?)<\/CurrentURI>/.exec(body)[1].replaceAll('&amp;', '&')
          assert.ok(body.includes('audio/wav'))
          const range = await fetch(url, { headers: { range: 'bytes=0-43' } })
          assert.equal(range.status, 206)
          assert.equal(range.headers.get('content-type'), 'audio/wav')
          assert.equal(Buffer.from(await range.arrayBuffer()).toString('ascii', 0, 4), 'RIFF')
          const response = await fetch(url)
          assert.equal(response.status, 200)
          const bytes = Buffer.from(await response.arrayBuffer())
          received.push(bytes)
          duration = bytes.readUInt32LE(40) / stride / rate
          current = 0; state = 'STOPPED'
        }
        if (action === 'Play') state = 'PLAYING'
        if (action === 'Pause') state = 'PAUSED_PLAYBACK'
        if (action === 'Stop') state = 'STOPPED'
        if (action === 'Seek') {
          current = soap.parseUpnpTime(/<Target>(.*?)<\/Target>/.exec(body)[1])
          seeks.push(current)
        }
        res.end(`<Envelope><Body><CurrentTransportState>${state}</CurrentTransportState>` +
          `<RelTime>${soap.formatUpnpTime(current)}</RelTime>` +
          `<TrackDuration>${soap.formatUpnpTime(duration)}</TrackDuration></Body></Envelope>`)
      } catch (error) { receiverError = error; res.writeHead(500); res.end(String(error)) }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const device = { id: 'loopback-only', protocol: 'dlna', friendlyName: 'Silent receiver',
      manufacturer: 'Test', modelName: 'Fixture', location: 'http://127.0.0.1',
      avTransportUrl: `http://127.0.0.1:${server.address().port}/control`,
      renderingControlUrl: null, lastSeenAt: 0 }
    const { discoverDlnaDevices } = await import('../src/adapters-node/dlnaDiscovery.ts')
    const backend = createCastBackend({ arm: async () => {}, disarm: async () => {} }, discoverDlnaDevices)
    cast = new CoreCastService({ backend: { ...backend, discover: async () => [device] },
      media, resources, authorizeFile: async path => { assert.equal(path, source); return path },
      segments: createCastPcmSegments({ root: join(directory, 'cast-media'),
        render: (path, request, signal) => analysis.renderCastPcmSegment(path, request, signal) }),
      changed: () => {}, observe: () => {}, failed: error => assert.fail(error.message),
      schedule: () => () => {} })
    await cast.discover(); await cast.select(device.id, 0)
    const cueRange = { startSeconds: 1, endSeconds: 2.5, pregapSeconds: 0.2,
      virtualPregapSeconds: 0.2, sourcePregapSeconds: 0.1 }
    const track = { id: 'local:cue:one', source: 'local', title: 'Selected CUE', artist: 'Artist',
      album: 'Album', filePath: source, fileName: 'disc.wav', duration: 1.7,
      size: pcm.length + 44, cover: null, lyrics: null, cueRange }
    const sample = await resources.use(() => cast.load(source, track, 0.125, true, new AbortController().signal))
    if (receiverError) throw receiverError
    assert.equal(sample.position, 0.125)
    assert.equal(sample.duration, 1.7)
    assert.deepEqual(seeks, [0.125], 'sub-second CUE resume must not be discarded')
    const bytes = received[0]
    const silenceBytes = Math.round(0.2 * rate) * stride
    assert.equal(bytes.length, 44 + (Math.round(1.5 * rate) + Math.round(0.2 * rate)) * stride)
    assert.deepEqual(bytes.subarray(44, 44 + silenceBytes), Buffer.alloc(silenceBytes))
    assert.deepEqual(bytes.subarray(44 + silenceBytes), pcm.subarray(rate * stride, Math.round(2.5 * rate) * stride))
    assert.equal(bytes.readUInt16LE(34), 24)
    assert.equal(bytes.readUInt32LE(24), rate)
    assert.equal((await cast.control('seek', 1.25)).position, 1.25)
    assert.equal((await cast.control('pause')).state, 'paused')
    assert.equal((await cast.control('play')).state, 'playing')
    assert.equal(received.length, 1, 'seek and pause/resume reuse the same prepared segment')
    const oldUrl = url
    await cast.stop()
    assert.equal((await fetch(oldUrl)).status, 404)
    assert.deepEqual(await readdir(join(directory, 'cast-media')), [])
    assert.deepEqual(resources.protectedSources(), [])
    assert.equal(actions.filter(action => action === 'SetAVTransportURI').length, 1)
    console.log(JSON.stringify({ nativeWorker: true, channels: 2, bitDepth: 24, sampleRate: rate,
      segmentFrames: bytes.readUInt32LE(40) / stride, virtualPregapFrames: silenceBytes / stride,
      sourceFrames: Math.round(1.5 * rate), exactPcm: true, relativeSeeks: seeks,
      range: true, stopRevoked: true, filesReleased: true }))
  })
