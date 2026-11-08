import { IPC } from './ipcChannels.ts'
export const DIAGNOSTICS_SCHEMA_VERSION = 1
export const DIAGNOSTICS_MAX_EVENT_BYTES = 16 * 1024
export const DIAGNOSTICS_MAX_QUEUE_BYTES = 4 * 1024 * 1024
export const DIAGNOSTICS_MAX_FILE_BYTES = 8 * 1024 * 1024
export const DIAGNOSTICS_MAX_TOTAL_BYTES = 256 * 1024 * 1024
export const DIAGNOSTICS_RETENTION_DAYS = 7

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export interface DiagnosticContext {
  debugSessionId?: string
  operationId?: string
  requestId?: string
  serviceGeneration?: number
  streamToken?: number
}
export interface DiagnosticEvent extends DiagnosticContext {
  schemaVersion: 1
  eventId: string
  timestamp: string
  monotonicMs: number
  sessionId: string
  processId: number
  processRole: string
  processInstanceId: string
  sequence: number
  level: DiagnosticLevel
  module: string
  event: string
  details: unknown
}
export interface DiagnosticStatus {
  enabled: true
  level: 'debug'
  sessionId: string
  directory: string
  bytes: number
  files: number
  retentionDays: number
  maxTotalBytes: number
  queuedBytes: number
  droppedEvents: number
  lastWriteAt: string | null
  error: string | null
  warnings?: string[]
  debug?: DebugSessionStatus | null
}
export interface DebugSessionStatus {
  id: string
  startedAt: string
  endedAt?: string
  state: 'active' | 'restart-required' | 'stopping' | 'ended'
  captureCrashes: boolean
  directory: string
  bytes: number
  maxTotalBytes: number
  droppedEvents: number
  warnings: string[]
  crashes?: {
    electron: 'disabled' | 'pending' | 'active' | 'stopped' | 'failed'
    native: 'disabled' | 'windows-helper' | 'unsupported'
    dumps: number
    dumpBytes: number
    collectors: {
      processId: number
      status: 'attached' | 'failed'
      architecture?: string
      stage?: string
      errorCode?: number
    }[]
  }
  pendingExport?: { destination: string; includeCrashes: boolean; error?: string }
  processes?: {
    role: string
    processId: number | null
    alive: boolean
    debugSessionId?: string
    updatedAt: string
    captureState?: 'pending' | 'active' | 'inactive' | 'timeout' | 'exited'
    error?: string
  }[]
}
export interface DiagnosticExportOptions {
  debugSessionId?: string
  includeCrashes?: boolean
  stopDebug?: boolean
}
export interface DiagnosticRendererEvent {
  timestamp?: string
  monotonicMs?: number
  sequence?: number
  processInstanceId?: string
  level: DiagnosticLevel
  module: string
  event: string
  details?: unknown
}
export interface DiagnosticsApi {
  getStatus(): Promise<DiagnosticStatus>
  markProblem(note?: string): Promise<{ markerId: string }>
  openDirectory(): Promise<void>
  startDebug(options: { captureCrashes: boolean }): Promise<DebugSessionStatus>
  stopDebug(): Promise<DebugSessionStatus | null>
  exportBundle(
    options?: DiagnosticExportOptions
  ): Promise<{ filePath: string | null; restarting?: boolean }>
  clearHistory(): Promise<DiagnosticStatus>
  record(events: DiagnosticRendererEvent[]): void
}
export const DIAGNOSTICS_CHANNELS = IPC.diagnostics

// The envelope is internal to preload/main. Business handlers still receive
// their original arguments, and callers without an envelope remain compatible.
export interface ObservedIpcEnvelope {
  __twilightDiagnosticEnvelope: 1
  context: DiagnosticContext
  args: unknown[]
}
