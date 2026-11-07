import type { BridgePeer, BridgeRuntimeState, CoreZoneState, BridgeStreamOptions } from '../../shared/audioBridge.ts'
import { bridgeInvitation } from '../../shared/audioBridge.ts'
import type { CoreAudioOutputService } from './outputService.ts'
import type { CorePlaybackSession } from '../playback/session.ts'
import type { CoreCastService } from '../cast/service.ts'
import type { RemoteTlsIdentity } from '../cast/tlsIdentity.ts'
import type { AudioOutputState } from '../../shared/audioEngineTypes.ts'

type Method = 'BridgeStatus' | 'BridgeHostStart' | 'BridgeHostStop' | 'BridgeConnect' | 'BridgeDisconnect' | 'BridgeShutdown' | 'BridgeCancelTimed'
export class CoreBridgeService {
  private revision = 0
  private peer: BridgePeer | null = null
  private invitation: string | null = null
  private outputName = '输出桥'
  private readonly options: {
    call(method: Method, args?: unknown[]): Promise<unknown>
    output: Pick<CoreAudioOutputService, 'serialize'>
    outputState(): Promise<AudioOutputState>
    playback: Pick<CorePlaybackSession, 'stop'> & Partial<Pick<CorePlaybackSession, 'assertIndependent'>>
    cast: Pick<CoreCastService, 'active'>
    identity(): RemoteTlsIdentity
    name: string
    address(): string
    changed(): void
    coordinateConnection?(action: (grouped: boolean) => Promise<void>): Promise<void>
    groupId?(): string | null
    localOutputAllowed?: boolean
  }
  constructor(options: CoreBridgeService['options']) { this.options = options }
  async state(): Promise<CoreZoneState> {
    const runtime = await this.options.call('BridgeStatus') as BridgeRuntimeState
    if (runtime.peerName && runtime.receiver?.deviceName)
      this.outputName = `${runtime.peerName} · ${runtime.receiver.deviceName}`
    else if (runtime.peerName && this.outputName === '输出桥') this.outputName = runtime.peerName
    return { ...runtime, revision: this.revision, zoneId: 'local', groupId: this.options.groupId?.() ?? null, selectedOutputId: runtime.selected ? 'bridge' : 'local',
      outputs: [{ id: 'local', name: '此电脑', available: this.options.localOutputAllowed !== false && !runtime.hosting },
        ...(this.peer ? [{ id: 'bridge' as const, name: this.outputName, available: !runtime.hosting }] : [])] }
  }
  invite(): { invitation: string | null } { return { invitation: this.invitation } }
  private edit(revision: number, action: () => Promise<void>, coordinated = false): Promise<void> {
    if (!coordinated) this.options.playback.assertIndependent?.()
    return this.options.output.serialize(async () => {
      if (!coordinated) this.options.playback.assertIndependent?.()
      if (revision !== this.revision) throw Object.assign(new Error('输出已变化，请刷新'), { code: 'STALE_REVISION' })
      try { await action() } finally { ++this.revision; this.options.changed() }
    })
  }
  async assertLocal(): Promise<void> {
    if (this.options.localOutputAllowed === false) throw new Error('此 Server 仅向输出桥发送音频；本机 DAC 请在交互式 Bridge 中使用')
    const state = await this.state()
    if (state.selected || state.hosting) throw new Error('请先退出输出桥模式并选择此电脑输出')
  }
  host(revision: number, enabled: boolean, sampleRate: number, stream: BridgeStreamOptions = {}): Promise<void> {
    if (enabled && this.options.localOutputAllowed === false) return Promise.reject(new Error('Windows Service 不承载本机 DAC，请在交互式电脑上运行输出桥'))
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
        device: output.device, sampleRate, wireFormat: stream.wireFormat, channels: stream.channels, channelMask: stream.channelMask }]) as { port: number; token: string }
      this.invitation = bridgeInvitation({ host: this.options.address(), port: result.port,
        token: result.token, fingerprint: identity.fingerprint })
    })
  }
  connect(revision: number, peer: BridgePeer): Promise<void> {
    if (revision !== this.revision) return Promise.reject(Object.assign(new Error('输出已变化，请刷新'), { code: 'STALE_REVISION' }))
    const action = (grouped: boolean) => this.edit(revision, async () => {
      if (this.options.cast.active()) throw new Error('请先结束投屏')
      if (!grouped) await this.options.playback.stop()
      this.peer = { ...peer }
      await this.options.call('BridgeConnect', [peer])
      if (grouped) await this.options.call('BridgeCancelTimed')
    }, grouped)
    return this.options.coordinateConnection ? this.options.coordinateConnection(action) : action(false)
  }
  select(revision: number, outputId: 'local' | 'bridge'): Promise<void> {
    if (outputId === 'local' && this.options.localOutputAllowed === false) return Promise.reject(new Error('此 Server 只能选择输出桥'))
    if (outputId === 'bridge' && this.options.coordinateConnection) {
      if (!this.peer) return Promise.reject(new Error('请先在电脑上添加已授权的输出桥'))
      return this.connect(revision, this.peer)
    }
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
