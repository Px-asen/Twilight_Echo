import type { CorePlatformId } from '../../shared/audioEngineTypes.ts'
import type { PortableBuffer, PortableBufferEncoding } from '../../shared/portableBytes.ts'
import { configurePortablePathPlatform } from '../../shared/portablePath.ts'

export interface PortableStats {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  size: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  mtime: Date
  ctime: Date
  birthtime: Date
  mode: number
  ino?: number
  dev?: number
}

export interface PortableDirent {
  name: string
  parentPath?: string
  path?: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface PortableStatFs {
  bavail: number
  bfree: number
  blocks: number
  bsize: number
  ffree: number
  files: number
  type: number
}

export interface PortableFileHandle {
  fd: number
  read(
    buffer: Uint8Array,
    offset?: number | null,
    length?: number | null,
    position?: number | null
  ): Promise<{ bytesRead: number; buffer: Uint8Array }>
  read(options?: {
    buffer?: Uint8Array
    offset?: number
    length?: number
    position?: number | null
  }): Promise<{ bytesRead: number; buffer: Uint8Array }>
  write(
    buffer: Uint8Array | string,
    offsetOrPosition?: number | null,
    lengthOrEncoding?: number | PortableBufferEncoding | null,
    position?: number | null
  ): Promise<{ bytesWritten: number; buffer: Uint8Array | string }>
  stat(options?: any): Promise<PortableStats>
  sync(): Promise<void>
  datasync(): Promise<void>
  truncate(len?: number): Promise<void>
  close(): Promise<void>
  createReadStream(options?: any): PortableReadStream
  createWriteStream(options?: any): PortableWriteStream
}

export interface PortableStreamBase {
  on(event: string | symbol, listener: (...args: any[]) => void): this
  once(event: string | symbol, listener: (...args: any[]) => void): this
  off(event: string | symbol, listener: (...args: any[]) => void): this
  removeListener(event: string | symbol, listener: (...args: any[]) => void): this
  removeAllListeners(event?: string | symbol): this
  emit(event: string | symbol, ...args: any[]): boolean
  pipe(destination: any, options?: { end?: boolean }): any
  destroy(error?: Error): this
  destroyed?: boolean
  [Symbol.asyncIterator](): AsyncIterableIterator<any>
  [key: string]: any
}

export interface PortableReadableStream extends PortableStreamBase {
  readable?: boolean
  read(size?: number): any
  pause(): this
  resume(): this
  setEncoding(encoding: PortableBufferEncoding): this
  unpipe(destination?: any): this
}

export interface PortableWritableStream extends PortableStreamBase {
  writable?: boolean
  write(chunk: any, encodingOrCb?: any, cb?: any): boolean
  end(chunk?: any, encodingOrCb?: any, cb?: any): this
  cork?(): void
  uncork?(): void
}

export interface PortableDuplexStream extends PortableReadableStream, PortableWritableStream {}

export interface PortablePassThroughStream extends PortableDuplexStream {}

export interface PortableReadStream extends PortableReadableStream {
  path?: string | PortableBuffer
  bytesRead?: number
  close(cb?: (err?: Error | null) => void): void
}

export interface PortableWriteStream extends PortableWritableStream {
  path?: string | PortableBuffer
  bytesWritten?: number
  close(cb?: (err?: Error | null) => void): void
}

export interface PortableFsWatcher {
  on(event: string, listener: (...args: any[]) => void): this
  close(): void
}

export interface CoreFsPromisesPort {
  access(path: string | URL, mode?: number): Promise<void>
  appendFile(
    path: string | URL | PortableFileHandle,
    data: string | Uint8Array,
    options?: PortableBufferEncoding | { encoding?: PortableBufferEncoding | null; mode?: number; flag?: string }
  ): Promise<void>
  copyFile(src: string | URL, dest: string | URL, mode?: number): Promise<void>
  cp(src: string | URL, dest: string | URL, options?: { recursive?: boolean; force?: boolean; [key: string]: any }): Promise<void>
  lstat(path: string | URL, options?: any): Promise<PortableStats>
  mkdir(
    path: string | URL,
    options?: { recursive?: boolean; mode?: number } | number
  ): Promise<string | undefined>
  mkdtemp(prefix: string, options?: any): Promise<string>
  open(path: string | URL, flags?: string | number, mode?: number): Promise<PortableFileHandle>
  opendir(path: string | URL, options?: any): Promise<AsyncIterable<PortableDirent>>
  readdir(path: string | URL, options?: { withFileTypes?: false; encoding?: any } | PortableBufferEncoding): Promise<string[]>
  readdir(path: string | URL, options: { withFileTypes: true; encoding?: any }): Promise<PortableDirent[]>
  readdir(path: string | URL, options?: any): Promise<any[]>
  readFile(path: string | URL | PortableFileHandle, options?: { encoding?: null; flag?: string; signal?: AbortSignal } | null): Promise<PortableBuffer>
  readFile(
    path: string | URL | PortableFileHandle,
    options: PortableBufferEncoding | { encoding: PortableBufferEncoding; flag?: string; signal?: AbortSignal }
  ): Promise<string>
  readFile(path: string | URL | PortableFileHandle, options?: any): Promise<PortableBuffer | string>
  realpath(path: string | URL, options?: any): Promise<string>
  rename(oldPath: string | URL, newPath: string | URL): Promise<void>
  rm(
    path: string | URL,
    options?: { force?: boolean; maxRetries?: number; recursive?: boolean; retryDelay?: number }
  ): Promise<void>
  stat(path: string | URL, options?: any): Promise<PortableStats>
  statfs(path: string | URL, options?: any): Promise<PortableStatFs>
  unlink(path: string | URL): Promise<void>
  utimes(path: string | URL, atime: number | string | Date, mtime: number | string | Date): Promise<void>
  chmod(path: string | URL, mode: number | string): Promise<void>
  writeFile(
    file: string | URL | PortableFileHandle,
    data: string | Uint8Array | AsyncIterable<string | Uint8Array>,
    options?:
      | PortableBufferEncoding
      | { encoding?: PortableBufferEncoding | null; mode?: number; flag?: string; signal?: AbortSignal }
  ): Promise<void>
}

export interface CoreFsPort {
  readonly promises: CoreFsPromisesPort
  readonly constants: {
    F_OK: number
    R_OK: number
    W_OK: number
    X_OK: number
    COPYFILE_EXCL: number
    [key: string]: number
  }
  existsSync(path: string | URL): boolean
  readFileSync(path: string | URL | number, options?: { encoding?: null; flag?: string } | null): PortableBuffer
  readFileSync(
    path: string | URL | number,
    options: PortableBufferEncoding | { encoding: PortableBufferEncoding; flag?: string }
  ): string
  readFileSync(path: string | URL | number, options?: any): PortableBuffer | string
  writeFileSync(
    file: string | URL | number,
    data: string | ArrayBufferView,
    options?: PortableBufferEncoding | { encoding?: PortableBufferEncoding | null; mode?: number; flag?: string }
  ): void
  appendFileSync(
    file: string | URL | number,
    data: string | Uint8Array,
    options?: PortableBufferEncoding | { encoding?: PortableBufferEncoding | null; mode?: number; flag?: string }
  ): void
  copyFileSync(src: string | URL, dest: string | URL, mode?: number): void
  mkdirSync(
    path: string | URL,
    options?: { recursive?: boolean; mode?: number } | number
  ): string | undefined
  rmSync(
    path: string | URL,
    options?: { force?: boolean; maxRetries?: number; recursive?: boolean; retryDelay?: number }
  ): void
  unlinkSync(path: string | URL): void
  utimesSync(path: string | URL, atime: number | string | Date, mtime: number | string | Date): void
  renameSync(oldPath: string | URL, newPath: string | URL): void
  statSync(path: string | URL, options?: any): PortableStats
  lstatSync(path: string | URL, options?: any): PortableStats
  realpathSync: {
    (path: string | URL, options?: any): string
    native(path: string | URL, options?: any): string
  }
  readdirSync(path: string | URL, options?: { withFileTypes?: false; encoding?: any } | PortableBufferEncoding): string[]
  readdirSync(path: string | URL, options: { withFileTypes: true; encoding?: any }): PortableDirent[]
  readdirSync(path: string | URL, options?: any): any[]
  openSync(path: string | URL, flags?: string | number, mode?: number): number
  readSync(
    fd: number,
    buffer: ArrayBufferView,
    offset?: number,
    length?: number,
    position?: number | null
  ): number
  writeSync(
    fd: number,
    buffer: ArrayBufferView | string,
    offsetOrPosition?: number | null,
    lengthOrEncoding?: number | PortableBufferEncoding | null,
    position?: number | null
  ): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  createReadStream(path: string | URL, options?: any): PortableReadStream
  createWriteStream(path: string | URL, options?: any): PortableWriteStream
  watch(
    filename: string | URL,
    optionsOrListener?: any,
    listener?: (eventType: string, filename: string | null) => void
  ): PortableFsWatcher
}

export interface CoreStreamPort {
  Readable: {
    new (options?: any): PortableReadableStream
    from(iterable: Iterable<any> | AsyncIterable<any>, options?: any): PortableReadableStream
    fromWeb(readableStream: any, options?: any): PortableReadableStream
    toWeb?(streamReadable: PortableReadableStream): any
    [key: string]: any
  }
  Writable: {
    new (options?: any): PortableWritableStream
    fromWeb?(writableStream: any, options?: any): PortableWritableStream
    toWeb?(streamWritable: PortableWritableStream): any
    [key: string]: any
  }
  PassThrough: {
    new (options?: any): PortablePassThroughStream
  }
  Transform: {
    new (options?: any): PortableDuplexStream
  }
  Duplex: {
    new (options?: any): PortableDuplexStream
  }
  pipeline(...streams: any[]): Promise<void>
  finished(stream: any, options?: any): Promise<void>
}

export interface PortableNetworkInterfaceInfo {
  address: string
  netmask: string
  family: 'IPv4' | 'IPv6' | string
  mac: string
  internal: boolean
  cidr: string | null
  scopeid?: number
}

export interface CoreOsPort {
  tmpdir(): string
  homedir(): string
  platform(): CorePlatformId
  arch(): string
  release(): string
  hostname(): string
  networkInterfaces(): Record<string, PortableNetworkInterfaceInfo[] | undefined>
  cpus(): Array<{ model: string; speed: number; times: Record<string, number> }>
  totalmem(): number
  freemem(): number
}

export interface CoreProcessPort {
  readonly platform: CorePlatformId
  readonly arch: string
  readonly env: Record<string, string | undefined>
  readonly versions: Record<string, string | undefined> & {
    node: string
    modules: string
    electron?: string
    chrome?: string
  }
  readonly pid: number
  readonly resourcesPath?: string
  readonly execPath: string
  readonly argv: string[]
  cwd(): string
  nextTick(callback: (...args: any[]) => void, ...args: any[]): void
  hrtime: {
    (time?: [number, number]): [number, number]
    bigint(): bigint
  }
}

export interface PortableAddressInfo {
  address: string
  family: string
  port: number
}

export type PortableIncomingHttpHeaders = Record<string, string | string[] | undefined>

export interface PortableIncomingMessage extends PortableReadableStream {
  statusCode?: number
  statusMessage?: string
  headers: PortableIncomingHttpHeaders
  rawHeaders: string[]
  method?: string
  url?: string
  httpVersion?: string
  socket: PortableNetSocket
  setTimeout(msecs: number, callback?: () => void): this
}

export interface PortableServerResponse extends PortableWritableStream {
  statusCode: number
  statusMessage: string
  headersSent: boolean
  writableEnded: boolean
  setHeader(name: string, value: number | string | readonly string[]): this
  getHeader(name: string): number | string | string[] | undefined
  removeHeader(name: string): void
  writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | Record<string, any>,
    headers?: Record<string, any>
  ): this
  flushHeaders?(): void
}

