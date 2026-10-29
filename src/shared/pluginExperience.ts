export interface PluginExperience {
  id: string
  name: string
  entry: string
  bridgeVersion: 1 | 2
  /**
   * How the host surfaces this experience. `page` (default) lists it in the
   * sidebar navigation; `panel` hides it from navigation — the plugin opens it
   * through its own `titleBarButton` and the host mounts it in a flyout.
   * `sidebar` embeds it below navigation, above the import/edit tools.
   */
  launch?: 'page' | 'panel' | 'sidebar'
  /** Only for launch: sidebar. The iframe height in CSS px, default 144 (64–480). */
  sidebar?: { height?: number }
}

export interface InstalledExperience extends PluginExperience {
  pluginId: string
  version: string
  url: string
  permissions: string[]
}

export interface StartupExperience {
  pluginId: string
  experienceId: string
}

export const EXPERIENCE_MUSIC_OPERATIONS = [
  'status', 'task', 'preview', 'import', 'reconcile', 'introductions', 'credits', 'enrich',
  'inventory', 'history', 'history.read', 'restore', 'cancel',
  'provenance.list', 'provenance.read', 'provenance.review'
] as const
export type ExperienceMusicOperation = typeof EXPERIENCE_MUSIC_OPERATIONS[number]

export function normalizeStartupExperience(value: unknown): StartupExperience | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { pluginId, experienceId } = value as Record<string, unknown>
  if (
    typeof pluginId !== 'string' ||
    pluginId.length > 255 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(pluginId) ||
    typeof experienceId !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(experienceId)
  )
    return null
  return { pluginId, experienceId }
}

export function startupExperienceKey(value: StartupExperience | null | undefined): string {
  return value ? `${value.pluginId}:${value.experienceId}` : ''
}

export function normalizeExperiences(manifest: {
  apiVersion: number
  type: readonly string[]
  permissions: readonly string[]
  contributes?: unknown
}): PluginExperience[] {
  const raw = (manifest.contributes as { experiences?: unknown } | undefined)?.experiences
  if (raw === undefined) return []
  if (
    manifest.apiVersion < 4 ||
    !manifest.type.includes('ui') ||
    !manifest.permissions.includes('ui:inject')
  )
    throw new Error('Experiences require API v4, type ui and ui:inject')
  if (!Array.isArray(raw) || !raw.length || raw.length > 8) throw new Error('Invalid experiences')
  const ids = new Set<string>()
  return raw.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid experience')
    const value = item as Record<string, unknown>
    const { id, name, entry, bridgeVersion } = value
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id) || ids.has(id))
      throw new Error('Invalid or duplicate experience id')
    if (typeof name !== 'string' || !name.trim() || name.length > 120)
      throw new Error('Invalid experience name')
    if (
      typeof entry !== 'string' ||
      !/^[a-zA-Z0-9_/-]+\.html$/.test(entry) ||
      entry.startsWith('/') ||
      entry.split('/').includes('..')
    )
      throw new Error('Experience entry must be a packaged HTML file')
    if (bridgeVersion !== 1 && bridgeVersion !== 2)
      throw new Error('Unsupported experience bridge version')
    if (
      value.launch !== undefined &&
      value.launch !== 'page' &&
      value.launch !== 'panel' &&
      value.launch !== 'sidebar'
    )
      throw new Error('Experience launch must be page, panel or sidebar')
    let sidebar: PluginExperience['sidebar']
    if (value.sidebar !== undefined) {
      if (
        value.launch !== 'sidebar' ||
        !value.sidebar ||
        typeof value.sidebar !== 'object' ||
        Array.isArray(value.sidebar)
      )
        throw new Error('Experience sidebar options require launch: sidebar')
      const { height } = value.sidebar as Record<string, unknown>
      if (
        height !== undefined &&
        (typeof height !== 'number' || !Number.isInteger(height) || height < 64 || height > 480)
      )
        throw new Error('Experience sidebar height must be an integer between 64 and 480')
      sidebar = height === undefined ? {} : { height }
    }
    ids.add(id)
    return {
      id,
      name: name.trim(),
      entry,
      bridgeVersion,
      ...(value.launch === 'panel' || value.launch === 'sidebar' ? { launch: value.launch } : {}),
      ...(sidebar ? { sidebar } : {})
    }
  })
}

