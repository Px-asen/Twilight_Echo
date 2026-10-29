import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteDevicePairing, type RemoteTrustDocument } from './devicePairing.ts'
import { RemoteHttpServer } from './httpServer.ts'
import { createPersistentDevicePairing, loadRemoteTlsIdentity } from '../../main/remote/deviceTrust.ts'
import { request as httpsRequest } from 'node:https'
import type { TLSSocket } from 'node:tls'
import { X509Certificate, createHash, createPrivateKey, randomBytes } from 'node:crypto'
import { certificateFingerprint, createRemoteTlsIdentity, remotePairingCode } from './tlsIdentity.ts'
import type { RemotePairingRequest } from '../../shared/remoteControl.ts'

test('only a desktop approval plus the private claim secret yields a device credential', () => {
  let now = 1000
  let saved: RemoteTrustDocument | undefined
  const pairing = new RemoteDevicePairing({ now: () => now, save: value => { saved = value } })
  const ticket = pairing.request('我的手机', '192.168.1.2')
  assert.equal(pairing.authorize(ticket.claimSecret), false)
  assert.equal(pairing.claim(ticket.requestId, 'wrong'), null)
  assert.deepEqual(pairing.claim(ticket.requestId, ticket.claimSecret), { state: 'pending' })
  assert.equal('claimSecret' in pairing.pending()[0], false)
  assert.equal(pairing.decide(ticket.requestId, true), true)
  const claim = pairing.claim(ticket.requestId, ticket.claimSecret)!
  assert.equal(pairing.authorize(claim.token!), true)
  assert.equal(JSON.stringify(saved).includes(claim.token!), false)
  assert.deepEqual(Object.keys(pairing.devices()[0]).sort(), ['createdAt', 'id', 'name'])
  const again = new RemoteDevicePairing({ document: saved })
  assert.equal(again.serverId, pairing.serverId)
  assert.equal(again.authorize(claim.token!), true)
  const second = pairing.request('平板', '192.168.1.3')
  pairing.decide(second.requestId, true)
  const secondToken = pairing.claim(second.requestId, second.claimSecret)!.token!
  pairing.revoke(ticket.requestId)
  assert.equal(pairing.authorize(claim.token!), false)
  assert.equal(pairing.authorize(secondToken), true)
  const denied = pairing.request('陌生设备', '192.168.1.4')
  pairing.decide(denied.requestId, false)
  assert.deepEqual(pairing.claim(denied.requestId, denied.claimSecret), { state: 'rejected' })
  now += 120001
  assert.equal(pairing.claim(second.requestId, second.claimSecret), null)
  assert.equal(pairing.decide(second.requestId, true), false)
})

test('pair requests validate names and have bounded lifetime and capacity', () => {
  const pairing = new RemoteDevicePairing()
  for (const name of ['', 'x\nspoof', 'x'.repeat(81), 123]) assert.throws(() => pairing.request(name, '127.0.0.1'))
  for (let i = 0; i < 4; i++) pairing.request(`Phone ${i}`, '127.0.0.1')
  assert.throws(() => pairing.request('Fifth', '127.0.0.1'), /too_many/)
  pairing.clearPending()
  assert.equal(pairing.pending().length, 0)
})

test('persistent trust keeps server identity and only revokes the selected phone', async t => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-device-trust-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = createPersistentDevicePairing(root)
  const ticket = first.request('Phone', '127.0.0.1')
  first.decide(ticket.requestId, true)
  const token = first.claim(ticket.requestId, ticket.claimSecret)!.token!
  assert.equal((await readFile(join(root, 'remote-devices.json'), 'utf8')).includes(token), false)
  const restarted = createPersistentDevicePairing(root)
  assert.equal(restarted.serverId, first.serverId)
  assert.equal(restarted.authorize(token), true)
  restarted.revoke(ticket.requestId)
  assert.equal(createPersistentDevicePairing(root).authorize(token), false)
})

