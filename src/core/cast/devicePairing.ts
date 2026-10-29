import { createHash, randomBytes, randomUUID } from '../../shared/portableCrypto.ts'
import { safeEqualText, SlidingWindowRateLimiter } from './auth.ts'
import type { RemotePairingRequest, RemoteTrustedDevice } from '../../shared/remoteControl.ts'

export interface RemoteTrustDocument {
  serverId: string
  devices: (RemoteTrustedDevice & { tokenHash: string })[]
}
type Ticket = RemotePairingRequest & {
  claimSecret: string
  state: 'pending' | 'approved' | 'rejected'
  token?: string
  /** TLS pairing: SHA-256 (base64url) of the phone's nonce, which stays hidden until the desktop's nonce is out. */
  commitment?: string
  serverNonce?: string
}
const verifier = (token: string) => createHash('sha256').update(token).digest('hex')

/** Approval is local to the desktop. Discovery never grants access to the library. */
export class RemoteDevicePairing {
  private readonly options: {
    document?: RemoteTrustDocument
    save?(value: RemoteTrustDocument): void
    now?: () => number
  }
  private document: RemoteTrustDocument
  private readonly tickets = new Map<string, Ticket>()
  private readonly limiter: SlidingWindowRateLimiter
  constructor(options: RemoteDevicePairing['options'] = {}) {
    this.options = options
    this.document = options.document ?? { serverId: randomUUID(), devices: [] }
    this.limiter = new SlidingWindowRateLimiter(8, 300_000, () => this.now())
  }
  get serverId(): string { return this.document.serverId }
  private now(): number { return this.options.now?.() ?? Date.now() }
  private prune(): void {
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= this.now()) this.tickets.delete(id)
  }
  pending(): RemotePairingRequest[] {
    this.prune()
    // A committed request is offered for approval only once its verification code exists.
    return [...this.tickets.values()].filter(t => t.state === 'pending' && (!t.commitment || t.verificationCode))
      .map(({ id, deviceName, address, expiresAt, verificationCode }) =>
        ({ id, deviceName, address, expiresAt, ...(verificationCode ? { verificationCode } : {}) }))
  }
  devices(): RemoteTrustedDevice[] {
    return this.document.devices.map(({ id, name, createdAt }) => ({ id, name, createdAt }))
  }
  request(deviceName: unknown, address: string, commitment?: string):
    { requestId: string; claimSecret: string; expiresAt: number; serverNonce?: string } {
    // eslint-disable-next-line no-control-regex -- Device labels must not inject control characters into approval prompts.
    if (typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 80 || /[\x00-\x1f\x7f]/.test(deviceName))
      throw new Error('invalid_device_name')
    this.prune()
    if (!this.limiter.tryConsume() || this.tickets.size >= 4 || this.document.devices.length + this.pending().length >= 16)
      throw new Error('too_many_pair_requests')
    const ticket: Ticket = { id: randomUUID(), deviceName: deviceName.trim(), address,
      claimSecret: randomBytes(32).toString('base64url'), state: 'pending', expiresAt: this.now() + 120_000,
      ...(commitment ? { commitment, serverNonce: randomBytes(32).toString('base64url') } : {}) }
    this.tickets.set(ticket.id, ticket)
    return { requestId: ticket.id, claimSecret: ticket.claimSecret, expiresAt: ticket.expiresAt,
      ...(ticket.serverNonce ? { serverNonce: ticket.serverNonce } : {}) }
  }
  /** Opens the phone's commitment once; the code then depends on both nonces and the certificate. */
  reveal(requestId: string, claimSecret: string, nonce: string, code: (serverNonce: string) => string): boolean {
    this.prune()
    const ticket = this.tickets.get(requestId)
    if (!ticket || !safeEqualText(ticket.claimSecret, claimSecret) || ticket.state !== 'pending' ||
      !ticket.commitment || !ticket.serverNonce || ticket.verificationCode) return false
    if (!safeEqualText(createHash('sha256').update(nonce).digest('base64url'), ticket.commitment)) return false
    ticket.verificationCode = code(ticket.serverNonce)
    return true
  }
  decide(requestId: string, allow: boolean): boolean {
    this.prune()
    const ticket = this.tickets.get(requestId)
    if (!ticket || ticket.state !== 'pending') return false
    // Nobody can approve a TLS request before both screens could compare its code.
    if (allow && ticket.commitment && !ticket.verificationCode) return false
    if (allow) {
      const token = randomBytes(32).toString('base64url')
      const next = { ...this.document, devices: [...this.document.devices,
        { id: ticket.id, name: ticket.deviceName, createdAt: this.now(), tokenHash: verifier(token) }] }
      this.options.save?.(next)
      this.document = next
      ticket.token = token
    }
    ticket.state = allow ? 'approved' : 'rejected'
    return true
  }
  claim(requestId: string, claimSecret: string): { state: 'pending' | 'approved' | 'rejected'; token?: string } | null {
    this.prune()
    const ticket = this.tickets.get(requestId)
    if (!ticket || !safeEqualText(ticket.claimSecret, claimSecret)) return null
    return { state: ticket.state, ...(ticket.token ? { token: ticket.token } : {}) }
  }
  authorize(token: string): boolean {
    return this.principal(token) !== null
  }
  principal(token: string): string | null {
    if (!token || token.length > 256) return null
    const hash = verifier(token)
    return this.document.devices.find(device => safeEqualText(hash, device.tokenHash))?.id ?? null
  }
  revoke(id?: string): void {
    const next = { ...this.document, devices: id ? this.document.devices.filter(d => d.id !== id) : [] }
    this.options.save?.(next)
    this.document = next
    if (id) this.tickets.delete(id)
    else this.tickets.clear()
  }
  clearPending(): void { this.tickets.clear() }
}
