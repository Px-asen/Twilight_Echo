import { createServer, createConnection, type Socket } from 'node:net'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import type { CoreRequestEnvelope } from '../../shared/coreProtocol.ts'
import type { NodeServerRuntime } from './runtime.ts'

interface AdminAddress {
  pid: number
  address: string
  token: string
}
type AdminRequest =
  | { kind: 'status' }
  | { kind: 'rpc'; request: CoreRequestEnvelope }
  | { kind: 'stop'; force?: boolean }

export async function createServerAdmin(
  runtime: NodeServerRuntime,
  root: string
): Promise<{ close(): Promise<void> }> {
  const token = randomBytes(32).toString('hex')
  const address =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\twilight-server-${randomUUID()}`
      : join(root, `admin-${randomUUID()}.sock`)
  const runFile = join(root, 'server-run.json')
  const clients = new Set<Socket>()
  const close = async (replyTo?: Socket) => {
    server.close()
    for (const client of clients) if (client !== replyTo) client.destroy()
    await unlink(runFile)
  }
  const server = createServer((socket) => {
    clients.add(socket)
    socket.once('close', () => clients.delete(socket))
    let input = Buffer.alloc(0),
      dispatched = false
    socket.setTimeout(60_000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk) => {
      if (dispatched) return
      input = Buffer.concat([input, chunk])
      if (input.length > 4 * 1024 * 1024) {
        socket.destroy()
        return
      }
      const line = input.indexOf(10)
      if (line < 0) return
      dispatched = true
      void (async () => {
        try {
          const envelope = JSON.parse(input.subarray(0, line).toString('utf8'))
          const supplied = Buffer.from(
            typeof envelope.token === 'string' ? envelope.token : '',
            'hex'
          )
          if (supplied.length !== 32 || !timingSafeEqual(Buffer.from(token, 'hex'), supplied))
            throw new Error('本机管理凭据无效')
          const request = envelope.request as AdminRequest
          let value: unknown
          if (request.kind === 'status') value = runtime.health()
          else if (request.kind === 'rpc') value = await runtime.request(request.request)
          else if (request.kind === 'stop') {
            await runtime.stop(request.force === true, () => close(socket))
            value = runtime.health()
          } else throw new Error('未知的 Server 管理操作')
          socket.end(`${JSON.stringify({ ok: true, value })}\n`)
        } catch (error) {
          socket.end(
            `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code })}\n`
          )
        }
      })()
    })
  })
  server.listen(address)
  await once(server, 'listening')
  try {
    await writeFile(
      runFile,
      JSON.stringify({ pid: process.pid, address, token } satisfies AdminAddress),
      { mode: 0o600 }
    )
  } catch (error) {
    server.close()
    throw error
  }
  return { close: () => close() }
}

export async function requestServerAdmin(root: string, request: AdminRequest): Promise<unknown> {
  const target = JSON.parse(await readFile(join(root, 'server-run.json'), 'utf8')) as AdminAddress
  const socket = createConnection(target.address)
  socket.setTimeout(60_000, () =>
    socket.destroy(new Error('Server 管理请求超时；命令结果可能未知，请先刷新状态'))
  )
  try {
    await once(socket, 'connect')
    socket.setEncoding('utf8')
    const response = new Promise<unknown>((resolve, reject) => {
      let input = ''
      socket.on('data', (data) => {
        input += data
        const line = input.indexOf('\n')
        if (line < 0) return
        try {
          const reply = JSON.parse(input.slice(0, line))
          if (reply.ok) resolve(reply.value)
          else reject(Object.assign(new Error(reply.error), { code: reply.code }))
        } catch (error) {
          reject(error)
        }
      })
      socket.once('error', reject)
      socket.once('end', () => reject(new Error('Server 未确认请求结果，请刷新状态')))
    })
    socket.write(`${JSON.stringify({ token: target.token, request })}\n`)
    return await response
  } finally {
    socket.destroy()
  }
}
