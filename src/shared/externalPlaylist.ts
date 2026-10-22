import type { TrackData } from './track.ts'

export const EXTERNAL_PLAYLIST_MAX_ENTRIES = 20_000
export const EXTERNAL_PLAYLIST_MAX_BYTES = 8 * 1024 * 1024
export type ImportPlatform = 'ncm' | 'qq' | 'kugou' | 'kuwo' | 'qishui' | 'bili' | 'ytm' | 'spotify' | 'apple' | 'tidal' | 'deezer'
export const IMPORT_PLATFORM_NAMES: Record<ImportPlatform, string> = {
  ncm: '网易云音乐', qq: 'QQ 音乐', kugou: '酷狗音乐', kuwo: '酷我音乐', qishui: '汽水音乐',
  bili: 'Bilibili', ytm: 'YouTube Music', spotify: 'Spotify', apple: 'Apple Music', tidal: 'TIDAL', deezer: 'Deezer'
}
export const IMPORT_PROVIDER_ALIASES: Partial<Record<ImportPlatform,string[]>> = {qq:['qqmusic','qq','com.twilightecho.provider.qqmusic'],kugou:['com.twilightecho.provider.kugou'],bili:['bilibili','bili'],ytm:['ytm','youtube-music','ytmusic']}
export function providerMatchesImportPlatform(provider:string,platform:ImportPlatform|undefined) {return !!platform&&(provider===platform||IMPORT_PROVIDER_ALIASES[platform]?.includes(provider)===true)}
export interface ImportSong {
  title?: string
  artist?: string
  album?: string
  duration?: number
  isrc?: string
  platform?: ImportPlatform
  platformId?: string
  cover?: string | null
  coverSource?: string | null
  coverSmall?: string | null
  coverSmallSource?: string | null
  /** Alternative locations belong to one occurrence, not several songs. */
  locations?: string[]
  unavailableReason?: string
}
export type ImportResolutionState = 'pending' | 'local' | 'streaming' | 'missing' | 'ambiguous' | 'login' | 'network' | 'rate-limit' | 'cancelled'
export interface ImportResolution {
  state: ImportResolutionState
  message?: string
  track?: TrackData
  checkedAt?: string
}
export interface ImportedPlaylistEntry {
  entryId: string
  position: number
  original: ImportSong
  resolution: ImportResolution
  manualBinding?: TrackData
  /** Incremented only by user edits, so in-flight work cannot undo a binding. */
  revision: number
}
export interface PlaylistImportDocument {
  name: string
  songs: ImportSong[]
  source: { kind: 'file' | 'platform'; label: string; platform?: ImportPlatform; playlistId?: string; url?: string }
  warnings: string[]
  complete: boolean
  total?: number
  /** For an Apple library export, user chooses a playlist instead of flattening it. */
  playlists?: Array<{ name: string; songs: ImportSong[] }>
  columns?: string[]
  table?: import('./playlistImportTable.ts').ImportTable
}
export interface ImportedPlaylistData {
  version: 1
  source: PlaylistImportDocument['source']
  entries: ImportedPlaylistEntry[]
  complete: boolean
  readError?: string
  expectedTotal?: number
  importedAt: string
  locallyEdited?: boolean
  /** Replaced by refresh; background tasks fence on this identity. */
  generation: string
  /** Refresh lineage survives local membership edits. Older documents use
   * generation until their first edit; a refresh starts a new lineage. */
  refreshGeneration?: string
  /** Membership-only revision; resolution updates do not rebuild SQL indexes. */
  membershipRevision: number
}
export function externalRefreshGeneration(data: ImportedPlaylistData): string {
  return data.refreshGeneration ?? data.generation
}
export interface PlaylistImportPage {
  name?: string
  songs: ImportSong[]
  total: number
  nextOffset: number
  hasMore: boolean
  nextCursor?: string
}
export interface PlaylistLink { platform: ImportPlatform; id: string; url: string }

