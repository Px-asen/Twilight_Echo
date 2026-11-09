import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { computed, ref } from 'vue'
import { libraryQueueTrack } from '../../utils/libraryQueuePlayback.ts'

function saveDialogFixture(save) {
  const script = stripTypeScriptTypes(
    readFileSync(new URL('./QueueSavePlaylistDialog.vue', import.meta.url), 'utf8')
      .split('<script setup lang="ts">')[1]
      .split('</script>')[0]
  )
  const events = []
  const context = vm.createContext({
    Error,
    props: { save },
    name: ref('  Queue  '),
    pending: ref(false),
    error: ref(''),
    cancellation: new AbortController(),
    emit: (...args) => events.push(args)
  })
  for (const name of ['close', 'submitSave']) {
    const start = script.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'))
    const end = script.indexOf('\n}', start)
    assert.ok(start >= 0 && end > start)
    vm.runInContext(script.slice(start, end + 2), context)
  }
  return { context, events }
}

test('queue save dialog prevents duplicate submission and publishes only a confirmed completed ID', async () => {
  let release,
    calls = 0
  const f = saveDialogFixture((name, signal) => {
    calls++
    assert.equal(name, 'Queue')
    assert.equal(signal.aborted, false)
    return new Promise((resolve) => {
      release = resolve
    })
  })
  const pending = f.context.submitSave()
  await f.context.submitSave()
  assert.equal(calls, 1)
  assert.equal(f.context.pending.value, true)
  assert.deepEqual(f.events, [])
  release('completed')
  await pending
  assert.deepEqual(f.events, [['saved', 'completed'], ['close']])
  assert.equal(f.context.pending.value, false)
})

test('queue save cancellation aborts the producer and rejects late success feedback', async () => {
  let release
  const f = saveDialogFixture(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const pending = f.context.submitSave()
  f.context.close()
  assert.equal(f.context.cancellation.signal.aborted, true)
  release('late')
  await pending
  assert.deepEqual(f.events, [['close']])
  assert.equal(f.context.error.value, '')
})

test('queue save failure stays visible for retry; empty IDs never announce success', async () => {
  let calls = 0
  const f = saveDialogFixture(async () => {
    if (++calls === 1) throw new Error('read failed')
    return calls === 2 ? '' : 'retry'
  })
  await f.context.submitSave()
  assert.equal(f.context.error.value, 'read failed')
  assert.deepEqual(f.events, [])
  await f.context.submitSave()
  assert.match(f.context.error.value, /没有可保存/)
  assert.deepEqual(f.events, [])
  await f.context.submitSave()
  assert.equal(f.context.error.value, '')
  assert.deepEqual(f.events, [['saved', 'retry'], ['close']])
})

// Exercise the actual event handlers independently of the Electron render gate.
const source = stripTypeScriptTypes(
  readFileSync(new URL('./LibraryQueueDrawer.vue', import.meta.url), 'utf8')
    .split('<script setup lang="ts">')[1]
    .split('</script>')[0]
)
function fixture() {
  const calls = [],
    added = []
  const snapshot = { id: 'queue', revision: 2, total: 5, index: 0, selectedEntryId: 'entry:0' }
  const props = {
    snapshot,
    contentRevision: 3,
    busy: false,
    playEntry: async (...args) => {
      calls.push(['play', ...args])
    },
    duplicateEntry: async (...args) => { calls.push(['duplicate', ...args]) },
    editQueue: async (...args) => {
      calls.push(['edit', ...args])
    },
    refreshQueue: async () => {
      calls.push(['refresh'])
    },
    readPage: async (page) => ({
      revision: 2,
      libraryRevision: 3,
      items: Array.from({ length: 5 }, (_, i) => ({
        position: page * 200 + i,
        queueEntryId: 'entry:' + i,
        track: {
          id: 'track:' + Math.floor(i / 2),
          title: 'Song ' + i,
          filePath: 'D:/Music/disc.flac'
        }
      }))
    })
  }
  const pending = ref(false)
  const context = vm.createContext({
    props,
    pending,
    disposed: false,
    actionError: ref(''),
    announcement: ref(''),
    dragged: ref(null),
    LIBRARY_PAGE_SIZE: 200,
    libraryQueueTrack,
    disabled: computed(() => props.busy || pending.value),
    selectedEntryId: computed(() => props.snapshot?.selectedEntryId),
    total: computed(() => props.snapshot?.total ?? 0),
    emit: (event, track) => added.push([event, track]),
    viewport: { retry: () => calls.push(['retry']) }
  })
  for (const name of [
    'version',
    'action',
    'play',
    'remove',
    'insert',
    'clear',
    'refresh',
    'retry',
    'readEntry',
    'addToPlaylist',
    'moveBy',
    'dragStart',
    'dragOver',
    'drop'
  ]) {
    const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm')),
      end = source.indexOf('\n}', start)
    assert.ok(start >= 0 && end > start)
    vm.runInContext(source.slice(start, end + 2), context)
  }
  const row = (index) => ({
    index,
    queueEntryId: 'entry:' + index,
    id: 'track:' + Math.floor(index / 2),
    title: 'Song ' + index,
    state: 'ready',
    queueId: 'queue',
    revision: 2
  })
  return { props, calls, added, context, row }
}
async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}

