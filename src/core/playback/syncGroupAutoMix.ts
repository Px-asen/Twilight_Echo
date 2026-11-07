import type { PlaybackInfo } from '../../shared/audioEngineTypes.ts'
import type { AutoMixMode, AutoMixSelection } from '../../shared/twilightAutoMix.ts'
import type { BridgeAutoMixPlan } from '../../shared/bridgeAutoMix.ts'
import type { SyncGroupOutput, SyncGroupOutputState } from './syncGroupEngine.ts'
import type { AutoMixMaterialExport } from '../audio/autoMixMaterials.ts'
import type { BridgeSourceTimeline } from '../../shared/bridgeSourceTimeline.ts'

/** Member-local tickets never cross the native pipeline that issued them. */
export interface SyncGroupAutoMixOutput {
  mode(mode: AutoMixMode): Promise<void>
  select(request: string): Promise<AutoMixSelection>
  bind(request: string): Promise<AutoMixSelection>
  prepare(request: string): Promise<boolean>
  status(): Promise<PlaybackInfo>
  submit(id: number): Promise<boolean>
  cancel(): Promise<boolean>
}
interface Context { epoch: number; queueToken: string; currentEntry: string; nextEntry: string }
interface Transaction {
  id: number
  context: Context
  plan: BridgeAutoMixPlan
  selections: AutoMixSelection[]
  nativeIds: number[]
  boundaryMs: number[]
  stems: boolean
  timelines: BridgeSourceTimeline[]
  decodeMs: number
  prepareMs: number
  phase: 'selected' | 'preparing' | 'ready' | 'submitted'
}

/** Tightly owned by SyncGroupEngine: only the collective transition transaction,
 * no independent queue, media resolution, SQL cursor or background selector. */
