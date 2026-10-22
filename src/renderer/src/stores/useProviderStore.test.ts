import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { computed, ref } from 'vue'
import ts from 'typescript'
import { toProviderIpcArgs } from '../providers/mediaProvider.ts'

const source = readFileSync(new URL('./useProviderStore.ts', import.meta.url), 'utf8')

function providerStoreFixture(
  list: () => Promise<unknown[]>,
  initialOptions?: { listen?: boolean }
) {
  const listeners: Array<() => void> = []
  const intervals = new Map<number, () => void>()
  let intervalId = 0
  let clearCalls = 0
  const exports: {
    useProviderStore?: (options?: { listen?: boolean }) => {
      syncProviders: () => Promise<void>
      hasProvider: (id: string) => boolean
    }
  } = {}
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      exports,
      require: (id: string) => {
        if (id === 'vue') return { computed, ref }
        if (id === '@renderer/providers/mediaProvider') return { toProviderIpcArgs }
        throw new Error(`Unexpected dependency: ${id}`)
      },
      window: {
        setInterval: (callback: () => void, delay: number) => {
          assert.equal(delay, 30_000)
          intervals.set(++intervalId, callback)
          return intervalId
        },
        clearInterval: (id: number) => {
          clearCalls++
          intervals.delete(id)
        },
        api: {
          providers: { list },
          plugins: { onChanged: (listener: () => void) => listeners.push(listener) }
        }
      }
    }
  )
  return {
    store: exports.useProviderStore!(initialOptions),
    useStore: exports.useProviderStore!,
    changed: () => listeners.forEach((fn) => fn()),
    poll: () => intervals.forEach((fn) => fn()),
    get listenerCount() {
      return listeners.length
    },
    get intervalCount() {
      return intervals.size
    },
    get clearCalls() {
      return clearCalls
    }
  }
}

test('preview-first provider store stays idle and a later live caller starts shared listeners once', async () => {
  let calls = 0
  const f = providerStoreFixture(
    async () => {
      calls++
      return [{ id: 'ncm', name: 'NCM', capabilities: ['login'] }]
    },
    { listen: false }
  )
  assert.equal(f.listenerCount, 0)
  assert.equal(f.intervalCount, 0)
  f.changed()
  f.poll()
  assert.equal(calls, 0, 'a preview does not initialize background provider requests')

  const live = f.useStore()
  f.useStore()
  f.useStore({ listen: false })
  assert.equal(f.listenerCount, 1)
  assert.equal(f.intervalCount, 1)
  assert.equal(f.clearCalls, 0)
  f.changed()
  await live.syncProviders()
  assert.equal(calls, 1)
  assert.equal(live.hasProvider('ncm'), true)
  f.poll()
  await live.syncProviders()
  assert.equal(calls, 2, 'the live caller still receives provider health polling')
})

test('live-first provider store keeps its listener and polling when previews join', async () => {
  let calls = 0
  const f = providerStoreFixture(async () => {
    calls++
    return []
  })
  assert.equal(f.listenerCount, 1)
  assert.equal(f.intervalCount, 1)
  f.useStore({ listen: false })
  f.useStore({ listen: false })
  assert.equal(f.listenerCount, 1, 'previews do not register another lifecycle listener')
  assert.equal(f.intervalCount, 1, 'previews do not replace or remove the live interval')
  assert.equal(f.clearCalls, 0)
  f.changed()
  await f.store.syncProviders()
  f.poll()
  await f.store.syncProviders()
  assert.equal(calls, 2, 'both live update paths survive preview initialization')
})

test('provider navigation waits for fresh lifecycle state when a list is already pending', async () => {
  let resolve!: (value: unknown[]) => void
  const stale = new Promise<unknown[]>((done) => {
    resolve = done
  })
  const provider = { id: 'ncm', name: 'NCM', capabilities: ['login'] }
  let calls = 0
  const f = providerStoreFixture(async () => (++calls === 1 ? stale : [provider]))
  const first = f.store.syncProviders()
  const second = f.store.syncProviders()
  assert.equal(calls, 1, 'concurrent readers share the request')
  f.changed()
  resolve([])
  await Promise.all([first, second])
  assert.equal(calls, 2)
  assert.equal(f.store.hasProvider('ncm'), true)
})

test('a stale provider list cannot undo disabling a plugin', async () => {
  let resolve!: (value: unknown[]) => void
  const stale = new Promise<unknown[]>((done) => {
    resolve = done
  })
  const provider = { id: 'ncm', name: 'NCM', capabilities: ['login'] }
  let calls = 0
  const f = providerStoreFixture(async () => (++calls === 1 ? stale : []))
  const pending = f.store.syncProviders()
  f.changed()
  resolve([provider])
  await pending
  assert.equal(f.store.hasProvider('ncm'), false)
})

test('homepage section arguments cross IPC after provider metadata becomes reactive', async () => {
  const metadata = ref({
    ui: {
      streamingSections: [
        { method: 'fetchRecommendSongs', args: ['daily'] },
        { method: 'fetchRecommendSongs', args: ['rising'] }
      ]
    }
  })
  const received: unknown[][] = []
  const functionSource = source.slice(
    source.indexOf('async function callProvider<T>('),
    source.indexOf('export function useProviderStore(')
  )
  const callProvider = runInNewContext(`${stripTypeScriptTypes(functionSource)}\ncallProvider`, {
    toProviderIpcArgs,
    window: {
      api: {
        providers: {
          call: async (_provider: string, _method: string, args: unknown[]) => {
            received.push(structuredClone(args))
            return []
          }
        }
      }
    }
  }) as (id: string, method: string, args: unknown[]) => Promise<unknown>
  for (const section of metadata.value.ui.streamingSections) {
    await callProvider('kugou', section.method, section.args)
  }
  assert.deepEqual(received, [['daily'], ['rising']])
})

test('provider store exposes provider health metadata from the host', () => {
  assert.match(source, /export interface ProviderHealth/)
  assert.match(source, /health\?: ProviderHealth/)
  assert.match(source, /health: provider\.health as ProviderHealth \| undefined/)
  assert.match(source, /supportedMethods: provider\.supportedMethods \?\? \[\]/)
})

test('streaming library surfaces provider health diagnostics to users', () => {
  const streamingSource = readFileSync(
    new URL('../components/StreamingLibrary.vue', import.meta.url),
    'utf8'
  )

  assert.match(streamingSource, /buildProviderHealthPresentation/)
  assert.match(streamingSource, /type ProviderHealthInput/)
  assert.match(streamingSource, /health\?: ProviderHealthInput/)
  assert.match(streamingSource, /loggedIn\?: boolean/)
  assert.match(streamingSource, /providerMenuHealthLabel/)
  assert.match(streamingSource, /providerMenuHealthDetail/)
  assert.match(streamingSource, /provider-menu-health/)
  assert.match(streamingSource, /:title="providerMenuHealthDetail\(provider\)"/)
})