test('drawer handlers retain occurrence identity and catch synchronous stale-row errors without blocking retry', async () => {
  const f = fixture()
  f.context.play(f.row(1))
  await settle()
  assert.equal(f.calls[0][1], 'entry:1')
  f.props.snapshot.revision++
  f.context.remove(f.row(1))
  await settle()
  assert.equal(f.calls.length, 1)
  assert.match(f.context.actionError.value, /播放队列已变化/)
  assert.equal(f.context.pending.value, false)
  f.context.retry()
  await settle()
  assert.deepEqual(f.calls.slice(1), [['refresh'], ['retry']])
  assert.equal(f.context.actionError.value, '')
})

test('retrying a failed page only reloads rows; explicit queue recovery remains available', async () => {
  const f = fixture()
  f.context.retry()
  await settle()
  assert.deepEqual(f.calls, [['retry']], 'reading the drawer must not stop or reset playback')
  f.context.refresh()
  await settle()
  assert.deepEqual(f.calls.slice(1), [['refresh'], ['retry']])
})

test('drawer next/tail insertion and removal use IDs rather than rendered positions', async () => {
  const f = fixture()
  f.context.insert(f.row(1), true)
  await settle()
  f.context.insert(f.row(1), false)
  await settle()
  f.context.remove({ ...f.row(1), state: 'missing' })
  await settle()
  assert.deepEqual(f.calls[0].slice(0, 3), ['duplicate', 'entry:1', true])
  assert.deepEqual(f.calls[1].slice(0, 3), ['duplicate', 'entry:1', false])
  assert.equal(f.calls[0][3].revision, 2)
  assert.equal(f.calls[2][1].entryIds[0], 'entry:1')
  f.context.play({ ...f.row(0), state: 'missing' })
  await settle()
  assert.equal(f.calls.length, 3)
})

test('keyboard moves address the correct before-occurrence and drag rejects a changed source revision', async () => {
  const f = fixture()
  f.context.moveBy(f.row(1), 1)
  await settle()
  f.context.moveBy(f.row(1), -1)
  await settle()
  f.context.moveBy(f.row(3), 1)
  await settle()
  assert.deepEqual(
    f.calls.map((call) => call[1].beforeEntryId),
    ['entry:3', 'entry:0', null]
  )
  const event = {
    preventDefault() {},
    dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' }
  }
  f.context.dragStart(event, f.row(1))
  f.props.snapshot.revision++
  f.context.drop(event, { ...f.row(3), revision: 3 })
  await settle()
  assert.equal(f.calls.length, 3)
  assert.match(f.context.actionError.value, /重新拖动/)
})

test('single-track playlist add revalidates the page, queue and content after awaiting details', async () => {
  const f = fixture()
  f.context.addToPlaylist(f.row(1))
  await settle()
  assert.equal(f.added[0][0], 'addToPlaylist')
  assert.equal(f.added[0][1].id, 'track:0')
  assert.equal(f.added[0][1].queueEntryId, 'entry:1')
  assert.equal(f.added[0][1].queue.id, 'queue')
  assert.equal(f.added[0][1].queue.revision, 2)
  let release
  const read = f.props.readPage
  f.props.readPage = async (page) => {
    await new Promise((resolve) => {
      release = resolve
    })
    return read(page)
  }
  f.context.addToPlaylist(f.row(1))
  await settle()
  f.props.contentRevision++
  release()
  await settle()
  assert.equal(f.added.length, 1)
  assert.match(f.context.actionError.value, /播放队列已变化/)
})
