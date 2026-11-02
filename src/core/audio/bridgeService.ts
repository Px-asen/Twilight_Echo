import type { BridgePeer, BridgeRuntimeState, CoreZoneState } from '../../shared/audioBridge.ts'
import { bridgeInvitation } from '../../shared/audioBridge.ts'
import type { CoreAudioOutputService } from './outputService.ts'
import type { CorePlaybackSession } from '../playback/session.ts'
import type { CoreCastService } from '../cast/service.ts'
import type { RemoteTlsIdentity } from '../cast/tlsIdentity.ts'
import type { AudioOutputState } from '../../shared/audioEngineTypes.ts'

type Method = 'BridgeStatus' | 'BridgeHostStart' | 'BridgeHostStop' | 'BridgeConnect' | 'BridgeDisconnect' | 'BridgeShutdown'
export class CoreBridgeService {
  private revision = 0
  private peer: BridgePeer | null = null
  private invitation: string | null = null
  private outputName = '输出桥'
  private readonly options: {
    call(method: Method, args?: unknown[]): Promise<unknown>
    output: Pick<CoreAudioOutputService, 'serialize'>
    outputState(): Promise<AudioOutputState>
    playback: Pick<CorePlaybackSession, 'stop'>
    cast: Pick<CoreCastService, 'active'>
    identity(): RemoteTlsIdentity
    name: string
    address(): string
    changed(): void
  }
  constructor(options: CoreBridgeService['options']) { this.options = options }
  async state(): Promise<CoreZoneState> {
    const runtime = await this.options.call('BridgeStatus') as BridgeRuntimeState
    if (runtime.peerName && runtime.receiver?.deviceName)
      this.outputName = `${runtime.peerName} · ${runtime.receiver.deviceName}`
    else if (runtime.peerName && this.outputName === '输出桥') this.outputName = runtime.peerName
    return { ...runtime, revision: this.revision, zoneId: 'local', selectedOutputId: runtime.selected ? 'bridge' : 'local',
      outputs: [{ id: 'local', name: '此电脑', available: !runtime.hosting },
        ...(this.peer ? [{ id: 'bridge' as const, name: this.outputName, available: !runtime.hosting }] : [])] }
  }
  invite(): { invitation: string | null } { return { invitation: this.invitation } }
  private edit(revision: number, action: () => Promise<void>): Promise<void> {
    return this.options.output.serialize(async () => {
      if (revision !== this.revision) throw Object.assign(new Error('输出已变化，请刷新'), { code: 'STALE_REVISION' })
      try { await action() } finally { ++this.revision; this.options.changed() }
    })
  }
  async assertLocal(): Promise<void> {
    const state = await this.state()
    if (state.selected || state.hosting) throw new Error('请先退出输出桥模式并选择此电脑输出')
  }
  host(revision: number, enabled: boolean, sampleRate: number): Promise<void> {
    return this.edit(revision, async () => {
      if (!enabled) { await this.options.call('BridgeHostStop'); this.invitation = null; return }
      if (this.options.cast.active()) throw new Error('请先结束投屏')
      await this.options.playback.stop()
      // Already in the output lane; do not re-enter output.state()'s serializer.
      const output = await this.options.outputState()
      const identity = this.options.identity()
      const result = await this.options.call('BridgeHostStart', [{ ...identity, name: this.options.name,
        backend: output.exclusiveMode && ['wasapi', 'coreaudio'].includes(output.output)
          ? `${output.output}-exclusive` : output.output,
        device: output.device, sampleRate }]) as { port: number; token: string }
      this.invitation = bridgeInvitation({ host: this.options.address(), port: result.port,
        token: result.token, fingerprint: identity.fingerprint })
    })
  }
  connect(revision: number, peer: BridgePeer): Promise<void> {
    return this.edit(revision, async () => {
      if (this.options.cast.active()) throw new Error('请先结束投屏')
      await this.options.playback.stop()
      this.peer = { ...peer }
      await this.options.call('BridgeConnect', [peer])
    })
  }
  select(revision: number, outputId: 'local' | 'bridge'): Promise<void> {
    return this.edit(revision, async () => {
      if (this.options.cast.active()) throw new Error('请先结束投屏')
      await this.options.playback.stop()
      if (outputId === 'local') await this.options.call('BridgeDisconnect')
      else {
        if (!this.peer) throw new Error('请先在电脑上添加已授权的输出桥')
        await this.options.call('BridgeConnect', [this.peer])
      }
    })
  }
  async shutdown(): Promise<void> { await this.options.call('BridgeShutdown') }
}
