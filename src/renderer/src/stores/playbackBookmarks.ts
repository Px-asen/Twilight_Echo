import { computed, effectScope, readonly, shallowRef } from 'vue'
import { useCoreConnection } from './coreConnection.ts'
import { createCorePlayerResource } from './player/corePlayerResource.ts'
import type { CorePlayerClient } from './player/corePlayerTypes.ts'
import type { CoreBookmark } from '../../../shared/coreBookmarks.ts'

/** Read-only bookmark catalog for library menus. Core owns identity keys and every write. */
export function createCorePlaybackBookmarks(core: Pick<CorePlayerClient, 'state' | 'attach' | 'query'>) {
  const scope = effectScope(true)
  const store = scope.run(() => {
    const error = shallowRef<Error | null>(null)
    const projection = createCorePlayerResource(
      () => {
        const state = core.state.value
        return state?.phase === 'ready' && state.bookmarksRevision !== null
          ? `${state.epoch}:${state.bookmarksRevision}` : ''
      },
      async (signal) => {
        const state = await core.query('bookmarks.state', {}, signal)
        const items: CoreBookmark[] = []
        let offset = 0
        for (;;) {
          const page = await core.query(
            'bookmarks.page',
            { revision: state.revision, scope: 'all', offset, limit: 200 },
            signal
          )
          items.push(...page.items)
          offset += page.items.length
          if (offset >= page.total) return { state, items }
          if (!page.items.length) throw new Error('书签分页读取中断')
        }
      },
      cause => { error.value = cause instanceof Error ? cause : new Error(String(cause)) }
    )
    const bookmarksFor = (track: { id: string } | null | undefined) => track
      ? (projection.value.value?.items ?? []).filter(bookmark => bookmark.trackId === track.id)
          .sort((a, b) => a.positionSeconds - b.positionSeconds || a.createdAt.localeCompare(b.createdAt))
      : []
    return {
      error: readonly(error),
      longTrackResumeSeconds: computed(() => projection.value.value?.state.longTrackResumeSeconds ?? 1200),
      bookmarksFor,
      resumeBookmarkFor: (track: { id: string } | null | undefined) => bookmarksFor(track).find(bookmark => bookmark.kind === 'resume') ?? null,
      ensureLoaded: async () => {
        if (!core.state.value) await core.attach()
        if (!projection.value.value) await projection.refresh()
      },
      dispose: () => scope.stop()
    }
  })!
  return store
}
let singleton: ReturnType<typeof createCorePlaybackBookmarks> | null = null
export function usePlaybackBookmarks() {
  return (singleton ??= createCorePlaybackBookmarks(useCoreConnection()))
}
if (import.meta.hot) import.meta.hot.dispose(() => { singleton?.dispose(); singleton = null })
