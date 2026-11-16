import { coreFs, coreFsPromises, coreProcess, coreStream } from '../ports/index.ts'
const { createWriteStream, mkdirSync, readdirSync, existsSync, statSync, unlinkSync, utimesSync } = coreFs
const { rename, rm } = coreFsPromises
const { Readable, pipeline } = coreStream
import { join, extname, isAbsolute, resolve } from '../../shared/portablePath.ts'
import { createHash, randomUUID } from '../../shared/portableCrypto.ts'


import { redactSensitiveText } from '../../shared/errors/redactSensitiveText.ts'
import { getMusicCacheStorageDirectories } from './musicCacheLayout.ts'
import { NCM_CACHE_MAX_BYTES, planNcmCachePrune } from './ncmCachePrune.ts'
import { buildNcmCacheIndexFromNames, parseNcmCacheFileSongId } from './ncmCacheIndex.ts'
import { downloadAutoMixSource } from './autoMixSourceDownload.ts'
import { clearUnpinnedCache, getDirectorySize } from '../network/networkCache.ts'

export function ensureMusicCacheDirectories(rootPath: string): void {
  if (!rootPath) return
  mkdirSync(rootPath, { recursive: true })
  for (const directory of getMusicCacheStorageDirectories(rootPath)) {
    mkdirSync(directory, { recursive: true })
  }
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

export interface NcmCacheOptions {
  root(): string
  fetch?: typeof fetch
  now?: () => number
  waitForStart?: (signal: AbortSignal) => Promise<void>
  /** Schedule outside the provider call: AutoMix may itself hold a source lease. */
  maintainSources?: <T>(action: (sources: readonly string[]) => Promise<T>) => Promise<T>
  maxBytes?: number
}

/** One cache owner per Core, retaining the existing on-disk layout and download policy. */
export function createNcmCache(options: NcmCacheOptions) {
  const now = options.now ?? Date.now
  const request = options.fetch ?? fetch
  const lifetime = new AbortController()
  const pending = new Set<Promise<string | null>>()
  let cacheReads = new AbortController()
  let cacheBarrier: Promise<void> | null = null
  let maintenance: Promise<unknown> | null = null
  let pruning: Promise<void> | null = null
  const pruneDirectories = new Set<string>()
  const writerTargets = new Map<string, number>()
  const pathKey = (path: string) =>
    coreProcess.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  function writing(target: string): () => void {
    const key = pathKey(target)
    writerTargets.set(key, (writerTargets.get(key) ?? 0) + 1)
    return () => {
      const count = writerTargets.get(key)!
      if (count === 1) writerTargets.delete(key)
      else writerTargets.set(key, count - 1)
    }
  }
  function getMusicCacheRoot(): string {
    const root = options.root()
    ensureMusicCacheDirectories(root)
    return root
  }
  function getNcmCacheDir(): string {
    return join(getMusicCacheRoot(), 'ncm-cache')
  }
  function track(work: Promise<string | null>): Promise<string | null> {
    pending.add(work)
    void work.finally(() => pending.delete(work)).catch(() => undefined)
    return work
  }
  function start(action: () => Promise<string | null>): Promise<string | null> {
    if (cacheBarrier) return cacheBarrier.then(() => start(action))
    if (lifetime.signal.aborted) return Promise.resolve(null)
    return track(action())
  }
  function getCachedNcmSong(songId: number): string | null {
    if (cacheBarrier || lifetime.signal.aborted) return null
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
      const accessedAt = new Date(now())
      utimesSync(fullPath, accessedAt, accessedAt)
    } catch {
      /* 只读文件系统等场景下放弃 touch，不影响命中。 */
    }
    return fullPath
  }

  /**
   * NetEase CDN URLs rotate edge hostnames, expiration timestamps, and hex auth
   * signatures on every `/song/url/v1` resolution. Canonicalize the timed object
   * path so repeat plays across restarts reuse the verified cached audio file.
   */
  function computeNcmCacheSourceKey(url: string): string {
    try {
      const parsed = new URL(url)
      if (parsed.hostname.toLowerCase().endsWith('.music.126.net')) {
        const assetMatch = /^\/\d{8,16}\/[0-9a-f]{16,64}(\/.+)$/i.exec(parsed.pathname)
        if (assetMatch) {
          return createHash('sha256').update(`ncm-asset:${assetMatch[1]}`).digest('hex')
        }
      }
    } catch {
      /* keep raw url hash fallback */
    }
    return createHash('sha256').update(url).digest('hex')
  }

  function isHashedNcmCacheFileName(name: string, songId: number): boolean {
    const prefix = `${songId}.`
    if (!name.startsWith(prefix)) return false
    const rest = name.slice(prefix.length)
    const dot = rest.indexOf('.')
    return dot >= 16 && /^[0-9a-f]+$/i.test(rest.slice(0, dot))
  }

  function findMatchingCachedNcmSong(
    songId: number,
    url: string,
    fileName?: string,
    expectedBytes?: number | null
  ): string | null {
    if (cacheBarrier || lifetime.signal.aborted) return null
    if (!Number.isFinite(songId) || songId <= 0 || !isSafeRemoteMediaUrl(url)) return null
    const entry = getNcmCacheEntryName(songId)
    if (!entry) return null
    const fullPath = join(entry.dir, entry.name)
    let size = 0
    try {
      const info = statSync(fullPath)
      if (!info.isFile() || info.size <= 0) {
        if (ncmCacheIndex?.dir === entry.dir) ncmCacheIndex.files.delete(songId)
        return null
      }
      size = info.size
    } catch {
      if (ncmCacheIndex?.dir === entry.dir) ncmCacheIndex.files.delete(songId)
      return null
    }
    const sourceKey = computeNcmCacheSourceKey(url)
    const keyMatch = entry.name.startsWith(`${songId}.${sourceKey}.`)
    const hasExpectedBytes =
      expectedBytes != null && Number.isFinite(expectedBytes) && expectedBytes > 0
    const validSize = !hasExpectedBytes || size === expectedBytes
    const expectedExt = inferNcmCacheExtension(url, null, fileName).toLowerCase()
    const extMatch = extname(entry.name).toLowerCase() === expectedExt
    const sizeMatch =
      !keyMatch &&
      hasExpectedBytes &&
      size === expectedBytes &&
      extMatch &&
      isHashedNcmCacheFileName(entry.name, songId)
    if ((!keyMatch || !validSize) && !sizeMatch) return null
    try {
      const accessedAt = new Date(now())
      utimesSync(fullPath, accessedAt, accessedAt)
    } catch {
      /* ignore mtime update failure on read-only fs */
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
    if (!options.maintainSources) return pruneDirectory(dir, [])
    pruneDirectories.add(dir)
    schedulePrune()
  }
  function schedulePrune(): void {
    if (pruning || lifetime.signal.aborted || cacheBarrier || !pruneDirectories.size) return
    pruning = options.maintainSources!(async (sources) => {
      for (const directory of pruneDirectories) {
        pruneDirectories.delete(directory)
        pruneDirectory(directory, sources)
      }
    })
      .catch((error) => {
        console.warn('网易云歌曲缓存清理失败：', redactSensitiveText(String(error)))
      })
      .finally(() => {
        pruning = null
        schedulePrune()
      })
  }
  function pruneDirectory(dir: string, sources: readonly string[]): void {
    try {
      const files = readdirSync(dir).map((name) => {
        try {
          const info = statSync(join(dir, name))
          return { name, size: info.isFile() ? info.size : 0, mtimeMs: info.mtimeMs }
        } catch {
          return { name, size: 0, mtimeMs: 0 }
        }
      })
      const pins = new Set(sources.filter(isAbsolute).map(pathKey))
      const protectedNames = new Set(
        files
          .filter(({ name }) => {
            const key = pathKey(join(dir, name))
            return (
              pins.has(key) ||
              [...writerTargets.keys()].some(
                (target) =>
                  key === target || (key.startsWith(target + '.') && name.includes('.part'))
              )
            )
          })
          .map(({ name }) => name)
      )
      const plan = planNcmCachePrune(
        files,
        options.maxBytes ?? NCM_CACHE_MAX_BYTES,
        now(),
        protectedNames
      )
      for (const name of [...plan.deleteNames, ...plan.orphanPartNames]) {
        try {
          unlinkSync(join(dir, name))
          forgetNcmCacheEntry(dir, name)
        } catch {
          /* 个别文件占用不阻塞其余清理 */
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('网易云歌曲缓存清理失败：', redactSensitiveText(message))
    }
  }

  /** 进行中的整文件缓存下载。新解析到达时旧下载全部取消（快速连切 ≤1 个活跃下载）。 */
  const activeCacheDownloads = new Map<number, AbortController>()

  // A single bounded preparation queue; normal playback retains its existing
  // delayed cache flow. A cancelled RPC never publishes a partially cached song.
  let autoMixSourceQueue: Promise<unknown> = Promise.resolve()
  async function prepareNcmAutoMixSong(
    songId: number,
    url: string,
    fileName: string | undefined,
    options: { signal?: AbortSignal; expiresAt?: number | null; expectedBytes?: number | null }
  ): Promise<string | null> {
    if (
      lifetime.signal.aborted ||
      !Number.isFinite(songId) ||
      songId <= 0 ||
      !isSafeRemoteMediaUrl(url)
    )
      return null
    const signal = AbortSignal.any([
      cacheReads.signal,
      lifetime.signal,
      ...(options.signal ? [options.signal] : [])
    ])
    options = { ...options, signal }
    const deadline = now() + 10_000
    const run = autoMixSourceQueue
      .catch(() => {})
      .then(async () => {
        options.signal?.throwIfAborted()
        if (now() >= deadline) return null
        const sourceKey = computeNcmCacheSourceKey(url)
        const cached = findMatchingCachedNcmSong(songId, url, fileName, options.expectedBytes)
        if (cached) return cached
        // Avoid an old delayed write replacing or competing with prepared bytes.
        for (const active of activeCacheDownloads.values())
          active.abort(new Error(NCM_CACHE_DOWNLOAD_SUPERSEDED_MESSAGE))
        const dir = getNcmCacheDir()
        const ext = inferNcmCacheExtension(url, null, fileName)
        const name = `${songId}.${sourceKey}${ext}`
        const target = join(dir, name)
        const finished = writing(target)
        try {
          const result = await downloadAutoMixSource(url, target, {
            ...options,
            fetch: request,
            timeoutMs: deadline - now()
          })
          rememberNcmCacheEntry(songId, dir, name)
          pruneNcmCacheDir(dir)
          return result.path
        } finally {
          finished()
        }
      })
    autoMixSourceQueue = run
    try {
      return await run
    } catch {
      options.signal?.throwIfAborted()
      return null
    }
  }

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

  async function cacheNcmSong(
    songId: number,
    url: string,
    fileName?: string
  ): Promise<string | null> {
    if (
      lifetime.signal.aborted ||
      !Number.isFinite(songId) ||
      songId <= 0 ||
      !isSafeRemoteMediaUrl(url)
    )
      return null

    const sourceKey = computeNcmCacheSourceKey(url)
    const cached = findMatchingCachedNcmSong(songId, url, fileName)
    if (cached) return cached

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
      await (options.waitForStart ?? waitForNcmCacheStartDelay)(controller.signal)
      const timer = setTimeout(() => controller.abort(), 45000)
      try {
        // NetEase CDN edges reject bare Node fetch without a browser-like UA/Referer
        // (same constraint as the twilight-media proxy and native FFmpeg open path).
        const res = await request(url, {
          signal: controller.signal,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            Referer: 'https://music.163.com/'
          }
        })
        if (!res.ok) {
          await res.body?.cancel()
          throw new Error(`HTTP ${res.status}`)
        }
        if (!res.body) throw new Error('响应没有内容流')
        const ext = inferNcmCacheExtension(url, res.headers.get('content-type'), fileName)
        const dir = getNcmCacheDir()
        const target = join(dir, `${songId}.${sourceKey}${ext}`)
        // 流式落盘：整文件不经内存（无损单曲 50-150MB）；先写 .part，完成才原子
        // rename 为成品，中断只会留下可清理的 .part 而不会混入“成品”。
        const partPath = `${target}.${randomUUID()}.part`
        const finished = writing(target)
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
        } finally {
          finished()
        }
        rememberNcmCacheEntry(songId, dir, `${songId}.${sourceKey}${ext}`)
        pruneNcmCacheDir(dir)
        return target
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      // 被新解析抢占是有意取消，静默结束；自身 45s 超时仍是故障，保留告警。
      if (lifetime.signal.aborted || cacheBarrier) return null
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

  /** Block new cache work, abort and join existing writers before filesystem IO.
   * The music-cache owner must first revoke playback previews, then acquire its
   * source-maintenance lease. Never call this from a provider source read. */
  function maintain<T>(action: () => Promise<T>): Promise<T> {
    if (cacheBarrier) throw new Error('NetEase cache maintenance is already running')
    let release!: () => void
    cacheBarrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const reason = new Error('NetEase cache is being cleared')
    cacheReads.abort(reason)
    for (const active of activeCacheDownloads.values()) active.abort(reason)
    const work = Promise.allSettled([...pending])
      .then(async () => {
        ncmCacheIndex = null
        return action()
      })
      .finally(() => {
        ncmCacheIndex = null
        cacheReads = new AbortController()
        cacheBarrier = null
        maintenance = null
        release()
        schedulePrune()
      })
    maintenance = work
    return work
  }

  return {
    getMusicCacheRoot,
    getNcmCacheDir,
    getCachedSong: getCachedNcmSong,
    resolveCachedSong: (
      songId: number,
      url: string,
      fileName?: string,
      resolveOptions?: { expectedBytes?: number | null }
    ) => findMatchingCachedNcmSong(songId, url, fileName, resolveOptions?.expectedBytes),
    cacheSong: (songId: number, url: string, fileName?: string) =>
      start(() => cacheNcmSong(songId, url, fileName)),
    prepareAutoMixSong: (...args: Parameters<typeof prepareNcmAutoMixSong>) =>
      start(() => prepareNcmAutoMixSong(...args)),
    maintain,
    cacheInfo: async () => ({ sizeBytes: await getDirectorySize(getNcmCacheDir()) }),
    clear: (sources: readonly string[], signal?: AbortSignal) =>
      maintain(async () => {
        signal?.throwIfAborted()
        await clearUnpinnedCache(getNcmCacheDir(), sources, signal)
        return { sizeBytes: await getDirectorySize(getNcmCacheDir()) }
      }),
    async shutdown(): Promise<void> {
      lifetime.abort(new Error('NetEase cache is shutting down'))
      for (const active of activeCacheDownloads.values()) active.abort(lifetime.signal.reason)
      await Promise.allSettled(pending)
      await maintenance?.catch(() => {})
      await pruning
    }
  }
}
