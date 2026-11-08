import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { effectScope, nextTick, ref } from 'vue'
import type { Track } from '../../types/music.ts'

const { useTrackMultiSelect, isTrackListShortcutTarget } = (await import(
  new URL('./useTrackMultiSelect.ts', import.meta.url).href
)) as typeof import('./useTrackMultiSelect')

test('select-all resolves an unknown provider count and a later clear cancels the pending selection', async () => {
  const total = ref(800)
  let ready!: () => void
  const scope = effectScope()
  const select = scope.run(() =>
    useTrackMultiSelect({
      tracks: ref([]),
      querySelection: () => ({
        total: total.value,
        positionForKey: () => null,
        prepareAll: () =>
          new Promise<void>((resolve) => {
            ready = () => {
              total.value = 4201
              resolve()
            }
          })
      })
    })
  )!
  select.selectAll()
  ready()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(select.selectedCount.value, 4201)
  select.selectAll()
  select.clearSelection()
  ready()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(select.selectedCount.value, 0)
  scope.stop()
})

test('list shortcuts stay within the owning noneditable surface and yield to menus and dialogs', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')
  class TestElement {
    tagName = 'BUTTON'
    isContentEditable = false
  }
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: TestElement })
  try {
    const row = new TestElement()
    const outside = new TestElement()
    const input = Object.assign(new TestElement(), { tagName: 'INPUT' })
    const select = Object.assign(new TestElement(), { tagName: 'SELECT' })
    const contentEditable = Object.assign(new TestElement(), { isContentEditable: true })
    let active = row
    let overlay: object | null = null
    const inside = new Set([row, input, select, contentEditable])
    const root = {
      contains: (element: TestElement) => inside.has(element),
      ownerDocument: {
        get activeElement() {
          return active
        },
        querySelector: () => overlay
      }
    } as unknown as HTMLElement
    const event = (target: TestElement, defaultPrevented = false): KeyboardEvent =>
      ({
        key: 'a',
        ctrlKey: true,
        target,
        defaultPrevented
      }) as unknown as KeyboardEvent
    assert.equal(isTrackListShortcutTarget(event(row), root, false), true)
    assert.equal(isTrackListShortcutTarget(event(outside), root, false), false)
    active = outside
    assert.equal(isTrackListShortcutTarget(event(row), root, false), false)
    for (const editable of [input, select, contentEditable]) {
      active = editable
      assert.equal(isTrackListShortcutTarget(event(editable), root, false), false)
    }
    active = row
    assert.equal(isTrackListShortcutTarget(event(row, true), root, false), false)
    assert.equal(isTrackListShortcutTarget(event(row), root, true), false)
    overlay = { role: 'menu' }
    assert.equal(isTrackListShortcutTarget(event(row), root, false), false)
    overlay = { tag: 'dialog' }
    assert.equal(isTrackListShortcutTarget(event(row), root, false), false)
    assert.equal(isTrackListShortcutTarget(event(row), null, false), false)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'HTMLElement', previous)
    else Reflect.deleteProperty(globalThis, 'HTMLElement')
  }
})

function makeTracks(count: number): Array<{
  id: string
  title: string
  artist: string
  album: string
  filePath: string
  fileName: string
  duration: number
  size: number
  cover: null
  lyrics: null
  source: 'local'
}> {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    title: `Track ${i}`,
    artist: 'Artist',
    album: 'Album',
    filePath: `/music/t${i}.flac`,
    fileName: `t${i}.flac`,
    duration: 100 + i,
    size: 1000,
    cover: null,
    lyrics: null,
    source: 'local' as const
  }))
}

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
})
function withScope<T>(run: () => T): T {
  const scope = effectScope()
  scopes.push(scope)
  const result = scope.run(run)
  if (result === undefined) throw new Error('scope.run returned undefined')
  return result
}

