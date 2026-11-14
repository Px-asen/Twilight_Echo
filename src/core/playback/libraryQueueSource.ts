import {
  LIBRARY_CACHE_PAGES,
  LIBRARY_MAX_PENDING_PAGE_READS,
  LIBRARY_PAGE_SIZE,
  type LibraryDatabaseApi,
  type LibraryQuery,
  type LibraryQueueEdit,
  type LibraryQueueEditResult,
  type LibraryQueuePage,
  type LibraryQueueSnapshot,
  type LibraryQueuePlaybackWindow
} from '../../shared/libraryDatabase.ts'
import type {
  CoreQueueSourceReplacement,
  CoreSourceRecoveryApi
} from '../../shared/coreSourceRecovery.ts'

/** Matches the preload seam; the array queue remains a separate player source. */
export interface LibraryQueueApi {
  replaceSource?: CoreSourceRecoveryApi['replacePlaybackQueueSource']
  extendQueue?: import('../../shared/corePersonalized.ts').CoreQueueExtensionApi['extendPlaybackQueue']
  buildQueue?: import('../../shared/libraryQueueBuild.ts').LibraryQueueBuildApi['buildQueue']
  createQueue: LibraryDatabaseApi['createLibraryQueue']
  getQueue: LibraryDatabaseApi['getLibraryQueue']
  readQueue: LibraryDatabaseApi['readLibraryQueue']
  editQueue: LibraryDatabaseApi['editLibraryQueue']
  deleteQueue: LibraryDatabaseApi['deleteLibraryQueue']
  /** Optional during the JSON-library transition; SQLite callers use it to
   * keep queue rows alive while this source owns the live cursor. */
  syncQueueReferences?: LibraryDatabaseApi['syncLibraryQueueReferences']
}
type PageRequest = {
  epoch: number
  queue: LibraryQueueSnapshot
  page: number
  resolve(value: LibraryQueuePage | null): void
  reject(error: unknown): void
}
type LibraryQueueUndoEntry = { revision: number; label: string }
export type LibraryPlaybackWindow = LibraryQueuePlaybackWindow

/** Frozen membership lives in SQLite. Only four 200-entry detail pages and two
 * read RPCs can be resident, even while the user replaces queues repeatedly. */
export class LibraryQueueSource {
  private readonly api: LibraryQueueApi
  private readonly referenceOwner = `playback:${crypto.randomUUID()}`
  private referenceTail: Promise<void> = Promise.resolve()
  private queue: LibraryQueueSnapshot | null = null
  private attachment = 0
  private epoch = 0
  private disposed = false
  private requiresRefresh = false
  private minimumLibraryRevision = 0
  private libraryRevision: number | null = null
  private readonly pages = new Map<number, LibraryQueuePage>()
  private readonly reads = new Map<string, Promise<LibraryQueuePage | null>>()
  private readonly waiting: PageRequest[] = []
  private activeReads = 0
  private pendingControls = 0
  private tail: Promise<unknown> = Promise.resolve()
  private undoStack: LibraryQueueUndoEntry[] = []

  constructor(api: LibraryQueueApi) {
    this.api = api
  }

  private syncReference(ids: string[]): Promise<void> {
    const sync = this.api.syncQueueReferences
    if (!sync) return Promise.resolve()
    const result = this.referenceTail.then(() => sync(this.referenceOwner, ids))
    this.referenceTail = result.catch(() => {})
    return result
  }

  get state() {
    return {
      queue: this.queue ? { ...this.queue } : null,
      requiresRefresh: this.requiresRefresh,
      libraryRevision: this.libraryRevision,
      cachedPages: this.pages.size,
      cachedTracks: [...this.pages.values()].reduce(
        (count, page) => count + page.items.filter((item) => item.track !== null).length,
        0
      ),
      activeReads: this.activeReads,
      pendingControls: this.pendingControls
    }
  }

  private resetPages(): void {
    this.epoch++
    this.pages.clear()
    this.libraryRevision = null
    for (const request of this.waiting.splice(0)) request.resolve(null)
    // Keep active requests counted until they settle: replacements cannot create
    // more transport slots or allow stale errors to affect the new source.
  }

  /** Detaching does not delete a queue that a persisted session may reference. */
  detach(): void {
    this.attachment++
    this.queue = null
    this.undoStack = []
    this.requiresRefresh = false
    this.resetPages()
    void this.syncReference([]).catch(() => {})
  }

