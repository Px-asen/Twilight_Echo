import { randomUUID } from '../../shared/portableCrypto.ts'
import { ChunkUploads } from '../transfers/chunkUploads.ts'
import type { UploadFileStorage } from '../transfers/fileStorage.ts'
import { PLUGIN_TRANSFER_BYTES, PLUGIN_UPLOAD_BYTES, validPluginUpload, pluginManagementToken,
  type PluginUpload, type PluginPackagePreview, type PluginManagementPage, type PluginManagementEdit } from '../../shared/pluginManagement.ts'
import type { TwilightPluginManifest, TwilightPluginInstallResult } from '../../shared/pluginTypes.ts'
import type { TwilightPluginManager } from './manager.ts'
import { isCompatibleTwilightRange } from './manifest.ts'

const fail = (code: string, message: string) => Object.assign(new Error(message), { code })
interface Pending {
  owner: string; previewId: string; accepted: boolean; view?: PluginPackagePreview
  approve(value: boolean): void; controller: AbortController; timer: ReturnType<typeof setTimeout>
  task: Promise<TwilightPluginInstallResult>
}

/** The manager keeps the exact staged candidate while the owning client reviews it. */
export class CorePluginManagement {
  private readonly uploads: ChunkUploads<PluginUpload>
  private readonly pending = new Map<string, Pending>()
  private closed = false
  private readonly options: {
    manager: Pick<TwilightPluginManager, 'list' | 'installFromPath' | 'editManaged'>
    uploadRoot: string; appVersion: string; remoteEnabled: boolean; headless: boolean
    now?: () => number; newId?: () => string
    files: UploadFileStorage
  }
  constructor(options: CorePluginManagement['options']) {
    this.options = options
    this.uploads = new ChunkUploads(options.uploadRoot, options.now ?? Date.now, options.newId ?? randomUUID,
      { chunkBytes: PLUGIN_TRANSFER_BYTES, maxBytes: PLUGIN_UPLOAD_BYTES, valid: validPluginUpload }, options.files)
  }
  initialize() { return this.uploads.initialize() }
  private issues(plugin: Pick<TwilightPluginManifest, 'type' | 'engines'>): string[] {
    const issues: string[] = []
    if (!isCompatibleTwilightRange(plugin.engines.twilightEcho, this.options.appVersion)) issues.push('需要其他版本的 Twilight Echo')
    if (this.options.headless && plugin.type.some(type => ['ui', 'theme', 'dsp'].includes(type)))
      issues.push('此扩展需要桌面界面或原生 DSP 工作台，请在桌面端管理')
    return issues
  }
  private writable(administrator: boolean) {
    if (this.closed) throw fail('NOT_READY', '扩展管理已关闭')
    if (!administrator && !this.options.remoteEnabled) throw fail('FORBIDDEN', 'Server 尚未开启远程扩展管理')
  }
  async list(administrator: boolean, offset = 0): Promise<PluginManagementPage> {
    const all = await this.options.manager.list()
    return { canManage: administrator || this.options.remoteEnabled, total: all.length, offset,
      maxUploadBytes: PLUGIN_UPLOAD_BYTES, items: all.slice(offset, offset + 100).map(plugin => ({
        id: plugin.id, name: plugin.name, version: plugin.version, description: plugin.description,
        author: plugin.author, type: plugin.type, permissions: plugin.permissions,
        enabled: plugin.enabled, status: plugin.status, builtIn: plugin.builtIn,
        token: pluginManagementToken(plugin), issues: this.issues(plugin)
      })) }
  }
  begin(owner: string, administrator: boolean, input: PluginUpload) { this.writable(administrator); return this.uploads.begin(owner, input) }
  chunk(owner: string, administrator: boolean, id: string, offset: number, data: string) {
    this.writable(administrator); return this.uploads.chunk(owner, id, offset, data)
  }
  cancelUpload(owner: string, id: string) { return this.uploads.cancel(owner, id) }
  async preview(owner: string, administrator: boolean, uploadId: string, signal: AbortSignal): Promise<PluginPackagePreview> {
    this.writable(administrator)
    if (this.pending.size >= 2) throw fail('BUSY', '已有两个扩展包等待确认')
    const previewId = (this.options.newId ?? randomUUID)(), controller = new AbortController()
    const expiresAt = (this.options.now ?? Date.now)() + 600_000
    let approve!: (value: boolean) => void
    const approval = new Promise<boolean>(resolve => { approve = resolve })
    let ready!: (value: PluginPackagePreview) => void, reject!: (error: unknown) => void
    const prepared = new Promise<PluginPackagePreview>((resolve, fail) => { ready = resolve; reject = fail })
    const cancel = () => { controller.abort(); approve(false) }
    const entry: Pending = { owner, previewId, accepted: false, approve, controller,
      timer: setTimeout(cancel, 600_000), task: Promise.resolve(null as never) }
    this.pending.set(previewId, entry)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      return await this.uploads.consume(owner, uploadId, async (path, input) => {
        let expected = 'null'
        entry.task = this.options.manager.installFromPath(path, { source: 'tep', sourceLabel: input.fileName,
          signal: controller.signal, expectedToken: () => expected,
          confirm: async (manifest) => {
            controller.signal.throwIfAborted()
            const previous = (await this.options.manager.list()).find(plugin => plugin.id === manifest.id) ?? null
            expected = pluginManagementToken(previous)
            const { id, name, version, description, author, type, permissions, dependencies } = manifest
            entry.view = { previewId, plugin: { id, name, version, description, author, type, permissions, dependencies },
              previousVersion: previous?.version ?? null, previouslyEnabled: previous?.enabled ?? false,
              issues: this.issues(manifest), expiresAt }
            ready(entry.view)
            return approval
          }
        })
        void entry.task.then(() => {}, reject).finally(() => {
          clearTimeout(entry.timer); this.pending.delete(previewId)
        })
        return prepared
      })
    } catch (error) {
      cancel(); clearTimeout(entry.timer); this.pending.delete(previewId)
      throw error
    } finally { signal.removeEventListener('abort', cancel) }
  }
  private entry(owner: string, id: string) {
    const entry = this.pending.get(id)
    if (!entry || entry.owner !== owner || !entry.view || entry.view.expiresAt <= (this.options.now ?? Date.now)())
      throw fail('NOT_FOUND', '扩展预览已失效')
    if (entry.accepted) throw fail('OUTCOME_UNKNOWN', '安装已经提交，请刷新扩展列表')
    return entry
  }
  async install(owner: string, administrator: boolean, id: string, signal: AbortSignal) {
    this.writable(administrator); signal.throwIfAborted()
    const entry = this.entry(owner, id)
    if (entry.view!.issues.length) throw fail('UNSUPPORTED_CAPABILITY', '此扩展不适用于当前宿主')
    entry.accepted = true; clearTimeout(entry.timer); entry.approve(true)
    const result = await entry.task
    return { id: result.plugin.id, version: result.plugin.version, enabled: result.plugin.enabled }
  }
  async cancel(owner: string, id: string) {
    const entry = this.entry(owner, id)
    entry.controller.abort(); entry.approve(false)
    await entry.task.catch(() => {})
  }
  async edit(administrator: boolean, edit: PluginManagementEdit, signal: AbortSignal) {
    this.writable(administrator)
    const plugin = (await this.options.manager.list()).find(plugin => plugin.id === edit.id)
    if (!plugin) throw fail('NOT_FOUND', '扩展已卸载')
    if (edit.action === 'enable' && this.issues(plugin).length) throw fail('UNSUPPORTED_CAPABILITY', '此扩展不适用于当前宿主')
    return this.options.manager.editManaged(edit, signal)
  }
  async disconnect(owner: string) {
    const owned = [...this.pending.values()].filter(entry => entry.owner === owner && !entry.accepted)
    for (const entry of owned) { entry.controller.abort(); entry.approve(false) }
    await Promise.allSettled(owned.map(entry => entry.task))
    await this.uploads.disconnect(owner)
  }
  async shutdown() {
    this.closed = true
    const tasks = [...this.pending.values()]
    for (const entry of tasks) { clearTimeout(entry.timer); entry.controller.abort(); entry.approve(false) }
    await Promise.allSettled(tasks.map(entry => entry.task))
    await this.uploads.close()
  }
}
