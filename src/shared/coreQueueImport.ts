import type {
  LibraryQueueBuildCommand,
  LibraryQueueBuildReply,
  LibraryQueueSeedItem
} from './libraryQueueBuild.ts'

/** Private database capability for a legacy session upgrade. Ordinary queue
 * builders cannot choose persistent occurrence IDs or continue this namespace. */
export type CoreQueueImportCommand =
  | Exclude<LibraryQueueBuildCommand, { kind: 'append' }>
  | {
      kind: 'append'
      id: string
      sequence: number
      items: Array<LibraryQueueSeedItem & { occurrenceId: string }>
    }
export type CoreQueueImportReply = LibraryQueueBuildReply | { kind: 'retiring'; id: string }
export interface CoreQueueImportApi {
  importLegacyPlaybackQueue(command: CoreQueueImportCommand): Promise<CoreQueueImportReply>
}

/** The primary legacy identity stays compatible; additional sessions own separate import leases. */
export function legacyQueueImportOwner(id: string): string {
  const match = /^core-session-(?:(zone-[a-f0-9-]{36}|group-[a-f0-9-]{36})-)?[0-9]+$/.exec(id)
  if (!match) throw new Error('Invalid Core legacy queue import identity')
  return match[1] ? `core:legacy-import:${match[1]}` : 'core:legacy-import'
}