  private control<T>(action: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Library queue source was disposed'))
    // Eight controls plus two reads fit inside the database's 16-request limit.
    if (this.pendingControls >= 8)
      return Promise.reject(new Error('Too many pending library queue actions'))
    this.pendingControls++
    const result = this.tail.then(action).finally(() => {
      this.pendingControls--
    })
    this.tail = result.catch(() => {})
    return result
  }

  private current(attachment: number): boolean {
    return !this.disposed && attachment === this.attachment
  }

  create(query: LibraryQuery, selectedId?: string): Promise<LibraryQueueSnapshot | null> {
    const input = structuredClone(query)
    if (this.disposed || this.pendingControls >= 8) return this.control(async () => null)
    this.detach()
    const attachment = this.attachment
    return this.control(async () => {
      if (!this.current(attachment)) return null
      const queue = await this.api.createQueue(input, selectedId)
      if (!this.current(attachment)) {
        // This newly-created queue was never exposed to a player or session.
        // Release it rather than leaking 300k occurrences on rapid double-click.
        await this.api.deleteQueue(queue.id, queue.revision)
        return null
      }
      try {
        await this.syncReference([queue.id])
      } catch (error) {
        await this.api.deleteQueue(queue.id, queue.revision).catch(() => {})
        throw error
      }
      if (!this.current(attachment)) {
        await this.syncReference([]).catch(() => {})
        await this.api.deleteQueue(queue.id, queue.revision).catch(() => {})
        return null
      }
      this.queue = queue
      return { ...queue }
    })
  }

  restore(id: string): Promise<LibraryQueueSnapshot | null> {
    if (this.disposed || this.pendingControls >= 8) return this.control(async () => null)
    this.detach()
    const attachment = this.attachment
    return this.control(async () => {
      if (!this.current(attachment)) return null
      const queue = await this.api.getQueue(id)
      if (!this.current(attachment)) return null
      await this.syncReference([queue.id])
      if (!this.current(attachment)) {
        await this.syncReference([]).catch(() => {})
        return null
      }
      this.queue = queue
      return { ...queue }
    })
  }

  refresh(): Promise<LibraryQueueSnapshot | null> {
    const attachment = this.attachment
    return this.control(async () => {
      if (!this.current(attachment) || !this.queue) return null
      const queue = await this.api.getQueue(this.queue.id)
      if (!this.current(attachment)) return null
      this.queue = queue
      this.requiresRefresh = false
      this.resetPages()
      return { ...queue }
    })
  }

  edit(
    edit: LibraryQueueEdit,
    options: { recordUndo?: boolean } = {}
  ): Promise<LibraryQueueEditResult | null> {
    const input = structuredClone(edit),
      attachment = this.attachment
    return this.control(async () => {
      if (!this.current(attachment) || !this.queue) return null
      if (this.requiresRefresh) throw new Error('Refresh the library queue before editing it')
      const previous = this.queue
      try {
        const result = await this.api.editQueue(previous.id, previous.revision, input)
        if (!this.current(attachment)) return null
        this.queue = result.queue
        if (previous.revision !== result.queue.revision) this.resetPages()
        if (previous.revision !== result.queue.revision) {
          if (edit.kind === 'undo') {
            // The caller pops the corresponding local entry after the CAS
            // succeeds; keeping older entries enables repeated undo.
          } else if (
            edit.kind === 'insert' ||
            edit.kind === 'remove' ||
            edit.kind === 'move' ||
            edit.kind === 'order' ||
            edit.kind === 'clear'
          ) {
            if (options.recordUndo !== false)
              this.undoStack = [
                ...this.undoStack,
                {
                  revision: result.queue.revision,
                  label: edit.kind === 'clear' ? '清空队列' : '队列操作'
                }
              ].slice(-20)
            else this.undoStack = []
          } else this.undoStack = []
        }
        return { ...result, queue: { ...result.queue } }
      } catch (error) {
        if (this.current(attachment)) {
          // A timeout or worker crash may have committed. Never replay the edit;
          // require an authoritative refresh before the next explicit command.
          this.requiresRefresh = true
          this.resetPages()
        }
        throw error
      }
    })
  }

