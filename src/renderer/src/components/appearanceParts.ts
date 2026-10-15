import type { EditorNodeDefinition } from '../editor/viewportGeometry'
import { BODY_CONTROL_SELECTOR, CARD_SURFACE_SELECTOR } from '../../../shared/cardSurfaces.ts'
export type AppearancePart =
  | 'overview'
  | 'inner-panel'
  | 'outer-panel'
  | 'controls'
  | 'background'
  | 'navigation'
  | 'material'
  | 'player-bar'
  | 'card'
  | 'global-font'
  | 'appearance-theme'
/** Older navigation and saved focus targets still use background. */
export function resolveAppearancePart(part: AppearancePart): Exclude<AppearancePart, 'background'> {
  return part === 'background' ? 'inner-panel' : part
}
export const APPEARANCE_PARTS: {
  id: AppearancePart
  label: string
  icon: string
  description: string
  preview?: Omit<EditorNodeDefinition<AppearancePart>, 'id'>
}[] = [
  {
    id: 'overview',
    label: '整窗',
    icon: 'pi pi-desktop',
    description: '点击预览中的部件，或从下方选择编辑对象。'
  },
  {
    id: 'inner-panel',
    label: '内框背景',
    icon: 'pi pi-stop',
    description: '统一调整圆角内容矩形的底色、背景图片与明暗，也可使用透明图片作为完整部件皮肤。',
    preview: { selector: '.app-shell-content', label: '调整内框背景', focus: 'scene' }
  },
  {
    id: 'outer-panel',
    label: '外框',
    icon: 'pi pi-window-maximize',
    description: '包含标题栏的整窗背景，可使用带透明通道的完整皮肤。',
    preview: { selector: '.app-shell', label: '调整外框', focus: 'scene' }
  },
  {
    id: 'controls',
    label: '控件',
    icon: 'pi pi-sliders-h',
    description: '统一调整按钮、输入框等控件的底色与交互外观。',
    preview: { selector: `.app-shell-content :is(${BODY_CONTROL_SELECTOR})`, label: '调整控件材质' }
  },
  {
    id: 'navigation',
    label: '侧边栏',
    icon: 'pi pi-bars',
    description: '调整导航的玻璃质感与清晰度。',
    preview: { selector: '.side-menu,.sidebar-bookmark', label: '调整侧边栏材质' }
  },
  {
    id: 'material',
    label: '标题栏',
    icon: 'pi pi-window-maximize',
    description: '观察窗口顶部的材质与文字对比。',
    preview: { selector: '.title-bar', label: '调整标题栏材质' }
  },
  {
    id: 'player-bar',
    label: '播放栏',
    icon: 'pi pi-play-circle',
    description: '调整播放栏整体材质与背景皮肤，保留按钮和进度条的独立操作。',
    preview: { selector: '.player-bar', label: '调整播放条布局' }
  },
  {
    id: 'card',
    label: '卡片',
    icon: 'pi pi-clone',
    description: '调整内容卡片的颜色与材质。',
    preview: {
      selector: CARD_SURFACE_SELECTOR,
      label: '调整内容卡片'
    }
  },
  {
    id: 'global-font',
    label: '文字',
    icon: 'pi pi-language',
    description: '在主题设置中调整字体与排版。'
  },
  {
    id: 'appearance-theme',
    label: '配色',
    icon: 'pi pi-palette',
    description: '在主题设置中搭配整体配色。'
  }
]