test('pending approvals reserve capacity so concurrent requests cannot exceed the device limit', () => {
  const document: RemoteTrustDocument = { serverId: 'test-server', devices: Array.from({ length: 15 }, (_, index) => ({
    id: `device-${index}`, name: 'Phone', createdAt: 1, tokenHash: '0'.repeat(64)
  })) }
  const pairing = new RemoteDevicePairing({ document })
  const last = pairing.request('Last phone', '127.0.0.1')
  assert.throws(() => pairing.request('Extra phone', '127.0.0.1'), /too_many_pair_requests/)
  pairing.decide(last.requestId, false)
  const replacement = pairing.request('Replacement', '127.0.0.1')
  pairing.decide(replacement.requestId, true)
  assert.equal(pairing.devices().length, 16)
  assert.throws(() => pairing.request('Extra phone', '127.0.0.1'), /too_many_pair_requests/)
})

test('real HTTP approval, rejection, revocation and discovery lifecycle preserve PIN clients', async t => {
  const advertising: string[] = []
  const remote = new RemoteHttpServer({ staticRoot: '', addresses: () => ['127.0.0.1'],
    onCoreRpc: async () => ({ ok: true }),
    discovery: { start: async info => { advertising.push(`start:${info.port}`) }, stop: async () => { advertising.push('stop') } } })
  t.after(() => remote.stop())
  const started = await remote.start(0)
  const base = `http://127.0.0.1:${started.port}`
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal(started.discovery, 'advertising')
  const status = await (await fetch(base + '/api/status')).json() as { serverId: string; pairingMode: string }
  assert.equal(status.pairingMode, 'approval-v1')
  assert.equal(status.serverId, started.serverId)
  const ticket = await (await post('/api/pair/requests', { deviceName: 'Phone' })).json() as { requestId: string; claimSecret: string }
  assert.equal((await fetch(base + '/api/state')).status, 401)
  assert.equal((await post('/api/pair/claim', { ...ticket, claimSecret: 'wrong' })).status, 404)
  remote.decidePairing(ticket.requestId, true)
  const claim = await (await post('/api/pair/claim', ticket)).json() as { token: string }
  const auth = { authorization: `Bearer ${claim.token}` }
  assert.equal((await fetch(base + '/api/state', { headers: auth })).status, 200)
  const events = await fetch(base + '/api/core/events', { headers: auth })
  const reader = events.body!.getReader()
  await reader.read()
  remote.revokeDevice(ticket.requestId)
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: auth/)
  await reader.cancel()
  assert.equal((await fetch(base + '/api/state', { headers: auth })).status, 401)
  const cancel = await (await post('/api/pair/requests', { deviceName: 'Cancel me' })).json()
  assert.equal((await post('/api/pair/cancel', cancel)).status, 200)
  assert.equal(((await (await post('/api/pair/claim', cancel)).json()) as { state: string }).state, 'rejected')
  const legacy = await (await post('/api/pair', { pin: started.pin })).json() as { token: string }
  assert.equal((await fetch(base + '/api/state', { headers: { authorization: `Bearer ${legacy.token}` } })).status, 200)
  await remote.start(0, { mode: 'mediaOnly' })
  assert.equal((await post('/api/pair/requests', { deviceName: 'Hidden' })).status, 404)
  assert.equal(remote.getStatus().discovery, 'off')
  assert.deepEqual(advertising, [`start:${started.port}`, 'stop'])
})

