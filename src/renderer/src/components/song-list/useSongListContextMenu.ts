import {
  computed,
  getCurrentInstance,
  onMounted,
  onUnmounted,
  ref,
  type ComputedRef,
  type Ref
} from 'vue'
import type { Track } from '../../types/music'
import type { PlaylistActions } from './types'

type UseSongListContextMenuOptions = PlaylistActions & {
  currentPlaylistName: ComputedRef<string | null>
}

export function useSongListContextMenu({
  currentPlaylistName,
  removeTrack,
  addToPlaylist,
  removeFromPlaylist,
  rematchTrack,
  rematchMetadata,
  clearMetadataMatch,
  createPlaylist,
  deletePlaylist,
  playNext,
  viewArtist,
  viewAlbum,
  addToAggregatePlaylist,
  createAggregatePlaylist
}: UseSongListContextMenuOptions): {
  showContextMenu: Ref<boolean>
  menuX: Ref<number>
  menuY: Ref<number>
  selectedTrack: Ref<Track | null>
  canViewSelectedContext: ComputedRef<boolean>
  canPlayNextSelectedTrack: ComputedRef<boolean>
  handlePlayNext: () => void
  handleViewArtist: () => void
  handleViewAlbum: () => void
  showPlaylistSubmenu: Ref<boolean>
  showCreatePlaylistDialog: Ref<boolean>
  newPlaylistName: Ref<string>
  onContextMenu: (event: MouseEvent, track: Track) => void
  closeContextMenu: () => void
  handleDelete: () => void
  handleOpenFolder: () => Promise<void>
  handleAddToPlaylist: (playlistName: string) => void
  handleRemoveFromCurrentPlaylist: () => void
  canRematchSelectedTrack: ComputedRef<boolean>
  handleRematchTrack: () => Promise<void>
  canRematchMetadataSelectedTrack: ComputedRef<boolean>
  handleRematchMetadata: () => Promise<void>
  canClearMetadataMatchSelectedTrack: ComputedRef<boolean>
  handleClearMetadataMatch: () => Promise<void>
  openCreatePlaylistDialog: (track?: Track) => void
  handleCreatePlaylist: () => void
  completeCreatePlaylistDialog: () => void
  handleCreatePlaylistFromMenu: () => void
  handleDeletePlaylist: (playlistId: string, event: MouseEvent | KeyboardEvent) => void
  showAggregateSubmenu: Ref<boolean>
  handleAddToAggregatePlaylist: (playlistId: string) => void
  handleCreateAggregatePlaylistFromMenu: () => void
} {
  const showContextMenu = ref(false)
  const menuX = ref(0)
  const menuY = ref(0)
  const selectedTrack = ref<Track | null>(null)
  const showPlaylistSubmenu = ref(false)
  const showAggregateSubmenu = ref(false)
  const showCreatePlaylistDialog = ref(false)
  const newPlaylistName = ref('')
  const createPlaylistForTrack = ref<Track | null>(null)
  const canRematchSelectedTrack = computed(() => {
    const track = selectedTrack.value
    if (!track || !rematchTrack) return false
    return getTrackSource(track) !== 'local'
  })
  const canRematchMetadataSelectedTrack = computed(() => {
    const track = selectedTrack.value
    if (!track || !rematchMetadata) return false
    return getTrackSource(track) === 'local'
  })
  const canClearMetadataMatchSelectedTrack = computed(() => {
    const track = selectedTrack.value
    if (!track || !clearMetadataMatch || !track.metadataMatch) return false
    return getTrackSource(track) === 'local'
  })
  const canViewSelectedContext = computed(() => {
    const track = selectedTrack.value
    return !!track && (!!viewArtist || !!viewAlbum)
  })
  const canPlayNextSelectedTrack = computed(() => !!selectedTrack.value && !!playNext)

  function onContextMenu(event: MouseEvent, track: Track): void {
    event.preventDefault()
    selectedTrack.value = track
    menuX.value = event.clientX
    menuY.value = event.clientY
    showContextMenu.value = true
    showPlaylistSubmenu.value = false
    showAggregateSubmenu.value = false
  }

  function closeContextMenu(): void {
    showContextMenu.value = false
    showPlaylistSubmenu.value = false
    showAggregateSubmenu.value = false
    selectedTrack.value = null
  }

  function handleAddToAggregatePlaylist(playlistId: string): void {
    if (!addToAggregatePlaylist) return
    addToAggregatePlaylist(playlistId)
    closeContextMenu()
  }

  function handleCreateAggregatePlaylistFromMenu(): void {
    if (!createAggregatePlaylist) return
    createAggregatePlaylist()
    closeContextMenu()
  }

  function handleDelete(): void {
    if (selectedTrack.value) {
      removeTrack(selectedTrack.value.id)
      closeContextMenu()
    }
  }

  async function handleOpenFolder(): Promise<void> {
    if (selectedTrack.value) {
      await window.api.shell.showItemInFolder(selectedTrack.value.filePath)
      closeContextMenu()
    }
  }

  function handleAddToPlaylist(playlistName: string): void {
    if (selectedTrack.value) {
      addToPlaylist(playlistName, selectedTrack.value.id, selectedTrack.value)
      closeContextMenu()
    }
  }

  function handleRemoveFromCurrentPlaylist(): void {
    const playlistName = currentPlaylistName.value
    if (!playlistName || !selectedTrack.value) return
    removeFromPlaylist(playlistName, selectedTrack.value.id)
    closeContextMenu()
  }

  async function handleRematchTrack(): Promise<void> {
    if (!selectedTrack.value || !canRematchSelectedTrack.value || !rematchTrack) return
    await rematchTrack(selectedTrack.value)
    closeContextMenu()
  }

  async function handleRematchMetadata(): Promise<void> {
    if (!selectedTrack.value || !canRematchMetadataSelectedTrack.value || !rematchMetadata) return
    await rematchMetadata(selectedTrack.value)
    closeContextMenu()
  }

  async function handleClearMetadataMatch(): Promise<void> {
    if (!selectedTrack.value || !canClearMetadataMatchSelectedTrack.value || !clearMetadataMatch)
      return
    await clearMetadataMatch(selectedTrack.value)
    closeContextMenu()
  }

  function openCreatePlaylistDialog(track?: Track): void {
    createPlaylistForTrack.value = track ?? null
    newPlaylistName.value = ''
    showCreatePlaylistDialog.value = true
    closeContextMenu()
  }

  function handleCreatePlaylist(): void {
    const name = newPlaylistName.value.trim()
    if (!name) return
    createPlaylist(name)
    if (createPlaylistForTrack.value) {
      addToPlaylist(name, createPlaylistForTrack.value.id, createPlaylistForTrack.value)
    }
    completeCreatePlaylistDialog()
  }

  function completeCreatePlaylistDialog(): void {
    showCreatePlaylistDialog.value = false
    createPlaylistForTrack.value = null
    newPlaylistName.value = ''
  }

  function handleCreatePlaylistFromMenu(): void {
    openCreatePlaylistDialog(selectedTrack.value ?? undefined)
  }

  function handleDeletePlaylist(playlistId: string, event: MouseEvent | KeyboardEvent): void {
    event.stopPropagation()
    deletePlaylist(playlistId)
  }

  function handlePlayNext(): void {
    const track = selectedTrack.value
    if (!track || !playNext) return
    playNext(track)
    closeContextMenu()
  }

  function handleViewArtist(): void {
    const track = selectedTrack.value
    if (!track || !viewArtist) return
    viewArtist(track)
    closeContextMenu()
  }

  function handleViewAlbum(): void {
    const track = selectedTrack.value
    if (!track || !viewAlbum) return
    viewAlbum(track)
    closeContextMenu()
  }

  if (getCurrentInstance()) {
    onMounted(() => {
      window.addEventListener('click', closeContextMenu)
    })

    onUnmounted(() => {
      window.removeEventListener('click', closeContextMenu)
    })
  }

  return {
    showContextMenu,
    menuX,
    menuY,
    selectedTrack,
    canViewSelectedContext,
    canPlayNextSelectedTrack,
    handlePlayNext,
    handleViewArtist,
    handleViewAlbum,
    showPlaylistSubmenu,
    showCreatePlaylistDialog,
    newPlaylistName,
    onContextMenu,
    closeContextMenu,
    handleDelete,
    handleOpenFolder,
    handleAddToPlaylist,
    handleRemoveFromCurrentPlaylist,
    canRematchSelectedTrack,
    handleRematchTrack,
    canRematchMetadataSelectedTrack,
    handleRematchMetadata,
    canClearMetadataMatchSelectedTrack,
    handleClearMetadataMatch,
    openCreatePlaylistDialog,
    handleCreatePlaylist,
    completeCreatePlaylistDialog,
    handleCreatePlaylistFromMenu,
    handleDeletePlaylist,
    showAggregateSubmenu,
    handleAddToAggregatePlaylist,
    handleCreateAggregatePlaylistFromMenu
  }
}

function getTrackSource(track: Pick<Track, 'id' | 'source'>): string {
  if (track.source) return track.source
  if (/^[a-zA-Z]:[\\/]/.test(track.id) || /^[\\/]/.test(track.id)) return 'local'
  const separatorIndex = track.id.indexOf(':')
  return separatorIndex > 0 ? track.id.slice(0, separatorIndex) : 'local'
}