export interface PortableClientRequest extends PortableWritableStream {
  abort?(): void
  setTimeout(timeout: number, callback?: () => void): this
  setNoDelay(noDelay?: boolean): void
  setSocketKeepAlive(enable?: boolean, initialDelay?: number): void
  setHeader(name: string, value: number | string | readonly string[]): this
  getHeader(name: string): number | string | string[] | undefined
  removeHeader(name: string): void
  flushHeaders(): void
}

export interface PortableHttpServer {
  listen(port?: number, hostname?: string, backlog?: number, listeningListener?: () => void): this
  listen(port?: number, hostname?: string, listeningListener?: () => void): this
  listen(port?: number, listeningListener?: () => void): this
  listen(options: any, listeningListener?: () => void): this
  close(callback?: (err?: Error) => void): this
  address(): PortableAddressInfo | string | null
  on(event: string, listener: (...args: any[]) => void): this
  once(event: string, listener: (...args: any[]) => void): this
  off(event: string, listener: (...args: any[]) => void): this
  removeListener(event: string, listener: (...args: any[]) => void): this
  removeAllListeners(event?: string): this
  setTimeout(msecs?: number, callback?: () => void): this
  listening?: boolean
  [key: string]: any
}

export interface PortableHttpAgent {
  destroy(): void
  [key: string]: any
}

