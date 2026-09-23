import extract from 'extract-zip'
import { app } from 'electron'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  copyFile,
  cp
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import {
  THEME_ARCHIVE_SCHEMA_VERSION,
  normalizeThemeAssets,
  normalizeThemeProfile,
  type ThemeAssetReference,
  type ThemeAssetType,
  type ThemeArchiveDocumentV2,
  type ThemeProfileV2
} from '../../shared/theme.ts'
import { validateThemeArchiveBuffer as preflightThemeArchive } from './themeArchiveValidation.ts'
import { tryParseJsonWithNestingLimit } from '../security/jsonSafety.ts'

const MAX_THEME_ARCHIVE_BYTES = 20 * 1024 * 1024
const MAX_THEME_EXTRACTED_BYTES = 40 * 1024 * 1024
const MAX_THEME_ARCHIVE_FILES = 128
const MAX_THEME_JSON_BYTES = 2 * 1024 * 1024
const THEME_ASSET_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.woff2'])

interface ZipEntry {
  absolute: string
  relative: string
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

export async function exportThemeArchive(profile: ThemeProfileV2, target: string): Promise<void> {
  const normalized = normalizeThemeProfile(profile)
  if (!normalized) throw new Error('主题档案无效')
  const temporary = await mkdtemp(join(tmpdir(), 'twilight-theme-export-'))
  try {
    const assets = await copyThemeAssetsForExport(normalized, temporary)
    const document: ThemeArchiveDocumentV2 = {
      schemaVersion: THEME_ARCHIVE_SCHEMA_VERSION,
      profile: normalized,
      assets
    }
    await writeFile(join(temporary, 'theme.json'), JSON.stringify(document, null, 2), 'utf8')
    await writeStoredZip(temporary, target)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function importThemeArchive(source: string): Promise<ThemeProfileV2> {
  const archiveStat = await stat(source)
  if (!archiveStat.isFile() || archiveStat.size > MAX_THEME_ARCHIVE_BYTES) {
    throw new Error('主题包不存在或超过 20 MB')
  }
  preflightThemeArchive(await readFile(source))
  const temporary = await mkdtemp(join(tmpdir(), 'twilight-theme-import-'))
  try {
    await extract(source, { dir: temporary })
    const entries = await collectSafeFiles(temporary)
    const themeEntry = entries.find((entry) => entry.relative === 'theme.json')
    if (!themeEntry) throw new Error('主题包根目录缺少 theme.json')
    const themeStat = await stat(themeEntry.absolute)
    if (themeStat.size > MAX_THEME_JSON_BYTES) throw new Error('theme.json 过大')
    const parsedResult = tryParseJsonWithNestingLimit(await readFile(themeEntry.absolute, 'utf8'))
    if (!parsedResult.ok) {
      throw new Error(parsedResult.reason === 'too-deep' ? 'theme.json ????' : 'theme.json ????')
    }
    const parsed = parsedResult.value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('theme.json 必须是对象')
    }
    const document = parsed as {
      schemaVersion?: unknown
      profile?: unknown
      assets?: unknown
    }
    if (document.schemaVersion !== 1 && document.schemaVersion !== THEME_ARCHIVE_SCHEMA_VERSION) {
      throw new Error('不支持的主题包版本')
    }
    const profileVersion =
      document.profile && typeof document.profile === 'object' && !Array.isArray(document.profile)
        ? (document.profile as { schemaVersion?: unknown }).schemaVersion
        : undefined
    if (profileVersion !== document.schemaVersion) throw new Error('主题包与档案版本不一致')
    const assets = await validateDeclaredAssets(document.assets, entries)
    const sourceProfile = normalizeThemeProfile({
      ...(document.profile as ThemeProfileV2),
      assets
    })
    if (!sourceProfile) throw new Error('主题包中的档案无效')
    const now = new Date().toISOString()
    const profile: ThemeProfileV2 = {
      ...sourceProfile,
      id: `user:${randomUUID()}`,
      createdAt: now,
      updatedAt: now
    }
    await persistImportedAssets(profile.id, entries)
    return profile
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('theme.json 不是有效 JSON')
    throw error
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function copyThemeAssetsForExport(
  profile: ThemeProfileV2,
  targetRoot: string
): Promise<ThemeAssetReference[]> {
  const sourceRoot = getThemeAssetRoot(profile.id)
  try {
    const entries = await collectSafeFiles(sourceRoot, true)
    const byPath = new Map(entries.map((entry) => [entry.relative, entry]))
    const assets: ThemeAssetReference[] = []
    for (const asset of profile.assets ?? []) {
      const entry = byPath.get(asset.path)
      if (!entry) throw new Error(`主题资源不存在: ${asset.id}`)
      const archivePath = `assets/${asset.path}`
      const target = join(targetRoot, ...archivePath.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await copyFile(entry.absolute, target)
      assets.push({
        id: asset.id,
        path: archivePath,
        type: asset.type
      })
    }
    return assets
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function persistImportedAssets(profileId: string, entries: ZipEntry[]): Promise<void> {
  const targetRoot = getThemeAssetRoot(profileId)
  await rm(targetRoot, { recursive: true, force: true })
  for (const entry of entries) {
    if (!entry.relative.startsWith('assets/')) continue
    const assetRelative = entry.relative.slice('assets/'.length)
    const target = join(targetRoot, ...assetRelative.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await copyFile(entry.absolute, target)
  }
}

async function validateDeclaredAssets(
  value: unknown,
  entries: ZipEntry[]
): Promise<ThemeAssetReference[]> {
  const declared = Array.isArray(value) ? value : []
  const available = new Set(entries.map((entry) => entry.relative))
  const assetEntries = entries.filter((entry) => entry.relative.startsWith('assets/'))
  const declaredPaths = new Set<string>()
  const declaredIds = new Set<string>()
  const assets: ThemeAssetReference[] = []
  for (const asset of declared) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
      throw new Error('主题资源声明无效')
    }
    const path = (asset as { path?: unknown }).path
    const type = (asset as { type?: unknown }).type
    const id = (asset as { id?: unknown }).id
    const extension = typeof path === 'string' ? extname(path).toLowerCase() : ''
    if (
      typeof id !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) ||
      typeof path !== 'string' ||
      !path.startsWith('assets/') ||
      !available.has(path) ||
      (type !== 'image' && type !== 'font') ||
      (type === 'font' ? extension !== '.woff2' : extension === '.woff2') ||
      declaredPaths.has(path) ||
      declaredIds.has(id)
    ) {
      throw new Error('主题资源声明与包内容不一致')
    }
    declaredPaths.add(path)
    declaredIds.add(id)
    assets.push({ id, path: path.slice('assets/'.length), type })
  }
  if (declaredPaths.size !== assetEntries.length) {
    throw new Error('主题包包含未声明的资源')
  }
  for (const entry of assetEntries) await validateThemeAssetContent(entry)
  return normalizeThemeAssets(assets)
}

async function validateThemeAssetContent(entry: ZipEntry): Promise<void> {
  const data = await readFile(entry.absolute)
  const extension = extname(entry.relative).toLowerCase()
  if (!isThemeAssetContentValid(data, extension)) {
    throw new Error(`主题资源内容与扩展名不匹配: ${entry.relative}`)
  }
}

function isThemeAssetContentValid(data: Buffer, extension: string): boolean {
  const valid =
    (extension === '.png' &&
      data.length >= 8 &&
      data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    ((extension === '.jpg' || extension === '.jpeg') &&
      data.length >= 3 &&
      data[0] === 0xff &&
      data[1] === 0xd8 &&
      data[2] === 0xff) ||
    (extension === '.webp' &&
      data.length >= 12 &&
      data.toString('ascii', 0, 4) === 'RIFF' &&
      data.toString('ascii', 8, 12) === 'WEBP') ||
    (extension === '.woff2' && data.length >= 4 && data.toString('ascii', 0, 4) === 'wOF2')
  return valid
}

async function collectSafeFiles(
  root: string,
  allowMissing = false,
  format: 'theme' | 'plugin-theme' = 'theme'
): Promise<ZipEntry[]> {
  const rootPath = resolve(root)
  const files: ZipEntry[] = []
  let totalBytes = 0

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const relativePath = relative(rootPath, absolute).split(sep).join('/')
      if (!relativePath || relativePath.startsWith('../') || relativePath.includes('/../')) {
        throw new Error('主题资源路径越界')
      }
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new Error('主题包不能包含符号链接')
      if (info.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!info.isFile()) throw new Error('主题包包含不支持的文件类型')
      if (format === 'plugin-theme') {
        if (!['plugin.json', 'theme.css', 'ATTRIBUTION.json'].includes(relativePath))
          throw new Error('插件主题包包含非主题文件')
      } else if (relativePath !== 'theme.json') {
        if (!relativePath.startsWith('assets/'))
          throw new Error('主题包只能包含 theme.json 与 assets/')
        if (!THEME_ASSET_EXTENSIONS.has(extname(relativePath).toLowerCase())) {
          throw new Error('主题包包含不支持的资源格式')
        }
      }
      totalBytes += info.size
      if (totalBytes > MAX_THEME_EXTRACTED_BYTES) throw new Error('主题包解压后超过 40 MB')
      files.push({ absolute, relative: relativePath })
      if (files.length > MAX_THEME_ARCHIVE_FILES) throw new Error('主题包文件数量过多')
    }
  }

  try {
    await walk(rootPath)
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return files.sort((left, right) => left.relative.localeCompare(right.relative))
}

function getThemeAssetRoot(profileId: string): string {
  const safeId = profileId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return join(app.getPath('userData'), 'theme-assets', safeId)
}

export async function importThemeAsset(
  profileId: string,
  sourcePath: string,
  type: ThemeAssetType
): Promise<ThemeAssetReference> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(profileId)) {
    throw new Error('主题档案标识无效')
  }
  const sourceStat = await stat(sourcePath)
  if (!sourceStat.isFile() || sourceStat.size > MAX_THEME_ARCHIVE_BYTES) {
    throw new Error('主题资源不存在或超过 20 MB')
  }
  const extension = extname(sourcePath).toLowerCase()
  if (
    !THEME_ASSET_EXTENSIONS.has(extension) ||
    (type === 'font' ? extension !== '.woff2' : extension === '.woff2')
  ) {
    throw new Error(type === 'font' ? '请选择 WOFF2 字体' : '请选择受支持的图片')
  }
  const data = await readFile(sourcePath)
  if (!isThemeAssetContentValid(data, extension)) throw new Error('主题资源内容与格式不匹配')
  const hash = createHash('sha256').update(data).digest('hex')
  const normalizedExtension = extension === '.jpeg' ? '.jpg' : extension
  const fileName = `${hash.slice(0, 24)}${normalizedExtension}`
  const targetRoot = getThemeAssetRoot(profileId)
  await mkdir(targetRoot, { recursive: true })
  await writeFile(join(targetRoot, fileName), data)
  return { id: `asset-${hash.slice(0, 16)}`, path: fileName, type }
}

export async function validateThemeProfileAssets(
  profileId: string,
  assets: ThemeAssetReference[]
): Promise<boolean> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(profileId)) return false
  const normalized = normalizeThemeAssets(assets)
  if (normalized.length !== assets.length) return false
  for (const asset of normalized) {
    const target = resolveThemeAssetFile(profileId, asset.path)
    if (!target) return false
    try {
      const info = await stat(target)
      if (!info.isFile() || info.size > MAX_THEME_ARCHIVE_BYTES) return false
      if (!isThemeAssetContentValid(await readFile(target), extname(asset.path).toLowerCase())) {
        return false
      }
    } catch {
      return false
    }
  }
  return true
}

export function resolveThemeAssetFile(profileId: string, assetPath: string): string | null {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(profileId)) return null
  const normalized = assetPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!normalized || normalized.split('/').some((segment) => !segment || segment === '..')) {
    return null
  }
  if (!THEME_ASSET_EXTENSIONS.has(extname(normalized).toLowerCase())) return null
  const root = resolve(getThemeAssetRoot(profileId))
  const target = resolve(root, ...normalized.split('/'))
  return target.startsWith(`${root}${sep}`) ? target : null
}

