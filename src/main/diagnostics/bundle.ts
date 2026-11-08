import { createReadStream, createWriteStream } from 'node:fs'
import {
  copyFile,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
import { ZipFile } from 'yazl'
import type { DebugSessionStatus, DiagnosticEvent } from '../../shared/diagnostics.ts'
import {
  sanitizeDiagnosticValue as sanitizeValue,
  type DiagnosticSanitizeOptions
} from './sanitize.ts'

export interface DiagnosticCollector {
  name: string
  collect: () => unknown | Promise<unknown>
}
export interface CollectorResult {
  name: string
  status: 'ok' | 'failed' | 'timeout'
  collectedAt: string
  durationMs: number
  value?: unknown
  error?: unknown
}

export async function collectDiagnosticSnapshots(
  collectors: DiagnosticCollector[],
  timeoutMs = 2000,
  totalMs = 15000,
  sanitizeOptions: DiagnosticSanitizeOptions = { preserveLocalPaths: false }
): Promise<CollectorResult[]> {
  const deadline = Date.now() + totalMs
  return Promise.all(
    collectors.slice(0, 32).map(async (collector) => {
      const started = Date.now()
      let timer: NodeJS.Timeout | undefined
      const result = await Promise.race([
        Promise.resolve()
          .then(collector.collect)
          .then(
            (value) => ({ status: 'ok' as const, value: sanitizeValue(value, sanitizeOptions) }),
            (error) => ({ status: 'failed' as const, error: sanitizeValue(error, sanitizeOptions) })
          ),
        new Promise<{ status: 'timeout' }>((resolve) => {
          timer = setTimeout(
            () => resolve({ status: 'timeout' }),
            Math.max(1, Math.min(timeoutMs, deadline - Date.now()))
          )
        })
      ])
      clearTimeout(timer)
      return {
        name: collector.name,
        collectedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        ...result
      }
    })
  )
}

/** Small bounded line reader used for the external merge. No source log or
 * full export is held in memory, even when retention reaches 256 MiB. */
class LineReader {
  readonly decoder = new StringDecoder('utf8')
  private handle: Awaited<ReturnType<typeof open>> | undefined
  private buffer = ''
  private ended = false
  invalidLines = 0
  private skipping = false
  private file: string
  constructor(file: string) {
    this.file = file
  }
  async next(): Promise<string | null> {
    this.handle ??= await open(this.file, 'r')
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (this.skipping) {
          this.skipping = false
          continue
        }
        return line
      }
      if (this.ended) {
        if (this.buffer.length && !this.skipping) this.invalidLines++
        this.buffer = ''
        return null
      }
      const chunk = Buffer.alloc(16384)
      const read = await this.handle.read(chunk)
      if (!read.bytesRead) {
        this.ended = true
        continue
      }
      this.buffer += this.decoder.write(chunk.subarray(0, read.bytesRead))
      if (this.buffer.length > 65536 && !this.buffer.includes('\n')) {
        if (!this.skipping) this.invalidLines++
        this.skipping = true
        this.buffer = ''
      }
    }
  }
  async close() {
    await this.handle?.close()
  }
}

export interface DiagnosticBundleOptions {
  destination: string
  collectors: DiagnosticCollector[]
  snapshot: (directory: string) => Promise<{ files: { name: string }[]; missing: string[] }>
  memoryEvents?: DiagnosticEvent[]
  status?: unknown
  legacyFiles?: { source: string; name: string; module: string }[]
  debugSession?: Pick<DebugSessionStatus, 'id' | 'startedAt' | 'captureCrashes'> &
    Partial<DebugSessionStatus>
  attachments?: { source: string; name: string }[]
}

