import { join } from '../../shared/portablePath.ts'
import type { AppSettings } from '../../shared/appSettings.ts'
import type { CoreAutoMixCapabilities } from '../../shared/coreAutoMix.ts'
import type { CorePlatformOperations } from '../../shared/corePlatform.ts'
import { normalizeAutoMixStemDevice } from '../../shared/twilightAutoMix.ts'
import { AutoMixStemDetector } from './autoMixStemCapabilities.ts'
import { AutoMixStemService } from './autoMixStemService.ts'
import { TwilightAutoMixWindowCache } from './twilightAutoMixCache.ts'
import {
  TwilightAutoMixCoordinator,
  type TwilightAutoMixCoordinatorDependencies
} from './twilightAutoMixCoordinator.ts'
import type { ProviderPlaybackIdentityRegistry } from './providerPlaybackIdentity.ts'
import type { AutoMixMaterialHost } from './autoMixMaterials.ts'

export interface CoreAutoMixOptions {
  root: string
  settings(): Pick<AppSettings, 'autoMixStemMode' | 'autoMixStemDevice' | 'autoMixStemCacheMiB'>
  engine: {
    setAutoMixCoordinator(coordinator: TwilightAutoMixCoordinator | null): void
    getAutoMixContext: TwilightAutoMixCoordinatorDependencies['context']
    selectAutoMix: NonNullable<TwilightAutoMixCoordinatorDependencies['select']>
    prepareAutoMix: TwilightAutoMixCoordinatorDependencies['prepare']
    submitAutoMix: TwilightAutoMixCoordinatorDependencies['submit']
    cancelAutoMix: TwilightAutoMixCoordinatorDependencies['cancel']
    getAutoMixNativeStatus: TwilightAutoMixCoordinatorDependencies['status']
    reportAutoMixAnalysisState: NonNullable<TwilightAutoMixCoordinatorDependencies['onState']>
    clearAutoMixAnalysisState(): void
    invalidateAutoMixSource(): void
    autoMixMaterials?: AutoMixMaterialHost
    autoMixCommitMarginSeconds?: number
  }
  authorize: TwilightAutoMixCoordinatorDependencies['authorize']
  analysis: {
    analyze: TwilightAutoMixCoordinatorDependencies['analyze']
    cancel: TwilightAutoMixCoordinatorDependencies['cancelAnalysis']
  }
  identities: ProviderPlaybackIdentityRegistry
  useSources<T>(action: () => Promise<T>): Promise<T>
  environment(): Promise<CorePlatformOperations['automix.environment']['output']>
  probe(
    directory: string,
    signal: AbortSignal
  ): Promise<CorePlatformOperations['automix.probe']['output']>
  runWorker(
    request: CorePlatformOperations['automix.runWorker']['input'],
    signal: AbortSignal
  ): Promise<void>
  now(): number
}