export function isNeteaseShortLink(input: string): boolean {
  const normalized = input.trim().replace(/https\\:\/\//gi, 'https://')
  const raw = normalized.match(/https?:\/\/[^\s<>"，。]+/i)?.[0]
  if (!raw) return false
  try { return new URL(raw).hostname.toLowerCase() === '163cn.tv' } catch { return false }
}

export function recognizePlaylistLink(input: string): PlaylistLink {
  const normalized = input.trim().replace(/https\\:\/\//gi, 'https://')
  const raw = normalized.match(/https?:\/\/[^\s<>"，。]+/i)?.[0]
  if (!raw) throw new Error('请粘贴完整的歌单分享链接')
  const url = new URL(raw), host = url.hostname.toLowerCase()
  const route = new URL(url.hash.startsWith('#/') ? url.origin + url.hash.slice(1) : url.href)
  let platform: ImportPlatform | undefined, id: string | null | undefined
  if (host === 'music.163.com' || host === 'y.music.163.com') { platform = 'ncm'; id = route.searchParams.get('id'); if (!/playlist/.test(route.pathname)) id = null }
  else if (host === 'y.qq.com' || host === 'i.y.qq.com' || host === 'i2.y.qq.com') { platform = 'qq'; id = route.searchParams.get('id') || route.searchParams.get('disstid') || route.pathname.match(/playlist\/(\w+)/)?.[1] }
  else if (host === 'www.kugou.com' || host === 'm.kugou.com') { platform = 'kugou'; id = route.searchParams.get('specialid') || route.searchParams.get('id') || route.pathname.match(/special\/(\d+)/)?.[1] || route.pathname.match(/songlist\/(gcid_[\w.-]+)/i)?.[1] }
  else if (host === 'www.kuwo.cn' || host === 'm.kuwo.cn') { platform = 'kuwo'; id = route.pathname.match(/playlist(?:_detail)?\/(\d+)/)?.[1] || route.searchParams.get('pid') }
  else if (host === 'music.douyin.com' || host === 'www.qishui.com') { platform = 'qishui'; id = route.searchParams.get('playlist_id') || route.pathname.match(/playlist\/(\w+)/)?.[1] }
  else if (host === 'www.bilibili.com' || host === 'space.bilibili.com') { platform = 'bili'; id = route.searchParams.get('fid') || route.searchParams.get('media_id') || route.searchParams.get('mlid') || route.pathname.match(/\/list\/(?:ml)?(\d+)/)?.[1] }
  else if (host === 'music.youtube.com' || host === 'www.youtube.com') { platform = 'ytm'; id = route.searchParams.get('list') }
  else if (host === 'open.spotify.com') { platform = 'spotify'; id = route.pathname.match(/playlist\/([\w]+)/)?.[1] }
  else if (host === 'music.apple.com') { platform = 'apple'; id = route.pathname.match(/playlist\/(?:[^/]+\/)?([^/?]+)/)?.[1] }
  else if (host === 'tidal.com' || host === 'listen.tidal.com') { platform = 'tidal'; id = route.pathname.match(/playlist\/([\w-]+)/)?.[1] }
  else if (host === 'www.deezer.com' || host === 'deezer.com') { platform = 'deezer'; id = route.pathname.match(/playlist\/(\d+)/)?.[1] }
  if (!platform || !id || !/^[\w.-]{1,200}$/.test(id)) throw new Error('未识别到歌单 ID，请在平台中展开分享链接，或改用文件导入')
  return { platform, id, url: url.href }
}

export function importSongKey(song: ImportSong): string {
  return song.platform && song.platformId ? `${song.platform}:${song.platformId}` : JSON.stringify([song.locations ?? [], song.title ?? '', song.artist ?? '', song.album ?? '', song.duration ?? null])
}
/** Match occurrences FIFO, retaining duplicates and manual choices. */
export function reconcileImportEntries(before: ImportedPlaylistEntry[], songs: ImportSong[], identity: () => string): ImportedPlaylistEntry[] {
  const buckets = new Map<string, { entries: ImportedPlaylistEntry[]; next: number }>()
  for (const entry of before) {
    const key = importSongKey(entry.original)
    let bucket = buckets.get(key)
    if (!bucket) { bucket = { entries: [], next: 0 }; buckets.set(key, bucket) }
    bucket.entries.push(entry)
  }
  return songs.map((original, position) => {
    const bucket = buckets.get(importSongKey(original))
    const previous = bucket?.entries[bucket.next++]
    return previous ? { ...previous, original, position } : { entryId: identity(), original, position, revision: 0, resolution: { state: 'pending' } }
  })
}
export function previewImportUpdate(before: ImportedPlaylistEntry[], songs: ImportSong[]) {
  let i = 0
  const next = reconcileImportEntries(before, songs, () => `new:${i++}`)
  const ids = new Set(before.map(e => e.entryId)), kept = new Set(next.map(e => e.entryId))
  const retainedBefore = before.filter(e => kept.has(e.entryId))
  const retainedNext = next.filter(e => ids.has(e.entryId))
  return {
    added: next.length - retainedNext.length,
    removed: before.length - retainedBefore.length,
    reordered: retainedNext.some((entry, position) => entry.entryId !== retainedBefore[position]?.entryId)
  }
}

/** Projection DTO for SQL search/count/order. Never a playable Track. */
export function importEntryViewRecord(entry: ImportedPlaylistEntry) {
  return {
    id: entry.entryId, filePath: '', title: entry.original.title || entry.original.locations?.[0]?.split(/[\\/]/).at(-1) || '信息缺失',
    artist: entry.original.artist || '', album: entry.original.album || '', duration: entry.original.duration || 0,
    source: 'playlist-import',
    externalEntry: { entryId: entry.entryId, state: entry.resolution.state }, cover: null
  }
}
