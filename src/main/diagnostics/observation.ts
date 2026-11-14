import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { writeDiagnostic, withDiagnosticContext, diagnosticContext } from './logger.ts'
import { summarizeDiagnosticArguments } from './sanitize.ts'
import type { DiagnosticContext } from '../../shared/diagnostics.ts'

const POLLED =
  /(?:getPlaybackInfo|getVisualizationData|getSpectrumData|getDspGraphStatus|getDspPluginStatus|getConvolverInfo|getUpcomingTrack|enumerateDevices|bridgeStatus|bridgeSourceTimeline|getState|getStatus|playback-info|progress|miniPlayer:moveTo|desktopLyrics:clock)/i
const buckets = new Map<
  string,
  { count: number; durationMs: number; maxMs: number; failures: number }
>()
const inFlight = new Map<string, { module: string; method: string; startedAt: number }>()
let timer: NodeJS.Timeout | undefined

export function flushDiagnosticAggregates(): void {
  for (const [key, bucket] of buckets) {
    const split = key.indexOf('|')
    writeDiagnostic(
      key.slice(0, split),
      'requests.summary',
      { method: key.slice(split + 1), ...bucket },
      'debug'
    )
  }
  buckets.clear()
}
export function diagnosticInFlight() {
  const now = performance.now()
  return [...inFlight.entries()].slice(0, 64).map(([requestId, entry]) => ({
    requestId,
    module: entry.module,
    method: entry.method,
    elapsedMs: now - entry.startedAt
  }))
}
export function observeDiagnosticOperation<T>(
  module: string,
  method: string,
  fn: () => T,
  args: unknown[] = [],
  context: DiagnosticContext = {},
  options?: { polled?: boolean }
): T {
  const startedAt = performance.now()
  const requestId = context.requestId ?? randomUUID()
  const operationId = context.operationId ?? diagnosticContext().operationId ?? randomUUID()
  const scope = { ...context, requestId, operationId }
  const polled = options?.polled ?? POLLED.test(method)
  if (!polled)
    writeDiagnostic(
      module,
      'request.start',
      { method, arguments: summarizeDiagnosticArguments(args, method) },
      'debug',
      scope
    )
  if (inFlight.size < 1024) inFlight.set(requestId, { module, method, startedAt })
  const finish = (error?: unknown) => {
    inFlight.delete(requestId)
    const durationMs = performance.now() - startedAt
    if (polled) {
      if (!timer) {
        timer = setInterval(flushDiagnosticAggregates, 1000)
        timer.unref()
      }
      const key = `${module}|${method}`
      if (buckets.size < 256 || buckets.has(key)) {
        const bucket = buckets.get(key) ?? { count: 0, durationMs: 0, maxMs: 0, failures: 0 }
        bucket.count++
        bucket.durationMs += durationMs
        bucket.maxMs = Math.max(bucket.maxMs, durationMs)
        bucket.failures += Number(error !== undefined)
        buckets.set(key, bucket)
      }
    }
    if (error !== undefined) {
      const code = String((error as { code?: unknown })?.code ?? '')
      const outcome =
        /cancel|abort/i.test(code) || (error as Error)?.name === 'AbortError'
          ? 'cancelled'
          : /timeout/i.test(code)
            ? 'timeout'
            : 'failed'
      writeDiagnostic(
        module,
        `request.${outcome}`,
        { method, durationMs, error, inFlight: diagnosticInFlight() },
        outcome === 'cancelled' ? 'info' : 'error',
        scope
      )
    } else if (!polled)
      writeDiagnostic(module, 'request.complete', { method, durationMs }, 'debug', scope)
  }
  return withDiagnosticContext(scope, () => {
    try {
      const result = fn()
      if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function')
        return Promise.resolve(result).then(
          (value) => {
            finish()
            return value
          },
          (error) => {
            finish(error)
            throw error
          }
        ) as T
      finish()
      return result
    } catch (error) {
      finish(error)
      throw error
    }
  })
}

