import type { Cell, PlaylistRuntime } from './ports.ts'
import type { Playlist, PlaylistPersistenceNotice } from '../../shared/playlists.ts'
import {
  PlaylistPersistence,
  PlaylistTransactionRejectedError,
  type PlaylistPersistenceStatus
} from './persistence.ts'
import {
  isVersionedDataEnvelope,
  isPersistentDataRevisionConflict,
  type VersionedDataEnvelope
} from '../../shared/versionedPersistence.ts'
import {
  playlistDataEqual,
  replayPlaylistTransaction,
  sharePlaylistSnapshot,
  slimPlaylistLegacySnapshots
} from './data.ts'

/** Own the save queue, authoritative revision and conflict recovery together. */
export function createPlaylistState({
  playlists,
  runtime,
  playlistPersistenceStatus,
  playlistPersistenceNotice,
  onChange
}: {
  runtime: PlaylistRuntime
  playlists: Cell<Playlist[]>
  playlistPersistenceStatus: Cell<PlaylistPersistenceStatus>
  playlistPersistenceNotice: Cell<PlaylistPersistenceNotice | null>
  onChange: () => void
}) {
  let playlistsRevision = 0
  let playlistAuthoritativeSnapshot: Playlist[] = []
  let playlistPersistence: PlaylistPersistence<Playlist[]> | null = null

  function clonePlaylistSnapshot(source: Playlist[] = playlists.value): Playlist[] {
    return sharePlaylistSnapshot(source)
  }

  function getPlaylistPersistence(): PlaylistPersistence<Playlist[]> {
    if (playlistPersistence) return playlistPersistence
    playlistPersistence = new PlaylistPersistence({
      write: persistPlaylistSnapshot,
      onStatus: (status) => {
        playlistPersistenceStatus.value = status
      },
      flushDelayMs: 250,
      retryDelayMs: 1_000,
      // queuePlaylistPersistence only ever enqueues clonePlaylistSnapshot()
      // results (frozen plain data), so the queue does not need to re-clone.
      cloneSnapshot: (snapshot) => snapshot,
      shouldRetry: (error) => !(error instanceof PlaylistTransactionRejectedError)
    })
    return playlistPersistence
  }

  function queuePlaylistPersistence(base?: Playlist[]): void {
    onChange()
    // playlists 是 shallowRef：就地修改（trackIds/trackSnapshots/name/cover）不会
    // 自动通知，所有变更路径都在此汇合，统一触发。
    runtime.notify()
    const before = persistentSnapshot(base ?? playlistAuthoritativeSnapshot, false)
    getPlaylistPersistence().enqueue(persistentSnapshot(playlists.value), before)
  }

  function persistentSnapshot(source: Playlist[], clone = true): Playlist[] {
    const snapshot = source.filter((playlist) => !playlist.transient)
    return clone ? clonePlaylistSnapshot(snapshot) : snapshot
  }

  function isPlaylistData(value: unknown): value is Playlist[] {
    return Array.isArray(value)
  }

  async function loadPlaylistEnvelopeForConflict(): Promise<VersionedDataEnvelope<
    Playlist[]
  > | null> {
    const loaded = await runtime.repository.load()
    return isVersionedDataEnvelope(loaded, isPlaylistData) ? loaded : null
  }

  async function persistPlaylistSnapshot(snapshot: Playlist[], base: Playlist[]): Promise<void> {
    let expectedRevision = playlistsRevision
    // A preceding queued write may have recovered a CAS conflict while this
    // transaction was waiting. In that case `base` predates the newly merged
    // authoritative snapshot even though `expectedRevision` is current. Replay
    // the local delta before the first attempt so the next successful write
    // cannot silently erase data recovered by the previous transaction.
    let desired = playlistDataEqual(base, playlistAuthoritativeSnapshot)
      ? snapshot
      : replayPlaylistTransaction(base, snapshot, playlistAuthoritativeSnapshot)
    let recoveredConflictRevision: number | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const saved = await runtime.repository.save(desired, expectedRevision)
        if (isVersionedDataEnvelope(saved, isPlaylistData)) {
          playlistsRevision = saved.revision
          playlistAuthoritativeSnapshot = clonePlaylistSnapshot(saved.data)
          // Do not overwrite an action that arrived while this write was in flight.
          if (playlistDataEqual(persistentSnapshot(playlists.value), snapshot)) {
            playlists.value = [
              ...clonePlaylistSnapshot(saved.data),
              ...playlists.value.filter((playlist) => playlist.transient)
            ]
            onChange()
          }
        } else {
          playlistAuthoritativeSnapshot = clonePlaylistSnapshot(desired)
        }
        if (recoveredConflictRevision !== null) {
          playlistPersistenceNotice.value = {
            kind: 'revision-conflict-recovered',
            message: '检测到歌单被其他窗口更新，已合并权威版本并保存本次修改',
            authoritativeRevision: recoveredConflictRevision,
            recoveredAt: new Date(runtime.now()).toISOString()
          }
        }
        return
      } catch (error) {
        if (!isPersistentDataRevisionConflict(error)) throw error
        const current = isVersionedDataEnvelope(error.current, isPlaylistData)
          ? error.current
          : await loadPlaylistEnvelopeForConflict()
        if (!current) throw error
        // Reapply only the immutable local delta to the authoritative snapshot.
        // Sending the old whole-file snapshot here would erase concurrent edits.
        desired = replayPlaylistTransaction(base, snapshot, current.data)
        playlistsRevision = current.revision
        expectedRevision = current.revision
        recoveredConflictRevision = current.revision
      }
    }
    throw new Error('Playlist persistence revision conflict did not settle after 3 retries')
  }

  async function savePlaylists(): Promise<void> {
    queuePlaylistPersistence()
  }

  async function flushPlaylists(): Promise<boolean> {
    return getPlaylistPersistence().flush()
  }

  async function loadPlaylists(): Promise<void> {
    const loadedResult = await runtime.repository.load()
    applyLoadedPlaylists(loadedResult)
  }

  /** Explicitly discard all unsaved changes. Read failures or intervening
   * gestures preserve both optimistic data and its pending transaction. */
  async function reloadPlaylistsDiscardingChanges(): Promise<void> {
    if (playlistPersistenceStatus.value.canRetry !== false)
      throw new Error('当前没有需要重新读取的歌单成员冲突')
    const before = clonePlaylistSnapshot()
    const loadedResult = await runtime.repository.load()
    const saved = isVersionedDataEnvelope(loadedResult, isPlaylistData)
      ? loadedResult.data
      : loadedResult
    if (!isRecoveryData(saved)) throw new Error('未读取到有效歌单，已保留未保存的修改')
    // Normalize and clone before dropping pending intent. A malformed snapshot
    // must not clear the queue and only then fail during publication.
    const prepared = prepareLoadedPlaylists(loadedResult)
    await getPlaylistPersistence().discardPending(
      () => {
        if (
          playlistPersistenceStatus.value.canRetry !== false ||
          !playlistDataEqual(before, playlists.value)
        )
          throw new Error('读取期间歌单又有变化，已保留未保存的修改，请重试')
      },
      () => applyPreparedPlaylists(prepared)
    )
  }

  function isRecoveryData(value: unknown): value is Playlist[] {
    if (!Array.isArray(value)) return false
    const ids = new Set<string>()
    return value.every((playlist: Playlist | null) => {
      if (
        !playlist ||
        typeof playlist.id !== 'string' ||
        !playlist.id ||
        ids.has(playlist.id) ||
        typeof playlist.name !== 'string' ||
        typeof playlist.createdAt !== 'string' ||
        !Array.isArray(playlist.trackIds) ||
        playlist.trackIds.some((id) => typeof id !== 'string')
      )
        return false
      ids.add(playlist.id)
      if (!playlist.imported) return true
      const data = playlist.imported
      return (
        typeof data.generation === 'string' &&
        Number.isSafeInteger(data.membershipRevision) &&
        Array.isArray(data.entries) &&
        data.entries.every(
          (entry) =>
            entry &&
            typeof entry.entryId === 'string' &&
            Number.isSafeInteger(entry.revision) &&
            Number.isSafeInteger(entry.position) &&
            !!entry.original &&
            !!entry.resolution
        )
      )
    })
  }

  function prepareLoadedPlaylists(loadedResult: unknown) {
    const saved = isVersionedDataEnvelope(loadedResult, isPlaylistData)
      ? loadedResult.data
      : loadedResult
    const revision = isVersionedDataEnvelope(loadedResult, isPlaylistData)
      ? loadedResult.revision
      : 0
    const DEFAULT_PLAYLIST: Playlist = {
      id: 'pl_favorites',
      name: '我收藏的音乐',
      trackIds: [],
      isDefault: true,
      createdAt: new Date(runtime.now()).toISOString()
    }

    if (!saved || !Array.isArray(saved) || saved.length === 0) {
      return { revision, loaded: [DEFAULT_PLAYLIST], authority: [] as Playlist[], needsSave: true }
    }

    // 旧版本保存的歌单快照可能携带歌词全文 / bpmAnalysis / metadataMatch，
    // 加载时统一瘦身，避免数十 MB 载荷随歌单驻留。
    const loaded = sharePlaylistSnapshot((saved as Playlist[]).map(slimPlaylistLegacySnapshots))
    // Ensure default playlist exists
    if (!loaded.find((p) => p.isDefault)) {
      loaded.unshift(DEFAULT_PLAYLIST)
    }
    return { revision, loaded, authority: clonePlaylistSnapshot(loaded), needsSave: false }
  }

  function applyPreparedPlaylists(prepared: ReturnType<typeof prepareLoadedPlaylists>): void {
    playlistsRevision = prepared.revision
    playlistAuthoritativeSnapshot = prepared.authority
    playlists.value = prepared.loaded
    onChange()
    if (prepared.needsSave) queuePlaylistPersistence([])
  }

  function applyLoadedPlaylists(loadedResult: unknown): void {
    applyPreparedPlaylists(prepareLoadedPlaylists(loadedResult))
  }
  return {
    getRevision: () => playlistsRevision,
    getAuthoritativeSnapshot: () => playlistAuthoritativeSnapshot,
    dispose: () => playlistPersistence?.dispose(),
    clonePlaylistSnapshot,
    queuePlaylistPersistence,
    savePlaylists,
    flushPlaylists,
    loadPlaylists,
    reloadPlaylistsDiscardingChanges
  }
}
