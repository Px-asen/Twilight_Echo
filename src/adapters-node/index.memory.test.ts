import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

test('registering Node ports leaves optional builtins unloaded and first use preserves synchronous APIs', () => {
  const adapterUrl = JSON.stringify(new URL('./index.ts', import.meta.url).href)
  const portsUrl = JSON.stringify(new URL('../core/ports/index.ts', import.meta.url).href)
  // A fresh process keeps the test runner's own HTTP/crypto imports from hiding
  // eager adapter loads. Preload the portable types to exclude the TS runtime.
  const script = `
    import assert from 'node:assert/strict'
    import { createRequire } from 'node:module'
    const require = createRequire(${adapterUrl})
    const { getCorePorts } = await import(${portsUrl})
    const before = new Set(process.moduleLoadList)
    const { nodeCorePorts: ports, createNodeCorePorts } = await import(${adapterUrl})
    assert.equal(getCorePorts(), ports)
    assert.equal(createNodeCorePorts().process.platform, process.platform)
    for (const name of ['http', 'https', 'tls', 'dgram', 'zlib', 'crypto', 'internal/deps/undici/undici']) {
      assert.ok(!process.moduleLoadList.some(entry => entry === 'NativeModule ' + name && !before.has(entry)), name + ' loaded during registration')
    }

    // Reading just fs must not initialize unrelated services; returned ports
    // retain native constructors, constants and immediate return values.
    assert.equal(ports.fs.existsSync, require('node:fs').existsSync)
    assert.equal(ports.fs.existsSync(new URL(${adapterUrl})), true)
    assert.ok(!process.moduleLoadList.includes('NativeModule https'))
    for (const [name, module] of [
      ['fs', 'node:fs'], ['fsPromises', 'node:fs/promises'], ['os', 'node:os'],
      ['http', 'node:http'], ['https', 'node:https'], ['net', 'node:net'],
      ['dgram', 'node:dgram'], ['tls', 'node:tls'], ['zlib', 'node:zlib'],
      ['crypto', 'node:crypto']
    ]) {
      assert.equal(ports[name], require(module), name)
      assert.equal(ports[name], ports[name], name + ' is cached')
    }
    const output = []
    const { Readable, Writable, pipeline } = ports.stream
    await pipeline(Readable.from(['first', 'second']), new Writable({
      write(chunk, encoding, done) { output.push(chunk.toString()); done() }
    }))
    assert.deepEqual(output, ['first', 'second'])
    assert.equal(ports.stream, ports.stream)
    assert.equal(ports.stream.finished, require('node:stream/promises').finished)
    assert.equal(ports.module.createRequire, createRequire)
  `
  assert.doesNotThrow(() =>
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', script],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
  )
})