export class SyncGroupAutoMix {
  private serial = 0
  private transaction: Transaction | null = null
  private selecting = false
  private revision = 0
  private materialScopes = new Map<number, { selections: AutoMixSelection[]; material: AutoMixMaterialExport }>()
  reason = ''
  private readonly owner: {
    outputs: SyncGroupOutput[]
    context(): Context | null
    states(): Promise<SyncGroupOutputState[]>
    fail(error: unknown): Promise<void>
  }
  constructor(owner: SyncGroupAutoMix['owner']) { this.owner = owner }
  get active(): boolean { return this.selecting || !!this.transaction }
  get submittedPlan(): BridgeAutoMixPlan | null {
    return this.transaction?.phase === 'submitted' ? this.transaction.plan : null
  }
  get expectedBoundaryMs(): readonly number[] { return this.transaction?.boundaryMs ?? [] }
  complete(): void { ++this.revision; this.transaction = null; this.reason = '' }
  private current(context: Context, revision: number): void {
    const live = this.owner.context()
    if (revision !== this.revision || !live || Object.keys(context).some(k =>
      context[k as keyof Context] !== live[k as keyof Context])) throw new Error('stale_group_automix')
  }
  private ports(): SyncGroupAutoMixOutput[] {
    if (this.owner.outputs.some(o => !o.autoMix || !o.continuous)) throw new Error('group_automix_unavailable')
    return this.owner.outputs.map(o => o.autoMix!)
  }
  async select(json: string, material?: AutoMixMaterialExport): Promise<AutoMixSelection> {
    if (this.active) throw new Error('group_preparation_busy')
    const context = this.owner.context()
    if (!context) throw new Error('group_ownership_required')
    const revision = this.revision, ports = this.ports()
    let retained = false
    const exports: AutoMixSelection[] = []
    const select = async (request: string, native: (json: string) => Promise<AutoMixSelection>) => {
      const selection = material ? await material.select(request, native) : await native(request)
      exports.push(selection)
      return selection
    }
    this.selecting = true; this.reason = ''
    try {
      // Mode-on ticks cannot commit ordinary gapless while a policy is pending.
      await Promise.all(this.owner.outputs.map(o => o.continuous!.hold()))
      const states = await this.owner.states(); this.current(context, revision)
      const request = JSON.parse(json) as Record<string, unknown>
      const minimum = Math.max(Number(request.minimumCurrentStartSeconds) || 0, ...states.map(s => {
        if (!s.sourceTimeline || s.sourceTimeline.entryId !== context.currentEntry || !s.bridge.connected)
          throw new Error('source_timeline_not_exact')
        if (s.dsp.applyState === 'pending' || s.dsp.applyState === 'failed' || s.dsp.compileState === 'compiling' ||
            s.dsp.compileState === 'failed' || !Number.isFinite(s.dsp.totalLatencyFrames) || s.dsp.totalLatencyFrames < 0 ||
            (s.dsp.totalLatencyFrames > 0 && !(s.dsp.latencySampleRate! > 0))) throw new Error('dsp_not_applied')
        const dspLead = s.dsp.totalLatencyFrames ? s.dsp.totalLatencyFrames / s.dsp.latencySampleRate! : 0
        return s.sourceTimeline.positionFrames / s.sourceTimeline.sampleRate + 2 + dspLead
      }))
      const boundRequest = { ...request, minimumCurrentStartSeconds: minimum }
      const leader = await select(JSON.stringify(boundRequest), json => ports[0].select(json)); this.current(context, revision)
      if (!leader.ok || !leader.sharedPlan) {
        this.reason = leader.reason || 'shared_selection_required'
        await this.cancelPorts(ports)
        return { ok: false, reason: this.reason }
      }
      const plan = leader.sharedPlan
      if (plan.currentEntryId !== context.currentEntry || plan.nextEntryId !== context.nextEntry)
        throw new Error('shared_source_binding_mismatch')
      // Material exports belong to a member's rate/domain and ticket directory.
      // The leader's materialDirectory must never leak into follower binding.
      const { materialDirectory: _leaderDirectory, ...followerRequest } = boundRequest as Record<string, unknown>
      const results = await Promise.allSettled(ports.slice(1).map(port => select(JSON.stringify({ ...followerRequest, sharedPlan: plan }), json => port.bind(json))))
      this.current(context, revision)
      const failed = results.find(r => r.status === 'rejected' || !r.value.ok)
      if (failed) throw failed.status === 'rejected' ? failed.reason : new Error(failed.value.reason || 'shared_plan_binding_failed')
      const selections = [leader, ...results.map(r => (r as PromiseFulfilledResult<AutoMixSelection>).value)]
      if (selections.some(s => !Number.isSafeInteger(s.selectionId) || s.selectionId! <= 0)) throw new Error('invalid_selection_ticket')
      const id = ++this.serial
      const boundaryMs = states.map(s => (s.sourceTimeline!.frames-s.sourceTimeline!.positionFrames)*1000/s.sourceTimeline!.sampleRate +
        (plan.currentStartFrame+plan.outputFrames)*1000/plan.sampleRate)
      this.transaction = { id, context, plan, selections, nativeIds: [], boundaryMs, stems: false, decodeMs: 0, prepareMs: 0,
        timelines: states.map(s => ({ ...s.sourceTimeline! })), phase: 'selected' }
      if (material) this.materialScopes.set(id, { selections, material })
      retained = true
      return { ...leader, selectionId: id }
    } catch (error) {
      this.reason = error instanceof Error ? error.message : String(error)
      if (revision === this.revision) await this.cancelPorts(ports)
      throw error
    } finally {
      this.selecting = false
      if (material && !retained)
        await Promise.all(exports.map(s => material.release(s)))
    }
  }
  async prepareMaterials(selection: AutoMixSelection, prepare: (member: AutoMixSelection) => Promise<Record<string, unknown> | null>): Promise<Record<string, unknown> | null> {
    const tx = this.transaction, revision = this.revision
    if (!tx || tx.id !== selection.selectionId || tx.phase !== 'selected') throw new Error('stale_selection_ticket')
    const material: Record<string, Record<string, unknown>> = {}
    // One existing stem service owns a worker/cache. Run members serially:
    // each export has its own native rate, origins, ticket and directory.
    for (const [i, member] of tx.selections.entries()) {
      this.current(tx.context, revision)
      const result = await prepare(member)
      this.current(tx.context, revision)
      if (!result) return null // Optional enhancement is all-member or none.
      material[this.owner.outputs[i].id] = result
    }
    return { memberMaterials: material }
  }
  async releaseMaterials(selection?: AutoMixSelection): Promise<void> {
    const id = selection?.selectionId, scope = id ? this.materialScopes.get(id) : undefined
    if (!scope || !id) return
    this.materialScopes.delete(id)
    await Promise.all(scope.selections.map(s => scope.material.release(s)))
  }
  async prepare(json: string): Promise<boolean> {
    const request = JSON.parse(json) as Record<string, unknown>, tx = this.transaction
    if (!tx || tx.phase !== 'selected' || request.selectionId !== tx.id) throw new Error('stale_selection_ticket')
    const revision = this.revision, ports = this.ports()
    this.current(tx.context, revision)
    // Per-member stem preparation is supplied by the analysis/material owner.
    // Reject a leader-only payload rather than silently dropping enhancement.
    const materials = request.memberMaterials as Record<string, Record<string, unknown>> | undefined
    if (request.stemMaterials && !materials) throw new Error('group_material_bindings_required')
    if (materials && this.owner.outputs.some(o => !materials[o.id])) throw new Error('group_material_bindings_required')
    tx.stems = !!materials
    tx.phase = 'preparing'
    const { selectionId: _groupId, memberMaterials: _materials, stemMaterials: _leaderMaterials, ...common } = request
    const results = await Promise.allSettled(ports.map((port, i) => port.prepare(JSON.stringify({ ...common,
      ...(materials?.[this.owner.outputs[i].id] ?? {}), selectionId: tx.selections[i].selectionId }))))
    this.current(tx.context, revision)
    if (results.some(r => r.status === 'rejected' || !r.value)) {
      this.reason = 'group_native_preparation_failed'; this.transaction = null
      await this.cancelPorts(ports); return false
    }
    return true
  }
  async status(): Promise<{ phase: PlaybackInfo['autoMixState']; id: number; reason: string; info?: Partial<PlaybackInfo> }> {
    const tx = this.transaction
    if (!tx) return { phase: 'degraded', id: 0, reason: this.reason }
    const revision = this.revision
    const statuses = await Promise.all(this.ports().map(p => p.status())); this.current(tx.context, revision)
    if (this.transaction !== tx) throw new Error('stale_group_automix')
    // The existing native clock retires a completed preparation with this
    // reason. It is not proof of a transition: the owner still requires the
    // exact private promotion marker, including a common audible deadline.
    let completionStates: SyncGroupOutputState[] | null = null
    if (tx.phase === 'submitted' && statuses.some(s => s.autoMixReason === 'next_source_changed')) {
      completionStates = await this.owner.states(); this.current(tx.context, revision)
    }
    const retired = (s: PlaybackInfo, i: number) => {
      if (tx.phase !== 'submitted' || s.autoMixState !== 'degraded') return false
      if (s.autoMixReason === 'transition_completed') return true
      // The native queue clock may retire the completed plan again when it
      // prepares subsequent lookahead. Only a proven exact promotion permits
      // this otherwise ordinary invalidation reason to count as retirement.
      const marker = completionStates?.[i].sourceTimeline, before = tx.timelines[i]
      return s.autoMixReason === 'next_source_changed' && !!marker && marker.generation === before.generation &&
        marker.epoch === before.epoch && marker.transitionSerial === before.transitionSerial+1 &&
        marker.entryId === tx.plan.nextEntryId && Math.abs(marker.transitionFrame*1000/marker.sampleRate-tx.boundaryMs[i]) <= 1
    }
    const failed = statuses.find((s,i) => s.autoMixMode === 'off' || (s.autoMixState === 'degraded' && !retired(s,i)) || s.autoMixState === 'off')
    if (failed) {
      const error = new Error(failed.autoMixReason || 'group_native_preparation_failed')
      if (tx.phase === 'submitted') await this.owner.fail(error)
      else { this.reason = error.message; this.transaction = null; await this.cancelPorts(this.ports()) }
      return { phase: 'degraded', id: 0, reason: error.message }
    }
    if (tx.phase === 'preparing' && statuses.every(s => s.autoMixState === 'ready' && Number.isSafeInteger(s.autoMixPlanId) && s.autoMixPlanId! > 0)) {
      if (tx.stems && statuses.some(s => !s.autoMixStemEnhanced)) {
        this.reason = 'group_stems_binding_failed'; this.transaction = null
        await this.cancelPorts(this.ports())
        return { phase: 'degraded', id: 0, reason: this.reason }
      }
      tx.nativeIds = statuses.map(s => s.autoMixPlanId!); tx.phase = 'ready'
    }
    tx.decodeMs = Math.max(tx.decodeMs, ...statuses.map(s => s.autoMixDecodeMs ?? 0))
    tx.prepareMs = Math.max(tx.prepareMs, ...statuses.map(s => s.autoMixPrepareMs ?? 0))
    const strategy = tx.selections[0].strategy
    return { phase: tx.phase === 'submitted' && statuses.some((s,i) => s.autoMixState === 'mixing' || s.autoMixState === 'completed' || retired(s,i)) ? 'mixing' :
      ['ready', 'submitted'].includes(tx.phase) ? 'ready' : 'preparing', id: tx.id, reason: '',
      info: { autoMixDurationSeconds: tx.plan.outputFrames/tx.plan.sampleRate,
        autoMixStemEnhanced: tx.stems && ['ready','submitted'].includes(tx.phase), autoMixDecodeMs: tx.decodeMs, autoMixPrepareMs: tx.prepareMs,
        autoMixStrategy: strategy && ['beat-aligned','content-boundary','tail-overlap','release-boundary'].includes(strategy)
          ? strategy as PlaybackInfo['autoMixStrategy'] : '' } }
  }
  async submit(id: number): Promise<boolean> {
    const tx = this.transaction, revision = this.revision
    if (!tx || tx.id !== id || tx.phase !== 'ready') throw new Error('stale_preparation_ticket')
    this.current(tx.context, revision)
    // Recheck every native preparation ID immediately before committing any.
    const statuses = await Promise.all(this.ports().map(p => p.status())); this.current(tx.context, revision)
    if (statuses.some((s, i) => s.autoMixState !== 'ready' || s.autoMixPlanId !== tx.nativeIds[i])) throw new Error('stale_preparation_ticket')
    const states = await this.owner.states(); this.current(tx.context, revision)
    if (states.some(s => !s.sourceTimeline || s.sourceTimeline.entryId !== tx.context.currentEntry ||
        tx.plan.currentStartFrame/tx.plan.sampleRate-s.sourceTimeline.positionFrames/s.sourceTimeline.sampleRate < .5))
      throw new Error('preparation_missed_boundary')
    tx.phase = 'submitted'
    const results = await Promise.allSettled(this.ports().map((p, i) => p.submit(tx.nativeIds[i])))
    if (results.some(r => r.status === 'rejected' || !r.value)) {
      const error = new Error('同步组 AutoMix 提交不一致或结果未知，全部输出已暂停')
      await this.owner.fail(error); throw error
    }
    this.current(tx.context, revision)
    return true
  }
  async cancel(): Promise<boolean> {
    ++this.revision; this.transaction = null
    await this.cancelPorts(this.owner.outputs.flatMap(o => o.autoMix ? [o.autoMix] : []))
    return true
  }
  private async cancelPorts(ports: SyncGroupAutoMixOutput[]): Promise<void> {
    const results = await Promise.allSettled(ports.map(p => p.cancel()))
    if (results.some(r => r.status === 'rejected' || !r.value)) {
      // The owner also silences independently; cancellation cannot leave a
      // possibly armed deck running while reporting a harmless fallback.
      throw Object.assign(new Error('同步组 AutoMix 撤销未确认'), { code: 'CANCEL_UNCONFIRMED' })
    }
  }
}
