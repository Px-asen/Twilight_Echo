import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeSupervisionMessage, encodeSupervisionMessage } from './supervisionCodec.ts'

test('cross-runtime supervision JSON retains binary types, special scalars and shared references', () => {
  const buffer = new ArrayBuffer(24)
  const typed = new Float32Array(buffer, 4, 3)
  typed.set([0.25, -0.5, 1.5])
  const source = {
    absent: undefined,
    big: 42n,
    negativeZero: -0,
    nan: NaN,
    infinite: Infinity,
    buffer,
    typed,
    view: new DataView(buffer, 8, 4),
    bytes: Buffer.from([0, 128, 255]),
    map: new Map([[42n, typed]]),
    set: new Set([typed]),
    date: new Date('2026-11-08T00:00:00Z'),
    regexp: /twilight/gi,
    nested: { ['__proto__']: { owned: true }, constructor: 'ordinary key' }
  }
  const wire = JSON.parse(JSON.stringify(encodeSupervisionMessage(source)))
  const result = decodeSupervisionMessage(wire) as typeof source
  assert.deepEqual(result, source)
  assert.equal(result.typed.buffer, result.buffer)
  assert.equal(result.view.buffer, result.buffer)
  assert.equal(result.map.get(42n), result.typed)
  assert.equal([...result.set][0], result.typed)
  assert.equal(Object.getPrototypeOf(result.nested), Object.prototype)
})

test('supervision codec preserves cycles and rejects unsupported values and wire versions', () => {
  const source: any = { array: [], error: new Error('fixture failure') }
  source.array.push(source)
  source.error.cause = source.error
  const result = decodeSupervisionMessage(
    JSON.parse(JSON.stringify(encodeSupervisionMessage(source)))
  ) as typeof source
  assert.equal(result.array[0], result)
  assert.equal(result.error.cause, result.error)
  assert.equal(result.error.message, 'fixture failure')
  assert.throws(() => encodeSupervisionMessage(() => {}), /Unsupported/)
  assert.throws(() => decodeSupervisionMessage({ version: 2, nodes: [] }), /version/)
  assert.throws(
    () => decodeSupervisionMessage({ version: 1, root: ['ref', 1], nodes: [] }),
    /reference/
  )
})
