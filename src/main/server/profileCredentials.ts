import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SecureValueEnvelope } from '../../shared/secureValue.ts'

/** A private random key travels with the persistent profile, never with the container image. */
export function createProfileCipher(root: string) {
  const file = join(root, 'server-credentials.key')
  let pending: Promise<Buffer> | undefined
  async function readKey(create: boolean): Promise<Buffer> {
    if (create) {
      const key = randomBytes(32)
      try { await writeFile(file, key, { flag: 'wx', mode: 0o600 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      finally { key.fill(0) }
    }
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== 32 ||
        (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid!())))
      throw new Error('Server 凭据密钥须由运行账号持有，权限为 0600，且为 32 字节普通文件')
    const key = await readFile(file)
    if (key.length !== 32) throw new Error('Server 凭据密钥已损坏')
    return key
  }
  const key = (create: boolean) => pending ??= readKey(create).catch(error => { pending = undefined; throw error })
  return {
    async protect(bytes: Buffer, scope: Buffer): Promise<SecureValueEnvelope> {
      // Keep the IV next to the ciphertext; the key remains in the profile's private file.
      const iv = randomBytes(12)
      const encryption = createCipheriv('aes-256-gcm', await key(true), iv)
      encryption.setAAD(scope)
      const ciphertext = Buffer.concat([encryption.update(bytes), encryption.final()])
      return { __twilightSecure: true, version: 1, backend: 'aes-256-gcm-profile',
        ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: encryption.getAuthTag().toString('base64') }
    },
    async unprotect(value: SecureValueEnvelope, scope: Buffer): Promise<Buffer> {
      if (value.backend !== 'aes-256-gcm-profile') throw new Error('此凭据来自其他宿主，请在 Server 重新登录')
      const iv = Buffer.from(value.iv ?? '', 'base64'), tag = Buffer.from(value.tag ?? '', 'base64')
      if (iv.length !== 12 || tag.length !== 16) throw new Error('Server 凭据格式无效')
      const decipher = createDecipheriv('aes-256-gcm', await key(false), iv)
      decipher.setAAD(scope); decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()])
    }
  }
}
