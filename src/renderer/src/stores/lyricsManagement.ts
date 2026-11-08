import { computed, effectScope, readonly, shallowRef } from 'vue'
import { useCoreConnection } from './coreConnection.ts'
import { createCorePlayerResource } from './player/corePlayerResource.ts'
import type { CorePlayerClient } from './player/corePlayerTypes.ts'
import type {
  CoreLyricPatch,
  CoreLyricsCurrent,
  CoreLyricsMutation
} from '../../../shared/coreLyrics.ts'
import {
  DEFAULT_LYRICS_MANAGEMENT,
  effectiveLyricOffsetSeconds,
  type LyricSourcePreference,
  type LyricsManagementDocument
} from '../../../shared/lyricsManagement.ts'

/** A bounded current-track projection; committed lyrics and source resolution live in Core. */
export function createCoreLyricsManagement(
  core: Pick<CorePlayerClient, 'state' | 'attach' | 'query' | 'command'>
) {
  const scope = effectScope(true)
  const store = scope.run(() => {
    const error = shallowRef<Error | null>(null)
    const failed = (cause: unknown) => {
      error.value = cause instanceof Error ? cause : new Error(String(cause))
    }
    const key = () => {
      const state = core.state.value
      return state?.phase === 'ready' && state.lyricsRevision !== null
        ? `${state.epoch}:${state.lyricsRevision}:${state.lyricsContentRevision}:${state.track?.id}:${state.queue?.occurrenceId}`
        : ''
    }
    const projection = createCorePlayerResource(
      key,
      async (signal) => ({
        state: await core.query('lyrics.state', {}, signal),
        content: await core.query('lyrics.current', {}, signal)
      }),
      failed
    )
    const document = computed<LyricsManagementDocument>(() => {
      const value = projection.value.value
      const current = value?.content.current
      const preferences = value?.state.preferences ?? DEFAULT_LYRICS_MANAGEMENT
      return {
        schemaVersion: 1,
        globalOffsetMs: preferences.globalOffsetMs,
        showOriginal: preferences.showOriginal,
        showTranslation: preferences.showTranslation,
        showRomanization: preferences.showRomanization,
        tracks:
          current && value?.content.override ? { [current.trackId]: value.content.override } : {}
      }
    })
    const revision = computed(() => projection.value.value?.state.revision ?? null)
    async function refresh() {
      await projection.refresh()
      error.value = null
    }
    async function ensureLoaded() {
      if (!core.state.value) await core.attach()
      if (!projection.value.value) await refresh()
      if (revision.value === null) throw new Error('歌词尚未就绪，请稍后重试')
    }
    async function edit(edit: CoreLyricsMutation['edit'], expectedRevision?: number | null) {
      await ensureLoaded()
      try {
        await core.command('lyrics.edit', { revision: expectedRevision ?? revision.value!, edit })
        await refresh()
      } catch (cause) {
        if ((cause as { code?: string })?.code === 'STALE_REVISION') await refresh().catch(failed)
        failed(cause)
        throw cause
      }
    }
    const entryFor = (trackId: string) => document.value.tracks[trackId]
    const current = (): CoreLyricsCurrent => {
      const state = core.state.value
      if (!state?.track) throw new Error('当前没有播放曲目')
      return { trackId: state.track.id, occurrenceId: state.queue?.occurrenceId ?? null }
    }
    return {
      document: readonly(document),
      revision,
      error: readonly(error),
      globalOffsetMs: computed(() => document.value.globalOffsetMs),
      getRevision: () => revision.value,
      ensureLoaded,
      refresh,
      entryFor,
      effectiveOffsetSeconds: (trackId: string) =>
        effectiveLyricOffsetSeconds(
          document.value.globalOffsetMs,
          entryFor(trackId)?.offsetMs ?? 0
        ),
      updateTrack: (trackId: string, patch: CoreLyricPatch, expectedRevision?: number | null) =>
        edit({ kind: 'track', trackId, patch }, expectedRevision),
      selectSource: (trackId: string, source: LyricSourcePreference) =>
        edit({ kind: 'track', trackId, patch: { source } }),
      updateGlobalOffset: (offsetMs: number) => edit({ kind: 'globalOffset', offsetMs }),
      updateVisibility: (
        patch: Partial<
          Pick<LyricsManagementDocument, 'showOriginal' | 'showTranslation' | 'showRomanization'>
        >
      ) => edit({ kind: 'visibility', patch }),
      importDraft: async () => (await core.command('lyrics.importDraft', {})) as string | null,
      exportDraft: async (contents: string) =>
        (await core.command('lyrics.exportDraft', { contents })) as string | null,
      search: () => core.query('lyrics.search', current())
    }
  })!
  return { ...store, dispose: () => scope.stop() }
}
let singleton: ReturnType<typeof createCoreLyricsManagement> | null = null
export function useLyricsManagement() {
  return (singleton ??= createCoreLyricsManagement(useCoreConnection()))
}
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    singleton?.dispose()
    singleton = null
  })
