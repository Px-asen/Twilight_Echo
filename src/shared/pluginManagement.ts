import type { TwilightPluginDescriptor, TwilightPluginManifest } from './pluginTypes.ts'

export const PLUGIN_TRANSFER_BYTES = 768 * 1024
export const PLUGIN_UPLOAD_BYTES = 50 * 1024 * 1024
export const PLUGIN_MANAGEMENT_QUERIES = ['plugins.management.list'] as const
export const PLUGIN_MANAGEMENT_COMMANDS = ['plugins.management.edit', 'plugins.management.upload.begin',
  'plugins.management.upload.chunk', 'plugins.management.upload.cancel', 'plugins.management.preview',
  'plugins.management.install', 'plugins.management.cancel'] as const
export const isPluginManagementOperation = (name: string) =>
  ([...PLUGIN_MANAGEMENT_QUERIES, ...PLUGIN_MANAGEMENT_COMMANDS] as readonly string[]).includes(name)

export type ManagedPlugin = Pick<TwilightPluginDescriptor,
  'id' | 'name' | 'version' | 'description' | 'author' | 'type' | 'permissions' | 'enabled' | 'status' | 'builtIn'> & {
  token: string; issues: string[]
}
export interface PluginManagementPage { canManage: boolean; total: number; offset: number; items: ManagedPlugin[]; maxUploadBytes: number }
export interface PluginPackagePreview {
  previewId: string
  plugin: Pick<TwilightPluginManifest, 'id' | 'name' | 'version' | 'description' | 'author' | 'type' | 'permissions' | 'dependencies'>
  previousVersion: string | null; previouslyEnabled: boolean; issues: string[]; expiresAt: number
}
export interface PluginUpload { fileName: string; byteSize: number }
export interface PluginManagementEdit { id: string; token: string; action: 'enable' | 'disable' | 'uninstall'; removeData?: boolean }

/** Contains only public lifecycle state; never paths, credentials or free-form errors. */
export const pluginManagementToken = (plugin: TwilightPluginDescriptor | null): string => plugin
  ? JSON.stringify([plugin.id, plugin.version, plugin.enabled, plugin.requestedEnabled ?? plugin.enabled, plugin.status, plugin.updatedAt]) : 'null'
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
const text = (value: unknown, max = 160): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\0\r\n]/.test(value)
const uint = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
export const validPluginUpload = (input: PluginUpload): boolean => text(input.fileName) && !/[\\/:]/.test(input.fileName) &&
  !input.fileName.startsWith('.') && input.fileName.toLowerCase().endsWith('.tep')
export function validPluginManagementPayload(name: string, value: Record<string, unknown>): boolean {
  if (name === 'plugins.management.list') return only(value, ['offset']) && (value.offset === undefined || uint(value.offset))
  if (name === 'plugins.management.upload.begin') return only(value, ['fileName', 'byteSize']) &&
    validPluginUpload(value as unknown as PluginUpload) && uint(value.byteSize) && Number(value.byteSize) > 0 && Number(value.byteSize) <= PLUGIN_UPLOAD_BYTES
  if (name === 'plugins.management.upload.chunk') return only(value, ['uploadId', 'offset', 'data']) && text(value.uploadId) &&
    uint(value.offset) && typeof value.data === 'string' && value.data.length > 0 && value.data.length <= PLUGIN_TRANSFER_BYTES / 3 * 4 &&
    value.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.data)
  if (name === 'plugins.management.upload.cancel' || name === 'plugins.management.preview')
    return only(value, ['uploadId']) && text(value.uploadId)
  if (name === 'plugins.management.install' || name === 'plugins.management.cancel')
    return only(value, ['previewId']) && text(value.previewId)
  if (name === 'plugins.management.edit') return only(value, ['id', 'token', 'action', 'removeData']) &&
    text(value.id) && text(value.token, 1024) && ['enable', 'disable', 'uninstall'].includes(String(value.action)) &&
    (value.removeData === undefined || value.action === 'uninstall' && typeof value.removeData === 'boolean')
  return false
}
