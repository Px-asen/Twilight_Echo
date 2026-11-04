import { createRequire } from 'node:module'
import { resolve, sep } from 'node:path'
import type { CoreSupervisorOptions } from '../coreProcess/supervisor.ts'
import { tryParseJsonWithNestingLimit } from '../../shared/jsonSafety.ts'
import { createProfileCipher } from './profileCredentials.ts'

const require = createRequire(import.meta.url)
type Binding = { protect(data: Buffer, entropy: Buffer): Buffer; unprotect(data: Buffer, entropy: Buffer): Buffer }
/** DPAPI binds secrets to the service account. Entropy remains stable across profile backup/restore paths. */
export function createServerCredentials(root: string, addon?: string): NonNullable<CoreSupervisorOptions['platform']> {
  let binding: Binding | undefined
  const profile = process.platform === 'linux' ? createProfileCipher(root) : undefined
  const load = () => {
    if (!addon || process.platform !== 'win32') throw new Error('Server 缺少 Windows 凭据保护组件')
    return binding ??= require(addon) as Binding
  }
  const entropy = (scope: string) => {
    const prefix = `plugin-settings:${resolve(root)}${sep}`
    if (!scope.startsWith(prefix) || scope.length > 8192) throw new Error('无效的扩展凭据范围')
    return Buffer.from(`twilight-server-credentials-v1\0${scope.slice(prefix.length).replaceAll('\\', '/')}`, 'utf8')
  }
  return {
    'credentials.protect': async ({ scope, value }) => {
      const bytes = Buffer.from(JSON.stringify(value) ?? 'null'), context = entropy(scope)
      if (bytes.length > 1024 * 1024) throw new Error('扩展凭据内容过大')
      try {
        return profile ? await profile.protect(bytes, context) : { __twilightSecure: true, version: 1, backend: 'windows-dpapi',
          ciphertext: load().protect(bytes, context).toString('base64') }
      } finally { bytes.fill(0) }
    },
    'credentials.unprotect': async ({ scope, value }) => {
      if (!profile && value.backend !== 'windows-dpapi') throw new Error('此凭据来自其他宿主，请在 Server 重新登录')
      const decoded = profile ? await profile.unprotect(value, entropy(scope)) : load().unprotect(Buffer.from(value.ciphertext, 'base64'), entropy(scope))
      try {
        const parsed = tryParseJsonWithNestingLimit(decoded.toString('utf8'))
        if (!parsed.ok) throw new Error('扩展凭据内容无效')
        return parsed.value
      } finally { decoded.fill(0) }
    }
  }
}
