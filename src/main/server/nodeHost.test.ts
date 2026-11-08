import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createServer, createConnection } from 'node:net'
import { serialize } from 'node:v8'
import { createNodeServiceChannel, NodeSupervisedProcess } from './nodeHost.ts'
import { SocketMessagePort } from './socketPort.ts'

test(
  'explicit desktop runtime preserves bootstrap resources and launch flags while Server keeps its default',
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'twilight-desktop-node-host-'))
    t.after(async () => {
      assert.equal(resolve(root, '..'), resolve(tmpdir()))
      await rm(root, { recursive: true, force: true })
    })
    const bootstrap = join(root, 'bootstrap.cjs')
    buildSync({
      entryPoints: [resolve('src/main/server/bootstrap.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bootstrap,
      banner: { js: 'const __entryUrl = require("node:url").pathToFileURL(__filename).href;' },
      define: { 'import.meta.url': '__entryUrl' }
    })
    const entry = join(root, 'entry.cjs')
    await writeFile(
      entry,
      `process.parentPort.on('message', event => process.parentPort.postMessage({ echo: event.data })); process.parentPort.postMessage({ resources: process.resourcesPath, execPath: process.execPath, execArgv: process.execArgv });`
    )
    const child = new NodeSupervisedProcess({
      execPath: process.execPath,
      execArgv: ['--max-old-space-size=64'],
      bootstrap,
      entry,
      args: [],
      cwd: root,
      env: {
        ...process.env,
        TWILIGHT_DESKTOP_NODE_HOST: '1',
        TWILIGHT_DESKTOP_RESOURCES_PATH: root
      }
    })
    const exit = once(child, 'exit')
    try {
      const [reply] = await once(child, 'message')
      assert.equal(reply.resources, root)
      assert.equal(reply.execPath, process.execPath)
      assert.deepEqual(reply.execArgv, ['--max-old-space-size=64'])
      assert.equal(child.pid, child.child.pid)
      assert.equal(child.stdout, child.child.stdout)
      assert.equal(child.stderr, child.child.stderr)
      const message = {
        bytes: Buffer.from([1, 128, 255]),
        values: new Float32Array([0.25, -0.5]),
        big: 123n,
        omitted: undefined,
        map: new Map([['one', 1]])
      }
      const echoed = once(child, 'message')
      child.postMessage(message)
      assert.deepEqual((await echoed)[0].echo, message)
    } finally {
      child.kill()
      await exit
    }
  }
)

const require = createRequire(import.meta.url)
const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')

test(
  'two Node processes exchange binary business messages directly over transferred sockets',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'twilight-node-host-'))
    const children: NodeSupervisedProcess[] = []
    try {
      const bootstrap = join(root, 'bootstrap.cjs')
      buildSync({
        entryPoints: [resolve('src/main/server/bootstrap.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: bootstrap,
        banner: { js: 'const __entryUrl = require("node:url").pathToFileURL(__filename).href;' },
        define: { 'import.meta.url': '__entryUrl' }
      })
      const entry = join(root, 'peer.cjs')
      await writeFile(
        entry,
        `
      const p = process.parentPort;
      p.on('message', e => {
        const peer = e.ports[0];
        if (e.data.role === 'echo') {
          peer.on('message', e => peer.postMessage(e.data)); peer.start();
        } else {
          peer.on('message', e => p.postMessage({kind:'result', value:e.data})); peer.start();
          peer.postMessage({bytes:new Uint8Array([0,128,255]), buffer:new Float32Array([.25,-.5]).buffer, big:42n, map:new Map([['a',7]])});
        }
      });
      p.postMessage({kind:'booted'});
    `
      )
      const launch = async () => {
        const child = new NodeSupervisedProcess({ bootstrap, entry, args: [], cwd: root })
        children.push(child)
        child.child.stderr!.on('data', (data) => process.stderr.write(data))
        await once(child, 'message')
        return child
      }
      const a = await launch(),
        b = await launch()
      const { port1, port2 } = createNodeServiceChannel()
      const result = once(b, 'message')
      a.postMessage({ role: 'echo' }, [port1])
      b.postMessage({ role: 'source' }, [port2])
      const [reply] = await result
      assert.equal(reply.kind, 'result')
      assert.deepEqual(reply.value.bytes, new Uint8Array([0, 128, 255]))
      assert.deepEqual(new Float32Array(reply.value.buffer), new Float32Array([0.25, -0.5]))
      assert.equal(reply.value.big, 42n)
      assert.equal(reply.value.map.get('a'), 7)
      // Neither source nor echo sends the request/reply payload through parent IPC.
      assert.throws(() => port1.postMessage({}), /must be transferred/)
      assert.throws(() => port2.on('message', () => {}), /cannot read/)
    } finally {
      await Promise.all(
        children.map(async (child) => {
          const exit = once(child, 'exit')
          child.kill()
          await exit
        })
      )
      assert.equal(resolve(root, '..'), resolve(tmpdir()))
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('socket port waits for start and parses fragmented and coalesced frames in order', async () => {
  const server = createServer({ pauseOnConnect: true })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const connection = once(server, 'connection')
  const sender = createConnection((server.address() as { port: number }).port, '127.0.0.1')
  const [receiver] = await connection
  const port = new SocketMessagePort(receiver)
  const frame = (value: unknown) => {
    const body = serialize(value),
      header = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    return Buffer.concat([header, body])
  }
  try {
    const values: unknown[] = []
    const completed = new Promise<void>((resolve) =>
      port.on('message', (e) => {
        values.push(e.data)
        if (values.length === 3) resolve()
      })
    )
    const first = frame('first')
    sender.write(first.subarray(0, 2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(values, [])
    port.start()
    sender.write(
      Buffer.concat([first.subarray(2), frame(new Uint8Array(32 * 1024 * 1024)), frame('last')])
    )
    await completed
    assert.equal(values[0], 'first')
    assert.deepEqual(values[1], new Uint8Array(32 * 1024 * 1024))
    assert.equal(values[2], 'last')
    const closed = once(port, 'close')
    sender.destroy()
    await closed
    assert.throws(() => port.postMessage('late'), /closed/)
  } finally {
    port.close()
    sender.destroy()
    server.close()
  }
})
