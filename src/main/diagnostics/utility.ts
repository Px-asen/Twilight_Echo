import {
  configureDiagnosticLogger,
  diagnosticIdentity,
  installConsoleDiagnostics,
  writeDiagnostic
} from './logger.ts'
import { installNetworkDiagnostics } from './network.ts'
import { DIAGNOSTICS_MAX_QUEUE_BYTES } from '../../shared/diagnostics.ts'
import { debugCaptureContext, setDebugCaptureContext } from './debugContext.ts'
import { sanitizeDiagnosticValue } from './sanitize.ts'
import { diagnosticInFlight } from './observation.ts'
import { registerWindowsCrashCapture } from './windowsCrashCapture.ts'

let snapshotProvider: (() => unknown) | undefined
let publishSnapshot: (() => void) | undefined
export function publishUtilityDiagnosticSnapshot(): void {
  publishSnapshot?.()
}
export function setUtilityDiagnosticSnapshotProvider(provider: () => unknown): void {
  snapshotProvider = provider
  publishSnapshot?.()
}

export const DIAGNOSTIC_OUTPUT_PREFIX = '[TwilightDiagnostic]'

export function initializeUtilityDiagnostics(role: string): void {
  if (!process.env.TWILIGHT_LOG_SESSION_ID) return
  registerWindowsCrashCapture()
  const stdout = process.stdout.write.bind(process.stdout)
  let dropped = 0
  configureDiagnosticLogger(
    { sessionId: process.env.TWILIGHT_LOG_SESSION_ID, processRole: role },
    (event) => {
      const line = `${DIAGNOSTIC_OUTPUT_PREFIX}${JSON.stringify(event)}\n`
      if (process.stdout.writableLength + Buffer.byteLength(line) > DIAGNOSTICS_MAX_QUEUE_BYTES) {
        dropped++
        return
      }
      stdout(line)
    }
  )
  process.stdout.on('drain', () => {
    if (dropped) {
      const count = dropped
      dropped = 0
      writeDiagnostic(role, 'events.dropped', { count }, 'warn')
    }
  })
  installConsoleDiagnostics(role)
  installNetworkDiagnostics()
  const parent = (
    process as unknown as {
      parentPort?: {
        postMessage(value: unknown): void
        on(event: 'message', listener: (event: { data: any }) => void): void
      }
    }
  ).parentPort
  const send = (value: unknown) => {
    try {
      if (parent) parent.postMessage(value)
      else process.send?.(value)
    } catch {
      /* Parent exit. */
    }
  }
  publishSnapshot = () => {
    try {
      const context = debugCaptureContext()
      send({
        kind: 'diagnostics:snapshot',
        value: sanitizeDiagnosticValue(
          {
            processId: process.pid,
            identity: diagnosticIdentity(),
            role,
            debugSessionId: context?.id,
            inFlight: diagnosticInFlight(),
            ...(context
              ? {
                  directories: {
                    executable: process.execPath,
                    workingDirectory: process.cwd(),
                    resources: process.resourcesPath
                  },
                  versions: process.versions
                }
              : {}),
            ...((snapshotProvider?.() ?? {}) as Record<string, unknown>)
          },
          { maxArrayLength: 4096 }
        )
      })
    } catch (error) {
      writeDiagnostic(role, 'diagnostic-snapshot.failed', { error }, 'warn')
    }
  }
  const configure = (message: any) => {
    if (message?.kind !== 'diagnostics:configure') return
    const context = message.context
    if (
      context !== null &&
      (!context ||
        !/^[\w-]{1,128}$/.test(context.id) ||
        typeof context.directory !== 'string' ||
        typeof context.captureCrashes !== 'boolean')
    )
      return
    setDebugCaptureContext(context)
    send({ kind: 'diagnostics:ack', debugSessionId: context?.id })
    publishSnapshot?.()
  }
  if (parent) parent.on('message', (event) => configure(event.data))
  else process.on('message', configure)
  send({ kind: 'diagnostics:ready' })
  const snapshotTimer = setInterval(() => publishSnapshot?.(), 2000)
  snapshotTimer.unref()
  publishSnapshot()
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    writeDiagnostic(role, 'process.uncaught-exception', { error, origin }, 'fatal')
  })
  writeDiagnostic(role, 'process.start', {
    versions: process.versions,
    identity: diagnosticIdentity()
  })
  process.on('exit', (code) => {
    writeDiagnostic(role, 'process.exit', { code })
  })
}
