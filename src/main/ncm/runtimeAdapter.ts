import { existsSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { Dispatcher } from 'undici'
import {
  NcmApiService,
  NCM_API_HOST,
  type NcmApiServiceOptions
} from '../../core/providers/ncmApi.ts'

const nodeRequire = createRequire(import.meta.url)

/** The OS may assign a valid loopback port (such as 6000) blocked by Fetch. */
export function createNcmLoopbackTransport(
  dispatcher?: Dispatcher
): Required<Pick<NcmApiServiceOptions, 'fetch' | 'closeTransport'>> {
  let activeDispatcher: Dispatcher | null = dispatcher ?? null
  return {
    fetch: async (url, init) => {
      const { Agent, request } = nodeRequire('undici') as typeof import('undici')
      activeDispatcher ??= new Agent({
        connections: 8,
        keepAliveTimeout: 30_000,
        keepAliveMaxTimeout: 60_000
      })
      const response = await request(url, {
        signal: init.signal,
        headers: init.headers,
        dispatcher: activeDispatcher,
        maxRedirections: 20
      })
      const headers = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item)
        } else if (value !== undefined) headers.set(name, value)
      }
      return { status: response.statusCode, headers, text: () => response.body.text() }
    },
    closeTransport: async () => {
      const current = activeDispatcher
      activeDispatcher = null
      if (current) await current.close()
    }
  }
}

/** Node/package adapter shared by the legacy main entry and the utility Core. */
export function createNcmApiRuntime(): NcmApiService<Server> {
  return new NcmApiService<Server>({
    ...createNcmLoopbackTransport(),
    startServer: async () => {
      const tokenPath = join(tmpdir(), 'anonymous_token')
      if (!existsSync(tokenPath)) writeFileSync(tokenPath, '', 'utf8')
      const { serveNcmApi } = await import('@neteasecloudmusicapienhanced/api/server.js')
      const api = await serveNcmApi({
        // The package treats numeric zero as absent; a string requests an OS-assigned port.
        port: '0' as unknown as number,
        host: NCM_API_HOST,
        checkVersion: false
      })
      if (!api.server) throw new Error('NetEase API server did not return a listener')
      return api.server
    }
  })
}
