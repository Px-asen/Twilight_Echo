import { shallowRef } from 'vue'
import {
  LIBRARY_PAGE_SIZE,
  type LibraryDatabaseApi,
  type LibraryPlaylistViewSync,
  type LibraryPlaylistViewSyncResult,
  type LibraryTrackRecord
} from '../../../../shared/libraryDatabase.ts'
import type { RecordingVersion } from '../../../../shared/recordingIdentity.ts'
import { compactPlaylistRecord } from '../../../../shared/playlistSnapshot.ts'
import type { Playlist } from './musicStoreTypes.ts'
import { importEntryViewRecord } from '../../../../shared/externalPlaylist.ts'

type Definition = Pick<Playlist, 'id' | 'trackIds' | 'trackSnapshots' | 'imported'>
type CatalogDefinition = Definition & Pick<Playlist, 'name' | 'cover' | 'isDefault'>
type Preferences = { revision: number; versions: RecordingVersion[]; preserveSources?: boolean }

/** One consumer owns one immutable view. Membership/preferences replace it;
 * library changes only refresh its SQL projection. Never hydrate a full playlist
 * or replay an uncertain append/commit. Release even an unacknowledged begin. */
export function createLibraryPlaylistView(
  api: Pick<LibraryDatabaseApi, 'syncPlaylistView'>,
  identity: () => string = () => crypto.randomUUID()
) {
  const state = shallowRef({
    id: null as string | null,
    pending: false,
    error: '',
    generation: 0
  })
  let definition: Definition | null = null
  let catalog: CatalogDefinition[] | null = null
  let preferences: Preferences = { revision: -1, versions: [] }
  let leasedId: string | null = null
  let task: Promise<void> | null = null
  let dirty = false
  let disposed = false

  function check(
    reply: LibraryPlaylistViewSyncResult,
    id: string,
    sequence: number,
    count: number,
    committed: boolean
  ): void {
    if (
      reply.id !== id ||
      reply.sequence !== sequence ||
      reply.count !== count ||
      reply.committed !== committed
    )
      throw new Error('曲库返回了无效的歌单视图确认')
  }
  async function release(): Promise<void> {
    if (leasedId === null) return
    const id = leasedId
    // Keep the cleanup obligation if its reply is lost. Drop is idempotent.
    const reply = await api.syncPlaylistView({ kind: 'drop', id })
    check(reply, id, 0, 0, false)
    leasedId = null
  }
  function run(): Promise<void> {
    if (task) return task
    let attemptedGeneration = state.value.generation
    task = (async () => {
      try {
        while (dirty || disposed) {
          attemptedGeneration = state.value.generation
          await release()
          if (disposed) return
          dirty = false
          const current = catalog ?? (definition ? [definition] : null),
            isCatalog = catalog !== null,
            generation = state.value.generation
          attemptedGeneration = generation
          if (!current) return
          const versions = structuredClone(preferences.versions),
            id = identity()
          leasedId = id
          let sequence = 0
          check(
            await api.syncPlaylistView({
              kind: 'begin',
              id,
              versions,
              ...(preferences.preserveSources ? { preserveSources: true } : {}),
              ...(isCatalog ? { catalog: true } : {})
            }),
            id,
            0,
            0,
            false
          )
          const stale = () => disposed || generation !== state.value.generation
          if (isCatalog) {
            for (let offset = 0; offset < current.length && !stale(); offset += LIBRARY_PAGE_SIZE) {
              const groups = (current as CatalogDefinition[])
                .slice(offset, offset + LIBRARY_PAGE_SIZE)
                .map(({ id, name, cover, isDefault }) => ({ id, name, cover, isDefault }))
              check(
                await api.syncPlaylistView({ kind: 'groups', id, sequence: ++sequence, groups }),
                id,
                sequence,
                0,
                false
              )
            }
          }
          let count = 0
          let entries: Extract<LibraryPlaylistViewSync, { kind: 'append' }>['entries'] = []
          const flush = async () => {
            check(
              await api.syncPlaylistView({
                kind: 'append',
                id,
                sequence: ++sequence,
                // Serialize only this compact window: nested routing may be a
                // Vue proxy even when the containing snapshot is plain data.
                entries: JSON.parse(JSON.stringify(entries)) as typeof entries
              }),
              id,
              sequence,
              count + entries.length,
              false
            )
            count += entries.length
            entries = []
          }
          // Retain immutable configuration references; compact only one member
          // window at a time. Small playlists share a window, rather than each
          // requiring a separate RPC for a single member.
          for (const group of current) {
            const memberCount = group.imported?.entries.length ?? group.trackIds.length
            for (let index = 0; index < memberCount; index++) {
              if (stale()) break
              const importedEntry = group.imported?.entries[index]
              const trackId = importedEntry ? importedEntry.entryId : group.trackIds[index]
              const snapshot = importedEntry
                ? importEntryViewRecord(importedEntry)
                : group.trackSnapshots?.[trackId]
              entries.push({
                id: trackId,
                ...(isCatalog ? { collectionId: group.id } : {}),
                ...(snapshot
                  ? {
                      snapshot: compactPlaylistRecord(snapshot as unknown as LibraryTrackRecord)
                    }
                  : {})
              })
              if (entries.length === LIBRARY_PAGE_SIZE) await flush()
            }
            if (stale()) break
          }
          if (entries.length && !stale()) await flush()
          if (stale()) continue
          check(
            await api.syncPlaylistView({ kind: 'commit', id, sequence: ++sequence }),
            id,
            sequence,
            count,
            true
          )
          if (!stale()) state.value = { ...state.value, id, pending: false }
        }
      } catch (error) {
        if (!disposed && attemptedGeneration === state.value.generation)
          state.value = {
            ...state.value,
            id: null,
            pending: false,
            error: error instanceof Error ? error.message : String(error)
          }
        // A failed or superseded upload is never made visible. Try releasing
        // once, retaining the obligation for explicit retry if transport failed.
        try {
          await release()
        } catch {
          /* The worker lease also expires; retry releases before allocating. */
        }
      }
    })().finally(() => {
      task = null
      if (!disposed && dirty && !state.value.error) void run()
    })
    return task
  }
  function replace(): Promise<void> {
    dirty = true
    state.value = {
      id: null,
      pending: definition !== null || catalog !== null,
      error: '',
      generation: state.value.generation + 1
    }
    return run()
  }
  return {
    state,
    setPlaylist(value: Definition | null, next: Preferences): Promise<void> {
      if (disposed) return Promise.resolve()
      if (
        catalog === null &&
        value?.id === definition?.id &&
        value?.trackIds === definition?.trackIds &&
        value?.trackSnapshots === definition?.trackSnapshots &&
        value?.imported?.membershipRevision === definition?.imported?.membershipRevision &&
        next.revision === preferences.revision &&
        next.preserveSources === preferences.preserveSources
      )
        return task ?? Promise.resolve()
      // Retain the immutable membership references, not the mutable Playlist.
      definition = value
        ? { id: value.id, trackIds: value.trackIds, trackSnapshots: value.trackSnapshots, imported: value.imported ? {...value.imported} : undefined }
        : null
      catalog = null
      preferences = next
      return replace()
    },
    setCatalog(value: CatalogDefinition[] | null, next: Preferences): Promise<void> {
      if (disposed) return Promise.resolve()
      const beforeById = new Map(catalog?.map((group) => [group.id, group]))
      if (
        definition === null &&
        next.revision === preferences.revision &&
        next.preserveSources === preferences.preserveSources &&
        (value === null
          ? catalog === null
          : catalog !== null &&
            value.length === catalog.length &&
            value.every((group) => {
              const before = beforeById.get(group.id)
              return (
                before !== undefined &&
                group.id === before.id &&
                group.name === before.name &&
                group.cover === before.cover &&
                group.isDefault === before.isDefault &&
                group.trackIds === before.trackIds &&
                group.trackSnapshots === before.trackSnapshots
                && group.imported?.membershipRevision === before.imported?.membershipRevision
              )
            }))
      )
        return task ?? Promise.resolve()
      definition = null
      catalog =
        value?.map(({ id, name, cover, isDefault, trackIds, trackSnapshots, imported }) => ({
          id,
          name,
          cover,
          isDefault,
          trackIds,
          trackSnapshots,
          imported: imported ? {...imported} : undefined
        })) ?? null
      preferences = next
      return replace()
    },
    retry(): Promise<void> {
      return disposed ? Promise.resolve() : replace()
    },
    /** A lost worker or expired private view can be rebuilt from configuration.
     * Content/history fences and genuine SQL errors must remain visible errors. */
    recover(id: string, error: unknown): boolean {
      if (
        disposed ||
        id !== state.value.id ||
        !/Playlist view expired|Music library database process (?:exited|is unavailable)/i.test(
          String(error)
        )
      )
        return false
      void replace()
      return true
    },
    dispose(): Promise<void> {
      disposed = true
      state.value = { id: null, pending: false, error: '', generation: state.value.generation + 1 }
      return run()
    }
  }
}
