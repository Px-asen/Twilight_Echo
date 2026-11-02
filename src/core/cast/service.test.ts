import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreCastService } from './service.ts'
import { RemoteHttpServer } from './httpServer.ts'
import { SourceResources } from '../playback/sourceResources.ts'
import type { CastDevice, CastLoadRequest, CastSample } from './castBackend.ts'
import { assertCastUpstream } from './policy.ts'
import type { TrackData } from '../../shared/track.ts'
import type { CastPcmSegments } from './pcmSegments.ts'
import { createCastPcmSegments } from '../../adapters-node/castPcmSegments.ts'

const track: TrackData = {
  id: 'local:one',
  queueEntryId: 'occurrence-1',
  title: 'One',
  artist: 'Artist',
  album: 'Album',
  filePath: '',
  fileName: 'one.mp3',
  duration: 231,
  size: 10,
  cover: null,
  lyrics: null,
  source: 'local'
}
const device: CastDevice = {
  id: 'discovered-device',
  protocol: 'dlna',
  friendlyName: 'Living room',
  manufacturer: 'Test',
  modelName: 'Fake',
  location: 'http://192.168.1.8/device',
  avTransportUrl: 'http://192.168.1.8/av',
  renderingControlUrl: 'http://192.168.1.8/rc',
  lastSeenAt: 0
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(t: test.TestContext, segments?: CastPcmSegments) {
  const directory = await mkdtemp(join(tmpdir(), 'core-cast-'))
  const file = join(directory, 'one.mp3')
  await writeFile(file, '0123456789')
  const resources = new SourceResources()
  const media = new RemoteHttpServer({
    staticRoot: directory,
    addresses: () => ['127.0.0.1'],
    useSource: (action) => resources.use(action)
  })
  const commands: string[] = [],
    loads: CastLoadRequest[] = [],
    observations: CastSample[] = []
  let timer: (() => void) | null = null
  let sample: CastSample = { state: 'playing', position: 20, duration: 231 }
  let rejectLoad = false,
    stopGate: Promise<void> | null = null
  let sampleGate: Promise<void> | null = null
  const service = new CoreCastService({
    resources,
    media,
    authorizeFile: async (path) => {
      assert.equal(path, file)
      return file
    },
    segments,
    backend: {
      discover: async () => [device],
      load: async (_device, request) => {
        loads.push(request)
        if (rejectLoad) throw new Error('LOAD reply lost')
      },
      control: async (_device, command) => {
        commands.push(command)
        if (command === 'stop') await stopGate
      },
      sample: async (_device, signal) => {
        if (sampleGate)
          await Promise.race([
            sampleGate,
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            })
          ])
        return sample
      }
    },
    changed: () => {},
    observe: (value) => observations.push(value),
    failed: (error) => {
      throw error
    },
    schedule: (callback) => {
      timer = callback
      return () => {
        timer = null
      }
    }
  })
  t.after(async () => {
    stopGate = null
    sampleGate = null
    await service.shutdown()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    file, directory,
    media,
    resources,
    service,
    commands,
    loads,
    observations,
    fire: () => {
      const callback = timer
      timer = null
      callback?.()
    },
    timer: () => timer,
    setSample: (value: CastSample) => {
      sample = value
    },
    failLoad: () => {
      rejectLoad = true
    },
    stopGate: (value: Promise<void>) => {
      stopGate = value
    },
    sampleGate: (value: Promise<void>) => {
      sampleGate = value
    }
  }
}