  get canUndo(): boolean {
    return !!this.queue && !this.requiresRefresh && (this.queue.canUndo ?? this.undoStack.length > 0)
  }
  /** A source repair changes metadata for one occurrence, not queue membership.
   * Retain a valid undo chain, but never resurrect an already invalid one. */
  replaceSource(command: CoreQueueSourceReplacement): Promise<LibraryQueueSnapshot | null> {
    const attachment = this.attachment
    return this.control(async () => {
      if (!this.current(attachment) || !this.queue) return null
      if (!this.api.replaceSource) throw new Error('Playback source repair is unavailable')
      if (this.requiresRefresh) throw new Error('Refresh the library queue before repairing it')
      if (this.queue.id !== command.queue.id || this.queue.revision !== command.queue.revision)
        throw new Error('Playback queue changed during source preparation')
      try {
        const repaired = await this.api.replaceSource(command)
        if (!this.current(attachment)) return null
        const undo = this.undoStack.at(-1)
        if (undo?.revision === command.queue.revision) undo.revision = repaired.revision
        this.queue = repaired
        this.resetPages()
        return { ...repaired }
      } catch (error) {
        if (this.current(attachment)) {
          this.requiresRefresh = true
          this.resetPages()
        }
        throw error
      }
    })
  }
  extend(
    items: import('../../shared/libraryDatabase.ts').LibraryQueueInsertItem[]
  ): Promise<LibraryQueueEditResult | null> {
    const input = structuredClone(items),
      attachment = this.attachment
    return this.control(async () => {
      if (!this.current(attachment) || !this.queue) return null
      if (!this.api.extendQueue) throw new Error('Automatic queue extensions are unavailable')
      if (this.requiresRefresh) throw new Error('Refresh the library queue before extending it')
      try {
        const result = await this.api.extendQueue(this.queue.id, this.queue.revision, input)
        if (!this.current(attachment)) return null
        this.queue = result.queue
        this.undoStack = []
        this.resetPages()
        return result
      } catch (error) {
        if (this.current(attachment)) {
          this.requiresRefresh = true
          this.resetPages()
        }
        throw error
      }
    })
  }

  get undoLabel(): string {
    return this.queue?.undoLabel ?? this.undoStack.at(-1)?.label ?? ''
  }

  undo(expectedRevision = this.queue?.revision ?? -1): Promise<LibraryQueueEditResult | null> {
    if (!this.canUndo || this.queue?.revision !== expectedRevision ||
      (this.queue.canUndo === undefined && this.undoStack.at(-1)?.revision !== expectedRevision))
      return Promise.resolve(null)
    return this.edit({ kind: 'undo' }).then((result) => {
      if (result) {
        this.undoStack = this.undoStack.slice(0, -1)
        const previous = this.undoStack.at(-1)
        if (previous) previous.revision = result.queue.revision
      }
      return result
    })
  }

  /** Call only after the replacement session has durably stopped referencing it. */
  delete(): Promise<boolean> {
    const attachment = this.attachment
    return this.control(async () => {
      if (!this.current(attachment) || !this.queue) return false
      if (this.requiresRefresh) throw new Error('Refresh the library queue before deleting it')
      try {
        await this.syncReference([])
        await this.api.deleteQueue(this.queue.id, this.queue.revision)
        if (this.current(attachment)) this.detach()
        return true
      } catch (error) {
        if (this.current(attachment)) {
          // The delete may be rejected by a durable session/workspace owner.
          // Restore the live owner before exposing the failed source again so
          // later GC cannot retire a queue that is still attached here.
          await this.syncReference(this.queue ? [this.queue.id] : []).catch(() => {})
          this.requiresRefresh = true
          this.resetPages()
        }
        throw error
      }
    })
  }

  invalidateLibrary(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid library revision')
    if (revision <= Math.max(this.minimumLibraryRevision, this.libraryRevision ?? 0)) return
    this.minimumLibraryRevision = revision
    // Queue membership/order does not change when tags or scan results change.
    this.resetPages()
  }

  loadPage(page: number): Promise<LibraryQueuePage | null> {
    if (!Number.isSafeInteger(page) || page < 0)
      return Promise.reject(new Error('Invalid library queue page'))
    if (this.disposed) return Promise.reject(new Error('Library queue source was disposed'))
    if (this.requiresRefresh)
      return Promise.reject(new Error('Refresh the library queue before reading it'))
    if (!this.queue) return Promise.resolve(null)
    const cached = this.pages.get(page)
    if (cached) {
      this.pages.delete(page)
      this.pages.set(page, cached)
      return Promise.resolve(cached)
    }
    const key = `${this.epoch}:${page}`,
      existing = this.reads.get(key)
    if (existing) return existing
    if (this.waiting.length >= LIBRARY_MAX_PENDING_PAGE_READS)
      return Promise.reject(new Error('Too many pending library queue pages'))
    const promise = new Promise<LibraryQueuePage | null>((resolve, reject) => {
      this.waiting.push({ epoch: this.epoch, queue: { ...this.queue! }, page, resolve, reject })
    })
    this.reads.set(key, promise)
    void promise.then(
      () => this.reads.delete(key),
      () => this.reads.delete(key)
    )
    this.pump()
    return promise
  }