/** Preparation belongs to the same native session, not to an attached window. */
export class CoreAutoMixService {
  private readonly coordinator: TwilightAutoMixCoordinator
  private readonly lifetime = new AbortController()
  private materials: Promise<{
    detector: AutoMixStemDetector
    service: AutoMixStemService
  }> | null = null
  private environment: CorePlatformOperations['automix.environment']['output'] | null = null
  private active = false
  private readonly options: CoreAutoMixOptions
  constructor(options: CoreAutoMixOptions) {
    this.options = options
    const engine = options.engine
    this.coordinator = new TwilightAutoMixCoordinator({
      context: () => engine.getAutoMixContext(),
      authorize: options.authorize,
      analyze: options.analysis.analyze,
      cancelAnalysis: options.analysis.cancel,
      scopedCancellation: true,
      commitMarginSeconds: engine.autoMixCommitMarginSeconds,
      sourceRevision: (source) => options.identities.revision(source),
      assertSource: (source) => options.identities.assertCurrent(source),
      select: async (request) => {
        if (options.settings().autoMixStemMode === 'off') return engine.selectAutoMix(request)
        const { service } = await this.stems()
        return engine.autoMixMaterials
          ? engine.autoMixMaterials.select(request, { select: (json, native) => service.select(json, native), release: selection => service.release(selection) })
          : service.select(request, json => engine.selectAutoMix(json))
      },
      stems: async (selection, _request, signal) => {
        if (options.settings().autoMixStemMode === 'off') return null
        const { service } = await this.stems()
        const prepare = (member: typeof selection) => service.prepare(member, () => engine.getAutoMixContext()?.info.position ?? 0, signal)
        return engine.autoMixMaterials ? engine.autoMixMaterials.prepare(selection, prepare) : prepare(selection)
      },
      releaseMaterials: async (selection) => {
        if (engine.autoMixMaterials) await engine.autoMixMaterials.release(selection)
        else if (this.materials) await (await this.materials).service.release(selection)
      },
      prepare: (request) => engine.prepareAutoMix(request),
      submit: (id) => engine.submitAutoMix(id),
      cancel: () => engine.cancelAutoMix(),
      status: () => engine.getAutoMixNativeStatus(),
      onState: (state, reason) => engine.reportAutoMixAnalysisState(state, reason),
      onNativePreparation: () => engine.clearAutoMixAnalysisState(),
      cache: new TwilightAutoMixWindowCache(join(options.root, 'twilight-automix-windows.json')),
      useSources: options.useSources,
      now: options.now
    })
  }
  private stems() {
    return (this.materials ??= this.options
      .environment()
      .then((environment) => {
        this.lifetime.signal.throwIfAborted()
        this.environment = environment
        const detector = new AutoMixStemDetector(
          () => this.environment!.candidates,
          () => environment.workerDirectory,
          (directory) => this.options.probe(directory, this.lifetime.signal)
        )
        const service = new AutoMixStemService({
          cacheDirectory: join(this.options.root, 'automix-stems-v2'),
          pack: () =>
            detector.resolveDevice(
              normalizeAutoMixStemDevice(this.options.settings().autoMixStemDevice)
            ),
          enabled: () => this.options.settings().autoMixStemMode === 'auto',
          cacheMiB: () => this.options.settings().autoMixStemCacheMiB,
          device: () => this.options.settings().autoMixStemDevice,
          workerDirectory: () => environment.workerDirectory,
          temporaryDirectory: environment.temporaryDirectory,
          runWorker: (packDirectory, _worker, requestPath, budgetMs, signal) =>
            this.options.runWorker({ packDirectory, requestPath, budgetMs }, signal)
        })
        return { detector, service }
      })
      .catch((error) => {
        this.materials = null
        throw error
      }))
  }
  private readonly sourceChanged = (sources: string[]) => {
    const context = this.options.engine.getAutoMixContext()
    if (
      context &&
      sources.some((source) => source === context.current.source || source === context.next.source)
    )
      this.options.engine.invalidateAutoMixSource()
  }
  activate(): void {
    this.lifetime.signal.throwIfAborted()
    this.active = true
    this.options.identities.on('changed', this.sourceChanged)
    this.options.engine.setAutoMixCoordinator(this.coordinator)
  }
  async capabilities(refresh: boolean): Promise<CoreAutoMixCapabilities> {
    // Refresh discovery without disrupting an accepted native transition plan.
    if (refresh && this.environment) this.environment = await this.options.environment()
    const state = await (await this.stems()).detector.get(refresh)
    return { ...state, packs: state.packs.map(({ cpu, gpu, gpuName }) => ({ cpu, gpu, gpuName })) }
  }
  async maintain<T>(action: () => Promise<T>): Promise<T> {
    if (!this.active) return action()
    await this.coordinator.suspend()
    try {
      return await action()
    } finally {
      this.coordinator.resume()
    }
  }
  async shutdown(): Promise<void> {
    this.active = false
    this.options.identities.off('changed', this.sourceChanged)
    this.options.engine.setAutoMixCoordinator(null)
    this.lifetime.abort(new Error('Core AutoMix is shutting down'))
    await this.coordinator.shutdown()
    await this.materials?.catch(() => {})
  }
}
