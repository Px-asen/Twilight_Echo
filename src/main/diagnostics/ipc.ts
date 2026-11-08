import { app, dialog, ipcMain, shell } from 'electron'
import { cpus, release, totalmem } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { IPC } from '../../shared/ipcChannels.ts'
import { runtime } from '../core/runtime.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { inspectJsonValueWithLimits } from '../security/jsonSafety.ts'
import { writeDiagnostic, diagnosticIdentity, forwardDiagnosticEvent } from './logger.ts'
import { diagnosticInFlight } from './observation.ts'
import { exportDiagnosticBundle, type DiagnosticCollector } from './bundle.ts'
import type { DiagnosticWriterClient } from './client.ts'
import { utilityDiagnosticStatuses } from './utilityObservation.ts'
import { cachedCoreEvidence, processEvidence } from './processEvidence.ts'
import { desktopDebugSessions, collectDesktopDebugEvidence } from './desktopDebug.ts'
import type { DiagnosticExportOptions } from '../../shared/diagnostics.ts'

export function createApplicationDiagnosticCollectors(
  coreSnapshot = cachedCoreEvidence()
): DiagnosticCollector[] {
  return [
    {
      name: 'environment',
      collect: async () => ({
        appVersion: app.getVersion(),
        packaged: app.isPackaged,
        platform: process.platform,
        architecture: process.arch,
        osRelease: release(),
        cpu: cpus()[0]?.model,
        cpuCount: cpus().length,
        memoryBytes: totalmem(),
        versions: process.versions,
        gpu: app.getGPUFeatureStatus()
      })
    },
    {
      name: 'settings',
      collect: () => coreSnapshot.value?.settings ?? runtime.appSettings
    },
    {
      name: 'processes',
      collect: () => ({
        metrics: app.getAppMetrics(),
        inFlight: diagnosticInFlight(),
        utilityProcesses: utilityDiagnosticStatuses(),
        evidence: processEvidence()
      })
    },
    { name: 'core.cached', collect: () => coreSnapshot },
    {
      name: 'build.javascript',
      collect: async () =>
        JSON.parse(await readFile(join(app.getAppPath(), 'out', 'diagnostic-build.json'), 'utf8'))
    },
    {
      name: 'build.native',
      collect: async () =>
        JSON.parse(
          await readFile(
            join(
              app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'),
              'audio-engine',
              'native-build-identities.json'
            ),
            'utf8'
          )
        )
    },
    {
      name: 'audio.cached',
      collect: () => {
        const core = coreSnapshot
        return { ...core, value: core.value?.audio ?? { available: false } }
      }
    },
    {
      name: 'native.identity',
      collect: () => {
        const core = coreSnapshot
        return core.value?.audio?.serviceEvidence?.lastKnownCapabilities ?? { available: false }
      }
    },
    {
      name: 'native.capabilities',
      collect: async () => {
        const core = coreSnapshot
        const identity =
          core.value?.audio?.serviceEvidence?.lastKnownCapabilities?.value?.nativeRuntime
        if (!identity?.addonPath || typeof identity.addonPath !== 'string')
          return { available: false }
        return JSON.parse(
          await readFile(join(identity.addonPath, '..', 'audio-capabilities.json'), 'utf8')
        )
      }
    },
    {
      name: 'services',
      collect: () => coreSnapshot.value?.services ?? { available: false }
    }
  ]
}

