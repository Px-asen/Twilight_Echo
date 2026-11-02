import { createHash } from '../../shared/portableCrypto.ts'
import { PortableBuffer } from '../../shared/portableBytes.ts'

/** The desktop's long-lived TLS identity. Phones pin `fingerprint` (SHA-256 of the certificate DER) at pairing. */
export interface RemoteTlsIdentity {
  key: string
  cert: string
  fingerprint: string
}

/** SHA-256 of the certificate DER, lowercase hex: the value phones pin. */
export function certificateFingerprint(certPem: string): string {
  const body = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(certPem)?.[1]
  if (!body) throw new Error('Invalid TLS certificate')
  return createHash('sha256').update(PortableBuffer.from(body.replace(/\s+/g, ''), 'base64')).digest('hex')
}

/**
 * The six digits both screens show while a phone waits for approval. Each side derives them from the
 * certificate it sees, the phone's revealed nonce and the desktop's nonce; the phone committed to its
 * nonce before it learned the desktop's, so an interceptor holding a different certificate cannot steer
 * both screens to the same digits.
 */
export function remotePairingCode(fingerprint: string, phoneNonce: string, serverNonce: string): string {
  const digest = createHash('sha256')
    .update(`twilight-pair-v2|${fingerprint.toLowerCase()}|${phoneNonce}|${serverNonce}`).digest()
  return String(PortableBuffer.from(digest).readUInt32BE(0) % 1_000_000).padStart(6, '0')
}
