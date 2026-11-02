import { assertCastUpstream } from './policy.ts'
import type { CoreCastDevice, CoreCastState } from '../../shared/coreCast.ts'
import type { TrackData } from '../../shared/track.ts'
import type { CastDevice, CastSample } from './castBackend.ts'
import type { CoreCastBackend } from './backend.ts'
import type { RemoteHttpServer } from './httpServer.ts'
import { guessAudioContentType } from './mediaTokens.ts'
import type { SourceResources } from '../playback/sourceResources.ts'
import { projectCoreError } from '../projections.ts'
import { normalizeCueRange } from '../../shared/cue.ts'
import type { CastPcmSegments, PreparedCastSegment } from './pcmSegments.ts'

interface Options {
  backend: CoreCastBackend
  media: RemoteHttpServer
  resources: SourceResources
  authorizeFile(path: string): Promise<string>
  segments?: CastPcmSegments
  changed(): void
  observe(sample: CastSample, revision: number): void
  failed(error: Error, revision: number): void
  schedule(callback: () => void, milliseconds: number): () => void
}

const deviceView = (device: CastDevice): CoreCastDevice => ({
  id: device.id,
  protocol: device.protocol,
  name: device.friendlyName,
  manufacturer: device.manufacturer,
  model: device.modelName
})

/** Single remote output. The playback session remains the only logical queue,
 * occurrence and listening-history owner; this class never advances a queue. */
export class CoreCastService {
  private readonly options: Options
  private devices: CastDevice[] = []
  private discovering: Promise<void> | null = null
  private target: CastDevice | null = null
  private revision = 0
  private phase: CoreCastState['phase'] = 'idle'
  private error: string | null = null
  private pending: AbortController | null = null
  private cancelTimer: (() => void) | null = null
  private sample: Promise<void> | null = null
  private releaseSource: (() => void) | null = null
  private token: string | null = null
  private dispatched = false
  private segment: PreparedCastSegment | null = null

  constructor(options: Options) {
    this.options = options
  }

  state(): CoreCastState {
    return {
      revision: this.revision,
      target: this.target ? deviceView(this.target) : null,
      phase: this.phase,
      error: this.error ? projectCoreError(this.error) : null
    }
  }
  active(): boolean {
    return this.target !== null
  }
  page(offset: number, limit: number) {
    return {
      offset,
      total: this.devices.length,
      items: this.devices.slice(offset, offset + limit).map(deviceView)
    }
  }
  discover(): Promise<void> {
    return (this.discovering ??= this.options.backend
      .discover()
      .then((devices) => {
        this.devices = devices
        this.options.changed()
      })
      .finally(() => {
        this.discovering = null
      }))
  }
  private changed(): void {
    this.revision++
    this.options.changed()
  }
  private fail(error: unknown): void {
    this.phase = 'failed'
    this.error = error instanceof Error ? error.message : String(error)
    this.changed()
  }
  assertRevision(revision: number): void {
    if (revision !== this.revision)
      throw Object.assign(new Error('Cast target changed'), { code: 'STALE_REVISION' })
  }
  assertDevice(deviceId: string, revision: number): CastDevice {
    this.assertRevision(revision)
    const device = this.devices.find((item) => item.id === deviceId)
    if (!device) throw new Error('Cast device not found — refresh discovery and try again')
    return device
  }
  async select(deviceId: string, revision: number): Promise<void> {
    const device = this.assertDevice(deviceId, revision)
    await this.end()
    this.target = device
    this.phase = 'selected'
    this.error = null
    this.changed()
  }
  cancelPending(): void {
    this.pending?.abort(new Error('Cast operation superseded'))
    this.cancelTimer?.()
    this.cancelTimer = null
  }
  private async releaseMedia(): Promise<void> {
    if (this.token) this.options.media.getMediaGrants().revoke(this.token)
    this.token = null
    this.releaseSource?.()
    this.releaseSource = null
    await this.segment?.release()
    this.segment = null
  }

  assertTrack(track: TrackData): void {
    if (track.cueRange) {
      if (!normalizeCueRange(track.cueRange)) throw new Error('Invalid Cast CUE range')
      if (!this.options.segments) throw new Error('Cast CUE media preparation is unavailable')
    } else if (track.subTrack) throw new Error('Cast does not support native container subtracks')
  }