test('Core Cast discovers privately, streams authorized Range media and samples without a renderer', async (t) => {
  const f = await fixture(t)
  await f.service.discover()
  assert.deepEqual(f.service.page(0, 1), {
    offset: 0,
    total: 1,
    items: [
      {
        id: device.id,
        protocol: 'dlna',
        name: device.friendlyName,
        manufacturer: device.manufacturer,
        model: device.modelName
      }
    ]
  })
  await assert.rejects(f.service.select('http://untrusted/control', 0), /not found/)
  await f.service.select(device.id, 0)
  await assert.rejects(f.service.select(device.id, 0), { code: 'STALE_REVISION' })
  const sample = await f.resources.use(() =>
    f.service.load(f.file, track, 20, true, new AbortController().signal)
  )
  assert.equal(sample.position, 20)
  assert.equal(f.service.state().phase, 'ready')
  const url = f.loads[0].mediaUrl
  assert.doesNotMatch(url, /one\.mp3|core-cast/)
  const response = await fetch(url, { headers: { range: 'bytes=3-6' } })
  assert.equal(response.status, 206)
  assert.equal(await response.text(), '3456')
  const base = new URL(url).origin
  for (const path of ['/api/state', '/api/pair', '/', '/api/command']) {
    assert.equal((await fetch(base + path)).status, 404)
  }
  assert.equal(f.media.getStatus().pin, null)
  assert.equal(f.media.getStatus().enabled, false)
  await f.resources.maintain(async () => assert.deepEqual(f.resources.protectedSources(), [f.file]))
  f.setSample({ state: 'paused', position: 31.25, duration: 231 })
  f.fire()
  await tick()
  assert.equal(f.observations[0].position, 31.25)
  assert.ok(f.timer())
  await f.service.end()
  assert.deepEqual(f.resources.protectedSources(), [])
  assert.equal(f.media.getStatus().running, false)
  assert.equal(f.timer(), null)
  assert.equal(f.service.active(), false)
})

test('Cast Stop cancels in-flight sampling, retains source/token until the device stop ACK', async (t) => {
  const f = await fixture(t)
  await f.service.discover()
  await f.service.select(device.id, 0)
  await f.resources.use(() => f.service.load(f.file, track, 0, true, new AbortController().signal))
  f.sampleGate(deferred().promise)
  f.fire()
  const ack = deferred()
  f.stopGate(ack.promise)
  const stopping = f.service.stop()
  await tick()
  assert.deepEqual(f.resources.protectedSources(), [f.file])
  const response = await fetch(f.loads[0].mediaUrl)
  assert.equal(response.status, 200)
  await response.text()
  ack.resolve()
  await stopping
  assert.deepEqual(f.resources.protectedSources(), [])
  assert.equal((await fetch(f.loads[0].mediaUrl)).status, 404)
  assert.equal(f.observations.length, 0)
  assert.equal(f.timer(), null)
  assert.deepEqual(f.commands, ['stop'])
})

test('unknown Cast LOAD is not replayed; explicit Stop releases its retained source', async (t) => {
  const f = await fixture(t)
  await f.service.discover()
  await f.service.select(device.id, 0)
  f.failLoad()
  await assert.rejects(
    f.resources.use(() => f.service.load(f.file, track, 0, true, new AbortController().signal)),
    /reply lost/
  )
  assert.equal(f.loads.length, 1)
  assert.equal(f.service.state().phase, 'failed')
  assert.deepEqual(f.resources.protectedSources(), [f.file])
  assert.equal(f.timer(), null)
  await f.service.stop()
  assert.deepEqual(f.resources.protectedSources(), [])
  assert.equal(f.loads.length, 1)
})

test('Cast rejects unavailable segment preparation and native-only subtracks before dispatch, preserving upstream authorization', async (t) => {
  const f = await fixture(t)
  await f.service.discover()
  await f.service.select(device.id, 0)
  for (const extra of [
    { subTrack: 'disc.iso?area=stereo&track=1' },
    { cueRange: { startSeconds: 10, endSeconds: 20, pregapSeconds: 0 } }
  ]) {
    await assert.rejects(
      f.resources.use(() =>
        f.service.load(f.file, { ...track, ...extra }, 0, true, new AbortController().signal)
      ),
      /does not support|unavailable/
    )
  }
  assert.equal(f.loads.length, 0)
  for (const url of [
    'http://127.0.0.1/a',
    'http://192.168.1.8/a',
    'https://localhost/a',
    'https://user:secret@example.com/a',
    'file:///audio.mp3'
  ]) {
    assert.throws(() => assertCastUpstream(url), /not authorized/)
  }
  assert.doesNotThrow(() => assertCastUpstream('https://example.com/audio.mp3?token=secret'))
})

