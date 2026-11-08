import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { debugCaptureContext } from './debugContext.ts'
import { sanitizeDiagnosticValue } from './sanitize.ts'
const capped = new Set<string>()

/** A native load can terminate the process before stdout drains. Control-thread only. */
export function recordNativeStartup(event: string, details: unknown): void {
  const context = debugCaptureContext()
  if (!context) return
  try {
    if (existsSync(join(context.directory, 'capacity-reached'))) return
    mkdirSync(join(context.directory, 'startup'), { recursive: true })
    const file = join(context.directory, 'startup', `${process.pid}.jsonl`)
    if (existsSync(file) && statSync(file).size >= 16 * 1024 * 1024) {
      if (!capped.has(file)) {
        capped.add(file)
        process.stderr.write(
          '[TwilightDiagnostics] startup journal reached 16 MiB; later startup events omitted\n'
        )
      }
      return
    }
    appendFileSync(
      file,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        processId: process.pid,
        debugSessionId: context.id,
        event,
        details: sanitizeDiagnosticValue(details)
      }) + '\n'
    )
  } catch (error) {
    process.stderr.write(
      `[TwilightDiagnostics] startup journal failed: ${(error as NodeJS.ErrnoException).code ?? 'WRITE_FAILED'}\n`
    )
  }
}