export const EXPERIENCE_METHOD_PERMISSIONS: Record<string, string> = {
  'themes.list': 'app:settings',
  'themes.create': 'app:settings',
  'themes.read': 'app:settings',
  'themes.edit': 'app:settings',
  'themes.export': 'app:settings',
  'themes.import': 'app:settings',
  'themes.apply': 'plugins:manage',
  'radio.list': 'network',
  'radio.add': 'library:write',
  'radio.remove': 'library:write',
  'radio.import': 'library:write',
  'radio.search': 'network',
  'radio.play': 'network',
  'podcasts.list': 'network',
  'podcasts.episodes': 'network',
  'podcasts.subscribe': 'library:write',
  'podcasts.remove': 'library:write',
  'podcasts.refresh': 'network',
  'podcasts.play': 'network',
  'network.profiles': 'network',
  'network.create': 'app:settings',
  'network.remove': 'app:settings',
  'network.test': 'network',
  'network.browse': 'network',
  'network.library': 'network',
  'network.scan': 'library:write',
  'network.play': 'network',
  'stats.read': 'library:read',
  'diagnostics.status': 'app:settings',
  'diagnostics.mark': 'app:settings',
  'diagnostics.export': 'app:settings',
  'plugins.catalog': 'plugins:manage',
  'plugins.update': 'plugins:manage',
  'music.library': 'library:read',
  'music.scan': 'library:write',
  'music.metadata.read': 'library:write',
  'music.metadata.write': 'library:write',
  'music.metadata.operate': 'library:write',
  'player.transition': 'player:control',
  'player.setQueue': 'player:control',
  'player.reorderQueue': 'player:control',
  'player.playQueue': 'player:control',
  'host.capabilities': 'ui:inject',
  'files.export': 'library:write',
  'online.providers': 'network',
  'online.search': 'network',
  'online.login': 'network',
  'online.qr': 'network',
  'online.qrStatus': 'network',
  'online.logout': 'network',
  'online.library': 'network',
  'online.playlist': 'network',
  'online.recommendations': 'network',
  'online.cloud': 'network',
  'downloads.list': 'network',
  'downloads.create': 'library:write',
  'downloads.cancel': 'library:write',
  'downloads.retry': 'library:write',
  'library.list': 'library:read',
  'library.album': 'library:read',
  'library.search': 'library:read',
  'library.playlists': 'library:read',
  'library.favorite': 'library:write',
  'library.createPlaylist': 'library:write',
  'library.addToPlaylist': 'library:write',
  'library.removeFromPlaylist': 'library:write',
  'library.deletePlaylist': 'library:write',
  'library.scan': 'library:write',
  'player.state': 'player:observe',
  'player.sleep': 'player:control',
  'player.rate': 'player:control',
  'player.queue': 'player:observe',
  'player.lyrics': 'player:observe',
  'player.play': 'player:control',
  'player.toggle': 'player:control',
  'player.pause': 'player:control',
  'player.stop': 'player:control',
  'player.next': 'player:control',
  'player.previous': 'player:control',
  'player.seek': 'player:control',
  'player.volume': 'player:control',
  'player.mode': 'player:control',
  'player.removeQueue': 'player:control',
  'player.clearQueue': 'player:control',
  'settings.read': 'app:settings',
  'settings.update': 'app:settings',
  'audio.read': 'app:settings',
  'audio.processing': 'app:settings',
  'audio.output': 'app:settings',
  'dsp.read': 'app:settings',
  'dsp.create': 'app:settings',
  'dsp.apply': 'app:settings',
  'dsp.node': 'app:settings',
  'dsp.import': 'app:settings',
  'dsp.export': 'app:settings',
  'plugins.list': 'plugins:manage',
  'plugins.enable': 'plugins:manage',
  'plugins.disable': 'plugins:manage',
  'plugins.install': 'plugins:manage',
  'plugins.uninstall': 'plugins:manage',
  'preferences.read': 'settings',
  'preferences.write': 'settings',
  'host.environment': 'ui:inject',
  'host.exit': 'ui:inject',
  'host.fullscreen': 'ui:inject',
  'host.openLink': 'ui:inject',
  'window.mini': 'ui:inject',
  'window.tray': 'ui:inject',
  'window.lyrics': 'ui:inject',
  'host.panel': 'app:settings',
  /**
   * Calls the owning plugin's background code (utility process) with a JSON
   * request. The iframe itself has no network access, so this relay is how an
   * experience reaches proxy-aware fetch, API keys and durable background work.
   */
  'plugin.request': 'network'
}

/** Imports have a larger explicit envelope; ordinary commands remain small. */
export function experienceRequestLimit(method: string): number {
  if (method === 'music.metadata.operate' || method === 'files.export') return 5 * 1024 * 1024
  if (method === 'music.metadata.write') return 17 * 1024 * 1024
  return 256 * 1024
}

export function assertExperienceMethod(method: string, permissions: readonly string[]): void {
  const permission = Object.hasOwn(EXPERIENCE_METHOD_PERMISSIONS, method)
    ? EXPERIENCE_METHOD_PERMISSIONS[method]
    : undefined
  if (!permission || !permissions.includes(permission))
    throw new Error(`Experience operation denied: ${method}`)
}