export interface PortableRequestOptions {
  protocol?: string | null
  host?: string | null
  hostname?: string | null
  family?: number
  port?: number | string | null
  localAddress?: string
  socketPath?: string
  method?: string
  path?: string | null
  headers?: Record<string, any>
  auth?: string | null
  agent?: PortableHttpAgent | boolean
  timeout?: number
  signal?: AbortSignal
  rejectUnauthorized?: boolean
  servername?: string
  lookup?: any
  [key: string]: any
}

export interface CoreHttpPort {
  Agent: new (options?: any) => PortableHttpAgent
  globalAgent: PortableHttpAgent
  Server: new (optionsOrListener?: any, listener?: any) => PortableHttpServer
  IncomingMessage: any
  ServerResponse: any
  createServer(
    optionsOrListener?:
      | Record<string, any>
      | ((req: PortableIncomingMessage, res: PortableServerResponse) => void),
    requestListener?: (req: PortableIncomingMessage, res: PortableServerResponse) => void
  ): PortableHttpServer
  request(
    urlOrOptions: string | URL | PortableRequestOptions,
    optionsOrCallback?: PortableRequestOptions | ((res: PortableIncomingMessage) => void),
    callback?: (res: PortableIncomingMessage) => void
  ): PortableClientRequest
  get(
    urlOrOptions: string | URL | PortableRequestOptions,
    optionsOrCallback?: PortableRequestOptions | ((res: PortableIncomingMessage) => void),
    callback?: (res: PortableIncomingMessage) => void
  ): PortableClientRequest
}

