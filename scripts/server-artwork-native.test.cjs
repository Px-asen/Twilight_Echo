'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { randomBytes } = require('node:crypto')
const { PNG } = require('pngjs')
const root = join(__dirname, '..')
const image = require(join(root, 'resources/audio-engine/twilight_image_node.node'))

function raster(width, height, noisy) {
  const data = noisy ? randomBytes(width * height * 4) : Buffer.alloc(width * height * 4, 96)
  if (noisy) for (let pixel = 3; pixel < data.length; pixel += 4) data[pixel] = 96
  return PNG.sync.write({ width, height, data })
}

test('real Server image runtime scales PNG, JPEG and WebP into bounded valid PNG previews without audio', async () => {
  const { resizeServerArtwork } = await import('../src/main/server/imageResize.ts')
  const input = raster(768, 384, true)
  assert.ok(input.length > 180_000)
  const result = resizeServerArtwork(input, 'image/png')
  assert.ok(result.length <= 180_000)
  const preview = PNG.sync.read(result)
  assert.ok(preview.width <= 500 && preview.width > 100)
  assert.ok(Math.abs(preview.width - 2 * preview.height) <= 1)
  assert.equal(preview.data[3], 96)
  for (const [path, mime] of [
    ['resources/sponsor/alipay.jpg', 'image/jpeg'],
    ['src/renderer/src/assets/images/default-track-cover-dark.webp', 'image/webp']
  ]) {
    const bytes = await readFile(join(root, path))
    const png = resizeServerArtwork(bytes, mime)
    assert.ok(png.length <= 180_000)
    const decoded = PNG.sync.read(png)
    assert.ok(
      decoded.width > 0 && decoded.height > 0 && Math.max(decoded.width, decoded.height) <= 500
    )
  }
  assert.equal(resizeServerArtwork(Buffer.from('not a bitmap'), 'image/png'), null)
  assert.equal(resizeServerArtwork(Buffer.from('not a bitmap'), 'image/svg+xml'), null)
  assert.equal(resizeServerArtwork(Buffer.alloc(25 * 1024 * 1024 + 1), 'image/png'), null)
  assert.equal(image.resize(Buffer.alloc(3), 'image/rgba', 500, 1, 1), undefined)
  assert.equal(image.resize(Buffer.from('broken jpeg'), 'image/jpeg', 500, 0, 0), undefined)
  assert.throws(() => image.resize('not bytes', 'image/png'), /requires bitmap/)
})

test('Server projects large personal and cached covers, keeps original bytes, and rejects a cache escape', async (t) => {
  const { createServerArtwork } = await import('../src/main/server/artwork.ts')
  const dir = await mkdtemp(join(tmpdir(), 'twilight-server-image-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cache = join(dir, 'covers')
  await mkdir(cache)
  const bytes = raster(768, 384, true)
  const cover = `data:image/png;base64,${bytes.toString('base64')}`
  const platform = createServerArtwork(cache)
  const signal = new AbortController().signal
  const personal = await platform['artwork.remotePreview']({ cover }, signal)
  assert.ok(personal.length < 250_000)
  PNG.sync.read(Buffer.from(personal.split(',')[1], 'base64'))
  await writeFile(join(cache, 'large.png'), bytes)
  const cached = await platform['artwork.remotePreview']({ cover: 'cover://large.png' }, signal)
  assert.ok(cached.length < 250_000)
  assert.deepEqual(await readFile(join(cache, 'large.png')), bytes)
  const result = PNG.sync.read(Buffer.from(cached.split(',')[1], 'base64'))
  assert.ok(Math.abs(result.width - 2 * result.height) <= 1)
  assert.equal(
    await platform['artwork.remotePreview']({ cover: 'https://private.test/image.png' }, signal),
    null
  )
  await assert.rejects(
    platform['artwork.remotePreview']({ cover: 'cover://../private.png' }, signal),
    /无效/
  )
  const cancelled = AbortSignal.abort()
  await assert.rejects(platform['artwork.remotePreview']({ cover }, cancelled), {
    name: 'AbortError'
  })
})
