import { randomUUID } from '../../shared/portableCrypto.ts'
import {
  isCoreRequest,
  type CoreRequestEnvelope,
  type CoreQueries
} from '../../shared/coreProtocol.ts'
import type { RemoteLibraryRequest } from '../../shared/remoteLibrary.ts'
import type { CoreTrackView } from '../../shared/coreViews.ts'
import { parsePersonalMusicArtwork } from '../../shared/personalMusicArtwork.ts'

interface Envelope {
  kind: 'query' | 'command'
  name: string
  payload: Record<string, unknown>
  epoch: string
  requestId: string
  commandId?: string
}
const failure = (code = 'INVALID_REQUEST') => Object.assign(new Error('远程曲库请求无效'), { code })

/** Wire adaptation only. Core retains CAS, SQL selection and mutation ownership. */
export class RemoteLibraryBridge {
  private readonly members = new Map<
    string,
    { principal: string; playlist: string; revision: number; id: string; imported: boolean }
  >()
  private readonly options: {
    request: RemoteLibraryRequest
    track(track: CoreTrackView): Record<string, unknown>
    cover(handle: string | null): Promise<string | null>
  }
  constructor(options: RemoteLibraryBridge['options']) {
    this.options = options
  }
  clear() {
    this.members.clear()
  }

  async handle(env: Envelope, principal: string): Promise<unknown> {
    const candidate: unknown = {
      kind: env.kind,
      name: env.name,
      payload: env.payload,
      epoch: env.epoch,
      requestId: env.kind === 'command' ? (env.commandId ?? env.requestId) : env.requestId
    }
    if (!isCoreRequest(candidate)) throw failure()
    const raw = candidate
    if (raw.kind === 'query') {
      if (
        (raw.name === 'ratings.targets' || raw.name === 'preferences.targets') &&
        raw.payload.trackContext
      )
        throw failure() // A legacy Track context can be a host path. Use catalog entity IDs.
      if (raw.name === 'playlists.members' && raw.payload.anchorId) {
        const member = this.members.get(raw.payload.anchorId)
        if (
          !member ||
          member.principal !== principal ||
          member.playlist !== raw.payload.id ||
          member.revision !== raw.payload.revision
        )
          throw failure('STALE_REVISION')
        raw.payload = { ...raw.payload, anchorId: member.id }
      }
      const result = await this.options.request(principal, raw)
      if (raw.name === 'playlists.catalog') {
        const page = result as CoreQueries['playlists.catalog']['output']
        return {
          revision: page.revision,
          total: page.total,
          offset: page.offset,
          items: await Promise.all(
            page.items.map(async (row) => ({
              id: row.id,
              name: row.name,
              kind: row.kind,
              count: row.count,
              isDefault: row.isDefault,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              pinnedAt: row.pinnedAt,
              imported: !!row.imported,
              cover: await this.options.cover(row.cover ?? null)
            }))
          )
        }
      }
      if (raw.name === 'playlists.members') {
        // Anchor IDs have the same opaque membership contract as mutations.
        const page = result as CoreQueries['playlists.members']['output']
        return {
          revision: page.revision,
          total: page.total,
          offset: page.offset,
          items: page.items.map((row) => {
            const id = `remote-member:${randomUUID()}`
            this.members.set(id, {
              principal,
              playlist: raw.payload.id,
              revision: page.revision,
              id: row.id,
              imported: !!row.imported
            })
            if (this.members.size > 8192) this.members.delete(this.members.keys().next().value!)
            return {
              id,
              position: row.position,
              track: row.track ? this.options.track(row.track) : null,
              imported: !!row.imported
            }
          })
        }
      }
      return result
    }
    if (raw.name === 'playlists.edit') return this.editPlaylist(raw, principal)
    const result = await this.options.request(principal, raw)
    // Core's playlist result may contain its complete path-bearing snapshot.
    if (raw.name === 'playlists.addSources')
      return { revision: (result as { revision: number }).revision }
    // Metadata writes return detail through a separate bounded query projection.
    if (raw.name.startsWith('metadata.entity.')) return { entityId: env.payload.entityId }
    return result
  }

  private async editPlaylist(
    raw: Extract<CoreRequestEnvelope, { name: 'playlists.edit' }>,
    principal: string
  ) {
    const edit = structuredClone(raw.payload.edit)
    if (
      ![
        'create',
        'rename',
        'copy',
        'delete',
        'pin',
        'cover',
        'remove',
        'reorder',
        'move',
        'importRemove'
      ].includes(edit.kind)
    )
      throw failure()
    if (edit.kind === 'cover' && edit.cover !== null && !parsePersonalMusicArtwork(edit.cover))
      throw failure()
    if (
      edit.kind === 'remove' ||
      edit.kind === 'reorder' ||
      edit.kind === 'move' ||
      edit.kind === 'importRemove'
    ) {
      const ids = edit.kind === 'importRemove' ? edit.entryIds : edit.ids
      const resolve = (id: string) => {
        const member = this.members.get(id)
        if (
          !member ||
          member.principal !== principal ||
          member.playlist !== edit.id ||
          member.revision !== raw.payload.revision
        )
          throw failure('STALE_REVISION')
        if (member.imported !== (edit.kind === 'importRemove')) throw failure()
        return member.id
      }
      if (edit.kind === 'importRemove') edit.entryIds = ids.map(resolve)
      else edit.ids = ids.map(resolve)
    }
    const result = (await this.options.request(principal, {
      ...raw,
      payload: { ...raw.payload, edit }
    })) as { revision: number; result?: unknown }
    const created = edit.kind === 'create' || edit.kind === 'copy' ? result.result : undefined
    return { revision: result.revision, ...(typeof created === 'string' ? { id: created } : {}) }
  }
}
