import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { LocalLibraryWatchChange } from '../../shared/localLibraryScan.ts'
import { LibraryWatcherPoller } from './libraryWatcherPolling.ts'
import * as extensions from './watcherExtensions.ts'

function fixture(
  options: {
    platform?: string
    watch?: (
      folder: string,
      watchOptions: { recursive?: boolean },
      callback: (type: string, name: string | null) => void
    ) => EventEmitter & { close(): void }
  } = {}
) {
  let callback!: (type: string, name: string | null) => void
  const pending = new Map<number, () => void>()
  let sequence = 0
  const deliveries: LocalLibraryWatchChange[][] = []
  const watchCalls: { folder: string; recursive: boolean }[] = []
  const watch = Object.assign(new EventEmitter(), { close() {} })
  const exports: {
    createLibraryWatchers?: typeof import('../../core/library/watcher.ts').createLibraryWatchers
  } = {}
  const dependencies: Record<string, unknown> = {
    '../ports/index.ts': { coreFs: {
      watch: (
        folder: string,
        watchOptions: { recursive?: boolean },
        cb: typeof callback
      ) => {
        watchCalls.push({ folder, recursive: watchOptions?.recursive === true })
        if (options.watch) return options.watch(folder, watchOptions, cb)
        callback = cb
        return watch
      },
      existsSync: () => true
    } },
    '../../shared/portablePath.ts': path,
    './watcherExtensions.ts': extensions,
    './watcherPolling.ts': { LibraryWatcherPoller }
  }
  runInNewContext(
    ts.transpileModule(
      readFileSync(new URL('../../core/library/watcher.ts', import.meta.url), 'utf8'),
      {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }
    ).outputText,
    {
      exports,
      console,
      process: { platform: options.platform ?? 'win32' },
      require: (id: string) => {
        assert.ok(id in dependencies, id)
        return dependencies[id]
      },
      setTimeout: (action: () => void) => {
        const id = ++sequence
        pending.set(id, action)
        return id
      },
      clearTimeout: (id: number) => pending.delete(id),
      clearInterval: (id: number) => pending.delete(id)
    }
  )
  const root = path.resolve('media')
  const watchers = exports.createLibraryWatchers!({
    platform: options.platform ?? 'win32',
    now: () => new Date(),
    debounceMs: () => 350,
    database: () => ({
      enqueueWatcherChanges: (changes) => deliveries.push(changes),
      poll: async () => false
    }),
    coordinator: () => null,
    isExcluded: () => false,
    isMutating: () => false,
    changed: () => {}
  })
  watchers.apply([root], true)
  return {
    root,
    deliveries,
    pending,
    watchCalls,
    watch,
    status() {
      return watchers.snapshot([root], true).folders[0]
    },
    emit(name: string) {
      callback('change', name)
    },
    flush() {
      const timers = [...pending.values()]
      pending.clear()
      timers.forEach((timer) => timer())
    },
    stop() {
      watchers.apply([], false)
    }
  }
}

test('native SQLite events coalesce by directory without indefinitely delaying the first flush', () => {
  const f = fixture()
  for (let i = 0; i < 5000; i++) f.emit(`album/${i}.flac`)
  assert.equal(f.pending.size, 1)
  f.flush()
  assert.equal(f.deliveries.length, 1)
  assert.equal(
    JSON.stringify(f.deliveries[0]),
    JSON.stringify([{ kind: 'reconcile', path: path.join(f.root, 'album') }])
  )
  f.stop()
})

test('native SQLite event staging stays bounded when more than 256 directories change', () => {
  const f = fixture()
  for (let i = 0; i < 5000; i++) f.emit(`album-${i}/track.flac`)
  assert.equal(f.pending.size, 1)
  f.flush()
  assert.equal(
    JSON.stringify(f.deliveries[0]),
    JSON.stringify([{ kind: 'reconcile', path: f.root }])
  )
  f.stop()
})

test('Linux arms a recursive watcher instead of pre-emptively demoting to polling', () => {
  const f = fixture({ platform: 'linux' })
  // The regression: no arm attempt was ever made on Linux, so the folder was
  // reported degraded with the internal 'linux-recursive-watch-unsupported' code.
  assert.deepEqual(f.watchCalls, [{ folder: f.root, recursive: true }])
  const status = f.status()
  assert.equal(status.state, 'active')
  assert.equal(status.mode, 'recursive')
  assert.equal(status.lastError, null)
  f.stop()
})

test('a non-recoverable arming error still falls back to polling on Linux', () => {
  const f = fixture({
    platform: 'linux',
    watch: () => {
      throw Object.assign(new Error('inotify watch limit reached'), { code: 'ENOSPC' })
    }
  })
  const status = f.status()
  assert.equal(status.state, 'degraded')
  assert.equal(status.mode, 'polling')
  assert.equal(status.lastError, 'ENOSPC')
  f.stop()
})

test('a transient arming error is retried instead of demoting the folder to polling', () => {
  const f = fixture({
    platform: 'linux',
    watch: () => {
      throw Object.assign(new Error('device temporarily unavailable'), { code: 'EIO' })
    }
  })
  // Re-arming is scheduled, so the folder is not permanently demoted to polling.
  const status = f.status()
  assert.equal(status.mode, 'none')
  assert.notEqual(status.mode, 'polling')
  assert.equal(status.lastError, 'EIO')
  // One timer re-arms the watcher; the other flushes the compensating reconcile.
  assert.equal(f.pending.size, 2)
  f.stop()
})
