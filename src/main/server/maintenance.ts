import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  toNamespacedPath
} from 'node:path'
import { lockServerProfile, readServerProfile } from './profile.ts'

interface InventoryEntry {
  path: string
  size: number
}
interface SnapshotManifest {
  format: 'twilight-server-snapshot'
  version: 1
  applicationVersion: string
  platform: NodeJS.Platform
  createdAt: string
  profileId: string
  files: InventoryEntry[]
}
const transient = new Set(['server.lock', 'server-run.json', 'server-service.log'])

async function inventory(root: string, prefix = ''): Promise<InventoryEntry[]> {
  const files: InventoryEntry[] = []
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name
    const stat = await lstat(join(root, path))
    if (stat.isSymbolicLink()) throw new Error(`备份目录包含链接，请先将资源放入数据目录：${path}`)
    if (stat.isDirectory()) files.push(...(await inventory(root, path)))
    else if (stat.isFile()) files.push({ path, size: stat.size })
    else throw new Error(`不支持的备份文件类型：${path}`)
  }
  return files
}

async function copyInventory(
  source: string,
  destination: string,
  files: InventoryEntry[]
): Promise<void> {
  for (const file of files) {
    const path = join(destination, file.path)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await copyFile(join(source, file.path), path, constants.COPYFILE_EXCL)
  }
}

async function checkDatabases(root: string, files: InventoryEntry[]): Promise<void> {
  for (const file of files.filter((file) => file.path.endsWith('.sqlite'))) {
    const database = new DatabaseSync(toNamespacedPath(join(root, file.path)), { readOnly: true })
    try {
      const rows = database.prepare('PRAGMA quick_check').all()
      if (rows.length !== 1 || rows[0].quick_check !== 'ok')
        throw new Error(`SQLite 检查失败：${file.path}`)
    } finally {
      database.close()
    }
  }
}

export async function newDestination(source: string, destination: string): Promise<string> {
  if (!isAbsolute(destination)) throw new Error('备份／恢复目标必须是绝对路径')
  const canonical = join(await realpath(dirname(destination)), basename(destination))
  const within = relative(source, canonical)
  if (!within || (!within.startsWith(`..${sep}`) && within !== '..' && !isAbsolute(within)))
    throw new Error('目标不能位于源目录中')
  try {
    await lstat(canonical)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return canonical
    throw error
  }
  throw new Error('目标已存在；恢复不会覆盖原数据，请使用新的目录')
}

/** Write into an owned sibling, publish only after inventory and SQLite checks succeed. */
export async function publish(
  destination: string,
  write: (staged: string) => Promise<void>
): Promise<void> {
  const staged = `${destination}.partial-${randomUUID()}`
  await mkdir(staged, { mode: 0o700 })
  try {
    await write(staged)
    await rename(staged, destination)
  } catch (error) {
    if (dirname(resolve(staged)) !== dirname(resolve(destination))) throw error
    await rm(staged, { recursive: true, force: true })
    throw error
  }
}

export async function backupServerProfile(
  root: string,
  destination: string,
  applicationVersion: string
): Promise<SnapshotManifest> {
  const source = await realpath(root)
  const target = await newDestination(source, destination)
  const unlock = await lockServerProfile(source)
  try {
    return await snapshotLockedServerProfile(source, target, applicationVersion)
  } finally {
    await unlock()
  }
}

/** Host-owned upgrade operation already holds the Profile lock across snapshot,
 * candidate validation and activation. Ordinary backup callers use the wrapper. */
export async function snapshotLockedServerProfile(
  source: string,
  target: string,
  applicationVersion: string
): Promise<SnapshotManifest> {
  const profile = await readServerProfile(source)
  const files = (await inventory(source)).filter((file) => !transient.has(file.path))
  let manifest: SnapshotManifest
  await publish(target, async (staged) => {
    const data = join(staged, 'data')
    await mkdir(data, { mode: 0o700 })
    await copyInventory(source, data, files)
    await checkDatabases(data, files)
    manifest = {
      format: 'twilight-server-snapshot',
      version: 1,
      applicationVersion,
      platform: process.platform,
      createdAt: new Date().toISOString(),
      profileId: profile.id,
      files: await inventory(data)
    }
    await writeFile(join(staged, 'snapshot.json'), JSON.stringify(manifest, null, 2), {
      flag: 'wx',
      mode: 0o600
    })
  })
  return manifest!
}

export async function restoreServerProfile(
  snapshot: string,
  destination: string,
  applicationVersion: string
): Promise<SnapshotManifest> {
  const source = await realpath(snapshot)
  const target = await newDestination(source, destination)
  const manifest = JSON.parse(
    await readFile(join(source, 'snapshot.json'), 'utf8')
  ) as SnapshotManifest
  if (
    manifest.format !== 'twilight-server-snapshot' ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.files)
  )
    throw new Error('Server 备份清单格式无效')
  if (manifest.applicationVersion !== applicationVersion || manifest.platform !== process.platform)
    throw new Error('请使用生成备份时的应用版本和操作系统恢复；升级失败时先恢复原版本程序')
  const data = join(source, 'data')
  const files = await inventory(data)
  if (JSON.stringify(files) !== JSON.stringify(manifest.files))
    throw new Error('备份文件清单／大小不一致，恢复未执行')
  if (files.some((file) => transient.has(file.path)))
    throw new Error('备份含运行时锁或管理凭据文件')
  await publish(target, async (staged) => {
    await copyInventory(data, staged, files)
    await checkDatabases(staged, files)
    const profile = await readServerProfile(staged)
    if (profile.id !== manifest.profileId) throw new Error('备份 Profile 身份不一致')
  })
  return manifest
}