test('plain click plays without selecting when selection mode is inactive', () => {
  const tracks = ref(makeTracks(5))
  const multi = withScope(() => useTrackMultiSelect({ tracks }))

  const result = multi.onRowClick(tracks.value[2], 2, {
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    detail: 1
  } as MouseEvent)
  assert.equal(result, 'play')
  assert.equal(multi.selectedCount.value, 0)
})

test('plain click only toggles selection while selection mode is active', () => {
  const tracks = ref(makeTracks(5))
  const multi = withScope(() => useTrackMultiSelect({ tracks }))
  multi.toggle(tracks.value[0].id, 0)

  const result = multi.onRowClick(tracks.value[2], 2, {
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    detail: 1
  } as MouseEvent)
  assert.equal(result, 'select')
  assert.deepEqual(multi.getSelectedTrackIds().sort(), ['t0', 't2'])

  const deselectResult = multi.onRowClick(tracks.value[0], 0, {
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    detail: 1
  } as MouseEvent)
  assert.equal(deselectResult, 'select')
  assert.deepEqual(multi.getSelectedTrackIds(), ['t2'])
})

test('ctrl click toggles selection without play', () => {
  const tracks = ref(makeTracks(5))
  const multi = withScope(() => useTrackMultiSelect({ tracks }))
  multi.onRowClick(tracks.value[0], 0, {
    shiftKey: false,
    ctrlKey: true,
    metaKey: false
  } as MouseEvent)
  multi.onRowClick(tracks.value[2], 2, {
    shiftKey: false,
    ctrlKey: true,
    metaKey: false
  } as MouseEvent)
  assert.equal(multi.selectedCount.value, 2)
  assert.equal(multi.isSelected('t0'), true)
  assert.equal(multi.isSelected('t2'), true)

  multi.onRowClick(tracks.value[0], 0, {
    shiftKey: false,
    ctrlKey: true,
    metaKey: false
  } as MouseEvent)
  assert.equal(multi.isSelected('t0'), false)
  assert.equal(multi.selectedCount.value, 1)
})

test('selection clicks suppress the following row double-click play', () => {
  const tracks = ref(makeTracks(3))
  const multi = withScope(() => useTrackMultiSelect({ tracks }))
  multi.toggle(tracks.value[0].id, 0)

  multi.onRowClick(tracks.value[1], 1, {
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    detail: 2
  } as MouseEvent)

  assert.equal(
    multi.shouldSuppressRowDoubleClick({
      shiftKey: false,
      ctrlKey: false,
      metaKey: false
    } as MouseEvent),
    true
  )
})

test('meta click behaves like ctrl click', () => {
  const tracks = ref(makeTracks(3))
  const multi = withScope(() => useTrackMultiSelect({ tracks }))
  const result = multi.onRowClick(tracks.value[1], 1, {
    shiftKey: false,
    ctrlKey: false,
    metaKey: true
  } as MouseEvent)
  assert.equal(result, 'select')
  assert.equal(multi.isSelected('t1'), true)
})

test('shift click selects inclusive range from anchor', () => {
  const tracks = ref(makeTracks(6))
  const multi = withScope(() => useTrackMultiSelect({ tracks }))
  // Enter selection with ctrl first (plain click no longer selects).
  multi.onRowClick(tracks.value[1], 1, {
    shiftKey: false,
    ctrlKey: true,
    metaKey: false
  } as MouseEvent)
  const result = multi.onRowClick(tracks.value[4], 4, {
    shiftKey: true,
    ctrlKey: false,
    metaKey: false
  } as MouseEvent)
  assert.equal(result, 'select')
  assert.deepEqual(multi.getSelectedTrackIds().sort(), ['t1', 't2', 't3', 't4'])
})

test('shift click without prior ctrl selection does not enter multi-select', () => {
  const tracks = ref(makeTracks(4))
  const multi = withScope(() => useTrackMultiSelect({ tracks }))
  const result = multi.onRowClick(tracks.value[2], 2, {
    shiftKey: true,
    ctrlKey: false,
    metaKey: false
  } as MouseEvent)
  assert.equal(result, 'play')
  assert.deepEqual(multi.getSelectedTrackIds(), [])
})

