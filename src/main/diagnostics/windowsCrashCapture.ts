import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { debugCaptureContext } from './debugContext.ts'

/** Block only worker startup, before any business addon is loaded. Never attaches to Electron. */
export function registerWindowsCrashCapture(): void {
  const context = debugCaptureContext()
  if (process.platform !== 'win32' || process.versions.electron || !context?.captureCrashes) return
  const helper = process.env.TWILIGHT_DEBUG_CRASH_HELPER
  const directory = join(context.directory, 'crashes')
  const ready = join(directory, `attach-${process.pid}.json`)
  const failed = (stage: string, error: NodeJS.ErrnoException | string) => {
    process.stderr.write(`[TwilightDiagnostics] crash capture ${stage}: ${String(error)}\n`)
    try {
      mkdirSync(directory, { recursive: true })
      writeFileSync(
        `${ready}.tmp`,
        JSON.stringify({
          status: 'failed',
          processId: process.pid,
          stage,
          errorCode: typeof error === 'object' ? error.errno : undefined,
          error: typeof error === 'object' ? (error.code ?? error.message) : error
        })
      )
      renameSync(`${ready}.tmp`, ready)
    } catch (cause) {
      process.stderr.write(`[TwilightDiagnostics] crash receipt write failed: ${String(cause)}\n`)
    }
  }
  if (!helper || !existsSync(helper)) {
    failed('helper-unavailable', 'Crash helper executable is missing')
    return
  }
  try {
    mkdirSync(directory, { recursive: true })
    rmSync(ready, { force: true })
  } catch (error) {
    failed('directory', error as NodeJS.ErrnoException)
    return
  }
  const child = spawn(
    helper,
    [
      '--pid',
      String(process.pid),
      '--directory',
      directory,
      '--session',
      context.id,
      '--owner',
      String(process.ppid)
    ],
    { stdio: 'ignore', windowsHide: true }
  )
  child.on('error', (error) => failed('launch', error))
  child.unref()
  const deadline = Date.now() + 3000
  while (!existsSync(ready) && Date.now() < deadline)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  if (!existsSync(ready)) failed('attach-timeout', 'No collector acknowledgement after 3 seconds')
  else {
    try {
      if (JSON.parse(readFileSync(ready, 'utf8')).status !== 'attached')
        process.stderr.write(
          '[TwilightDiagnostics] crash helper attachment failed; see attachment receipt\n'
        )
    } catch {
      /* Receipt is exported for inspection. */
    }
  }
}
