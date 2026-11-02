import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { discoverDlnaDevices } from './dlnaDiscovery.ts'
import { discoverDlnaDevices as desktopDiscovery, dlnaSeek } from '../main/remote/dlnaClient.ts'
import { dlnaSeek as portableSeek } from '../core/cast/dlnaClient.ts'

const response = (id: string, location: string, status = 200) => Buffer.from([
  `HTTP/1.1 ${status} OK`, `USN: uuid:${id}`, `LOCATION: ${location}`, '', ''
].join('\r\n'))

const description = (name: string) => `<root><device><friendlyName>${name}</friendlyName>
  <manufacturer>Test</manufacturer><modelName>Renderer</modelName><serviceList>
  <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
  <controlURL>/transport</controlURL></service>
  <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
  <controlURL>volume</controlURL></service></serviceList></device></root>`

function peer(messages: Uint8Array[]) {
  const socket = new EventEmitter() as EventEmitter & {
    bind(port: number, ready: () => void): void
    setBroadcast(enabled: boolean): void
    send(data: Uint8Array, offset: number, length: number, port: number, host: string): void
    close(): void
  }
  const packets: string[] = []
  let closed = false
  socket.bind = (port, ready) => { assert.equal(port, 0); ready() }
  socket.setBroadcast = enabled => assert.equal(enabled, true)
  socket.send = (data, offset, length, port, host) => {
    if (closed) throw new Error('socket closed')
    assert.equal(port, 1900)
    assert.equal(host, '239.255.255.250')
    packets.push(Buffer.from(data.subarray(offset, offset + length)).toString('utf8'))
    messages.forEach(message => socket.emit('message', message))
  }
  socket.close = () => { closed = true }
  return { socket, packets, closed: () => closed }
}

test('desktop DLNA entry retains discovery options and portable SOAP exports', async () => {
  assert.equal(desktopDiscovery, discoverDlnaDevices)
  assert.equal(dlnaSeek, portableSeek)
  const p = peer([
    response('z', 'http://192.0.2.2/device.xml'),
    response('a', 'http://192.0.2.1/device.xml'),
    response('a', 'http://192.0.2.1/device.xml'),
    response('refused', 'http://192.0.2.3/device.xml'),
    response('not-ok', 'http://192.0.2.4/device.xml', 500),
    Buffer.from('not SSDP')
  ])
  const devices = await desktopDiscovery({
    timeoutMs: 10,
    createSocket: type => { assert.equal(type, 'udp4'); return p.socket },
    fetchText: async url => {
      if (url.includes('192.0.2.3')) throw new Error('description refused')
      return description(url.includes('192.0.2.1') ? 'Alpha' : 'Zulu')
    }
  })
  assert.deepEqual(devices.map(device => device.usn), ['uuid:a', 'uuid:z'])
  assert.equal(devices[0].avTransportUrl, 'http://192.0.2.1/transport')
  assert.equal(devices[0].renderingControlUrl, 'http://192.0.2.1/volume')
  assert.equal(p.closed(), true)
  assert.match(p.packets[0], /^M-SEARCH \* HTTP\/1\.1/)
})

test('Node DLNA discovery retains socket-error completion', async () => {
  assert.deepEqual(await discoverDlnaDevices({ createSocket: () => { throw new Error('no UDP') } }), [])
  const p = peer([])
  const pending = discoverDlnaDevices({ timeoutMs: 1000, createSocket: () => p.socket })
  p.socket.emit('error', new Error('UDP unavailable'))
  assert.deepEqual(await pending, [])
  assert.equal(p.closed(), true)
})

test('CUE files and TLS issuance work in a fresh Node host without the legacy port bootstrap', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-cast-platform-'))
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  })
  const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href)
  const script = `
    import assert from 'node:assert/strict';
    import { writeFile, readFile, readdir } from 'node:fs/promises';
    import { join } from 'node:path';
    import { X509Certificate, createPrivateKey } from 'node:crypto';
    import { hasCorePorts } from ${moduleUrl('../core/ports/index.ts')};
    import { createCastPcmSegments } from ${moduleUrl('./castPcmSegments.ts')};
    import { createRemoteTlsIdentity } from ${moduleUrl('./remoteTlsIdentity.ts')};
    import { certificateFingerprint, remotePairingCode } from ${moduleUrl('../core/cast/tlsIdentity.ts')};
    assert.equal(hasCorePorts(), false);
    const identity = createRemoteTlsIdentity('Fresh host');
    const certificate = new X509Certificate(identity.cert);
    assert.equal(certificate.checkPrivateKey(createPrivateKey(identity.key)), true);
    assert.equal(certificateFingerprint(identity.cert), certificate.fingerprint256.replaceAll(':', '').toLowerCase());
    assert.equal(remotePairingCode('AB'.repeat(32), 'phone-nonce', 'server-nonce'), '133668');
    const root = join(${JSON.stringify(directory)}, 'media');
    const segments = createCastPcmSegments({ root, render: async (source, request) => {
      assert.equal(source, 'authorized-source');
      assert.equal(request.startSeconds, 1);
      assert.equal(request.endSeconds, 2);
      assert.equal(request.virtualPregapSeconds, 0.25);
      await writeFile(request.outputPath, 'bounded-pcm');
    }});
    const media = await segments.prepare('authorized-source', {
      startSeconds: 1, endSeconds: 2, pregapSeconds: 1, virtualPregapSeconds: 0.25
    }, new AbortController().signal);
    assert.equal(await readFile(media.path, 'utf8'), 'bounded-pcm');
    await media.release();
    assert.deepEqual(await readdir(root), []);
    assert.equal(hasCorePorts(), false);
    console.log('fresh-node-cast-host: passed');
  `
  const result = await promisify(execFile)(process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script])
  assert.match(result.stdout, /fresh-node-cast-host: passed/)
})
