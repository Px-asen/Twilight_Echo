import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

test('publishing a large remote cover keeps one image buffer and preserves its exact byte range', async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'te-cover-memory-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  let baseline = 0,
    publicationBytes = 0
  const dependencies: Record<string, unknown> = {
    'node:crypto': crypto,
    'node:path': path,
    'node:fs/promises': {
      ...fs,
      writeFile: (...args: Parameters<typeof fs.writeFile>) => {
        publicationBytes = process.memoryUsage().arrayBuffers - baseline
        return fs.writeFile(...args)
      }
    },
    '../diagnostics/logger.ts': { writeDiagnostic: () => {} }
  }
  const exports = {} as typeof import('./remoteCoverCache.ts')
  runInNewContext(
    ts.transpileModule(readFileSync(new URL('./remoteCoverCache.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      exports,
      Buffer,
      Response,
      require: (id: string) => {
        assert.ok(id in dependencies, id)
        return dependencies[id]
      }
    }
  )
  const cache = exports.createRemoteCoverCache(() => root)
  // A non-zero offset catches accidental writes of the backing buffer's prefix
  // or suffix; GIF artwork follows the path that keeps the original image.
  const backing = new Uint8Array(24 * 1024 * 1024 + 32).fill(0xa5)
  const bytes = backing.subarray(16, backing.length - 16)
  bytes.fill(0x3c)
  bytes[0] = 0x47
  bytes[bytes.length - 1] = 0x3b
  baseline = process.memoryUsage().arrayBuffers
  const result = await cache.write('https://example.com/large.gif', 'image/gif', bytes)
  assert.ok(result)
  assert.equal(result.bytes, bytes)
  assert.ok(publicationBytes < 1024 * 1024, `publication allocated ${publicationBytes} extra bytes`)
  const stored = await cache.read('https://example.com/large.gif')
  assert.ok(stored)
  assert.equal(stored.headers.get('content-type'), 'image/gif')
  assert.deepEqual(new Uint8Array(await stored.arrayBuffer()), bytes)
  assert.equal((await fs.readdir(root)).length, 1)
  t.diagnostic(`24 MiB image: ${publicationBytes} extra buffer bytes at disk publication`)
})
