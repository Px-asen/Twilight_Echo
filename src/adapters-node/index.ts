import { createRequire as nodeCreateRequire } from 'node:module'
import {
  registerCorePorts,
  type CorePorts,
  type CoreFsPort,
  type CoreFsPromisesPort,
  type CoreStreamPort,
  type CoreOsPort,
  type CoreProcessPort,
  type CoreHttpPort,
  type CoreHttpsPort,
  type CoreNetPort,
  type CoreDgramPort,
  type CoreTlsPort,
  type CoreZlibPort,
  type CoreCryptoPort,
  type CoreModulePort,
  type CoreArchivePort,
  type CoreAudioMetadataPort,
  type CoreFtpPort,
  type CoreTextPort
} from '../core/ports/index.ts'

const nodeRequire = nodeCreateRequire(import.meta.url)

function lazyLoad<T>(loader: () => T): () => T {
  let cached: T | undefined
  let loaded = false
  return () => {
    if (!loaded) {
      cached = loader()
      loaded = true
    }
    return cached as T
  }
}

export function createNodeCorePorts(): CorePorts {
  // Each utility process registers these ports, but local playback does not need
  // every network, TLS and compression module to remain loaded in each process.
  const fsPromisesPort = lazyLoad(() => nodeRequire('node:fs/promises') as CoreFsPromisesPort)
  const fsPort = lazyLoad(() => nodeRequire('node:fs') as CoreFsPort)
  const streamPort = lazyLoad((): CoreStreamPort => {
    const { Readable, Writable, PassThrough, Transform, Duplex } = nodeRequire('node:stream')
    const { pipeline, finished } = nodeRequire('node:stream/promises')
    return { Readable, Writable, PassThrough, Transform, Duplex, pipeline, finished }
  })
  const osPort = lazyLoad(() => nodeRequire('node:os') as CoreOsPort)
  const processPort: CoreProcessPort = process as unknown as CoreProcessPort
  const httpPort = lazyLoad(() => nodeRequire('node:http') as CoreHttpPort)
  const httpsPort = lazyLoad(() => nodeRequire('node:https') as CoreHttpsPort)
  const netPort = lazyLoad(() => nodeRequire('node:net') as CoreNetPort)
  const dgramPort = lazyLoad(() => nodeRequire('node:dgram') as CoreDgramPort)
  const tlsPort = lazyLoad(() => nodeRequire('node:tls') as CoreTlsPort)
  const zlibPort = lazyLoad(() => nodeRequire('node:zlib') as CoreZlibPort)
  const cryptoPort = lazyLoad(() => nodeRequire('node:crypto') as CoreCryptoPort)
  const modulePort: CoreModulePort = {
    createRequire: nodeCreateRequire as unknown as CoreModulePort['createRequire']
  }

  const getYauzl = lazyLoad(() => {
    const mod = nodeRequire('yauzl')
    return (mod.default ?? mod) as CoreArchivePort['yauzl']
  })
  const getExtractZip = lazyLoad(() => {
    const mod = nodeRequire('extract-zip')
    return (mod.default ?? mod) as CoreArchivePort['extractZip']
  })
  const getCrc32 = lazyLoad(() => {
    const raw = nodeRequire('buffer-crc32')
    const crc32 = raw.default ?? raw
    return Object.assign(
      (buf: Uint8Array | string, partialCrc?: Uint8Array | number) =>
        crc32(
          typeof buf === 'string' || Buffer.isBuffer(buf)
            ? buf
            : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength),
          partialCrc
        ),
      {
        unsigned: (buf: Uint8Array | string, partialCrc?: number) =>
          crc32.unsigned(
            typeof buf === 'string' || Buffer.isBuffer(buf)
              ? buf
              : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength),
            partialCrc
          ),
        signed: (buf: Uint8Array | string, partialCrc?: number) =>
          crc32.signed(
            typeof buf === 'string' || Buffer.isBuffer(buf)
              ? buf
              : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength),
            partialCrc
          )
      }
    ) as unknown as CoreArchivePort['crc32']
  })

  const archivePort: CoreArchivePort = {
    get yauzl() {
      return getYauzl()
    },
    get extractZip() {
      return getExtractZip()
    },
    get crc32() {
      return getCrc32()
    }
  }

  const getMusicMetadata = lazyLoad(
    () => nodeRequire('music-metadata') as CoreAudioMetadataPort['musicMetadata']
  )
  const getStrtok3 = lazyLoad(() => nodeRequire('strtok3') as CoreAudioMetadataPort['strtok3'])
  const getTaglib = lazyLoad(() => {
    const mod = nodeRequire('node-taglib-sharp')
    return (mod.default ?? mod) as CoreAudioMetadataPort['taglib']
  })

  const audioMetadataPort: CoreAudioMetadataPort = {
    get musicMetadata() {
      return getMusicMetadata()
    },
    get strtok3() {
      return getStrtok3()
    },
    get taglib() {
      return getTaglib()
    }
  }

  const getBasicFtp = lazyLoad(() => nodeRequire('basic-ftp'))
  const ftpPort: CoreFtpPort = {
    get Client() {
      return getBasicFtp().Client as CoreFtpPort['Client']
    },
    get FileType() {
      return getBasicFtp().FileType as CoreFtpPort['FileType']
    }
  }

  const getXmlDomParser = lazyLoad(
    () => nodeRequire('@xmldom/xmldom').DOMParser as CoreTextPort['DOMParser']
  )
  const getIconv = lazyLoad(() => {
    const mod = nodeRequire('iconv-lite')
    return (mod.default ?? mod) as CoreTextPort['iconv']
  })
  const getOpenCC = lazyLoad(() => {
    const mod = nodeRequire('opencc-js')
    return (mod.default ?? mod) as CoreTextPort['opencc']
  })

  const textPort: CoreTextPort = {
    get DOMParser() {
      return getXmlDomParser()
    },
    get iconv() {
      return getIconv()
    },
    get opencc() {
      return getOpenCC()
    }
  }

  return {
    get fs() {
      return fsPort()
    },
    get fsPromises() {
      return fsPromisesPort()
    },
    get stream() {
      return streamPort()
    },
    get os() {
      return osPort()
    },
    process: processPort,
    get http() {
      return httpPort()
    },
    get https() {
      return httpsPort()
    },
    get net() {
      return netPort()
    },
    get dgram() {
      return dgramPort()
    },
    get tls() {
      return tlsPort()
    },
    get zlib() {
      return zlibPort()
    },
    get crypto() {
      return cryptoPort()
    },
    module: modulePort,
    archive: archivePort,
    audioMetadata: audioMetadataPort,
    ftp: ftpPort,
    text: textPort
  }
}

export const nodeCorePorts: CorePorts = createNodeCorePorts()
registerCorePorts(nodeCorePorts)
