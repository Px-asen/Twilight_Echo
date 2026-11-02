import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeDiagnostic } from '../diagnostics/logger.ts'

export type RemoteCoverResizer = (
  bytes: Uint8Array,
  mime: string
) => { bytes: Uint8Array; mime: string } | null

export interface RemoteCoverCacheOptions {
  /** Saved metadata artwork follows its licence, not the transient cover TTL. */
  maxAgeMs?: number
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
  let generation = 0
  let clearing = false
  const writes = new Set<Promise<void>>()
  function cachePath(source: string): string | null {
    const root = directory()
    return root ? join(root, `${createHash('sha256').update(source).digest('hex')}.remote`) : null
  }
  return {
    generation: () => generation,
    async maintain<T>(action: () => Promise<T>): Promise<T> {
      if (clearing) throw new Error('Remote cover maintenance is already running')
      clearing = true
      generation++
      try {
        await Promise.allSettled([...writes])
        return await action()
      } finally {
        generation++
        clearing = false
      }
    },
    async read(source: string): Promise<Response | null> {
      if (clearing) return null
      const path = cachePath(source)
      const miss = (reason: string) => {
        writeDiagnostic('cover.cache', 'read.miss', { source, reason }, 'debug')
        return null
      }
      if (!path) return miss('disabled')
      try {
        const info = await stat(path)
        if (Date.now() - info.mtimeMs > (options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000))
          return miss('expired')
        if (info.size > 25 * 1024 * 1024 + 256) return miss('oversized')
        const bytes = await readFile(path)
        const separator = bytes.indexOf(10)
        if (separator < 1 || separator > 255) return miss('invalid-header')
        const type = bytes.subarray(0, separator).toString('utf8')
        if (!/^image\/[a-z0-9.+-]+$/i.test(type)) return miss('invalid-content-type')
        writeDiagnostic(
          'cover.cache',
          'read.hit',
          { source, bytes: bytes.length - separator - 1, contentType: type },
          'debug'
        )
        return new Response(bytes.subarray(separator + 1), { headers: { 'content-type': type } })
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return miss('not-found')
        writeDiagnostic('cover.cache', 'read.failed', { source, error }, 'warn')
        return null
      }
    },
    async write(
      source: string,
      type: string,
      bytes: Uint8Array,
      started = generation
    ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
      let mime = type.split(';', 1)[0].trim()
      const path = cachePath(source)
      if (!/^image\/[a-z0-9.+-]+$/i.test(mime) || bytes.byteLength > 25 * 1024 * 1024) {
        writeDiagnostic(
          'cover.cache',
          'write.skipped',
          {
            source,
            reason: !path
              ? 'disabled'
              : bytes.byteLength > 25 * 1024 * 1024
                ? 'oversized'
                : 'content-type'
          },
          'debug'
        )
        return null
      }
      let stored = bytes
      if (options.resize) {
        try {
          const resized = options.resize(bytes, mime)
          if (resized && resized.bytes.byteLength > 0) {
            stored = resized.bytes
            mime = resized.mime.split(';', 1)[0].trim() || mime
          }
        } catch (error) {
          writeDiagnostic('cover.cache', 'resize.failed', { source, error }, 'warn')
          // Keep the original bytes when downscaling fails.
        }
      }
      const result = { bytes: stored, contentType: mime }
      if (clearing || started !== generation) return result
      if (!path) {
        writeDiagnostic('cover.cache', 'write.skipped', { source, reason: 'disabled' }, 'debug')
        return result
      }
      const work = (async () => {
        const temporary = `${path}.${randomUUID()}.part`
        try {
          await mkdir(join(path, '..'), { recursive: true })
          await writeFile(temporary, Buffer.concat([Buffer.from(`${mime}\n`), stored]))
          await rename(temporary, path)
          writeDiagnostic(
            'cover.cache',
            'write.complete',
            { source, inputBytes: bytes.byteLength, bytes: stored.byteLength, contentType: mime },
            'debug'
          )
        } catch (error) {
          writeDiagnostic('cover.cache', 'write.failed', { source, error }, 'warn')
          await rm(temporary, { force: true }).catch(() => undefined)
        }
      })()
      writes.add(work)
      try {
        await work
      } finally {
        writes.delete(work)
      }
      return result
    }
  }
}
