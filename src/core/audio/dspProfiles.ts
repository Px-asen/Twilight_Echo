import type { TransferFileStorage } from '../transfers/fileStorage.ts'
import { join } from '../../shared/portablePath.ts'
import { PortableBuffer } from '../../shared/portableBytes.ts'
import { DSP_UPLOAD_CHUNK_BYTES, DSP_UPLOAD_MAX_BYTES, type DspProfilePreview, type DspProfileDownload } from '../../shared/dspLibrary.ts'
import { normalizeDspScenes, type DspProfile, type DspScene } from '../../shared/dspGraph.ts'
import { DspAssetLibrary } from './dspAssetLibrary.ts'
import type { Vst3CatalogService } from './vst3Catalog.ts'
import { collectDspAssetIds, createDspProfile, exportDspProfileArchive, importDspProfileArchive } from './dspProfileArchive.ts'

const fail = (code: string, message: string) => Object.assign(new Error(message), { code })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
interface Preview { owner: string; uploadId: string; root: string; assets: DspAssetLibrary; profile: DspProfile; view: DspProfilePreview; expires: number }
interface Download { owner: string; path: string; view: DspProfileDownload; expires: number }

/** Runs on the owning DSP configuration lane. Staged packages never alter saved scenes or assets. */
export class DspProfiles {
  private readonly previews = new Map<string, Preview>()
  private readonly downloads = new Map<string, Download>()
  private readonly options: { root: string; now(): number; newId(): string; catalog: Vst3CatalogService; files: TransferFileStorage }
  constructor(options: DspProfiles['options']) { this.options = options }
  async initialize() { await this.options.files.mkdir(this.options.root, { recursive: true }) }
  private async expire() {
    for (const [key, entry] of this.previews) if (entry.expires <= this.options.now()) await this.dropPreview(key)
    for (const [key, entry] of this.downloads) if (entry.expires <= this.options.now()) await this.dropDownload(key)
  }
  private async dropPreview(key: string) {
    const entry = this.previews.get(key)
    if (entry) await this.options.files.rm(entry.root, { recursive: true, force: true })
    this.previews.delete(key)
  }
  private async dropDownload(key: string) {
    const entry = this.downloads.get(key)
    if (entry) await this.options.files.rm(entry.path, { force: true })
    this.downloads.delete(key)
  }
  async preview(owner: string, uploadId: string, path: string, revision: number, signal: AbortSignal): Promise<DspProfilePreview> {
    await this.expire()
    for (const [key, entry] of this.previews) if (entry.owner === owner && entry.uploadId === uploadId) await this.dropPreview(key)
    if (this.previews.size >= 2) throw fail('BUSY', '已有两个配置包等待确认')
    const root = await this.options.files.mkdtemp(join(this.options.root, 'preview-'))
    let retained = false
    try {
      const assets = new DspAssetLibrary(join(root, 'assets'), this.options)
      const imported = await importDspProfileArchive(path, assets, root, DSP_UPLOAD_MAX_BYTES)
      const profile = imported.profile
      if (typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 160) throw new Error('配置包名称无效')
      profile.scenes = portableScenes(profile.scenes)
      const issues: string[] = []
      const entries = (await this.options.catalog.getState()).entries
      for (const scene of profile.scenes) for (const node of scene.graph.nodes) {
        if (node.type === 'nativePlugin') issues.push(`「${scene.name}」包含需要桌面管理的原生扩展`)
        if (node.type === 'vst3Plugin') {
          const ref = node.vst3
          const matches = ref ? entries.filter(entry => entry.status === 'available' && entry.classId.toLowerCase() === ref.classId.toLowerCase()) : []
          const match = matches.find(entry => entry.id === ref?.catalogId) ?? (matches.length === 1 ? matches[0] : null)
          if (!match) issues.push(`「${scene.name}」的 VST3 未安装、未通过扫描或存在重复版本`)
          else node.vst3 = { ...ref!, catalogId: match.id, classId: match.classId }
        }
        for (const [id, kind] of [[node.params.impulseResponseAssetId, 'impulseResponse'], [node.params.correctionAssetId, 'correctionProfile'], [node.vst3?.stateAssetId, 'state']] as const) {
          if (!id) continue
          const asset = await assets.get(String(id))
          if (!asset || (kind === 'state' ? !['vst3Preset', 'vst3State'].includes(asset.kind) : asset.kind !== kind))
            issues.push(`「${scene.name}」缺少匹配的资料`)
        }
      }
      for (const id of collectDspAssetIds(profile.scenes)) if (!await assets.get(id)) issues.push('配置包缺少场景引用的资料')
      const all = await assets.list()
      const view: DspProfilePreview = { previewId: this.options.newId(), revision, name: profile.name,
        scenes: profile.scenes.map(scene => ({ name: scene.name, nodeCount: scene.graph.nodes.length })),
        assetCount: all.length, assetBytes: all.reduce((sum, asset) => sum + asset.byteSize, 0), issues: [...new Set(issues)] }
      signal.throwIfAborted()
      this.previews.set(view.previewId, { owner, uploadId, root, assets, profile, view, expires: this.options.now() + 600_000 })
      retained = true
      return view
    } finally { if (!retained) await this.options.files.rm(root, { recursive: true, force: true }) }
  }
  async import<T>(owner: string, uploadId: string, previewId: string, revision: number, target: DspAssetLibrary,
    apply: (scenes: DspScene[]) => Promise<T>): Promise<T> {
    await this.expire()
    const entry = this.previews.get(previewId)
    if (!entry || entry.owner !== owner || entry.uploadId !== uploadId) throw fail('NOT_FOUND', '配置包预览已失效')
    const added: string[] = []
    try {
      if (entry.view.revision !== revision) throw fail('STALE_REVISION', '请重新预览配置包')
      if (entry.view.issues.length) throw fail('INVALID_REQUEST', '请先解决配置包中的缺失项目')
      for (const scene of entry.profile.scenes) for (const node of scene.graph.nodes) if (node.vst3) {
        const plugin = await this.options.catalog.find(node.vst3.catalogId)
        if (plugin?.status !== 'available' || plugin.classId !== node.vst3.classId) throw fail('STALE_REVISION', '插件目录已改变，请重新预览')
      }
      for (const { asset, path } of await entry.assets.entries((await entry.assets.list()).map(asset => asset.id))) {
        const existing = await target.get(asset.id)
        if (!existing) added.push(asset.id)
        await target.importFile({ kind: asset.kind, sourcePath: path, fileName: asset.fileName, name: asset.name })
      }
      // Fresh IDs keep imported default scenes and repeated imports separate from the current scene set.
      return await apply(entry.profile.scenes.map(scene => ({ ...structuredClone(scene), id: `imported-${this.options.newId()}`, enabled: false, allowDsdPcmFallback: false })))
    } catch (error) {
      for (const id of added) await target.remove(id).catch(() => {})
      throw error
    } finally { await this.dropPreview(previewId) }
  }
  async export(owner: string, name: string, scenes: DspScene[], pinnedSceneId: string | null, source: DspAssetLibrary,
    authorizeImpulse: (path: string) => Promise<string>, signal: AbortSignal): Promise<DspProfileDownload> {
    await this.expire()
    if (this.downloads.size >= 2) throw fail('BUSY', '已有两个配置包等待下载')
    const root = await this.options.files.mkdtemp(join(this.options.root, 'export-'))
    const downloadId = this.options.newId(), path = join(this.options.root, `${downloadId}.tedsp`)
    let retained = false
    try {
      const assets = new DspAssetLibrary(join(root, 'assets'), this.options)
      const portable = structuredClone(scenes)
      let bytes = 0
      for (const scene of portable) for (const node of scene.graph.nodes) {
        if (typeof node.params.impulseResponsePath === 'string' && node.params.impulseResponsePath && !node.params.impulseResponseAssetId) {
          const sourcePath = await authorizeImpulse(node.params.impulseResponsePath)
          bytes += (await this.options.files.stat(sourcePath)).size
          if (bytes > DSP_UPLOAD_MAX_BYTES) throw new Error('配置包资料超过 64 MiB')
          const asset = await assets.importFile({ kind: 'impulseResponse', sourcePath })
          node.params.impulseResponseAssetId = asset.id
        }
        delete node.params.impulseResponsePath
        for (const key of ['vst3ModulePath', 'vst3StatePath', 'vst3ClassId', 'vst3StateFormat', 'vst3BypassReason']) delete node.params[key]
      }
      for (const id of collectDspAssetIds(portable)) {
        if (await assets.get(id)) continue
        const asset = await source.get(id)
        if (!asset) throw new Error('场景引用的资料已缺失，无法导出完整配置包')
        bytes += asset.byteSize
        if (bytes > DSP_UPLOAD_MAX_BYTES) throw new Error('配置包资料超过 64 MiB')
        await assets.importFile({ kind: asset.kind, sourcePath: await source.getPath(id), fileName: asset.fileName, name: asset.name })
      }
      const profile = createDspProfile({ name, scenes: portableScenes(portable), pinnedSceneId,
        assetIds: collectDspAssetIds(portable), id: downloadId, now: new Date(this.options.now()) })
      signal.throwIfAborted()
      await exportDspProfileArchive({ outputPath: path, profile }, assets)
      const byteSize = (await this.options.files.stat(path)).size
      if (byteSize > DSP_UPLOAD_MAX_BYTES) throw new Error('完整配置包超过 64 MiB')
      const fileName = `${name.replace(/[\\/:*?"<>|\r\n\0]/g, '_').replace(/[. ]+$/g, '') || 'DSP'}.tedsp`
      const view = { downloadId, fileName, byteSize, chunkBytes: DSP_UPLOAD_CHUNK_BYTES }
      signal.throwIfAborted()
      this.downloads.set(downloadId, { owner, path, view, expires: this.options.now() + 600_000 }); retained = true
      return view
    } finally {
      await this.options.files.rm(root, { recursive: true, force: true })
      if (!retained) await this.options.files.rm(path, { force: true })
    }
  }
  async chunk(owner: string, id: string, offset: number) {
    await this.expire()
    const entry = this.downloads.get(id)
    if (!entry || entry.owner !== owner) throw fail('NOT_FOUND', '下载已失效')
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= entry.view.byteSize) throw fail('INVALID_REQUEST', '下载位置无效')
    const file = await this.options.files.open(entry.path, 'r')
    try {
      const buffer = PortableBuffer.alloc(Math.min(DSP_UPLOAD_CHUNK_BYTES, entry.view.byteSize - offset))
      let read = 0
      while (read < buffer.length) {
        const { bytesRead } = await file.read(buffer, read, buffer.length - read, offset + read)
        if (!bytesRead) throw new Error('配置包文件不完整')
        read += bytesRead
      }
      entry.expires = this.options.now() + 600_000
      return { offset, nextOffset: offset + read, data: buffer.toString('base64') }
    } finally { await file.close() }
  }
  async release(owner: string, id: string) {
    if (this.downloads.get(id)?.owner !== owner) throw fail('NOT_FOUND', '下载已失效')
    await this.dropDownload(id)
  }
  async cancel(owner: string, uploadId: string) {
    for (const [key, entry] of this.previews) if (entry.owner === owner && entry.uploadId === uploadId) await this.dropPreview(key)
  }
  async disconnect(owner: string) {
    for (const [key, entry] of this.previews) if (entry.owner === owner) await this.dropPreview(key)
    for (const [key, entry] of this.downloads) if (entry.owner === owner) await this.dropDownload(key)
  }
}

function portableScenes(value: unknown): DspScene[] {
  if (!Array.isArray(value) || !value.length || value.length > 64 || !value.every(scene => object(scene) &&
    typeof scene.name === 'string' && scene.name.trim().length > 0 && scene.name.length <= 160 && object(scene.graph) &&
    Array.isArray(scene.graph.nodes) && scene.graph.nodes.length <= 64 && scene.graph.nodes.every(object))) throw new Error('配置包场景结构无效')
  const normalized = normalizeDspScenes(value)
  if (normalized.length !== value.length || normalized.some((scene, index) => scene.graph.nodes.length !== value[index].graph.nodes.length))
    throw new Error('配置包包含未知节点或重复场景')
  const visit = (data: unknown, key = '') => {
    if (typeof data === 'string' && data && /(path|paths|url|uri)$/i.test(key)) throw new Error('配置包包含外部路径；请先嵌入所需资料')
    if (Array.isArray(data)) data.forEach(item => visit(item, key))
    else if (object(data)) for (const [child, item] of Object.entries(data)) visit(item, child)
  }
  visit(normalized)
  return normalized
}
