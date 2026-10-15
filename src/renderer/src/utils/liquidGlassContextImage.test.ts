import assert from 'node:assert/strict'
import test from 'node:test'
import { loadLiquidGlassContextImage } from './liquidGlassContextImage.ts'

function fixture(): HTMLImageElement {
  return { src: '', decoding: '', onload: null, onerror: null } as unknown as HTMLImageElement
}

test('network, executable and file URLs never enter the material image loader', async () => {
  let created = 0
  for (const source of ['https://example.com/image.png', 'http://localhost/a', 'javascript:alert(1)', 'file:///C:/private.png']) {
    await assert.rejects(loadLiquidGlassContextImage(source, new AbortController().signal, () => {
      created++
      return fixture()
    }), /Untrusted/)
  }
  assert.equal(created, 0)
})

test('obsolete and disposed loads clear the source, handlers and abort listener', async () => {
  const request = new AbortController()
  const image = fixture()
  const result = loadLiquidGlassContextImage('cover:test', request.signal, () => image)
  request.abort()
  await assert.rejects(result, { name: 'AbortError' })
  assert.equal(image.src, '')
  assert.equal(image.onload, null)
  assert.equal(image.onerror, null)
})

test('stalled and failed local images release their resource references', async () => {
  const image = fixture()
  await assert.rejects(loadLiquidGlassContextImage('background:test', new AbortController().signal, () => image, 10), /timed out/)
  assert.equal(image.src, '')
  assert.equal(image.onload, null)
  const failed = fixture()
  const result = loadLiquidGlassContextImage('cover:missing', new AbortController().signal, () => failed)
  failed.onerror?.call(failed, new Event('error'))
  await assert.rejects(result, /could not load/)
  assert.equal(failed.src, '')
})

test('successful local loads retain pixels for sampling but release callbacks', async () => {
  const request = new AbortController()
  const image = fixture()
  const result = loadLiquidGlassContextImage('theme-asset:test', request.signal, () => image)
  image.onload?.call(image, new Event('load'))
  assert.equal(await result, image)
  assert.equal(image.crossOrigin, 'anonymous')
  request.abort()
  assert.equal(image.src, 'theme-asset:test')
  assert.equal(image.onload, null)
})
