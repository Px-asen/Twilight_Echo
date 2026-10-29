import Bonjour from 'bonjour-service'
import type { Service } from 'bonjour-service'

/** DNS-SD on the node side only; the portable Core receives a lifecycle port. */
export class CoreDiscoveryAdvertisement {
  private bonjour: Bonjour | null = null
  private service: Service | null = null
  private key = ''
  async start(info: { serverId: string; name: string; port: number; pairingMode?: string }): Promise<void> {
    const pair = info.pairingMode ?? 'approval-v1'
    const key = `${info.serverId}:${info.port}:${pair}`
    if (this.key === key && this.service?.published) return
    await this.stop()
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Discovery advertisement timed out')), 5000)
        const failed = (error: Error) => { clearTimeout(timer); reject(error) }
        this.bonjour = new Bonjour(undefined, failed)
        this.service = this.bonjour.publish({
          name: `Twilight ${info.serverId.slice(0, 8)}`,
          host: `twilight-${info.serverId}.local`, type: 'twilight-core', protocol: 'tcp', port: info.port,
          disableIPv6: true,
          txt: { id: info.serverId, name: info.name.slice(0, 80), v: '1', bridge: '1', pair }
        })
        this.service.once('up', () => { clearTimeout(timer); resolve() })
        this.service.once('error', failed)
      })
      this.key = key
    } catch (error) { await this.stop(); throw error }
  }
  async stop(): Promise<void> {
    const bonjour = this.bonjour
    this.bonjour = null; this.service = null; this.key = ''
    if (!bonjour) return
    await new Promise<void>(resolve => bonjour.unpublishAll(() => bonjour.destroy(resolve)))
  }
}