export function registerDiagnosticsIpc(writer: DiagnosticWriterClient): void {
  let exporting = false
  const sessions = desktopDebugSessions()
  const restart = () => {
    setTimeout(() => {
      void import('../app/settingsRuntime.ts').then((module) => module.relaunchApplication())
    }, 150)
  }
  const status = async () => ({
    ...(await writer.status()),
    debug: sessions.current
      ? {
          ...sessions.current,
          processes: processEvidence().map(
            ({ role, processId, alive, debugSessionId, updatedAt, captureState, error }) => ({
              role,
              processId,
              alive,
              debugSessionId,
              updatedAt,
              captureState,
              error
            })
          )
        }
      : null
  })
  ipcMain.handle(IPC.diagnostics.startDebug, async (event, options: unknown) => {
    assertTrustedIpcSender(event, 'diagnostics')
    if (
      !options ||
      typeof options !== 'object' ||
      typeof (options as any).captureCrashes !== 'boolean' ||
      Object.keys(options).some((key) => key !== 'captureCrashes')
    )
      throw new Error('Invalid debug options')
    const captureCrashes = (options as { captureCrashes: boolean }).captureCrashes
    const choice = await dialog.showMessageBox({
      type: 'info',
      title: '开始调试',
      message: '调试日志将保留完整本地路径、模块和调用记录。',
      detail:
        '密码、Token 和 Cookie 会被过滤，文件仅保存在本机。' +
        (captureCrashes
          ? '\n崩溃转储可能包含敏感内存片段。将重启应用开始取证，结束取证时也需要重启；播放保持停止。'
          : ''),
      buttons: [captureCrashes ? '重启并开始取证' : '开始调试', '取消'],
      defaultId: 0,
      cancelId: 1
    })
    if (choice.response !== 0) throw new Error('已取消开始调试')
    const session = sessions.start(captureCrashes)
    writeDiagnostic('diagnostics', 'debug.started', { id: session.id, captureCrashes })
    if (captureCrashes) restart()
    else void collectDesktopDebugEvidence()
    return session
  })
  ipcMain.handle(IPC.diagnostics.stopDebug, async (event) => {
    assertTrustedIpcSender(event, 'diagnostics')
    writeDiagnostic('diagnostics', 'debug.stopped')
    const result = await sessions.stop()
    if (result?.state === 'stopping') restart()
    return result
  })
  const budgets = new Map<number, { started: number; events: number; dropped: number }>()
  ipcMain.handle(IPC.diagnostics.status, (event) => {
    assertTrustedIpcSender(event, 'diagnostics')
    return status()
  })
  ipcMain.handle(IPC.diagnostics.directory, async (event) => {
    assertTrustedIpcSender(event, 'diagnostics')
    const error = await shell.openPath(writer.directory)
    if (error) throw new Error(error)
  })
  ipcMain.handle(IPC.diagnostics.marker, (event, note?: unknown) => {
    assertTrustedIpcSender(event, 'diagnostics')
    if (note !== undefined && (typeof note !== 'string' || note.length > 1024))
      throw new Error('Problem note must be at most 1024 characters')
    const markerId = randomUUID()
    writeDiagnostic(
      'diagnostics',
      'problem.marked',
      {
        markerId,
        note: note ?? '',
        beforeSeconds: 120,
        afterSeconds: 30,
        inFlight: diagnosticInFlight(),
        audio: cachedCoreEvidence()
      },
      'warn'
    )
    const timer = setTimeout(
      () =>
        writeDiagnostic('diagnostics', 'problem.context-complete', {
          markerId,
          audio: cachedCoreEvidence()
        }),
      30000
    )
    timer.unref()
    return { markerId }
  })
  ipcMain.handle(IPC.diagnostics.clear, async (event) => {
    assertTrustedIpcSender(event, 'diagnostics')
    if (exporting) throw new Error('Diagnostic export is in progress')
    await writer.clearHistory()
    writeDiagnostic('diagnostics', 'history.cleared')
    return writer.status()
  })
  ipcMain.on(IPC.diagnostics.record, (event, events: unknown) => {
    assertTrustedIpcSender(event, 'diagnostics')
    if (
      !Array.isArray(events) ||
      events.length > 32 ||
      !inspectJsonValueWithLimits(events, 64 * 1024).ok
    )
      return
    const id = event.sender.id
    let budget = budgets.get(id)
    if (!budget || Date.now() - budget.started >= 1000) {
      if (budget?.dropped)
        writeDiagnostic(
          'renderer',
          'events.dropped',
          { windowId: id, count: budget.dropped },
          'warn'
        )
      budget = { started: Date.now(), events: 0, dropped: 0 }
      budgets.set(id, budget)
      if (budgets.size > 64) budgets.delete(budgets.keys().next().value!)
    }
    for (const entry of events) {
      if (++budget.events > 100) {
        budget.dropped++
        continue
      }
      if (
        !entry ||
        !['debug', 'info', 'warn', 'error', 'fatal'].includes(entry.level) ||
        typeof entry.module !== 'string' ||
        !/^[\w.-]{1,96}$/.test(entry.module) ||
        typeof entry.event !== 'string' ||
        !/^[\w.-]{1,128}$/.test(entry.event)
      )
        continue
      if (
        typeof entry.processInstanceId === 'string' &&
        /^[\w-]{1,128}$/.test(entry.processInstanceId) &&
        Number.isSafeInteger(entry.sequence)
      ) {
        forwardDiagnosticEvent({
          ...diagnosticIdentity(),
          schemaVersion: 1,
          eventId: `${entry.processInstanceId}:${entry.sequence}`,
          timestamp: entry.timestamp,
          monotonicMs: entry.monotonicMs,
          sequence: entry.sequence,
          processRole: 'renderer',
          processId: event.sender.getOSProcessId(),
          processInstanceId: entry.processInstanceId,
          module: entry.module,
          event: entry.event,
          level: entry.level,
          details: { windowId: id, data: entry.details }
        })
      } else
        writeDiagnostic(
          entry.module,
          entry.event,
          { windowId: id, data: entry.details },
          entry.level
        )
    }
  })
  const performExport = async (destination: string, options: DiagnosticExportOptions = {}) => {
    // Crashpad may finish additional dumps during shutdown. Reconcile the
    // final directory after restart before freezing status or selecting files.
    if (options.debugSessionId) await sessions.maintain()
    const selected = options.debugSessionId ? sessions.get(options.debugSessionId) : undefined
    const legacyFiles = selected
      ? []
      : ['audio-diagnostics.jsonl', 'audio-diagnostics.previous.jsonl'].map((name) => ({
          source: join(app.getPath('logs'), 'audio', name),
          name,
          module: 'audio'
        }))
    if (!selected) {
      const pluginRoot = join(app.getPath('userData'), 'logs', 'plugins')
      for (const name of await readdir(pluginRoot).catch(() => []))
        if (/^[\w.-]+\.log(?:\.1)?$/.test(name))
          legacyFiles.push({ source: join(pluginRoot, name), name, module: 'plugin' })
    }
    const result = await exportDiagnosticBundle({
      destination,
      collectors: createApplicationDiagnosticCollectors(
        selected ? await sessions.coreSnapshot(selected.id) : cachedCoreEvidence()
      ),
      snapshot: (directory) =>
        selected ? sessions.snapshot(selected.id, directory) : writer.snapshot(directory),
      memoryEvents: selected ? [] : writer.memoryEvents(),
      status: await status(),
      legacyFiles,
      debugSession: selected,
      attachments: selected
        ? await sessions.attachmentsFor(selected.id, options.includeCrashes === true)
        : []
    })
    writeDiagnostic('diagnostics', 'bundle.complete', {
      eventCount: result.manifest.coverage.events,
      missing: result.manifest.missing.length
    })
    return { filePath: result.filePath }
  }
  ipcMain.handle(IPC.diagnostics.export, async (event, options: DiagnosticExportOptions = {}) => {
    assertTrustedIpcSender(event, 'diagnostics')
    if (
      !options ||
      typeof options !== 'object' ||
      Object.keys(options).some(
        (key) => !['debugSessionId', 'includeCrashes', 'stopDebug'].includes(key)
      ) ||
      (options.debugSessionId !== undefined && typeof options.debugSessionId !== 'string') ||
      [options.includeCrashes, options.stopDebug].some(
        (value) => value !== undefined && typeof value !== 'boolean'
      )
    )
      throw new Error('Invalid export options')
    if (exporting) throw new Error('Diagnostic export is already in progress')
    exporting = true
    try {
      if (options.stopDebug && !options.debugSessionId) throw new Error('Debug session is required')
      const selected = options.debugSessionId ? sessions.get(options.debugSessionId) : undefined
      if (options.stopDebug && selected?.id !== sessions.current?.id)
        throw new Error('Cannot stop a historical debug session')
      const chosen = await dialog.showSaveDialog({
        title: selected ? '结束并导出调试包' : '导出诊断包',
        defaultPath: `TwilightEcho-${selected ? 'debug' : 'diagnostics'}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`,
        filters: [{ name: '诊断包 ZIP', extensions: ['zip'] }]
      })
      if (chosen.canceled || !chosen.filePath) return { filePath: null }
      if (options.includeCrashes) {
        const confirmation = await dialog.showMessageBox({
          type: 'warning',
          title: '包含崩溃转储',
          message: '转储可能包含敏感内存片段，无法像文本日志一样脱敏。',
          buttons: ['包含转储并导出', '取消'],
          defaultId: 1,
          cancelId: 1
        })
        if (confirmation.response !== 0) return { filePath: null }
      }
      writeDiagnostic('diagnostics', 'bundle.requested')
      if (options.stopDebug && selected) {
        await collectDesktopDebugEvidence()
        sessions.queueExport(chosen.filePath, options.includeCrashes === true)
        const ended = await sessions.stop()
        if (ended?.state === 'stopping') {
          restart()
          return { filePath: null, restarting: true }
        }
      }
      const result = await performExport(chosen.filePath, options)
      if (options.stopDebug) sessions.exportResult()
      return result
    } catch (error) {
      if (options.stopDebug) sessions.exportResult(String(error))
      writeDiagnostic('diagnostics', 'bundle.failed', { error }, 'error')
      throw error
    } finally {
      exporting = false
    }
  })
  const pending = sessions.current
  if (pending?.state === 'ended' && pending.pendingExport) {
    exporting = true
    void performExport(pending.pendingExport.destination, {
      debugSessionId: pending.id,
      includeCrashes: pending.pendingExport.includeCrashes
    })
      .then(
        () => sessions.exportResult(),
        (error) => sessions.exportResult(String(error))
      )
      .finally(() => {
        exporting = false
      })
  }
}
