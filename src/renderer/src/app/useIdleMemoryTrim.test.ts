import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick } from 'vue'
import {
  createIdleMemoryTrimmer,
  IDLE_MINIMIZED_TRIM_DELAY_MS,
  trimRendererIdleCaches
} from './useIdleMemoryTrim.ts'
import { readCachedCover, resolveCover } from '../utils/coverLoader.ts'

test('idle memory trimmer waits for continuous hidden duration, flushes DOM before cache purge, and restores immediately', async () => {
  assert.equal(IDLE_MINIMIZED_TRIM_DELAY_MS, 90_000)

  let hidden = false
  const hooks: { onVisibility: (() => void) | null; onTimer: (() => void) | null } = {
    onVisibility: null,
    onTimer: null
  }
  let scheduledDelay = 0
  let clearedTimers = 0
  const events: string[] = []

  const trimmer = createIdleMemoryTrimmer({
    isHidden: () => hidden,
    subscribeVisibility: (onChange) => {
      hooks.onVisibility = onChange
      return () => {
        hooks.onVisibility = null
      }
    },
    setTimer: (fn, ms) => {
      hooks.onTimer = fn
      scheduledDelay = ms
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => {
      clearedTimers += 1
      hooks.onTimer = null
    },
    scheduleFlush: (fn) => {
      events.push(`flush-scheduled:trimmed=${trimmer.trimmed.value}`)
      void nextTick(fn)
    },
    onTrim: () => {
      events.push(`trim:trimmed=${trimmer.trimmed.value}`)
    },
    onRestore: () => {
      events.push(`restore:trimmed=${trimmer.trimmed.value}`)
    }
  })

  const fireVisibility = (): void => {
    hooks.onVisibility?.()
  }
  const fireTimer = (): void => {
    const fn = hooks.onTimer
    assert.notEqual(fn, null)
    fn?.()
  }

  try {
    assert.equal(trimmer.trimmed.value, false)
    assert.equal(hooks.onTimer, null)

    // Minimize briefly, then restore before 90s — must cancel timer without trimming.
    hidden = true
    fireVisibility()
    assert.equal(scheduledDelay, 90_000)
    assert.notEqual(hooks.onTimer, null)

    hidden = false
    fireVisibility()
    assert.equal(clearedTimers, 1)
    assert.equal(trimmer.trimmed.value, false)
    assert.deepEqual(events, [])

    // Minimize again and stay hidden past the threshold.
    hidden = true
    fireVisibility()
    fireTimer()

    // `trimmed` flips synchronously so heavy DOM subtrees unmount before `onTrim` runs on nextTick.
    assert.equal(trimmer.trimmed.value, true)
    assert.deepEqual(events, ['flush-scheduled:trimmed=true'])

    await nextTick()
    assert.deepEqual(events, ['flush-scheduled:trimmed=true', 'trim:trimmed=true'])

    // Restoring visibility immediately clears `trimmed` before the next paint.
    hidden = false
    fireVisibility()
    assert.equal(trimmer.trimmed.value, false)
    assert.deepEqual(events, [
      'flush-scheduled:trimmed=true',
      'trim:trimmed=true',
      'restore:trimmed=false'
    ])
  } finally {
    trimmer.dispose()
  }
})

test('trimRendererIdleCaches clears local/remote cover caches and invokes webFrame cache purge', async () => {
  const globalRecord = globalThis as Record<string, unknown>
  const previousWindow = globalRecord.window
  let webFrameCleared = 0

  globalRecord.window = {
    api: {
      data: {
        getCover: async () => 'data:image/jpeg;base64,local',
        grantRemoteCover: async () => 'twilight-media://image/remote'
      },
      window: {
        clearMemoryCache: () => {
          webFrameCleared += 1
        }
      }
    }
  }

  try {
    await resolveCover('cover://idle-test.jpg')
    await resolveCover(null, 'https://example.com/idle-remote.jpg')
    assert.equal(readCachedCover('cover://idle-test.jpg'), 'data:image/jpeg;base64,local')
    assert.equal(
      readCachedCover(null, 'https://example.com/idle-remote.jpg'),
      'twilight-media://image/remote'
    )

    trimRendererIdleCaches()

    assert.equal(readCachedCover('cover://idle-test.jpg'), null)
    assert.equal(readCachedCover(null, 'https://example.com/idle-remote.jpg'), null)
    assert.equal(webFrameCleared, 1)
  } finally {
    globalRecord.window = previousWindow
    trimRendererIdleCaches()
  }
})