export interface CoreHttpsPort {
  Agent: new (options?: any) => PortableHttpAgent
  globalAgent: PortableHttpAgent
  createServer(options: any, requestListener?: any): PortableHttpServer
  request(
    urlOrOptions: string | URL | PortableRequestOptions,
    optionsOrCallback?: PortableRequestOptions | ((res: PortableIncomingMessage) => void),
    callback?: (res: PortableIncomingMessage) => void
  ): PortableClientRequest
  get(
    urlOrOptions: string | URL | PortableRequestOptions,
    optionsOrCallback?: PortableRequestOptions | ((res: PortableIncomingMessage) => void),
    callback?: (res: PortableIncomingMessage) => void
  ): PortableClientRequest
}

export interface PortableNetSocket extends PortableDuplexStream {
  /** True only for a TLS socket; plain HTTP sockets leave this unset. */
  encrypted?: boolean
  remoteAddress?: string
  remoteFamily?: string
  remotePort?: number
  localAddress?: string
  localPort?: number
  connecting?: boolean
  connect(portOrOptions: any, hostOrListener?: any, connectionListener?: () => void): this
  setTimeout(timeout: number, callback?: () => void): this
  setNoDelay(noDelay?: boolean): this
  setKeepAlive(enable?: boolean, initialDelay?: number): this
  address(): PortableAddressInfo | Record<string, never>
  unref(): this
  ref(): this
}

