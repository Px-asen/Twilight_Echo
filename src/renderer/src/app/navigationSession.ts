import type { UiContribution } from '../extensions/registry'
import type { NavigationPageTarget, StreamingPageTab } from './navigationPages.ts'
import type { AppearanceWorkspaceTab, SettingsSection, ThemeStudioDomain } from './useAppNavigation'
import { normalizeSettingsSection } from '../components/settings-page/types.ts'

export type NavigationOverlay =
  | 'playing'
  | 'login'
  | 'settings'
  | 'appearance'
  | 'theme'
  | 'plugins'
  | 'equalizer'
  | 'dsp'
export type SavedNavigationTarget =
  | Exclude<NavigationPageTarget, { kind: 'plugin' }>
  | { kind: 'plugin'; pluginId: string; pageId: string }

export interface NavigationSession {
  version: 1
  pageTarget: SavedNavigationTarget
  history: SavedNavigationTarget[]
  lastLocal: Extract<NavigationPageTarget, { kind: 'local' }>
  overlay: NavigationOverlay | null
  overlayHistory: Array<NavigationOverlay | null>
  menuOpen: boolean
  settingsSection: SettingsSection
  themeStudioDomain: ThemeStudioDomain
  appearanceTab?: AppearanceWorkspaceTab
  themeReturn: 'playing' | 'settings' | null
  loginPageMode: 'login' | 'profile'
  loginProviderId: string | null
}

export interface NavigationSessionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const NAVIGATION_SESSION_KEY = 'twilight-echo:navigation-session:v1'
const localCategories = new Set([
  'dashboard',
  'allSongs',
  'artists',
  'albums',
  'genres',
  'playlists',
  'aggregate',
  'folders',
  'recent',
  'analytics'
])
const streamingTabs = new Set<StreamingPageTab>(['home', 'discover', 'library', 'cloud', 'search'])
const overlays = new Set<NavigationOverlay>([
  'playing',
  'login',
  'settings',
  'appearance',
  'theme',
  'plugins',
  'equalizer',
  'dsp'
])
const themeDomains = new Set<ThemeStudioDomain>([
  'presets',
  'personalization',
  'shell',
  'navigation',
  'library',
  'typography',
  'player',
  'windows',
  'motion',
  'advanced'
])
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096
const member = <T extends string>(set: Set<T>, value: unknown): value is T =>
  typeof value === 'string' && set.has(value as T)
export const navigationHome = (): Extract<NavigationPageTarget, { kind: 'local' }> => ({
  kind: 'local',
  category: 'dashboard',
  filter: null
})

function normalizeTarget(value: unknown): SavedNavigationTarget | null {
  if (!record(value)) return null
  switch (value.kind) {
    case 'local':
      return member(localCategories, value.category) &&
        (value.filter === null || text(value.filter))
        ? { kind: 'local', category: value.category, filter: value.filter }
        : null
    case 'streaming':
      return member(streamingTabs, value.tab) ? { kind: 'streaming', tab: value.tab } : null
    case 'recent':
      return {
        kind: 'recent',
        ...(value.scope === 'platform' || value.scope === 'device' ? { scope: value.scope } : {}),
        ...(text(value.providerId) ? { providerId: value.providerId } : {})
      }
    case 'radio':
      return { kind: 'radio' }
    case 'network':
      return { kind: 'network' }
    case 'plugin':
      return text(value.pluginId) && text(value.pageId)
        ? { kind: 'plugin', pluginId: value.pluginId, pageId: value.pageId }
        : null
    default:
      return null
  }
}

export function saveNavigationTarget(target: NavigationPageTarget): SavedNavigationTarget {
  return target.kind === 'plugin'
    ? { kind: 'plugin', pluginId: target.page.pluginId, pageId: target.page.id }
    : { ...target }
}

export function resolveNavigationTarget(
  target: SavedNavigationTarget,
  pages: UiContribution[]
): NavigationPageTarget | null {
  if (target.kind !== 'plugin') return target
  const page = pages.find((page) => page.pluginId === target.pluginId && page.id === target.pageId)
  return page ? { kind: 'plugin', page } : null
}

export function normalizeNavigationSession(value: unknown): NavigationSession | null {
  if (!record(value) || value.version !== 1) return null
  const pageTarget = normalizeTarget(value.pageTarget)
  if (!pageTarget) return null
  const lastLocal = normalizeTarget(value.lastLocal)
  const overlayHistory: Array<NavigationOverlay | null> = Array.isArray(value.overlayHistory)
    ? value.overlayHistory.slice(-20).filter((entry) => entry === null || member(overlays, entry))
    : []
  // Earlier local previews stored the avatar expansion as a full-page overlay.
  const overlay = value.overlay === 'account'
    ? (overlayHistory.pop() ?? null)
    : member(overlays, value.overlay) ? value.overlay : null
  return {
    version: 1,
    pageTarget,
    history: Array.isArray(value.history)
      ? value.history.slice(-50).flatMap((entry) => normalizeTarget(entry) ?? [])
      : [],
    lastLocal: lastLocal?.kind === 'local' ? lastLocal : navigationHome(),
    overlay,
    overlayHistory,
    menuOpen: value.menuOpen === true,
    settingsSection: normalizeSettingsSection(value.settingsSection),
    themeStudioDomain: member(themeDomains, value.themeStudioDomain)
      ? value.themeStudioDomain
      : 'presets',
    appearanceTab:
      value.appearanceTab === 'studio' || value.appearanceTab === 'workshop'
        ? value.appearanceTab
        : 'adjust',
    themeReturn:
      value.themeReturn === 'settings' || value.themeReturn === 'playing'
        ? value.themeReturn
        : null,
    loginPageMode: value.loginPageMode === 'profile' ? 'profile' : 'login',
    loginProviderId: text(value.loginProviderId) ? value.loginProviderId : null
  }
}

export function browserNavigationStorage(): NavigationSessionStorage {
  return {
    getItem: (key) => globalThis.localStorage?.getItem(key) ?? null,
    setItem: (key, value) => globalThis.localStorage?.setItem(key, value)
  }
}

export function readNavigationSession(storage: NavigationSessionStorage): NavigationSession | null {
  try {
    return normalizeNavigationSession(JSON.parse(storage.getItem(NAVIGATION_SESSION_KEY) ?? 'null'))
  } catch {
    return null
  }
}

export function writeNavigationSession(
  storage: NavigationSessionStorage,
  session: NavigationSession
): boolean {
  try {
    storage.setItem(NAVIGATION_SESSION_KEY, JSON.stringify(session))
    return true
  } catch {
    // Optional page memory must not interrupt navigation or application shutdown.
    return false
  }
}