test('TLS pairing pins the certificate, shows one code on both screens and keeps device tokens off plain HTTP', async t => {
  const tls = createRemoteTlsIdentity()
  const prompts: RemotePairingRequest[] = []
  let approve: (allow: boolean) => void = () => {}
  const remote = new RemoteHttpServer({ staticRoot: '', addresses: () => ['127.0.0.1'], tls,
    onCoreRpc: async () => ({ ok: true }),
    confirmDevice: request => { prompts.push(request); return new Promise(resolve => { approve = resolve }) } })
  t.after(() => remote.stop())
  const { port } = await remote.start(0)
  const secure = (path: string, body?: unknown, token?: string) => new Promise<{ status: number; json: any; fingerprint: string }>(
    (resolve, reject) => {
      const req = httpsRequest({ host: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST',
        rejectUnauthorized: false, headers: { 'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}) } }, res => {
        const fingerprint = (res.socket as TLSSocket).getPeerCertificate().fingerprint256.replace(/:/g, '').toLowerCase()
        let text = ''
        res.on('data', chunk => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null, fingerprint }))
      })
      req.on('error', reject)
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  const plain = `http://127.0.0.1:${port}`

  const status = await secure('/api/status')
  assert.equal(status.fingerprint, tls.fingerprint)
  assert.equal(status.json.pairingMode, 'approval-v2')
  assert.equal(status.json.tls, true)
  assert.ok(status.json.capabilities.queries.includes('providers.session'))
  const plainStatus = await (await fetch(plain + '/api/status')).json() as { capabilities: { queries: string[] } }
  assert.ok(!plainStatus.capabilities.queries.includes('providers.session'), 'the browser remote keeps working without TLS')

  const plainRequest = await fetch(plain + '/api/pair/requests', { method: 'POST', body: JSON.stringify({ deviceName: 'Phone' }) })
  assert.equal(plainRequest.status, 403)
  assert.equal((await secure('/api/pair/requests', { deviceName: 'Phone' })).status, 400, 'TLS pairing needs a commitment')

  const nonce = randomBytes(32).toString('base64url')
  const commitment = createHash('sha256').update(nonce).digest('base64url')
  const ticket = (await secure('/api/pair/requests', { deviceName: 'Phone', commitment })).json
  assert.match(ticket.serverNonce, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(prompts.length, 0, 'the desktop must not ask before a code exists')
  assert.deepEqual(remote.getStatus().pairingRequests, [])
  assert.throws(() => remote.decidePairing(ticket.requestId, true), /pair_request_expired/)
  assert.equal((await secure('/api/pair/reveal', { ...ticket, nonce: 'not-the-committed-nonce' })).status, 404)
  assert.equal((await secure('/api/pair/reveal', { requestId: ticket.requestId, claimSecret: ticket.claimSecret, nonce })).status, 200)
  assert.equal((await secure('/api/pair/reveal', { requestId: ticket.requestId, claimSecret: ticket.claimSecret, nonce })).status, 404,
    'a revealed request cannot be re-keyed')
  const code = remotePairingCode(tls.fingerprint, nonce, ticket.serverNonce)
  assert.match(code, /^\d{6}$/)
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0]!.verificationCode, code)
  assert.equal(remote.getStatus().pairingRequests?.[0]?.verificationCode, code)
  assert.notEqual(remotePairingCode(createRemoteTlsIdentity().fingerprint, nonce, ticket.serverNonce), code,
    'a phone talking to another certificate sees other digits')

  approve(true)
  let claim: { state: string; token?: string } = { state: 'pending' }
  for (let i = 0; i < 50 && claim.state === 'pending'; i++)
    claim = (await secure('/api/pair/claim', { requestId: ticket.requestId, claimSecret: ticket.claimSecret })).json
  assert.equal(claim.state, 'approved')
  assert.equal((await secure('/api/state', undefined, claim.token)).status, 200)
  assert.equal((await fetch(plain + '/api/state', { headers: { authorization: `Bearer ${claim.token}` } })).status, 401,
    'a device token sent in plain text is refused')

  assert.equal((await fetch(plain + '/api/pair/forget', { method: 'POST', headers: { authorization: `Bearer ${claim.token}` } })).status,
    401, 'forgetting needs the encrypted transport too')
  assert.equal((await secure('/api/pair/forget', {}, 'someone-else')).status, 401)
  assert.equal(remote.getStatus().trustedDevices?.length, 1)
  assert.equal((await secure('/api/pair/forget', {}, claim.token)).status, 200)
  assert.equal(remote.getStatus().trustedDevices?.length ?? 0, 0, 'the phone forgetting the computer revokes its own token')
  assert.equal((await secure('/api/state', undefined, claim.token)).status, 401)
})

test('the TLS identity is created once and reloaded with the same fingerprint', async t => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-tls-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = loadRemoteTlsIdentity(root)
  const second = loadRemoteTlsIdentity(root)
  assert.equal(second.fingerprint, first.fingerprint)
  assert.equal(certificateFingerprint(second.cert), first.fingerprint)
  assert.equal(new X509Certificate(second.cert).checkPrivateKey(createPrivateKey(second.key)), true)
})

test('pairing codes match the vectors the Android client is tested against', () => {
  // Same vectors as DesktopApprovalTest.pairingCodesMatchTheDesktopImplementation on Android.
  assert.equal(remotePairingCode('AB'.repeat(32), 'phone-nonce', 'server-nonce'), '133668')
  assert.equal(remotePairingCode('0'.repeat(64), 'x', 'y'), '495891')
  assert.equal(remotePairingCode('f00d'.repeat(16), 'nonceA_-', 'nonceB'), '889474')
})
