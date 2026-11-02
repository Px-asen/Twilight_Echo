import type { BridgePeer, BridgeRuntimeState } from '../../shared/audioBridge.ts'
import { MAX_CORE_ZONES, type ZoneDescriptor, type ZonesView, type ZoneTransport } from '../../shared/coreZones.ts'
import type { CoreDspService } from '../audio/dspService.ts'
import type { CoreDspEdit } from '../../shared/coreDsp.ts'
import type { CorePlaybackSession } from './session.ts'
import type { LibraryQuery } from '../../shared/libraryDatabase.ts'

export interface ZoneRuntime {
  playback: CorePlaybackSession
  dsp: Pick<CoreDspService, 'state' | 'status' | 'edit'>
  output(): Promise<BridgeRuntimeState>
  connect(peer: BridgePeer): Promise<void>
  sources(): string[]
  close(): Promise<void>
}
interface ZoneOwner { descriptor: ZoneDescriptor; runtime: ZoneRuntime | null; revision: number; error: string | null }
const fail = (code: string, message: string) => Object.assign(new Error(message), { code })

/** Registry owns topology; every session retains its own transport/configuration
 * lanes. A slow Play in one zone must never queue another zone's Pause/Stop. */
export class CoreZoneRegistry {
  private readonly owners = new Map<string, ZoneOwner>()
  private revision = 0
  private topology = Promise.resolve()
  private stopped = false
  private catalogError: string | null = null
  private readonly options: {
    local: ZoneRuntime
    load(): Promise<ZoneDescriptor[]>
    save(zones: ZoneDescriptor[]): Promise<void>
    create(zone: ZoneDescriptor): Promise<ZoneRuntime>
    newId(): string
    changed(): void
  }
  constructor(options: CoreZoneRegistry['options']) {
    this.options = options
    this.owners.set('local', { descriptor: { id: 'local', name: '此电脑主会话' }, runtime: options.local, revision: 0, error: null })
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const work = this.topology.then(action)
    this.topology = work.then(() => {}, () => {})
    return work
  }
  private owner(id: string): ZoneOwner {
    if (this.stopped) throw fail('NOT_READY', 'Zone 正在关闭')
    const zone = this.owners.get(id)
    if (!zone) throw fail('INVALID_REQUEST', 'Zone 不存在，请刷新')
    return zone
  }
  private runtime(id: string): ZoneRuntime {
    const owner = this.owner(id)
    if (!owner.runtime) throw fail('NOT_READY', owner.error ?? 'Zone 尚未就绪')
    return owner.runtime
  }
  private descriptors(): ZoneDescriptor[] { return [...this.owners.values()].filter(z => z.descriptor.id !== 'local').map(z => z.descriptor) }
  async initialize(): Promise<void> {
    let descriptors: ZoneDescriptor[]
    try { descriptors = await this.options.load() }
    catch { this.catalogError = 'Zone 清单无法读取；主会话可用，新增／移除已隔离，请修复清单后重启 Core'; return }
    for (const descriptor of descriptors) {
      const owner: ZoneOwner = { descriptor, runtime: null, revision: 0, error: null }
      this.owners.set(descriptor.id, owner)
      try { owner.runtime = await this.options.create(descriptor) }
      catch { owner.error = '此 Zone 初始化失败；请明确重连或移除，不影响其他 Zone' }
    }
  }
  async list(): Promise<ZonesView> {
    const zones = await Promise.all([...this.owners.values()].map(async owner => {
      const snapshot = owner.runtime?.playback.snapshot()
      let output: BridgeRuntimeState | null = null
      let error = owner.error ?? snapshot?.error ?? null
      try { output = await owner.runtime?.output() ?? null }
      catch { error = '此 Zone 音频服务不可用，未切换到其他输出' }
      return { ...owner.descriptor, revision: owner.revision, playback: snapshot?.playback ?? null,
        track: snapshot?.track ?? null, queue: snapshot?.queue ?? null, output, error: error ?? output?.error ?? null }
    }))
    return { revision: this.revision, limit: MAX_CORE_ZONES, zones, error: this.catalogError }
  }
  create(name: string, revision: number): Promise<string> {
    return this.serialize(async () => {
      if (this.stopped) throw fail('NOT_READY', 'Zone 正在关闭')
      if (this.catalogError) throw fail('NOT_READY', this.catalogError)
      if (revision !== this.revision) throw fail('STALE_REVISION', 'Zone 列表已变化，请刷新')
      if (this.owners.size >= MAX_CORE_ZONES) throw fail('BUSY', '已达到当前 Core 的 Zone 数量上限')
      const descriptor = { id: `zone-${this.options.newId()}`, name: name.trim() }
      const runtime = await this.options.create(descriptor)
      try { await this.options.save([...this.descriptors(), descriptor]) }
      catch (error) { await runtime.close(); throw error }
      this.owners.set(descriptor.id, { descriptor, runtime, revision: 0, error: null })
      ++this.revision; this.options.changed()
      return descriptor.id
    })
  }
  remove(id: string, revision: number): Promise<void> {
    return this.serialize(async () => {
      if (id === 'local') throw fail('FORBIDDEN', '主会话不能移除')
      if (revision !== this.revision) throw fail('STALE_REVISION', 'Zone 列表已变化，请刷新')
      const owner = this.owner(id)
      await owner.runtime?.close()
      // A failed catalog commit leaves an offline, retryable owner, not a live
      // process omitted from persistence.
      owner.runtime = null; owner.error = 'Zone 已关闭；移除未提交时可刷新后重试'
      await this.options.save(this.descriptors().filter(z => z.id !== id))
      this.owners.delete(id); ++this.revision; this.options.changed()
    })
  }
  connect(id: string, peer: BridgePeer, revision: number): Promise<void> {
    return this.serialize(async () => {
      if (id === 'local') throw fail('FORBIDDEN', '请在主会话输出面板连接')
      const owner = this.owner(id)
      this.check(owner, revision)
      if (!owner.runtime) owner.runtime = await this.options.create(owner.descriptor)
      try { await owner.runtime.connect(peer); owner.error = null }
      catch (error) { owner.error = '连接未成功；Zone 保持隔离，请取得有效邀请后重连'; throw error }
      finally { this.options.changed() }
    })
  }
  private check(owner: ZoneOwner, revision: number): void {
    if (owner.revision !== revision) throw fail('STALE_REVISION', 'Zone 状态已变化，请刷新')
    ++owner.revision
  }
  async transport(id: string, revision: number, command: ZoneTransport, signal: AbortSignal): Promise<void> {
    const owner = this.owner(id), runtime = this.runtime(id)
    this.check(owner, revision)
    try {
      const p = runtime.playback
      switch (command.kind) {
        case 'play': await p.play(undefined, signal); break
        case 'pause': await p.pause(); break
        case 'stop': await p.stop(); break
        case 'next': await p.navigate(1, signal); break
        case 'previous': await p.navigate(-1, signal); break
        case 'seek': await p.seek(command.position); break
        case 'volume': await p.setVolume(command.volume); break
      }
    } finally { this.options.changed() }
  }
  async fromQuery(id: string, revision: number, query: LibraryQuery, selectedId: string | undefined, signal: AbortSignal): Promise<void> {
    const owner = this.owner(id), runtime = this.runtime(id)
    this.check(owner, revision)
    try { await runtime.playback.fromQuery(query, selectedId, false, signal, { prepareOnly: true }) }
    finally { this.options.changed() }
  }
  dsp(id: string) { return this.runtime(id).dsp.state() }
  dspStatus(id: string) { return this.runtime(id).dsp.status() }
  async editDsp(id: string, edit: CoreDspEdit, signal: AbortSignal): Promise<void> {
    await this.runtime(id).dsp.edit(edit, signal)
  }
  async signalPath(id: string) {
    const runtime = this.runtime(id)
    const { buildSignalPath } = await import('../../shared/remoteDsp.ts')
    return { ...buildSignalPath(runtime.playback.snapshot().playback, await runtime.dsp.status(), await runtime.output()), zoneId: id }
  }
  /** The stable topology is held while each session fences preparation; source
   * deletion/cache maintenance sees all zones, but their Stop remains usable. */
  maintainSources<T>(action: (sources: readonly string[]) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const runtimes = [...this.owners.values()].flatMap(z => z.runtime ? [z.runtime] : [])
      const visit = (index: number, sources: readonly string[]): Promise<T> => index === runtimes.length
        ? action(sources) : runtimes[index].playback.maintainSources(next => visit(index + 1, [...sources, ...next]))
      return visit(0, [])
    })
  }
  sources(): string[] { return [...this.owners.values()].flatMap(z => z.runtime?.sources() ?? []) }
  async stopSources(matches: (source: string) => boolean): Promise<void> {
    await Promise.all([...this.owners.values()].map(z => z.runtime?.sources().some(matches) ? z.runtime.playback.stop() : undefined))
  }
  async shutdown(): Promise<void> {
    await this.serialize(async () => {
      this.stopped = true
      const results = await Promise.allSettled([...this.owners.values()].filter(z => z.descriptor.id !== 'local').map(z => z.runtime?.close()))
      const failed = results.find(r => r.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
  }
}
