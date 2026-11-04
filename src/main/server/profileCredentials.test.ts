import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, cp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProfileCipher } from './profileCredentials.ts'

test('private profile credentials persist, bind scope, reject tampering and move with a backup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-profile-crypto-')), restored = `${root}-restored`
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(restored, { recursive: true, force: true }) })
  const cipher = createProfileCipher(root), value = Buffer.from('test-only-credential'), scope = Buffer.from('plugin-one')
  const [first, second] = await Promise.all([cipher.protect(value, scope), cipher.protect(value, scope)])
  assert.notEqual(first.ciphertext, second.ciphertext)
  assert.equal((await readFile(join(root, 'server-credentials.key'))).length, 32)
  assert.equal((await createProfileCipher(root).unprotect(first, scope)).toString(), value.toString())
  await assert.rejects(cipher.unprotect(first, Buffer.from('plugin-two')))
  await assert.rejects(cipher.unprotect({ ...first, ciphertext: Buffer.from('tampered').toString('base64') }, scope))
  await cp(root, restored, { recursive: true })
  assert.equal((await createProfileCipher(restored).unprotect(first, scope)).toString(), value.toString())
  await writeFile(join(root, 'server-credentials.key'), 'bad')
  await assert.rejects(createProfileCipher(root).unprotect(first, scope), /32/)
  await assert.rejects(createProfileCipher(root).protect(value, scope), /32/)
  assert.equal(await readFile(join(root, 'server-credentials.key'), 'utf8'), 'bad')
})

test('Linux credentials reject a key readable by other accounts', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-profile-mode-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const envelope = await createProfileCipher(root).protect(Buffer.from('value'), Buffer.from('scope'))
  await chmod(join(root, 'server-credentials.key'), 0o644)
  await assert.rejects(createProfileCipher(root).unprotect(envelope, Buffer.from('scope')), /0600/)
})