export interface PortableNetServer {
  listen(port?: number, hostname?: string, backlog?: number, listeningListener?: () => void): this
  listen(port?: number, hostname?: string, listeningListener?: () => void): this
  listen(port?: number, listeningListener?: () => void): this
  listen(options: any, listeningListener?: () => void): this
  close(callback?: (err?: Error) => void): this
  address(): PortableAddressInfo | string | null
  on(event: string, listener: (...args: any[]) => void): this
  once(event: string, listener: (...args: any[]) => void): this
  off(event: string, listener: (...args: any[]) => void): this
}

export interface CoreNetPort {
  Socket: new (options?: any) => PortableNetSocket
  Server: new (optionsOrListener?: any, listener?: any) => PortableNetServer
  createServer(optionsOrListener?: any, connectionListener?: (socket: PortableNetSocket) => void): PortableNetServer
  createConnection(portOrOptions: any, hostOrListener?: any, connectionListener?: () => void): PortableNetSocket
  connect(portOrOptions: any, hostOrListener?: any, connectionListener?: () => void): PortableNetSocket
  isIP(input: string): number
  isIPv4(input: string): boolean
  isIPv6(input: string): boolean
}

export interface PortableRemoteInfo {
  address: string
  family: 'IPv4' | 'IPv6'
  port: number
  size: number
}

export interface PortableDgramSocket {
  bind(port?: number, address?: string, callback?: () => void): this
  bind(options: any, callback?: () => void): this
  send(
    msg: string | Uint8Array | readonly any[],
    offsetOrPort?: number,
    lengthOrAddress?: number | string,
    portOrCallback?: number | ((error: Error | null, bytes: number) => void),
    addressOrCallback?: string | ((error: Error | null, bytes: number) => void),
    callback?: (error: Error | null, bytes: number) => void
  ): void
  close(callback?: () => void): this
  address(): PortableAddressInfo
  setBroadcast(flag: boolean): void
  setMulticastTTL(ttl: number): number
  setMulticastLoopback(flag: boolean): boolean
  setMulticastInterface(multicastInterface: string): void
  addMembership(multicastAddress: string, multicastInterface?: string): void
  dropMembership(multicastAddress: string, multicastInterface?: string): void
  on(event: string, listener: (...args: any[]) => void): this
  once(event: string, listener: (...args: any[]) => void): this
  off(event: string, listener: (...args: any[]) => void): this
  removeListener(event: string, listener: (...args: any[]) => void): this
  removeAllListeners(event?: string): this
  unref(): this
  ref(): this
}

export interface CoreDgramPort {
  Socket: any
  createSocket(
    typeOrOptions: 'udp4' | 'udp6' | { type: 'udp4' | 'udp6'; reuseAddr?: boolean; [key: string]: any },
    callback?: (msg: PortableBuffer, rinfo: PortableRemoteInfo) => void
  ): PortableDgramSocket
}

export interface PortableTlsSocket extends PortableNetSocket {
  authorized: boolean
  authorizationError?: Error
  alpnProtocol?: string | false | null
  getPeerCertificate(detailed?: boolean): any
}

