import type { DiagnosticContext } from '../../shared/diagnostics.ts'

export interface DebugCaptureContext {
  id: string
  directory: string
  captureCrashes: boolean
}
let current: DebugCaptureContext | null =
  process.env.TWILIGHT_DEBUG_SESSION_ID && process.env.TWILIGHT_DEBUG_DIRECTORY
    ? {
        id: process.env.TWILIGHT_DEBUG_SESSION_ID,
        directory: process.env.TWILIGHT_DEBUG_DIRECTORY,
        captureCrashes: process.env.TWILIGHT_DEBUG_CRASHES === '1'
      }
    : null
const listeners = new Set<(context: DebugCaptureContext | null) => void>()
export function debugCaptureContext(): DebugCaptureContext | null {
  return current
}
export function debugDiagnosticContext(): DiagnosticContext {
  return current ? { debugSessionId: current.id } : {}
}
export function setDebugCaptureContext(context: DebugCaptureContext | null): void {
  current = context
  for (const key of [
    'TWILIGHT_DEBUG_SESSION_ID',
    'TWILIGHT_DEBUG_DIRECTORY',
    'TWILIGHT_DEBUG_CRASHES'
  ])
    delete process.env[key]
  if (context) {
    process.env.TWILIGHT_DEBUG_SESSION_ID = context.id
    process.env.TWILIGHT_DEBUG_DIRECTORY = context.directory
    process.env.TWILIGHT_DEBUG_CRASHES = context.captureCrashes ? '1' : '0'
  }
  for (const listener of listeners) listener(context)
}
export function onDebugCaptureChange(
  listener: (context: DebugCaptureContext | null) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