export async function exportDiagnosticBundle(options: DiagnosticBundleOptions) {
  const sanitizeOptions = {
    preserveLocalPaths: Boolean(options.debugSession),
    maxArrayLength: 16384,
    maxDepth: 16
  }
  const sanitizeDiagnosticValue = (value: unknown) => sanitizeValue(value, sanitizeOptions)
  // The user-selected destination is already writable; do not require access
  // to an unrelated system temp directory to export their evidence.
  const staging = await mkdtemp(join(dirname(options.destination), '.twilight-diagnostics-'))
  const partial = `${options.destination}.${randomUUID()}.partial`
  const files: string[] = []
  const missing: string[] = [...(options.debugSession?.warnings ?? [])]
  const crashSummaries: string[] = []
  const processSummaries: string[] = []
  const reportText = (value: unknown) => String(value ?? 'unknown').replace(/[\r\n`]/g, ' ')
  const coverage: {
    first: string | null
    last: string | null
    events: number
    invalidLines: number
    duplicates: number
  } = { first: null, last: null, events: 0, invalidLines: 0, duplicates: 0 }
  const notable: { timestamp: string; module: string; event: string; level: string }[] = []
  const markers: unknown[] = []
  try {
    const logsDir = join(staging, 'logs')
    await mkdir(logsDir)
    try {
      const snapshot = await options.snapshot(logsDir)
      files.push(...snapshot.files.map((file) => `logs/${file.name}`))
      missing.push(...snapshot.missing)
    } catch (error) {
      missing.push(`disk snapshot: ${String(sanitizeDiagnosticValue(error))}`)
    }
    const collectors = await collectDiagnosticSnapshots(
      options.collectors,
      2000,
      15000,
      sanitizeOptions
    )
    for (const result of collectors)
      if (result.status !== 'ok') missing.push(`${result.name}: ${result.status}`)
      else if (
        result.value &&
        typeof result.value === 'object' &&
        'available' in result.value &&
        result.value.available === false
      )
        missing.push(`${result.name}: unavailable`)
    await writeFile(join(staging, 'snapshots.json'), `${JSON.stringify(collectors, null, 2)}\n`)
    files.push('snapshots.json')
    let attachmentBytes = 0
    for (const attachment of options.attachments ?? []) {
      if (!/^debug\/[\w./-]+$/.test(attachment.name) || attachment.name.includes('..'))
        throw new Error('Invalid attachment name')
      try {
        const size = (await stat(attachment.source)).size
        if (attachmentBytes + size > 1024 * 1024 * 1024) {
          missing.push(`${attachment.name}: capacity exceeded`)
          continue
        }
        const target = join(staging, attachment.name)
        await mkdir(join(target, '..'), { recursive: true })
        if (attachment.name.endsWith('.json')) {
          if (size > 16 * 1024 * 1024) {
            missing.push(`${attachment.name}: JSON exceeds 16 MiB`)
            continue
          }
          const value = sanitizeDiagnosticValue(
            JSON.parse(await readFile(attachment.source, 'utf8'))
          ) as any
          if (attachment.name.startsWith('debug/processes/')) {
            processSummaries.push(
              `- ${reportText(value.role)} · PID ${reportText(value.processId)} · ${value.alive ? '采集时存活' : '已退出'} · 最后采集 ${reportText(value.snapshot?.collectedAt)} · ${reportText(value.error ?? value.captureState ?? '见缓存快照')}`
            )
          }
          if (attachment.name.startsWith('debug/crashes/') && value.exceptionCode) {
            const address = /^0x[\da-f]+$/i.test(value.exceptionAddress ?? '')
              ? BigInt(value.exceptionAddress)
              : null
            const faulting =
              address !== null && Array.isArray(value.modules)
                ? value.modules.find(
                    (module: any) =>
                      /^0x[\da-f]+$/i.test(module.baseAddress ?? '') &&
                      Number.isSafeInteger(module.size) &&
                      module.size >= 0 &&
                      address >= BigInt(module.baseAddress) &&
                      address < BigInt(module.baseAddress) + BigInt(module.size)
                  )
                : undefined
            const offset = faulting
              ? `0x${(address! - BigInt(faulting.baseAddress)).toString(16)}`
              : 'unknown'
            crashSummaries.push(
              `- PID ${reportText(value.processId)} · 异常 ${reportText(value.exceptionCode)} · ${reportText(faulting?.name)} + ${offset} · 转储 ${reportText(value.dumpStatus)}`
            )
          }
          if (
            attachment.name === 'debug/windows/application-errors.json' &&
            Array.isArray(value.events)
          )
            for (const event of value.events.slice(-20))
              crashSummaries.push(
                `- ${reportText(event.timestamp)} · PID ${reportText(event.processId)} · 异常 ${reportText(event.exceptionCode)} · ${reportText(event.module)} + ${reportText(event.faultingOffset)}`
              )
          await writeFile(target, JSON.stringify(value, null, 2))
        } else if (attachment.name.endsWith('.jsonl')) {
          const reader = new LineReader(attachment.source),
            output = await open(target, 'w')
          try {
            for (let line = await reader.next(); line !== null; line = await reader.next()) {
              try {
                await output.write(JSON.stringify(sanitizeDiagnosticValue(JSON.parse(line))) + '\n')
              } catch {
                missing.push(`${attachment.name}: invalid event`)
              }
            }
          } finally {
            await reader.close()
            await output.close()
          }
        } else if (attachment.name.endsWith('.dmp')) await copyFile(attachment.source, target)
        else continue
        files.push(attachment.name)
        attachmentBytes += size
      } catch (error) {
        missing.push(`${attachment.name}: ${String(error)}`)
      }
    }
    if (options.memoryEvents?.length) {
      await writeFile(
        join(logsDir, 'memory-fallback.jsonl'),
        options.memoryEvents.map((event) => JSON.stringify(event)).join('\n') + '\n'
      )
      files.push('logs/memory-fallback.jsonl')
    }
    let legacyBytes = 0
    for (const legacy of (options.legacyFiles ?? []).slice(0, 32)) {
      try {
        const size = (await stat(legacy.source)).size
        if (size > 8 * 1024 * 1024 || legacyBytes + size > 32 * 1024 * 1024) {
          missing.push(`${legacy.name}: legacy size limit`)
          continue
        }
        legacyBytes += size
        const raw = await readFile(legacy.source, 'utf8')
        const lines = raw
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line, index) => {
            try {
              const entry = JSON.parse(line)
              return JSON.stringify({
                ...entry,
                module: entry.module ?? legacy.module,
                eventId: entry.eventId ?? `legacy-${legacy.name}-${index}`,
                details: sanitizeDiagnosticValue(entry.details)
              })
            } catch {
              return JSON.stringify({
                timestamp: /^\[([^\]]+)\]/.exec(line)?.[1] ?? new Date().toISOString(),
                module: legacy.module,
                event: 'legacy.output',
                level: 'info',
                eventId:
                  /\[eventId=([\w.:-]+)\]/.exec(line)?.[1] ?? `legacy-${legacy.name}-${index}`,
                details: sanitizeDiagnosticValue({ message: line })
              })
            }
          })
        const name = `legacy-${legacy.name.replace(/[^\w.-]/g, '_')}.jsonl`
        await writeFile(join(logsDir, name), lines.join('\n') + '\n')
        files.push(`logs/${name}`)
      } catch {
        missing.push(`${legacy.name}: unavailable`)
      }
    }

    const sortDir = join(staging, 'sort')
    await mkdir(sortDir)
    let chunk: { timestamp: string; eventId: string; line: string; priority: number }[] = []
    let chunkBytes = 0
    const chunks: string[] = []
    const flushChunk = async () => {
      if (!chunk.length) return
      chunk.sort(
        (a, b) =>
          a.timestamp.localeCompare(b.timestamp) ||
          a.eventId.localeCompare(b.eventId) ||
          a.priority - b.priority
      )
      const file = join(sortDir, `${chunks.length}.jsonl`)
      await writeFile(file, chunk.map((entry) => entry.line).join('\n') + '\n')
      chunks.push(file)
      chunk = []
      chunkBytes = 0
    }
    for (const file of files.filter((file) => file.startsWith('logs/'))) {
      const reader = new LineReader(join(staging, file))
      // Rewrite sanitized lines into the snapshot itself too; legacy/native
      // data must not bypass export sanitization by remaining in a raw file.
      const safeFile = `${join(staging, file)}.safe`
      const output = await open(safeFile, 'w')
      try {
        for (let line = await reader.next(); line !== null; line = await reader.next()) {
          try {
            const raw = JSON.parse(line)
            const nativeSequence = raw.nativeSequence || raw.details?.engineSequence
            const nativeTimestamp = raw.nativeSequence
              ? raw.timestamp
              : raw.details?.engineTimestamp
            if (
              nativeSequence > 0 &&
              typeof nativeTimestamp === 'string' &&
              /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(nativeTimestamp)
            ) {
              // Legacy audio reports and the independent journal refer to the
              // same native ring event, even when they were drained later.
              raw.eventId = `engine:${nativeTimestamp}:${nativeSequence}:${raw.event}`
              raw.timestamp = nativeTimestamp
            }
            if (
              typeof raw.timestamp !== 'string' ||
              !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(raw.timestamp) ||
              !Number.isFinite(Date.parse(raw.timestamp)) ||
              typeof raw.event !== 'string'
            )
              throw new Error('invalid event')
            const entry = sanitizeDiagnosticValue(raw) as Record<string, unknown>
            let eventId = String(
              raw.eventId ??
                `${raw.processInstanceId ?? raw.sessionId ?? file}:${raw.sequence ?? coverage.invalidLines}`
            )
            if (!/^[\w.:-]{1,160}$/.test(eventId))
              eventId = createHash('sha256').update(eventId).digest('hex')
            entry.eventId = eventId
            const safe = JSON.stringify(entry)
            await output.write(`${safe}\n`)
            chunk.push({
              timestamp: raw.timestamp,
              eventId,
              line: safe,
              priority: raw.processRole === 'native' ? 0 : 1
            })
            chunkBytes += Buffer.byteLength(safe)
            if (chunkBytes >= 2 * 1024 * 1024) await flushChunk()
          } catch {
            coverage.invalidLines++
          }
        }
      } finally {
        coverage.invalidLines += reader.invalidLines
        await reader.close()
        await output.close()
      }
      await rename(safeFile, join(staging, file))
    }
    await flushChunk()
    const readers = chunks.map((file) => new LineReader(file))
    const heads = await Promise.all(readers.map((reader) => reader.next()))
    const timeline = await open(join(staging, 'timeline.jsonl'), 'w')
    const seen = new Map<string, true>()
    try {
      while (true) {
        let selected = -1
        let selectedKey = ''
        for (let index = 0; index < heads.length; index++) {
          if (heads[index] === null) continue
          const entry = JSON.parse(heads[index]!)
          const key = `${entry.timestamp}|${entry.eventId}`
          if (
            selected < 0 ||
            key < selectedKey ||
            (key === selectedKey && entry.processRole === 'native')
          ) {
            selected = index
            selectedKey = key
          }
        }
        if (selected < 0) break
        const line = heads[selected]!
        const entry = JSON.parse(line)
        if (!seen.has(entry.eventId)) {
          seen.set(entry.eventId, true)
          if (seen.size > 10000) seen.delete(seen.keys().next().value!)
          await timeline.write(`${line}\n`)
          coverage.events++
          if (/problem\.marked|incident\./.test(entry.event)) {
            markers.push(entry)
            if (markers.length > 256) markers.shift()
          }
          coverage.first ??= entry.timestamp
          coverage.last = entry.timestamp
          if (
            ['warn', 'warning', 'error', 'fatal'].includes(entry.level) ||
            /problem|incident/.test(entry.event)
          ) {
            notable.push({
              timestamp: entry.timestamp,
              module: entry.module ?? 'audio',
              event: entry.event,
              level: entry.level
            })
            if (notable.length > 80) notable.shift()
          }
        } else coverage.duplicates++
        heads[selected] = await readers[selected].next()
      }
    } finally {
      await timeline.close()
      await Promise.all(readers.map((reader) => reader.close()))
    }
    files.push('timeline.jsonl')
    await writeFile(join(staging, 'markers.json'), JSON.stringify(markers, null, 2) + '\n')
    files.push('markers.json')
    const snapshotFailures = collectors.filter((result) => result.status !== 'ok')
    const report = `# Twilight Echo 诊断包\n\n生成时间：${new Date().toISOString()}\n\n日志覆盖：${coverage.first ?? '无'} → ${coverage.last ?? '无'}\n\n记录 ${coverage.events} 条事件；去重 ${coverage.duplicates} 条；无效或截断记录 ${coverage.invalidLines} 条。\n\n## 采集状态\n\n${collectors.map((result) => `- ${result.name}：${result.status}（${result.durationMs} ms）`).join('\n')}\n\n缺失文件：${missing.length ? missing.join('；') : '无'}\n\n## 最近的重要事件\n\n${notable.map((entry) => `- ${entry.timestamp} [${entry.level}] ${entry.module} / ${entry.event}`).join('\n') || '没有记录到重要事件。'}\n\n## 如何排查\n\n先在 timeline.jsonl 中查找 problem.marked 或 incident，再按 operationId、requestId、serviceGeneration 和 streamToken 关联操作。snapshots.json 中的缓存状态带数据年龄；采集失败不能当作服务正常。原生健康计数是相邻采样，不代表整个引擎的原子快照。\n\n日志经过脱敏，不包含音频内容、认证密钥或完整歌曲地址。日志只在本机保存。\n`
    const debugSummary = options.debugSession
      ? `## 调试会话\n\n${options.debugSession.id} · ${options.debugSession.startedAt}\n\n完整本地路径已保留。认证字段已过滤。${files.some((name) => name.endsWith('.dmp')) ? '包含崩溃转储；转储可能含敏感内存片段，未经过文本脱敏。' : '未包含崩溃转储。'}\n\n问题标记见 markers.json；进程最后状态见 debug/processes/；原生加载阶段见 debug/startup/；系统异常和模块清单见 debug/windows/ 与 debug/crashes/。\n\n`
      : ''
    const evidenceSummary = options.debugSession
      ? `## 问题标记与相关操作\n\n${
          markers
            .slice(-12)
            .map(
              (entry: any) =>
                `- ${reportText(entry.timestamp)} · ${reportText(entry.details?.note ?? entry.event)} · operationId=${reportText(entry.operationId)} · requestId=${reportText(entry.requestId)}`
            )
            .join('\n') || '本次会话没有人工标记。'
        }\n\n## 故障进程与异常\n\n${crashSummaries.slice(-20).join('\n') || '没有采集到系统异常记录；转储文件和采集失败原因见 debug/crashes/ 与会话状态。'}\n\n## 进程最后状态\n\n${processSummaries.slice(-32).join('\n') || '未取得进程缓存。'}\n\n`
      : ''
    await writeFile(
      join(staging, 'README.md'),
      report
        .replace('## 采集状态', `${debugSummary}${evidenceSummary}## 采集状态`)
        .replace(
          '日志经过脱敏，不包含音频内容、认证密钥或完整歌曲地址。',
          options.debugSession
            ? '文本日志过滤认证信息并保留完整本地路径。'
            : '日志经过脱敏，不包含音频内容、认证密钥或完整歌曲地址。'
        )
    )
    files.push('README.md')
    const hashes: { name: string; bytes: number; sha256: string }[] = []
    for (const name of files) {
      const hash = createHash('sha256')
      for await (const data of createReadStream(join(staging, name))) hash.update(data)
      hashes.push({
        name,
        bytes: (await stat(join(staging, name))).size,
        sha256: hash.digest('hex')
      })
    }
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      coverage,
      status: sanitizeDiagnosticValue(options.status),
      missing,
      snapshotFailures: snapshotFailures.map((result) => result.name),
      files: hashes,
      privacy: {
        localOnly: true,
        audioPayloadCaptured: false,
        credentialsCaptured: files.some((name) => name.endsWith('.dmp'))
          ? 'possible-in-crash-dumps'
          : false,
        fullPathsCaptured: Boolean(options.debugSession),
        crashDumpsIncluded: files.some((name) => name.endsWith('.dmp'))
      }
    }
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    files.push('manifest.json')
    const zip = new ZipFile()
    for (const name of files) zip.addFile(join(staging, name), name)
    const writing = pipeline(zip.outputStream, createWriteStream(partial))
    zip.end()
    await writing
    await rename(partial, options.destination)
    return { filePath: options.destination, manifest }
  } finally {
    await rm(partial, { force: true }).catch(() => undefined)
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}
