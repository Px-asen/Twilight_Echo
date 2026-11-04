import type { CoreCommands, CoreQueries, CoreRequestEnvelope } from './coreProtocol.ts'

/** Paired TLS clients edit the same library as the desktop. These public DTOs
 * contain catalog identities and revision fences, never host paths or TrackData. */
export const REMOTE_LIBRARY_QUERIES = [
  'focus.query',
  'focus.facets',
  'focus.saved.list',
  'focus.play.status',
  'tags.list',
  'tags.entity',
  'tags.members',
  'tags.recordings',
  'ratings.detail',
  'ratings.targets',
  'ratings.history',
  'preferences.detail',
  'preferences.targets',
  'preferences.history',
  'playlists.catalog',
  'playlists.members'
] as const satisfies readonly (keyof CoreQueries)[]

export const REMOTE_LIBRARY_COMMANDS = [
  'focus.saved.create',
  'focus.saved.rename',
  'focus.saved.update',
  'focus.saved.delete',
  'focus.play',
  'tags.create',
  'tags.rename',
  'tags.delete',
  'tags.member.set',
  'tags.play',
  'ratings.set',
  'preferences.set',
  'metadata.entity.override',
  'metadata.entity.sourcePreference',
  'metadata.entity.artworkOverride',
  'playlists.edit',
  'playlists.addSources'
] as const satisfies readonly (keyof CoreCommands)[]

export const isRemoteLibraryOperation = (name: string) =>
  ([...REMOTE_LIBRARY_QUERIES, ...REMOTE_LIBRARY_COMMANDS] as readonly string[]).includes(name)

export type RemoteLibraryRequest = (
  principal: string,
  request: CoreRequestEnvelope
) => Promise<unknown>

/** Playlist membership IDs are session references issued by playlists.members.
 * Stable source IDs for adding songs come from catalog.sources. */
export interface PlaylistSourceAppend {
  id: string
  revision: number
  catalogRevision: number
  sourceIds: string[]
}