export interface PortableTlsConnectOptions {
  host?: string
  port?: number
  socket?: PortableNetSocket
  rejectUnauthorized?: boolean
  servername?: string
  ALPNProtocols?: string[] | Uint8Array[]
  ca?: string | Uint8Array | Array<string | Uint8Array>
  cert?: string | Uint8Array | Array<string | Uint8Array>
  key?: string | Uint8Array | Array<string | Uint8Array>
  timeout?: number
  [key: string]: any
}

export interface CoreTlsPort {
  TLSSocket: any
  connect(options: PortableTlsConnectOptions, secureConnectListener?: () => void): PortableTlsSocket
  connect(
    port: number,
    host?: string,
    options?: PortableTlsConnectOptions,
    secureConnectListener?: () => void
  ): PortableTlsSocket
  connect(
    port: number,
    options?: PortableTlsConnectOptions,
    secureConnectListener?: () => void
  ): PortableTlsSocket
}

export interface CoreZlibPort {
  gunzipSync(buf: ArrayBufferView, options?: any): PortableBuffer
  gzipSync(buf: ArrayBufferView, options?: any): PortableBuffer
  inflateSync(buf: ArrayBufferView, options?: any): PortableBuffer
  deflateSync(buf: ArrayBufferView, options?: any): PortableBuffer
  inflateRawSync(buf: ArrayBufferView, options?: any): PortableBuffer
  deflateRawSync(buf: ArrayBufferView, options?: any): PortableBuffer
  createGunzip(options?: any): PortableDuplexStream
  createGzip(options?: any): PortableDuplexStream
  createInflate(options?: any): PortableDuplexStream
  createInflateRaw(options?: any): PortableDuplexStream
}

export interface CoreCryptoPort {
  createHash(algorithm: string): {
    update(data: string | ArrayBufferView, inputEncoding?: PortableBufferEncoding): any
    digest(encoding?: 'hex' | 'base64' | 'base64url'): any
  }
  createHmac(algorithm: string, key: string | ArrayBufferView): {
    update(data: string | ArrayBufferView, inputEncoding?: PortableBufferEncoding): any
    digest(encoding?: 'hex' | 'base64' | 'base64url'): any
  }
  randomBytes(size: number): PortableBuffer
  randomUUID(): `${string}-${string}-${string}-${string}-${string}`
  randomInt(minOrMax: number, max?: number): number
  timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean
  createPublicKey(key: string | ArrayBufferView | Record<string, any>): any
  generateKeyPairSync(type: 'ec', options: { namedCurve: string }): { publicKey: any; privateKey: any }
  sign(algorithm: string | null | undefined, data: ArrayBufferView, key: any): PortableBuffer
  verify(
    algorithm: string | null | undefined,
    data: ArrayBufferView,
    key: any,
    signature: ArrayBufferView
  ): boolean
  createCipheriv(algorithm: string, key: ArrayBufferView | string, iv: ArrayBufferView | string | null, options?: any): any
  createDecipheriv(algorithm: string, key: ArrayBufferView | string, iv: ArrayBufferView | string | null, options?: any): any
  scryptSync(password: string | ArrayBufferView, salt: string | ArrayBufferView, keylen: number, options?: any): PortableBuffer
}

export interface CoreModulePort {
  createRequire(filenameOrUrl: string | URL): {
    (id: string): any
    resolve(id: string, options?: { paths?: string[] }): string
  }
}

export interface CoreArchivePort {
  yauzl: {
    open(path: string, optionsOrCallback: any, callback?: any): void
    fromBuffer(buffer: Uint8Array, optionsOrCallback: any, callback?: any): void
    fromFd(fd: number, optionsOrCallback: any, callback?: any): void
    fromRandomAccessReader(reader: any, totalSize: number, options: any, callback: any): void
    [key: string]: any
  }
  extractZip(source: string, options: { dir: string; [key: string]: any }): Promise<void>
  crc32: {
    (buf: Uint8Array | string, partialCrc?: Uint8Array | number): PortableBuffer
    unsigned(buf: Uint8Array | string, partialCrc?: number): number
    signed(buf: Uint8Array | string, partialCrc?: number): number
  }
}

