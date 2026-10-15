import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyzeBackgroundImage,
  backgroundImagePaletteFromPixels
} from './backgroundImagePalette.ts'

const source = 'background://sample.png'

test('raster samples retain white, black and neutral accents instead of substituting blue', () => {
  for (const value of [0, 128, 255]) {
    const expected = `#${value.toString(16).padStart(2, '0').repeat(3)}`
    assert.deepEqual(backgroundImagePaletteFromPixels([value, value, value, 255], source), {
      image: source,
      average: expected,
      accent: expected,
      opacity: 1
    })
  }
  assert.equal(backgroundImagePaletteFromPixels([0, 0, 0], source), null)
  assert.equal(backgroundImagePaletteFromPixels([0, NaN, 0, 255], source), null)
  assert.equal(
    backgroundImagePaletteFromPixels([0, 0, 0, 255], 'https://example.test/image.png'),
    null
  )
})

test('raster samples ignore transparent RGB and keep alpha for later solid-base compositing', () => {
  assert.deepEqual(backgroundImagePaletteFromPixels([255, 0, 0, 255, 0, 255, 0, 0], source), {
    image: source,
    average: '#ff0000',
    accent: '#ff0000',
    opacity: 0.5
  })
  assert.deepEqual(backgroundImagePaletteFromPixels([255, 0, 255, 0], source), {
    image: source,
    average: '#000000',
    accent: '#000000',
    opacity: 0
  })
  const sample = backgroundImagePaletteFromPixels(
    [255, 255, 255, 255, 255, 255, 255, 255, 30, 80, 200, 255],
    source
  )!
  assert.equal(sample.accent, '#1e50c8')
  assert.equal(sample.average, '#b4c5ed')
})

function imageDom(
  options: { stalled?: boolean; decodeFailure?: boolean; sampleFailure?: boolean } = {}
) {
  let release: () => void = () => {}
  let sampled = 0
  const images: FakeImage[] = []
  class FakeImage {
    src = ''
    decoding = ''
    crossOrigin = ''
    onload = null
    onerror = null
    constructor() {
      images.push(this)
    }
    decode() {
      if (options.decodeFailure) return Promise.reject(new Error('decode failed'))
      return options.stalled
        ? new Promise<void>((resolve) => {
            release = resolve
          })
        : Promise.resolve()
    }
  }
  return {
    images,
    release: () => release(),
    sampled: () => sampled,
    createImage: () => new FakeImage() as unknown as HTMLImageElement,
    createCanvas: () =>
      ({
        width: 0,
        height: 0,
        getContext() {
          if (options.sampleFailure) throw new Error('canvas unavailable')
          return {
            drawImage() {
              sampled++
            },
            getImageData() {
              return { data: new Uint8ClampedArray([30, 80, 200, 255]) }
            }
          }
        }
      }) as unknown as HTMLCanvasElement
  }
}

test('local image analysis decodes once, samples without networking and releases the image', async () => {
  const dom = imageDom()
  assert.equal((await analyzeBackgroundImage(source, dom))!.accent, '#1e50c8')
  assert.equal(dom.images.length, 1)
  assert.equal(dom.sampled(), 1)
  assert.equal(dom.images[0].crossOrigin, 'anonymous')
  assert.equal(dom.images[0].src, '')
  await assert.rejects(analyzeBackgroundImage('https://example.test/remote.png', dom), /本地背景/)
  assert.equal(dom.images.length, 1)
})

test('sampling failure permits manual colors while an undecodable image is rejected', async () => {
  const failedSample = imageDom({ sampleFailure: true })
  assert.equal(await analyzeBackgroundImage(source, failedSample), null)
  const failedDecode = imageDom({ decodeFailure: true })
  await assert.rejects(analyzeBackgroundImage(source, failedDecode), /无法读取/)
  assert.equal(failedDecode.images[0].src, '')
})

test('cancelled and timed-out image decodes release resources and ignore late completion', async () => {
  const dom = imageDom({ stalled: true })
  const request = new AbortController()
  const pending = analyzeBackgroundImage(source, { ...dom, signal: request.signal })
  request.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(dom.images[0].src, '')
  dom.release()
  await Promise.resolve()
  assert.equal(dom.sampled(), 0)
  await assert.rejects(analyzeBackgroundImage(source, { ...dom, timeoutMs: 5 }), /超时/)
  dom.release()
  await Promise.resolve()
  assert.equal(dom.sampled(), 0)
  assert.equal(dom.images[1].src, '')
  await assert.rejects(analyzeBackgroundImage(source, { ...dom, signal: request.signal }), {
    name: 'AbortError'
  })
  assert.equal(dom.images.length, 2)
})
