import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import * as vue from 'vue'
import { LibraryDatabase } from '../../../main/library/libraryDatabase.ts'
import type { LibraryQuery } from '../../../shared/libraryDatabase.ts'
import { useMusicStore } from '../stores/useMusicStore.ts'
import { musicVersionRevision } from '../stores/musicVersions.ts'
import { buildLogicalTracks } from '../utils/logicalTrackModel.ts'
import { unifiedSearchSongs } from '../utils/unifiedMusicSearch.ts'
import type { UnifiedMusicSearchState } from './useUnifiedMusicSearch.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('preview search hooks stay idle while default live hooks still synchronize and subscribe', () => {
  const scope = vue.effectScope()
  const mounts: Array<() => void> = []
  const unmounts: Array<() => void> = []
  let syncs = 0,
    subscriptions = 0,
    unsubscriptions = 0,
    sources = 0
  const dependencies: Record<string, unknown> = {
    vue: {
      ...vue,
      onMounted: (fn: () => void) => mounts.push(fn),
      onBeforeUnmount: (fn: () => void) => unmounts.push(fn)
    },
    '@renderer/stores/musicVersions.ts': { musicVersionRevision },
    '../stores/musicVersions.ts': { musicVersionRevision },
    '@renderer/utils/logicalTrackModel.ts': { buildLogicalTracks },
    '../providers/index.ts': {
      useMediaProviders: (options?: { sync?: boolean }) => {
        if (options?.sync !== false) syncs++
        return { searchAllSongs: () => assert.fail('unused hook searched providers') }
      }
    },
    '../stores/useMusicStore.ts': {
      useMusicStore: () => ({
        createUnifiedSearchSource: () => {
          sources++
          assert.fail('unused hook loaded the library')
        }
      })
    }
  }
  const load = (file: string) => {
    const exports = {}
    runInNewContext(
      ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }).outputText,
      {
        exports,
        require: (id: string) => {
          assert.ok(id in dependencies, id)
          return dependencies[id]
        },
        window: {
          api: {
            library: {
              onChanged: () => {
                subscriptions++
                return () => unsubscriptions++
              }
            }
          }
        },
        AbortController,
        DOMException,
        queueMicrotask
      }
    )
    return exports
  }
  dependencies['./useLibraryUnifiedSearch.ts'] = load('./useLibraryUnifiedSearch.ts')
  const hooks = load('./useUnifiedMusicSearch.ts') as {
    useUnifiedMusicSearch: (options?: {
      sync?: boolean
      listen?: boolean
    }) => UnifiedMusicSearchState
  }
  try {
    scope.run(() => hooks.useUnifiedMusicSearch({ sync: false, listen: false }))
    mounts.splice(0).forEach((mount) => mount())
    assert.deepEqual([syncs, subscriptions, sources], [0, 0, 0])
    scope.run(() => hooks.useUnifiedMusicSearch())
    mounts.splice(0).forEach((mount) => mount())
    assert.deepEqual([syncs, subscriptions, sources], [1, 1, 0])
    unmounts.splice(0).forEach((unmount) => unmount())
    assert.equal(unsubscriptions, 1, 'only the live subscription is released')
  } finally {
    unmounts.splice(0).forEach((unmount) => unmount())
    scope.stop()
  }
})

test('production unified-search hooks query SQLite with an empty renderer, coalesce scan refreshes, preserve deep offsets and dispose their source', async (t) => {
  const db = new LibraryDatabase(':memory:'),
    store = useMusicStore()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const scope = vue.effectScope(),
    mounts: Array<() => void> = [],
    unmounts: Array<() => void> = []
  t.after(() => {
    for (const unmount of unmounts) unmount()
    scope.stop()
    store.clearTracks()
    db.close()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: 405 }, (_, i) => ({
      id: `local:${i}`,
      filePath: `D:/Music/${i}.flac`,
      title: `晴天 ${String(i).padStart(4, '0')}`,
      artist: '周杰伦',
      album: 'Album',
      source: 'local',
      format: 'flac'
    }))
  })
  store.clearTracks()
  let listener: ((change: { kind: 'database'; revision: number }) => void) | undefined,
    unsubscribed = false
  const queries: LibraryQuery[] = []
  const api = {
    library: {
      getStorageMode: async () => 'sqlite',
      onChanged: (callback: typeof listener) => {
        listener = callback
        return () => {
          listener = undefined
          unsubscribed = true
        }
      },
      database: {
        queryTracks: async (query: LibraryQuery) => {
          queries.push(query)
          return db.queryTracks(query)
        },
        getMetadata: async () => db.getMetadata()
      }
    }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api } })
  const facade = {
    ...store,
    tracks: {
      get value(): never {
        throw new Error('full renderer library access')
      }
    }
  }
  const exports: { useUnifiedMusicSearch?: () => UnifiedMusicSearchState } = {}
  const dependencies: Record<string, unknown> = {
    vue: {
      ...vue,
      onMounted: (fn: () => void) => mounts.push(fn),
      onBeforeUnmount: (fn: () => void) => unmounts.push(fn)
    },
    '@renderer/stores/musicVersions.ts': { musicVersionRevision },
    '@renderer/utils/logicalTrackModel.ts': { buildLogicalTracks },
    '../providers/index.ts': {
      useMediaProviders: () => ({
        searchAllSongs: (options: Parameters<typeof unifiedSearchSongs>[0]) =>
          unifiedSearchSongs({
            ...options,
            providers: [],
            searchProviderSongs: async () => ({ items: [], total: 0 })
          })
      })
    },
    '../stores/useMusicStore.ts': { useMusicStore: () => facade }
  }
  dependencies['../stores/musicVersions.ts'] = { musicVersionRevision }
  const load = (file: string, exports: object) =>
    runInNewContext(
      ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }).outputText,
      {
        exports,
        require: (id: string) => {
          assert.ok(id in dependencies, id)
          return dependencies[id]
        },
        window: { api },
        AbortController,
        DOMException,
        queueMicrotask
      }
    )
  const sourceExports = {}
  load('./useLibraryUnifiedSearch.ts', sourceExports)
  dependencies['./useLibraryUnifiedSearch.ts'] = sourceExports
  load('./useUnifiedMusicSearch.ts', exports)
  const search = scope.run(() => exports.useUnifiedMusicSearch!())!
  mounts.forEach((mount) => mount())
  assert.equal(queries.length, 0, 'mounting an unused search must not request local data')
  await search.search('晴天', { limit: 20, offset: 200 })
  assert.equal(search.total.value, 405)
  assert.equal(search.items.value[0].track.id, 'local:200')
  assert.equal(queries.length, 1)
  const saved = db.patchTracks([
    { id: 'local:210', expectedVersion: 1, patch: { title: '晴天 0210 edited' } }
  ])
  for (let i = 0; i < 500; i++) listener!({ kind: 'database', revision: saved.revision })
  for (let i = 0; i < 50 && (search.loading.value || queries.length < 2); i++) await tick()
  assert.equal(search.error.value, '')
  assert.equal(queries.length, 2)
  assert.equal(queries[1].offset, 200)
  assert.equal(
    search.items.value.find((item) => item.track.id === 'local:210')?.track.title,
    '晴天 0210 edited'
  )
  assert.equal(store.tracks.value.length, 0)
  for (const unmount of unmounts.splice(0)) unmount()
  assert.equal(unsubscribed, true)
  assert.equal(search.items.value.length, 0)
  search.refresh()
  await tick()
  assert.equal(queries.length, 2)
})
