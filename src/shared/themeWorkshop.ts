import type { StructuredPluginTheme, ThemeModes, ThemeShellLayout, ThemeTone } from './theme.ts'
import type { ThemeEditorDescriptor } from './themeEditor.ts'
import type { WorkshopLayer, WorkshopSurface } from './themeWorkshopLayers.ts'
import type { WorkshopDiagnosticReport } from './themeWorkshopDiagnostics.ts'
import type { AppearanceDraft } from './appAppearance.ts'
import type { ThemeProfileV2, ThemeSelection } from './theme.ts'
import type { AppSettings } from './appSettings.ts'

export { normalizeThemeEditor } from './themeEditor.ts'
export type { ThemeEditorControl, ThemeEditorDescriptor } from './themeEditor.ts'
export { isWorkshopProject } from './themeWorkshopValidation.ts'
export {
  compileWorkshopProject,
  compileWorkshopTheme,
  exportWorkshopEditor,
  workshopRuntimeAttributes
} from './themeWorkshopCompiler.ts'

export const THEME_WORKSHOP_ID = 'com.twilightecho.tool.theme-workshop'
export const WORKSHOP_TEMPLATES = [
  { id: 'minimal', name: '简洁配色', description: '从配色、圆角和干净的留白开始' },
  { id: 'wallpaper', name: '全屏壁纸', description: '选择一张壁纸，搭配清晰的半透明界面' },
  { id: 'illustration', name: '插画主题', description: '为首页、列表和空状态安排自己的插画' },
  { id: 'glass', name: '玻璃质感', description: '半透明面板与柔和的层次，适合壁纸主题' },
  { id: 'high-contrast', name: '高对比', description: '清晰的文字和控件，兼顾深浅色可读性' },
  { id: 'compact', name: '紧凑列表', description: '紧凑列表与简洁播放栏，适合大曲库' }
] as const

export interface WorkshopAsset {
  id: string
  name: string
  type: 'image' | 'font'
  dataUrl: string
  license: string
  source: string
  originalDataUrl?: string
}

export interface WorkshopBase {
  pluginId?: string
  themeId?: string
  version?: string
  digest?: string
  author: string
  license: string
  notices?: Record<string, string>
  css: string
  variables: Record<string, string>
  structured?: StructuredPluginTheme
  editor?: ThemeEditorDescriptor
}

export interface WorkshopProject {
  schemaVersion: 1
  id: string
  revision: number
  name: string
  author: string
  description: string
  version: string
  updatedAt: string
  base: WorkshopBase
  values: Record<ThemeTone, Record<string, string>>
  tokens: Record<ThemeTone, Record<string, string>>
  css: string
  lastApplied?: { version: string; at: string; revision?: number }
  editor?: ThemeEditorDescriptor
  unlinked?: Record<string, boolean>
  enabled?: boolean
  assets?: WorkshopAsset[]
  layers?: Record<ThemeTone, Partial<Record<WorkshopSurface, WorkshopLayer[]>>>
  modes?: ThemeModes
  layout?: ThemeShellLayout | null
  fonts?: Partial<Record<'sans' | 'display' | 'rounded', string>>
}

export type WorkshopProjectSummary = Pick<
  WorkshopProject,
  'id' | 'name' | 'author' | 'version' | 'revision' | 'updatedAt' | 'lastApplied'
>

export interface WorkshopThemeSource {
  pluginId: string
  themeId: string
  name: string
  version: string
}

export interface WorkshopCompiledTheme {
  css: string
  structured?: StructuredPluginTheme
  variables: Record<string, string>
}

export interface ThemeWorkshopApi {
  createFromAppearance(input: CustomThemeInput): Promise<WorkshopProject>
  exportAppearance(input: CustomThemeInput): Promise<string | null>
  list(): Promise<WorkshopProjectSummary[]>
  get(id: string): Promise<WorkshopProject>
  sources(): Promise<WorkshopThemeSource[]>
  create(template: string, source?: WorkshopThemeSource): Promise<WorkshopProject>
  save(project: WorkshopProject): Promise<WorkshopProject>
  importProject(): Promise<WorkshopProject | null>
  duplicate(id: string, revision: number): Promise<WorkshopProject>
  remove(id: string, revision: number): Promise<void>
  preflight(id: string, revision: number): Promise<WorkshopDiagnosticReport>
  exportProject(id: string, format: 'project' | 'tep', revision?: number): Promise<string | null>
  importAsset(type?: 'image' | 'font'): Promise<WorkshopAsset | null>
  updateBase(id: string): Promise<WorkshopBase>
  restoreApplied(id: string): Promise<WorkshopProject>
  apply(
    id: string,
    revision?: number
  ): Promise<{ pluginId: string; themeId: string; project: WorkshopProject }>
}

export interface CustomThemeInput {
  selection: ThemeSelection
  profile?: ThemeProfileV2
  appearance: AppearanceDraft
  preferences?: Pick<
    AppSettings,
    'fontFamily' | 'fontRendering' | 'lightAccentColor' | 'darkAccentColor'
  >
}

export function workshopEditor(
  project: WorkshopProject | undefined
): ThemeEditorDescriptor | undefined {
  return project?.editor ?? project?.base.editor
}

export function createWorkshopProject(
  id: string,
  name: string,
  base?: WorkshopBase
): WorkshopProject {
  return {
    schemaVersion: 1,
    id,
    revision: 0,
    name,
    author: '',
    description: '',
    version: '1.0.0',
    updatedAt: new Date().toISOString(),
    base: base ?? { author: '', license: 'UNLICENSED', css: '', variables: {} },
    values: { pureWhite: {}, dark: {} },
    tokens: { pureWhite: {}, dark: {} },
    css: ''
  }
}

export function workshopProjectSummary(project: WorkshopProject): WorkshopProjectSummary {
  const { id, name, author, version, revision, updatedAt, lastApplied } = project
  return { id, name, author, version, revision, updatedAt, lastApplied }
}

export function copyWorkshopDraft(project: WorkshopProject): WorkshopProject {
  return {
    ...project,
    base: JSON.parse(JSON.stringify(project.base)),
    editor: project.editor && {
      schemaVersion: 1,
      controls: project.editor.controls.map((control) => ({
        ...control,
        defaults: { ...control.defaults },
        options: control.options && [...control.options],
        targets: control.targets && { ...control.targets }
      }))
    },
    values: { pureWhite: { ...project.values.pureWhite }, dark: { ...project.values.dark } },
    tokens: { pureWhite: { ...project.tokens.pureWhite }, dark: { ...project.tokens.dark } },
    unlinked: { ...project.unlinked },
    assets: project.assets?.map((asset) => ({ ...asset })),
    layers: project.layers && {
      pureWhite: copyLayers(project.layers.pureWhite),
      dark: copyLayers(project.layers.dark)
    },
    modes: project.modes && JSON.parse(JSON.stringify(project.modes)),
    layout: project.layout && JSON.parse(JSON.stringify(project.layout)),
    fonts: { ...project.fonts }
  }
}

function copyLayers(
  layers: Partial<Record<WorkshopSurface, WorkshopLayer[]>>
): Partial<Record<WorkshopSurface, WorkshopLayer[]>> {
  return Object.fromEntries(
    Object.entries(layers).map(([surface, entries]) => [
      surface,
      entries.map((layer) => ({ ...layer, fade: { ...layer.fade }, crop: { ...layer.crop } }))
    ])
  )
}
