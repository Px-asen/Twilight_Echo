import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DebugSessionStatus, DiagnosticEvent } from '../../shared/diagnostics.ts'
import { DiagnosticWriterClient } from './client.ts'
import { DiagnosticStore } from './store.ts'
import { setDebugCaptureContext } from './debugContext.ts'
import { sanitizeDiagnosticValue } from './sanitize.ts'

export const DEBUG_BUDGET = 1024 * 1024 * 1024
export const DEBUG_RETENTION_MS = 7 * 86400000
const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id)

export async function diagnosticFiles(
  directory: string,
  prefix = ''
): Promise<{ name: string; bytes: number }[]> {
  const files: { name: string; bytes: number }[] = []
  let entries
  try {
    entries = await readdir(join(directory, prefix), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files
    throw error
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name.endsWith('.tmp')) continue
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...(await diagnosticFiles(directory, name)))
    else if (entry.isFile()) {
      try {
        files.push({ name, bytes: (await stat(join(directory, name))).size })
      } catch (error) {
        // Writers atomically replace receipts and rotate logs while we inventory them.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  return files
}

/** One desktop-owned session, independent of app and service lifetimes. */
export class DebugSessionController {
  private session: DebugSessionStatus | null = null
  private writer: DiagnosticWriterClient | null = null
  private attachments = Promise.resolve()
  private capacityReached = false
  private attachmentBytes = 0
  private readonly pointer: string
  readonly root: string
  constructor(root: string) {
    this.root = root
    this.pointer = join(root, 'current.json')
    try {
      const id = JSON.parse(readFileSync(this.pointer, 'utf8')).id
      if (typeof id === 'string' && validId(id)) this.session = this.load(id)
    } catch {
      /* No existing debug session. */
    }
  }
  private load(id: string): DebugSessionStatus {
    if (!validId(id)) throw new Error('Invalid debug session identifier')
    const directory = join(this.root, id)
    const value = JSON.parse(
      readFileSync(join(directory, 'session.json'), 'utf8')
    ) as DebugSessionStatus
    if (
      value.id !== id ||
      !['active', 'restart-required', 'stopping', 'ended'].includes(value.state)
    )
      throw new Error('Invalid debug session state')
    return { ...value, directory }
  }
  get current(): DebugSessionStatus | null {
    return this.session ? structuredClone(this.session) : null
  }
  get(id: string): DebugSessionStatus {
    return this.session?.id === id ? this.current! : this.load(id)
  }
  private save(): void {
    if (!this.session) return
    mkdirSync(this.session.directory, { recursive: true })
    const target = join(this.session.directory, 'session.json')
    writeFileSync(`${target}.tmp`, JSON.stringify(this.session, null, 2))
    renameSync(`${target}.tmp`, target)
    writeFileSync(`${this.pointer}.tmp`, JSON.stringify({ id: this.session.id }))
    renameSync(`${this.pointer}.tmp`, this.pointer)
  }
  /** Called before Electron creates any children. */
  boot(): DebugSessionStatus | null {
    if (!this.session) return null
    if (this.session.state === 'stopping') {
      this.session.state = 'ended'
      this.session.endedAt = new Date().toISOString()
      if (this.session.crashes?.electron !== 'failed') this.setCrashpadState('stopped')
      this.save()
    } else if (this.session.state === 'active' || this.session.state === 'restart-required') {
      this.session.state = 'active'
      this.activate()
      this.save()
    }
    return this.current
  }
  private activate(): void {
    const session = this.session!
    this.writer = new DiagnosticWriterClient(join(session.directory, 'logs'), null, {
      maxTotalBytes: 512 * 1024 * 1024
    })
    this.capacityReached = false
    setDebugCaptureContext({
      id: session.id,
      directory: session.directory,
      captureCrashes: session.captureCrashes
    })
  }
  start(captureCrashes: boolean): DebugSessionStatus {
    if (this.session && this.session.state !== 'ended') throw new Error('已有调试会话正在进行')
    const id = randomUUID()
    this.session = {
      id,
      startedAt: new Date().toISOString(),
      state: captureCrashes ? 'restart-required' : 'active',
      captureCrashes,
      directory: join(this.root, id),
      bytes: 0,
      maxTotalBytes: DEBUG_BUDGET,
      droppedEvents: 0,
      warnings: []
    }
    this.session.crashes = {
      electron: captureCrashes ? 'pending' : 'disabled',
      native: !captureCrashes
        ? 'disabled'
        : process.platform === 'win32'
          ? 'windows-helper'
          : 'unsupported',
      dumps: 0,
      dumpBytes: 0,
      collectors: []
    }
    this.save()
    if (!captureCrashes) this.activate()
    return this.current!
  }
  async stop(): Promise<DebugSessionStatus | null> {
    if (!this.session || this.session.state === 'ended' || this.session.state === 'stopping')
      return this.current
    this.session.state =
      this.session.captureCrashes && this.session.state === 'active' ? 'stopping' : 'ended'
    this.session.endedAt = new Date().toISOString()
    this.save()
    setDebugCaptureContext(null)
    await this.writer?.close()
    this.writer = null
    await this.attachments
    return this.current
  }
  queueExport(destination: string, includeCrashes: boolean): void {
    if (!this.session) throw new Error('No debug session')
    this.session.pendingExport = { destination, includeCrashes }
    this.save()
  }
  exportResult(error?: string): void {
    if (!this.session?.pendingExport) return
    if (error) this.session.pendingExport.error = error
    else delete this.session.pendingExport
    this.save()
  }
  warn(message: string): void {
    if (!this.session) return
    if (!this.session.warnings.includes(message)) this.session.warnings.push(message)
    this.session.warnings = this.session.warnings.slice(-64)
  }
  setCrashpadState(state: NonNullable<DebugSessionStatus['crashes']>['electron']): void {
    if (this.session?.crashes) this.session.crashes.electron = state
  }
  private async readCrashStatus(files: { name: string; bytes: number }[]): Promise<void> {
    const session = this.session
    if (!session?.crashes) return
    const dumps = files.filter((file) => file.name.endsWith('.dmp'))
    session.crashes.dumps = dumps.length
    session.crashes.dumpBytes = dumps.reduce((sum, file) => sum + file.bytes, 0)
    session.crashes.collectors = []
    for (const file of files) {
      if (!/^crashes\/(?:attach-\d+|crash-[\w-]+)\.json$/.test(file.name)) continue
      try {
        if (file.bytes > 16 * 1024 * 1024) throw new Error('Crash metadata exceeds 16 MiB')
        const record = JSON.parse(await readFile(join(session.directory, file.name), 'utf8'))
        const processId = record.processId ?? Number(file.name.match(/attach-(\d+)/)?.[1])
        if (file.name.startsWith('crashes/attach-')) {
          session.crashes.collectors.push({
            processId,
            status: record.status === 'attached' ? 'attached' : 'failed',
            architecture: record.architecture,
            stage: record.stage,
            errorCode: record.errorCode
          })
        }
        if (record.status === 'failed' || record.dumpStatus === 'failed')
          this.warn(
            `崩溃采集失败：PID ${processId} · ${record.stage ?? 'dump'} · 系统错误 ${record.errorCode ?? 'unknown'}`
          )
      } catch (error) {
        this.warn(`${file.name}: ${String(error)}`)
      }
    }
  }
  record(event: DiagnosticEvent): void {
    if (!this.writer || !this.session || event.debugSessionId !== this.session.id) return
    if (this.capacityReached) {
      this.session.droppedEvents++
      return
    }
    this.writer.record(event)
  }
  emergency(event: DiagnosticEvent): void {
    if (this.writer && !this.capacityReached && event.debugSessionId === this.session?.id)
      this.writer.emergency(event)
  }
  attachment(name: string, value: unknown): void {
    const session = this.session
    if (!session || session.state !== 'active' || this.capacityReached) return
    if (!/^[\w./-]+\.json$/.test(name) || name.includes('..') || name.startsWith('/'))
      throw new Error('Invalid diagnostic attachment')
    const safe = sanitizeDiagnosticValue(value, {
      preserveLocalPaths: true,
      maxArrayLength: 16384,
      maxDepth: 16
    })
    const body = JSON.stringify(safe, null, 2)
    const bytes = Buffer.byteLength(body)
    if (bytes > 16 * 1024 * 1024 || this.attachmentBytes + bytes > 16 * 1024 * 1024) {
      session.droppedEvents++
      this.warn(`${name}: attachment queue capacity reached`)
      return
    }
    this.attachmentBytes += bytes
    this.attachments = this.attachments
      .then(async () => {
        const file = join(session.directory, name)
        await mkdir(join(file, '..'), { recursive: true })
        await writeFile(`${file}.tmp`, body)
        const { rename } = await import('node:fs/promises')
        await rename(`${file}.tmp`, file)
      })
      .catch((error) => {
        this.warn(`${name}: ${String(error)}`)
      })
      .finally(() => {
        this.attachmentBytes -= bytes
      })
  }
  async maintain(): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => [])
    const sessions: { directory: string; status: DebugSessionStatus; bytes: number }[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !validId(entry.name)) continue
      try {
        const status = this.get(entry.name)
        const files = await diagnosticFiles(status.directory)
        // Keep at most three completed dumps. Never remove an in-progress file.
        const dumps = (
          await Promise.all(
            files
              .filter((file) => file.name.endsWith('.dmp'))
              .map(async (file) => ({
                file,
                modified: (await stat(join(status.directory, file.name))).mtimeMs
              }))
          )
        )
          .sort((a, b) => a.modified - b.modified)
          .map((item) => item.file)
        const removed = dumps.slice(0, Math.max(0, dumps.length - 3))
        for (const old of removed) await rm(join(status.directory, old.name))
        const retained = files.filter((file) => !removed.includes(file))
        const bytes = retained.reduce((sum, file) => sum + file.bytes, 0)
        sessions.push({ directory: status.directory, status, bytes })
        if (this.session?.id === status.id) {
          this.session.bytes = bytes
          if (removed.length) this.warn('每个会话最多保留 3 份完成的转储，较早转储已清理')
          await this.readCrashStatus(retained)
        }
      } catch (error) {
        this.warn(`Retention: ${String(error)}`)
      }
    }
    let total = sessions.reduce((sum, session) => sum + session.bytes, 0)
    for (const session of sessions.sort((a, b) =>
      a.status.startedAt.localeCompare(b.status.startedAt)
    )) {
      if (session.status.state !== 'ended' || session.status.pendingExport) continue
      if (
        total <= DEBUG_BUDGET &&
        Date.now() - Date.parse(session.status.endedAt!) <= DEBUG_RETENTION_MS
      )
        continue
      await rm(session.directory, { recursive: true, force: true })
      if (session.status.id === this.session?.id) {
        this.session = null
        await rm(this.pointer, { force: true })
      }
      total -= session.bytes
    }
    this.capacityReached = total >= DEBUG_BUDGET
    if (this.capacityReached) {
      this.warn('调试记录达到 1 GiB 上限，新增记录已停止，请结束并导出')
      if (this.session) await writeFile(join(this.session.directory, 'capacity-reached'), '')
    }
    const status = await this.writer?.status()
    if (status?.error) this.warn(status.error)
    if (this.session && status)
      this.session.droppedEvents = Math.max(this.session.droppedEvents, status.droppedEvents)
    this.save()
  }
  async snapshot(id: string, destination: string) {
    const session = this.get(id)
    if (id === this.session?.id)
      await this.writer?.flush().catch((error) => this.warn(String(error)))
    await this.attachments
    const result = await new DiagnosticStore({
      directory: join(session.directory, 'logs')
    }).snapshot(destination)
    return result
  }
  async attachmentsFor(
    id: string,
    includeCrashes: boolean
  ): Promise<{ source: string; name: string }[]> {
    await this.attachments
    const session = this.get(id)
    const files = await diagnosticFiles(session.directory)
    return files
      .filter(
        (file) =>
          !file.name.startsWith('logs/') &&
          !file.name.endsWith('.tmp') &&
          (includeCrashes || !file.name.endsWith('.dmp')) &&
          !/lock|settings\.dat|metrics/.test(file.name)
      )
      .map((file) => ({ source: join(session.directory, file.name), name: `debug/${file.name}` }))
  }
  async coreSnapshot(id: string): Promise<Record<string, any>> {
    await this.attachments
    const session = this.get(id)
    const directory = join(session.directory, 'processes')
    const candidates: any[] = []
    for (const name of await readdir(directory).catch(() => [])) {
      if (!/^[\w-]+\.json$/.test(name)) continue
      try {
        const record = JSON.parse(await readFile(join(directory, name), 'utf8'))
        if (record.role === 'twilight-core' && record.snapshot?.value?.audio)
          candidates.push(record)
      } catch {
        /* Interrupted metadata writes are not authoritative snapshots. */
      }
    }
    const core = candidates.sort((a, b) =>
      b.snapshot.collectedAt.localeCompare(a.snapshot.collectedAt)
    )[0]
    if (!core)
      return {
        available: false,
        evidenceOrigin: 'debug-session',
        reason: 'No saved Core snapshot for this session'
      }
    return {
      available: true,
      evidenceOrigin: 'debug-session',
      processId: core.processId,
      aliveAtCapture: core.alive,
      collectedAt: core.snapshot.collectedAt,
      dataAgeMs: Date.now() - Date.parse(core.snapshot.collectedAt),
      value: core.snapshot.value
    }
  }
  async close(): Promise<void> {
    await this.writer?.close()
    await this.attachments
    this.save()
  }
}
