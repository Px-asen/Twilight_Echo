import { ipcRenderer } from 'electron'
import type {
  DiagnosticsApi,
  DiagnosticContext,
  ObservedIpcEnvelope
} from '../shared/diagnostics.ts'
import { IPC } from '../shared/ipcChannels.ts'

let sequence = 0
let eventSequence = 0
const processInstanceId = `renderer-${process.pid}-${Date.now()}`
function envelope(args: unknown[]): ObservedIpcEnvelope {
  const id = `renderer-${process.pid}-${Date.now()}-${++sequence}`
  const context: DiagnosticContext = { operationId: id, requestId: id }
  return { __twilightDiagnosticEnvelope: 1, context, args }
}
// This module is the first preload dependency; no business API needs to change.
const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer)
const originalSend = ipcRenderer.send.bind(ipcRenderer)
ipcRenderer.invoke = (channel, ...args) =>
  originalInvoke(channel, ...(channel.startsWith('diagnostics:') ? args : [envelope(args)]))
ipcRenderer.send = (channel, ...args) =>
  originalSend(channel, ...(channel.startsWith('diagnostics:') ? args : [envelope(args)]))

export const diagnosticsApi: DiagnosticsApi = {
  getStatus: () => originalInvoke(IPC.diagnostics.status),
  startDebug: (options) => originalInvoke(IPC.diagnostics.startDebug, options),
  stopDebug: () => originalInvoke(IPC.diagnostics.stopDebug),
  markProblem: (note) => originalInvoke(IPC.diagnostics.marker, note),
  openDirectory: () => originalInvoke(IPC.diagnostics.directory),
  exportBundle: (options) => originalInvoke(IPC.diagnostics.export, options),
  clearHistory: () => originalInvoke(IPC.diagnostics.clear),
  record: (events) =>
    originalSend(
      IPC.diagnostics.record,
      events.map((event) => ({
        ...event,
        timestamp: new Date().toISOString(),
        monotonicMs: performance.now(),
        sequence: ++eventSequence,
        processInstanceId
      }))
    )
}
