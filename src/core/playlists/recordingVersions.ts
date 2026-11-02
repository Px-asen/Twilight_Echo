import { createLogicalTrackModel } from '../../shared/logicalTrackModel.ts'
import {
  emptyMusicVersions,
  editMusicVersions,
  parseMusicVersions,
  type MusicVersionsDocument,
  type MusicVersion
} from '../../shared/musicVersions.ts'
import type { CoreStateApi } from '../../shared/coreState.ts'
import type {
  CoreVersionsApi,
  CoreVersionsEdit,
  CoreVersionsQuery,
  CoreVersionsPage
} from '../../shared/coreVersions.ts'

/** Recording rules use the migrated repository, not a renderer's lazy browser index. */
export class CoreRecordingVersions {
  private revision = 0
  private document = emptyMusicVersions()
  private readonly tracks = new Map<string, MusicVersion>()
  readonly identity = createLogicalTrackModel((key) => this.tracks.get(key))
  private tail: Promise<unknown> = Promise.resolve()
  private uncertain = false
  private readonly database: Pick<CoreStateApi, 'coreStateRead'> & CoreVersionsApi
  private readonly changed: () => void
  private readonly newId: () => string
  constructor(
    database: Pick<CoreStateApi, 'coreStateRead'> & CoreVersionsApi,
    changed: () => void = () => {},
    newId: () => string = () => crypto.randomUUID()
  ) {
    this.database = database
    this.changed = changed
    this.newId = newId
  }
  getRevision(): number {
    return this.revision
  }
  async initialize(): Promise<void> {
    const next = emptyMusicVersions()
    let after: string | undefined, revision: number | undefined
    do {
      const page = await this.database.coreStateRead('versions', after, 128, revision)
      revision = page.revision
      for (const row of page.rows) {
        const [scope, kind] = row.key.split(':') as ['tracks' | 'albums', 'versions' | 'families']
        ;(next[scope][kind] as unknown[]).push(row.value)
      }
      after = page.next ?? undefined
    } while (after !== undefined)
    this.adopt(parseMusicVersions(JSON.stringify(next)), revision!)
    this.uncertain = false
  }
  private adopt(next: MusicVersionsDocument, revision: number): void {
    this.document = next
    this.revision = revision
    this.tracks.clear()
    for (const version of this.document.tracks.versions)
      for (const source of version.sources) this.tracks.set(source, version)
  }
  snapshot(): MusicVersionsDocument {
    return structuredClone(this.document)
  }
  readonlySnapshot(): Readonly<MusicVersionsDocument> {
    return this.document
  }
  private fence(revision: number): void {
    if (revision !== this.revision)
      throw Object.assign(new Error('版本记录已变化，请重新预览'), { code: 'STALE_REVISION' })
  }
  async page(query: CoreVersionsQuery): Promise<CoreVersionsPage> {
    if (this.uncertain) await this.initialize()
    this.fence(query.revision)
    const items = this.document[query.scope][query.kind],
      offset = query.offset ?? 0
    return structuredClone({
      revision: this.revision,
      total: items.length,
      offset,
      items: items.slice(offset, offset + (query.limit ?? 128))
    })
  }
  edit(edit: CoreVersionsEdit, signal?: AbortSignal): Promise<{ revision: number }> {
    const work = this.tail
      .catch(() => undefined)
      .then(async () => {
        signal?.throwIfAborted()
        if (this.uncertain) await this.initialize()
        this.fence(edit.revision)
        const next = editMusicVersions(
          this.document,
          edit.scope,
          edit.operation,
          edit.keys,
          edit.label,
          this.newId
        )
        try {
          const revision = await this.database.coreVersionsReplace(next, this.revision)
          this.adopt(next, revision)
          this.changed()
          return { revision }
        } catch (error) {
          // Resolve the durable outcome by reading, never by repeating a write.
          this.uncertain = true
          await this.initialize()
          this.changed()
          throw error
        }
      })
    this.tail = work
    return work
  }
  async flush(): Promise<void> {
    await this.tail.catch(() => undefined)
    if (this.uncertain) await this.initialize()
  }
}
