import { open, readFile, unlink } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import type { DspLibraryPage, DspProfilePreview, DspProfileDownload } from '../../shared/dspLibrary.ts'
import { DSP_UPLOAD_MAX_BYTES, validDspUploadFile } from '../../shared/dspLibrary.ts'

type Rpc = (kind: 'query' | 'command', name: string, payload?: unknown) => Promise<unknown>
/** Same Core operations as paired clients; the local CLI supplies bytes, never a host path to Core. */
export async function manageServerDsp(command: string, values: {
  zone?: string; from?: string; to?: string; kind?: string; id?: string; request?: string; apply?: boolean
  scene?: string; node?: string; offset?: string; name?: string
  'asset-offset'?: string; 'plugin-offset'?: string
}, rpc: Rpc): Promise<unknown> {
  const zoneId = values.zone ?? 'local'
  const offset = (value?: string) => {
    const number = value === undefined ? 0 : Number(value)
    if (!Number.isSafeInteger(number) || number < 0) throw new Error('分页位置必须为非负整数')
    return number
  }
  const library = await rpc('query', 'zones.dsp.library', { zoneId,
    assetOffset: offset(values['asset-offset']), pluginOffset: offset(values['plugin-offset']) }) as DspLibraryPage
  if (command === 'dsp-library') return library
  if (command === 'dsp-parameters') {
    if (!values.scene || !values.node) throw new Error('需要 --scene 场景 ID 与 --node 节点 ID')
    return rpc('query', 'zones.dsp.parameters', { zoneId, revision: library.revision, sceneId: values.scene, nodeId: values.node, offset: offset(values.offset) })
  }
  if (command === 'dsp-profile-export') {
    if (!values.to || !isAbsolute(values.to) || !values.to.toLowerCase().endsWith('.tedsp')) throw new Error('需要 --to 新的绝对 .tedsp 文件路径')
    const output = await open(values.to, 'wx')
    let download: DspProfileDownload | undefined, complete = false
    try {
      download = await rpc('command', 'zones.dsp.profile.export', { zoneId, revision: library.revision, name: values.name ?? 'Twilight Echo DSP' }) as DspProfileDownload
      let offset = 0
      while (offset < download.byteSize) {
        const chunk = await rpc('query', 'zones.dsp.profile.chunk', { zoneId, downloadId: download.downloadId, offset }) as { offset: number; nextOffset: number; data: string }
        const bytes = Buffer.from(chunk.data, 'base64')
        if (chunk.offset !== offset || chunk.nextOffset !== offset + bytes.length || !bytes.length || chunk.nextOffset > download.byteSize) throw new Error('配置包分块不完整')
        await output.writeFile(bytes); offset = chunk.nextOffset
      }
      await output.sync(); complete = true
      return { file: values.to, byteSize: download.byteSize }
    } finally {
      await output.close()
      if (!complete) await unlink(values.to)
      if (download) await rpc('command', 'zones.dsp.profile.release', { zoneId, downloadId: download.downloadId }).catch(() => {})
    }
  }
  if (command === 'dsp-import' || command === 'dsp-profile-import') {
    if (!values.from || !isAbsolute(values.from)) throw new Error('dsp-import 需要 --from 绝对文件路径')
    const fileName = basename(values.from), kind = command === 'dsp-profile-import' ? 'profile' : values.kind ?? ({
      wav: 'impulseResponse', flac: 'impulseResponse', aif: 'impulseResponse', aiff: 'impulseResponse',
      txt: 'correctionProfile', apo: 'correctionProfile', vstpreset: 'vst3Preset', vststate: 'vst3State', bin: 'vst3State'
    } as Record<string, string>)[fileName.split('.').at(-1)!.toLowerCase()]
    if (!validDspUploadFile(kind, fileName)) throw new Error('不支持的 DSP 资料类型或文件名')
    const source = await open(values.from, 'r')
    let uploadId: string | undefined
    try {
      const info = await source.stat()
      if (!info.isFile() || info.size <= 0 || info.size > DSP_UPLOAD_MAX_BYTES) throw new Error('资料大小须为 1 字节至 64 MB')
      const upload = await rpc('command', 'zones.dsp.upload.begin', { zoneId, kind, fileName, byteSize: info.size }) as { uploadId: string; chunkBytes: number }
      uploadId = upload.uploadId
      const buffer = Buffer.alloc(upload.chunkBytes)
      let offset = 0
      while (offset < info.size) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset)
        if (!bytesRead) throw new Error('文件在读取时发生变化')
        await rpc('command', 'zones.dsp.upload.chunk', { zoneId, uploadId, offset, data: buffer.subarray(0, bytesRead).toString('base64') })
        offset += bytesRead
      }
      const after = await source.stat()
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('文件在读取时发生变化')
      if (kind === 'profile') {
        const preview = await rpc('command', 'zones.dsp.profile.preview', { zoneId, uploadId, revision: library.revision }) as DspProfilePreview
        if (!values.apply || preview.issues.length) return { applied: false, preview }
        return { applied: true, preview, result: await rpc('command', 'zones.dsp.profile.import', { zoneId, uploadId, previewId: preview.previewId, revision: preview.revision }) }
      }
      return await rpc('command', 'zones.dsp.upload.commit', { zoneId, uploadId, revision: library.revision })
    } finally {
      await source.close()
      if (uploadId) await rpc('command', 'zones.dsp.upload.cancel', { zoneId, uploadId }).catch(() => {})
    }
  }
  let edit: unknown
  if (command === 'dsp-remove') {
    if (!values.id) throw new Error('dsp-remove 需要 --id 资料 ID')
    edit = { kind: 'removeAsset', id: values.id }
  } else if (command === 'vst3-scan') edit = { kind: 'scan' }
  else if (command === 'dsp-edit') {
    if (!values.request) throw new Error('dsp-edit 需要 --request 编辑 JSON 文件')
    edit = JSON.parse(await readFile(values.request, 'utf8'))
  } else throw new Error('未知 DSP 管理操作')
  await rpc('command', 'zones.dsp.library.edit', { zoneId, revision: library.revision, edit })
  return rpc('query', 'zones.dsp.library', { zoneId })
}
