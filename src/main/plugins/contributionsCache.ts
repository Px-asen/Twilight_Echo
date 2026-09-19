/**
 * Persisted snapshot of what each JS plugin registered while it was running.
 *
 * With host hibernation the manager only needs a plugin's provider and UI
 * contributions to route calls; the process itself can start on demand. This
 * cache lets an enabled plugin come up hibernated at boot instead of forking a
 * utility process, as long as the snapshot still matches the installed
 * version. Anything unexpected in the file simply cold-starts that plugin.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import type {
  TwilightMediaProviderCapability,
  TwilightMediaProviderMethod,
  TwilightMediaProviderRegistration,
  TwilightUiContribution
} from './types'
import { isTwilightMediaProviderMethod, normalizeProviderUi } from './providerRouting.ts'

export const PLUGIN_CONTRIBUTIONS_CACHE_FILE = 'plugin-contributions.json'
export const MAX_PLUGIN_CONTRIBUTIONS_BYTES = 1024 * 1024
const CACHE_SCHEMA_VERSION = 1
const PROVIDER_CAPABILITIES: readonly TwilightMediaProviderCapability[] = [
  'search',
  'playbackUrl',
  'lyrics',
  'cover',
  'playlist',
  'library',
  'login',
  'download'
]
const UI_CONTRIBUTION_KINDS = new Set([
  'sidebarPage',
  'playerBarButton',
  'settingsPanel',
  'localSidebarItem',
  'streamingHome'
])

export interface PluginContributionsSnapshot {
  version: string
  /** Size:mtime of the plugin entry file; a rebuilt bundled plugin invalidates the cache. */
  mainSignature: string
  providers: TwilightMediaProviderRegistration[]
  ui: TwilightUiContribution[]
  subscriptions: string[]
}

export type PluginContributionsCacheFile = Record<string, PluginContributionsSnapshot>

interface CacheDocument {
  schemaVersion: number
  plugins: PluginContributionsCacheFile
}

export async function loadPluginContributionsCache(
  filePath: string
): Promise<PluginContributionsCacheFile> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    return {}
  }
  if (Buffer.byteLength(raw, 'utf-8') > MAX_PLUGIN_CONTRIBUTIONS_BYTES) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const document = parsed as Partial<CacheDocument>
  if (document.schemaVersion !== CACHE_SCHEMA_VERSION) return {}
  const plugins = document.plugins
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return {}
  const result: PluginContributionsCacheFile = {}
  for (const [pluginId, value] of Object.entries(plugins)) {
    const snapshot = normalizeSnapshot(value)
    if (snapshot && isPluginId(pluginId)) result[pluginId] = snapshot
  }
  return result
}

export async function savePluginContributionsCache(
  filePath: string,
  cache: PluginContributionsCacheFile
): Promise<void> {
  const document: CacheDocument = { schemaVersion: CACHE_SCHEMA_VERSION, plugins: cache }
  const json = JSON.stringify(document, null, 2)
  if (Buffer.byteLength(json, 'utf-8') > MAX_PLUGIN_CONTRIBUTIONS_BYTES) {
    throw new Error('Plugin contributions cache is too large to persist.')
  }
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, json, 'utf-8')
    await rename(temporary, filePath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function isPluginId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes('/') && !value.includes('\\')
}

function normalizeSnapshot(value: unknown): PluginContributionsSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.version !== 'string' || !record.version.trim() || record.version.length > 128)
    return null
  if (
    typeof record.mainSignature !== 'string' ||
    !/^\d+:\d+$/.test(record.mainSignature) ||
    record.mainSignature.length > 64
  )
    return null
  if (!Array.isArray(record.providers) || !Array.isArray(record.ui)) return null
  const providers: TwilightMediaProviderRegistration[] = []
  for (const raw of record.providers) {
    const provider = normalizeProvider(raw)
    if (!provider) return null
    providers.push(provider)
  }
  const ui: TwilightUiContribution[] = []
  for (const raw of record.ui) {
    const contribution = normalizeUi(raw)
    if (!contribution) return null
    ui.push(contribution)
  }
  const subscriptions = Array.isArray(record.subscriptions)
    ? record.subscriptions.filter(
        (item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 128
      )
    : []
  return {
    version: record.version,
    mainSignature: record.mainSignature,
    providers,
    ui,
    subscriptions
  }
}

function normalizeProvider(raw: unknown): TwilightMediaProviderRegistration | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim().toLowerCase() : ''
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!id || !/^[a-z][a-z0-9-]*$/.test(id) || !name) return null
  if (!Array.isArray(record.capabilities)) return null
  const capabilities = record.capabilities.filter(
    (item): item is TwilightMediaProviderCapability =>
      typeof item === 'string' &&
      PROVIDER_CAPABILITIES.includes(item as TwilightMediaProviderCapability)
  )
  if (capabilities.length === 0) return null
  const supportedMethods = Array.isArray(record.supportedMethods)
    ? record.supportedMethods.filter(
        (item): item is TwilightMediaProviderMethod =>
          typeof item === 'string' && isTwilightMediaProviderMethod(item)
      )
    : undefined
  return {
    id,
    name,
    capabilities,
    ...(supportedMethods ? { supportedMethods } : {}),
    ui: normalizeProviderUi(record.ui)
  }
}

function normalizeUi(raw: unknown): TwilightUiContribution | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const kind = typeof record.kind === 'string' ? record.kind : ''
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  if (!id || !title || !UI_CONTRIBUTION_KINDS.has(kind)) return null
  const contribution: TwilightUiContribution = {
    id,
    kind: kind as TwilightUiContribution['kind'],
    title
  }
  if (typeof record.description === 'string') contribution.description = record.description
  if (typeof record.icon === 'string') contribution.icon = record.icon
  if (typeof record.command === 'string') contribution.command = record.command
  if (record.renderMode === 'command' || record.renderMode === 'html')
    contribution.renderMode = record.renderMode
  if (typeof record.autoLoad === 'boolean') contribution.autoLoad = record.autoLoad
  return contribution
}
