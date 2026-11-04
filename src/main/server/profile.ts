import { mkdir, readdir, readFile, writeFile, open, unlink, realpath } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface ServerProfile {
  version: 1
  id: string
  libraryRoots: string[]
  vst3Roots: string[]
  remotePluginManagement?: boolean
}

export async function initializeServerProfile(
  directory: string,
  libraryRoots: string[]
): Promise<void> {
  if (!isAbsolute(directory)) throw new Error('--data 必须是绝对路径')
  const roots = await Promise.all(libraryRoots.map((path) => realpath(resolve(path))))
  await mkdir(directory, { recursive: true })
  if ((await readdir(directory)).length)
    throw new Error('初始化需要空目录；不能直接使用桌面端数据目录')
  const profile: ServerProfile = {
    version: 1,
    id: randomUUID(),
    libraryRoots: roots,
    vst3Roots: [],
    remotePluginManagement: false
  }
  await writeFile(join(directory, 'server.json'), `${JSON.stringify(profile, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600
  })
}

export async function readServerProfile(directory: string): Promise<ServerProfile> {
  if (!isAbsolute(directory)) throw new Error('--data 必须是绝对路径')
  const value = JSON.parse(await readFile(join(directory, 'server.json'), 'utf8')) as ServerProfile
  if (
    value.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    !Array.isArray(value.libraryRoots) ||
    !Array.isArray(value.vst3Roots) ||
    (value.remotePluginManagement !== undefined && typeof value.remotePluginManagement !== 'boolean') ||
    ![...value.libraryRoots, ...value.vst3Roots].every(
      (path) => typeof path === 'string' && isAbsolute(path)
    )
  )
    throw new Error('Server 配置格式无效')
  return value
}

/** A stale lock is explicit recovery, never permission to open the same SQLite profile twice. */
export async function lockServerProfile(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, 'server.lock')
  const lock = await open(path, 'wx', 0o600)
  await lock.writeFile(JSON.stringify({ pid: process.pid }))
  return async () => {
    await lock.close()
    await unlink(path)
  }
}

export async function unlockStoppedServerProfile(directory: string): Promise<void> {
  await readServerProfile(directory)
  const path = join(directory, 'server.lock')
  const { pid } = JSON.parse(await readFile(path, 'utf8'))
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('锁文件 PID 无效，请人工检查')
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    await unlink(path)
    return
  }
  throw new Error(`Server 进程 ${pid} 仍存在，不能解除锁定`)
}
