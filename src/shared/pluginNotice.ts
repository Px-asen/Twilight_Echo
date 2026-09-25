/**
 * Shared contract for the host-rendered plugin notice (toast) API.
 *
 * `context.twilight.ui.notify(...)` in the plugin host ultimately produces a
 * {@link PluginNotice}, which the renderer turns into a toast through
 * `useAppNoticeStore`. Keep the validation here so the main process, preload
 * bridge and tests all agree on the same limits.
 */

export const PLUGIN_NOTICE_KINDS = ['info', 'success', 'warning', 'error'] as const

export const PLUGIN_NOTICE_CHANNEL = 'plugins:notice'

export type PluginNoticeKind = (typeof PLUGIN_NOTICE_KINDS)[number]

/** A transient notice a plugin asked the host to show. */
export interface PluginNotice {
  pluginId: string
  kind: PluginNoticeKind
  message: string
  durationMs?: number
}

export const PLUGIN_NOTICE_MESSAGE_MAX_LENGTH = 500
export const PLUGIN_NOTICE_MIN_DURATION_MS = 2500
export const PLUGIN_NOTICE_MAX_DURATION_MS = 30_000

/**
 * Validate untrusted plugin input. Returns `null` for anything without a
 * usable message; malformed `kind`/`durationMs` fall back to safe defaults.
 */
export function normalizePluginNoticeInput(
  raw: unknown
): { kind: PluginNoticeKind; message: string; durationMs?: number } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const message = typeof record.message === 'string' ? record.message.trim() : ''
  if (!message) return null
  const kind = PLUGIN_NOTICE_KINDS.includes(record.kind as PluginNoticeKind)
    ? (record.kind as PluginNoticeKind)
    : 'info'
  const durationMs =
    typeof record.durationMs === 'number' && Number.isFinite(record.durationMs)
      ? Math.min(
          PLUGIN_NOTICE_MAX_DURATION_MS,
          Math.max(PLUGIN_NOTICE_MIN_DURATION_MS, Math.round(record.durationMs))
        )
      : undefined
  return { kind, message: message.slice(0, PLUGIN_NOTICE_MESSAGE_MAX_LENGTH), durationMs }
}
