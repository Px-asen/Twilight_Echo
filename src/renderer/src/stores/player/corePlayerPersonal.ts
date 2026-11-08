import { computed, readonly, ref, shallowRef } from 'vue'
import type { CorePlayerClient } from './corePlayerTypes.ts'
import { createCorePlayerResource } from './corePlayerResource.ts'
import type {
  CoreWorkspaceEdit,
  CoreWorkspaceRestoreResult
} from '../../../../shared/coreWorkspace.ts'

export function createCorePlayerPersonal(core: CorePlayerClient, failed: (error: unknown) => void) {
  const key = (domain: 'lyrics' | 'bookmarks' | 'workspace') => {
    const state = core.state.value
    if (!state || state.phase !== 'ready' || state[`${domain}Revision`] === null) return ''
    return `${state.epoch}:${state[`${domain}Revision`]}:${domain === 'bookmarks' ? state.queue?.occurrenceId : state[`${domain}ContentRevision`]}`
  }
  const lyrics = createCorePlayerResource(
    () => key('lyrics'),
    async (signal) => ({
      state: await core.query('lyrics.state', {}, signal),
      content: await core.query('lyrics.current', {}, signal)
    }),
    failed
  )
  const bookmarks = createCorePlayerResource(
    () => key('bookmarks'),
    async (signal) => {
      const state = await core.query('bookmarks.state', {}, signal)
      return {
        ...state,
        page: await core.query(
          'bookmarks.page',
          {
            revision: state.revision,
            scope: 'current',
            offset: 0,
            limit: 200
          },
          signal
        )
      }
    },
    failed
  )
  const workspace = createCorePlayerResource(
    () => key('workspace'),
    async (signal) => {
      const state = await core.query('workspace.state', {}, signal)
      const page = {
        revision: state.revision,
        contentRevision: state.contentRevision,
        offset: 0,
        limit: 200
      }
      return {
        state,
        sessions: await core.query('workspace.sessions', page, signal),
        history: await core.query('workspace.history', page, signal)
      }
    },
    failed
  )
  const current = () => {
    const state = core.state.value
    if (!state?.track) throw new Error('当前没有播放曲目')
    return { trackId: state.track.id, occurrenceId: state.queue?.occurrenceId ?? null }
  }
  async function editWorkspace(edit: CoreWorkspaceEdit['edit']): Promise<void> {
    if (!workspace.value.value) await workspace.refresh()
    await core.command('workspace.edit', { revision: workspace.value.value!.state.revision, edit })
    await workspace.refresh()
  }
  const open = ref(false),
    tab = ref<'sessions' | 'history'>('sessions'),
    restoring = ref(false)
  const lastRestore = shallowRef<CoreWorkspaceRestoreResult | null>(null)
  let restoreView = 0
  const queueWorkspace = {
    sessions: computed(() => workspace.value.value?.sessions.items ?? []),
    history: computed(() => workspace.value.value?.history.items ?? []),
    loading: workspace.loading,
    busy: computed(() => workspace.loading.value || restoring.value),
    error: computed(() => workspace.value.value?.state.error ?? ''),
    ensureLoaded: async () => {
      if (!workspace.value.value) await workspace.refresh()
    },
    reload: workspace.refresh,
    getRevision: () => workspace.value.value?.state.revision ?? 0,
    rename: (id: string, name: string) => editWorkspace({ kind: 'rename', id, name }),
    remove: (id: string) => editWorkspace({ kind: 'remove', id }),
    flush: async () => {
      await core.command('lifecycle.flush', {})
    }
  }
  const queueSessions = {
    open,
    tab,
    restoring: readonly(restoring),
    lastRestore: readonly(lastRestore),
    show: (next: 'sessions' | 'history' = 'sessions') => {
      tab.value = next
      open.value = true
      lastRestore.value = null
    },
    cancelRestore: () => {
      restoreView++
      restoring.value = false
    },
    save: (name: string, id?: string) =>
      editWorkspace({ kind: 'saveCurrent', name, ...(id ? { id } : {}) }),
    restore: async (id: string, play = false) => {
      if (!workspace.value.value) await workspace.refresh()
      const view = ++restoreView
      restoring.value = true
      try {
        const result = await core.command('workspace.restore', {
          revision: workspace.value.value!.state.revision,
          id,
          play
        })
        if (view === restoreView) lastRestore.value = result as CoreWorkspaceRestoreResult
      } finally {
        if (view === restoreView) restoring.value = false
      }
    }
  }
  const resumeOffer = computed(() => {
    const bookmark = currentBookmarks()?.resumeOffer
    return bookmark
      ? {
          trackId: core.state.value?.track?.id ?? '',
          positionSeconds: bookmark.positionSeconds,
          label: bookmark.label
        }
      : null
  })
  async function bookmarkState() {
    if (!bookmarks.value.value) await bookmarks.refresh()
    return bookmarks.value.value!
  }
  function currentBookmarks() {
    const value = bookmarks.value.value
    const state = core.state.value
    return value?.current?.trackId === state?.track?.id &&
      value?.current?.occurrenceId === (state?.queue?.occurrenceId ?? null) ? value : null
  }
  return {
    lyricsContent: computed(() => lyrics.value.value?.content ?? null),
    lyricsLoadState: computed(
      () => lyrics.value.value?.state.loadState ?? { trackId: '', status: 'idle' as const }
    ),
    lyricsOffsetSeconds: computed(() => lyrics.value.value?.content.offsetSeconds ?? 0),
    refreshCurrentLyrics: async () => {
      await core.command('lyrics.reload', current())
      await lyrics.refresh()
    },
    resumeOffer,
    acceptResumeOffer: async () => {
      const state = await bookmarkState()
      if (state.resumeOffer)
        await core.command('bookmarks.seek', {
          id: state.resumeOffer.id,
          revision: state.revision,
          current: current()
        })
    },
    dismissResumeOffer: async () => {
      const state = await bookmarkState()
      await core.command('bookmarks.edit', {
        revision: state.revision,
        edit: { kind: 'dismissOffer', current: current() }
      })
    },
    addManualBookmarkAtCurrentTime: async (label?: string) => {
      const state = await bookmarkState()
      await core.command('bookmarks.edit', {
        revision: state.revision,
        edit: { kind: 'addCurrent', current: current(), ...(label ? { label } : {}) }
      })
      await bookmarks.refresh()
    },
    currentTrackBookmarks: computed(() => currentBookmarks()?.page.items ?? []),
    refreshBookmarks: bookmarks.refresh,
    renameBookmark: async (id: string, label: string) => {
      const state = await bookmarkState()
      await core.command('bookmarks.edit', { revision: state.revision, edit: { kind: 'rename', id, label } })
      await bookmarks.refresh()
    },
    removeBookmark: async (id: string) => {
      const state = await bookmarkState()
      await core.command('bookmarks.edit', { revision: state.revision, edit: { kind: 'remove', id } })
      await bookmarks.refresh()
    },
    seekBookmark: async (id: string) => {
      const state = await bookmarkState()
      await core.command('bookmarks.seek', { revision: state.revision, id, current: current() })
    },
    queueWorkspace,
    queueSessions
  }
}
