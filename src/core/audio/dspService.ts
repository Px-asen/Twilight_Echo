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
import { authorizeDspScenes, authorizeDspSettings } from './dspSettingsAuthorization.ts'
import { lexicalPathKey } from '../persistence/pathGrants.ts'
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
import { createDspFactoryScene, type DspGraphNode } from '../../shared/dspGraph.ts'
import { DSP_UPLOAD_MAX_BYTES, type DspLibraryEdit, type DspLibraryPage, type DspUploadBegin, type DspParameterPage } from '../../shared/dspLibrary.ts'
import { DspUploads } from './dspUploads.ts'
import { DspProfiles } from './dspProfiles.ts'
import { join } from '../../shared/portablePath.ts'

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
  private readonly uploads: DspUploads
  private readonly profiles: DspProfiles
  private scanning = false
  private scanFailed = false
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
    uploadDirectory?: string
    hostSearchPaths?: string[]
    now(): number
    newId(): string
    failed(error: unknown): void
  }
  constructor(options: CoreDspService['options']) {
    this.options = options
    const staging = options.uploadDirectory ?? join(options.temporaryDirectory, `twilight-dsp-upload-${options.newId()}`)
    this.uploads = new DspUploads(staging, options.now, options.newId, coreFsPromises)
    this.profiles = new DspProfiles({ root: join(staging, 'profiles'), now: options.now, newId: options.newId, catalog: options.catalog, files: coreFsPromises })
  }
  async initialize(): Promise<void> {
    await this.uploads.initialize()
    await this.profiles.initialize()
    await this.options.assets.initialize()
    await this.options.catalog.initialize()
    if (this.options.hostSearchPaths) {
      const paths = await this.options.platform.call('dsp.authorizeVst3Paths', { paths: this.options.hostSearchPaths })
      await this.options.catalog.setSearchPaths(paths, true)
    }
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
  private async reconcile(
    scenes = this.options.settings.read().dspScenes,
    processing = this.options.settings.read().audioProcessing
  ): Promise<void> {
    const ids = new Set(collectDspAssetIds(scenes))
    if (processing.convolverIrPath) {
      const path = lexicalPathKey(processing.convolverIrPath)
      for (const asset of await this.options.assets.list()) {
        const owned = this.options.assets.getKnownPath(asset.id)
        if (asset.kind === 'impulseResponse' && owned && lexicalPathKey(owned) === path)
          ids.add(asset.id)
      }
    }
    await this.options.assets.reconcileReferences(ids)
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
    return authorizeDspScenes(
      scenes,
      this.options.settings.read().audioProcessing,
      this.options.assets,
      (path) => this.authorizeImpulse(path, signal)
    )
  }
  private async authorizeImpulse(path: string, signal?: AbortSignal): Promise<string> {
    for (const asset of await this.options.assets.list()) {
      const owned = this.options.assets.getKnownPath(asset.id)
      if (asset.kind === 'impulseResponse' && owned && lexicalPathKey(owned) === lexicalPathKey(path))
        return this.options.assets.getPath(asset.id)
    }
    return this.options.platform.call('dsp.authorizeImpulse', { path }, signal)
  }
  /** Settings import shares the output lane; authorization precedes every native mutation. */
  async prepareSettingsRestore(next: AppSettings, signal: AbortSignal): Promise<AppSettings> {
    const authorized = await authorizeDspSettings(next, this.options.assets, (path) =>
      this.authorizeImpulse(path, signal)
    )
    signal.throwIfAborted()
    return authorized
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
        await this.reconcile(
          patch.dspScenes ?? this.options.settings.read().dspScenes,
          patch.audioProcessing ?? this.options.settings.read().audioProcessing
        )
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
          ? await this.authorizeImpulse(processing.convolverIrPath, signal)
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
  library(assetOffset = 0, pluginOffset = 0, revision?: number): Promise<DspLibraryPage> {
    return this.options.configuration.serialize(async () => {
      if (revision !== undefined && revision !== this.options.configuration.getRevision())
        throw Object.assign(new Error('DSP library changed'), { code: 'STALE_REVISION' })
      const assets = await this.options.assets.list()
      const catalog = await this.options.catalog.getState()
      const state = this.options.engine.getDspSceneState()
      return {
        revision: this.options.configuration.getRevision(),
        assets: { total: assets.length, offset: assetOffset, items: assets.slice(assetOffset, assetOffset + 100) },
        plugins: { total: catalog.entries.length, offset: pluginOffset, items: catalog.entries.slice(pluginOffset, pluginOffset + 100)
          .map(({ id, name, vendor, version, status, parameters }) => ({ id, name, vendor, version, status, parameterCount: parameters.length })) },
        scenes: state.scenes.map(scene => ({ id: scene.id, name: scene.name, active: scene.id === state.activeSceneId,
          pinned: scene.id === state.pinnedSceneId, nodes: scene.graph.nodes.map(node => ({
            id: node.id, type: node.type, enabled: node.enabled,
            assetId: typeof node.params.impulseResponseAssetId === 'string' && node.params.impulseResponseAssetId
              ? node.params.impulseResponseAssetId : typeof node.params.correctionAssetId === 'string' && node.params.correctionAssetId
                ? node.params.correctionAssetId : node.vst3?.stateAssetId ?? null,
            catalogId: node.vst3?.catalogId ?? null })) })),
        vst3Enabled: catalog.enabled, scanning: this.scanning, scanFailed: this.scanFailed,
        searchRootCount: catalog.searchPaths.length, helpers: this.options.catalog.getHelpersAvailability(),
        maxUploadBytes: DSP_UPLOAD_MAX_BYTES
      }
    })
  }
  beginUpload(owner: string, input: DspUploadBegin) { return this.uploads.begin(owner, input) }
  uploadChunk(owner: string, id: string, offset: number, data: string) { return this.uploads.chunk(owner, id, offset, data) }
  async cancelUpload(owner: string, id: string) {
    await this.options.configuration.serialize(() => this.profiles.cancel(owner, id))
    return this.uploads.cancel(owner, id)
  }
  async disconnectUploads(owner: string) {
    await this.uploads.disconnect(owner)
    return this.options.configuration.serialize(() => this.profiles.disconnect(owner))
  }
  isPluginScanActive() { return this.scanning }
  commitUpload(owner: string, id: string, revision: number, signal: AbortSignal) {
    return this.uploads.consume(owner, id, (path, input) => this.options.configuration.run(revision, signal, async () => {
      if (input.kind === 'profile') throw new Error('请先预览配置包，再确认导入')
      if (input.kind === 'correctionProfile') await parseCorrectionProfileFile(path)
      signal.throwIfAborted()
      return this.options.assets.importFile({ kind: input.kind, sourcePath: path, fileName: input.fileName, name: input.fileName })
    }))
  }
  private requireRevision(revision: number, signal: AbortSignal) {
    signal.throwIfAborted()
    if (revision !== this.options.configuration.getRevision()) throw Object.assign(new Error('音频设置已改变，请刷新'), { code: 'STALE_REVISION' })
  }
  previewProfile(owner: string, uploadId: string, revision: number, signal: AbortSignal) {
    return this.uploads.inspect(owner, uploadId, (path, input) => this.options.configuration.serialize(async () => {
      this.requireRevision(revision, signal)
      if (input.kind !== 'profile') throw new Error('请选择 .tedsp 配置包')
      return this.profiles.preview(owner, uploadId, path, revision, signal)
    }))
  }
  importProfile(owner: string, uploadId: string, previewId: string, revision: number, signal: AbortSignal) {
    return this.uploads.consume(owner, uploadId, (_path, input) => this.options.configuration.run(revision, signal, async () => {
      if (input.kind !== 'profile') throw new Error('请选择 .tedsp 配置包')
      if (this.scanning) throw Object.assign(new Error('插件扫描正在进行'), { code: 'BUSY' })
      return this.profiles.import(owner, uploadId, previewId, revision, this.options.assets, async scenes => {
        const current = this.options.engine.getDspSceneState()
        if (current.scenes.length + scenes.length > 64) throw new Error('导入后场景超过 64 个，请先整理现有场景')
        signal.throwIfAborted()
        await this.commit(async engine => {
          const next = await engine.setDspScenes(await this.authorizeScenes([...current.scenes, ...scenes], signal), current.pinnedSceneId)
          return { dspScenes: next.scenes, dspPinnedSceneId: next.pinnedSceneId }
        })
        return { sceneIds: scenes.map(scene => scene.id) }
      })
    }))
  }
  exportProfile(owner: string, revision: number, name: string, signal: AbortSignal) {
    return this.options.configuration.serialize(async () => {
      this.requireRevision(revision, signal)
      const state = this.options.engine.getDspSceneState()
      return this.profiles.export(owner, name, state.scenes, state.pinnedSceneId, this.options.assets,
        path => this.authorizeImpulse(path, signal), signal)
    })
  }
  profileChunk(owner: string, id: string, offset: number) {
    return this.options.configuration.serialize(() => this.profiles.chunk(owner, id, offset))
  }
  releaseProfile(owner: string, id: string) {
    return this.options.configuration.serialize(() => this.profiles.release(owner, id))
  }
  nodeParameters(revision: number, sceneId: string, nodeId: string, offset = 0): Promise<DspParameterPage> {
    return this.options.configuration.serialize(async () => {
      this.requireRevision(revision, new AbortController().signal)
      const node = this.options.engine.getDspSceneState().scenes.find(scene => scene.id === sceneId)?.graph.nodes.find(node => node.id === nodeId)
      const entry = node?.type === 'vst3Plugin' && node.vst3 ? await this.options.catalog.find(node.vst3.catalogId) : null
      if (!node || !entry || entry.classId !== node.vst3?.classId || entry.status !== 'available') throw new Error('场景插件不可用，请重新扫描或选择节点')
      const parameters = node.params.parameters as Record<string, unknown> | undefined
      return { revision, sceneId, nodeId, name: entry.name, total: entry.parameters.length, offset,
        items: entry.parameters.slice(offset, offset + 100).map(parameter => {
          const override = parameters?.[String(parameter.id)]
          return { ...parameter, overridden: typeof override === 'number', value: typeof override === 'number' ? override : node.vst3?.stateAssetId ? null : parameter.defaultNormalizedValue }
        }) }
    })
  }
  async editLibrary(revision: number, edit: DspLibraryEdit, signal: AbortSignal): Promise<void> {
    if (this.scanning) throw Object.assign(new Error('Plugin scan is running'), { code: 'BUSY' })
    if (edit.kind === 'vst3Enabled') return this.editVst3({ revision, edit: { kind: 'enabled', enabled: edit.enabled } }, signal)
    if (edit.kind === 'scan' || edit.kind === 'clearQuarantine') {
      await this.options.configuration.run(revision, signal, async () => {
        // Reauthorize the persisted paths on every scan; a remote request cannot widen host grants.
        const catalog = this.options.catalog
        await this.options.platform.call('dsp.authorizeVst3Paths', { paths: (await catalog.getState()).searchPaths }, signal)
        signal.throwIfAborted()
        this.scanning = true; this.scanFailed = false
        const task = (async () => {
          try {
            if (edit.kind === 'clearQuarantine') await catalog.clearQuarantine(edit.id)
            const state = await catalog.scan()
            if (edit.kind === 'clearQuarantine' && state.entries.find(row => row.id === edit.id)?.status === 'available')
              this.options.engine.clearVst3RecoveryBypass(edit.id)
          } catch (error) { this.scanFailed = true; this.options.failed(error) }
          finally {
            await this.options.configuration.serialize(async () => {
              this.scanning = false; this.options.engine.refreshDspGraph(); this.options.configuration.changed()
            })
          }
        })()
        this.background.add(task)
        void task.finally(() => this.background.delete(task)).catch(() => {})
      })
      return
    }
    if (edit.kind === 'removeAsset') return this.removeAsset(revision, edit.id, signal)
    return this.options.configuration.run(revision, signal, async () => {
      const state = structuredClone(this.options.engine.getDspSceneState())
      if (edit.kind === 'createScene') {
        if (state.scenes.length >= 64) throw new Error('最多保存 64 个场景')
        const scene = createDspFactoryScene('transparent', `managed-${this.options.newId()}`)
        scene.name = edit.name.trim(); scene.enabled = false
        state.scenes.push(scene)
      } else {
        const scene = state.scenes.find(row => row.id === edit.sceneId)
        if (!scene || scene.id === 'default' && edit.kind !== 'parameter') throw new Error('请先新建或选择自定义场景')
        if (edit.kind === 'applyScene') {
          scene.enabled = true
        } else if (edit.kind === 'removeScene') {
          state.scenes = state.scenes.filter(row => row !== scene)
          if (state.pinnedSceneId === scene.id) state.pinnedSceneId = null
        } else if (edit.kind === 'parameter') {
          const node = scene.graph.nodes.find(node => node.id === edit.nodeId && node.type === 'vst3Plugin')
          const entry = node?.vst3 ? await this.options.catalog.find(node.vst3.catalogId) : null
          const parameter = entry?.parameters.find(parameter => parameter.id === edit.parameterId)
          if (!node || entry?.status !== 'available' || entry.classId !== node.vst3?.classId || !parameter || (parameter.flags & (2 | 16)) !== 0)
            throw new Error('此参数不可编辑')
          const parameters = { ...(node.params.parameters as Record<string, unknown> ?? {}) }
          if (edit.value === null) delete parameters[String(edit.parameterId)]
          else parameters[String(edit.parameterId)] = parameter.stepCount > 0 ? Math.round(edit.value * parameter.stepCount) / parameter.stepCount : edit.value
          node.params = { ...node.params, parameters }
        } else if (edit.kind === 'removeNode') {
          if (!scene.graph.nodes.some(node => node.id === edit.nodeId)) throw new Error('节点不存在')
          scene.graph.nodes = scene.graph.nodes.filter(node => node.id !== edit.nodeId)
        } else {
          let node: DspGraphNode
          if (edit.kind === 'bindImpulse') {
            const asset = await this.options.assets.get(edit.assetId)
            if (asset?.kind !== 'impulseResponse') throw new Error('请选择当前声区的 IR 资料')
            await this.options.assets.getPath(asset.id)
            node = { id: `ir-${this.options.newId()}`, type: 'convolver', enabled: true,
              params: { impulseResponseAssetId: asset.id, wet: 1, dry: 0, gainDb: 0, routingMode: 'diagonal', layout: 'stereo', matrix: [] } }
          } else if (edit.kind === 'bindCorrection') {
            const asset = await this.options.assets.get(edit.assetId)
            if (asset?.kind !== 'correctionProfile') throw new Error('请选择当前声区的校正资料')
            const profile = await parseCorrectionProfileFile(await this.options.assets.getPath(asset.id))
            node = { id: `eq-${this.options.newId()}`, type: 'equalizer', enabled: true,
              params: { correctionAssetId: asset.id, mode: 'parametric', preampDb: profile.preampDb, bands: profile.bands } }
          } else {
            const plugin = await this.options.catalog.find(edit.catalogId)
            if (!plugin || plugin.status !== 'available') throw new Error('插件未通过扫描')
            if (edit.stateAssetId && !this.options.assets.resolveVst3State(edit.stateAssetId).path) throw new Error('插件状态资料不可用')
            node = { id: `vst3-${this.options.newId()}`, type: 'vst3Plugin', enabled: true,
              vst3: { catalogId: plugin.id, classId: plugin.classId, ...(edit.stateAssetId ? { stateAssetId: edit.stateAssetId } : {}) },
              params: { parameters: {} } }
          }
          if (node.type !== 'vst3Plugin') scene.graph.nodes = scene.graph.nodes.filter(row => row.type !== node.type)
          if (scene.graph.nodes.length >= 64) throw new Error('场景节点过多')
          const tail = scene.graph.nodes.findIndex(row => row.type === 'meter' || row.type === 'nativePlugin' && row.pluginAbiVersion === 1)
          scene.graph.nodes.splice(tail < 0 ? scene.graph.nodes.length : tail, 0, node)
          // A newly prepared scene stays out of automatic matching until explicitly applied.
        }
      }
      signal.throwIfAborted()
      await this.commit(async engine => {
        let processing: AudioProcessingSettings | undefined
        if (edit.kind === 'applyScene') {
          const graph = state.scenes.find(row => row.id === edit.sceneId)!.graph
          processing = { ...this.options.settings.read().audioProcessing,
            ...(graph.nodes.some(node => node.enabled && node.type === 'convolver') ? { convolverEnabled: true } : {}),
            ...(graph.nodes.some(node => node.enabled && node.type === 'equalizer') ? { eqEnabled: true } : {}) }
          await engine.setAudioProcessing(buildEffectiveAudioProcessingSettings(processing, this.options.settings.read().headphoneCompensation))
        }
        let next = await engine.setDspScenes(await this.authorizeScenes(state.scenes), state.pinnedSceneId)
        if (edit.kind === 'applyScene') next = await engine.applyDspScene(edit.sceneId, edit.confirmDsdPcmFallback)
        const compensated = this.options.settings.read().audioEqAutoPreamp?.enabled ? await this.compensate(engine) : {}
        return { ...(processing ? { audioProcessing: processing } : {}), dspScenes: next.scenes, dspPinnedSceneId: next.pinnedSceneId, ...compensated }
      })
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
        return { ...imported, state: structuredClone(this.options.engine.getDspSceneState()) }
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
    await this.uploads.close()
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
