import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../ui/bridge.js', import.meta.url), 'utf8')

function fixture() {
  const events = new Map()
  const window = {
    addEventListener(name, callback, options) {
      if (!events.has(name)) events.set(name, new Map())
      events.get(name).set(callback, options?.once)
    },
    removeEventListener(name, callback) {
      events.get(name)?.delete(callback)
    },
    emit(name, value) {
      for (const [callback, once] of [...(events.get(name) ?? [])]) {
        if (once) events.get(name).delete(callback)
        callback(value)
      }
    }
  }
  const messages = []
  const parent = { postMessage: (message) => messages.push(message) }
  const port = {
    messages: [],
    started: false,
    closed: false,
    start() {
      this.started = true
    },
    close() {
      this.closed = true
    },
    postMessage(message) {
      this.messages.push(message)
    },
    receive(data) {
      this.onmessage({ data })
    }
  }
  const connect = vm.runInNewContext(
    source.replace('export function connectExperience', 'function connectExperience') +
      '\nconnectExperience',
    { window, parent, setTimeout, clearTimeout }
  )
  const handshake = (patch) =>
    window.emit('message', {
      source: parent,
      data: { type: 'twilight-experience-connect', bridgeVersion: 2 },
      ports: [port],
      ...patch
    })
  return { window, parent, events, messages, port, connect, handshake }
}

async function connected() {
  const f = fixture()
  const ready = f.connect()
  f.handshake()
  return { ...f, client: await ready }
}

test('handshake accepts only its parent, bridge v2 and a transferred port', async () => {
  const f = fixture()
  const ready = f.connect()
  assert.equal(f.messages[0].type, 'twilight-experience-ready')
  assert.equal(f.messages[0].bridgeVersion, 2)
  f.handshake({ source: {} })
  f.handshake({ data: { type: 'twilight-experience-connect', bridgeVersion: 1 } })
  f.handshake({ ports: [] })
  assert.equal(f.port.started, false)
  f.handshake()
  const client = await ready
  assert.equal(f.port.started, true)
  assert.equal(f.events.get('message').size, 0)
  client.dispose()
})

test('requests correlate out-of-order values and errors; events unsubscribe', async () => {
  const { client, port } = await connected()
  const first = client.call('player.state')
  const second = client.call('player.volume', { value: 0.5 })
  const denied = assert.rejects(second, /operation denied/)
  port.receive({ id: port.messages[1].id, error: 'operation denied' })
  port.receive({ id: port.messages[0].id, value: { playing: false } })
  assert.equal((await first).playing, false)
  await denied
  const received = []
  const stop = client.on('player', (value) => received.push(value))
  port.receive({ event: 'player', value: 1 })
  stop()
  port.receive({ event: 'player', value: 2 })
  assert.deepEqual(received, [1])
  client.dispose()
})

test('client bounds concurrency at 16 and releases completed request slots', async () => {
  const { client, port } = await connected()
  const pending = Array.from({ length: 16 }, () => client.call('player.state'))
  await assert.rejects(client.call('player.state'), /请求过多/)
  for (const { id } of port.messages) port.receive({ id, value: null })
  await Promise.all(pending)
  const next = client.call('host.environment')
  port.receive({ id: port.messages.at(-1).id, value: { reducedMotion: true } })
  assert.equal((await next).reducedMotion, true)
  client.dispose()
})

test('timeout ignores a late reply and never retries a mutation', async () => {
  const { client, port } = await connected()
  await assert.rejects(client.call('player.volume', { value: 0.5 }, 5), /操作超时/)
  assert.equal(port.messages.length, 1)
  port.receive({ id: port.messages[0].id, value: null })
  const next = client.call('player.state')
  port.receive({ id: port.messages[1].id, value: { volume: 0.5 } })
  assert.equal((await next).volume, 0.5)
  client.dispose()
})

test('pagehide rejects pending work, closes the port and blocks further requests', async () => {
  const { client, window, port } = await connected()
  const rejected = assert.rejects(client.call('player.state'), /连接已关闭/)
  window.emit('pagehide')
  await rejected
  assert.equal(port.closed, true)
  await assert.rejects(client.call('player.state'), /连接已关闭/)
  client.dispose()
})

test('a failed postMessage releases its pending slot', async () => {
  const { client, port } = await connected()
  port.postMessage = () => {
    throw new Error('cannot clone')
  }
  for (let i = 0; i < 17; i++) await assert.rejects(client.call('player.state'), /cannot clone/)
  client.dispose()
})

test('missing host and cancelled handshake clean up their listeners', async () => {
  const f = fixture()
  await assert.rejects(f.connect(5), /未连接到 Twilight Echo/)
  assert.equal(f.events.get('message').size, 0)
  const cancelled = assert.rejects(f.connect(), /界面已关闭/)
  f.window.emit('pagehide')
  await cancelled
  assert.equal(f.events.get('message').size, 0)
})

test('the guide manifest is the installable example manifest', async () => {
  const guide = await readFile(
    new URL('../../../../docs/plugin-full-interface.md', import.meta.url),
    'utf8'
  )
  const manifest = JSON.parse(await readFile(new URL('../plugin.json', import.meta.url), 'utf8'))
  const snippet = JSON.parse(guide.match(/```json\n([\s\S]*?)\n```/)[1])
  assert.deepEqual(snippet, manifest)
})
