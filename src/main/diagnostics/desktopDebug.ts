import { app, crashReporter } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DebugSessionController } from './debugSession.ts'
import { onProcessEvidence, processEvidence } from './processEvidence.ts'
import { debugCaptureContext, onDebugCaptureChange } from './debugContext.ts'
import { collectWindowsCrashEvents, collectWindowsModules } from './windowsEvidence.ts'

let controller: DebugSessionController | undefined
let collecting: Promise<void> | null = null
let moduleSnapshot = ''
export function desktopDebugSessions(): DebugSessionController {
  if (!controller) throw new Error('Debug diagnostics have not initialized')
  return controller
}
export function initializeDesktopDebug(directory: string): DebugSessionController {
  controller = new DebugSessionController(join(directory, 'debug-sessions'))
  let session
  try {
    session = controller.boot()
  } catch (error) {
    controller.warn(`调试会话恢复失败：${String(error)}`)
  }
  const helper = join(
    app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'),
    'audio-engine',
    'twilight-crash-helper.exe'
  )
  if (existsSync(helper)) process.env.TWILIGHT_DEBUG_CRASH_HELPER = helper
  if (session?.state === 'active' && session.captureCrashes) {
    const crashDirectory = join(session.directory, 'crashes', 'electron')
    try {
      mkdirSync(crashDirectory, { recursive: true })
      app.setPath('crashDumps', crashDirectory)
      crashReporter.start({
        uploadToServer: false,
        ignoreSystemCrashHandler: false,
        globalExtra: { debugSessionId: session.id }
      })
      controller.setCrashpadState('active')
    } catch (error) {
      controller.setCrashpadState('failed')
      controller.warn(`Crashpad 启用失败：${String(error)}`)
    }
    if (process.platform === 'win32' && !existsSync(helper))
      controller.warn('原生崩溃 helper 缺失，独立 Node/ASIO/VST3 进程无法采集转储')
    if (process.platform !== 'win32')
      controller.warn('独立原生辅助进程的崩溃转储尚未覆盖；Electron 进程已启用 Crashpad')
  }
  const directories = () => {
    moduleSnapshot = ''
    controller!.attachment('directories.json', {
      executable: app.getPath('exe'),
      application: app.getAppPath(),
      resources: process.resourcesPath,
      profile: app.getPath('userData'),
      logs: directory,
      workingDirectory: process.cwd(),
      temporaryDirectory: app.getPath('temp')
    })
  }
  onDebugCaptureChange(directories)
  directories()
  onProcessEvidence((evidence) => {
    controller!.attachment(`processes/${evidence.instanceId}.json`, evidence)
    if (debugCaptureContext() && evidence.error)
      controller!.warn(`${evidence.role} · PID ${evidence.processId}: ${evidence.error}`)
    if (!evidence.alive && debugCaptureContext()) void collectDesktopDebugEvidence()
  })
  const timer = setInterval(() => void collectDesktopDebugEvidence(), 15000)
  timer.unref()
  app.once('will-quit', () => clearInterval(timer))
  return controller
}
export function collectDesktopDebugEvidence(): Promise<void> {
  if (!controller) return Promise.resolve()
  if (collecting) return collecting
  const owner = controller
  collecting = (async () => {
    try {
      await owner.maintain()
      const session = owner.current
      if (!session || session.state !== 'active') return
      const records = processEvidence()
      const metrics = app.isReady() ? app.getAppMetrics() : []
      const ids = [
        process.pid,
        ...metrics.map((metric) => metric.pid),
        ...records.filter((item) => item.alive).map((item) => item.processId ?? 0)
      ]
      if (process.platform === 'win32') {
        const modules = await collectWindowsModules(ids)
        if (owner.current?.id !== session.id || owner.current.state !== 'active') return
        const text = JSON.stringify(modules)
        if (text !== moduleSnapshot) {
          moduleSnapshot = text
          owner.attachment(`windows/modules-${Date.now()}.json`, {
            collectedAt: new Date().toISOString(),
            processes: modules
          })
        }
        if (Array.isArray(modules))
          for (const record of modules)
            if (record.status === 'failed')
              owner.warn(`模块清单采集失败：PID ${record.processId} · ${record.error}`)
        const errors = await collectWindowsCrashEvents(
          session.startedAt,
          records.map((item) => item.processId ?? 0)
        )
        if (owner.current?.id === session.id && owner.current.state === 'active') {
          owner.attachment('windows/application-errors.json', errors)
          if (
            errors &&
            typeof errors === 'object' &&
            'status' in errors &&
            errors.status === 'failed'
          )
            owner.warn(`系统崩溃事件采集失败：${'error' in errors ? errors.error : 'unknown'}`)
        }
      }
      // Windows collection can take seconds; include dumps completed meanwhile.
      await owner.maintain()
    } catch (error) {
      owner.warn(`系统证据采集失败：${String(error)}`)
    } finally {
      collecting = null
    }
  })()
  return collecting
}
