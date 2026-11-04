import { randomUUID } from 'node:crypto'
import type {
  CorePlatformOperations,
  CorePlatformRequest,
  CorePlatformResponse,
  CorePlatformCancel
} from '../../shared/corePlatform.ts'

/** Private capability requests. No retries, particularly after a trash operation loses its reply. */
export class CorePlatformClient {
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; dispose(): void }
  >()
  private readonly epoch: string
  private readonly send: (message: CorePlatformRequest | CorePlatformCancel) => void
  private readonly timeoutMs: number
  constructor(
    epoch: string,
    send: (message: CorePlatformRequest | CorePlatformCancel) => void,
    timeoutMs = 30_000
  ) {
    this.epoch = epoch
    this.send = send
    this.timeoutMs = timeoutMs
  }
  call<K extends keyof CorePlatformOperations>(
    name: K,
    payload: CorePlatformOperations[K]['input'],
    signal?: AbortSignal
  ): Promise<CorePlatformOperations[K]['output']> {
    return this.request(name, payload, signal, false)
  }
  /** Cancellation joins OS jobs and platform cache writes before releasing their owner. */
  callJoined<
    K extends
      | 'network.sftp'
      | 'audio.restartWindowsServices'
      | 'network.mountCommand'
      | 'cache.clearPlatform'
      | 'automix.probe'
      | 'automix.probeInstall'
      | 'automix.decodeArchiveEntry'
      | 'automix.runWorker'
      | 'files.trashAudio'
      | 'themes.deleteAssets'
      | 'themes.copyAssets'
      | 'themes.importArchive'
      | 'themes.exportArchive'
      | 'themes.importAsset'
  >(
    name: K,
    payload: CorePlatformOperations[K]['input'],
    signal?: AbortSignal
  ): Promise<CorePlatformOperations[K]['output']> {
    return this.request(name, payload, signal, true)
  }
  private request<K extends keyof CorePlatformOperations>(
    name: K,
    payload: CorePlatformOperations[K]['input'],
    signal: AbortSignal | undefined,
    join: boolean
  ): Promise<CorePlatformOperations[K]['output']> {
    if (signal?.aborted)
      return Promise.reject(
        signal.reason ?? new Error('Platform request cancelled before dispatch')
      )
    if (this.pending.size >= 32)
      return Promise.reject(new Error('Core platform request queue is full'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      let timedOut: Error | null = null
      const dispose = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.pending.delete(requestId)
      }
      const abort = () => {
        this.send({ kind: 'core:platform-cancel', epoch: this.epoch, requestId })
        if (join) return
        dispose()
        reject(new Error(`${name} cancelled; outcome may be unknown`))
      }
      const timer = setTimeout(
        () => {
          if (
            name === 'audio.restartWindowsServices' ||
            name === 'cache.clearPlatform' ||
            name === 'automix.probe' ||
            name === 'automix.probeInstall' ||
            name === 'automix.decodeArchiveEntry' ||
            name === 'automix.runWorker' ||
            name === 'files.trashAudio' ||
            name.startsWith('themes.')
          ) {
            // Trash cannot be cancelled after shell dispatch. Its eventual ACK
            // gives the actual outcome; Core death retains the SQL claim.
            timedOut =
              name === 'files.trashAudio'
                ? null
                : new Error(`${name} timed out; outcome may be unknown`)
            this.send({ kind: 'core:platform-cancel', epoch: this.epoch, requestId })
            // Keep the writer/process lease until main confirms completion.
            return
          }
          dispose()
          reject(new Error(`${name} timed out; outcome may be unknown`))
        },
        name === 'audio.confirmWindowsRestart' ||
          name === 'remote.confirmDevice' ||
          name === 'ncm.officialLogin' ||
          name === 'qqmusic.officialLogin' ||
          name === 'ncm.chooseUploadFiles' ||
          name === 'ncm.chooseDownloadFile' ||
          name === 'automix.chooseArchive' ||
          name === 'themes.importArchive' ||
          name === 'themes.exportArchive' ||
          name === 'themes.importAsset' ||
          name === 'backup.chooseFile' ||
          name === 'backup.chooseFolder' ||
          name.endsWith('.chooseImportFile') ||
          name.endsWith('.chooseExportFile')
          ? 185_000
          : name === 'audio.restartWindowsServices'
            ? 190_000
          : name === 'automix.decodeArchiveEntry'
            ? 310_000
            : name === 'automix.runWorker'
              ? 100_000
              : join
                ? 70_000
                : this.timeoutMs
      )
      this.pending.set(requestId, {
        resolve: (value) =>
          timedOut
            ? reject(timedOut)
            : signal?.aborted
              ? reject(signal.reason)
              : resolve(value as CorePlatformOperations[K]['output']),
        reject,
        dispose
      })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.send({
          kind: 'core:platform',
          epoch: this.epoch,
          requestId,
          name,
          payload
        } as CorePlatformRequest)
      } catch (error) {
        dispose()
        reject(error)
      }
    })
  }
  handle(message: CorePlatformResponse): void {
    if (message.epoch !== this.epoch) return
    const pending = this.pending.get(message.requestId)
    if (!pending) return
    pending.dispose()
    if (message.ok) pending.resolve(message.value)
    else pending.reject(new Error(message.error))
  }
  destroy(): void {
    for (const pending of this.pending.values()) {
      pending.dispose()
      pending.reject(new Error('Core platform bridge closed'))
    }
    this.pending.clear()
  }
}
