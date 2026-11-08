export type CoreServiceFactories<Services extends object> = {
  [Name in keyof Services]?: () => Promise<Services[Name]>
}

/** Optional features have one owner. Reading state never constructs that owner. */
export class CoreServiceRegistry<Services extends object> {
  private readonly loading = new Map<keyof Services, Promise<unknown>>()
  private closed = false
  private readonly owners: Partial<Services>
  private readonly factories: CoreServiceFactories<Services>

  constructor(owners: Partial<Services>, factories: CoreServiceFactories<Services> = {}) {
    this.owners = owners
    this.factories = factories
  }

  has<Name extends keyof Services>(name: Name): boolean {
    return this.owners[name] !== undefined || this.factories[name] !== undefined
  }

  async get<Name extends keyof Services>(
    name: Name,
    signal?: AbortSignal
  ): Promise<Services[Name] | undefined> {
    signal?.throwIfAborted()
    if (this.closed) throw new Error('Core services are shutting down')
    if (this.owners[name] !== undefined) return this.owners[name]
    const factory = this.factories[name]
    if (!factory) return undefined
    let loading = this.loading.get(name) as Promise<Services[Name]> | undefined
    if (!loading) {
      loading = Promise.resolve()
        .then(factory)
        .then((service) => {
          this.owners[name] = service
          return service
        })
      this.loading.set(name, loading)
      void loading
        .finally(() => {
          if (this.loading.get(name) === loading) this.loading.delete(name)
        })
        .catch(() => {})
    }
    const service = await loading
    signal?.throwIfAborted()
    if (this.closed) throw new Error('Core services are shutting down')
    return service
  }

  /** Wait for constructors before the caller drains their jobs and repositories. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.loading.values()])
  }
}
