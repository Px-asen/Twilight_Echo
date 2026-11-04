import { open } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { PLUGIN_TRANSFER_BYTES, PLUGIN_UPLOAD_BYTES, validPluginUpload,
  type PluginManagementPage, type PluginPackagePreview } from '../../shared/pluginManagement.ts'

type Rpc = (kind: 'query' | 'command', name: string, payload?: unknown) => Promise<unknown>

/** Local administration uses the same staged package and version checks as mobile clients. */
export async function manageServerPlugins(command: string, values: {
  from?: string; id?: string; offset?: string; apply?: boolean; 'remove-data'?: boolean
}, rpc: Rpc): Promise<unknown> {
  const call = (kind: 'query' | 'command', name: string, payload: unknown = {}) => rpc(kind, `plugins.management.${name}`, payload)
  if (command === 'plugins') {
    const offset = values.offset === undefined ? 0 : Number(values.offset)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('分页位置必须为非负整数')
    return call('query', 'list', { offset })
  }
  if (command === 'plugin-install') {
    if (!values.from || !isAbsolute(values.from)) throw new Error('需要 --from 绝对 .tep 文件路径')
    const fileName = basename(values.from)
    if (!validPluginUpload({ fileName, byteSize: 1 })) throw new Error('请选择 .tep 扩展包')
    const source = await open(values.from, 'r')
    let uploadId: string | undefined, preview: PluginPackagePreview | undefined
    try {
      const info = await source.stat()
      if (!info.isFile() || info.size <= 0 || info.size > PLUGIN_UPLOAD_BYTES) throw new Error('安装包大小须为 1 字节至 50 MiB')
      const upload = await call('command', 'upload.begin', { fileName, byteSize: info.size }) as { uploadId: string; chunkBytes: number }
      uploadId = upload.uploadId
      if (!Number.isSafeInteger(upload.chunkBytes) || upload.chunkBytes <= 0 || upload.chunkBytes > PLUGIN_TRANSFER_BYTES) throw new Error('无效的上传分块大小')
      const buffer = Buffer.alloc(upload.chunkBytes)
      let offset = 0
      while (offset < info.size) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset)
        if (!bytesRead) throw new Error('安装包在读取时发生变化')
        const receipt = await call('command', 'upload.chunk', { uploadId, offset, data: buffer.subarray(0, bytesRead).toString('base64') }) as { offset: number }
        offset += bytesRead
        if (receipt.offset !== offset) throw new Error('Server 未确认完整分块')
      }
      const after = await source.stat()
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('安装包在读取时发生变化')
      preview = await call('command', 'preview', { uploadId }) as PluginPackagePreview
      uploadId = undefined
      if (!values.apply || preview.issues.length) return { applied: false, preview }
      return { applied: true, preview, result: await call('command', 'install', { previewId: preview.previewId }) }
    } finally {
      await source.close()
      if (preview) await call('command', 'cancel', { previewId: preview.previewId }).catch(() => {})
      if (uploadId) await call('command', 'upload.cancel', { uploadId }).catch(() => {})
    }
  }
  const actions: Record<string, 'enable' | 'disable' | 'uninstall'> = {
    'plugin-enable': 'enable', 'plugin-disable': 'disable', 'plugin-uninstall': 'uninstall'
  }
  const action = actions[command]
  if (!action || !values.id) throw new Error('需要有效操作及 --id 扩展 ID')
  let offset = 0
  for (;;) {
    const page = await call('query', 'list', { offset }) as PluginManagementPage
    const plugin = page.items.find(item => item.id === values.id)
    if (plugin) {
      if (action === 'uninstall' && !values.apply) return { applied: false, plugin, removeData: values['remove-data'] === true }
      await call('command', 'edit', { id: plugin.id, token: plugin.token, action,
        ...(action === 'uninstall' ? { removeData: values['remove-data'] === true } : {}) })
      return { applied: true, id: plugin.id, action }
    }
    offset += page.items.length
    if (!page.items.length || offset >= page.total) throw new Error('扩展不存在，请刷新列表')
  }
}
