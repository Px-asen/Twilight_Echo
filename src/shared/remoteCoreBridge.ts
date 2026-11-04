/** Authenticated LAN bridge capabilities, independent of the desktop's internal command table. */
import { REMOTE_LIBRARY_QUERIES, REMOTE_LIBRARY_COMMANDS } from './remoteLibrary.ts'
import { DSP_LIBRARY_QUERIES, DSP_LIBRARY_COMMANDS } from './dspLibrary.ts'
import { PLUGIN_MANAGEMENT_QUERIES, PLUGIN_MANAGEMENT_COMMANDS } from './pluginManagement.ts'
export const REMOTE_CORE_BRIDGE_VERSION = 1

/**
 * Wire protocol versions this desktop accepts. A client picks the highest version both sides list
 * ([negotiateRemoteProtocol]) and sends it on every request; a request outside the range is refused
 * with UNSUPPORTED_PROTOCOL instead of being misread.
 */
export const REMOTE_CORE_PROTOCOL_RANGE = { min: 1, max: 1 } as const

/**
 * Legacy requests keep their original local-session envelope. Multi-Zone calls
 * name their destination explicitly in a validated payload, never by silently
 * retargeting existing playback or library requests.
 */
export const REMOTE_CORE_LOCAL_ZONE = 'local'

export interface RemoteProtocolRange {
  min: number
  max: number
}

export function negotiateRemoteProtocol(client: RemoteProtocolRange, server: RemoteProtocolRange): number | null {
  const version = Math.min(client.max, server.max)
  return version >= Math.max(client.min, server.min) ? version : null
}
export const REMOTE_CORE_PAGE_LIMIT = 200
export const REMOTE_CORE_ARTWORK_LIMIT = 8

/** Transport facts supplied by the server, never by the RPC payload or proxy headers. */
export interface RemoteCoreRpcContext {
  encrypted: boolean
  /** This desktop's pairing identity; a request whose `targetId` names another computer is refused. */
  serverId?: string
}

export interface RemoteProviderSession {
  providerId: 'ncm'
  loggedIn: boolean
  cookie?: string
}

export const REMOTE_CORE_QUERIES = [
  ...PLUGIN_MANAGEMENT_QUERIES,
  ...DSP_LIBRARY_QUERIES,
  ...REMOTE_LIBRARY_QUERIES,
  'core.getSnapshot',
  'state.snapshot',
  'playback.getQueueWindow',
  'queue.page',
  'search.songs',
  'playlists.list',
  'catalog.query',
  'catalog.detail',
  'catalog.sources',
  'metadata.entity.detail',
  'library.artwork',
  'library.info',
  'lyrics.current',
  'lyrics.fetchOnline',
  'media.resolve',
  'media.lyrics',
  'providers.session'
  , 'zones.state', 'audio.dsp', 'audio.dsp.status', 'audio.signalPath'
  , 'zones.list', 'zones.dsp', 'zones.signalPath', 'groups.list', 'groups.signalPath'
  , 'zones.queue.page'
] as const

export const REMOTE_CORE_COMMANDS = [
  ...PLUGIN_MANAGEMENT_COMMANDS,
  ...DSP_LIBRARY_COMMANDS,
  ...REMOTE_LIBRARY_COMMANDS,
  'playback.play',
  'playback.pause',
  'playback.stop',
  'playback.seek',
  'playback.next',
  'playback.previous',
  'playback.setVolume',
  'playback.setPlayMode',
  'playback.selectQueueIndex',
  'playback.replaceQueue',
  'catalog.play'
  , 'zones.select', 'audio.dsp.edit'
  , 'zones.transport', 'zones.dsp.edit', 'zones.handoff'
  , 'groups.create', 'groups.remove', 'groups.transport', 'groups.queueFromQuery'
  , 'zones.queue.load', 'zones.queue.edit', 'zones.queue.select'
] as const
