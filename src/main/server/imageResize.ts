import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { getNativeAddonCandidates } from '../audio/nativeBinding.ts'

const require = createRequire(import.meta.url)
type Raster = { width: number; height: number; data: Buffer }
const { PNG } = require('pngjs') as {
  PNG: {
    sync: {
      read(bytes: Buffer): Raster
      write(raster: Raster): Buffer
    }
  }
}
let binding:
  | {
      resize(
        bytes: Buffer,
        mime: string,
        edge: number,
        width: number,
        height: number
      ): Raster | undefined
    }
  | undefined

/** Uses the existing native runtime's FFmpeg build, not an Electron app or external command. */
export function resizeServerArtwork(bytes: Uint8Array, mime: string): Uint8Array | null {
  if (!binding) {
    const candidate = getNativeAddonCandidates({ binary: 'twilight_image_node.node' }).find(
      existsSync
    )
    if (!candidate)
      throw new Error('Server 缺少 twilight_image_node.node 图片运行时，请更新完整安装包')
    binding = require(candidate)
  }
  if (bytes.length > 25 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(mime))
    return null
  let input: Buffer = Buffer.from(bytes)
  let width = 0,
    height = 0
  if (mime === 'image/png') {
    if (input.length < 24 || input.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null
    width = input.readUInt32BE(16)
    height = input.readUInt32BE(20)
    if (
      width < 1 ||
      height < 1 ||
      width > 8192 ||
      height > 8192 ||
      width * height > 32 * 1024 * 1024
    )
      return null
    // The installed FFmpeg omits its zlib codecs; use the existing PNG dependency, preserving alpha.
    try {
      input = PNG.sync.read(input).data
    } catch {
      return null
    }
    mime = 'image/rgba'
  }
  let edge = 500
  while (edge > 0) {
    const raster = binding!.resize(input, mime, edge, width, height)
    if (!raster) return null
    const output = PNG.sync.write(raster)
    if (output.length <= 180_000) return output
    edge = Math.floor((edge * 3) / 4)
  }
  return null
}
