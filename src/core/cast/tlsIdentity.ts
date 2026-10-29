import { coreCrypto } from '../ports/index.ts'
import { PortableBuffer } from '../../shared/portableBytes.ts'

/** The desktop's long-lived TLS identity. Phones pin `fingerprint` (SHA-256 of the certificate DER) at pairing. */
export interface RemoteTlsIdentity {
  key: string
  cert: string
  fingerprint: string
}

const der = (tag: number, ...parts: Uint8Array[]): PortableBuffer => {
  const body = PortableBuffer.concat(parts)
  const n = body.length
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : null
  if (!length) throw new Error('DER value too long')
  return PortableBuffer.concat([PortableBuffer.from([tag, ...length]), body])
}
const sequence = (...parts: Uint8Array[]) => der(0x30, ...parts)
const ascii = (text: string) => PortableBuffer.from(text, 'utf8')
/** ecdsa-with-SHA256 (1.2.840.10045.4.3.2); ECDSA identifiers carry no parameters. */
const ECDSA_SHA256 = sequence(der(0x06, PortableBuffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])))
const commonName = (name: string) =>
  sequence(der(0x31, sequence(der(0x06, PortableBuffer.from([0x55, 0x04, 0x03])), der(0x0c, ascii(name)))))

/**
 * A self-signed P-256 certificate. Nothing validates its chain, names or dates: phones trust exactly
 * the fingerprint they pinned, so the certificate only has to be well-formed and stable.
 */
export function createRemoteTlsIdentity(name = 'Twilight Echo Core'): RemoteTlsIdentity {
  const { publicKey, privateKey } = coreCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const serial = coreCrypto.randomBytes(16)
  serial[0] = (serial[0]! & 0x7f) | 0x01
  const subject = commonName(name.slice(0, 64))
  const tbs = sequence(
    der(0xa0, der(0x02, PortableBuffer.from([0x02]))),
    der(0x02, serial),
    ECDSA_SHA256,
    subject,
    sequence(der(0x17, ascii('200101000000Z')), der(0x18, ascii('20991231235959Z'))),
    subject,
    publicKey.export({ type: 'spki', format: 'der' })
  )
  const signature = coreCrypto.sign('sha256', tbs, privateKey)
  const certificate = sequence(tbs, ECDSA_SHA256, der(0x03, PortableBuffer.from([0]), signature))
  return {
    key: String(privateKey.export({ type: 'pkcs8', format: 'pem' })),
    cert: certificatePem(certificate),
    fingerprint: coreCrypto.createHash('sha256').update(certificate).digest('hex')
  }
}

function certificatePem(certificate: Uint8Array): string {
  const lines = PortableBuffer.from(certificate).toString('base64').match(/.{1,64}/g) ?? []
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
}

/** SHA-256 of the certificate DER, lowercase hex: the value phones pin. */
export function certificateFingerprint(certPem: string): string {
  const body = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(certPem)?.[1]
  if (!body) throw new Error('Invalid TLS certificate')
  return coreCrypto.createHash('sha256').update(PortableBuffer.from(body.replace(/\s+/g, ''), 'base64')).digest('hex')
}

/**
 * The six digits both screens show while a phone waits for approval. Each side derives them from the
 * certificate it sees, the phone's revealed nonce and the desktop's nonce; the phone committed to its
 * nonce before it learned the desktop's, so an interceptor holding a different certificate cannot steer
 * both screens to the same digits.
 */
export function remotePairingCode(fingerprint: string, phoneNonce: string, serverNonce: string): string {
  const digest = coreCrypto.createHash('sha256')
    .update(`twilight-pair-v2|${fingerprint.toLowerCase()}|${phoneNonce}|${serverNonce}`).digest()
  return String(PortableBuffer.from(digest).readUInt32BE(0) % 1_000_000).padStart(6, '0')
}
