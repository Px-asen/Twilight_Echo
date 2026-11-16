import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import * as protocolCache from '../cache/protocolAssetCache.ts'
import * as backgroundDisplay from '../cache/backgroundDisplayCache.ts'

test('GIF cache handles are accepted and served with their original bytes and MIME type', async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cover-gif-'))
  t.after(() => {
    protocolCache.resetProtocolAssetCacheForTests()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const exports = loadCoverCache(root)
  const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  for (const [directory, name] of [
    [exports.getCoverCacheDir(), 'current.gif'],
    [exports.getLegacyCoverCacheDir(), 'legacy.GIF']
  ]) {
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, name), bytes)
    assert.equal(exports.isCoverCacheFileName(name), true)
    assert.equal(exports.getCoverCacheContentType(name), 'image/gif')
    assert.deepEqual(await exports.readCoverCacheFileBytes(name), bytes)
    assert.equal(await exports.normalizeCachedCoverHandle(`cover://${name}`), `cover://${name}`)
  }
  assert.equal(exports.isCoverCacheFileName('cover.svg'), false)
  assert.equal(exports.isCoverCacheFileName('cover.html'), false)
})

test('main cover maintenance joins normalization writes and gates new work without stale memoization', async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cover-maintenance-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let releaseRead!: () => void,
    reads = 0
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  const cache = loadCoverCache(root, {
    'fs/promises': {
      ...fsPromises,
      readFile: async (file: string) => {
        reads++
        await readGate
        return fsPromises.readFile(file)
      }
    },
    electron: {
      app: { getPath: () => root },
      nativeImage: {
        createFromBuffer: () => ({
          isEmpty: () => false,
          getSize: () => ({ width: 1000 }),
          resize: () => ({ toJPEG: () => Buffer.from('small-jpeg') })
        })
      }
    }
  })
  const directory = cache.ensureCoverCacheDir()
  fs.writeFileSync(path.join(directory, 'original.png'), 'large')
  const first = cache.normalizeCachedCoverHandle('cover://original.png')
  let entered = false,
    releaseClear!: () => void
  const clearing = cache.maintainCoverCache(async () => {
    entered = true
    const handle = await first
    assert.ok(fs.existsSync(path.join(directory, handle.slice('cover://'.length))))
    await fsPromises.rm(directory, { recursive: true, force: true })
    await fsPromises.mkdir(directory)
    await new Promise<void>((resolve) => {
      releaseClear = resolve
    })
  })
  const next = cache.normalizeCachedCoverHandle('cover://original.png')
  assert.equal(cache.cacheCoverFromBuffer(Buffer.from('during-maintenance')), null)
  await Promise.resolve()
  assert.equal(entered, false)
  assert.equal(reads, 1)
  releaseRead()
  while (!releaseClear) await new Promise((resolve) => setImmediate(resolve))
  releaseClear()
  await clearing
  assert.equal(await next, 'cover://original.png')
  assert.notEqual(await first, await next)
  await assert.rejects(
    cache.maintainCoverCache(async () => {
      throw new Error('clear failed')
    }),
    /clear failed/
  )
  assert.equal(await cache.normalizeCachedCoverHandle('cover://missing.png'), 'cover://missing.png')
})