  /** Caller holds SourceResources.use() from source preparation through this ACK.
   * Pin survives that short lease, including future HTTP Range requests. */
  async load(
    source: string,
    track: TrackData,
    position: number,
    autoplay: boolean,
    signal: AbortSignal
  ): Promise<CastSample> {
    if (!this.target) throw new Error('No Cast target selected')
    this.assertTrack(track)
    await this.stop()
    signal.throwIfAborted()
    const device = this.target
    const pending = new AbortController()
    this.pending = pending
    const cancellation = AbortSignal.any([signal, pending.signal])
    this.phase = 'loading'
    this.changed()
    try {
      const remote = /^https?:\/\//i.test(source)
      if (remote) assertCastUpstream(source)
      const physical = remote ? source : await this.options.authorizeFile(source)
      cancellation.throwIfAborted()
      if (track.cueRange) {
        this.segment = await this.options.segments!.prepare(physical, track.cueRange, cancellation)
      }
      cancellation.throwIfAborted()
      const mediaPath = this.segment?.path ?? physical
      const proxyRemote = remote && !this.segment
      if (!this.options.media.getStatus().running) {
        await this.options.media.start(0, { mode: 'mediaOnly' })
      }
      cancellation.throwIfAborted()
      const url = proxyRemote
        ? this.options.media.issueRemoteMediaUrl(mediaPath, { title: track.title })
        : this.options.media.issueMediaUrl(mediaPath, track.title)
      if (!url) throw new Error('Unable to issue Cast media URL')
      this.token = new URL(url).pathname.slice('/media/'.length)
      this.releaseSource = this.options.resources.pin([
        ...(remote ? [] : [physical]),
        ...(this.segment ? [mediaPath] : [])
      ])
      this.dispatched = true
      await this.options.backend.load(
        device,
        {
          deviceId: device.id,
          mediaUrl: url,
          title: track.title,
          artist: track.artist,
          album: track.album,
          contentType: guessAudioContentType(mediaPath),
          positionSeconds: position,
          autoplay
        },
        cancellation
      )
      cancellation.throwIfAborted()
      const sample = await this.options.backend.sample(device, cancellation)
      cancellation.throwIfAborted()
      this.phase = 'ready'
      this.error = null
      this.changed()
      this.schedule()
      return sample
    } catch (error) {
      if (!this.dispatched) await this.releaseMedia()
      // A failed/unknown LOAD is never replayed and never falls back to local audio.
      this.fail(error)
      throw error
    } finally {
      if (this.pending === pending) this.pending = null
    }
  }
  async control(
    command: 'play' | 'pause' | 'seek' | 'volume',
    value?: number
  ): Promise<CastSample> {
    const device = this.target
    if (!device || this.phase !== 'ready') throw new Error('Cast media is not ready')
    this.cancelPending()
    await this.sample
    try {
      await this.options.backend.control(device, command, value)
      const sample = await this.options.backend.sample(device, new AbortController().signal)
      this.schedule()
      return sample
    } catch (error) {
      this.fail(error)
      throw error
    }
  }
  async stop(): Promise<void> {
    this.cancelPending()
    await this.sample
    if (!this.target) return
    try {
      if (this.dispatched) await this.options.backend.control(this.target, 'stop')
    } catch (error) {
      this.fail(error)
      throw error
    }
    this.dispatched = false
    this.phase = 'selected'
    try { await this.releaseMedia() }
    finally { this.changed() }
  }
  async shutdown(): Promise<void> {
    await this.end()
    await this.discovering
  }
  async end(): Promise<void> {
    await this.stop()
    this.target = null
    this.phase = 'idle'
    this.error = null
    if (this.options.media.isMediaOnly()) await this.options.media.stop()
    this.changed()
  }
  resumeSampling(): void {
    if (this.phase === 'ready' && !this.pending && !this.cancelTimer) this.schedule()
  }
  read(): Promise<CastSample> {
    if (!this.target || this.phase !== 'ready') throw new Error('Cast media is not ready')
    return this.options.backend.sample(this.target, new AbortController().signal)
  }
  private schedule(): void {
    this.cancelTimer?.()
    this.cancelTimer = this.options.schedule(() => {
      this.cancelTimer = null
      if (!this.target || this.phase !== 'ready') return
      const revision = this.revision
      const device = this.target,
        pending = new AbortController()
      this.pending = pending
      this.sample = this.options.backend
        .sample(device, pending.signal)
        .then((sample) => {
          if (!pending.signal.aborted) this.options.observe(sample, revision)
        })
        .catch((error) => {
          if (!pending.signal.aborted) {
            this.fail(error)
            this.options.failed(
              error instanceof Error ? error : new Error(String(error)),
              this.revision
            )
          }
        })
        .finally(() => {
          this.sample = null
          if (this.pending === pending) this.pending = null
          if (!pending.signal.aborted && this.phase === 'ready') this.schedule()
        })
    }, 1000)
  }
}
