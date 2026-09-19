import {
  createWorkshopProject,
  type ThemeEditorControl,
  type WorkshopProject
} from './themeWorkshop.ts'

const control = (
  id: string,
  label: string,
  type: ThemeEditorControl['type'],
  value: string,
  dark = value,
  unit?: string
): ThemeEditorControl => ({
  id,
  label,
  type,
  group: '背景',
  variable: `--workshop-${id}`,
  defaults: { pureWhite: value, dark },
  unit
})

export function workshopTemplate(id: string, template: string): WorkshopProject {
  if (!['minimal', 'wallpaper', 'illustration'].includes(template)) throw new Error('未知主题模板')
  const project = createWorkshopProject(
    id,
    template === 'minimal' ? '简洁配色' : template === 'wallpaper' ? '全屏壁纸' : '插画主题'
  )
  project.base.editor = {
    schemaVersion: 1,
    controls: [
      control('paper', '背景颜色', 'color', '#edf5f5', '#14282e'),
      control('image', '背景图片', 'image', 'none'),
      { ...control('wash', '蒙版强度', 'number', '55%', '65%', '%'), min: 0, max: 100 },
      { ...control('position', '图片位置', 'text', 'center center') },
      {
        ...control('size', '图片缩放', 'select', 'cover'),
        options: ['cover', 'contain', '100% auto', 'auto 100%']
      },
      { ...control('card', '卡片底色', 'color', '#f8fcfa', '#193137'), group: '卡片' },
      {
        ...control('radius', '卡片圆角', 'number', '20px', '20px', 'px'),
        group: '卡片',
        min: 0,
        max: 64
      }
    ]
  }
  project.base.css = `html {--workshop-paper:#edf5f5;--workshop-image:none;--workshop-wash:55%;--workshop-position:center center;--workshop-size:cover;--workshop-card:#f8fcfa;--workshop-radius:20px}
html[data-theme='dark'] {--workshop-paper:#14282e;--workshop-card:#193137;--workshop-wash:65%}
body:has(.app-shell) {background:linear-gradient(color-mix(in srgb,var(--workshop-paper) var(--workshop-wash),transparent),color-mix(in srgb,var(--workshop-paper) var(--workshop-wash),transparent)),var(--workshop-image) var(--workshop-position)/var(--workshop-size) fixed,var(--workshop-paper) !important}
:is(.dashboard-wrapper,.song-list,.streaming-page,.settings-page) {background:transparent !important}
:is(.settings-section,.dashboard-card) {background:var(--workshop-card) !important;border-radius:var(--workshop-radius) !important}`
  if (template === 'minimal') {
    project.base.editor.controls = project.base.editor.controls.filter(
      (item) => !['image', 'wash', 'position', 'size'].includes(item.id)
    )
    project.base.css = `html {--workshop-paper:#edf5f5;--workshop-card:#f8fcfa;--workshop-radius:12px}
html[data-theme='dark'] {--workshop-paper:#14282e;--workshop-card:#193137}
body:has(.app-shell) {background:var(--workshop-paper) !important}
:is(.settings-section,.dashboard-card) {background:var(--workshop-card) !important;border-radius:var(--workshop-radius) !important}`
    project.base.editor.controls.find((item) => item.id === 'radius')!.defaults = {
      pureWhite: '12px',
      dark: '12px'
    }
  }
  if (template === 'illustration') {
    project.base.editor.controls.push(
      { ...control('illustration', '人物插画', 'image', 'none'), group: '人物插画' },
      {
        ...control('illustration-size', '人物宽度', 'number', '45%', '45%', '%'),
        group: '人物插画',
        min: 10,
        max: 100
      },
      {
        ...control('illustration-wash', '人物蒙版', 'number', '40%', '55%', '%'),
        group: '人物插画',
        min: 0,
        max: 100
      },
      {
        ...control('illustration-fade', '左侧淡化范围', 'number', '25%', '25%', '%'),
        group: '人物插画',
        min: 0,
        max: 80
      },
      { ...control('illustration-position', '人物位置', 'text', 'right center'), group: '人物插画' }
    )
    project.base.css += `
html {--workshop-illustration:none;--workshop-illustration-size:45%;--workshop-illustration-wash:40%;--workshop-illustration-fade:25%;--workshop-illustration-position:right center}
html[data-theme='dark'] {--workshop-illustration-wash:55%}
:is(.song-list,.streaming-content) {isolation:isolate}
:is(.song-list,.streaming-content)::before {content:'';position:absolute;inset:0;z-index:-1;pointer-events:none;background-image:linear-gradient(color-mix(in srgb,var(--workshop-paper) var(--workshop-illustration-wash),transparent),color-mix(in srgb,var(--workshop-paper) var(--workshop-illustration-wash),transparent)),var(--workshop-illustration);background-size:var(--workshop-illustration-size) auto;background-position:var(--workshop-illustration-position);background-repeat:no-repeat;mask-image:linear-gradient(90deg,transparent,var(--workshop-paper) var(--workshop-illustration-fade))}`
  }
  return project
}