export interface CoreAudioMetadataPort {
  musicMetadata: {
    parseFile(filePath: string, options?: any): Promise<any>
    parseBuffer(buf: Uint8Array, fileInfo?: any, options?: any): Promise<any>
    parseStream(stream: any, fileInfo?: any, options?: any): Promise<any>
    parseFromTokenizer(tokenizer: any, options?: any): Promise<any>
    selectCover(pictures?: any[] | null): any
    orderTags(nativeTags: any): any
    ratingToStars(rating: any): number
    [key: string]: any
  }
  strtok3: {
    fromFile(filePath: string): Promise<any>
    fromBuffer(uint8Array: Uint8Array, fileInfo?: any): any
    fromStream(stream: any, fileInfo?: any): Promise<any>
    [key: string]: any
  }
  taglib: {
    File: {
      createFromPath(path: string): {
        tag: {
          title?: string
          performers?: string[]
          album?: string
          albumArtists?: string[]
          track?: number
          disc?: number
          year?: number
          genres?: string[]
          lyrics?: string
          pictures: unknown[]
          [key: string]: any
        }
        save(): void
        dispose(): void
        [key: string]: any
      }
      createFromAbstraction(abstraction: any): any
      [key: string]: any
    }
    ByteVector: any
    Picture: any
    PictureType: any
    Id3v2Tag: any
    Id3v2Settings: any
    TagTypes: any
    [key: string]: any
  }
}

export interface CoreFtpPort {
  Client: new (timeout?: number) => any
  FileType: {
    Unknown: number
    File: number
    Directory: number
    SymbolicLink: number
    [key: string]: any
  }
}

export interface CoreTextPort {
  DOMParser: new (options?: any) => any
  iconv: {
    decode(buf: Uint8Array, encoding: string, options?: any): string
    encode(str: string, encoding: string, options?: any): PortableBuffer
    encodingExists(encoding: string): boolean
    [key: string]: any
  }
  opencc: {
    Converter(options: { from: string; to: string }): (text: string) => string
    [key: string]: any
  }
}

export interface CorePorts {
  fs: CoreFsPort
  fsPromises: CoreFsPromisesPort
  stream: CoreStreamPort
  os: CoreOsPort
  process: CoreProcessPort
  http: CoreHttpPort
  https: CoreHttpsPort
  net: CoreNetPort
  dgram: CoreDgramPort
  tls: CoreTlsPort
  zlib: CoreZlibPort
  crypto: CoreCryptoPort
  module: CoreModulePort
  archive: CoreArchivePort
  audioMetadata: CoreAudioMetadataPort
  ftp: CoreFtpPort
  text: CoreTextPort
}

const GLOBAL_PORTS_KEY = '__TWILIGHT_CORE_PORTS__'
const GLOBAL_BOOTSTRAP_KEY = '__TWILIGHT_CORE_PORTS_BOOTSTRAP__'

let activePorts: CorePorts | null = null

export function registerCorePorts(ports: CorePorts): void {
  activePorts = ports
  ;(globalThis as Record<string, unknown>)[GLOBAL_PORTS_KEY] = ports
  configurePortablePathPlatform({
    isWindows: ports.process.platform === 'win32',
    cwd: () => ports.process.cwd()
  })
}

export function hasCorePorts(): boolean {
  return Boolean(activePorts || (globalThis as Record<string, unknown>)[GLOBAL_PORTS_KEY])
}

export function getCorePorts(): CorePorts {
  if (activePorts) return activePorts
  const globalRegistered = (globalThis as Record<string, unknown>)[GLOBAL_PORTS_KEY] as
    | CorePorts
    | undefined
  if (globalRegistered) {
    activePorts = globalRegistered
    return activePorts
  }
  const bootstrap = (globalThis as Record<string, unknown>)[GLOBAL_BOOTSTRAP_KEY] as
    | (() => CorePorts | void)
    | undefined
  if (typeof bootstrap === 'function') {
    const bootstrapped = bootstrap()
    if (bootstrapped) {
      registerCorePorts(bootstrapped)
      return bootstrapped
    }
    if (activePorts) return activePorts
  }
  throw new Error(
    'CorePorts have not been registered. Ensure the host adapter (e.g. src/adapters-node) is initialized before invoking Core platform I/O.'
  )
}

