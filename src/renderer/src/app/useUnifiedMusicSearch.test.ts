import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { nextTick, ref, shallowRef, watch } from 'vue'
import ts from 'typescript'
import type { Track } from '../types/music'
import type { CoreMusicSearchPage as UnifiedSearchResult } from '../../../shared/coreSearch.ts'

const { createUnifiedMusicSearch } = (await import(
  new URL('./useUnifiedMusicSearch.ts', import.meta.url).href
)) as typeof import('./useUnifiedMusicSearch.ts')

const localTrack: Track = {
  id: 'local:1',
  title: 'Moon River',
  artist: 'Audrey',
  album: 'Album',
  filePath: 'D:\\Music\\Moon River.flac',
  fileName: 'Moon River.flac',
  duration: 181,
  size: 1,
  cover: null,
  lyrics: null,
  source: 'local',
  format: 'flac'
}

function unifiedResult(track: Track): UnifiedSearchResult {
  return {
    versionsRevision: 1,
    items: [
      {
        kind: 'track' as const,
        track,
        source: 'local',
        sourceName: 'local',
        local: true,
        lossless: true,
        providerAvailable: true,
        providerReliability: 1
      }
    ],
    logicalItems: [
      {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        preferredTrack: track,
        variants: [
          {
            track,
            source: 'local',
            sourceName: 'local',
            local: true,
            lossless: true,
            providerAvailable: true,
            providerReliability: 1
          }
        ]
      }
    ],
    health: {},
    total: 1
  }
}

test('preview search does not react to Core revisions while live searches refresh and clean up', async () => {
  const state = ref({ epoch: 'core', libraryRevision: 1, versionsRevision: 1, pluginsRevision: 1 })
  let reads = 0
  const cleanups: Array<() => void> = []
  const exports: {
    useUnifiedMusicSearch?: typeof import('./useUnifiedMusicSearch.ts').useUnifiedMusicSearch
  } = {}
  runInNewContext(
    ts.transpileModule(
      readFileSync(new URL('./useUnifiedMusicSearch.ts', import.meta.url), 'utf8'),
      {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }
    ).outputText,
    {
      exports,
      require: (id: string) => {
        if (id === 'vue')
          return {
            ref,
            shallowRef,
            watch,
            onBeforeUnmount: (cleanup: () => void) => cleanups.push(cleanup)
          }
        if (id === '../stores/coreConnection.ts')
          return {
            useCoreConnection: () => ({
              state,
              query: async () => {
                reads++
                return unifiedResult(localTrack)
              }
            })
          }
        throw new Error(`Unexpected dependency: ${id}`)
      },
      Error,
      AbortController,
      queueMicrotask
    }
  )
  const preview = exports.useUnifiedMusicSearch!({ listen: false })
  const live = exports.useUnifiedMusicSearch!()
  try {
    await preview.search('preview')
    await live.search('live')
    state.value.libraryRevision++
    await nextTick()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(reads, 3)
    assert.equal(preview.query.value, 'preview')
    assert.equal(live.query.value, 'live')
  } finally {
    for (const cleanup of cleanups) cleanup()
  }
  state.value.libraryRevision++
  await nextTick()
  assert.equal(reads, 3)
  assert.equal(preview.query.value, '')
  assert.equal(live.query.value, '')
})

