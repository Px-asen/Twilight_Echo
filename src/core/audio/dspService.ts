import { coreFsPromises } from '../ports/index.ts'

const { readFile, stat } = coreFsPromises
import type {
  AudioProcessingSettings,
  ConvolverInfo,
  EqualizerBand,
  PlaybackInfo
} from '../../shared/audioEngineTypes.ts'
import type { AppSettings } from '../../shared/appSettings.ts'
import type { CoreStateApi } from '../../shared/coreState.ts'
import { computeAutoPreampDb, EQ_RESPONSE_DEFAULT_SAMPLE_RATE } from '../../shared/eqResponse.ts'
import { importedEqualizerAutoPreamp } from '../../shared/equalizerPreferences.ts'
import type {
  CoreDspEdit,
  CoreDspImport,
  CoreDspState,
  CoreVst3Edit,
  CoreVst3Page,
  CoreVst3Parameters
} from '../../shared/coreDsp.ts'
import type { CorePlatformOperations } from '../../shared/corePlatform.ts'
import type {
  DspGraphStatus,
  DspScene,
  DspSceneState,
  DspOutputStageConfig,
  DspStereoImageConfig
} from '../../shared/dspGraph.ts'
import { normalizeDspScenes } from '../../shared/dspGraph.ts'
import {
  normalizeAudioProcessingSettings,
  resolveProcessingMasterState
} from './audioEngineHelpers.ts'
import {
  buildEffectiveAudioProcessingSettings,
  normalizeHeadphoneCompensationSettings
} from './audioProcessingEffective.ts'
import type { CoreAudioOutputService } from './outputService.ts'
import type { CoreSettingsRepository } from '../persistence/settingsRepository.ts'
import type { DspAssetLibrary } from './dspAssetLibrary.ts'
import type { Vst3CatalogService } from './vst3Catalog.ts'
import {
  collectDspAssetIds,
  createDspProfile,
  exportDspProfileArchive,
  importDspProfileArchive
} from './dspProfileArchive.ts'
import { importCorrectionProfileFile, parseCorrectionProfileFile } from './correctionProfile.ts'
import { importFrequencyResponseFromDialog } from './importFrequencyResponse.ts'

export interface CoreDspEngine {
  configureDsp<T>(operation: (configuration: CoreDspConfiguration) => Promise<T>): Promise<T>
  getAudioProcessing(): AudioProcessingSettings
  setAudioProcessing(settings: Partial<AudioProcessingSettings>): Promise<AudioProcessingSettings>
  getDspSceneState(): DspSceneState
  setDspScenes(scenes: DspScene[], pin: string | null): Promise<DspSceneState>
  setOutputStage(settings: Partial<DspOutputStageConfig>): Promise<DspSceneState>
  setStereoImage(settings: Partial<DspStereoImageConfig>): Promise<DspSceneState>
  applyDspScene(id: string | null, confirm?: boolean): Promise<DspSceneState>
  getDspGraphStatus(): Promise<DspGraphStatus>
  getConvolverInfo(): ConvolverInfo
  refreshDspGraph(): void
  clearVst3RecoveryBypass(id: string): void
  stop(): Promise<void>
}
export type CoreDspConfiguration = Pick<
  CoreDspEngine,
  | 'getAudioProcessing'
  | 'setAudioProcessing'
  | 'getDspSceneState'
  | 'setDspScenes'
  | 'setOutputStage'
  | 'setStereoImage'
  | 'applyDspScene'
> & { checkpointConfiguration(): () => Promise<void> }
export interface CoreDspPlatform {
  call<K extends keyof CorePlatformOperations>(
    name: K,
    payload: CorePlatformOperations[K]['input'],
    signal?: AbortSignal
  ): Promise<CorePlatformOperations[K]['output']>
}

