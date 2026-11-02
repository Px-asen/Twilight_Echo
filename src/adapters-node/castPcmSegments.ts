import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rm, mkdtemp, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { CastPcmSegments } from '../core/cast/pcmSegments.ts'
import type { CastPcmSegmentRequest } from '../shared/castPcmSegment.ts'
import { assertCastUpstream } from '../core/cast/policy.ts'

/** A completed segment is an ordinary seekable WAV for both existing Cast transports.
 * No decoder or PCM crosses playback's RPC lane. Release follows the receiver's Stop ACK. */
export function createCastPcmSegments(options: {
  root: string
  render(source: string, request: CastPcmSegmentRequest, signal: AbortSignal): Promise<void>
}): CastPcmSegments {
  let ready: Promise<void> | null = null
  const initialize = () => ready ??= (async () => {
    await mkdir(options.root, { recursive: true })
    // Core recovery has already stopped the former remote output. Remove its private
    // incomplete/completed media once, never files owned by this live Cast service.
    for (const entry of await readdir(options.root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('segment-'))
        await rm(join(options.root, entry.name), { recursive: true, force: true })
    }
  })()
  return {
    async prepare(source, range, signal) {
      signal.throwIfAborted()
      await initialize()
      signal.throwIfAborted()
      const directory = await mkdtemp(join(options.root, 'segment-'))
      const path = join(directory, 'audio.wav')
      const release = () => rm(directory, { recursive: true, force: true })
      try {
        let input = source
        if (/^https?:\/\//i.test(source)) {
          // Preserve the existing Cast proxy policy: FFmpeg must not follow an upstream
          // redirect into a different host. Stage bytes once, outside the native RPC lane.
          assertCastUpstream(source)
          const response = await fetch(source, { signal, redirect: 'error' })
          if (!response.ok || !response.body) throw new Error('Unable to read Cast CUE source')
          input = join(directory, 'source.audio')
          // DOM and Node declarations describe the same runtime Web Stream differently.
          await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
            createWriteStream(input), { signal })
        }
        await options.render(input, {
          outputPath: path,
          startSeconds: range.startSeconds,
          endSeconds: range.endSeconds,
          virtualPregapSeconds: range.virtualPregapSeconds ?? 0
        }, signal)
        signal.throwIfAborted()
        if (input !== source) await unlink(input)
        return { path, release }
      } catch (error) {
        // The worker contract joins native writer exit before rejecting cancellation.
        await release()
        throw error
      }
    }
  }
}
