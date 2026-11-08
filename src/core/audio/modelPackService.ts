import type {
  CoreModelPackDecode,
  CoreModelPackStatus,
  CoreModelPackPlatformOperations
} from '../../shared/coreModelPack.ts'
import { join } from '../../shared/portablePath.ts'
import {
  coreFs,
  coreFsPromises,
  coreStream,
  type PortableReadableStream
} from '../ports/index.ts'
import { AutoMixStemInstaller } from './autoMixStemInstaller.ts'

const { createReadStream, createWriteStream } = coreFs
const { mkdir, mkdtemp, rm, stat } = coreFsPromises
const { Readable, pipeline } = coreStream

export interface CoreModelPackOptions {
  root: string
  chooseArchive(signal: AbortSignal): Promise<string | null>
  decode(request: CoreModelPackDecode, signal: AbortSignal): Promise<void>
  probe(
    directory: string,
    signal: AbortSignal
  ): Promise<CoreModelPackPlatformOperations['automix.probeInstall']['output']>
  changed(): void
  installed(enableAfterInstall: boolean): Promise<void>
  checkpointSha256?: string
}

/** An accepted installation belongs to Core, not to its initiating connection. */
export class CoreModelPackService {
  private readonly installer: AutoMixStemInstaller
  private pending: Promise<void> | null = null
  private stopped = false
  private readonly options: CoreModelPackOptions
  constructor(options: CoreModelPackOptions) {
    this.options = options
    const root = join(options.root, 'automix-stem-packs')
    this.installer = new AutoMixStemInstaller({
      root: () => root,
      chooseArchive: options.chooseArchive,
      decodeLzma: (input, bytes, signal, progress) =>
        decodeWithPlatform(root, input, bytes, options.decode, signal, progress),
      lzmaDiskTickets: true,
      probe: options.probe,
      changed: options.changed,
      checkpointSha256: options.checkpointSha256
    })
  }
  state(): CoreModelPackStatus {
    return this.installer.getStatus()
  }
  start(enableAfterInstall: boolean): CoreModelPackStatus {
    if (this.stopped) throw new Error('Core model installer is stopped')
    if (!this.pending) {
      const work = this.installer.install().then(async (state) => {
        if (state.phase === 'ready') await this.options.installed(enableAfterInstall)
      })
      this.pending = work
      void work
        .finally(() => {
          if (this.pending === work) this.pending = null
          this.options.changed()
        })
        .catch(() => {})
    }
    return this.state()
  }
  cancel(): CoreModelPackStatus {
    return this.installer.cancel()
  }
  async waitForIdle(): Promise<void> {
    await this.pending
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    await this.installer.shutdown()
    await this.pending
  }
}

/** Disk tickets keep multi-GB entry bytes out of IPC and keep 7za in main. */
export function decodeWithPlatform(
  root: string,
  input: PortableReadableStream,
  bytes: number,
  decode: CoreModelPackOptions['decode'],
  signal: AbortSignal,
  progress?: (bytes: number) => void
): PortableReadableStream {
  async function* run(): AsyncGenerator<Uint8Array> {
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(join(root, '.decode-'))
    try {
      await pipeline(input, createWriteStream(join(directory, 'input.lzma'), { flags: 'wx' }), {
        signal
      })
      signal.throwIfAborted()
      // This capability must join decoder exit on cancellation before cleanup.
      let decoding = true
      const output = join(directory, 'output.bin')
      const timer = setInterval(() => {
        void stat(output)
          .then((file) => {
            if (decoding) progress?.(Math.min(bytes, file.size))
          })
          .catch(() => {})
      }, 250)
      try {
        await decode({ directory, bytes }, signal)
      } finally {
        decoding = false
        clearInterval(timer)
      }
      signal.throwIfAborted()
      await rm(join(directory, 'input.lzma'))
      for await (const chunk of createReadStream(output, {
        signal
      }) as unknown as AsyncIterable<Uint8Array>)
        yield chunk
    } finally {
      input.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  }
  return Readable.from(run(), { objectMode: false })
}
