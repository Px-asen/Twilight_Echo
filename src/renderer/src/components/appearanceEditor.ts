import type { ThemeStudioDomain } from './theme-studio/useThemeStudioEditor'
import type { ThemeTone } from '../../../shared/theme'

export type AppearanceAction =
  | 'undo'
  | 'redo'
  | 'reset'
  | 'duplicate'
  | 'import'
  | 'export'
  | 'export-plugin'
  | 'apply'
  | 'save'
  | 'trial'
  | 'create'
export type AppearanceEditorState = {
  key: string
  tone: ThemeTone
  busy: boolean
  canUndo: boolean
  canRedo: boolean
  canReset: boolean
  canExport: boolean
  canApply: boolean
  status: string
  dirty?: boolean
  hasUnsavedChanges?: boolean
  error?: string
  trial?: boolean
}
export type AppearanceHistoryActions = {
  canUndo: boolean
  canRedo: boolean
  undo: () => Promise<void>
  redo: () => Promise<void>
}
export type AppearanceCategory = {
  id: string
  label: string
  studio?: ThemeStudioDomain
  workshop?: string
}

// Categories describe capabilities, independent of a theme's storage format.
export const APPEARANCE_CATEGORIES: AppearanceCategory[] = [
  { id: 'theme', label: '主题与版本', studio: 'presets', workshop: '项目' },
  { id: 'color', label: '配色与背景', studio: 'personalization', workshop: '配色' },
  { id: 'background', label: '背景与材质', studio: 'shell', workshop: '背景' },
  { id: 'material', label: '界面材质', studio: 'shell', workshop: '卡片' },
  { id: 'font', label: '字体与歌词', studio: 'typography', workshop: '字体' },
  { id: 'navigation', label: '图标与侧边栏', studio: 'navigation', workshop: '导航' },
  { id: 'library', label: '媒体库', studio: 'library', workshop: '列表' },
  { id: 'player', label: '播放器与封面', studio: 'player', workshop: '播放栏' },
  { id: 'windows', label: '小窗与桌面歌词', studio: 'windows' },
  { id: 'motion', label: '动画', studio: 'motion' },
  { id: 'assets', label: '素材与字体文件', workshop: '素材库' },
  { id: 'layers', label: '图层与蒙版', workshop: '图层与蒙版' },
  { id: 'layout', label: '布局与模式', workshop: '布局与模式' },
  { id: 'tokens', label: '全部外观参数', studio: 'advanced', workshop: '标准外观' },
  { id: 'parameters', label: '参数设计', workshop: '参数设计器' },
  { id: 'css', label: '自定义 CSS', workshop: '高级 CSS' }
]
