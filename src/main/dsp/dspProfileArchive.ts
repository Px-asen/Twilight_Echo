import { createRequire } from 'module'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { dirname, extname, join, relative, resolve } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import type { DspAsset, DspProfile, DspScene } from '../../shared/dspGraph.ts'
import { DspAssetLibrary } from './dspAssetLibrary.ts'
import { parseCorrectionProfileFile } from './correctionProfile.ts'
import { tryParseJsonWithNestingLimit } from '../security/jsonSafety.ts'

const require = createRequire(import.meta.url)
const yauzl = require('yauzl') as {
  open: (
    path: string,
    options: { lazyEntries: true; validateEntrySizes: false },
    callback: (error: Error | null, zipFile?: ZipFile) => void
  ) => void
}

const MAX_PROFILE_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_PROFILE_FILES = 1024
const MAX_PROFILE_MANIFEST_BYTES = 4 * 1024 * 1024

interface ZipFile {
  readEntry: () => void
  close: () => void
  on: (event: 'entry', handler: (entry: ZipEntry) => void) => void
  once(event: 'end', handler: () => void): void
  once(event: 'error', handler: (error: Error) => void): void
}

interface ZipEntry {
  fileName: string
  uncompressedSize: number
  externalFileAttributes: number
}

interface ProfileArchiveManifest {
  kind: 'twilight-echo-dsp-profile'
  schemaVersion: 1
  profile: DspProfile
  assets: Array<{
    asset: DspAsset
    archivePath: string
  }>
}

export interface ExportDspProfileOptions {
  outputPath: string
  profile: DspProfile
}

export interface ImportedDspProfile {
  profile: DspProfile
  importedAssets: DspAsset[]
}

export function createDspProfile(input: {
  name: string
  scenes: DspScene[]
  pinnedSceneId: string | null
  assetIds: string[]
  id?: string
  now?: Date
}): DspProfile {
  const now = (input.now ?? new Date()).toISOString()
  return {
    schemaVersion: 1,
    id: input.id?.trim() || `dsp-profile-${randomUUID()}`,
    name: input.name.trim().slice(0, 120) || 'DSP Profile',
    createdAt: now,
    updatedAt: now,
    scenes: input.scenes,
    pinnedSceneId: input.pinnedSceneId,
    assetIds: [...new Set(input.assetIds)].sort()
  }
}