  private pump(): void {
    while (!this.disposed && this.activeReads < 2 && this.waiting.length) {
      const request = this.waiting.shift()!
      this.activeReads++
      void this.fetch(request).finally(() => {
        this.activeReads--
        this.pump()
      })
    }
  }

  private async fetch(request: PageRequest): Promise<void> {
    try {
      const page = await this.api.readQueue(
        request.queue.id,
        request.page * LIBRARY_PAGE_SIZE,
        LIBRARY_PAGE_SIZE
      )
      if (this.disposed || request.epoch !== this.epoch) {
        request.resolve(null)
        return
      }
      if (page.revision !== request.queue.revision) {
        // Another owner edited this queue. Do not combine the new order with an
        // old cursor or silently let an outstanding read overwrite an edit.
        if (page.revision > request.queue.revision) {
          this.requiresRefresh = true
          this.resetPages()
        }
        request.resolve(null)
        return
      }
      if (page.libraryRevision < Math.max(this.minimumLibraryRevision, this.libraryRevision ?? 0)) {
        request.resolve(null)
        return
      }
      const offset = request.page * LIBRARY_PAGE_SIZE
      if (
        page.offset !== offset ||
        page.total !== request.queue.total ||
        page.items.length !== Math.max(0, Math.min(LIBRARY_PAGE_SIZE, page.total - offset)) ||
        page.items.some((item, i) => item.position !== offset + i)
      )
        throw new Error('Database returned an invalid library queue page')
      if (this.libraryRevision !== null && page.libraryRevision > this.libraryRevision)
        this.resetPages()
      this.libraryRevision = page.libraryRevision
      this.pages.set(request.page, page)
      while (this.pages.size > LIBRARY_CACHE_PAGES)
        this.pages.delete(this.pages.keys().next().value!)
      request.resolve(page)
    } catch (error) {
      if (request.epoch !== this.epoch || this.disposed) request.resolve(null)
      else request.reject(error)
    }
  }

  /** Fetch the selected occurrence plus an immediate successor for native CUE
   * handoff. Holes stay in the queue; navigation skips them inside SQL. At most
   * two detail pages are read, never a walk over an arbitrarily large hole. */
  async playbackWindow(
    options: { repeat?: boolean; wrap?: boolean } = {}
  ): Promise<LibraryPlaybackWindow | null> {
    const queue = this.queue ? { ...this.queue } : null,
      attachment = this.attachment
    if (!queue || queue.index < 0) return null
    const pageNumber = Math.floor(queue.index / LIBRARY_PAGE_SIZE)
    const first = await this.loadPage(pageNumber)
    if (!first || !this.current(attachment) || this.queue?.revision !== queue.revision) return null
    const current = first.items[queue.index % LIBRARY_PAGE_SIZE]
    if (!current?.track || current.queueEntryId !== queue.selectedEntryId) return null
    let next = !options.repeat
      ? first.items.find((item) => item.position > queue.index && item.track)
      : undefined
    const libraryRevision = first.libraryRevision
    if (!options.repeat && !next) {
      const nextPage =
        (pageNumber + 1) * LIBRARY_PAGE_SIZE < queue.total ? pageNumber + 1 : options.wrap ? 0 : -1
      if (nextPage >= 0) {
        const page = nextPage === pageNumber ? first : await this.loadPage(nextPage)
        if (!page || page.libraryRevision !== libraryRevision) return null
        next = page.items.find((item) => item.queueEntryId !== current.queueEntryId && item.track)
      }
    }
    if (
      !this.current(attachment) ||
      this.queue?.revision !== queue.revision ||
      libraryRevision < this.minimumLibraryRevision ||
      libraryRevision !== this.libraryRevision
    )
      return null
    return {
      queue,
      libraryRevision,
      lastPlayablePosition: first.lastPlayablePosition,
      items: next ? [current, next] : [current]
    }
  }

  dispose(): void {
    this.disposed = true
    this.detach()
  }
}