test('readCoverCacheThumbnailBytes persists and reuses sm (128px) and grid (256px) derivatives', async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cover-tiers-'))
  t.after(() => {
    protocolCache.resetProtocolAssetCacheForTests()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const resizes: Array<{ width?: number; quality?: number }> = []
  let decodes = 0
  const cache = loadCoverCache(root, {
    electron: {
      app: { getPath: () => root },
      nativeImage: {
        createFromBuffer: () => {
          decodes += 1
          return {
            isEmpty: () => false,
            getSize: () => ({ width: 500, height: 500 }),
            resize: ({ width }: { width?: number }) => ({
              toJPEG: (quality: number) => {
                resizes.push({ width, quality })
                return Buffer.from(`thumb-${width}-q${quality}`)
              }
            })
          }
        }
      }
    }
  })
  const directory = cache.ensureCoverCacheDir()
  fs.writeFileSync(path.join(directory, 'album.jpg'), 'canonical-500')

  const sm = await cache.readCoverCacheThumbnailBytes('album.jpg', 'sm')
  const grid = await cache.readCoverCacheThumbnailBytes('album.jpg', 'grid')
  const md = await cache.readCoverCacheThumbnailBytes('album.jpg', 'md')

  assert.equal(Buffer.from(sm!).toString('utf8'), 'thumb-128-q80')
  assert.equal(Buffer.from(grid!).toString('utf8'), 'thumb-256-q82')
  assert.equal(Buffer.from(md!).toString('utf8'), 'canonical-500')
  assert.deepEqual(resizes, [
    { width: 128, quality: 80 },
    { width: 256, quality: 82 }
  ])
  assert.ok(fs.existsSync(path.join(directory, 'album_sm.jpg')))
  assert.ok(fs.existsSync(path.join(directory, 'album_grid.jpg')))

  // Subsequent reads hit persisted derivative files without decoding again.
  assert.equal(Buffer.from((await cache.readCoverCacheThumbnailBytes('album.jpg', 'grid'))!).toString('utf8'), 'thumb-256-q82')
  assert.equal(decodes, 2)
})

test('readEncodedImageDimensions parses PNG, JPEG, and WebP headers and skips SkBitmap decode when already small', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cover-sniff-'))
  try {
    let decodes = 0
    const cache = loadCoverCache(root, {
      electron: {
        app: { getPath: () => root },
        nativeImage: {
          createFromBuffer: () => {
            decodes += 1
            return {
              isEmpty: () => false,
              getSize: () => ({ width: 800, height: 800 }),
              resize: () => ({ toJPEG: () => Buffer.from('resized-jpeg') })
            }
          }
        }
      }
    })

    const pngHeader = (width: number, height: number): Uint8Array => {
      const buf = Buffer.alloc(24)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
      buf.writeUInt32BE(13, 8)
      buf.write('IHDR', 12, 'ascii')
      buf.writeUInt32BE(width, 16)
      buf.writeUInt32BE(height, 20)
      return buf
    }

    const jpegHeader = (width: number, height: number, marker = 0xc0): Uint8Array => {
      // SOI + APP1 segment containing a decoy SOF0 thumbnail (width=9999) + fill byte + real SOF
      const app1Length = 10
      const sofOffset = 2 + 2 + app1Length + 1
      const sofLength = 17
      const buf = Buffer.alloc(sofOffset + 2 + sofLength)
      buf[0] = 0xff
      buf[1] = 0xd8
      buf[2] = 0xff
      buf[3] = 0xe1
      buf.writeUInt16BE(app1Length, 4)
      // Decoy SOF marker inside APP1 payload (must be skipped by segmentLength)
      buf[6] = 0xff
      buf[7] = 0xc0
      buf.writeUInt16BE(9999, 8)
      // Extra 0xFF fill byte before real SOF
      buf[2 + 2 + app1Length] = 0xff
      buf[sofOffset] = 0xff
      buf[sofOffset + 1] = marker
      buf.writeUInt16BE(sofLength, sofOffset + 2)
      buf[sofOffset + 4] = 8
      buf.writeUInt16BE(height, sofOffset + 5)
      buf.writeUInt16BE(width, sofOffset + 7)
      return buf
    }

    const webpVp8 = (width: number, height: number): Uint8Array => {
      const buf = Buffer.alloc(30)
      buf.write('RIFF', 0, 'ascii')
      buf.write('WEBP', 8, 'ascii')
      buf.write('VP8 ', 12, 'ascii')
      buf.writeUInt32LE(10, 16)
      buf[20] = 0x00 // keyframe bit = 0
      buf[23] = 0x9d
      buf[24] = 0x01
      buf[25] = 0x2a
      buf.writeUInt16LE(width & 0x3fff, 26)
      buf.writeUInt16LE(height & 0x3fff, 28)
      return buf
    }

    const webpVp8l = (width: number, height: number): Uint8Array => {
      const buf = Buffer.alloc(25)
      buf.write('RIFF', 0, 'ascii')
      buf.write('WEBP', 8, 'ascii')
      buf.write('VP8L', 12, 'ascii')
      buf.writeUInt32LE(5, 16)
      buf[20] = 0x2f
      const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
      buf.writeUInt32LE(bits >>> 0, 21)
      return buf
    }

    const webpVp8x = (width: number, height: number): Uint8Array => {
      const buf = Buffer.alloc(30)
      buf.write('RIFF', 0, 'ascii')
      buf.write('WEBP', 8, 'ascii')
      buf.write('VP8X', 12, 'ascii')
      buf.writeUInt32LE(10, 16)
      const w = width - 1
      const h = height - 1
      buf[24] = w & 0xff
      buf[25] = (w >> 8) & 0xff
      buf[26] = (w >> 16) & 0xff
      buf[27] = h & 0xff
      buf[28] = (h >> 8) & 0xff
      buf[29] = (h >> 16) & 0xff
      return buf
    }

    const dims = (bytes: Uint8Array) => {
      const result = cache.readEncodedImageDimensions(bytes)
      return result ? { width: result.width, height: result.height } : null
    }

    assert.deepEqual(dims(pngHeader(500, 480)), {
      width: 500,
      height: 480
    })
    assert.deepEqual(dims(jpegHeader(320, 240, 0xc2)), {
      width: 320,
      height: 240
    })
    assert.deepEqual(dims(webpVp8(400, 300)), {
      width: 400,
      height: 300
    })
    assert.deepEqual(dims(webpVp8l(500, 500)), {
      width: 500,
      height: 500
    })
    assert.deepEqual(dims(webpVp8x(1200, 900)), {
      width: 1200,
      height: 900
    })
    assert.equal(dims(Buffer.from('not-an-image')), null)
    assert.equal(dims(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 0])), null)

    // <= maxWidth short-circuits before nativeImage.createFromBuffer
    assert.equal(cache.resizeCoverImageBytes(pngHeader(500, 500), 'image/png', 500), null)
    assert.equal(cache.resizeCoverImageBytes(jpegHeader(480, 480), 'image/jpeg', 500), null)
    assert.equal(cache.resizeCoverImageBytes(webpVp8l(500, 500), 'image/webp', 500), null)
    assert.equal(decodes, 0)

    // > maxWidth falls through to nativeImage.createFromBuffer and resizes
    const resizedPng = cache.resizeCoverImageBytes(pngHeader(800, 800), 'image/png', 500)
    assert.equal(resizedPng?.mime, 'image/jpeg')
    assert.equal(decodes, 1)

    // Smaller maxWidth (e.g. 128px sm tier) still resizes a 500px WebP
    const resizedSmall = cache.resizeCoverImageBytes(webpVp8x(500, 500), 'image/webp', 128)
    assert.equal(resizedSmall?.mime, 'image/jpeg')
    assert.equal(decodes, 2)

    // Unrecognized bytes fall back to nativeImage.createFromBuffer
    assert.ok(cache.resizeCoverImageBytes(Buffer.from('unknown-bytes-012345'), 'image/jpeg', 500))
    assert.equal(decodes, 3)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function loadCoverCache(root: string, overrides: Record<string, unknown> = {}) {
  const dependencies: Record<string, unknown> = {
    electron: {
      app: { getPath: () => root },
      nativeImage: {
        createFromBuffer: () => assert.fail('GIF serving must not require nativeImage')
      }
    },
    fs,
    'fs/promises': fsPromises,
    path,
    crypto,
    '../cache/ncmCache.ts': { getMusicCacheRoot: () => path.join(root, 'music-cache') },
    '../cache/protocolAssetCache': protocolCache,
    '../cache/backgroundDisplayCache.ts': backgroundDisplay,
    ...overrides
  }
  const exports = {} as typeof import('./coverCache.ts')
  runInNewContext(
    ts.transpileModule(fs.readFileSync(new URL('./coverCache.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      exports,
      Buffer,
      require: (id: string) => {
        assert.ok(id in dependencies, id)
        return dependencies[id]
      }
    }
  )
  return exports
}
