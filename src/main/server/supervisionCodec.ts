/** Electron and standalone Node can use different V8 serialization versions.
 * This private control lane uses versioned JSON with explicit structured types;
 * bulk Core/service traffic keeps its direct, same-runtime socket transport. */
type WireValue =
  | null
  | boolean
  | string
  | number
  | ['undefined']
  | ['bigint', string]
  | ['number', string]
  | ['ref', number]
type WireNode = { type: string; value: any }
interface SupervisionWire {
  version: 1
  root: WireValue
  nodes: WireNode[]
}

export function encodeSupervisionMessage(message: unknown): SupervisionWire {
  const nodes: WireNode[] = []
  const seen = new Map<object, number>()
  const encode = (value: unknown): WireValue => {
    if (value === undefined) return ['undefined']
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number')
      return Number.isFinite(value) && !Object.is(value, -0)
        ? value
        : ['number', Object.is(value, -0) ? '-0' : String(value)]
    if (typeof value === 'bigint') return ['bigint', String(value)]
    if (typeof value !== 'object') throw new TypeError('Unsupported supervision message value')
    const previous = seen.get(value)
    if (previous !== undefined) return ['ref', previous]
    const index = nodes.length
    seen.set(value, index)
    const node: WireNode = { type: 'object', value: null }
    nodes.push(node)
    if (Buffer.isBuffer(value)) {
      node.type = 'Buffer'
      node.value = value.toString('base64')
    } else if (value instanceof ArrayBuffer) {
      node.type = 'ArrayBuffer'
      node.value = Buffer.from(value).toString('base64')
    } else if (ArrayBuffer.isView(value)) {
      node.type = 'view'
      node.value = [
        value.constructor.name,
        encode(value.buffer),
        value.byteOffset,
        value.byteLength
      ]
    } else if (Array.isArray(value)) {
      node.type = 'array'
      node.value = value.map(encode)
    } else if (value instanceof Map) {
      node.type = 'map'
      node.value = [...value].map(([key, item]) => [encode(key), encode(item)])
    } else if (value instanceof Set) {
      node.type = 'set'
      node.value = [...value].map(encode)
    } else if (value instanceof Date) {
      node.type = 'date'
      node.value = encode(value.getTime())
    } else if (value instanceof RegExp) {
      node.type = 'regexp'
      node.value = [value.source, value.flags]
    } else if (value instanceof Error) {
      node.type = 'error'
      node.value = [value.name, value.message, value.stack, encode(value.cause)]
    } else node.value = Object.entries(value).map(([key, item]) => [key, encode(item)])
    return ['ref', index]
  }
  return { version: 1, root: encode(message), nodes }
}

export function decodeSupervisionMessage(wire: unknown): unknown {
  if (
    !wire ||
    typeof wire !== 'object' ||
    (wire as SupervisionWire).version !== 1 ||
    !Array.isArray((wire as SupervisionWire).nodes)
  )
    throw new Error('Unsupported desktop supervision message version')
  const { root, nodes } = wire as SupervisionWire
  const decoded = new Map<number, any>()
  const decode = (value: WireValue): any => {
    if (!Array.isArray(value)) return value
    if (value[0] === 'undefined') return undefined
    if (value[0] === 'bigint') return BigInt(value[1])
    if (value[0] === 'number') return value[1] === '-0' ? -0 : Number(value[1])
    if (
      value[0] !== 'ref' ||
      !Number.isSafeInteger(value[1]) ||
      value[1] < 0 ||
      value[1] >= nodes.length
    )
      throw new Error('Invalid desktop supervision reference')
    const index = value[1]
    if (decoded.has(index)) return decoded.get(index)
    const node = nodes[index]
    let output: any
    switch (node.type) {
      case 'object':
        output = {}
        break
      case 'array':
        output = []
        break
      case 'map':
        output = new Map()
        break
      case 'set':
        output = new Set()
        break
      case 'Buffer':
        output = Buffer.from(node.value, 'base64')
        break
      case 'ArrayBuffer': {
        const bytes = Buffer.from(node.value, 'base64')
        output = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        break
      }
      case 'view': {
        const [name, buffer, offset, bytes] = node.value
        const constructors = {
          Int8Array,
          Uint8Array,
          Uint8ClampedArray,
          Int16Array,
          Uint16Array,
          Int32Array,
          Uint32Array,
          Float32Array,
          Float64Array,
          BigInt64Array,
          BigUint64Array
        }
        if (name === 'DataView') output = new DataView(decode(buffer), offset, bytes)
        else {
          const Constructor = constructors[name as keyof typeof constructors]
          if (!Constructor) throw new Error('Unknown desktop supervision typed array')
          output = new Constructor(decode(buffer), offset, bytes / Constructor.BYTES_PER_ELEMENT)
        }
        break
      }
      case 'date':
        output = new Date(decode(node.value))
        break
      case 'regexp':
        output = new RegExp(node.value[0], node.value[1])
        break
      case 'error':
        output = new Error(node.value[1])
        output.name = node.value[0]
        output.stack = node.value[2]
        break
      default:
        throw new Error('Unknown desktop supervision type')
    }
    decoded.set(index, output)
    if (node.type === 'object') {
      for (const [key, item] of node.value)
        Object.defineProperty(output, key, {
          value: decode(item),
          writable: true,
          configurable: true,
          enumerable: true
        })
    } else if (node.type === 'array') for (const item of node.value) output.push(decode(item))
    else if (node.type === 'map')
      for (const [key, item] of node.value) output.set(decode(key), decode(item))
    else if (node.type === 'set') for (const item of node.value) output.add(decode(item))
    else if (node.type === 'error') output.cause = decode(node.value[3])
    return output
  }
  return decode(root)
}
