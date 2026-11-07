/** File operations supplied by the owning host for bounded transfer staging. */
export interface TransferFileStorage {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>
  rm(path: string, options: { recursive?: boolean; force: boolean }): Promise<void>
  writeFile(path: string, data: Uint8Array, options: { flag: string }): Promise<void>
  appendFile(path: string, data: Uint8Array): Promise<void>
  mkdtemp(prefix: string): Promise<string>
  stat(path: string): Promise<{ size: number }>
  open(path: string, flags: string): Promise<{
    read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
    close(): Promise<void>
  }>
}

export type UploadFileStorage = Pick<TransferFileStorage, 'mkdir' | 'rm' | 'writeFile' | 'appendFile'>