test('Cast CUE serves only the completed WAV with relative time, Range and Stop-ACK lifetime', async (t) => {
  const requests: unknown[] = []
  let output = ''
  const f = await fixture(t, {
    prepare: async (source, range, signal) => {
      const segments = createCastPcmSegments({
        root: join(f.directory, 'cast-media'),
        render: async (input, request, abort) => {
          assert.equal(input, source)
          assert.equal(abort, signal)
          requests.push(request)
          output = request.outputPath
          await writeFile(output, 'RIFF-only-selected-segment')
        }
      })
      return segments.prepare(source, range, signal)
    }
  })
  await f.service.discover()
  await f.service.select(device.id, 0)
  const cue = { ...track, cueRange: {
    startSeconds: 20, endSeconds: 40, pregapSeconds: 2,
    virtualPregapSeconds: 2, sourcePregapSeconds: 1
  } }
  f.setSample({ state: 'paused', position: 12.75, duration: 22 })
  const sample = await f.resources.use(() =>
    f.service.load(f.file, cue, 12.75, false, new AbortController().signal))
  assert.equal(sample.position, 12.75)
  assert.equal(sample.duration, 22)
  assert.deepEqual(requests, [{ outputPath: output, startSeconds: 20,
    endSeconds: 40, virtualPregapSeconds: 2 }])
  assert.equal(f.loads[0].positionSeconds, 12.75)
  assert.equal(f.loads[0].autoplay, false)
  assert.equal(f.loads[0].contentType, 'audio/wav')
  assert.deepEqual(f.resources.protectedSources(), [f.file, output])
  assert.doesNotMatch(f.loads[0].mediaUrl, /audio.wav|one.mp3|cast-media/)
  const response = await fetch(f.loads[0].mediaUrl, { headers: { range: 'bytes=5-8' } })
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-type'), 'audio/wav')
  assert.equal(await response.text(), 'only')
  const ack = deferred()
  f.stopGate(ack.promise)
  const stopped = f.service.stop()
  await tick()
  assert.equal(await readFile(output, 'utf8'), 'RIFF-only-selected-segment')
  ack.resolve()
  await stopped
  await assert.rejects(access(output), { code: 'ENOENT' })
  assert.equal((await fetch(f.loads[0].mediaUrl)).status, 404)
  assert.deepEqual(f.resources.protectedSources(), [])
  assert.deepEqual(await readdir(join(f.directory, 'cast-media')), [])
})

test('cancelled CUE preparation joins the writer, removes partial output and never issues a whole-file URL', async (t) => {
  let started!: () => void, retire!: () => void
  const writing = new Promise<void>(resolve => { started = resolve })
  const exited = new Promise<void>(resolve => { retire = resolve })
  let output = '', root = ''
  const f = await fixture(t, {
    prepare: (source, range, signal) => createCastPcmSegments({
      root: root = join(f.directory, 'cancelled'),
      render: async (_source, request, abort) => {
        output = request.outputPath
        await writeFile(output, 'partial')
        started()
        await exited
        abort.throwIfAborted()
      }
    }).prepare(source, range, signal)
  })
  await f.service.discover()
  await f.service.select(device.id, 0)
  const abort = new AbortController()
  const work = f.resources.use(() => f.service.load(f.file, { ...track,
    cueRange: { startSeconds: 20, endSeconds: 40, pregapSeconds: 0 }
  }, 0, true, abort.signal))
  const rejected = assert.rejects(work, /superseded/)
  await writing
  abort.abort(new Error('superseded'))
  assert.equal(await readFile(output, 'utf8'), 'partial')
  assert.equal(f.loads.length, 0)
  retire()
  await rejected
  assert.deepEqual(await readdir(root), [])
  assert.equal(f.loads.length, 0)
  assert.equal(f.media.getStatus().running, false)
})

