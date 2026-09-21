import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, effectScope, nextTick, ref } from 'vue'
import { useSongListVirtualScroll } from './useSongListVirtualScroll.ts'

test('returning from an album restores its parent offset after the transition, ignoring temporary scroll events', async () => {
  const scope = effectScope()
  const key = ref('test:albums')
  const identity = computed(() => key.value)
  const scroll = scope.run(() =>
    useSongListVirtualScroll({
      displayTracks: computed(() => []),
      resetSources: [],
      shouldResetOnSearch: computed(() => false),
      debouncedSearchQuery: ref(''),
      viewKey: computed(() => key.value),
      viewIdentity: identity
    })
  )!
  const container = { clientHeight: 720, scrollTop: 0 } as HTMLElement
  scroll.containerRef.value = container
  scroll.restoreScrollAndMeasure()
  await nextTick()
  container.scrollTop = 2400
  scroll.onScroll({ target: container } as unknown as Event)
  key.value = 'test:albums:detail'
  await nextTick()
  container.scrollTop = 0
  scroll.onScroll({ target: container } as unknown as Event)
  scroll.restoreScrollAndMeasure()
  await nextTick()
  assert.equal(container.scrollTop, 0)
  key.value = 'test:albums'
  await nextTick()
  scroll.onScroll({ target: container } as unknown as Event)
  assert.equal(scroll.scrollTop.value, 2400)
  scroll.restoreScrollAndMeasure()
  await nextTick()
  assert.equal(container.scrollTop, 2400)
  scope.stop()
})
