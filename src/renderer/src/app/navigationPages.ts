import type { UiContribution } from '@renderer/extensions/registry'
import type { ThemeIconSlot } from '../../../shared/theme.ts'
import type { NavigationPagePreferences } from '../../../shared/navigationPages.ts'

export type StreamingPageTab = 'home' | 'discover' | 'library' | 'cloud' | 'search'

export type NavigationPageTarget =
  | { kind: 'local'; category: string; filter: string | null }
  | { kind: 'streaming'; tab: StreamingPageTab }
  | { kind: 'recent'; scope?: 'device' | 'platform'; providerId?: string }
  | { kind: 'radio' }
  | { kind: 'network' }
  | { kind: 'zones' }
  | { kind: 'plugin'; page: UiContribution }

export interface NavigationPageDefinition {
  id: string
  title: string
  description: string
  icon: ThemeIconSlot
  customIcon?: string
  defaultVisible: boolean
  unavailableReason?: string
  target: NavigationPageTarget
}

const local = (category: string): NavigationPageTarget => ({
  kind: 'local',
  category,
  filter: null
})

export const BUILTIN_NAVIGATION_PAGES: NavigationPageDefinition[] = [
  {
    id: 'local-home',
    title: '主页',
    description: '继续收听、本地音乐与在线发现',
    icon: 'navigation.home',
    defaultVisible: true,
    target: local('dashboard')
  },
  {
    id: 'streaming-home',
    title: '推荐主页',
    description: '各音源推荐与私人 FM',
    icon: 'navigation.streaming',
    defaultVisible: true,
    target: { kind: 'streaming', tab: 'home' }
  },
  {
    id: 'discover',
    title: '发现歌单',
    description: '按平台浏览在线歌单',
    icon: 'navigation.playlists',
    defaultVisible: true,
    target: { kind: 'streaming', tab: 'discover' }
  },
  {
    id: 'library',
    title: '我的音乐库',
    description: '平台的我喜欢、歌单、收藏专辑和歌手',
    icon: 'navigation.favorite',
    defaultVisible: true,
    target: { kind: 'streaming', tab: 'library' }
  },
  {
    id: 'cloud',
    title: '音乐云盘',
    description: '网易云音乐云盘',
    icon: 'navigation.cloud',
    defaultVisible: true,
    target: { kind: 'streaming', tab: 'cloud' }
  },
  {
    id: 'allSongs',
    title: '所有歌曲',
    description: '浏览本地曲库',
    icon: 'navigation.songs',
    defaultVisible: true,
    target: local('allSongs')
  },
  {
    id: 'albums',
    title: '专辑',
    description: '本地专辑',
    icon: 'navigation.albums',
    defaultVisible: true,
    target: local('albums')
  },
  {
    id: 'artists',
    title: '艺术家',
    description: '本地艺术家',
    icon: 'navigation.artists',
    defaultVisible: true,
    target: local('artists')
  },
  {
    id: 'playlists',
    title: '歌单',
    description: '应用收藏、应用歌单与聚合歌单',
    icon: 'navigation.playlists',
    defaultVisible: true,
    target: local('playlists')
  },
  {
    id: 'folders',
    title: '文件夹',
    description: '按目录浏览本地音乐',
    icon: 'navigation.folders',
    defaultVisible: true,
    target: local('folders')
  },
  {
    id: 'genres',
    title: '流派',
    description: '按流派浏览本地音乐',
    icon: 'navigation.genres',
    defaultVisible: true,
    target: local('genres')
  },
  {
    id: 'search',
    title: '搜索',
    description: '搜索本地与在线歌曲、歌单和歌手',
    icon: 'navigation.search',
    defaultVisible: true,
    target: { kind: 'streaming', tab: 'search' }
  },
  {
    id: 'recent',
    title: '最近播放',
    description: '分别查看本机记录与平台历史',
    icon: 'navigation.recent',
    defaultVisible: true,
    target: { kind: 'recent' }
  },
  {
    id: 'analytics',
    title: '统计仪表盘',
    description: '聆听统计与排行',
    icon: 'navigation.analytics',
    defaultVisible: false,
    target: local('analytics')
  },
  {
    id: 'radio',
    title: '电台 / 播客',
    description: '电台与播客订阅',
    icon: 'navigation.radio',
    defaultVisible: false,
    target: { kind: 'radio' }
  },
  {
    id: 'network',
    title: '网络源',
    description: '浏览与管理网络音乐源',
    icon: 'navigation.network',
    defaultVisible: false,
    target: { kind: 'network' }
  }
]

export function buildNavigationPages(
  contributions: UiContribution[],
  unavailable: Record<string, string> = {}
): NavigationPageDefinition[] {
  const pages: NavigationPageDefinition[] = BUILTIN_NAVIGATION_PAGES.map((page) => ({
    ...page,
    unavailableReason: unavailable[page.id]
  }))
  const seen = new Set(pages.map((page) => page.id))
  for (const page of contributions) {
    if (page.kind !== 'sidebarPage' && page.kind !== 'localSidebarItem') continue
    const id = `plugin:${page.pluginId}:${page.id}`
    if (seen.has(id)) continue
    seen.add(id)
    pages.push({
      id,
      title: page.title,
      description: page.description ?? '插件页面',
      icon: 'navigation.plugin',
      customIcon: page.icon,
      defaultVisible: true,
      target: { kind: 'plugin', page }
    })
  }
  return pages
}

export function orderNavigationPages(
  pages: NavigationPageDefinition[],
  preferences: NavigationPagePreferences
): NavigationPageDefinition[] {
  const byId = new Map(pages.map((page) => [page.id, page]))
  const result: NavigationPageDefinition[] = []
  for (const id of preferences.order) {
    const page = byId.get(id)
    if (page) {
      result.push(page)
      byId.delete(id)
    }
  }
  for (const page of byId.values()) result.push(page)
  return result
}

export function isNavigationPageVisible(
  page: NavigationPageDefinition,
  preferences: NavigationPagePreferences
): boolean {
  return (
    !preferences.hidden.includes(page.id) &&
    (preferences.order.includes(page.id) || page.defaultVisible)
  )
}

export function navigationTargetId(target: NavigationPageTarget): string {
  if (target.kind === 'local') {
    if (target.category === 'dashboard') return 'local-home'
    if (target.category === 'aggregate') return 'playlists'
    return target.category
  }
  if (target.kind === 'streaming') return target.tab === 'home' ? 'streaming-home' : target.tab
  if (target.kind === 'plugin') return `plugin:${target.page.pluginId}:${target.page.id}`
  return target.kind
}

export function createNavigationPageDraft(
  pages: NavigationPageDefinition[],
  previous: NavigationPagePreferences
): NavigationPagePreferences {
  const order = [...previous.order]
  const hidden = new Set(previous.hidden)
  for (const page of pages) {
    if (!order.includes(page.id)) order.push(page.id)
    if (!isNavigationPageVisible(page, previous)) hidden.add(page.id)
  }
  return { version: 1, order, hidden: [...hidden] }
}

export function moveNavigationPage(
  preferences: NavigationPagePreferences,
  from: string,
  to: string
): NavigationPagePreferences {
  const order = [...preferences.order]
  const start = order.indexOf(from)
  const end = order.indexOf(to)
  if (start < 0 || end < 0 || start === end) return preferences
  order.splice(start, 1)
  order.splice(end, 0, from)
  return { ...preferences, order }
}