function createPortProxy<T extends object>(selectPort: (ports: CorePorts) => T): T {
  const fnCache = new Map<PropertyKey, any>()
  return new Proxy({} as T, {
    get(_target, prop) {
      if (hasCorePorts()) {
        const port = selectPort(getCorePorts()) as Record<PropertyKey, any>
        const value = port[prop]
        if (typeof value !== 'function') {
          return value
        }
      }
      let cached = fnCache.get(prop)
      if (!cached) {
        cached = new Proxy(function () {
          // A constructible target is required; the traps dispatch to the active host port.
        }, {
          apply(_fn, _thisArg, args) {
            const port = selectPort(getCorePorts()) as Record<PropertyKey, any>
            const targetFn = port[prop]
            return Reflect.apply(targetFn, port, args)
          },
          construct(_fn, args, newTarget) {
            const port = selectPort(getCorePorts()) as Record<PropertyKey, any>
            const targetCtor = port[prop]
            return Reflect.construct(targetCtor, args, newTarget === cached ? targetCtor : newTarget)
          },
          get(_fn, subProp) {
            const port = selectPort(getCorePorts()) as Record<PropertyKey, any>
            const targetVal = port[prop]
            const member = targetVal?.[subProp]
            return typeof member === 'function' ? member.bind(targetVal) : member
          }
        })
        fnCache.set(prop, cached)
      }
      return cached
    },
    set(_target, prop, value) {
      const port = selectPort(getCorePorts()) as Record<PropertyKey, any>
      port[prop] = value
      return true
    },
    has(_target, prop) {
      const port = selectPort(getCorePorts()) as Record<PropertyKey, any>
      return prop in port
    },
    ownKeys() {
      const port = selectPort(getCorePorts()) as Record<PropertyKey, any>
      return Reflect.ownKeys(port)
    },
    getOwnPropertyDescriptor(_target, prop) {
      const port = selectPort(getCorePorts()) as Record<PropertyKey, any>
      return Object.getOwnPropertyDescriptor(port, prop)
    }
  })
}

export const coreFs: CoreFsPort = createPortProxy((ports) => ports.fs)
export const coreFsPromises: CoreFsPromisesPort = createPortProxy((ports) => ports.fsPromises)
export const coreStream: CoreStreamPort = createPortProxy((ports) => ports.stream)
export const coreOs: CoreOsPort = createPortProxy((ports) => ports.os)
export const coreProcess: CoreProcessPort = createPortProxy((ports) => ports.process)
export const coreHttp: CoreHttpPort = createPortProxy((ports) => ports.http)
export const coreHttps: CoreHttpsPort = createPortProxy((ports) => ports.https)
export const coreNet: CoreNetPort = createPortProxy((ports) => ports.net)
export const coreDgram: CoreDgramPort = createPortProxy((ports) => ports.dgram)
export const coreTls: CoreTlsPort = createPortProxy((ports) => ports.tls)
export const coreZlib: CoreZlibPort = createPortProxy((ports) => ports.zlib)
export const coreCrypto: CoreCryptoPort = createPortProxy((ports) => ports.crypto)
export const coreModule: CoreModulePort = createPortProxy((ports) => ports.module)
export const coreArchive: CoreArchivePort = createPortProxy((ports) => ports.archive)
export const coreAudioMetadata: CoreAudioMetadataPort = createPortProxy((ports) => ports.audioMetadata)
export const coreFtp: CoreFtpPort = createPortProxy((ports) => ports.ftp)
export const coreText: CoreTextPort = createPortProxy((ports) => ports.text)
