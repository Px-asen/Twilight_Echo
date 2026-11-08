import { createHash, randomUUID } from '../../shared/portableCrypto.ts'
import { basename, dirname, extname, join } from '../../shared/portablePath.ts'
import {
  autoMixStemInstallBusy,
  type AutoMixStemInstallStatus
} from '../../shared/twilightAutoMix.ts'
import {
  coreArchive,
  coreFs,
  coreFsPromises,
  coreStream,
  type PortableReadableStream
} from '../ports/index.ts'
import type { StemRuntimeProbe } from './autoMixStemCapabilities.ts'
import { STEM_CHECKPOINT_SHA256, STEM_MODEL_VERSION } from './autoMixStemService.ts'

const { createReadStream, createWriteStream, readFileSync } = coreFs
const { mkdir, mkdtemp, readFile, rename, rm, statfs, writeFile } = coreFsPromises
const { Transform, pipeline } = coreStream

interface Entry {
  fileName: string
  uncompressedSize: number
  compressedSize: number
  externalFileAttributes: number
  generalPurposeBitFlag: number
  compressionMethod: number
  crc32: number
}
interface Zip {
  on(event: string, listener: (...args: any[]) => void): this
  once(event: string, listener: (...args: any[]) => void): this
  readEntry(): void
  close(): void
  openReadStream(
    entry: Entry,
    callback: (error: Error | null, stream: PortableReadableStream) => void
  ): void
  openReadStream(
    entry: Entry,
    options: { decodeFileData: false },
    callback: (error: Error | null, stream: PortableReadableStream) => void
  ): void
}
const MODEL = 'models/955717e8-8726e21a.th'
const REQUIRED = ['manifest.json', 'model.lock.json', 'runtime/python.exe', MODEL]
const MAX_FILES = 30_000
const MAX_BYTES = 16 * 1024 ** 3
const MAX_METADATA = 4 * 1024 ** 2

class InstallError extends Error {
  readonly reason: NonNullable<AutoMixStemInstallStatus['reason']>
  constructor(reason: NonNullable<AutoMixStemInstallStatus['reason']>) {
    super(reason)
    this.reason = reason
  }
}
function invalidArchive(): never {
  throw new InstallError('invalid_archive')
}