export function unwrapObservedIpc(args: unknown[]): {
  args: unknown[]
  context: DiagnosticContext
} {
  const candidate = args[0] as Record<string, unknown> | undefined
  if (args.length !== 1 || !candidate || candidate.__twilightDiagnosticEnvelope !== 1)
    return { args, context: {} }
  if (!Array.isArray(candidate.args) || candidate.args.length > 32)
    throw new Error('Invalid diagnostic IPC envelope')
  const source = candidate.context as Record<string, unknown> | undefined
  const context: DiagnosticContext = {}
  for (const key of ['operationId', 'requestId'] as const) {
    const value = source?.[key]
    if (typeof value === 'string' && /^[\w-]{1,128}$/.test(value)) context[key] = value
  }
  return { args: candidate.args, context }
}

function describeIpcOperation(
  channel: string,
  args: unknown[]
): { method: string; args: unknown[]; polled?: boolean } {
  if (channel === 'core-window:request') {
    const envelope = args[0] as Record<string, unknown> | undefined
    const request =
      envelope && typeof envelope === 'object' && !Array.isArray(envelope)
        ? (envelope.request as Record<string, unknown> | undefined)
        : undefined
    const name = request && typeof request === 'object' ? request.name : undefined
    const kind = request && typeof request === 'object' ? request.kind : undefined
    if (typeof name === 'string' && /^[\w.-]{1,96}$/.test(name)) {
      return {
        method: `${channel}:${name}`,
        args: 'payload' in request! ? [request!.payload] : [],
        polled: kind === 'query' || undefined
      }
    }
  }
  return { method: channel, args }
}

export function installIpcDiagnostics(ipc: any, trusted: (event: any) => boolean): () => void {
  const originalHandle = ipc.handle
  const originalOn = ipc.on
  const originalRemove = ipc.removeListener
  const wrappers = new WeakMap<(...args: any[]) => any, Map<string, ((...args: any[]) => any)[]>>()
  ipc.handle = function (channel: string, listener: (...args: any[]) => any) {
    return originalHandle.call(this, channel, (event: any, ...wireArgs: unknown[]) => {
      if (channel.startsWith('diagnostics:')) return listener(event, ...wireArgs)
      if (!trusted(event)) return listener(event, ...wireArgs)
      const call = unwrapObservedIpc(wireArgs)
      const described = describeIpcOperation(channel, call.args)
      return observeDiagnosticOperation(
        `ipc.${channel.split(':', 1)[0]}`,
        described.method,
        () => listener(event, ...call.args),
        described.args,
        call.context,
        described.polled !== undefined ? { polled: described.polled } : undefined
      )
    })
  }
  ipc.on = function (channel: string, listener: (...args: any[]) => any) {
    if (channel.startsWith('diagnostics:')) return originalOn.call(this, channel, listener)
    let channels = wrappers.get(listener)
    if (!channels) {
      channels = new Map()
      wrappers.set(listener, channels)
    }
    const wrapped = function (this: any, event: any, ...wireArgs: unknown[]) {
      if (!trusted(event)) return listener.call(this, event, ...wireArgs)
      const call = unwrapObservedIpc(wireArgs)
      const described = describeIpcOperation(channel, call.args)
      return observeDiagnosticOperation(
        `ipc.${channel.split(':', 1)[0]}`,
        described.method,
        () => listener.call(this, event, ...call.args),
        described.args,
        call.context,
        described.polled !== undefined ? { polled: described.polled } : undefined
      )
    }
    Object.assign(wrapped, { listener: (listener as any).listener ?? listener })
    const entries = channels.get(channel) ?? []
    entries.push(wrapped)
    channels.set(channel, entries)
    return originalOn.call(this, channel, wrapped)
  }
  ipc.removeListener = function (channel: string, listener: (...args: any[]) => any) {
    const entries = wrappers.get(listener)?.get(channel)
    return originalRemove.call(this, channel, entries?.pop() ?? listener)
  }
  return () => {
    ipc.handle = originalHandle
    ipc.on = originalOn
    ipc.removeListener = originalRemove
  }
}
