export interface SecureValueEnvelope {
  __twilightSecure: true
  version: 1
  backend: 'electron-safe-storage' | 'aes-256-gcm-machine' | 'windows-dpapi' | 'aes-256-gcm-profile'
  ciphertext: string
  iv?: string
  tag?: string
}

const SENSITIVE_KEY_PATTERN =
  /(^|[-_.:])(cookie|csrf|token|access[-_.:]?token|refresh[-_.:]?token|api[-_.:]?key|apikey|bearer|signing[-_.:]?key|client[-_.:]?secret|secret|password|passwd|credential|session|auth)([-_.:]|$)/i

export function isSensitiveStorageKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key.trim())
}

export function isSecureValueEnvelope(value: unknown): value is SecureValueEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.__twilightSecure === true &&
    record.version === 1 &&
    typeof record.ciphertext === 'string'
  )
}
