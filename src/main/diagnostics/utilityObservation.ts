import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'
import { diagnosticContext, forwardDiagnosticEvent, writeDiagnostic } from './logger.ts'
import { sanitizeDiagnosticText, summarizeDiagnosticArguments } from './sanitize.ts'
import type { DiagnosticEvent } from '../../shared/diagnostics.ts'
import { registerDiagnosticProcess } from './processEvidence.ts'
const observed = new WeakSet<object>()
const POLLED_UTILITY_RPC =
  /^(?:Get(?:PlaybackInfo|VisualizationData|SpectrumData|DspGraphStatus|DspPluginStatus|ConvolverInfo|UpcomingTrack)|EnumerateDevices|BridgeStatus|BridgeSourceTimeline)$/
const states = new Map<
  string,
  {
    role: string
    processId: number | null
    alive: boolean
    journalUnavailable: boolean
    updatedAt: string
  }
>()
export function utilityDiagnosticStatuses() {
  return [...states.values()].map((state) => ({
    ...state,
    dataAgeMs: Date.now() - Date.parse(state.updatedAt)
  }))
}

export function observeUtilityProcess(child: any, role: string): void {
  if (observed.has(child)) return
  observed.add(child)
  const evidence = registerDiagnosticProcess(child, role)
  const state = {
    role,
    processId: child.pid ?? null,
    alive: true,
    journalUnavailable: false,
    updatedAt: new Date().toISOString()
  }
  states.set(evidence.instanceId, state)
  if (states.size > 64) states.delete(states.keys().next().value!)
  const pending = new Map<
    string,
    { started: number; method: string; context: ReturnType<typeof diagnosticContext> }
  >()
  writeDiagnostic('process', 'utility.spawn', { role })
  child.once('spawn', () => {
    state.processId = child.pid ?? state.processId
    writeDiagnostic('process', 'utility.ready', { role, processId: child.pid })
  })
  child.once('exit', (code: number | null, signal?: string) => {
    state.alive = false
    state.updatedAt = new Date().toISOString()
    writeDiagnostic(
      'process',
      'utility.exit',
      {
        role,
        processId: state.processId,
        instanceId: evidence.instanceId,
        code,
        signal,
        unfinished: [...pending.entries()].slice(0, 64).map(([requestId, item]) => ({
          requestId,
          method: item.method,
          elapsedMs: performance.now() - item.started
        }))
      },
      code !== 0 ? 'error' : 'info'
    )
  })
  const sendMethod = child.postMessage ? 'postMessage' : child.send ? 'send' : null
  if (sendMethod) {
    const post = child[sendMethod].bind(child)
    child[sendMethod] = (message: any, ...rest: any[]) => {
      if (typeof message?.requestId === 'string' && ['request', 'scan'].includes(message.kind)) {
        const context = { ...diagnosticContext(), requestId: message.requestId }
        const method = message.method ?? message.analysis ?? message.kind
        if (pending.size < 1024)
          pending.set(message.requestId, { started: performance.now(), method, context })
        if (!POLLED_UTILITY_RPC.test(method))
          writeDiagnostic(
            `rpc.${role}`,
            'dispatch',
            { method, arguments: summarizeDiagnosticArguments(message.args ?? [], method) },
            'debug',
            context
          )
        return post({ ...message, diagnosticContext: context }, ...rest)
      }
      return post(message, ...rest)
    }
    child.on('message', (message: any) => {
      if (message?.kind !== 'response') return
      const item = pending.get(message.requestId)
      if (!item) return
      pending.delete(message.requestId)
      if (!message.ok || !POLLED_UTILITY_RPC.test(item.method))
        writeDiagnostic(
          `rpc.${role}`,
          message.ok ? 'response' : 'failed',
          {
            method: item.method,
            durationMs: performance.now() - item.started,
            ...(message.ok ? {} : { error: message.error })
          },
          message.ok ? 'debug' : 'error',
          item.context
        )
    })
  }
  for (const [stream, level] of [
    [child.stdout, 'info'],
    [child.stderr, 'warn']
  ] as const) {
    let buffered = ''
    const decoder = new StringDecoder('utf8')
    let windowStarted = Date.now()
    let count = 0
    let suppressed = 0
    stream?.on('data', (chunk: Buffer) => {
      if (Date.now() - windowStarted >= 1000) {
        if (suppressed) writeDiagnostic(role, 'output.suppressed', { count: suppressed }, 'warn')
        windowStarted = Date.now()
        count = 0
        suppressed = 0
      }
      buffered += decoder.write(chunk.subarray(0, 64 * 1024))
      const lines = buffered.split('\n')
      buffered = lines.pop()?.slice(-16384) ?? ''
      for (const line of lines) {
        if (line.includes('[TwilightDiagnostics] native journal unavailable')) {
          state.journalUnavailable = true
          state.updatedAt = new Date().toISOString()
        }
        if (++count > 100) {
          suppressed++
          continue
        }
        if (!line.startsWith('[TwilightDiagnostic]')) {
          if (line.trim()) writeDiagnostic(role, 'process.output', { text: line }, level)
          continue
        }
        try {
          const raw = JSON.parse(line.slice('[TwilightDiagnostic]'.length)) as DiagnosticEvent
          if (
            Buffer.byteLength(line) <= 17 * 1024 &&
            raw.schemaVersion === 1 &&
            ['debug', 'info', 'warn', 'error', 'fatal'].includes(raw.level) &&
            typeof raw.eventId === 'string' &&
            raw.eventId.length < 160 &&
            typeof raw.processInstanceId === 'string' &&
            raw.processInstanceId.length < 128 &&
            typeof raw.timestamp === 'string'
          )
            forwardDiagnosticEvent({
              ...raw,
              processRole: role,
              module: sanitizeDiagnosticText(raw.module).slice(0, 96),
              event: sanitizeDiagnosticText(raw.event).slice(0, 128)
            })
        } catch {
          writeDiagnostic(role, 'output.invalid-event', {}, 'warn')
        }
      }
    })
    child.once('exit', () => {
      if (buffered.trim()) writeDiagnostic(role, 'process.output-tail', { text: buffered }, level)
    })
  }
}
