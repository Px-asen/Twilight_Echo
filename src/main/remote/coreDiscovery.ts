import type Bonjour from 'bonjour-service'
import type { Service } from 'bonjour-service'

/** DNS-SD on the node side only; the portable Core receives a lifecycle port. */
export class CoreDiscoveryAdvertisement {
  private bonjour: Bonjour | null = null
  private service: Service | null = null
  private key = ''
  private generation = 0
  private lifecycle = Promise.resolve()
  private starting: { key: string; work: Promise<void> } | null = null
  private cancelPublication: (() => void) | null = null

  start(info: {
    serverId: string
    name: string
    port: number
    pairingMode?: string
  }): Promise<void> {
    const pair = info.pairingMode ?? 'approval-v1'
    const key = `${info.serverId}:${info.port}:${pair}`
    if (this.starting?.key === key) return this.starting.work
    if (!this.starting && this.key === key && this.service?.published) return Promise.resolve()
    const current = ++this.generation
    const assertCurrent = (): void => {
      if (current !== this.generation)
        throw Object.assign(new Error('Discovery advertisement startup was cancelled'), {
          name: 'AbortError'
        })
    }
    this.cancelPublication?.()
    const work = this.lifecycle.then(async () => {
      assertCurrent()
      await this.release()
      try {
        const { default: Bonjour } = await import('bonjour-service')
        assertCurrent()
        await new Promise<void>((resolve, reject) => {
          let settled = false
          const finish = (error?: Error): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            this.cancelPublication = null
            if (error) reject(error)
            else resolve()
          }
          const timer = setTimeout(
            () => finish(new Error('Discovery advertisement timed out')),
            5000
          )
          this.cancelPublication = () => finish()
          try {
            this.bonjour = new Bonjour(undefined, finish)
            this.service = this.bonjour.publish({
              name: `Twilight ${info.serverId.slice(0, 8)}`,
              host: `twilight-${info.serverId}.local`,
              type: 'twilight-core',
              protocol: 'tcp',
              port: info.port,
              disableIPv6: true,
              txt: { id: info.serverId, name: info.name.slice(0, 80), v: '1', bridge: '1', pair }
            })
            this.service.once('up', () => finish())
            this.service.once('error', finish)
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          }
        })
        assertCurrent()
        this.key = key
      } catch (error) {
        await this.release()
        throw error
      }
    })
    this.lifecycle = work.catch(() => undefined)
    this.starting = { key, work }
    void work
      .finally(() => {
        if (this.starting?.work === work) this.starting = null
      })
      .catch(() => undefined)
    return work
  }

  stop(): Promise<void> {
    this.generation++
    this.key = ''
    this.starting = null
    this.cancelPublication?.()
    const work = this.lifecycle.then(() => this.release())
    this.lifecycle = work.catch(() => undefined)
    return work
  }

  private async release(): Promise<void> {
    const bonjour = this.bonjour
    this.bonjour = null
    this.service = null
    this.key = ''
    if (!bonjour) return
    await new Promise<void>((resolve) => bonjour.unpublishAll(() => bonjour.destroy(resolve)))
  }
}