test('unified music search composable exposes unified items and provider health', async () => {
  const search = createUnifiedMusicSearch({
    searchAllSongs: async (): Promise<UnifiedSearchResult> => ({
      versionsRevision: 1,
      items: [localTrack].map((track) => ({
        kind: 'track' as const,
        track,
        source: 'local',
        sourceName: '本地音乐',
        local: true,
        lossless: true,
        providerAvailable: true,
        providerReliability: 1
      })),
      logicalItems: [
        {
          id: 'moon river::audrey',
          title: 'Moon River',
          artist: 'Audrey',
          album: 'Album',
          preferredTrack: localTrack,
          variants: [
            {
              track: localTrack,
              source: 'local',
              sourceName: '本地音乐',
              local: true,
              lossless: true,
              providerAvailable: true,
              providerReliability: 1
            }
          ]
        }
      ],
      health: {
        ncm: {
          providerId: 'ncm',
          providerName: 'NetEase',
          available: false,
          searchable: true,
          resultCount: 0,
          lastError: 'login expired',
          pluginStatus: null,
          successRate: null,
          playbackUrlSuccessRate: null,
          playbackUrlLastError: null,
          lastCheckedAt: null
        }
      },
      total: 1
    })
  })

  await search.search('moon')

  assert.equal(search.loading.value, false)
  assert.equal(search.error.value, '')
  assert.deepEqual(
    search.items.value.map((item) => item.track.id),
    ['local:1']
  )
  assert.equal(search.logicalItems.value[0].preferredTrack.id, 'local:1')
  assert.equal(search.providerHealth.value.ncm.available, false)
  assert.equal(search.providerHealth.value.ncm.lastError, 'login expired')
})

test('unified music search clears state for blank queries', async () => {
  let called = false
  const search = createUnifiedMusicSearch({
    searchAllSongs: async () => {
      called = true
      return { items: [], logicalItems: [], health: {}, total: 0, versionsRevision: 1 }
    }
  })

  await search.search('   ')

  assert.equal(called, false)
  assert.equal(search.loading.value, false)
  assert.equal(search.items.value.length, 0)
  assert.equal(search.logicalItems.value.length, 0)
  assert.deepEqual(search.providerHealth.value, {})
})

test('a late unified search page cannot overwrite a newer request with the same query', async () => {
  let resolveFirst!: () => void
  let resolveSecond!: () => void
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve
  })
  const second = new Promise<void>((resolve) => {
    resolveSecond = resolve
  })
  const pageZero = { ...localTrack, id: 'local:page-0', title: 'Page zero' }
  const pageThirty = { ...localTrack, id: 'local:page-30', title: 'Page thirty' }
  const search = createUnifiedMusicSearch({
    searchAllSongs: async ({ offset }) => {
      if (offset === 0) {
        await first
        return unifiedResult(pageZero)
      }
      await second
      return unifiedResult(pageThirty)
    }
  })

  const oldRequest = search.search('moon', { offset: 0 })
  const newestRequest = search.search('moon', { offset: 30 })
  resolveSecond()
  await newestRequest
  resolveFirst()
  await oldRequest

  assert.deepEqual(
    search.items.value.map((item) => item.track.id),
    ['local:page-30']
  )
  assert.equal(search.loading.value, false)
})

test('clearing search aborts in-flight requests and cannot publish late results', async () => {
  let release!: () => void
  let signal: AbortSignal | undefined
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const search = createUnifiedMusicSearch({
    searchAllSongs: async (options) => {
      signal = options.signal
      await pending
      return unifiedResult(localTrack)
    }
  })
  const request = search.search('moon')
  assert.equal(search.loading.value, true)
  search.clear()
  assert.equal(signal?.aborted, true)
  release()
  await request
  assert.deepEqual(search.logicalItems.value, [])
  assert.equal(search.loading.value, false)
  assert.equal(search.total.value, 0)
})