export async function exportDspProfileArchive(
  options: ExportDspProfileOptions,
  assets: DspAssetLibrary
): Promise<void> {
  const outputPath = resolve(options.outputPath)
  if (extname(outputPath).toLowerCase() !== '.tedsp') {
    throw new Error('DSP 配置包必须使用 .tedsp 扩展名')
  }
  const assetEntries = await assets.entries(options.profile.assetIds)
  const archiveAssets = assetEntries.map(({ asset, path }) => ({
    asset,
    path,
    archivePath: assetArchivePath(asset)
  }))
  const manifest: ProfileArchiveManifest = {
    kind: 'twilight-echo-dsp-profile',
    schemaVersion: 1,
    profile: options.profile,
    assets: archiveAssets.map(({ asset, archivePath }) => ({ asset, archivePath }))
  }
  const files: ZipSourceEntry[] = [
    { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') }
  ]
  for (const entry of archiveAssets) {
    files.push({ path: entry.archivePath, data: await readFile(entry.path) })
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeStoredZip(outputPath, files)
}

export async function importDspProfileArchive(
  archivePath: string,
  assets: DspAssetLibrary
): Promise<ImportedDspProfile> {
  const source = resolve(archivePath)
  const archiveInfo = await stat(source)
  if (
    !archiveInfo.isFile() ||
    archiveInfo.size <= 0 ||
    archiveInfo.size > MAX_PROFILE_ARCHIVE_BYTES
  ) {
    throw new Error('DSP 配置包大小不在允许范围内')
  }
  await inspectProfileArchive(source)
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'twilight-dsp-profile-'))
  try {
    const { default: extract } = await import('extract-zip')
    await extract(source, { dir: temporaryRoot })
    const manifestPath = resolve(temporaryRoot, 'manifest.json')
    const manifestInfo = await stat(manifestPath)
    if (!manifestInfo.isFile() || manifestInfo.size > MAX_PROFILE_MANIFEST_BYTES) {
      throw new Error('DSP 配置包清单无效')
    }
    const parsedManifest = tryParseJsonWithNestingLimit(await readFile(manifestPath, 'utf8'))
    if (!parsedManifest.ok) throw new Error('DSP profile archive manifest is invalid')
    const manifest = parseProfileManifest(parsedManifest.value)
    const importedAssets: DspAsset[] = []
    for (const entry of manifest.assets) {
      const sourcePath = resolve(temporaryRoot, entry.archivePath)
      if (!isInside(sourcePath, temporaryRoot)) throw new Error('DSP 配置包包含越界资料')
      if (entry.asset.kind === 'correctionProfile') {
        await parseCorrectionProfileFile(sourcePath)
      }
      const imported = await assets.importFile({
        kind: entry.asset.kind,
        sourcePath,
        name: entry.asset.name
      })
      if (imported.sha256 !== entry.asset.sha256) throw new Error('DSP 配置包资料校验失败')
      importedAssets.push(imported)
    }
    return { profile: manifest.profile, importedAssets }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

export function collectDspAssetIds(scenes: DspScene[]): string[] {
  const ids = new Set<string>()
  for (const scene of scenes) {
    for (const node of scene.graph.nodes) {
      if (node.vst3?.stateAssetId) ids.add(node.vst3.stateAssetId)
      collectAssetIdsFromValue(node.params, ids)
    }
  }
  return [...ids].sort()
}

function collectAssetIdsFromValue(value: unknown, ids: Set<string>, key = ''): void {
  if (typeof value === 'string') {
    if (/assetId$/i.test(key) && /^[a-zA-Z]+:[a-f0-9]{64}$/.test(value)) ids.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAssetIdsFromValue(item, ids, key)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    collectAssetIdsFromValue(childValue, ids, childKey)
  }
}

function assetArchivePath(asset: DspAsset): string {
  const extension = extname(asset.fileName).toLowerCase() || '.bin'
  const safeId = asset.id.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `assets/${asset.kind}/${safeId}${extension}`
}

function parseProfileManifest(value: unknown): ProfileArchiveManifest {
  if (!value || typeof value !== 'object') throw new Error('DSP 配置包清单无效')
  const manifest = value as Partial<ProfileArchiveManifest>
  if (manifest.kind !== 'twilight-echo-dsp-profile' || manifest.schemaVersion !== 1) {
    throw new Error('DSP 配置包版本不受支持')
  }
  if (!isDspProfile(manifest.profile) || !Array.isArray(manifest.assets)) {
    throw new Error('DSP 配置包内容无效')
  }
  const assets = manifest.assets.filter(isArchiveAsset)
  if (assets.length !== manifest.assets.length) throw new Error('DSP 配置包资料无效')
  return { kind: manifest.kind, schemaVersion: 1, profile: manifest.profile, assets }
}

function isDspProfile(value: unknown): value is DspProfile {
  if (!value || typeof value !== 'object') return false
  const profile = value as Partial<DspProfile>
  return (
    profile.schemaVersion === 1 &&
    typeof profile.id === 'string' &&
    typeof profile.name === 'string' &&
    typeof profile.createdAt === 'string' &&
    typeof profile.updatedAt === 'string' &&
    Array.isArray(profile.scenes) &&
    (typeof profile.pinnedSceneId === 'string' || profile.pinnedSceneId === null) &&
    Array.isArray(profile.assetIds)
  )
}

function isArchiveAsset(value: unknown): value is ProfileArchiveManifest['assets'][number] {
  if (!value || typeof value !== 'object') return false
  const entry = value as { asset?: Partial<DspAsset>; archivePath?: unknown }
  return (
    typeof entry.archivePath === 'string' &&
    entry.archivePath.startsWith('assets/') &&
    !entry.archivePath.includes('..') &&
    !!entry.asset &&
    typeof entry.asset.id === 'string' &&
    typeof entry.asset.kind === 'string' &&
    typeof entry.asset.sha256 === 'string' &&
    typeof entry.asset.name === 'string' &&
    typeof entry.asset.fileName === 'string'
  )
}

async function inspectProfileArchive(source: string): Promise<void> {
  await new Promise<void>((resolveInspect, rejectInspect) => {
    yauzl.open(source, { lazyEntries: true, validateEntrySizes: false }, (error, zipFile) => {
      if (error || !zipFile) {
        rejectInspect(error ?? new Error('无法读取 DSP 配置包'))
        return
      }
      let count = 0
      let total = 0
      let settled = false
      const fail = (reason: Error): void => {
        if (settled) return
        settled = true
        zipFile.close()
        rejectInspect(reason)
      }
      zipFile.on('entry', (entry) => {
        try {
          assertSafeArchiveEntry(entry)
          if (!entry.fileName.endsWith('/')) {
            count += 1
            total += entry.uncompressedSize
            if (count > MAX_PROFILE_FILES || total > MAX_PROFILE_ARCHIVE_BYTES) {
              throw new Error('DSP 配置包解压后过大')
            }
          }
        } catch (entryError) {
          fail(entryError instanceof Error ? entryError : new Error(String(entryError)))
          return
        }
        zipFile.readEntry()
      })
      zipFile.once('end', () => {
        if (settled) return
        settled = true
        resolveInspect()
      })
      zipFile.once('error', fail)
      zipFile.readEntry()
    })
  })
}

function assertSafeArchiveEntry(entry: ZipEntry): void {
  if (!entry.fileName || entry.fileName.length > 4096 || entry.fileName.includes('\\')) {
    throw new Error('DSP 配置包包含非法路径')
  }
  if (entry.fileName.startsWith('/') || entry.fileName.split('/').includes('..')) {
    throw new Error('DSP 配置包包含越界路径')
  }
  if (entry.uncompressedSize < 0 || !Number.isFinite(entry.uncompressedSize)) {
    throw new Error('DSP 配置包包含无效文件')
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000
  if (unixMode === 0o120000) throw new Error('DSP 配置包不能包含符号链接')
}

type ZipSourceEntry = { path: string; data: Buffer }

async function writeStoredZip(outputPath: string, entries: ZipSourceEntry[]): Promise<void> {
  if (entries.length > MAX_PROFILE_FILES) throw new Error('DSP 配置包文件过多')
  let total = 0
  for (const entry of entries) {
    assertZipPath(entry.path)
    total += entry.data.length
  }
  if (total > MAX_PROFILE_ARCHIVE_BYTES) throw new Error('DSP 配置包过大')
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + entry.data.length
  }
  const centralOffset = offset
  const centralSize = centralParts.reduce((size, part) => size + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)
  await writeFile(outputPath, Buffer.concat([...localParts, ...centralParts, end]))
}

function assertZipPath(value: string): void {
  if (!value || value.startsWith('/') || value.includes('\\') || value.split('/').includes('..')) {
    throw new Error('DSP 配置包路径无效')
  }
}

function isInside(target: string, root: string): boolean {
  const relation = relative(resolve(root), resolve(target))
  return relation === '' || (!relation.startsWith('..') && !relation.includes(':'))
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
