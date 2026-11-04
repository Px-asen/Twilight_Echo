import type { BridgePeer, BridgeRuntimeState } from '../../shared/audioBridge.ts'
import { MAX_CORE_ZONES, type ZoneDescriptor, type ZonesView, type ZoneTransport, type ZoneHandoff } from '../../shared/coreZones.ts'
import type { CoreDspService } from '../audio/dspService.ts'
import type { CoreDspEdit } from '../../shared/coreDsp.ts'
import type { CorePlaybackSession } from './session.ts'
import type { LibraryQuery } from '../../shared/libraryDatabase.ts'
import type { SyncGroupDescriptor, SyncGroupCreate, SyncGroupsView } from '../../shared/coreSyncGroups.ts'
import type { SyncGroupEngine, SyncGroupOutput } from './syncGroupEngine.ts'
import type { ZoneQueueTarget, ZoneQueueKey, ZoneQueueEdit } from '../../shared/zoneQueue.ts'
import type { ZoneQueueFence } from '../../shared/coreZones.ts'
import type { DspLibraryEdit } from '../../shared/dspLibrary.ts'

type DspLibraryService = Pick<CoreDspService, 'library' | 'editLibrary' | 'beginUpload' | 'uploadChunk' | 'commitUpload' | 'cancelUpload' | 'disconnectUploads' | 'isPluginScanActive' | 'previewProfile' | 'importProfile' | 'exportProfile' | 'profileChunk' | 'releaseProfile' | 'nodeParameters'>

export interface ZoneRuntime {
  playback: CorePlaybackSession
  dsp: Pick<CoreDspService, 'state' | 'status' | 'edit'> & Partial<DspLibraryService>
  output(): Promise<BridgeRuntimeState>
  connect(peer: BridgePeer, coordinated?: boolean): Promise<void>
  sources(): string[]
  failed?(): boolean
  close(): Promise<void>
  /** Output actuator for a shared session; independent playback has no new prerequisites. */
  groupOutput?: import('./syncGroupEngine.ts').SyncGroupOutput
}
interface ZoneOwner { descriptor: ZoneDescriptor; runtime: ZoneRuntime | null; revision: number; error: string | null }
export interface SyncGroupRuntime { playback: CorePlaybackSession; engine: SyncGroupEngine; sources(): string[]; close(): Promise<void> }
interface GroupOwner { descriptor: SyncGroupDescriptor; runtime: SyncGroupRuntime | null; revision: number; error: string | null; abort: AbortController; transitioning: boolean; retiring: boolean }
const fail = (code: string, message: string) => Object.assign(new Error(message), { code })

/** Registry owns topology; every session retains its own transport/configuration
 * lanes. A slow Play in one zone must never queue another zone's Pause/Stop. */
