import { app } from 'electron'
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  existsSync,
  statSync,
  unlinkSync,
  utimesSync
} from 'fs'
import { rename, rm } from 'fs/promises'
import { join, extname } from 'path'
import { createHash, randomUUID } from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { runtime } from '../core/runtime'
import { redactSensitiveText } from '../security/secureStorage.ts'
import { getMusicCacheStorageDirectories } from './musicCacheLayout.ts'
import { NCM_CACHE_MAX_BYTES, planNcmCachePrune } from './ncmCachePrune.ts'
import { buildNcmCacheIndexFromNames, parseNcmCacheFileSongId } from './ncmCacheIndex.ts'

export function ensureMusicCacheDirectories(rootPath: string): void {
  if (!rootPath) return
  mkdirSync(rootPath, { recursive: true })
  for (const directory of getMusicCacheStorageDirectories(rootPath)) {
    mkdirSync(directory, { recursive: true })
  }
}

export function getMusicCacheRoot(): string {
  const root = runtime.appSettings.musicCachePath || join(app.getPath('userData'), 'music-cache')
  ensureMusicCacheDirectories(root)
  return root
}

export function getNcmCacheDir(): string {
  const dir = join(getMusicCacheRoot(), 'ncm-cache')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function inferNcmCacheExtension(
  url: string,
  contentType?: string | null,
  fileName?: string
): string {
  const nameExt = fileName ? extname(fileName).toLowerCase() : ''
  if (nameExt && /^[a-z0-9.]+$/i.test(nameExt)) return nameExt

  const mime = (contentType || '').toLowerCase()
  if (mime.includes('flac')) return '.flac'
  if (mime.includes('wav')) return '.wav'
  if (mime.includes('aac')) return '.aac'
  if (mime.includes('mp4') || mime.includes('m4a')) return '.m4a'
  if (mime.includes('ogg')) return '.ogg'

  try {
    const parsed = new URL(url)
    const pathExt = extname(parsed.pathname).toLowerCase()
    if (pathExt && /^[a-z0-9.]+$/i.test(pathExt)) return pathExt
  } catch {
    /* keep fallback */
  }

  return '.mp3'
}

export function getCachedNcmSong(songId: number): string | null {
  const entry = getNcmCacheEntryName(songId)
  if (!entry) return null
  const fullPath = join(entry.dir, entry.name)
  if (!existsSync(fullPath)) {
    // 外部手动删除后索引会陈旧：同步剔除并视为未命中。
    if (ncmCacheIndex?.dir === entry.dir) ncmCacheIndex.files.delete(songId)
    return null
  }
  // LRU 依靠 mtime：命中即刷新，让容量淘汰驱逐真正最久不用的条目。
  try {
    const now = new Date()
    utimesSync(fullPath, now, now)
  } catch {
    /* 只读文件系统等场景下放弃 touch，不影响命中。 */
  }
  return fullPath
}

/**
 * 缓存目录快照索引：命中走内存，免去每次播放的整目录 readdirSync（批量 8.3）。
 * 索引内 .part 临时文件绝不入录，缓存目录变更（设置改路径）即整体失效惰重建。
 */
let ncmCacheIndex: { dir: string; files: Map<number, string> } | null = null

function getNcmCacheEntryName(songId: number): { dir: string; name: string } | null {
  const dir = getNcmCacheDir()
  if (!ncmCacheIndex || ncmCacheIndex.dir !== dir) {
    let files: Map<number, string>
    try {
      files = buildNcmCacheIndexFromNames(readdirSync(dir))
    } catch {
      // 目录暂不可读不阻断播放：记空索引也不会误伤，写入成功时会补条目。
      files = new Map()
    }
    ncmCacheIndex = { dir, files }
  }
  const name = ncmCacheIndex.files.get(songId)
  return name ? { dir, name } : null
}

function rememberNcmCacheEntry(songId: number, dir: string, fileName: string): void {
  if (ncmCacheIndex?.dir !== dir) return
  ncmCacheIndex.files.set(songId, fileName)
}

function forgetNcmCacheEntry(dir: string, fileName: string): void {
  if (ncmCacheIndex?.dir !== dir) return
  const songId = parseNcmCacheFileSongId(fileName)
  if (songId == null) return
  if (ncmCacheIndex.files.get(songId) === fileName) ncmCacheIndex.files.delete(songId)
}

/** 容量上限 + 孤儿 .part 清理；出问题（权限/占用）只告警，不阻断缓存路径。 */
function pruneNcmCacheDir(dir: string): void {
  try {
    const files = readdirSync(dir).map((name) => {
      try {
        const info = statSync(join(dir, name))
        return { name, size: info.isFile() ? info.size : 0, mtimeMs: info.mtimeMs }
      } catch {
        return { name, size: 0, mtimeMs: 0 }
      }
    })
    const plan = planNcmCachePrune(files, NCM_CACHE_MAX_BYTES)
    for (const name of [...plan.deleteNames, ...plan.orphanPartNames]) {
      try {
        unlinkSync(join(dir, name))
      } catch {
        /* 个别文件占用不阻塞其余清理 */
      }
      // 无论删除成功与否都从索引剔除：失败（占用）时下一次 existsSync 校验
      // 仍会兜住，索引陈旧比索引漏删更安全。
      forgetNcmCacheEntry(dir, name)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('网易云歌曲缓存清理失败：', redactSensitiveText(message))
  }
}

/** 进行中的整文件缓存下载。新解析到达时旧下载全部取消（快速连切 ≤1 个活跃下载）。 */
const activeCacheDownloads = new Map<number, AbortController>()

/** 绝大多数跳歌发生在前 30s：延迟启动让被切走的歌完全不产生下载流量（批量 8.1③）。 */
const NCM_CACHE_DOWNLOAD_START_DELAY_MS = 30_000

const NCM_CACHE_DOWNLOAD_SUPERSEDED_MESSAGE =
  'ncm cache download superseded by a newer playback resolution'

function waitForNcmCacheStartDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, NCM_CACHE_DOWNLOAD_START_DELAY_MS)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function cacheNcmSong(
  songId: number,
  url: string,
  fileName?: string
): Promise<string | null> {
  if (!Number.isFinite(songId) || songId <= 0 || !isSafeRemoteMediaUrl(url)) return null

  const sourceKey = createHash('sha256').update(url).digest('hex')
  const cached = getCachedNcmSong(songId)
  if (cached && cached.includes(`${songId}.${sourceKey}.`)) return cached

  // 批量 8.1②：快速连切时只允许当前解析对应的一份全文件下载在跑。
  // 新解析到达即取消所有进行中的缓存下载（含同 songId 的旧 URL 重解析）。
  for (const active of activeCacheDownloads.values()) {
    active.abort(new Error(NCM_CACHE_DOWNLOAD_SUPERSEDED_MESSAGE))
  }
  activeCacheDownloads.clear()

  const controller = new AbortController()
  activeCacheDownloads.set(songId, controller)
  try {
    // 延迟启动：期间被新歌抢占取消的歌不产生任何下载流量（批量 8.1③）。
    // 45s 下载超时从实际启动后才计，排队延迟不算下载时间。
    await waitForNcmCacheStartDelay(controller.signal)
    const timer = setTimeout(() => controller.abort(), 45000)
    try {
      // NetEase CDN edges reject bare Node fetch without a browser-like UA/Referer
      // (same constraint as the twilight-media proxy and native FFmpeg open path).
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          Referer: 'https://music.163.com/'
        }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('响应没有内容流')
      const ext = inferNcmCacheExtension(url, res.headers.get('content-type'), fileName)
      const dir = getNcmCacheDir()
      const target = join(dir, `${songId}.${sourceKey}${ext}`)
      // 流式落盘：整文件不经内存（无损单曲 50-150MB）；先写 .part，完成才原子
      // rename 为成品，中断只会留下可清理的 .part 而不会混入“成品”。
      const partPath = `${target}.${randomUUID()}.part`
      try {
        await pipeline(
          Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
          createWriteStream(partPath, { flags: 'wx' }),
          { signal: controller.signal }
        )
        await rename(partPath, target)
      } catch (error) {
        await rm(partPath, { force: true }).catch(() => undefined)
        throw error
      }
      rememberNcmCacheEntry(songId, dir, `${songId}.${sourceKey}${ext}`)
      pruneNcmCacheDir(dir)
      return target
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    // 被新解析抢占是有意取消，静默结束；自身 45s 超时仍是故障，保留告警。
    if (
      controller.signal.reason instanceof Error &&
      controller.signal.reason.message === NCM_CACHE_DOWNLOAD_SUPERSEDED_MESSAGE
    ) {
      return null
    }
    const message = err instanceof Error ? err.message : String(err)
    console.warn('网易云歌曲缓存失败：', songId, redactSensitiveText(message))
    return null
  } finally {
    if (activeCacheDownloads.get(songId) === controller) {
      activeCacheDownloads.delete(songId)
    }
  }
}

function isSafeRemoteMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    if (parsed.username || parsed.password) return false
    const hostname = parsed.hostname.toLowerCase()
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === '[::1]'
    ) {
      return false
    }
    if (isPrivateIpv4(hostname)) return false
    return true
  } catch {
    return false
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number.parseInt(part, 10))
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false
  }
  const [a, b] = parts
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}
