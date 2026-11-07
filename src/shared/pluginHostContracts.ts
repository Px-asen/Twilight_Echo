/** Host routing and validation must not initialize a provider or Core ports. */
export const QISHUI_PLUGIN_ID = 'com.twilightecho.provider.qishui'
export const INTERNAL_NCM_PLUGIN_ID = 'com.twilightecho.provider.ncm'
export const PLUGIN_RPC_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function normalizeInternalNcmRequestOptions(raw: unknown): { idempotencyKey?: string } {
  if (raw == null) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('ncmRequest options 必须是对象')
  }
  const record = raw as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== 'idempotencyKey')) {
    throw new Error('ncmRequest options 包含不支持的字段')
  }
  const key = record.idempotencyKey
  if (key == null) return {}
  if (typeof key !== 'string' || !PLUGIN_RPC_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new Error('ncmRequest idempotency key 无效')
  }
  return { idempotencyKey: key }
}
