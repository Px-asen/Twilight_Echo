import { randomUUID } from 'node:crypto'
import { debugCaptureContext, onDebugCaptureChange } from './debugContext.ts'
import { sanitizeDiagnosticValue } from './sanitize.ts'

export interface ProcessEvidence {
  instanceId: string
  processInstanceId?: string
  role: string
  processId: number | null
  alive: boolean
  updatedAt: string
  debugSessionId?: string
  captureState: 'pending' | 'active' | 'inactive' | 'timeout' | 'exited'
  snapshot?: { collectedAt: string; value: unknown }
  error?: string
}
const processes = new Map<string, { child: any; evidence: ProcessEvidence; configure(): void }>()
const listeners = new Set<(evidence: ProcessEvidence) => void>()
export function processEvidence(): ProcessEvidence[] {
  return [...processes.values()].map(({ evidence }) => ({ ...evidence }))
}
export function onProcessEvidence(listener: (evidence: ProcessEvidence) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
onDebugCaptureChange(() => {
  for (const { evidence, configure } of processes.values()) if (evidence.alive) configure()
})

export function registerDiagnosticProcess(child: any, role: string): ProcessEvidence {
  const evidence: ProcessEvidence = {
    instanceId: randomUUID(),
    role,
    processId: child.pid ?? null,
    alive: true,
    captureState: 'pending',
    updatedAt: new Date().toISOString()
  }
  let acknowledgement: ReturnType<typeof setTimeout> | undefined
  let requestedId: string | undefined
  const configure = () => {
    clearTimeout(acknowledgement)
    const context = debugCaptureContext()
    requestedId = context?.id
    evidence.captureState = 'pending'
    const send = child.postMessage ?? child.send
    try {
      send?.call(child, { kind: 'diagnostics:configure', context })
    } catch (error) {
      evidence.error = `Diagnostic mode delivery failed: ${String(error)}`
    }
    acknowledgement = setTimeout(() => {
      if (!evidence.alive || evidence.captureState !== 'pending') return
      evidence.captureState = 'timeout'
      evidence.error = 'Diagnostic mode acknowledgement timed out after 5 seconds'
      publish()
    }, 5000)
    acknowledgement.unref()
    publish()
  }
  processes.set(evidence.instanceId, { child, evidence, configure })
  if (processes.size > 128)
    for (const [id, record] of processes) {
      if (!record.evidence.alive) {
        processes.delete(id)
        break
      }
    }
  const publish = () => {
    evidence.updatedAt = new Date().toISOString()
    for (const listener of listeners) listener({ ...evidence })
  }
  child.once('spawn', () => {
    evidence.processId = child.pid ?? evidence.processId
    configure()
    publish()
  })
  child.on('message', (message: any) => {
    if (message?.kind === 'diagnostics:ready') {
      configure()
      return
    }
    if (message?.kind === 'diagnostics:ack') {
      if ((message.debugSessionId ?? undefined) !== requestedId) return
      clearTimeout(acknowledgement)
      evidence.debugSessionId =
        typeof message.debugSessionId === 'string' ? message.debugSessionId : undefined
      evidence.captureState = evidence.debugSessionId ? 'active' : 'inactive'
      delete evidence.error
      publish()
    }
    if (
      message?.kind === 'diagnostics:snapshot' &&
      message.value &&
      typeof message.value === 'object'
    ) {
      // These messages arrive only through a registered child control channel.
      let bytes: number
      try {
        bytes = Buffer.byteLength(JSON.stringify(message.value))
      } catch {
        evidence.error = 'Diagnostic snapshot is not serializable'
        publish()
        return
      }
      if (bytes > 1024 * 1024) {
        evidence.error = 'Diagnostic snapshot exceeds 1 MiB'
        publish()
        return
      }
      evidence.snapshot = {
        collectedAt: new Date().toISOString(),
        value: sanitizeDiagnosticValue(message.value, { maxArrayLength: 4096 })
      }
      if (typeof message.value.identity?.processInstanceId === 'string')
        evidence.processInstanceId = message.value.identity.processInstanceId
      publish()
    }
  })
  child.once('exit', () => {
    clearTimeout(acknowledgement)
    evidence.alive = false
    evidence.captureState = 'exited'
    publish()
  })
  publish()
  return evidence
}

/** No RPC or native probe: this survives an unavailable Core or audio service. */
export function cachedCoreEvidence(): Record<string, any> {
  const core = [...processes.values()]
    .reverse()
    .find(
      (record) => record.evidence.role === 'twilight-core' && record.evidence.snapshot
    )?.evidence
  if (!core?.snapshot)
    return { available: false, reason: 'Core has not published a diagnostic snapshot' }
  return {
    available: true,
    evidenceOrigin: 'core-cache',
    alive: core.alive,
    processId: core.processId,
    collectedAt: core.snapshot.collectedAt,
    dataAgeMs: Date.now() - Date.parse(core.snapshot.collectedAt),
    value: core.snapshot.value
  }
}