test('selectAll and clearSelection', () => {
  const tracks = ref(makeTracks(3))
  const multi = withScope(() => useTrackMultiSelect({ tracks }))
  multi.selectAll()
  assert.equal(multi.selectedCount.value, 3)
  multi.clearSelection()
  assert.equal(multi.selectedCount.value, 0)
  assert.equal(multi.hasSelection.value, false)
})

test('multi-select API does not expose a right-click selection mutator', () => {
  const tracks = ref(makeTracks(4))
  const multi = withScope(() => useTrackMultiSelect({ tracks }))
  multi.toggle(tracks.value[0].id, 0)
  multi.toggle(tracks.value[2].id, 2)

  assert.equal('ensureContextSelection' in multi, false)
  assert.deepEqual(multi.getSelectedTrackIds().sort(), ['t0', 't2'])
})

test('getSelectedTracks preserves list order', () => {
  const tracks = ref(makeTracks(5))
  const multi = withScope(() => useTrackMultiSelect({ tracks }))
  multi.onRowClick(tracks.value[3], 3, {
    shiftKey: false,
    ctrlKey: true,
    metaKey: false
  } as MouseEvent)
  multi.onRowClick(tracks.value[1], 1, {
    shiftKey: false,
    ctrlKey: true,
    metaKey: false
  } as MouseEvent)
  assert.deepEqual(
    multi.getSelectedTracks().map((t) => t.id),
    ['t1', 't3']
  )
})

test('checkbox-style toggle enters multi-select without playing', () => {
  const tracks = ref(makeTracks(3))
  const multi = withScope(() => useTrackMultiSelect({ tracks }))
  multi.toggle(tracks.value[1].id, 1)
  assert.equal(multi.hasSelection.value, true)
  assert.equal(multi.isSelected('t1'), true)
  multi.toggle(tracks.value[1].id, 1)
  assert.equal(multi.hasSelection.value, false)
})

test('occurrence keys select duplicate recordings independently without changing Track IDs', () => {
  const list = [makeTracks(1)[0], makeTracks(1)[0], makeTracks(1)[0]]
  const tracks = ref(list)
  const keys = new Map<Track, string>(tracks.value.map((track, i) => [track, `entry:${i}`]))
  const multi = withScope(() =>
    useTrackMultiSelect({ tracks, keyForTrack: (track) => keys.get(track)! })
  )
  multi.onRowClick(tracks.value[1], 1, { ctrlKey: true } as MouseEvent)
  assert.deepEqual(multi.getSelectedTrackIds(), ['entry:1'])
  assert.equal(multi.getSelectedTracks().length, 1)
  assert.equal(multi.getSelectedTracks()[0], tracks.value[1])
  multi.onRowClick(tracks.value[2], 2, { shiftKey: true } as MouseEvent)
  assert.deepEqual(multi.getSelectedTrackIds(), ['entry:1', 'entry:2'])
  multi.selectAll()
  assert.equal(multi.selectedCount.value, 3)
  assert.deepEqual(
    multi.getSelectedTracks().map((track) => track.id),
    ['t0', 't0', 't0']
  )
})

test('SQLite-style bounded pages retain explicitly selected rows across page changes', async () => {
  const tracks = ref(makeTracks(4))
  const multi = withScope(() => useTrackMultiSelect({ tracks, preserveSelectedTracks: () => true }))
  multi.toggle(tracks.value[0].id, 0, tracks.value[0])
  tracks.value = tracks.value.slice(2)
  await nextTick()

  assert.equal(multi.selectedCount.value, 1)
  assert.equal(multi.isSelected('t0'), true)
  assert.deepEqual(
    multi.getSelectedTracks().map((track) => track.id),
    ['t0']
  )

  // A refreshed row updates the compact selection cache without requiring the
  // previous page to remain resident.
  const refreshed = { ...tracks.value[0], id: 't0' }
  tracks.value = [refreshed, tracks.value[1]]
  await nextTick()
  assert.equal(multi.getSelectedTracks()[0], tracks.value[0])

  multi.clearSelection()
  assert.equal(multi.selectedCount.value, 0)
  assert.deepEqual(multi.getSelectedTracks(), [])
})

