import { join } from '../../shared/portablePath.ts'
import { PortableBuffer } from '../../shared/portableBytes.ts'
import type { UploadFileStorage } from './fileStorage.ts'
export interface ChunkUploadInput { fileName: string; byteSize: number }
export interface ChunkUploadPolicy<T> { chunkBytes: number; maxBytes: number; valid(input: T): boolean }

interface Upload<T> { owner: string; input: T; path: string; offset: number; expires: number }
const fail = (code: string, message: string) => Object.assign(new Error(message), { code })
/** Temporary files belong to one service and one authenticated Core client. No caller path is used. */
export class ChunkUploads<T extends ChunkUploadInput> {
  private readonly entries = new Map<string, Upload<T>>()
  private pending = Promise.resolve()
  private closed = false
  private readonly root: string
  private readonly now: () => number
  private readonly newId: () => string
  private readonly policy: ChunkUploadPolicy<T>
  private readonly files: UploadFileStorage
  constructor(root: string, now: () => number, newId: () => string, policy: ChunkUploadPolicy<T>, files: UploadFileStorage) { this.root = root; this.now = now; this.newId = newId; this.policy = policy; this.files = files }
  async initialize() {
    // The dedicated staging directory contains no durable assets; retire crash leftovers.
    await this.files.rm(this.root, { recursive: true, force: true })
    await this.files.mkdir(this.root, { recursive: true })
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const work = this.pending.then(async () => {
      if (this.closed) throw fail('NOT_READY', 'Uploads are closed')
      for (const [id, entry] of this.entries) if (entry.expires <= this.now()) await this.remove(id)
      return action()
    })
    this.pending = work.then(() => {}, () => {})
    return work
  }
  begin(owner: string, input: T) {
    return this.serial(async () => {
      if (!this.policy.valid(input) || !Number.isSafeInteger(input.byteSize) ||
          input.byteSize <= 0 || input.byteSize > this.policy.maxBytes) throw fail('INVALID_REQUEST', 'Unsupported Upload')
      if (this.entries.size >= 2) throw fail('BUSY', 'Two Uploads are already pending')
      const uploadId = this.newId(), path = join(this.root, uploadId + input.fileName.slice(input.fileName.lastIndexOf('.')).toLowerCase())
      await this.files.writeFile(path, new Uint8Array(), { flag: 'wx' })
      this.entries.set(uploadId, { owner, input, path, offset: 0, expires: this.now() + 10 * 60_000 })
      return { uploadId, chunkBytes: this.policy.chunkBytes }
    })
  }
  private entry(owner: string, id: string) {
    const value = this.entries.get(id)
    if (!value || value.owner !== owner) throw fail('NOT_FOUND', 'Upload expired or belongs to another client')
    return value
  }
  chunk(owner: string, id: string, offset: number, data: string) {
    return this.serial(async () => {
      const entry = this.entry(owner, id)
      const bytes = PortableBuffer.from(data, 'base64')
      if (offset !== entry.offset || !bytes.length || bytes.length > this.policy.chunkBytes ||
          bytes.toString('base64') !== data || offset + bytes.length > entry.input.byteSize)
        throw fail('INVALID_REQUEST', 'Upload offset or size does not match')
      try { await this.files.appendFile(entry.path, bytes) }
      catch (error) { await this.remove(id); throw error }
      entry.offset += bytes.length
      entry.expires = this.now() + 10 * 60_000
      return { offset: entry.offset }
    })
  }
  consume<R>(owner: string, id: string, action: (path: string, input: T) => Promise<R>): Promise<R> {
    return this.serial(async () => {
      const entry = this.entry(owner, id)
      if (entry.offset !== entry.input.byteSize) throw fail('INVALID_REQUEST', 'Upload is incomplete')
      try { return await action(entry.path, entry.input) }
      finally { await this.remove(id) }
    })
  }
  inspect<R>(owner: string, id: string, action: (path: string, input: T) => Promise<R>): Promise<R> {
    return this.serial(async () => {
      const entry = this.entry(owner, id)
      if (entry.offset !== entry.input.byteSize) throw fail('INVALID_REQUEST', 'Upload is incomplete')
      entry.expires = this.now() + 10 * 60_000
      return action(entry.path, entry.input)
    })
  }
  cancel(owner: string, id: string) { return this.serial(async () => { this.entry(owner, id); await this.remove(id) }) }
  disconnect(owner: string) { return this.serial(async () => {
    for (const [id, entry] of this.entries) if (entry.owner === owner) await this.remove(id)
  }) }
  private async remove(id: string) {
    const entry = this.entries.get(id)
    if (entry) await this.files.rm(entry.path, { force: true })
    this.entries.delete(id)
  }
  async close() {
    await this.pending
    this.closed = true
    await this.files.rm(this.root, { recursive: true, force: true })
    this.entries.clear()
  }
}
