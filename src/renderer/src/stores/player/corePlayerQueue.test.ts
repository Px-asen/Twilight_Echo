import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, shallowRef } from 'vue'
import { coreQueueTrackInput, createCorePlayerQueue } from './corePlayerQueue.ts'
import { coreSnapshot } from '../coreTestFixtures.ts'
import type { CorePlayerClient } from './corePlayerTypes.ts'
import type { CoreQueueTrackInput } from '../../../../shared/coreQueueSubmission.ts'

function fixture(t: test.TestContext, hasQueue = true) {
  const state = shallowRef(
    coreSnapshot({
      queue: hasQueue
        ? { id: 'q', revision: 1, index: 0, total: 1, occurrenceId: 'original' }
        : null
    })
  )
  const commands: Array<{ name: string; payload: any }> = [],
    errors: unknown[] = []
  let fail: ((name: string, payload: any) => void) | undefined
  const core = {
    state,
    query: async () => ({ items: [], offset: 0, total: 0, revision: 1, libraryRevision: 1 }),
    command: async (name: string, payload: any) => {
      commands.push({ name, payload })
      fail?.(name, payload)
      if (name === 'queue.insert') {
        const queue = state.value.queue!
        state.value = {
          ...state.value,
          queue: {
            ...queue,
            revision: queue.revision + 1,
            total: queue.total + payload.items.length
          }
        }
        return state.value.queue
      }
      return {
        id: 'stage',
        sequence: payload.sequence ?? 0,
        total: 0,
        state: payload.kind === 'commit' ? 'committed' : 'building'
      }
    }
  } as unknown as CorePlayerClient
  const scope = effectScope(),
    queue = scope.run(() => createCorePlayerQueue(core, (error) => errors.push(error)))!
  t.after(() => scope.stop())
  return {
    queue,
    commands,
    errors,
    fail: (callback: typeof fail) => {
      fail = callback
    }
  }
}

test('paged display actions send bounded explicit Core inputs and advance each acknowledged queue revision', async (t) => {
  const f = fixture(t)
  const items: CoreQueueTrackInput[] = Array.from({ length: 405 }, (_, i) => ({
    kind: 'local',
    id: `local:${i}`
  }))
  items[0] = { kind: 'occurrence', queueId: 'q', revision: 1, occurrenceId: 'second-occurrence' }
  items[404] = {
    kind: 'provider',
    track: {
      id: 'ncm:7',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      duration: 180,
      source: 'ncm'
    }
  }
  await f.queue.appendLibraryQueuePages(async (append) => {
    await append(items)
  })
  assert.deepEqual(
    f.commands.map((command) => [
      command.name,
      command.payload.revision,
      command.payload.items.length
    ]),
    [
      ['queue.insert', 1, 200],
      ['queue.insert', 2, 200],
      ['queue.insert', 3, 5]
    ]
  )
  assert.deepEqual(f.commands[0].payload.items[0], items[0])
  assert.deepEqual(f.commands[2].payload.items[4], items[404])
  assert.equal(f.queue.queue.value.length, 0)
  assert.deepEqual(f.errors, [])
})

test('append without a queue stages once with play false, then commits without a separate Play or source load', async (t) => {
  const f = fixture(t, false)
  await f.queue.appendLibraryQueuePages(async (append) => {
    await append([
      { kind: 'local', id: 'one' },
      { kind: 'local', id: 'one' }
    ])
  })
  assert.deepEqual(
    f.commands.map((command) => command.name),
    ['queue.submit', 'queue.submit', 'queue.submit']
  )
  assert.deepEqual(f.commands[0].payload, { kind: 'begin', selectedIndex: 0, play: false })
  assert.equal(f.commands[1].payload.items.length, 2)
  assert.deepEqual(f.commands[2].payload, { kind: 'commit', id: 'stage', sequence: 2 })
})

test('unknown insert outcomes are not replayed; cancellation fences the next page while retaining acknowledged work', async (t) => {
  const unknown = fixture(t)
  unknown.fail((name) => {
    if (name === 'queue.insert')
      throw Object.assign(new Error('reply lost'), { code: 'OUTCOME_UNKNOWN' })
  })
  await assert.rejects(
    unknown.queue.appendLibraryQueuePages(async (append) => {
      await append([{ kind: 'local', id: 'one' }])
    }),
    { code: 'OUTCOME_UNKNOWN' }
  )
  assert.equal(unknown.commands.length, 1)
  const f = fixture(t),
    abort = new AbortController()
  await assert.rejects(
    f.queue.appendLibraryQueuePages(
      async (append) => {
        await append([{ kind: 'local', id: 'one' }])
        abort.abort()
        await append([{ kind: 'local', id: 'two' }])
      },
      true,
      { signal: abort.signal }
    ),
    { name: 'AbortError' }
  )
  assert.equal(f.commands.length, 1)
  assert.equal(f.queue.queueCount.value, 2)
})

test('coreQueueTrackInput forwards authorized provider artwork handles and drops raw remote or file URLs', () => {
  const granted = coreQueueTrackInput(
    {
      id: 'ncm:42',
      title: 'Is this love?',
      artist: 'twenty4-7',
      album: 'Letter',
      duration: 277,
      source: 'ncm',
      ncmSongId: 42,
      filePath: '',
      fileName: 'Is this love?',
      size: 0,
      cover: 'twilight-media://image/token_42',
      lyrics: null
    },
    null
  )
  assert.deepEqual(granted, {
    kind: 'provider',
    track: {
      id: 'ncm:42',
      title: 'Is this love?',
      artist: 'twenty4-7',
      album: 'Letter',
      duration: 277,
      source: 'ncm',
      ncmSongId: 42,
      cover: 'twilight-media://image/token_42'
    }
  })

  const rawRemote = coreQueueTrackInput(
    {
      id: 'ncm:43',
      title: 'Raw URL',
      artist: 'Artist',
      album: 'Album',
      duration: 180,
      source: 'ncm',
      filePath: '',
      fileName: 'Raw URL',
      size: 0,
      cover: 'https://p2.music.126.net/raw.jpg',
      lyrics: null
    },
    null
  )
  assert.equal(rawRemote.kind, 'provider')
  if (rawRemote.kind === 'provider') {
    assert.equal('cover' in rawRemote.track, false)
  }
})
