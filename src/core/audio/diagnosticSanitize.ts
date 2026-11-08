import { createHash } from '../../shared/portableCrypto.ts'

const SECRET_KEY =
  /password|passwd|secret|cookie|authorization|credential|api[_-]?key|(?:access|refresh|auth|bearer)[_-]?token|^token$|signature|private[_-]?key/i
const ADDRESS_KEY = /(?:paths?|urls?|uris?|source|host|hostname|address|endpoint|server)$/i
const MAX_TEXT = 8192
export interface DiagnosticSanitizeOptions {
  preserveLocalPaths?: boolean
  maxArrayLength?: number
  maxDepth?: number
}

export function diagnosticFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

export function summarizeDiagnosticAddress(value: string): unknown {
  const text = value.slice(0, MAX_TEXT)
  const local = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(text)
  const extension = /\.([a-z0-9]{1,12})(?:[?#]|$)/i.exec(text)?.[1]?.toLowerCase() ?? ''
  let identity = text
  let scheme = ''
  try {
    const parsed = new URL(text)
    scheme = parsed.protocol.replace(':', '')
    identity = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    /* Local paths and hosts are also fingerprinted. */
  }
  return {
    kind: local ? 'local-path' : scheme ? 'remote-address' : 'identifier',
    scheme,
    extension,
    fingerprint: diagnosticFingerprint(identity)
  }
}

export function sanitizeDiagnosticText(
  value: string,
  options: DiagnosticSanitizeOptions = {}
): string {
  const first = value.length <= MAX_TEXT ? value.trimStart()[0] : ''
  if (first === '[' || first === '{') {
    try {
      return JSON.stringify(sanitizeDiagnosticValue(JSON.parse(value), options))
    } catch {
      /* Continue with unstructured text. */
    }
  }
  return value
    .slice(0, MAX_TEXT)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, '[authentication redacted]')
    .replace(/(\bcookie\b["']?\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/data:[\w.+/-]+(?:;[\w=.+-]+)*;base64,[a-z0-9+/=\r\n]+/gi, '<binary-data>')
    .replace(
      /((?:password|passwd|secret|authorization|(?:access|refresh|auth)?[_-]?token|api[_-]?key|signature)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1[redacted]'
    )
    .replace(
      /\b(?:https?|ftp|sftp|smb|nfs|wss?):\/\/[^\s"'<>]+/gi,
      (text) =>
        `<address:${diagnosticFingerprint(text.split(/[?#]/, 1)[0].replace(/\/\/[^/@]*@/, '//'))}>`
    )
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'<>)]*/g, (text) =>
      options.preserveLocalPaths ? text : `<path:${diagnosticFingerprint(text.trim())}>`
    )
    .replace(/(^|[\s("'])\/(?:[^\s"'<>)]*\/)*[^\s"'<>),]+/g, (whole, prefix) =>
      options.preserveLocalPaths
        ? whole
        : `${prefix}<path:${diagnosticFingerprint(whole.slice(prefix.length))}>`
    )
    .replace(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      (text) => `<email:${diagnosticFingerprint(text)}>`
    )
}

export function sanitizeDiagnosticValue(
  value: unknown,
  options: DiagnosticSanitizeOptions = {}
): unknown {
  const seen = new WeakSet<object>()
  const visit = (input: unknown, key: string, depth: number): unknown => {
    if (SECRET_KEY.test(key)) return '[redacted]'
    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'number') return Number.isFinite(input) ? input : String(input)
    if (typeof input === 'bigint') return input.toString()
    if (typeof input === 'string')
      return ADDRESS_KEY.test(key) &&
        !(
          options.preserveLocalPaths &&
          (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(input) ||
            (/^(?:baseAddress|exceptionAddress)$/i.test(key) && /^0x[\da-f]+$/i.test(input)))
        )
        ? summarizeDiagnosticAddress(input)
        : sanitizeDiagnosticText(input, options)
    if (typeof input === 'undefined') return null
    if (typeof input !== 'object') return `[${typeof input}]`
    if (depth >= (options.maxDepth ?? 7)) return '[depth limit]'
    if (seen.has(input)) return '[circular]'
    seen.add(input)
    try {
      if (ArrayBuffer.isView(input))
        return { type: input.constructor.name, bytes: input.byteLength }
      if (input instanceof ArrayBuffer) return { type: 'ArrayBuffer', bytes: input.byteLength }
      if (input instanceof Date) return input.toISOString()
      if (input instanceof Error) {
        const record = input as Error & { code?: unknown; errno?: unknown; cause?: unknown }
        return {
          name: record.name,
          message: sanitizeDiagnosticText(record.message, options),
          stack: sanitizeDiagnosticText(record.stack ?? '', options),
          ...(record.code === undefined ? {} : { code: visit(record.code, 'code', depth + 1) }),
          ...(record.errno === undefined ? {} : { errno: visit(record.errno, 'errno', depth + 1) }),
          ...(record.cause === undefined ? {} : { cause: visit(record.cause, 'cause', depth + 1) })
        }
      }
      if (Array.isArray(input))
        return input
          .slice(0, options.maxArrayLength ?? 64)
          .map((item) => visit(item, key, depth + 1))
      const result: Record<string, unknown> = Object.create(null)
      const descriptors = Object.getOwnPropertyDescriptors(input)
      for (const name of Object.keys(descriptors).slice(0, 64)) {
        const descriptor = descriptors[name]
        const safeKey = /^[\w.-]{1,128}$/.test(name) ? name : `field-${diagnosticFingerprint(name)}`
        result[safeKey] =
          'value' in descriptor ? visit(descriptor.value, name, depth + 1) : '[accessor omitted]'
      }
      return result
    } catch {
      return '[unserializable]'
    }
  }
  return visit(value, '', 0)
}

/** IPC and network payloads are never dumped. Record bounded shape and public control values. */
export function summarizeDiagnosticArguments(args: unknown[]): unknown[] {
  return args.slice(0, 8).map((value) => {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
    if (typeof value === 'string')
      return { type: 'string', length: value.length, fingerprint: diagnosticFingerprint(value) }
    if (Array.isArray(value)) return { type: 'array', length: value.length }
    if (!value || typeof value !== 'object') return { type: typeof value }
    const summary: Record<string, unknown> = { type: 'object' }
    for (const key of Object.keys(value).slice(0, 32)) {
      if (
        !/^(?:enabled|revision|index|queueIndex|startIndex|startTime|position|volume|count|offset|limit|sampleRate|channels|bitDepth|timeoutMs|quality|method|backend|mode|kind|status)$/i.test(
          key
        )
      )
        continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) continue
      const item = descriptor.value
      if (typeof item === 'number' || typeof item === 'boolean') summary[key] = item
      else if (typeof item === 'string' && /^[\w-]{1,48}$/.test(item)) summary[key] = item
    }
    return summary
  })
}