/** Owns DSP configuration and repositories; native retains graph compilation/rendering. */
export class CoreDspService {
  private readonly background = new Set<Promise<void>>()
  private active = false
  private sampleRate = EQ_RESPONSE_DEFAULT_SAMPLE_RATE
  private observedScene: string | null = null
  private compensationPending = false
  private compensationVersion = 0
  private readonly options: {
    engine: CoreDspEngine
    configuration: CoreAudioOutputService
    settings: CoreSettingsRepository
    preferences: Pick<CoreStateApi, 'coreStateRead'>
    assets: DspAssetLibrary
    catalog: Vst3CatalogService
    platform: CoreDspPlatform
    temporaryDirectory: string
    now(): number
    newId(): string
    failed(error: unknown): void
  }
  constructor(options: CoreDspService['options']) {
    this.options = options
  }
  async initialize(): Promise<void> {
    await this.options.assets.initialize()
    await this.options.catalog.initialize()
    await this.options.platform.call('dsp.registerVst3Paths', {
      paths: (await this.options.catalog.getState()).searchPaths
    })
    await this.reconcile()
    this.options.engine.refreshDspGraph()
  }
  /** Browser import must finish before its EQ preference becomes effective. */
  async activate(): Promise<void> {
    await this.options.configuration.serialize(async () => {
      const stored = this.options.settings.read().audioEqAutoPreamp
      const preference =
        stored ??
        importedEqualizerAutoPreamp(
          (await this.options.preferences.coreStateRead('eq-preferences')).rows
        )
      if (preference.enabled) {
        await this.commit(async (engine) => ({
          ...(await this.compensate(engine)),
          ...(!stored ? { audioEqAutoPreamp: preference } : {})
        }))
      } else if (!stored) this.options.settings.update({ audioEqAutoPreamp: preference })
      this.observedScene = this.options.engine.getDspSceneState().activeSceneId
      this.active = true
    })
  }
  observePlayback(info: PlaybackInfo): void {
    const rate =
      info.outputInfo.actualSampleRate || info.outputSampleRate || EQ_RESPONSE_DEFAULT_SAMPLE_RATE
    const scene = this.options.engine.getDspSceneState().activeSceneId
    if (rate === this.sampleRate && scene === this.observedScene) return
    this.sampleRate = rate
    this.observedScene = scene
    this.compensationVersion++
    if (!this.active || this.compensationPending) return
    this.compensationPending = true
    const task = this.options.configuration.serialize(async () => {
      try {
        let version: number
        do {
          version = this.compensationVersion
          if (this.options.settings.read().audioEqAutoPreamp?.enabled)
            await this.commit((engine) => this.compensate(engine))
        } while (this.active && version !== this.compensationVersion)
      } finally {
        this.compensationPending = false
      }
    })
    this.background.add(task)
    void task
      .catch((error) => this.options.failed(error))
      .finally(() => this.background.delete(task))
  }
  private reconcile(scenes = this.options.settings.read().dspScenes): Promise<void> {
    return this.options.assets.reconcileReferences(collectDspAssetIds(scenes))
  }
  state(): Promise<CoreDspState> {
    return this.options.configuration.serialize(async () =>
      structuredClone({
        revision: this.options.configuration.getRevision(),
        processing: this.options.settings.read().audioProcessing,
        autoPreamp: this.options.settings.read().audioEqAutoPreamp,
        headphoneCompensation: this.options.settings.read().headphoneCompensation,
        scenes: this.options.engine.getDspSceneState(),
        convolver: this.options.engine.getConvolverInfo()
      })
    )
  }
  status(): Promise<DspGraphStatus> {
    return this.options.engine.getDspGraphStatus()
  }
  private async authorizeScenes(scenes: DspScene[], signal?: AbortSignal): Promise<DspScene[]> {
    const result = normalizeDspScenes(scenes, this.options.settings.read().audioProcessing)
    for (const scene of result)
      for (const node of scene.graph.nodes) {
        const path = node.params.impulseResponsePath
        if (node.params.impulseResponseAssetId) {
          const asset = await this.options.assets.get(String(node.params.impulseResponseAssetId))
          if (asset?.kind !== 'impulseResponse')
            throw new Error('Managed impulse response not found')
          await this.options.assets.getPath(asset.id)
          delete node.params.impulseResponsePath
        } else if (typeof path === 'string' && path)
          node.params.impulseResponsePath = await this.options.platform.call(
            'dsp.authorizeImpulse',
            { path },
            signal
          )
      }
    return result
  }
  /** Settings import shares the output lane; authorization precedes every native mutation. */
  async prepareSettingsRestore(next: AppSettings, signal: AbortSignal): Promise<AppSettings> {
    const audioProcessing = { ...next.audioProcessing }
    if (audioProcessing.convolverIrPath)
      audioProcessing.convolverIrPath = await this.options.platform.call(
        'dsp.authorizeImpulse',
        { path: audioProcessing.convolverIrPath },
        signal
      )
    const dspScenes = await this.authorizeScenes(next.dspScenes, signal)
    signal.throwIfAborted()
    return { ...next, audioProcessing, dspScenes }
  }
  async restoreSettings(next: AppSettings): Promise<Partial<AppSettings>> {
    const previous = this.options.settings.read()
    const fields = [
      'audioProcessing',
      'headphoneCompensation',
      'dspScenes',
      'dspPinnedSceneId',
      'audioEqAutoPreamp'
    ] as const
    if (fields.every((field) => JSON.stringify(previous[field]) === JSON.stringify(next[field])))
      return Object.fromEntries(fields.map((field) => [field, previous[field]]))
    let patch: Partial<AppSettings> = {}
    await this.commit(async (engine) => {
      await engine.setAudioProcessing(
        buildEffectiveAudioProcessingSettings(next.audioProcessing, next.headphoneCompensation)
      )
      const state = await engine.setDspScenes(next.dspScenes, next.dspPinnedSceneId)
      patch = {
        audioProcessing: next.audioProcessing,
        headphoneCompensation: next.headphoneCompensation,
        dspScenes: state.scenes,
        dspPinnedSceneId: state.pinnedSceneId,
        audioEqAutoPreamp: next.audioEqAutoPreamp
      }
      return patch
    })
    return patch
  }
  private async commit(
    action: (engine: CoreDspConfiguration) => Promise<Partial<AppSettings>>
  ): Promise<void> {
    return this.options.engine.configureDsp(async (engine) => {
      const rollback = engine.checkpointConfiguration()
      try {
        const patch = await action(engine)
        if (!Object.keys(patch).length) return
        await this.reconcile(patch.dspScenes ?? this.options.settings.read().dspScenes)
        this.options.settings.update(patch)
      } catch (error) {
        try {
          await rollback()
          await this.reconcile()
        } catch {
          await this.options.engine.stop()
        }
        throw error
      }
    })
  }
  private editableProcessing(engine: CoreDspConfiguration): AudioProcessingSettings {
    const settings = this.options.settings.read()
    const state = engine.getDspSceneState()
    if (settings.headphoneCompensation.enabled && settings.headphoneCompensation.bands.length)
      return settings.audioProcessing
    const scene = state.scenes.find((scene) => scene.id === state.activeSceneId)
    if (!scene) return settings.audioProcessing
    const node = scene.graph.nodes.find((node) => node.type === 'equalizer')
    return normalizeAudioProcessingSettings({
      ...settings.audioProcessing,
      eqEnabled:
        scene.id === 'default' && !settings.audioProcessing.dspEnabled
          ? settings.audioProcessing.eqEnabled
          : (node?.enabled ?? false),
      eqMode: node?.params.mode === 'graphic' ? 'graphic' : 'parametric',
      eqPreamp: typeof node?.params.preampDb === 'number' ? node.params.preampDb : 0,
      eqBands: (node?.params.bands as EqualizerBand[] | undefined) ?? []
    })
  }
  private target(processing: AudioProcessingSettings): number {
    return computeAutoPreampDb(processing.eqBands, {
      sampleRate: this.sampleRate,
      mode: processing.eqMode
    })
  }
  private async applyProcessing(
    engine: CoreDspConfiguration,
    processing: AudioProcessingSettings,
    equalizer: boolean,
    compensation = this.options.settings.read().headphoneCompensation
  ): Promise<Partial<AppSettings>> {
    await engine.setAudioProcessing(buildEffectiveAudioProcessingSettings(processing, compensation))
    let state = structuredClone(engine.getDspSceneState())
    const scene = state.scenes.find((scene) => scene.id === state.activeSceneId)
    if (equalizer && scene && scene.id !== 'default') {
      let node = scene.graph.nodes.find((node) => node.type === 'equalizer')
      if (!node) {
        node = {
          id: `equalizer-${this.options.newId()}`,
          type: 'equalizer',
          enabled: false,
          params: {}
        }
        const tail = scene.graph.nodes.findIndex(
          (item) => item.type === 'nativePlugin' && item.pluginAbiVersion === 1
        )
        scene.graph.nodes.splice(tail < 0 ? scene.graph.nodes.length : tail, 0, node)
      }
      const stacked = compensation.enabled && compensation.bands.length > 0
      node.enabled = processing.dspEnabled && processing.eqEnabled
      node.params = {
        ...node.params,
        mode: stacked ? 'parametric' : processing.eqMode,
        preampDb: processing.eqPreamp + (stacked ? compensation.preampDb : 0),
        bands: stacked ? [...compensation.bands, ...processing.eqBands] : processing.eqBands
      }
      state = await engine.setDspScenes(state.scenes, state.pinnedSceneId)
    }
    return {
      audioProcessing: processing,
      dspScenes: state.scenes,
      dspPinnedSceneId: state.pinnedSceneId
    }
  }
  private async compensate(engine: CoreDspConfiguration): Promise<Partial<AppSettings>> {
    const processing = this.editableProcessing(engine)
    const target = this.target(processing)
    if (Math.abs(processing.eqPreamp - target) < 0.05) return {}
    return this.applyProcessing(engine, { ...processing, eqPreamp: target }, true)
  }
  edit(request: CoreDspEdit, signal: AbortSignal): Promise<void> {
    return this.options.configuration.run(request.revision, signal, async () => {
      const edit = request.edit
      const scenes = edit.kind === 'scenes' ? await this.authorizeScenes(edit.scenes) : null
      let impulsePath: string | undefined
      if (edit.kind === 'processing') {
        const processing = normalizeAudioProcessingSettings({
          ...this.options.settings.read().audioProcessing,
          ...edit.settings
        })
        impulsePath = processing.convolverIrPath
          ? await this.options.platform.call('dsp.authorizeImpulse', {
              path: processing.convolverIrPath
            })
          : ''
      }
      return this.commit(async (engine) => {
        const settings = this.options.settings.read()
        const edit = request.edit
        const preference = settings.audioEqAutoPreamp ?? { enabled: false, manualDb: null }
        if (edit.kind === 'autoPreamp') {
          if (preference.enabled === edit.enabled) return {}
          const processing = this.editableProcessing(engine)
          const preamp = edit.enabled
            ? this.target(processing)
            : (preference.manualDb ?? processing.eqPreamp)
          return {
            ...(await this.applyProcessing(engine, { ...processing, eqPreamp: preamp }, true)),
            audioEqAutoPreamp: {
              enabled: edit.enabled,
              manualDb: edit.enabled ? processing.eqPreamp : null
            }
          }
        }
        if (edit.kind === 'headphoneCompensation') {
          const compensation = normalizeHeadphoneCompensationSettings({
            ...settings.headphoneCompensation,
            ...edit.settings
          })
          const processing = this.editableProcessing(engine)
          return {
            ...(await this.applyProcessing(engine, processing, true, compensation)),
            headphoneCompensation: compensation
          }
        }
        if (edit.kind === 'processing') {
          const eqTouched = ['eqEnabled', 'eqMode', 'eqPreamp', 'eqBands'].some((key) =>
            Object.hasOwn(edit.settings, key)
          )
          const merged = normalizeAudioProcessingSettings({
            ...(eqTouched ? this.editableProcessing(engine) : settings.audioProcessing),
            ...edit.settings
          })
          const switches = resolveProcessingMasterState(
            merged,
            edit.settings.dspEnabled,
            edit.settings.directMode
          )
          const processing = normalizeAudioProcessingSettings({ ...merged, ...switches })
          processing.convolverIrPath = impulsePath!
          const manual = edit.settings.eqPreamp !== undefined
          if (preference.enabled && eqTouched && !manual)
            processing.eqPreamp = this.target(processing)
          return {
            ...(await this.applyProcessing(engine, processing, eqTouched)),
            ...(manual ? { audioEqAutoPreamp: { enabled: false, manualDb: null } } : {})
          }
        }
        let state: DspSceneState
        switch (edit.kind) {
          case 'scenes':
            state = await engine.setDspScenes(scenes!, edit.pinnedSceneId)
            break
          case 'apply':
            state = await engine.applyDspScene(edit.id, edit.confirmDsdPcmFallback)
            break
          case 'outputStage':
            state = await engine.setOutputStage(edit.settings)
            break
          case 'stereoImage':
            state = await engine.setStereoImage(edit.settings)
            break
        }
        const compensated = preference.enabled ? await this.compensate(engine) : {}
        return {
          dspScenes: state.scenes,
          dspPinnedSceneId: state.pinnedSceneId,
          ...compensated
        }
      })
    })
  }
  assets(offset = 0, limit = 200) {
    return this.options.configuration.serialize(async () => {
      const all = await this.options.assets.list()
      return {
        revision: this.options.configuration.getRevision(),
        total: all.length,
        items: all.slice(offset, offset + limit)
      }
    })
  }
  correction(id: string) {
    return this.options.configuration.serialize(async () => {
      const asset = await this.options.assets.get(id)
      if (asset?.kind !== 'correctionProfile') throw new Error('DSP correction asset not found')
      return parseCorrectionProfileFile(await this.options.assets.getPath(id))
    })
  }
  removeAsset(revision: number, id: string, signal: AbortSignal): Promise<void> {
    return this.options.configuration.run(revision, signal, async () => {
      await this.reconcile()
      await this.options.assets.remove(id)
    })
  }
  async import(request: CoreDspImport, signal: AbortSignal): Promise<unknown> {
    const path = await this.options.platform.call('dsp.chooseFile', { kind: request.kind }, signal)
    if (!path) return null
    return this.options.configuration.run(request.revision, signal, async () => {
      if (request.kind === 'impulsePath') return path
      if (request.kind === 'frequencyResponse')
        return importFrequencyResponseFromDialog(
          { canceled: false, filePaths: [path] },
          (file) => readFile(file, 'utf8'),
          async (file) => (await stat(file)).size
        )
      if (request.kind === 'profile') {
        const imported = await importDspProfileArchive(
          path,
          this.options.assets,
          this.options.temporaryDirectory
        )
        await this.commit(async (engine) => {
          const scenes = await this.authorizeScenes(imported.profile.scenes)
          const state = await engine.setDspScenes(scenes, imported.profile.pinnedSceneId)
          const compensated = this.options.settings.read().audioEqAutoPreamp?.enabled
            ? await this.compensate(engine)
            : {}
          return { dspScenes: state.scenes, dspPinnedSceneId: state.pinnedSceneId, ...compensated }
        })
        return imported
      }
      if (request.kind === 'correctionProfile')
        return importCorrectionProfileFile(path, this.options.assets)
      return this.options.assets.importFile({ kind: request.kind, sourcePath: path })
    })
  }
  async export(revision: number, name: string, signal: AbortSignal): Promise<unknown> {
    const path = await this.options.platform.call('dsp.chooseExportFile', {}, signal)
    if (!path) return null
    return this.options.configuration.run(revision, signal, async () => {
      const settings = this.options.settings.read()
      const profile = createDspProfile({
        name,
        scenes: settings.dspScenes,
        pinnedSceneId: settings.dspPinnedSceneId,
        assetIds: collectDspAssetIds(settings.dspScenes),
        id: this.options.newId(),
        now: new Date(this.options.now())
      })
      await exportDspProfileArchive({ outputPath: path, profile }, this.options.assets)
      return profile
    })
  }
  async vst3(offset = 0, limit = 200): Promise<CoreVst3Page> {
    const state = await this.options.catalog.getState()
    return {
      revision: this.options.configuration.getRevision(),
      enabled: state.enabled,
      searchPaths: state.searchPaths,
      helpers: state.helpers,
      total: state.entries.length,
      items: state.entries
        .slice(offset, offset + limit)
        .map(({ parameters: _parameters, ...entry }) => entry)
    }
  }
  async parameters(
    id: string,
    revision: number,
    offset = 0,
    limit = 200
  ): Promise<CoreVst3Parameters> {
    const entry = await this.options.catalog.find(id)
    if (revision !== this.options.configuration.getRevision())
      throw Object.assign(new Error('Audio configuration changed'), { code: 'STALE_REVISION' })
    if (!entry) throw new Error('VST3 module not found')
    return {
      revision,
      total: entry.parameters.length,
      items: entry.parameters.slice(offset, offset + limit)
    }
  }
  chooseDirectory(signal: AbortSignal): Promise<string | null> {
    return this.options.platform.call('dsp.chooseVst3Directory', {}, signal)
  }
  async editVst3(request: CoreVst3Edit, signal: AbortSignal): Promise<void> {
    // Catalog IO (including the scanner helper) runs outside the playback/configuration lane.
    let work: Promise<unknown> = Promise.resolve()
    await this.options.configuration.run(request.revision, signal, async () => {
      const catalog = this.options.catalog
      const edit = request.edit
      if (edit.kind === 'enabled') work = catalog.setEnabled(edit.enabled)
      else if (edit.kind === 'searchPaths') {
        const paths = await this.options.platform.call('dsp.authorizeVst3Paths', {
          paths: edit.paths
        })
        work = catalog.setSearchPaths(paths)
      } else if (edit.kind === 'scan') work = catalog.scan()
      else
        work = (async () => {
          await catalog.clearQuarantine(edit.id)
          const state = await catalog.scan()
          if (state.entries.find((entry) => entry.id === edit.id)?.status === 'available')
            this.options.engine.clearVst3RecoveryBypass(edit.id)
        })()
    })
    try {
      await work
    } finally {
      await this.options.configuration.serialize(async () => {
        this.options.engine.refreshDspGraph()
        this.options.configuration.changed()
      })
    }
  }
  quarantineActive(reason: string): Promise<void> {
    const task = this.quarantine(reason)
    this.background.add(task)
    void task.finally(() => this.background.delete(task)).catch(() => {})
    return task
  }
  async flush(): Promise<void> {
    await Promise.all([...this.background])
  }
  async shutdown(): Promise<void> {
    this.active = false
    await this.flush()
  }
  private async quarantine(reason: string): Promise<void> {
    const ids = new Set(
      this.options.engine
        .getDspSceneState()
        .graph.nodes.filter((node) => node.type === 'vst3Plugin')
        .map((node) => node.vst3?.catalogId)
        .filter((id): id is string => !!id)
    )
    for (const id of ids) await this.options.catalog.quarantine(id, `音频服务崩溃后旁路：${reason}`)
    this.options.engine.refreshDspGraph()
    this.options.configuration.changed()
  }
}
