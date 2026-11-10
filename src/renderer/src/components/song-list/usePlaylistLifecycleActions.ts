import { computed, ref, shallowRef, watch, type Ref } from 'vue'
import {
  useMusicStore,
  type Playlist,
  type PlaylistPersistenceNotice
} from '@renderer/stores/useMusicStore.ts'
import type { Track } from '@renderer/types/music.ts'
import { playlistExportFilename, playlistExportMimeType } from '@renderer/utils/playlistExport.ts'
import {
  assertPlaylistCoverDimensions,
  assertPlaylistCoverFile,
  readPlaylistImportFile
} from '@renderer/utils/playlistFileValidation.ts'
import type { PlaylistFileFormat } from '@renderer/utils/playlistLifecycle.ts'
import type { SongListActionSource, SongListActionLease } from './songListActionSource.ts'

export type PlaylistDialogRequest =
  | { kind: 'rename' | 'copy'; playlistId: string; initialValue: string }
  | { kind: 'move'; playlistId: string; initialValue: string; trackIds: string[] }

export interface PlaylistLifecycleActionOptions {
  currentPlaylist: Readonly<Ref<Playlist | null>>
  isPlaylistDetail: Readonly<Ref<boolean>>
  repairMessage: Ref<string>
  getSelectedTracks(): Track[]
  isSelected(trackId: string): boolean
  clearSelection(): void
  selectPlaylist(name: string): void
  definitionTrack?(track: Track): Track
  streamingSelection?: {
    enabled(): boolean
    capture(track?: Track): SongListActionSource
    run(
      source: SongListActionSource,
      action: (lease: SongListActionLease, signal: AbortSignal) => Promise<void | boolean>,
      clear?: boolean
    ): Promise<boolean>
  }
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

async function readPlaylistCover(file: File): Promise<string> {
  assertPlaylistCoverFile(file)
  const image = await createImageBitmap(file)
  try {
    assertPlaylistCoverDimensions(image.width, image.height)
  } finally {
    image.close()
  }

  // Keep the large source out of the reactive playlist snapshot. The main
  // process resizes and stores the bytes, returning a small content-addressed
  // cover:// handle. Tests/early boot without the bridge retain the legacy
  // data URL as a compatibility fallback.
  const cacheCover = window.api?.data?.cacheCover
  if (cacheCover && typeof file.arrayBuffer === 'function') {
    const handle = await cacheCover(await file.arrayBuffer())
    if (!handle) throw new Error('封面缓存失败')
    return handle
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取封面文件失败'))
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('封面数据无效'))
    reader.readAsDataURL(file)
  })
}

/**
 * Production playlist UI actions shared by SongList and the real-browser behavior gate.
 * Keeping the DOM boundary here prevents format, size and persistence behavior from
 * drifting into template-only code that cannot be exercised end to end.
 */