// ZIP names must have one unambiguous meaning on Windows, including case,
// alternate streams, reserved device names and file/directory collisions.
export function validateStemArchivePath(name: string): void {
  if (
    !name ||
    name.length > 500 ||
    /[\\:]/.test(name) ||
    [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    invalidArchive()
  const parts = (name.endsWith('/') ? name.slice(0, -1) : name).split('/')
  for (const part of parts) {
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      /[. ]$/.test(part) ||
      /[<>"|?*]/.test(part) ||
      /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
    )
      invalidArchive()
  }
}

function installedIds(root: string): string[] {
  try {
    const registry = JSON.parse(readFileSync(join(root, 'active.json'), 'utf8'))
    return Array.isArray(registry)
      ? registry
          .filter(
            (id: unknown) => typeof id === 'string' && /^(?:[a-f0-9]{24}|[a-f0-9]{64})$/.test(id)
          )
          .slice(0, 16)
      : []
  } catch {
    return []
  }
}
export function managedStemPackDirectories(root: string): string[] {
  return installedIds(root).map((id) => join(root, id))
}

export class AutoMixStemInstaller {
  private state: AutoMixStemInstallStatus = { phase: 'idle', completedBytes: 0, totalBytes: 0 }
  private abort?: AbortController
  private running = false
  private pending: Promise<AutoMixStemInstallStatus> | null = null
  private stopped = false
  private readonly options: {
    root: () => string
    chooseArchive: (signal: AbortSignal) => Promise<string | null>
    probe: (directory: string, signal: AbortSignal) => Promise<StemRuntimeProbe>
    decodeLzma: (
      input: PortableReadableStream,
      bytes: number,
      signal: AbortSignal,
      progress: (bytes: number) => void
    ) => PortableReadableStream
    lzmaDiskTickets?: boolean
    changed?: () => void
    // Small integrity fixtures use their own checkpoint; production uses the pinned release.
    checkpointSha256?: string
    freeBytes?: (root: string) => Promise<number>
  }
  constructor(options: AutoMixStemInstaller['options']) {
    this.options = options
  }

  getStatus(): AutoMixStemInstallStatus {
    return structuredClone(this.state)
  }
  cancel(): AutoMixStemInstallStatus {
    if (this.state.phase !== 'selecting') this.abort?.abort()
    return this.getStatus()
  }
  install(): Promise<AutoMixStemInstallStatus> {
    if (this.stopped) return Promise.reject(new Error('Core model installer is stopped'))
    if (this.running || autoMixStemInstallBusy(this.state)) return Promise.resolve(this.getStatus())
    const work = this.performInstall()
    this.pending = work
    void work
      .finally(() => {
        if (this.pending === work) this.pending = null
      })
      .catch(() => {})
    return work
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    this.abort?.abort()
    await this.pending
  }
  private async performInstall(): Promise<AutoMixStemInstallStatus> {
    if (this.running || autoMixStemInstallBusy(this.state)) return this.getStatus()
    this.running = true
    this.state = { phase: 'selecting', completedBytes: 0, totalBytes: 0 }
    this.options.changed?.()
    const abort = new AbortController()
    this.abort = abort
    let zip: Zip | undefined
    let staging: string | undefined
    let unpublished: string | undefined
    const checkCancelled = (): void => {
      abort.signal.throwIfAborted()
    }
    try {
      const archive = await this.options.chooseArchive(abort.signal)
      checkCancelled()
      if (!archive) {
        this.state.phase = 'cancelled'
        return this.getStatus()
      }
      this.state.fileName = basename(archive)
      this.state.phase = 'checking'
      this.options.changed?.()
      if (extname(archive).toLowerCase() !== '.zip') invalidArchive()
      const { yauzl, crc32 } = coreArchive
      zip = await new Promise<Zip>((resolve, reject) => {
        yauzl.open(
          archive,
          {
            lazyEntries: true,
            autoClose: false,
            validateEntrySizes: true,
            strictFileNames: true
          },
          (error: Error | null, value?: Zip) =>
            error || !value ? reject(new InstallError('invalid_archive')) : resolve(value)
        )
      })
      const opened = zip
      const entries = await new Promise<Entry[]>((resolve, reject) => {
        const entries: Entry[] = []
        const names = new Map<string, boolean>()
        let total = 0
        opened.on('entry', (entry: Entry) => {
          try {
            checkCancelled()
            validateStemArchivePath(entry.fileName)
            const directory = entry.fileName.endsWith('/')
            const mode = (entry.externalFileAttributes >>> 16) & 0xf000
            if (mode && mode !== (directory ? 0x4000 : 0x8000)) invalidArchive()
            if (entry.generalPurposeBitFlag & 1 || ![0, 8, 14].includes(entry.compressionMethod))
              invalidArchive()
            const key = entry.fileName.replace(/\/$/, '').toLowerCase()
            if (names.has(key)) invalidArchive()
            names.set(key, directory)
            total += entry.uncompressedSize
            if (
              !Number.isSafeInteger(entry.uncompressedSize) ||
              entry.uncompressedSize < 0 ||
              entry.uncompressedSize > 8 * 1024 ** 3 ||
              total > MAX_BYTES ||
              entries.length >= MAX_FILES
            )
              invalidArchive()
            entries.push(entry)
            opened.readEntry()
          } catch (error) {
            reject(error)
          }
        })
        opened.once('error', () => reject(new InstallError('invalid_archive')))
        opened.once('end', () => {
          try {
            for (const name of names.keys()) {
              const parts = name.split('/')
              for (let i = 1; i < parts.length; i++)
                if (names.get(parts.slice(0, i).join('/')) === false) invalidArchive()
            }
            resolve(entries)
          } catch (error) {
            reject(error)
          }
        })
        opened.readEntry()
      })
      const roots = entries
        .filter((entry) => /(^|\/)manifest\.json$/.test(entry.fileName))
        .map((entry) => entry.fileName.slice(0, -'manifest.json'.length))
        .filter((prefix) =>
          REQUIRED.every((name) => entries.some((entry) => entry.fileName === prefix + name))
        )
      if (roots.length !== 1) throw new InstallError('invalid_pack')
      const prefix = roots[0]
      const files = entries.filter(
        (entry) => entry.fileName.startsWith(prefix) && !entry.fileName.endsWith('/')
      )
      this.state.totalBytes = files.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
      for (const entry of files) {
        const name = entry.fileName.slice(prefix.length)
        if (
          ['manifest.json', 'model.lock.json', 'package-files.json'].includes(name) &&
          entry.uncompressedSize > MAX_METADATA
        )
          throw new InstallError('invalid_pack')
      }
      const root = this.options.root()
      await mkdir(root, { recursive: true })
      const available = this.options.freeBytes
        ? await this.options.freeBytes(root)
        : await statfs(root).then((value) => value.bavail * value.bsize)
      const decodeWorkspace = this.options.lzmaDiskTickets
        ? Math.max(
            0,
            ...files
              .filter((entry) => entry.compressionMethod === 14)
              .map((entry) => Math.max(entry.compressedSize, entry.uncompressedSize))
          )
        : 0
      if (available < this.state.totalBytes + decodeWorkspace + 256 * 1024 ** 2)
        throw new InstallError('disk_space')
      checkCancelled()
      staging = await mkdtemp(join(root, '.install-'))
      this.state.phase = 'extracting'
      this.options.changed?.()
      const hashes = new Map<string, { bytes: number; sha256: string }>()
      for (const entry of files) {
        checkCancelled()
        const name = entry.fileName.slice(prefix.length)
        const destination = join(staging, name)
        await mkdir(dirname(destination), { recursive: true })
        const raw = await new Promise<PortableReadableStream>((resolve, reject) => {
          const callback = (error: Error | null, value: PortableReadableStream): void =>
            error ? reject(new InstallError('invalid_archive')) : resolve(value)
          if (entry.compressionMethod === 14)
            opened.openReadStream(entry, { decodeFileData: false }, callback)
          else opened.openReadStream(entry, callback)
        })
        let reportedBytes = 0,
          notifiedBytes = 0
        const report = (value: number): void => {
          if (value <= reportedBytes) return
          this.state.completedBytes += value - reportedBytes
          reportedBytes = value
          if (reportedBytes - notifiedBytes >= 16 * 1024 ** 2) {
            notifiedBytes = reportedBytes
            this.options.changed?.()
          }
        }
        const stream =
          entry.compressionMethod === 14
            ? this.options.decodeLzma(raw, entry.uncompressedSize, abort.signal, report)
            : raw
        const hash = createHash('sha256')
        let bytes = 0,
          crc = 0
        const progress = new Transform({
          transform: (
            chunk: Uint8Array,
            _encoding: string,
            callback: (error?: Error | null, data?: unknown) => void
          ) => {
            bytes += chunk.length
            report(bytes)
            if (bytes > entry.uncompressedSize) return callback(new InstallError('invalid_archive'))
            hash.update(chunk)
            crc = crc32.unsigned(chunk, crc)
            callback(null, chunk)
          }
        })
        try {
          await pipeline(stream, progress, createWriteStream(destination, { flags: 'wx' }), {
            signal: abort.signal
          })
        } catch (error) {
          if (
            entry.compressionMethod === 14 &&
            !abort.signal.aborted &&
            !['ENOSPC', 'EACCES', 'EPERM'].includes((error as { code?: string }).code ?? '')
          )
            throw new InstallError('integrity')
          throw error
        }
        if (bytes !== entry.uncompressedSize || crc !== entry.crc32)
          throw new InstallError('integrity')
        hashes.set(name, { bytes, sha256: hash.digest('hex') })
      }
      this.state.phase = 'verifying'
      this.options.changed?.()
      const manifest = JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8'))
      const lock = JSON.parse(await readFile(join(staging, 'model.lock.json'), 'utf8'))
      const checkpoint = this.options.checkpointSha256 ?? STEM_CHECKPOINT_SHA256
      if (
        manifest.modelVersion !== STEM_MODEL_VERSION ||
        lock.modelVersion !== STEM_MODEL_VERSION ||
        manifest.checkpointSha256 !== checkpoint ||
        lock.checkpointSha256 !== checkpoint ||
        (manifest.python && manifest.python !== 'runtime/python.exe') ||
        (manifest.checkpoint && manifest.checkpoint !== MODEL)
      )
        throw new InstallError('invalid_pack')
      if (hashes.get(MODEL)?.sha256 !== checkpoint) throw new InstallError('integrity')
      if (hashes.has('package-files.json')) {
        const inventory = JSON.parse(await readFile(join(staging, 'package-files.json'), 'utf8'))
        if (
          !inventory.files ||
          typeof inventory.files !== 'object' ||
          Array.isArray(inventory.files)
        )
          throw new InstallError('invalid_pack')
        for (const [name, expected] of Object.entries(inventory.files)) {
          const actual = hashes.get(name)
          const value = expected as { bytes: number; sha256: string }
          if (!actual || !value || actual.bytes !== value.bytes || actual.sha256 !== value.sha256)
            throw new InstallError('integrity')
        }
        // A supplied inventory must cover every executable/runtime/model file.
        for (const name of hashes.keys())
          if (/^(runtime|models)\//.test(name) && !Object.hasOwn(inventory.files, name))
            throw new InstallError('integrity')
      }
      checkCancelled()
      // Immutable installs keep running workers valid. Publish only a validated
      // pack, then replace the small active registry atomically. A short content
      // ID leaves room for Python extension paths under Windows MAX_PATH; exact
      // byte verification above still rejects a collision or damaged reinstall.
      const id = createHash('sha256')
        .update(JSON.stringify([...hashes].sort(([a], [b]) => a.localeCompare(b))))
        .digest('hex')
        .slice(0, 24)
      const destination = join(root, id)
      try {
        await rename(staging, destination)
        staging = undefined
        unpublished = destination
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as { code?: string }).code ?? ''))
          throw error
        // Reinstalling identical content is valid only if the existing pack's
        // bytes still match. Do not trust a stale folder name.
        for (const [name, expected] of hashes) {
          const hash = createHash('sha256')
          let bytes = 0
          for await (const chunk of createReadStream(
            join(destination, name)
          ) as unknown as AsyncIterable<Uint8Array>) {
            checkCancelled()
            bytes += chunk.length
            hash.update(chunk)
          }
          if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256)
            throw new InstallError('integrity')
        }
      }
      // Probe at the permanent path, since Python native imports can succeed in
      // staging and fail after a move to a longer Windows directory.
      checkCancelled()
      let capabilities
      try {
        capabilities = await this.options.probe(destination, abort.signal)
      } catch {
        throw new InstallError('runtime')
      }
      if (!capabilities.cpu) throw new InstallError('runtime')
      checkCancelled()
      const temporaryRegistry = join(root, `.active-${randomUUID()}.json`)
      try {
        await writeFile(
          temporaryRegistry,
          JSON.stringify([id, ...installedIds(root).filter((value) => value !== id)].slice(0, 16)),
          { flag: 'wx' }
        )
        checkCancelled()
        await rename(temporaryRegistry, join(root, 'active.json'))
      } finally {
        await rm(temporaryRegistry, { force: true })
      }
      unpublished = undefined
      this.state.phase = 'ready'
      this.state.capabilities = capabilities
    } catch (error) {
      this.state.phase = abort.signal.aborted ? 'cancelled' : 'failed'
      if (!abort.signal.aborted)
        this.state.reason =
          error instanceof InstallError
            ? error.reason
            : error instanceof SyntaxError
              ? 'invalid_pack'
              : (error as { code?: string })?.code === 'ENOSPC'
                ? 'disk_space'
                : 'io'
    } finally {
      zip?.close()
      // Both paths are created solely by this operation below the managed root.
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {})
      if (unpublished) await rm(unpublished, { recursive: true, force: true }).catch(() => {})
      this.abort = undefined
      this.running = false
      this.options.changed?.()
    }
    return this.getStatus()
  }
}