test('legacy reactive lists prune deleted rows and preserve list order by default', () => {
  const tracks = ref(makeTracks(4))
  const multi = withScope(() => useTrackMultiSelect({ tracks }))
  multi.toggle('t3', 3)
  multi.toggle('t1', 1)
  const version = multi.selectionVersion.value
  tracks.value = tracks.value.slice(0, 3)
  assert.equal(multi.selectionVersion.value, version + 1)
  assert.deepEqual(multi.getSelectedTrackIds(), ['t1'])
  assert.deepEqual(
    multi.getSelectedTracks().map((track) => track.id),
    ['t1']
  )
})

test('paged selection uses compact records in query order, supports two-argument calls, and releases on reset/dispose', () => {
  const tracks = ref<Track[]>(makeTracks(4))
  const offset = ref(200)
  const revision = ref(1)
  const preserve = ref(true)
  const scope = effectScope()
  const multi = scope.run(() =>
    useTrackMultiSelect({
      tracks,
      preserveSelectedTracks: preserve,
      snapshotTrack: (track) => ({ ...makeTracks(1)[0], id: track.id, title: track.title }),
      selectionOrder: (_track, index) => offset.value + index,
      resetSources: [revision],
      rangeContext: offset
    })
  )!
  multi.toggle('t3', 3)
  multi.toggle('missing', 0)
  assert.equal(multi.selectedCount.value, 1)
  tracks.value = [] // Loading is not deletion.
  offset.value = 0
  tracks.value = makeTracks(2).map((track) => ({ ...track, id: `first:${track.id}` }))
  multi.selectAll()
  assert.deepEqual(
    multi.getSelectedTracks().map((track) => track.id),
    ['first:t0', 'first:t1', 't3']
  )
  assert.notEqual(multi.getSelectedTracks()[0], tracks.value[0])
  multi.selectOnly('first:t1', 1)
  assert.deepEqual(
    multi.getSelectedTracks().map((track) => track.id),
    ['first:t1']
  )
  revision.value++
  assert.equal(
    multi.selectedCount.value,
    0,
    'revision fence clears synchronously, before a stale action'
  )
  multi.toggle('first:t0', 0)
  preserve.value = false
  assert.equal(multi.selectedCount.value, 0, 'storage/source changes release retained rows')
  preserve.value = true
  multi.selectAll()
  scope.stop()
  assert.deepEqual(multi.getSelectedTracks(), [])
})

test('page-local Shift range never uses a previous page anchor and select-all adds only this page', () => {
  const tracks = ref(makeTracks(6))
  const page = ref(0)
  const multi = withScope(() =>
    useTrackMultiSelect({
      tracks,
      preserveSelectedTracks: () => true,
      rangeContext: page,
      selectionOrder: (_track, index) => page.value * 200 + index
    })
  )
  multi.toggle('t5', 5)
  page.value = 1
  tracks.value = makeTracks(6).map((track) => ({ ...track, id: `next:${track.id}` }))
  multi.onRowClick(tracks.value[2], 2, { shiftKey: true } as MouseEvent)
  assert.deepEqual(multi.getSelectedTrackIds(), ['t5', 'next:t2'])
  multi.onRowClick(tracks.value[4], 4, { shiftKey: true } as MouseEvent)
  assert.deepEqual(
    multi.getSelectedTracks().map((track) => track.id),
    ['t5', 'next:t2', 'next:t3', 'next:t4']
  )
  multi.selectAll()
  assert.equal(multi.selectedCount.value, 7)
  assert.equal(multi.isSelected('t0'), false, 'select-all does not imply the complete SQL query')
})