export function usePlaylistLifecycleActions(options: PlaylistLifecycleActionOptions): {
  playlistImportInput: Ref<HTMLInputElement | null>
  playlistCoverInput: Ref<HTMLInputElement | null>
  playlistExportFormat: Ref<PlaylistFileFormat>
  playlistRepairPending: Ref<boolean>
  playlistDialog: Ref<PlaylistDialogRequest | null>
  playlistDialogError: Ref<string>
  playlistMoveTargets: Readonly<Ref<Playlist[]>>
  dismissPlaylistDialog(): void
  confirmPlaylistDialog(value: string): Promise<void>
  triggerPlaylistImport(): void
  handlePlaylistImport(event: Event): Promise<void>
  downloadPlaylistDocument(format: PlaylistFileFormat): Promise<void>
  triggerPlaylistCoverPicker(): void
  handlePlaylistCover(event: Event): Promise<void>
  handleRenamePlaylist(): void
  handleCopyPlaylist(): void
  handleMoveSelectedWithinPlaylist(toEnd: boolean): Promise<void>
  handlePlaylistDragStart(event: DragEvent, track: Track): void
  handlePlaylistDrop(event: DragEvent, target: Track): Promise<void>
  handleMoveSelectedToPlaylist(): void
  handlePlaylistRepair(): Promise<void>
} {
  const {
    playlists,
    localPlaylists,
    playlistPersistenceStatus,
    playlistPersistenceNotice,
    renamePlaylist,
    setPlaylistCover,
    copyPlaylist,
    reorderPlaylistTracks,
    movePlaylistTracks,
    movePlaylistMemberPagesById,
    reorderPlaylistTrackIdPagesById,
    importPlaylistDocumentAsync,
    exportPlaylistDocumentAsync,
    getPlaylistMemberPosition,
    repairPlaylistMissingTracksAsync
  } = useMusicStore()
  const playlistImportInput = ref<HTMLInputElement | null>(null)
  const playlistCoverInput = ref<HTMLInputElement | null>(null)
  const playlistExportFormat = ref<PlaylistFileFormat>('m3u8')
  const playlistRepairPending = ref(false)
  let playlistExportPending = false
  const playlistDragTrackId = ref<string | null>(null)
  const playlistDialog = shallowRef<PlaylistDialogRequest | null>(null)
  const playlistDialogError = ref('')
  let moveSource: SongListActionSource | null = null
  let dragSource: { playlistId: string; source: SongListActionSource; id: string } | null = null
  const playlistMoveTargets = computed(() =>
    localPlaylists.value.filter((playlist) => playlist.id !== options.currentPlaylist.value?.id)
  )

  watch(
    () => options.currentPlaylist.value?.id,
    (id) => {
      if (playlistDialog.value && playlistDialog.value.playlistId !== id) dismissPlaylistDialog()
    }
  )

  watch(playlistPersistenceNotice, (notice: PlaylistPersistenceNotice | null) => {
    if (notice) options.repairMessage.value = notice.message
  })
  watch(playlistPersistenceStatus, (status) => {
    if (status.state === 'error') {
      options.repairMessage.value = `歌单保存失败：${status.lastError || '未知错误'}`
    }
  })

  function requireCurrentPlaylist(): Playlist | null {
    const playlist = options.currentPlaylist.value
    if (!playlist) options.repairMessage.value = '当前没有可编辑的歌单'
    return playlist
  }

  function handleRenamePlaylist(): void {
    const playlist = requireCurrentPlaylist()
    if (!playlist) return
    playlistDialogError.value = ''
    playlistDialog.value = { kind: 'rename', playlistId: playlist.id, initialValue: playlist.name }
  }

  function handleCopyPlaylist(): void {
    const playlist = requireCurrentPlaylist()
    if (!playlist) return
    playlistDialogError.value = ''
    playlistDialog.value = {
      kind: 'copy',
      playlistId: playlist.id,
      initialValue: `${playlist.name} 副本`
    }
  }

  function dismissPlaylistDialog(): void {
    moveSource = null
    playlistDialog.value = null
    playlistDialogError.value = ''
  }

  async function confirmPlaylistDialog(value: string): Promise<void> {
    const request = playlistDialog.value
    if (!request) return
    const playlist = playlists.value.find((item) => item.id === request.playlistId)
    if (!playlist) {
      playlistDialogError.value = '原歌单已不存在，请关闭后重试'
      return
    }
    try {
      if (request.kind === 'rename') {
        const changed = await renamePlaylist(playlist.id, value)
        if (changed) {
          options.repairMessage.value = playlistPersistenceNotice.value?.message ?? '歌单已重命名'
          const renamed = playlists.value.find((item) => item.id === playlist.id)
          if (renamed) options.selectPlaylist(renamed.name)
        }
      } else if (request.kind === 'copy') {
        const copyId = await copyPlaylist(playlist.id, value)
        options.repairMessage.value = copyId ? '已创建歌单副本' : '未找到原歌单'
      } else if (request.kind === 'move') {
        const target = playlistMoveTargets.value.find((item) => item.id === value)
        if (!target) {
          playlistDialogError.value = '目标歌单已不存在，请重新选择'
          return
        }
        if (moveSource && options.streamingSelection) {
          const source = moveSource
          const done = await options.streamingSelection.run(
            source,
            async (lease, signal) => {
              const result = await movePlaylistMemberPagesById(
                playlist.id,
                target.id,
                async (append) => {
                  await lease.members(append)
                  return () => {
                    source.guard()
                    if (playlistDialog.value !== request)
                      throw new Error('移动对话框已关闭，请重新选择')
                  }
                },
                signal
              )
              options.repairMessage.value = `已移动 ${result.sourceRemoved} 首${result.moved < result.sourceRemoved ? '，重复歌曲已合并' : ''}`
            },
            true
          )
          if (done && playlistDialog.value === request) dismissPlaylistDialog()
          return
        }
        const result = await movePlaylistTracks(playlist.name, target.name, request.trackIds)
        if (!result.sourceRemoved) {
          playlistDialogError.value = '没有可移动的歌曲，请重新选择'
          return
        }
        options.repairMessage.value = `已移动 ${result.sourceRemoved} 首${
          result.moved < result.sourceRemoved ? '，重复歌曲已合并' : ''
        }`
        options.clearSelection()
      }
      dismissPlaylistDialog()
    } catch (error) {
      playlistDialogError.value = describeError(error, '歌单操作失败')
    }
  }

  function triggerPlaylistImport(): void {
    playlistImportInput.value?.click()
  }

  async function handlePlaylistImport(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    const playlist = requireCurrentPlaylist()
    if (!file || !playlist) return
    const targetId = playlist.id,
      targetName = playlist.name
    try {
      const contents = await readPlaylistImportFile(file)
      if (!playlists.value.some((item) => item.id === targetId && item.name === targetName))
        throw new Error('目标歌单已被重命名或删除，请重新导入')
      const result = await importPlaylistDocumentAsync(targetName, file.name, contents)
      options.repairMessage.value = `已导入 ${result.importedCount} 首${
        result.unresolvedEntries ? `，${result.unresolvedEntries} 首未匹配` : ''
      }`
      if (result.warnings.length > 0) {
        console.warn('[playlist] import warnings:', result.warnings)
      }
    } catch (error) {
      options.repairMessage.value = describeError(error, '导入歌单失败')
    }
  }

  async function downloadPlaylistDocument(format: PlaylistFileFormat): Promise<void> {
    const playlist = requireCurrentPlaylist()
    if (!playlist || playlistExportPending) return
    playlistExportPending = true
    options.repairMessage.value = '正在准备导出歌单…'
    const name = playlist.name
    try {
      const contents = await exportPlaylistDocumentAsync(name, format)
      if (contents === null) return
      const blob = new Blob([contents], { type: playlistExportMimeType(format) })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = playlistExportFilename(name, format)
      try {
        link.click()
      } finally {
        URL.revokeObjectURL(link.href)
      }
      options.repairMessage.value = `已导出 ${format.toUpperCase()} 歌单`
    } catch (error) {
      options.repairMessage.value = describeError(error, '导出歌单失败')
    } finally {
      playlistExportPending = false
    }
  }

  function triggerPlaylistCoverPicker(): void {
    playlistCoverInput.value?.click()
  }

  async function handlePlaylistCover(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    const playlist = requireCurrentPlaylist()
    if (!file || !playlist) return
    try {
      await setPlaylistCover(playlist.id, await readPlaylistCover(file))
      options.repairMessage.value = '歌单封面已更新'
    } catch (error) {
      options.repairMessage.value = describeError(error, '更新歌单封面失败')
    }
  }

  async function handleMoveSelectedWithinPlaylist(toEnd: boolean): Promise<void> {
    const playlist = requireCurrentPlaylist()
    if (!playlist) return
    if (options.streamingSelection?.enabled()) {
      const source = options.streamingSelection.capture()
      await options.streamingSelection.run(source, async (lease, signal) => {
        if (
          await reorderPlaylistTrackIdPagesById(
            playlist.id,
            lease.ids,
            toEnd ? playlist.count : 0,
            signal
          )
        )
          options.repairMessage.value = toEnd ? '已移动到歌单末尾' : '已移动到歌单开头'
      })
      return
    }
    const selected = options.getSelectedTracks().map((track) => track.id)
    if (!selected.length) return
    if (await reorderPlaylistTracks(playlist.name, selected, toEnd ? playlist.count : 0)) {
      options.repairMessage.value = toEnd ? '已移动到歌单末尾' : '已移动到歌单开头'
    }
  }

  function handlePlaylistDragStart(event: DragEvent, track: Track): void {
    if (!options.isPlaylistDetail.value) return
    const definition = options.definitionTrack?.(track) ?? track
    dragSource =
      options.streamingSelection?.enabled() && options.currentPlaylist.value
        ? {
            playlistId: options.currentPlaylist.value.id,
            id: definition.id,
            source: options.streamingSelection.capture(track)
          }
        : null
    playlistDragTrackId.value = definition.id
    event.dataTransfer?.setData('text/plain', definition.id)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  async function handlePlaylistDrop(event: DragEvent, target: Track): Promise<void> {
    event.preventDefault()
    target = options.definitionTrack?.(target) ?? target
    const playlist = requireCurrentPlaylist()
    const dragged = playlistDragTrackId.value ?? event.dataTransfer?.getData('text/plain')
    playlistDragTrackId.value = null
    const captured = dragSource
    dragSource = null
    if (!playlist || !dragged || dragged === target.id) return
    const streaming = options.streamingSelection?.enabled()
    if (streaming && (!captured || captured.playlistId !== playlist.id)) return
    const selected = streaming
      ? []
      : options.isSelected(dragged)
        ? options.getSelectedTracks().map((track) => track.id)
        : [dragged]
    try {
      const [fromIndex, targetIndex] = await Promise.all([
        getPlaylistMemberPosition(playlist.id, dragged),
        getPlaylistMemberPosition(playlist.id, target.id)
      ])
      if (fromIndex < 0 || targetIndex < 0 || options.currentPlaylist.value?.id !== playlist.id)
        return
      // Dropping downward inserts after the target; upward inserts before it.
      // Inserting before the next row would otherwise leave adjacent songs unchanged.
      const insertion = targetIndex + (fromIndex < targetIndex ? 1 : 0)
      if (streaming && captured) {
        await options.streamingSelection!.run(captured.source, async (lease, signal) => {
          if (await reorderPlaylistTrackIdPagesById(playlist.id, lease.ids, insertion, signal))
            options.repairMessage.value = '已更新歌单顺序'
        })
      } else if (await reorderPlaylistTracks(playlist.name, selected, insertion)) {
        options.repairMessage.value = '已更新歌单顺序'
      }
    } catch (error) {
      options.repairMessage.value = describeError(error, '调整歌单顺序失败')
    }
  }

  function handleMoveSelectedToPlaylist(): void {
    const playlist = requireCurrentPlaylist()
    if (!playlist) return
    const choices = playlistMoveTargets.value
    if (!choices.length) {
      options.repairMessage.value = '请先创建目标歌单'
      return
    }
    if (options.streamingSelection?.enabled()) {
      moveSource = options.streamingSelection.capture()
      if (!moveSource.count) return
      playlistDialogError.value = ''
      playlistDialog.value = {
        kind: 'move',
        playlistId: playlist.id,
        initialValue: choices[0].id,
        trackIds: []
      }
      return
    }
    const trackIds = options.getSelectedTracks().map((track) => track.id)
    if (!trackIds.length) return
    playlistDialogError.value = ''
    playlistDialog.value = {
      kind: 'move',
      playlistId: playlist.id,
      initialValue: choices[0].id,
      trackIds
    }
  }

  async function handlePlaylistRepair(): Promise<void> {
    const playlist = requireCurrentPlaylist()
    if (!playlist || playlistRepairPending.value) return
    const targetId = playlist.id,
      targetName = playlist.name
    const assertTarget = () => {
      if (!playlists.value.some((item) => item.id === targetId && item.name === targetName))
        throw new Error('目标歌单已被重命名或删除，请重新修复')
    }
    playlistRepairPending.value = true
    try {
      const folder = await window.api.dialog.openFolder()
      if (!folder) return
      assertTarget()
      options.repairMessage.value = '正在扫描所选文件夹并检查缺失歌曲…'
      await repairPlaylistMissingTracksAsync(targetId, folder)
      options.repairMessage.value = '后台正在修复歌单，可在任务状态中查看结果'
    } catch (error) {
      options.repairMessage.value = describeError(error, '批量修复歌单文件失败')
    } finally {
      playlistRepairPending.value = false
    }
  }

  return {
    playlistImportInput,
    playlistCoverInput,
    playlistExportFormat,
    playlistRepairPending,
    playlistDialog,
    playlistDialogError,
    playlistMoveTargets,
    dismissPlaylistDialog,
    confirmPlaylistDialog,
    triggerPlaylistImport,
    handlePlaylistImport,
    downloadPlaylistDocument,
    triggerPlaylistCoverPicker,
    handlePlaylistCover,
    handleRenamePlaylist,
    handleCopyPlaylist,
    handleMoveSelectedWithinPlaylist,
    handlePlaylistDragStart,
    handlePlaylistDrop,
    handleMoveSelectedToPlaylist,
    handlePlaylistRepair
  }
}