export class CoreZoneRegistry {
  private readonly owners = new Map<string, ZoneOwner>()
  private readonly groups = new Map<string, GroupOwner>()
  private readonly memberships = new Map<string, string>()
  private groupCatalogError: string | null = null
  private revision = 0
  private topology = Promise.resolve()
  private stopped = false
  private readonly dspMutating = new Set<string>()
  private catalogError: string | null = null
  private readonly options: {
    local: ZoneRuntime
    load(): Promise<ZoneDescriptor[]>
    save(zones: ZoneDescriptor[]): Promise<void>
    create(zone: ZoneDescriptor): Promise<ZoneRuntime>
    groups?: {
      load(): Promise<SyncGroupDescriptor[]>
      save(groups: SyncGroupDescriptor[]): Promise<void>
      create(descriptor: SyncGroupDescriptor, outputs: SyncGroupOutput[]): Promise<SyncGroupRuntime>
    }
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
  private independent(id: string): void {
    if (this.memberships.has(id)) throw fail('BUSY', '此输出已加入同步组；请使用组控制或先解除编组')
  }
  private group(id: string): GroupOwner {
    if (this.stopped) throw fail('NOT_READY', 'Core 正在关闭')
    const group = this.groups.get(id)
    if (!group) throw fail('INVALID_REQUEST', '同步组不存在，请刷新')
    return group
  }
  private groupDescriptors(): SyncGroupDescriptor[] { return [...this.groups.values()].map(g => g.descriptor) }
  private groupOutputs(group: GroupOwner): SyncGroupOutput[] {
    return group.descriptor.members.map(member => {
      const output = () => {
        const port = this.runtime(member.zoneId).groupOutput
        if (!port) throw fail('NOT_READY', '此输出没有同步组能力')
        return port
      }
      return { id: member.zoneId, downstreamDelayMs: member.downstreamDelayMs,
        read: () => output().read(), prepare: (...args) => { this.requireStableGroupDsp(group); return output().prepare(...args) },
        arm: (...args) => { this.requireStableGroupDsp(group); return output().arm(...args) }, silence: () => output().silence(), volume: v => output().volume(v) }
    })
  }
  private requireStableGroupDsp(group: GroupOwner) {
    if (group.descriptor.members.some(member => this.dspMutating.has(member.zoneId) || this.runtime(member.zoneId).dsp.isPluginScanActive?.()))
      throw fail('BUSY', '成员正在扫描插件，完成后请重新开始同步播放')
  }
  private async silenceGroup(group: GroupOwner, stop = false): Promise<void> {
    ++group.revision; group.abort.abort()
    if (group.runtime) await (stop ? group.runtime.playback.stop() : group.runtime.playback.pause())
    else {
      const results = await Promise.allSettled(group.descriptor.members.map(async m => this.runtime(m.zoneId).groupOutput!.silence()))
      const failed = results.find(r => r.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
    this.options.changed()
  }
  private reserve(group: GroupOwner): void {
    for (const member of group.descriptor.members) { this.independent(member.zoneId); this.owner(member.zoneId) }
    this.groups.set(group.descriptor.id, group)
    for (const member of group.descriptor.members) this.memberships.set(member.zoneId, group.descriptor.id)
  }
  private async claim(group: GroupOwner): Promise<void> {
    await Promise.all(group.descriptor.members.map(async member => {
      const session = this.runtime(member.zoneId).playback
      await session.claimOutput(group.descriptor.id, () => this.silenceGroup(group))
    }))
  }
  private release(group: GroupOwner): void {
    for (const member of group.descriptor.members) {
      this.owners.get(member.zoneId)?.runtime?.playback.releaseOutput(group.descriptor.id)
      this.memberships.delete(member.zoneId)
    }
    this.groups.delete(group.descriptor.id)
  }
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
    if (this.options.groups) {
      let saved: SyncGroupDescriptor[]
      try { saved = await this.options.groups.load() }
      catch { this.groupCatalogError = '同步组清单无法读取；未接管输出，请修复清单后重启'; return }
      for (const descriptor of saved) {
        const group: GroupOwner = { descriptor, runtime: null, revision: 0, error: null, abort: new AbortController(), transitioning: false, retiring: false }
        try {
          this.reserve(group); await this.claim(group)
          group.runtime = await this.options.groups.create(descriptor, this.groupOutputs(group))
        } catch {
          group.error = '同步组恢复失败，保持暂停；请重连或解除，不自动发声'
          if (!this.groups.has(descriptor.id)) this.groups.set(descriptor.id, group)
        }
      }
    }
  }
  async list(): Promise<ZonesView> {
    const zones = await Promise.all([...this.owners.values()].map(async owner => {
      const snapshot = owner.runtime?.playback.snapshot()
      let output: BridgeRuntimeState | null = null
      let error = owner.error ?? snapshot?.error ?? null
      try { output = await owner.runtime?.output() ?? null }
      catch { error = '此 Zone 音频服务不可用，未切换到其他输出' }
      return { ...owner.descriptor, groupId: this.memberships.get(owner.descriptor.id) ?? null, revision: owner.revision, playback: snapshot?.playback ?? null,
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
      this.independent(id)
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
      try {
        await this.reconnect(id, async grouped => {
          if (owner.runtime?.failed?.()) {
            // Retire the old process before its slot/DAC can be reused.
            await owner.runtime.close(); owner.runtime = null
          }
          const runtime = owner.runtime ??= await this.options.create(owner.descriptor)
          if (grouped) {
            const group = this.group(this.memberships.get(id)!)
            await runtime.playback.claimOutput(group.descriptor.id, () => this.silenceGroup(group))
          }
          await runtime.connect(peer, grouped)
        })
        owner.error = null
      }
      catch (error) { owner.error = '连接未成功；Zone 保持隔离，请取得有效邀请后重连'; throw error }
      finally { this.options.changed() }
    })
  }
  /** The primary Bridge panel retains its revision, peer and invitation state. */
  coordinatePrimaryConnection(action: (grouped: boolean) => Promise<void>): Promise<void> {
    return this.serialize(() => this.reconnect('local', action))
  }
  private async reconnect(id: string, action: (grouped: boolean) => Promise<void>): Promise<void> {
    const groupId = this.memberships.get(id)
    const group = groupId ? this.group(groupId) : null
    if (group) group.transitioning = true
    try {
    if (group) {
      try { await this.silenceGroup(group) }
      catch (error) {
        const runtime = this.owner(id).runtime
        const output = runtime && !runtime.failed?.() ? await runtime.output() : null
        if (output?.connected) throw error
        // Offline is not an acknowledgement. The new TLS session and joined
        // stop must both succeed before recovery is reported.
      }
    }
    await action(!!group)
    if (group) {
      if (group.retiring) {
        // A failed close may already have disposed the SQL session. Reconnect
        // confirms silence, but must not resurrect that retired session or
        // silently commit a group whose original catalog write failed.
        if (group.runtime) await group.runtime.close()
        else await this.silenceGroup(group)
        group.runtime = null
        group.error = '输出已恢复停音；请完成解除编组，再按需要重新建立'
        this.options.changed(); return
      }
      if (!group.runtime) {
        await this.claim(group)
        group.runtime = await this.options.groups!.create(group.descriptor, this.groupOutputs(group))
      }
      await group.runtime.playback.recoverAudio(() => group.runtime!.engine.recover())
      group.error = null
    }
    this.options.changed()
    } finally { if (group) group.transitioning = false }
  }
  async listGroups(): Promise<SyncGroupsView> {
    return { revision: this.revision, error: this.groupCatalogError, groups: [...this.groups.values()].map(group => {
      const snapshot = group.runtime?.playback.snapshot()
      return { ...structuredClone(group.descriptor), revision: group.revision, playback: snapshot?.playback ?? null,
        track: snapshot?.track ?? null, queue: snapshot?.queue ?? null, coordination: group.runtime?.engine.state() ?? null,
        error: group.error ?? group.runtime?.engine.state().error ?? snapshot?.error ?? null }
    }) }
  }
  membership(id: string): string | null { return this.memberships.get(id) ?? null }
  createGroup(command: SyncGroupCreate, signal: AbortSignal): Promise<string> {
    return this.serialize(async () => {
      const host = this.options.groups
      if (!host || this.groupCatalogError) throw fail('NOT_READY', this.groupCatalogError ?? '此宿主未提供同步组')
      if (command.revision !== this.revision) throw fail('STALE_REVISION', '输出拓扑已变化，请刷新')
      if (command.members.length < 2 || command.members.length > MAX_CORE_ZONES ||
          new Set(command.members.map(m => m.zoneId)).size !== command.members.length ||
          !command.members.some(m => m.zoneId === command.source.zoneId)) throw fail('INVALID_REQUEST', '同步组需要不同成员，且包含来源 Zone')
      const source = this.runtime(command.source.zoneId)
      const sourceQueue = source.playback.snapshot().queue, expected = command.source.queue
      if (sourceQueue?.id !== expected.id || sourceQueue?.revision !== expected.revision || sourceQueue?.occurrenceId !== expected.occurrenceId)
        throw fail('STALE_REVISION', '来源队列已变化，请刷新后编组')
      const members = command.members.map(m => this.owner(m.zoneId))
      for (const [index, member] of members.entries()) {
        this.independent(member.descriptor.id)
        if (member.revision !== command.members[index].revision) throw fail('STALE_REVISION', '组成员会话已变化，请刷新')
        if (!this.runtime(member.descriptor.id).groupOutput) throw fail('NOT_READY', '组成员不支持同步输出')
      }
      const descriptor: SyncGroupDescriptor = { id: `group-${this.options.newId()}`, name: command.name.trim(),
        members: command.members.map(({ zoneId, downstreamDelayMs }) => ({ zoneId, downstreamDelayMs })) }
      const group: GroupOwner = { descriptor, runtime: null, revision: 0, error: null, abort: new AbortController(), transitioning: true, retiring: false }
      this.reserve(group)
      const combined = AbortSignal.any([signal, group.abort.signal])
      let committed = false
      try {
        // Reserve before provider/SQL IO; members cannot start a conflicting Play.
        for (const member of members) ++member.revision
        const capture = source.playback.captureHandoff(command.source.queue, combined,
          { id: descriptor.id, silence: () => this.silenceGroup(group) })
        const claims = await Promise.allSettled([capture, ...members.filter(m => m.descriptor.id !== command.source.zoneId).map(async member =>
          this.runtime(member.descriptor.id).playback.claimOutput(descriptor.id, () => this.silenceGroup(group)))])
        const failed = claims.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
        const captured = (claims[0] as PromiseFulfilledResult<Awaited<typeof capture>>).value
        combined.throwIfAborted()
        group.runtime = await host.create(descriptor, this.groupOutputs(group))
        await group.runtime.playback.receiveHandoff(null, async () => captured, false, combined)
        combined.throwIfAborted()
        await this.claim(group)
        combined.throwIfAborted()
        await host.save(this.groupDescriptors())
        committed = true; ++this.revision; this.options.changed()
        return descriptor.id
      } finally {
        if (!committed) {
          group.retiring = true
          // A failed close keeps the lease visible for explicit recovery. Never
          // return an output to independent playback while its stop is unknown.
          try {
            if (group.runtime) await group.runtime.close()
            else await this.silenceGroup(group)
            this.release(group)
          }
          catch { group.error = '同步组创建未完成且停音未确认；请重连或重启音频服务' }
          this.options.changed()
        }
        group.transitioning = false
      }
    })
  }
  removeGroup(id: string, revision: number): Promise<void> {
    return this.serialize(async () => {
      if (!this.options.groups || this.groupCatalogError) throw fail('NOT_READY', '同步组清单不可写')
      const group = this.group(id)
      if (group.revision !== revision) throw fail('STALE_REVISION', '同步组已变化，请刷新')
      group.abort.abort(); group.transitioning = true; group.retiring = true
      try {
      if (group.runtime) await group.runtime.close()
      else await this.silenceGroup(group)
      group.runtime = null; group.error = '同步组已暂停；解除尚未提交时可明确重试'
      await this.options.groups.save(this.groupDescriptors().filter(g => g.id !== id))
      this.release(group)
      ++this.revision; this.options.changed()
      } finally { group.transitioning = false }
    })
  }
  async groupTransport(id: string, revision: number | null, command: ZoneTransport, signal: AbortSignal): Promise<void> {
    const group = this.group(id)
    if (revision !== null && revision !== group.revision) throw fail('STALE_REVISION', '同步组已变化，请刷新')
    if (['pause', 'stop'].includes(command.kind)) return this.silenceGroup(group, command.kind === 'stop')
    if (group.transitioning) throw fail('BUSY', '同步组正在变更；暂停／停止仍可使用')
    if (group.retiring) throw fail('NOT_READY', '请先完成解除编组')
    if (revision === null) throw fail('INVALID_REQUEST', '只有暂停／停止可跳过组版本')
    if (!group.runtime) throw fail('NOT_READY', group.error ?? '同步组未就绪')
    this.requireStableGroupDsp(group)
    ++group.revision
    const p = group.runtime.playback
    try {
      switch (command.kind) {
        case 'play': await p.play(undefined, signal); break
        case 'next': await p.navigate(1, signal); break
        case 'previous': await p.navigate(-1, signal); break
        case 'seek': await p.seek(command.position); break
        case 'volume': await p.setVolume(command.volume); break
      }
    } finally { this.options.changed() }
  }
  async groupFromQuery(id: string, revision: number, query: LibraryQuery, selectedId: string | undefined, signal: AbortSignal): Promise<void> {
    const group = this.group(id)
    if (group.transitioning) throw fail('BUSY', '同步组正在变更，请稍后重试')
    if (group.retiring) throw fail('NOT_READY', '请先完成解除编组')
    if (revision !== group.revision) throw fail('STALE_REVISION', '同步组已变化，请刷新')
    if (!group.runtime) throw fail('NOT_READY', '同步组未就绪')
    ++group.revision
    try { await group.runtime.playback.fromQuery(query, selectedId, false, signal, { prepareOnly: true }) }
    finally { this.options.changed() }
  }
  private check(owner: ZoneOwner, revision: number): void {
    if (owner.revision !== revision) throw fail('STALE_REVISION', 'Zone 状态已变化，请刷新')
    ++owner.revision
  }
  async transport(id: string, revision: number | null, command: ZoneTransport, signal: AbortSignal): Promise<void> {
    const owner = this.owner(id), runtime = this.runtime(id)
    const grouped = this.memberships.get(id)
    if (grouped) {
      if (!['pause', 'stop'].includes(command.kind)) this.independent(id)
      await this.silenceGroup(this.group(grouped), command.kind === 'stop'); return
    }
    // Silence needs no topology/output-status round trip. Epoch + Zone identity
    // still bind it; only Pause/Stop can bypass a stale transport revision.
    if (revision === null) {
      if (!['pause', 'stop'].includes(command.kind)) throw fail('INVALID_REQUEST', '只有暂停／停止可使用即时静音入口')
      ++owner.revision
    } else this.check(owner, revision)
    const ticket = owner.revision
    try {
      const p = runtime.playback
      if (id !== 'local' && ['play', 'next', 'previous', 'seek'].includes(command.kind)) {
        const output = await runtime.output()
        // Pause/Stop may arrive while the status RPC is pending, before the
        // session has a playback intent to revoke. Never resurrect that Play.
        if (owner.revision !== ticket || signal.aborted) throw fail('CANCELLED', '播放请求已被后续操作取消')
        if (output.selected && !output.connected) throw fail('NOT_READY', '输出桥未连接；未切换到本机输出')
      }
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
    this.independent(id)
    const owner = this.owner(id), runtime = this.runtime(id)
    this.check(owner, revision)
    try { await runtime.playback.fromQuery(query, selectedId, false, signal, { prepareOnly: true }) }
    finally { this.options.changed() }
  }
  dsp(id: string) { return this.runtime(id).dsp.state() }
  private queueOwner(target: ZoneQueueTarget, mutate = false) {
    const owner = target.kind === 'group' ? this.group(target.id) : this.owner(target.id)
    if (target.kind === 'zone') this.independent(target.id)
    else {
      const group = owner as GroupOwner
      if (group.transitioning || group.retiring) throw fail('BUSY', '同步组正在变更，请刷新')
      if (mutate) this.requireStableGroupDsp(group)
    }
    if (owner.revision !== target.revision) throw fail('STALE_REVISION', '声区已变化，请刷新')
    const runtime = owner.runtime
    if (!runtime) throw fail('NOT_READY', owner.error ?? '声区未就绪')
    if (mutate) ++owner.revision
    const ticket = owner.revision
    const guard = () => {
      if (this.stopped || owner.revision !== ticket || owner.runtime !== runtime ||
          (target.kind === 'zone' ? this.owners.get(target.id) !== owner || this.memberships.has(target.id) :
            this.groups.get(target.id) !== owner || (owner as GroupOwner).transitioning || (owner as GroupOwner).retiring))
        throw fail('STALE_REVISION', '声区已变化，请刷新')
    }
    return { playback: runtime.playback, guard }
  }
  async queuePage(target: ZoneQueueTarget, queue: ZoneQueueKey, offset: number, limit?: number) {
    const access = this.queueOwner(target)
    const page = await access.playback.queuePage(queue.id, queue.revision, offset, limit)
    access.guard()
    return page
  }
  async queueEdit(target: ZoneQueueTarget, queue: ZoneQueueKey, edit: ZoneQueueEdit) {
    const access = this.queueOwner(target, true)
    try { await access.playback.edit(queue.id, queue.revision, edit) }
    finally { this.options.changed() }
  }
  async queueSelect(target: ZoneQueueTarget, queue: ZoneQueueKey, index: number, occurrenceId: string, signal: AbortSignal) {
    const access = this.queueOwner(target, true)
    try {
      if (target.kind === 'zone' && target.id !== 'local') {
        const output = await this.runtime(target.id).output()
        access.guard(); signal.throwIfAborted()
        if (!output.connected) throw fail('NOT_READY', '输出桥未连接')
      }
      await access.playback.select({ ...queue, index, occurrenceId }, signal)
    } finally { this.options.changed() }
  }
  async loadQueue<T>(target: ZoneQueueTarget, expected: ZoneQueueFence | null, play: boolean,
    run: (playback: Pick<CorePlaybackSession, 'fromPages'>) => Promise<T>, signal: AbortSignal): Promise<T> {
    const access = this.queueOwner(target)
    const queueGuard = () => {
      access.guard(); signal.throwIfAborted()
      const current = access.playback.snapshot().queue
      if ((current?.id ?? null) !== (expected?.id ?? null) || current?.revision !== expected?.revision ||
          current?.occurrenceId !== expected?.occurrenceId) throw fail('STALE_REVISION', '目标队列已变化，请重新确认替换')
    }
    queueGuard()
    const reserved = this.queueOwner(target, true)
    // The mutation owns a new target revision. Pause/Stop can revoke it even
    // while a source query, provider resolution or output preflight is pending.
    const checkQueue = () => {
      reserved.guard(); signal.throwIfAborted()
      const current = reserved.playback.snapshot().queue
      if ((current?.id ?? null) !== (expected?.id ?? null) || current?.revision !== expected?.revision ||
          current?.occurrenceId !== expected?.occurrenceId) throw fail('STALE_REVISION', '目标队列已变化，请重新确认替换')
    }
    try {
      if (play && target.kind === 'zone' && target.id !== 'local') {
        const output = await this.runtime(target.id).output()
        checkQueue()
        if (!output.connected) throw fail('NOT_READY', '输出桥未连接；可先载入暂停队列')
      }
      return await run({ fromPages: (produce, options = {}, preparation) => reserved.playback.fromPages(produce, {
        ...options, play,
        guard: () => { reserved.guard(); signal.throwIfAborted(); options.guard?.() },
        beforeAdopt: async playing => { checkQueue(); await options.beforeAdopt?.(playing); checkQueue() }
      }, preparation ?? signal) })
    } finally { this.options.changed() }
  }
  handoff(command: ZoneHandoff, signal: AbortSignal): Promise<void> {
    return this.serialize(async () => {
      const { source, target } = command
      this.independent(source.zoneId); this.independent(target.zoneId)
      if (source.zoneId === target.zoneId) throw fail('INVALID_REQUEST', '请选择不同的目标 Zone')
      const from = this.owner(source.zoneId), to = this.owner(target.zoneId)
      const sender = this.runtime(source.zoneId), receiver = this.runtime(target.zoneId)
      if (from.revision !== source.revision || to.revision !== target.revision)
        throw fail('STALE_REVISION', '会话状态已变化，请刷新后重新接力')
      if (receiver.playback.snapshot().queue && !command.replace)
        throw fail('FORBIDDEN', '请明确确认替换目标会话的队列')
      if (command.resume) {
        const output = await receiver.output()
        if (output.selected && !output.connected) throw fail('NOT_READY', '目标输出桥未连接；可选择只接力并暂停')
      }
      // Transport does not wait on topology. A Pause/Stop on either session
      // invalidates its preparation token instead of being stuck behind transfer IO.
      this.check(from, source.revision); this.check(to, target.revision)
      try {
        await receiver.playback.receiveHandoff(target.queue,
          () => sender.playback.captureHandoff(source.queue, signal), command.resume, signal)
      } finally { this.options.changed() }
    })
  }
  dspStatus(id: string) { return this.runtime(id).dsp.status() }
  withDspLibrary<T>(id: string, action: (dsp: DspLibraryService) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const dsp = this.runtime(id).dsp
      if (!dsp.library) throw fail('UNSUPPORTED_CAPABILITY', '此声区尚不支持 DSP 资料管理')
      return action(dsp as DspLibraryService)
    })
  }
  editDspLibrary(id: string, revision: number, edit: DspLibraryEdit, signal: AbortSignal) {
    return this.changeDspLibrary(id, signal, !['removeAsset'].includes(edit.kind),
      !['scan', 'clearQuarantine'].includes(edit.kind), dsp => dsp.editLibrary(revision, edit, signal))
  }
  importDspProfile(id: string, owner: string, uploadId: string, previewId: string, revision: number, signal: AbortSignal) {
    return this.changeDspLibrary(id, signal, true, true, dsp => dsp.importProfile(owner, uploadId, previewId, revision, signal))
  }
  private changeDspLibrary<T>(id: string, signal: AbortSignal, changesAudio: boolean, canResume: boolean, action: (dsp: DspLibraryService) => Promise<T>): Promise<T> {
    return this.withDspLibrary(id, async dsp => {
      const grouped = this.memberships.get(id), group = grouped ? this.group(grouped) : null
      if (group?.transitioning) throw fail('BUSY', '同步组正在变更')
      const resume = changesAudio && group?.runtime?.playback.snapshot().playback?.state === 'playing'
      let ticket: number | undefined
      let result: T
      if (changesAudio) this.dspMutating.add(id)
      try {
        if (changesAudio && group) await this.silenceGroup(group)
        ticket = group?.revision
        result = await action(dsp)
      } finally { this.dspMutating.delete(id) }
      // A scan can complete later and change plugin availability/latency; the group stays paused.
      if (resume && canResume && group?.revision === ticket && !signal.aborted)
        await group.runtime!.playback.play(undefined, signal)
      return result
    })
  }
  async disconnectDspUploads(owner: string) {
    await Promise.all([...this.owners.values()].map(zone => zone.runtime?.dsp.disconnectUploads?.(owner)))
  }
  async editDsp(id: string, edit: CoreDspEdit, signal: AbortSignal): Promise<void> {
    if (this.runtime(id).dsp.isPluginScanActive?.()) throw fail('BUSY', '插件扫描完成后再调整 DSP')
    const grouped = this.memberships.get(id)
    const group = grouped ? this.group(grouped) : null
    if (group?.transitioning) throw fail('BUSY', '同步组正在变更，请稍后调整 DSP')
    const resume = group?.runtime?.playback.snapshot().playback?.state === 'playing'
    if (group) await this.silenceGroup(group)
    const ticket = group?.revision
    await this.runtime(id).dsp.edit(edit, signal)
    if (resume && group?.revision === ticket && !signal.aborted) await group.runtime!.playback.play(undefined, signal)
  }
  async signalPath(id: string) {
    const runtime = this.runtime(id)
    const { buildSignalPath } = await import('../../shared/remoteDsp.ts')
    return { ...buildSignalPath(runtime.playback.snapshot().playback, await runtime.dsp.status(), await runtime.output()), zoneId: id }
  }
  async groupSignalPath(groupId: string, zoneId: string) {
    const group = this.group(groupId)
    if (this.memberships.get(zoneId) !== groupId || !group.runtime) throw fail('INVALID_REQUEST', '该输出不是当前组成员')
    const runtime = this.runtime(zoneId)
    const { buildSignalPath } = await import('../../shared/remoteDsp.ts')
    return { ...buildSignalPath(group.runtime.playback.snapshot().playback, await runtime.dsp.status(), await runtime.output()), zoneId }
  }
  /** The stable topology is held while each session fences preparation; source
   * deletion/cache maintenance sees all zones, but their Stop remains usable. */
  maintainSources<T>(action: (sources: readonly string[]) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      for (const owner of this.owners.values()) ++owner.revision
      const sessions = [...this.owners.values()].flatMap(z => z.runtime ? [z.runtime.playback] : [])
      for (const group of this.groups.values()) if (group.runtime) {
        ++group.revision
        // Group sessions participate in the same source-deletion fence as standalone sessions.
        sessions.push(group.runtime.playback)
      }
      const visit = (index: number, sources: readonly string[]): Promise<T> => index === sessions.length
        ? action(sources) : sessions[index].maintainSources(next => visit(index + 1, [...sources, ...next]))
      return visit(0, [])
    })
  }
  sources(): string[] { return [...this.owners.values()].flatMap(z => z.runtime?.sources() ?? [])
    .concat([...this.groups.values()].flatMap(g => g.runtime?.sources() ?? [])) }
  async stopSources(matches: (source: string) => boolean): Promise<void> {
    await Promise.all([...this.groups.values()].map(g => g.runtime?.sources().some(matches) ? this.silenceGroup(g, true) : undefined))
    await Promise.all([...this.owners.values()].map(z => {
      if (!z.runtime?.sources().some(matches)) return
      ++z.revision
      return z.runtime.playback.stop()
    }))
  }
  async shutdown(): Promise<void> {
    await this.serialize(async () => {
      const groupResults = await Promise.allSettled([...this.groups.values()].map(async group => {
        await group.runtime?.close()
        this.release(group)
      }))
      this.stopped = true
      const results = await Promise.allSettled([...this.owners.values()].filter(z => z.descriptor.id !== 'local').map(z => z.runtime?.close()))
      const failed = [...groupResults, ...results].find(r => r.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
  }
}
