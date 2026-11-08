import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type {
  DiagnosticContext,
  DiagnosticEvent,
  DiagnosticLevel
} from '../../shared/diagnostics.ts'
import { DIAGNOSTICS_MAX_EVENT_BYTES } from '../../shared/diagnostics.ts'
import { sanitizeDiagnosticValue } from './sanitize.ts'
import { debugDiagnosticContext } from './debugContext.ts'

const contextStorage = new AsyncLocalStorage<DiagnosticContext>()
let sink: ((event: DiagnosticEvent) => void) | null = null
let identity = {
  sessionId: process.env.TWILIGHT_LOG_SESSION_ID || randomUUID(),
  processInstanceId: randomUUID(),
  processId: process.pid,
  processRole: 'main'
}
let sequence = 0

export function configureDiagnosticLogger(
  options: Partial<typeof identity>,
  write: (event: DiagnosticEvent) => void
): void {
  identity = { ...identity, ...options }
  sink = write
}
export function diagnosticIdentity() {
  return { ...identity }
}
export function forwardDiagnosticEvent(entry: DiagnosticEvent): void {
  if (!sink) return
  try {
    if (
      !/^[\w.:-]{1,160}$/.test(entry.eventId) ||
      !/^[\w.-]{1,128}$/.test(entry.processInstanceId) ||
      !/^[\w.-]{1,96}$/.test(entry.module) ||
      !/^[\w.-]{1,128}$/.test(entry.event) ||
      !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(entry.timestamp) ||
      !['debug', 'info', 'warn', 'error', 'fatal'].includes(entry.level)
    )
      return
    const safe: DiagnosticEvent = {
      schemaVersion: 1,
      ...debugDiagnosticContext(),
      eventId: entry.eventId,
      sessionId: identity.sessionId,
      processInstanceId: entry.processInstanceId,
      processRole: /^[\w.-]{1,64}$/.test(entry.processRole) ? entry.processRole : 'utility',
      processId: Number(entry.processId) || 0,
      sequence: Number(entry.sequence) || 0,
      monotonicMs: Number(entry.monotonicMs) || 0,
      timestamp: entry.timestamp,
      module: entry.module,
      event: entry.event,
      level: entry.level,
      details: sanitizeDiagnosticValue(entry.details)
    }
    for (const key of ['operationId', 'requestId', 'debugSessionId'] as const)
      if (typeof entry[key] === 'string' && /^[\w-]{1,128}$/.test(entry[key]!))
        safe[key] = entry[key]
    for (const key of ['serviceGeneration', 'streamToken'] as const)
      if (typeof entry[key] === 'number' && Number.isSafeInteger(entry[key])) safe[key] = entry[key]
    if (Buffer.byteLength(JSON.stringify(safe)) <= DIAGNOSTICS_MAX_EVENT_BYTES) sink(safe)
  } catch {
    /* Malformed worker output cannot affect playback. */
  }
}
export function diagnosticContext(): DiagnosticContext {
  return contextStorage.getStore() ?? {}
}
export function withDiagnosticContext<T>(context: DiagnosticContext, fn: () => T): T {
  return contextStorage.run({ ...diagnosticContext(), ...context }, fn)
}
export function writeDiagnostic(
  module: string,
  event: string,
  details: unknown = {},
  level: DiagnosticLevel = 'info',
  context: DiagnosticContext = {}
): DiagnosticEvent | null {
  if (!sink) return null
  try {
    const number = ++sequence
    const entry: DiagnosticEvent = {
      schemaVersion: 1,
      ...identity,
      ...debugDiagnosticContext(),
      ...diagnosticContext(),
      ...context,
      eventId: `${identity.processInstanceId}:${number}`,
      timestamp: new Date().toISOString(),
      monotonicMs: performance.now(),
      sequence: number,
      level,
      module: module.slice(0, 96),
      event: event.slice(0, 128),
      details: sanitizeDiagnosticValue(details)
    }
    if (Buffer.byteLength(JSON.stringify(entry)) > DIAGNOSTICS_MAX_EVENT_BYTES)
      entry.details = { truncated: true, summary: JSON.stringify(entry.details).slice(0, 2048) }
    sink(entry)
    return entry
  } catch {
    return null
  }
}
export function createDiagnosticLogger(module: string) {
  return {
    debug: (event: string, details?: unknown) => writeDiagnostic(module, event, details, 'debug'),
    info: (event: string, details?: unknown) => writeDiagnostic(module, event, details, 'info'),
    warn: (event: string, details?: unknown) => writeDiagnostic(module, event, details, 'warn'),
    error: (event: string, details?: unknown) => writeDiagnostic(module, event, details, 'error'),
    fatal: (event: string, details?: unknown) => writeDiagnostic(module, event, details, 'fatal'),
    operation: async <T>(
      event: string,
      fn: () => Promise<T> | T,
      details?: unknown
    ): Promise<T> => {
      const started = performance.now()
      return withDiagnosticContext(
        { operationId: diagnosticContext().operationId ?? randomUUID() },
        async () => {
          writeDiagnostic(module, `${event}.start`, details, 'debug')
          try {
            const result = await fn()
            writeDiagnostic(
              module,
              `${event}.complete`,
              { durationMs: performance.now() - started },
              'debug'
            )
            return result
          } catch (error) {
            writeDiagnostic(
              module,
              `${event}.failed`,
              { durationMs: performance.now() - started, error },
              'error'
            )
            throw error
          }
        }
      )
    }
  }
}

export function installConsoleDiagnostics(module: string): () => void {
  const methods = ['debug', 'log', 'info', 'warn', 'error'] as const
  const original = Object.fromEntries(methods.map((method) => [method, console[method]])) as Pick<
    Console,
    (typeof methods)[number]
  >
  let recording = false
  for (const method of methods)
    console[method] = (...args: unknown[]) => {
      if (!recording) {
        recording = true
        try {
          writeDiagnostic(
            module,
            `console.${method}`,
            { arguments: args },
            method === 'log' ? 'info' : method
          )
        } finally {
          recording = false
        }
      }
      original[method].apply(console, args)
    }
  return () => {
    for (const method of methods) console[method] = original[method]
  }
}
