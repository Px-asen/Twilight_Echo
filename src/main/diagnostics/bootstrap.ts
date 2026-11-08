import { app, ipcMain, powerMonitor, utilityProcess } from 'electron'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DiagnosticWriterClient } from './client.ts'
import { registerDiagnosticQuit } from './quit.ts'
import {
  configureDiagnosticLogger,
  diagnosticIdentity,
  installConsoleDiagnostics,
  writeDiagnostic
} from './logger.ts'
import { installIpcDiagnostics, flushDiagnosticAggregates } from './observation.ts'
import { isTrustedIpcSender } from '../security/electronSecurity.ts'
import { installNetworkDiagnostics } from './network.ts'
import { observeUtilityProcess } from './utilityObservation.ts'
import { initializeDesktopDebug } from './desktopDebug.ts'
import { sanitizeDiagnosticValue } from './sanitize.ts'

app.setName('TwilightEcho')

// electron-vite can launch through wrapper/process trees that deny its
// medium-integrity Electron process access to the normal Roaming profile. If
// that happens Chromium cannot create its process-singleton lock and exits
// before the window appears. Development mode therefore uses an explicit
// override when supplied and otherwise verifies that the default profile is
// writable, falling back to a workspace-local profile when needed.
function configureDevelopmentUserData(): void {
  if (app.isPackaged) return

  const explicitDirectory = process.env.TWILIGHT_DEV_USER_DATA_DIR?.trim()
  let directory = explicitDirectory
    ? isAbsolute(explicitDirectory)
      ? explicitDirectory
      : resolve(explicitDirectory)
    : ''

  if (!directory) {
    try {
      const defaultDirectory = app.getPath('userData')
      mkdirSync(defaultDirectory, { recursive: true })
      const probePath = join(defaultDirectory, `.twilight-write-probe-${randomUUID()}`)
      writeFileSync(probePath, 'probe')
      unlinkSync(probePath)
      return
    } catch (error) {
      directory = join(app.getAppPath(), 'tmp', 'electron-vite-user-data')
      console.warn(
        '[dev-user-data] default profile is not writable; using workspace-local profile:',
        directory,
        error instanceof Error ? error.message : error
      )
    }
  }

  try {
    mkdirSync(directory, { recursive: true })
    app.setPath('userData', directory)
  } catch (error) {
    console.warn('[dev-user-data] unable to use isolated profile:', error)
  }
}

configureDevelopmentUserData()

export const diagnosticDirectory =
  process.env.TWILIGHT_LOG_DIRECTORY || join(app.getPath('logs'), 'diagnostics')
export const diagnosticWriter = new DiagnosticWriterClient(diagnosticDirectory, null)
const debugSessions = initializeDesktopDebug(diagnosticDirectory)
configureDiagnosticLogger({ sessionId: randomUUID(), processRole: 'main' }, (event) => {
  diagnosticWriter.record({
    ...event,
    details: sanitizeDiagnosticValue(event.details, { preserveLocalPaths: false })
  })
  debugSessions.record(event)
})
process.env.TWILIGHT_LOG_DIRECTORY = diagnosticDirectory
process.env.TWILIGHT_LOG_SESSION_ID = diagnosticIdentity().sessionId
process.env.TAE_DIAGNOSTICS_DIR = diagnosticDirectory
installConsoleDiagnostics('main.console')
installIpcDiagnostics(ipcMain, isTrustedIpcSender)
installNetworkDiagnostics()

process.on('uncaughtExceptionMonitor', (error, origin) => {
  const entry = writeDiagnostic('app', 'process.uncaught-exception', { error, origin }, 'fatal')
  if (entry) {
    diagnosticWriter.emergency({
      ...entry,
      details: sanitizeDiagnosticValue(entry.details, { preserveLocalPaths: false })
    })
    debugSessions.emergency(entry)
  }
})
writeDiagnostic('app', 'session.start', {
  appVersion: app.getVersion(),
  packaged: app.isPackaged,
  platform: process.platform,
  architecture: process.arch,
  versions: process.versions
})

app.on('web-contents-created', (_event, contents) => {
  const windowId = contents.id
  writeDiagnostic('window', 'created', { windowId, type: contents.getType() })
  contents.on('console-message', (details) => {
    const level =
      details.level === 'error'
        ? 'error'
        : details.level === 'warning'
          ? 'warn'
          : details.level === 'debug'
            ? 'debug'
            : 'info'
    writeDiagnostic(
      'renderer.console',
      'console.message',
      { windowId, message: details.message, line: details.lineNumber, source: details.sourceId },
      level
    )
  })
  contents.on('did-fail-load', (_event, errorCode, description, _url, isMainFrame) =>
    writeDiagnostic(
      'window',
      'load.failed',
      { windowId, errorCode, description, isMainFrame },
      'error'
    )
  )
  contents.on('render-process-gone', (_event, details) =>
    writeDiagnostic('window', 'renderer.gone', { windowId, ...details }, 'error')
  )
  contents.on('preload-error', (_event, _path, error) =>
    writeDiagnostic('window', 'preload.failed', { windowId, error }, 'error')
  )
  contents.on('unresponsive', () => writeDiagnostic('window', 'unresponsive', { windowId }, 'warn'))
  contents.on('responsive', () => writeDiagnostic('window', 'responsive', { windowId }))
  contents.on('destroyed', () => writeDiagnostic('window', 'destroyed', { windowId }))
})
app.on('child-process-gone', (_event, details) =>
  writeDiagnostic('app', 'child-process.gone', details, 'error')
)

const originalFork = utilityProcess.fork.bind(utilityProcess)
utilityProcess.fork = (entry, args, options) => {
  const child = originalFork(entry, args, options)
  observeUtilityProcess(child, options?.serviceName ?? 'utility')
  return child
}

app
  .whenReady()
  .then(async () => {
    for (const event of [
      'suspend',
      'resume',
      'on-ac',
      'on-battery',
      'shutdown',
      'lock-screen',
      'unlock-screen'
    ])
      (powerMonitor as NodeJS.EventEmitter).on(event, () => writeDiagnostic('system', event))
    const { registerDiagnosticsIpc } = await import('./ipc.ts')
    registerDiagnosticsIpc(diagnosticWriter)
    writeDiagnostic('app', 'app.ready')
  })
  .catch((error) => writeDiagnostic('app', 'diagnostics.setup-failed', { error }, 'error'))

registerDiagnosticQuit(app, async () => {
  flushDiagnosticAggregates()
  writeDiagnostic('app', 'session.end')
  await diagnosticWriter.close()
  await debugSessions.close()
})