test('database refreshes coalesce, retain the page, and reject responses older than the notified content revision', async () => {
  const calls: Array<{ query: string; offset?: number }> = []
  let revision = 3
  const search = createUnifiedMusicSearch({
    searchAllSongs: async ({ query, offset }) => {
      calls.push({ query, offset })
      return { ...unifiedResult(localTrack), libraryRevision: revision }
    }
  })
  await search.search('moon', { limit: 20, offset: 200 })
  for (let i = 0; i < 500; i++) search.invalidateLibrary(4)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [
    { query: 'moon', offset: 200 },
    { query: 'moon', offset: 200 }
  ])
  assert.match(search.error.value, /发生变化/)
  assert.equal(search.items.value.length, 0)
  revision = 4
  search.refresh()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(search.items.value[0].track.id, localTrack.id)
  search.refresh()
  await search.search('new', { offset: 0 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(calls.at(-1), { query: 'new', offset: 0 })
  assert.equal(calls.length, 4, 'a scheduled refresh cannot restart after a newer manual search')
  search.clear()
})

test('in-flight unified search coalesces refreshes without aborting or blanking visible items', async () => {
  const signals: Array<AbortSignal | undefined> = []
  const resolvers: Array<(page: UnifiedSearchResult) => void> = []
  const updatedTrack: Track = { ...localTrack, id: 'ncm:2', title: 'Moon River (Online)', source: 'ncm' }
  const search = createUnifiedMusicSearch({
    searchAllSongs: ({ signal }) => {
      signals.push(signal)
      return new Promise<UnifiedSearchResult>((resolve) => {
        resolvers.push(resolve)
      })
    }
  })

  const initial = search.search('moon')
  assert.equal(signals.length, 1)
  for (let i = 0; i < 5; i++) search.refresh()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(signals.length, 1, 'refresh during in-flight search must wait instead of restarting')
  assert.equal(signals[0]?.aborted, false, 'in-flight multi-provider search must not be aborted')

  resolvers[0](unifiedResult(localTrack))
  await initial
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(signals.length, 2, 'queued refreshes coalesce into one follow-up read')
  assert.deepEqual(
    search.items.value.map((item) => item.track.id),
    ['local:1'],
    'background refresh retains existing items instead of flashing an empty list'
  )
  assert.equal(search.logicalItems.value.length, 1)
  assert.equal(search.total.value, 1)

  resolvers[1](unifiedResult(updatedTrack))
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.deepEqual(
    search.items.value.map((item) => item.track.id),
    ['ncm:2']
  )
  assert.equal(search.loading.value, false)
  search.clear()
})

test('automated Core revision updates skip failed searches while explicit refresh still retries', async () => {
  const state = ref({ epoch: 'core', libraryRevision: 1, versionsRevision: 1, pluginsRevision: 1 })
  let reads = 0
  let shouldFail = true
  const cleanups: Array<() => void> = []
  const exports: {
    useUnifiedMusicSearch?: typeof import('./useUnifiedMusicSearch.ts').useUnifiedMusicSearch
  } = {}
  runInNewContext(
    ts.transpileModule(
      readFileSync(new URL('./useUnifiedMusicSearch.ts', import.meta.url), 'utf8'),
      {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }
    ).outputText,
    {
      exports,
      require: (id: string) => {
        if (id === 'vue')
          return {
            ref,
            shallowRef,
            watch,
            onBeforeUnmount: (cleanup: () => void) => cleanups.push(cleanup)
          }
        if (id === '../stores/coreConnection.ts')
          return {
            useCoreConnection: () => ({
              state,
              query: async () => {
                reads++
                if (shouldFail) throw new Error('network error')
                return unifiedResult(localTrack)
              }
            })
          }
        throw new Error(`Unexpected dependency: ${id}`)
      },
      Error,
      AbortController,
      queueMicrotask
    }
  )

  const live = exports.useUnifiedMusicSearch!()
  try {
    await live.search('moon')
    assert.equal(reads, 1)
    assert.equal(live.error.value, 'network error')

    state.value.pluginsRevision++
    state.value.libraryRevision++
    await nextTick()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(reads, 1, 'Core revision bumps must not auto-retry an errored search')

    shouldFail = false
    live.refresh()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(reads, 2, 'explicit user refresh still recovers from error')
    assert.equal(live.error.value, '')
    assert.equal(live.items.value[0]?.track.id, localTrack.id)
  } finally {
    for (const cleanup of cleanups) cleanup()
  }
})
