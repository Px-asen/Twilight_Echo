import { app } from 'electron'
import { join } from 'node:path'
import { runtime } from '../core/runtime'
import { createNcmCache } from '../../core/providers/ncmCache.ts'
export {
  ensureMusicCacheDirectories,
  inferNcmCacheExtension
} from '../../core/providers/ncmCache.ts'

const cache = createNcmCache({
  root: () => runtime.appSettings.musicCachePath || join(app.getPath('userData'), 'music-cache')
})
export const getMusicCacheRoot = cache.getMusicCacheRoot
export const getNcmCacheDir = cache.getNcmCacheDir
export const getCachedNcmSong = cache.getCachedSong
export const resolveCachedNcmSong = cache.resolveCachedSong
export const cacheNcmSong = cache.cacheSong
export const prepareNcmAutoMixSong = cache.prepareAutoMixSong
export const shutdownNcmCache = cache.shutdown
