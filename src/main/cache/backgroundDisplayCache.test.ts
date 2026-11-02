import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  backgroundDisplaySize,
  createBackgroundDisplayCache,
  BACKGROUND_DISPLAY_MAX_PIXELS
} from './backgroundDisplayCache.ts'
import { backgroundDisplayUrl } from '../../shared/backgroundDisplay.ts'

test('display budget preserves 4K and small images and bounds tall, square and wide images', () => {
  assert.deepEqual(backgroundDisplaySize(3840, 2160), { width: 3840, height: 2160 })
  assert.deepEqual(backgroundDisplaySize(800, 600), { width: 800, height: 600 })
  for (const [width, height] of [
    [6676, 3768],
    [4000, 4000],
    [500, 20000],
    [20000, 500]
  ]) {
    const size = backgroundDisplaySize(width, height)
    assert.ok(size.width <= 3840 && size.height <= 3840)
    assert.ok(size.width * size.height <= BACKGROUND_DISPLAY_MAX_PIXELS)
    assert.ok(Math.abs(size.width - (size.height * width) / height) <= Math.max(1, width / height))
  }
})

test('display URL bypasses the old immutable bitmap without changing stored handles', () => {
  assert.equal(backgroundDisplayUrl('background://art.png'), 'background://art.png?display=v1')
  assert.equal(
    backgroundDisplayUrl('background://art.png?display=v1'),
    'background://art.png?display=v1'
  )
  assert.equal(backgroundDisplayUrl('cover://art.jpg'), 'cover://art.jpg')
})

test('concurrent loads share conversion, preserve originals and reuse disk derivatives after restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-background-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'large.png')
  await writeFile(source, 'original')
  let decodes = 0
  let requestedSize: unknown
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 6676, height: 3768 }),
    resize: (size: unknown) => {
      requestedSize = size
      return image
    },
    toPNG: () => Buffer.from('display-png-with-alpha')
  }
  const decode = () => {
    decodes++
    return image
  }
  const cache = createBackgroundDisplayCache(decode)
  const paths = await Promise.all([cache(source), cache(source), cache(source)])
  assert.equal(new Set(paths).size, 1)
  assert.equal(decodes, 1)
  assert.notEqual(paths[0], source)
  assert.deepEqual(requestedSize, { ...backgroundDisplaySize(6676, 3768), quality: 'best' })
  assert.equal(await readFile(source, 'utf8'), 'original')
  assert.equal(await readFile(paths[0], 'utf8'), 'display-png-with-alpha')
  assert.equal(await cache(source), paths[0])
  assert.equal(await createBackgroundDisplayCache(decode)(source), paths[0])
  assert.equal(decodes, 1)
  await rm(paths[0])
  assert.equal(await cache(source), paths[0])
  assert.equal(decodes, 2, 'regenerate a derivative removed by disk cleanup')
})

test('small images decode once per session and failures fall back without poisoning retries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-background-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'small.png')
  await writeFile(source, 'small')
  let decodes = 0
  const cache = createBackgroundDisplayCache(() => {
    decodes++
    if (decodes === 1) throw new Error('temporary decode failure')
    return {
      isEmpty: () => false,
      getSize: () => ({ width: 300, height: 200 }),
      resize: () => {
        throw new Error('must not upscale')
      },
      toPNG: () => {
        throw new Error('must not reencode')
      }
    }
  })
  assert.equal(await cache(source), source)
  assert.equal(await cache(source), source)
  assert.equal(await cache(source), source)
  assert.equal(decodes, 2)
})

test('opaque wallpapers encode as compact JPEG derivatives while transparent wallpapers stay PNG', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-background-opaque-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const opaquePng = join(root, 'opaque.png')
  const alphaPng = join(root, 'alpha.png')
  await writeFile(opaquePng, 'opaque')
  await writeFile(alphaPng, 'alpha')
  const cache = createBackgroundDisplayCache((bytes) => {
    const isOpaque = bytes.toString('utf8') === 'opaque'
    const image = {
      isEmpty: () => false,
      getSize: () => ({ width: 5000, height: 3000 }),
      resize: () => image,
      toBitmap: () => Buffer.from([10, 20, 30, isOpaque ? 255 : 128]),
      toJPEG: () => Buffer.from('compact-jpeg'),
      toPNG: () => Buffer.from('alpha-png')
    }
    return image
  })
  const opaquePath = await cache(opaquePng)
  const alphaPath = await cache(alphaPng)
  assert.ok(opaquePath.endsWith('.jpg'))
  assert.ok(alphaPath.endsWith('.png'))
  assert.equal(await readFile(opaquePath, 'utf8'), 'compact-jpeg')
  assert.equal(await readFile(alphaPath, 'utf8'), 'alpha-png')
})
