import {
  LIBRARY_CACHE_PAGES,
  LIBRARY_MAX_PENDING_PAGE_READS,
  LIBRARY_PAGE_SIZE,
  type LibraryQuery
} from '../../../../shared/libraryDatabase.ts'

export interface LibraryResultPage {
  total: number
  revision: number
  offset: number
  anchorIndex?: number
}

type Request<P> = {
  generation: number
  page: number | null
  query: LibraryQuery
  resolve(value: P | null): void
  reject(error: unknown): void
}

/** Query windows are separate from the legacy complete-library store.
 * At most four detail pages (by default) and two requests are resident, including stale requests. */
export class LibraryResultPageCache<P extends LibraryResultPage> {
  private readonly readPage: (query: LibraryQuery) => Promise<P>
  private readonly itemCount: (page: P) => number
  private readonly validatePage?: (page: P, query: LibraryQuery) => void
  private query: LibraryQuery = {}
  private generation = 0
  private minimumRevision = 0
  private revision: number | null = null
  private total = 0
  private readonly pages = new Map<number, P>()
  private readonly requests = new Map<string, Promise<P | null>>()
  private readonly waiting: Request<P>[] = []
  private active = 0
  private disposed = false
  private readonly capacity: number

  constructor(
    options: {
      readPage(query: LibraryQuery): Promise<P>
      itemCount(page: P): number
      validatePage?(page: P, query: LibraryQuery): void
    },
    capacity = LIBRARY_CACHE_PAGES
  ) {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      capacity > Math.max(LIBRARY_CACHE_PAGES, LIBRARY_MAX_PENDING_PAGE_READS)
    )
      throw new Error('Invalid library page cache capacity')
    this.readPage = options.readPage
    this.itemCount = options.itemCount
    this.validatePage = options.validatePage
    this.capacity = capacity
  }

  setQuery(query: LibraryQuery): void {
    const { anchorId: _anchor, offset: _offset, limit: _limit, ...selection } = query
    this.query = structuredClone(selection)
    this.reset()
  }

  /** A committed scan batch invalidates visible windows, not a whole Track[] snapshot. */
  invalidate(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid library revision')
    if (revision <= Math.max(this.minimumRevision, this.revision ?? 0)) return
    this.minimumRevision = revision
    this.reset()
  }

  private reset(): void {
    this.generation++
    this.pages.clear()
    this.total = 0
    this.revision = null
    for (const request of this.waiting.splice(0)) request.resolve(null)
    // In-flight promises stay tracked until completion; resetting a search never
    // creates more transport slots or lets an old response overwrite the new one.
  }

  get state() {
    return {
      total: this.total,
      revision: this.revision,
      cachedPages: this.pages.size,
      cachedItems: [...this.pages.values()].reduce(
        (count, page) => count + this.itemCount(page),
        0
      ),
      activeRequests: this.active
    }
  }

  get pageCapacity(): number {
    return this.capacity
  }

  peek(page: number): P | undefined {
    return this.pages.get(page)
  }

  load(page: number): Promise<P | null> {
    if (!Number.isSafeInteger(page) || page < 0)
      return Promise.reject(new Error('Invalid library page'))
    if (this.disposed) return Promise.reject(new Error('Library page cache was disposed'))
    const cached = this.pages.get(page)
    if (cached) {
      this.pages.delete(page)
      this.pages.set(page, cached)
      return Promise.resolve(cached)
    }
    return this.request(page)
  }

  /** Uses the same transport slots and cache as normal reads, not a full ID export. */
  locate(id: string, fallbackPage = 0): Promise<P | null> {
    if (!id) return Promise.reject(new Error('Invalid library anchor'))
    if (!Number.isSafeInteger(fallbackPage) || fallbackPage < 0)
      return Promise.reject(new Error('Invalid library page'))
    if (this.disposed) return Promise.reject(new Error('Library page cache was disposed'))
    return this.request(null, id, fallbackPage)
  }

  private request(page: number | null, anchorId?: string, fallbackPage = 0): Promise<P | null> {
    const key = JSON.stringify([this.generation, page, anchorId, fallbackPage]),
      existing = this.requests.get(key)
    if (existing) return existing
    if (this.waiting.length >= LIBRARY_MAX_PENDING_PAGE_READS)
      return Promise.reject(new Error('Too many pending library pages'))
    const promise = new Promise<P | null>((resolve, reject) => {
      this.waiting.push({
        generation: this.generation,
        page,
        query: {
          ...this.query,
          offset: (page ?? fallbackPage) * LIBRARY_PAGE_SIZE,
          limit: LIBRARY_PAGE_SIZE,
          ...(anchorId !== undefined ? { anchorId } : {})
        },
        resolve,
        reject
      })
    })
    this.requests.set(key, promise)
    void promise.then(
      () => this.requests.delete(key),
      () => this.requests.delete(key)
    )
    this.pump()
    return promise
  }

  private pump(): void {
    while (!this.disposed && this.active < 2 && this.waiting.length) {
      const request = this.waiting.shift()!
      this.active++
      void this.fetch(request).finally(() => {
        this.active--
        this.pump()
      })
    }
  }

  private async fetch(request: Request<P>): Promise<void> {
    try {
      const page = await this.readPage(request.query)
      if (
        this.disposed ||
        request.generation !== this.generation ||
        page.revision < this.minimumRevision ||
        (this.revision !== null && page.revision < this.revision)
      ) {
        request.resolve(null)
        return
      }
      if (
        (request.page !== null && page.offset !== request.page * LIBRARY_PAGE_SIZE) ||
        !Number.isSafeInteger(page.offset) ||
        page.offset < 0 ||
        page.offset % LIBRARY_PAGE_SIZE !== 0 ||
        (request.page === null &&
          (!Number.isSafeInteger(page.anchorIndex) ||
            page.anchorIndex! < -1 ||
            page.anchorIndex! >= page.total ||
            (page.anchorIndex! >= 0 &&
              Math.floor(page.anchorIndex! / LIBRARY_PAGE_SIZE) * LIBRARY_PAGE_SIZE !==
                page.offset))) ||
        this.itemCount(page) > LIBRARY_PAGE_SIZE
      )
        throw new Error('Database returned an invalid library page')
      this.validatePage?.(page, request.query)
      if (
        !Number.isSafeInteger(page.total) ||
        page.total < 0 ||
        !Number.isSafeInteger(page.revision) ||
        page.revision < 0
      )
        throw new Error('Database returned an invalid result count or revision')
      if (this.revision !== null && page.revision > this.revision) this.reset()
      this.revision = page.revision
      this.total = page.total
      // An anchor belongs to this operation, not future ordinary page reads.
      const cachedPage = { ...page }
      delete cachedPage.anchorIndex
      this.pages.set(page.offset / LIBRARY_PAGE_SIZE, cachedPage)
      while (this.pages.size > this.capacity) this.pages.delete(this.pages.keys().next().value!)
      request.resolve(page)
    } catch (error) {
      if (request.generation !== this.generation || this.disposed) request.resolve(null)
      else request.reject(error)
    }
  }

  dispose(): void {
    this.disposed = true
    this.reset()
  }
}