test('unknown CUE LOAD retains its generated file until an explicit acknowledged Stop', async (t) => {
  let released = false
  const f = await fixture(t, {
    prepare: async () => ({ path: join(f.directory, 'segment.wav'),
      release: async () => { released = true } })
  })
  await f.service.discover()
  await f.service.select(device.id, 0)
  f.failLoad()
  await assert.rejects(f.resources.use(() => f.service.load(f.file, { ...track,
    cueRange: { startSeconds: 20, endSeconds: 40, pregapSeconds: 0 }
  }, 0, true, new AbortController().signal)), /reply lost/)
  assert.equal(released, false)
  assert.equal(f.loads.length, 1)
  assert.equal(f.resources.protectedSources().length, 2)
  await f.service.stop()
  assert.equal(released, true)
  assert.deepEqual(f.resources.protectedSources(), [])
})

test('remote CUE stages source bytes without native redirects and releases failed staging', async (t) => {
  const f = await fixture(t)
  const root = join(f.directory, 'remote')
  let renderCalls = 0, inputPath = ''
  let refused = false
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (refused) throw new TypeError('redirect refused')
    assert.equal(url, 'https://example.com/disc.flac?token=private')
    assert.equal(options.redirect, 'error')
    return new Response(new Uint8Array([1, 2, 3, 4]))
  })
  const segments = createCastPcmSegments({ root,
    render: async (source, request) => {
      renderCalls++
      inputPath = source
      assert.deepEqual(await readFile(source), Buffer.from([1, 2, 3, 4]))
      assert.doesNotMatch(source, /https|token/)
      await writeFile(request.outputPath, 'segment')
    }
  })
  const range = { startSeconds: 20, endSeconds: 40, pregapSeconds: 0 }
  const prepared = await segments.prepare('https://example.com/disc.flac?token=private', range,
    new AbortController().signal)
  await assert.rejects(access(inputPath), { code: 'ENOENT' })
  assert.equal(await readFile(prepared.path, 'utf8'), 'segment')
  await prepared.release()
  refused = true
  await assert.rejects(segments.prepare('https://example.com/disc.flac', range,
    new AbortController().signal), /redirect refused/)
  assert.equal(renderCalls, 1)
  assert.deepEqual(await readdir(root), [])
})

test('first CUE preparation clears abandoned Core media but subsequent prepares keep live files', async (t) => {
  const f = await fixture(t)
  const root = join(f.directory, 'recover')
  await mkdir(join(root, 'segment-abandoned'), { recursive: true })
  await writeFile(join(root, 'segment-abandoned', 'audio.wav'), 'abandoned')
  await writeFile(join(root, 'keep.txt'), 'unrelated')
  const segments = createCastPcmSegments({ root,
    render: async (_source, request) => { await writeFile(request.outputPath, 'prepared') }
  })
  const range = { startSeconds: 0, endSeconds: 20, pregapSeconds: 0 }
  const first = await segments.prepare(f.file, range, new AbortController().signal)
  await assert.rejects(access(join(root, 'segment-abandoned')), { code: 'ENOENT' })
  assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'unrelated')
  const second = await segments.prepare(f.file, range, new AbortController().signal)
  assert.equal(await readFile(first.path, 'utf8'), 'prepared')
  await first.release(); await second.release()
  assert.deepEqual(await readdir(root), ['keep.txt'])
})

test('HTTP requests waiting on maintenance recheck revoked tokens before opening a file', async (t) => {
  const f = await fixture(t)
  await f.service.discover()
  await f.service.select(device.id, 0)
  await f.resources.use(() => f.service.load(f.file, track, 0, true, new AbortController().signal))
  const gate = deferred()
  const maintaining = f.resources.maintain(() => gate.promise)
  const response = fetch(f.loads[0].mediaUrl)
  await tick()
  // Revocation while a request waits for the maintenance barrier must not open the file later.
  await f.service.stop()
  gate.resolve()
  await maintaining
  assert.equal((await response).status, 404)
})