export async function deleteThemeAssets(profileId: string): Promise<void> {
  await rm(getThemeAssetRoot(profileId), { recursive: true, force: true })
}

export async function copyThemeAssets(
  sourceProfileId: string,
  targetProfileId: string
): Promise<void> {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(sourceProfileId) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(targetProfileId)
  ) {
    throw new Error('主题档案标识无效')
  }
  const source = getThemeAssetRoot(sourceProfileId)
  const target = getThemeAssetRoot(targetProfileId)
  await rm(target, { recursive: true, force: true })
  try {
    await cp(source, target, { recursive: true, errorOnExist: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function writeStoredZip(
  root: string,
  outputFile: string,
  format: 'theme' | 'plugin-theme' = 'theme'
): Promise<void> {
  const files = await collectSafeFiles(root, false, format)
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const data = await readFile(file.absolute)
    const name = Buffer.from(file.relative, 'utf8')
    const checksum = crc32(data)
    const time = msDosDateTime(new Date())
    const localHeader = Buffer.concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(time.dosTime),
      uint16(time.dosDate),
      uint32(checksum),
      uint32(data.length),
      uint32(data.length),
      uint16(name.length),
      uint16(0),
      name
    ])
    chunks.push(localHeader, data)
    central.push(
      Buffer.concat([
        uint32(0x02014b50),
        uint16(20),
        uint16(20),
        uint16(0x0800),
        uint16(0),
        uint16(time.dosTime),
        uint16(time.dosDate),
        uint32(checksum),
        uint32(data.length),
        uint32(data.length),
        uint16(name.length),
        uint16(0),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(0),
        uint32(offset),
        name
      ])
    )
    offset += localHeader.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.concat([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(files.length),
    uint16(files.length),
    uint32(directory.length),
    uint32(offset),
    uint16(0)
  ])
  await mkdir(dirname(outputFile), { recursive: true })
  await writeFile(outputFile, Buffer.concat([...chunks, directory, end]))
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function uint16(value: number): Buffer {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value)
  return buffer
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0)
  return buffer
}

function msDosDateTime(date: Date): { dosDate: number; dosTime: number } {
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}
