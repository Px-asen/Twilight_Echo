import { ipcRenderer } from 'electron'
import { isQueueWorkspaceDocument } from '../../shared/queueWorkspace.ts'
import type { QueueWorkspaceDocument } from '../types'
import type { OnlineLyricsSearchResult } from '../../shared/lyricsManagement.ts'
import { isLyricsManagementDocument } from '../../shared/lyricsManagement.ts'
import { isPlaybackSession as validatePlaybackSession } from '../../shared/playbackSession.ts'
import type {
  LocalLibrarySnapshotInput,
  LocalMusicLibraryDocument,
  LyricsManagementDocument,
  PlaybackSession,
  VersionedDataEnvelope
} from '../types'
import { invokeVersionedDataWrite } from './versionedData.ts'

function isPlaybackSessionData(value: unknown): value is PlaybackSession | null {
  return value === null || isPlaybackSession(value)
}

function isPlaybackSession(value: unknown): value is PlaybackSession {
  return validatePlaybackSession(value)
}

export const dataApi = {
  chooseRestoreFolder: (): Promise<string | null> => ipcRenderer.invoke('data:chooseRestoreFolder'),
  exportPersonalBackup: (
    data: import('../../shared/personalBackup.ts').PersonalData
  ): Promise<boolean> => ipcRenderer.invoke('data:exportPersonalBackup', data),
  previewPersonalBackup: (
    data: import('../../shared/personalBackup.ts').PersonalData
  ): Promise<import('../../shared/personalBackup.ts').PersonalBackupPreview | null> =>
    ipcRenderer.invoke('data:previewPersonalBackup', data),
  stagePersonalRestore: (
    options: import('../../shared/personalBackup.ts').PersonalRestoreOptions
  ): Promise<void> => ipcRenderer.invoke('data:stagePersonalRestore', options),
  readRendererRestore: (): Promise<unknown> => ipcRenderer.invoke('data:readRendererRestore'),
  acknowledgeRendererRestore: (id: string): Promise<void> =>
    ipcRenderer.invoke('data:acknowledgeRendererRestore', id),
  loadQueueWorkspace: (): Promise<VersionedDataEnvelope<QueueWorkspaceDocument> | null> =>
    ipcRenderer.invoke('data:loadQueueWorkspace'),
  saveQueueWorkspace: (
    document: QueueWorkspaceDocument,
    expectedRevision: number
  ): Promise<VersionedDataEnvelope<QueueWorkspaceDocument>> =>
    invokeVersionedDataWrite(
      'data:saveQueueWorkspace',
      [document, expectedRevision],
      isQueueWorkspaceDocument
    ),
  saveMusicLibrary: (data: LocalLibrarySnapshotInput): Promise<LocalMusicLibraryDocument> =>
    ipcRenderer.invoke('data:saveMusicLibrary', data),
  loadMusicLibrary: (): Promise<LocalMusicLibraryDocument | unknown[]> =>
    ipcRenderer.invoke('data:loadMusicLibrary'),
  getCover: (handle: string, size?: 'sm' | 'md'): Promise<Uint8Array | string | null> =>
    size ? ipcRenderer.invoke('cover:get', handle, size) : ipcRenderer.invoke('cover:get', handle),
  cacheCover: (data: ArrayBuffer | Uint8Array): Promise<string | null> =>
    ipcRenderer.invoke('cover:cache', data),
  grantRemoteCover: (source: string): Promise<string> =>
    ipcRenderer.invoke('cover:grantRemote', source),
  getLyrics: (dir: string, fileName: string, filePath?: string): Promise<string | null> =>
    ipcRenderer.invoke('lyrics:get', dir, fileName, filePath),
  getTranslatedLyrics: (dir: string, fileName: string, filePath?: string): Promise<string | null> =>
    ipcRenderer.invoke('lyrics:getTranslated', dir, fileName, filePath),
  getRomanizedLyrics: (dir: string, fileName: string, filePath?: string): Promise<string | null> =>
    ipcRenderer.invoke('lyrics:getRomanized', dir, fileName, filePath),
  getAmlTtml: (songId: number): Promise<string | null> =>
    ipcRenderer.invoke('lyrics:getAmlTtml', songId),
  importLyrics: (): Promise<string | null> => ipcRenderer.invoke('lyrics:import'),
  saveLyrics: (contents: string): Promise<string | null> =>
    ipcRenderer.invoke('lyrics:save', contents),
  searchOnlineLyrics: (query: {
    title: string
    artist: string
    album?: string
    durationSeconds?: number
  }): Promise<OnlineLyricsSearchResult> => ipcRenderer.invoke('lyrics:searchOnline', query),
  saveLyricsManagement: (
    document: LyricsManagementDocument,
    expectedRevision: number
  ): Promise<VersionedDataEnvelope<LyricsManagementDocument>> =>
    invokeVersionedDataWrite(
      'data:saveLyricsManagement',
      [document, expectedRevision],
      isLyricsManagementDocument
    ),
  loadLyricsManagement: (): Promise<VersionedDataEnvelope<LyricsManagementDocument> | null> =>
    ipcRenderer.invoke('data:loadLyricsManagement'),
  loadPlaybackBookmarks: (): Promise<VersionedDataEnvelope<
    import('../../shared/playbackBookmarks.ts').PlaybackBookmarksDocument
  > | null> => ipcRenderer.invoke('data:loadPlaybackBookmarks'),
  savePlaybackBookmarks: (
    document: import('../../shared/playbackBookmarks.ts').PlaybackBookmarksDocument,
    expectedRevision: number
  ): Promise<
    VersionedDataEnvelope<import('../../shared/playbackBookmarks.ts').PlaybackBookmarksDocument>
  > =>
    invokeVersionedDataWrite(
      'data:savePlaybackBookmarks',
      [document, expectedRevision],
      (value): value is import('../../shared/playbackBookmarks.ts').PlaybackBookmarksDocument =>
        Boolean(value) && typeof value === 'object'
    ),
  savePlaybackSession: (
    session: PlaybackSession,
    expectedRevision: number
  ): Promise<VersionedDataEnvelope<PlaybackSession>> =>
    invokeVersionedDataWrite(
      'data:savePlaybackSession',
      [session, expectedRevision],
      isPlaybackSession
    ),
  loadPlaybackSession: (): Promise<VersionedDataEnvelope<PlaybackSession | null> | null> =>
    ipcRenderer.invoke('data:loadPlaybackSession'),
  clearPlaybackSession: (
    expectedRevision: number
  ): Promise<VersionedDataEnvelope<PlaybackSession | null>> =>
    invokeVersionedDataWrite(
      'data:clearPlaybackSession',
      [expectedRevision],
      isPlaybackSessionData
    ),
  savePlaylists: (
    playlists: unknown[],
    expectedRevision: number
  ): Promise<VersionedDataEnvelope<unknown[]>> =>
    invokeVersionedDataWrite('data:savePlaylists', [playlists, expectedRevision], Array.isArray),
  loadPlaylists: (): Promise<VersionedDataEnvelope<unknown[]> | null> =>
    ipcRenderer.invoke('data:loadPlaylists'),
  saveCookie: (cookie: string): Promise<void> => ipcRenderer.invoke('data:saveCookie', cookie),
  loadCookie: (): Promise<string> => ipcRenderer.invoke('data:loadCookie')
}

export const miniPlayerCoverDataApi = {
  getCover: (handle: string, size?: 'sm' | 'md'): Promise<Uint8Array | string | null> =>
    size ? ipcRenderer.invoke('cover:get', handle, size) : ipcRenderer.invoke('cover:get', handle),
  cacheCover: (data: ArrayBuffer | Uint8Array): Promise<string | null> =>
    ipcRenderer.invoke('cover:cache', data),
  grantRemoteCover: (source: string): Promise<string> =>
    ipcRenderer.invoke('cover:grantRemote', source)
}
