import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { connect as tlsConnect } from 'node:tls'
import { dlnaStatus, dlnaPlay } from './dlnaClient.ts'
import {
  chromecastLoad,
  chromecastStatus,
  chromecastStop,
  chromecastStopReceiver
} from './chromecastClient.ts'
import type { CastDevice } from './castBackend.ts'

test('DLNA sampling uses actual transport and source position; cancellation interrupts SOAP', async (t) => {
  const actions: string[] = []
  let stalled!: () => void
  const started = new Promise<void>((resolve) => {
    stalled = resolve
  })
  const server = createServer((req, res) => {
    const action = String(req.headers.soapaction).split('#')[1].replace('"', '')
    actions.push(action)
    req.resume()
    if (action === 'Play') {
      stalled()
      return
    }
    const xml =
      action === 'GetTransportInfo'
        ? '<u:CurrentTransportState>PLAYING</u:CurrentTransportState>'
        : '<RelTime>0:02:13.75</RelTime><TrackDuration>1:03:04.125</TrackDuration>'
    res.end(`<Envelope><Body>${xml}</Body></Envelope>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/control`
  assert.deepEqual(await dlnaStatus(url), {
    state: 'playing',
    position: 133.75,
    duration: 3784.125,
    buffering: false,
    ended: false
  })
  const controller = new AbortController()
  const pending = dlnaPlay(url, controller.signal)
  await started
  controller.abort(new Error('Pause superseded load'))
  await assert.rejects(pending, /Pause superseded/)
  assert.deepEqual(actions.sort(), ['GetPositionInfo', 'GetTransportInfo', 'Play'])
})

function frame(payload: unknown): Buffer {
  const text = Buffer.from(JSON.stringify(payload))
  let n = text.length
  const length: number[] = []
  while (n > 127) {
    length.push((n & 127) | 128)
    n >>>= 7
  }
  length.push(n)
  const body = Buffer.concat([Buffer.from([0x32, ...length]), text])
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

/** Actual Cast v2 frames and message pump, with an in-memory TLS peer. */
function castPeer(receiverSessionId = 'session-1', refuseStop = false, otherReceiverFirst = false) {
  const socket = new EventEmitter() as EventEmitter & {
    write(data: Buffer, callback: (error?: Error) => void): boolean
    setTimeout(): void
    destroy(error?: Error): void
  }
  const commands: Record<string, any>[] = []
  let stopped = false,
    closed = false,
    holdLoad = false
  let notifyLoad!: () => void
  const loading = new Promise<void>((resolve) => {
    notifyLoad = resolve
  })
  const receiver = () => ({
    type: 'RECEIVER_STATUS',
    status: {
      applications: [
        ...(otherReceiverFirst
          ? [{ appId: 'other', transportId: 'other', sessionId: 'other' }]
          : []),
        ...(stopped
          ? []
          : [{ appId: 'CC1AD845', transportId: 'transport-1', sessionId: receiverSessionId }])
      ],
      volume: { level: 0.4 }
    }
  })
  socket.write = (data, callback) => {
    const request = JSON.parse(data.subarray(data.indexOf('{"')).toString())
    const receiverNamespace = data.includes(Buffer.from('com.google.cast.receiver'))
    commands.push(request)
    queueMicrotask(() => {
      callback()
      let reply: Record<string, unknown> | null = null
      switch (request.type) {
        case 'LAUNCH':
          reply = receiver()
          break
        case 'LOAD':
          notifyLoad()
          if (holdLoad) break
          reply = {
            type: 'MEDIA_STATUS',
            status: [
              {
                mediaSessionId: 7,
                playerState: 'PLAYING',
                currentTime: request.currentTime,
                media: { duration: 231 }
              }
            ]
          }
          break
        case 'GET_STATUS':
          reply = receiverNamespace
            ? receiver()
            : {
                type: 'MEDIA_STATUS',
                status: [
                  {
                    mediaSessionId: 7,
                    playerState: 'PAUSED',
                    currentTime: 42.25,
                    media: { duration: 231 }
                  }
                ]
              }
          break
        case 'STOP':
          stopped = !refuseStop
          reply = receiver()
          break
      }
      if (reply && !closed) socket.emit('data', frame({ ...reply, requestId: request.requestId }))
    })
    return true
  }
  socket.setTimeout = () => {}
  socket.destroy = (error) => {
    if (closed) return
    closed = true
    if (error) socket.emit('error', error)
    socket.emit('close')
  }
  const connect = ((_options: unknown, onConnect: () => void) => {
    queueMicrotask(onConnect)
    return socket
  }) as unknown as typeof tlsConnect
  return {
    commands,
    socket,
    connect,
    loading,
    hold: () => {
      holdLoad = true
    },
    closed: () => closed
  }
}
const device: CastDevice = {
  id: 'test-cast',
  protocol: 'chromecast',
  friendlyName: 'Test',
  manufacturer: 'Google',
  modelName: 'Fake',
  location: '127.0.0.1:8009',
  host: '127.0.0.1',
  avTransportUrl: null,
  renderingControlUrl: null,
  lastSeenAt: 0
}

test('Chromecast confirms LOAD, samples real status and stops the exact receiver session', async (t) => {
  const peer = castPeer(),
    controller = new AbortController()
  t.after(() => peer.socket.destroy())
  await chromecastLoad(
    device,
    { deviceId: device.id, mediaUrl: 'http://127.0.0.1/media/opaque', positionSeconds: 18 },
    { confirmed: true, signal: controller.signal, connect: peer.connect }
  )
  controller.abort(new Error('Former renderer detached'))
  assert.equal(
    peer.closed(),
    false,
    'accepted playback does not retain a client cancellation listener'
  )
  assert.deepEqual(await chromecastStatus(device), {
    state: 'paused',
    position: 42.25,
    duration: 231,
    buffering: false,
    ended: false,
    volume: 0.4
  })
  await chromecastStop(device, { confirmed: true })
  const stop = peer.commands.filter((command) => command.type === 'STOP')
  assert.equal(stop.length, 1)
  assert.equal(stop[0].sessionId, 'session-1')
  assert.equal(peer.closed(), true)
  assert.equal(peer.commands.filter((command) => command.type === 'LOAD').length, 1)
})

test('cancelled pending Chromecast LOAD is not replayed and remains stoppable', async (t) => {
  const peer = castPeer(),
    controller = new AbortController()
  peer.hold()
  t.after(() => peer.socket.destroy())
  const pending = chromecastLoad(
    device,
    { deviceId: device.id, mediaUrl: 'http://127.0.0.1/media/opaque' },
    { confirmed: true, signal: controller.signal, connect: peer.connect }
  )
  await peer.loading
  controller.abort(new Error('Stop requested'))
  await assert.rejects(pending, /Stop requested/)
  await chromecastStop(device, { confirmed: true })
  assert.equal(peer.commands.filter((command) => command.type === 'LOAD').length, 1)
  assert.equal(peer.closed(), true)
})

test('Chromecast arms the receiver identity before LOAD; denied supervision never sends LOAD', async (t) => {
  const peer = castPeer()
  t.after(() => peer.socket.destroy())
  await assert.rejects(
    chromecastLoad(
      device,
      { deviceId: device.id, mediaUrl: 'http://127.0.0.1/media/opaque' },
      {
        confirmed: true,
        connect: peer.connect,
        receiverReady: async (sessionId) => {
          assert.equal(sessionId, 'session-1')
          assert.equal(
            peer.commands.some((command) => command.type === 'LOAD'),
            false
          )
          throw new Error('Core epoch expired')
        }
      }
    ),
    /epoch expired/
  )
  assert.equal(
    peer.commands.some((command) => command.type === 'LOAD'),
    false
  )
  await chromecastStop(device, { confirmed: true })
})

test('main crash-stop opens a new connection, confirms the exact receiver stopped and never launches or loads media', async () => {
  const peer = castPeer('session-1', false, true)
  await chromecastStopReceiver('127.0.0.1', 8009, 'session-1', peer.connect)
  assert.deepEqual(
    peer.commands
      .filter((command) => !['CONNECT', 'PING'].includes(command.type))
      .map((command) => command.type),
    ['GET_STATUS', 'STOP']
  )
  assert.equal(peer.commands.find((command) => command.type === 'STOP')?.sessionId, 'session-1')
  assert.equal(peer.closed(), true)
})

test('main crash-stop leaves another controller receiver untouched and rejects an unconfirmed Stop', async () => {
  const other = castPeer('new-session')
  await chromecastStopReceiver('127.0.0.1', 8009, 'session-1', other.connect)
  assert.equal(
    other.commands.some((command) => command.type === 'STOP'),
    false
  )
  assert.equal(other.closed(), true)
  const unconfirmed = castPeer('session-1', true)
  await assert.rejects(
    chromecastStopReceiver('127.0.0.1', 8009, 'session-1', unconfirmed.connect),
    /not confirm Stop/
  )
  assert.equal(unconfirmed.closed(), true)
})
