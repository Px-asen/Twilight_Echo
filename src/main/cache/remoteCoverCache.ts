import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type RemoteCoverResizer = (
  bytes: Uint8Array,
  mime: string
) => { bytes: Uint8Array; mime: string } | null

export interface RemoteCoverCacheOptions {
  /**
   * Downscale a fetched cover before it is written. Returning null keeps the
   * original bytes (already small enough, undecodable, or an animated type).
   * The main process wires `resizeCoverImageBytes`; tests inject a stub.
   */
  resize?: RemoteCoverResizer
}

export function createRemoteCoverCache(
  directory: () => string | null,
  options: RemoteCoverCacheOptions = {}
) {
  function cachePath(source: string): string | null {
    const root = directory()
    return root ? join(root, `${createHash('sha256').update(source).digest('hex')}.remote`) : null
  }
  return {
    async read(source: string): Promise<Response | null> {
      const path = cachePath(source)
      if (!path) return null
      try {
        const info = await stat(path)
        if (
          Date.now() - info.mtimeMs > 7 * 24 * 60 * 60 * 1000 ||
          info.size > 25 * 1024 * 1024 + 256
        )
          return null
        const bytes = await readFile(path)
        const separator = bytes.indexOf(10)
        if (separator < 1 || separator > 255) return null
        const type = bytes.subarray(0, separator).toString('utf8')
        if (!/^image\/[a-z0-9.+-]+$/i.test(type)) return null
        return new Response(bytes.subarray(separator + 1), { headers: { 'content-type': type } })
      } catch {
        return null
      }
    },
    async write(source: string, type: string, bytes: Uint8Array): Promise<void> {
      const path = cachePath(source)
      let mime = type.split(';', 1)[0].trim()
      if (!path || !/^image\/[a-z0-9.+-]+$/i.test(mime) || bytes.byteLength > 25 * 1024 * 1024)
        return
      let stored = bytes
      if (options.resize) {
        try {
          const resized = options.resize(bytes, mime)
          if (resized && resized.bytes.byteLength > 0) {
            stored = resized.bytes
            mime = resized.mime.split(';', 1)[0].trim() || mime
          }
        } catch {
          // Keep the original bytes when downscaling fails.
        }
      }
      const temporary = `${path}.${randomUUID()}.part`
      try {
        await mkdir(join(path, '..'), { recursive: true })
        await writeFile(temporary, Buffer.concat([Buffer.from(`${mime}\n`), stored]))
        await rename(temporary, path)
      } catch {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    }
  }
}
