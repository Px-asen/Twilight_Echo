import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import type { CoreSupervisorOptions } from '../coreProcess/supervisor.ts'
import {
  createArtworkProjection,
  createQueueCoverResolver
} from '../coreProcess/artworkProjection.ts'
import {
  RemoteMediaGrantService,
  protectProviderMedia,
  createRemoteMediaRequestHandler
} from '../security/remoteMediaGrants.ts'
import { parsePersonalMusicArtwork } from '../../shared/personalMusicArtwork.ts'
import { isCanonicalPathInside, resolveCanonicalExistingPath } from '../security/pathGrants.ts'
import { resizeServerArtwork } from './imageResize.ts'

/** Phones receive bounded raster previews, never host paths, source URLs or Electron protocols. */
export function createServerArtwork(
  directory: string
): NonNullable<CoreSupervisorOptions['platform']> {
  const grants = new RemoteMediaGrantService()
  const request = createRemoteMediaRequestHandler({ grants, fetch: globalThis.fetch })
  const cachedName = (handle: string) => {
    const name = handle.slice('cover://'.length)
    if (!/^cover:\/\/[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp|gif)$/.test(handle))
      throw new Error('无效的封面缓存标识')
    return name
  }
  const normalize = async (handle: string) => {
    await cachedFile(handle)
    return handle
  }
  const cachedFile = async (handle: string) => {
    const root = await resolveCanonicalExistingPath(directory, 'directory')
    const file = await resolveCanonicalExistingPath(join(root, cachedName(handle)), 'file')
    if (!isCanonicalPathInside(root, file)) throw new Error('封面文件越过缓存目录')
    return file
  }
  const projection = {
    normalizeCachedCover: normalize,
    migrateBase64Cover: (data: string) => parsePersonalMusicArtwork(data)?.dataUrl ?? null,
    grant: (source: string, expiresAt?: number) => grants.grant(source, 'image', expiresAt),
    resolve: (handle: string) => grants.resolve(handle, 'image')
  }
  return {
    'media.resolveAudio': async ({ handle }) => grants.resolve(handle, 'audio'),
    'media.protectProviderResult': async ({ value, method }) => protectProviderMedia(value, method, grants),
    'artwork.normalizeCachedCover': ({ handle }) => normalize(handle),
    'artwork.present': createArtworkProjection(projection),
    'artwork.resolveQueueCovers': createQueueCoverResolver(projection),
    'artwork.remotePreview': async ({ cover }, signal) => {
      if (!cover) return null
      let bytes: Uint8Array, mime: string
      if (cover.startsWith('data:image/')) {
        const artwork = parsePersonalMusicArtwork(cover)
        if (!artwork) return null
        if (cover.length <= 250_000) return artwork.dataUrl
        bytes = Buffer.from(cover.slice(cover.indexOf(',') + 1), 'base64')
        mime = artwork.mime
      } else if (cover.startsWith('cover://')) {
        const name = cachedName(cover)
        bytes = await readFile(await cachedFile(cover))
        mime =
          {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp'
          }[extname(name)] ?? ''
      } else if (cover.startsWith('twilight-media://image/')) {
        const response = await request(new Request(cover, { signal }))
        if (!response.ok) {
          await response.body?.cancel()
          return null
        }
        bytes = new Uint8Array(await response.arrayBuffer())
        mime = response.headers.get('content-type')?.split(';')[0] ?? ''
      } else return null
      signal.throwIfAborted()
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) return null
      if (bytes.length > 180_000) {
        const resized = resizeServerArtwork(bytes, mime)
        if (!resized) return null
        bytes = resized
        mime = 'image/png'
      }
      return (
        parsePersonalMusicArtwork(`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`)
          ?.dataUrl ?? null
      )
    }
  }
}
