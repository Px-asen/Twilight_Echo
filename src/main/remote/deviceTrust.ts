import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RemoteDevicePairing, type RemoteTrustDocument } from '../../core/cast/devicePairing.ts'
import { certificateFingerprint, createRemoteTlsIdentity, type RemoteTlsIdentity } from '../../core/cast/tlsIdentity.ts'

/** Stored in the application profile. Only token verifiers are written, never bearer tokens. */
export function createPersistentDevicePairing(root: string): RemoteDevicePairing {
  const path = join(root, 'remote-devices.json')
  let document: RemoteTrustDocument | undefined
  if (existsSync(path)) {
    const value = JSON.parse(readFileSync(path, 'utf8')) as RemoteTrustDocument
    if (!/^[a-f0-9-]{36}$/.test(value.serverId) || !Array.isArray(value.devices) || value.devices.length > 16 ||
      value.devices.some(d => typeof d.id !== 'string' || typeof d.name !== 'string' ||
        !Number.isSafeInteger(d.createdAt) || !/^[a-f0-9]{64}$/.test(d.tokenHash)))
      throw new Error('Invalid remote device trust file')
    document = value
  }
  const save = (value: RemoteTrustDocument) => {
    writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }
  const pairing = new RemoteDevicePairing({ document, save })
  if (!document) save({ serverId: pairing.serverId, devices: [] })
  return pairing
}

/**
 * The certificate phones pin. It lives beside the trust file and is created once; replacing it makes every
 * paired phone refuse this desktop until it is paired again, which is the point of pinning.
 */
export function loadRemoteTlsIdentity(root: string): RemoteTlsIdentity {
  const path = join(root, 'remote-tls.json')
  if (existsSync(path)) {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { key?: unknown; cert?: unknown }
    if (typeof value.key !== 'string' || typeof value.cert !== 'string') throw new Error('Invalid remote TLS identity file')
    return { key: value.key, cert: value.cert, fingerprint: certificateFingerprint(value.cert) }
  }
  const identity = createRemoteTlsIdentity()
  writeFileSync(`${path}.tmp`, JSON.stringify({ key: identity.key, cert: identity.cert }), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
  return identity
}
