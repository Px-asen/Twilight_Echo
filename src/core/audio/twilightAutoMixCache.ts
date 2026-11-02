import { PortableBuffer } from '../../shared/portableBytes.ts'
import { createHash, randomUUID } from '../../shared/portableCrypto.ts'
import { dirname } from '../../shared/portablePath.ts'
import { coreFsPromises } from '../ports/index.ts'
import { AutoMixWindowCache, type AutoMixWindowStorage } from './autoMixWindowCache.ts'
export * from './autoMixWindowCache.ts'
const { mkdir, open, rename, rm, stat, writeFile } = coreFsPromises
const MAX_CACHE_BYTES = 16 * 1024 * 1024

function fileStorage(file: string): AutoMixWindowStorage {
  return {
    async read() {
      const handle = await open(file, 'r')
      try {
        const size = (await handle.stat()).size
        if (size > MAX_CACHE_BYTES) return null
        const bytes = PortableBuffer.allocUnsafe(size + 1)
        let count = 0
        while (count < bytes.length) {
          const { bytesRead } = await handle.read(bytes, count, bytes.length - count, null)
          if (!bytesRead) break
          count += bytesRead
        }
        return count > size ? null : bytes.subarray(0, count).toString('utf8')
      } finally { await handle.close() }
    },
    async write(text) {
      if (text === null) { await rm(file, { force: true }); return }
      await mkdir(dirname(file), { recursive: true })
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' })
        await rename(temporary, file)
      } finally { await rm(temporary, { force: true }) }
    }
  }
}
/** Existing desktop file API; mobile supplies its own bounded atomic store. */
export class TwilightAutoMixWindowCache extends AutoMixWindowCache {
  constructor(file: string | AutoMixWindowStorage, limit = 128) {
    super(typeof file === 'string' ? fileStorage(file) : file, limit)
  }
}

interface BigIntFileStats {
  isFile(): boolean
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

/** Worker/control path only. Caller must first resolve the existing authorization.
 * Hash the actual open file and reject replacement/mutation during the read. */
export async function identifyTwilightAutoMixFile(
  authorizedPath: string,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  const file = await open(authorizedPath, 'r')
  try {
    const before = (await file.stat({ bigint: true })) as unknown as BigIntFileStats
    if (!before.isFile() || before.size <= 0n)
      throw new Error('AutoMix needs a regular, nonempty audio source')
    const hash = createHash('sha256'),
      buffer = PortableBuffer.allocUnsafe(128 * 1024)
    let total = 0n
    while (true) {
      signal?.throwIfAborted()
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      total += BigInt(bytesRead)
      if (total > before.size) throw new Error('AutoMix source changed while hashing')
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = (await file.stat({ bigint: true })) as unknown as BigIntFileStats,
      current = (await stat(authorizedPath, { bigint: true })) as unknown as BigIntFileStats
    for (const observed of [after, current]) {
      if (
        observed.dev !== before.dev ||
        observed.ino !== before.ino ||
        observed.size !== before.size ||
        observed.mtimeNs !== before.mtimeNs ||
        observed.ctimeNs !== before.ctimeNs ||
        total !== before.size
      )
        throw new Error('AutoMix source changed while hashing')
    }
    signal?.throwIfAborted()
    return hash.digest('hex')
  } finally {
    await file.close()
  }
}
