import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { ref } from 'vue'
import { toProviderIpcArgs } from '../providers/mediaProvider.ts'

const source = readFileSync(new URL('./useProviderStore.ts', import.meta.url), 'utf8')

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
