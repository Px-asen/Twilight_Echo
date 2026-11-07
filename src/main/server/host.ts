import { createInterface } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeServerRuntime } from './runtime.ts'
import { createServerAdmin } from './admin.ts'

/** These stdout lines are the private inherited-pipe protocol of the native SCM host. */
export const SERVICE_READY = 'TWILIGHT_SERVER_READY'
export const SERVICE_STOP = 'TWILIGHT_SERVER_STOP'
export const SERVICE_STOPPED = 'TWILIGHT_SERVER_STOPPED'
export const SERVICE_STOP_FAILED = 'TWILIGHT_SERVER_STOP_FAILED'

export async function runServerHost(root: string, service = false, bridgeOnly = service): Promise<void> {
  const entryDirectory = dirname(fileURLToPath(import.meta.url))
  const runtime = new NodeServerRuntime()
  runtime.on('log', (name, line) => process.stderr.write(`[${name}] ${line}`))
  runtime.on('failure', (error) => console.error('[server]', error.message))
  await runtime.start({
    root,
    applicationRoot: resolve(entryDirectory, '../..'),
    entryDirectory,
    bridgeOnly
  })
  try {
    const admin = await createServerAdmin(runtime, root)
    let stopping: Promise<void> | undefined
    const shutdown = () => {
      stopping ??= runtime
        .stop(false, () => admin.close())
        .catch((error) => {
          stopping = undefined
          console.error(
            '停止未完成，管理入口仍可用；请检查 status，必要时明确使用 stop --force：',
            error.message
          )
          if (service) process.stdout.write(`${SERVICE_STOP_FAILED}\n`)
        })
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    if (service) {
      const input = createInterface({ input: process.stdin })
      input.on('line', (line) => {
        if (line === SERVICE_STOP) shutdown()
      })
      input.once('close', shutdown)
      runtime.once('closed', () => {
        input.removeAllListeners('close')
        input.close()
        process.stdin.destroy()
        process.stdout.write(`${SERVICE_STOPPED}\n`)
      })
      process.stdout.write(`${SERVICE_READY}\n`)
    } else console.log(JSON.stringify(runtime.health()))
  } catch (error) {
    await runtime.stop()
    throw error
  }
}
