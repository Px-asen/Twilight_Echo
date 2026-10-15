import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, ref } from 'vue'

const { useTrackMultiSelect, isTrackListShortcutTarget } = (await import(
  new URL('./useTrackMultiSelect.ts', import.meta.url).href
)) as typeof import('./useTrackMultiSelect')

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

function withScope<T>(run: () => T): T {
  const scope = effectScope()
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
